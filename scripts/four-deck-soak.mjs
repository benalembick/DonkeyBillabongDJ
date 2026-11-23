// Four-deck verification + soak test against the real app (built renderer in dist/), driven over CDP.
//
//   npm run build
//   node scripts/four-deck-soak.mjs --minutes 30 [--out <dir>] [--stems-model <path.onnx>] [--port 9333] [--skip-shots]
//   --stems-gpu-failed   seed the throwaway profile like a machine whose GPU already failed STEMS (separation on the CPU),
//                        instead of a fresh profile's first DirectML attempt (which can hang some integrated GPUs)
//   node scripts/four-deck-soak.mjs --baseline --decks 2 --minutes 5      (playback-only comparison run; also works on
//                                                                         builds from before the four-deck engine)
//
// Runs in a throwaway Electron profile (DBDJ_SMOKE_TEST) with generated test audio — it never touches your
// library, settings or music. Audio plays on the default output at -40 dB master (near-silent).
// Writes report.json + screenshots/ to --out and prints a summary. See docs/architecture/four-deck-performance-engine.md §29.
import { spawn, execFile } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(`--${name}`);
const minutes = Number(arg("minutes", "30"));
const port = Number(arg("port", "9333"));
const out = path.resolve(arg("out", path.join(os.tmpdir(), `dbdj-four-deck-soak-${Date.now()}`)));
const stemsModel = arg("stems-model", "");
const baseline = flag("baseline");
const deckCount = Number(arg("decks", "4"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ───────────────────────── test audio ─────────────────────────
function wav(channels, rate) {
  const n = channels[0].length, data = Buffer.alloc(44 + n * 4);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 4, 4); data.write("WAVE", 8); data.write("fmt ", 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(channels[c][i] * 32767))), 44 + i * 4 + c * 2);
  return data;
}
/** A four-on-the-floor beat at `bpm` with a bass line and a pad on `root` Hz (peak ≈ 0.6). */
function beatTrack(bpm, root, seconds, rate = 44100) {
  const n = Math.floor(seconds * rate), L = new Float32Array(n), R = new Float32Array(n), beat = 60 / bpm;
  let seed = 1234 + bpm;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, inBeat = t % beat, eighth = t % (beat / 2), b = Math.floor(t / beat);
    const kick = inBeat < 0.18 ? Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-inBeat * 30)) * inBeat) * Math.exp(-inBeat * 18) * 0.5 : 0;
    const noise = rnd(); hp = 0.85 * (hp + noise - prev); prev = noise;
    const hat = Math.abs(inBeat - beat / 2) < 0.03 ? hp * Math.exp(-Math.abs(inBeat - beat / 2) * 120) * 0.12 : 0;
    const bassF = root * (b % 8 < 4 ? 1 : 1.5);
    const bass = Math.sin(2 * Math.PI * bassF * t) * Math.exp(-eighth * 6) * 0.15;
    const pad = Math.sin(2 * Math.PI * root * 4 * t) * 0.04 + Math.sin(2 * Math.PI * root * 6.02 * t) * 0.03;
    L[i] = kick + hat + bass + pad; R[i] = kick + hat * 0.8 + bass + pad;
  }
  return wav([L, R], rate);
}
function toneTrack(freq, seconds, amp = 0.25, rate = 44100) {
  const n = Math.floor(seconds * rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return wav([x, x], rate);
}
async function makeAudio(dir) {
  await fs.mkdir(dir, { recursive: true });
  const beats = [[124, 55], [126, 61.7], [122, 49], [128, 65.4], [125, 58.3], [123, 51.9]].map(([bpm, root], i) => ({ file: path.join(dir, `beat-${String.fromCharCode(65 + i)}-${bpm}bpm.wav`), bpm, root }));
  for (const b of beats) await fs.access(b.file).catch(async () => fs.writeFile(b.file, beatTrack(b.bpm, b.root, 6 * 60)));
  const tones = [220, 277.18, 329.63, 440].map((f) => ({ file: path.join(dir, `tone-${f}hz.wav`), f }));
  for (const t of tones) await fs.access(t.file).catch(async () => fs.writeFile(t.file, toneTrack(t.f, 40)));
  return { beats, tones };
}

// ───────────────────────── CDP ─────────────────────────
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0; const pending = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          else if (msg.method === "Inspector.targetCrashed" || msg.method === "Inspector.detached") cdpEvents.push({ t: new Date().toISOString(), method: msg.method, params: msg.params });
        };
        ws.onclose = () => { cdpEvents.push({ t: new Date().toISOString(), method: "socket closed" }); for (const r of pending.values()) r({ result: { exceptionDetails: { text: "CDP socket closed" } } }); pending.clear(); };
        const send = (method, params = {}) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
        return { ws, send };
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("Could not connect to the app over CDP");
}
let cdp;
const cdpEvents = [];
async function js(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ""}`);
  return r.result?.result?.value;
}
async function shot(name, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(out, "screenshots", `${name}-${width}x${height}.png`);
  await fs.writeFile(file, Buffer.from(r.result.data, "base64"));
  return file;
}
function processMemoryMb(rootPid) {
  // Working set per process type (browser, renderer, gpu, audio, stems/node utility…) of this app instance's process tree.
  return new Promise((res) => {
    if (process.platform !== "win32") return res(null);
    const ps = `$all = Get-CimInstance Win32_Process; $ids = @(${rootPid}); do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })) | Select-Object -Unique } while ($ids.Count -ne $n); $all | Where-Object { $ids -contains $_.ProcessId -and $_.Name -eq 'electron.exe' } | ForEach-Object { $t = 'browser'; if ($_.CommandLine -match '--type=(\S+)') { $t = $matches[1] }; if ($_.CommandLine -match 'utility-sub-type=(\S+)') { $t = $matches[1] -replace '\.mojom\.\w+','' }; "$t=$([math]::Round($_.WorkingSetSize/1MB))" }`;
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], (err, stdout) => {
      if (err) return res(null);
      const by = {};
      for (const line of stdout.trim().split(/\r?\n/)) { const [k, v] = line.split("="); if (k) by[k] = (by[k] ?? 0) + Number(v); }
      by.total = Object.values(by).reduce((a, b) => a + b, 0);
      res(by);
    });
  });
}

// ───────────────────────── run ─────────────────────────
const report = { startedAt: new Date().toISOString(), minutes, environment: {}, checks: {}, soak: { samples: [] }, errors: [] };
const fail = (name, detail) => { report.errors.push({ name, detail }); log("✗", name, detail); };

await fs.mkdir(path.join(out, "screenshots"), { recursive: true });
const audioFiles = await makeAudio(path.join(out, "audio"));
const profile = path.join(out, "profile");
if (flag("stems-gpu-failed")) {
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, "stems-config.json"), JSON.stringify({ device: "auto", gpuFailed: true }));
}
const env = { ...process.env, DBDJ_SMOKE_TEST: "1", DBDJ_SMOKE_USERDATA: profile, DBDJ_SMOKE_WAIT_MS: String((minutes + 20) * 60000), DBDJ_SMOKE_SIZE: "1600x960" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DBDJ_DEV_SERVER;
if (stemsModel) env.DBDJ_STEMS_MODEL_PATH = stemsModel;
log("launching", electronPath, "profile", profile);
const child = spawn(electronPath, [".", `--remote-debugging-port=${port}`], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
let childOut = "";
let childExit = null;
child.stdout.on("data", (d) => (childOut += d));
child.stderr.on("data", (d) => (childOut += d));
child.on("exit", (code, signal) => { childExit = { at: new Date().toISOString(), code, signal }; log("app exited", childExit); });
const saveDiagnostics = () => fs.writeFile(path.join(out, "app-output.log"), `${childOut}\n--- exit: ${JSON.stringify(childExit)}\n--- cdp: ${JSON.stringify(cdpEvents, null, 1)}\n`).catch(() => undefined);
process.on("exit", () => { try { writeFileSync(path.join(out, "app-output.log"), `${childOut}\n--- exit: ${JSON.stringify(childExit)}\n--- cdp: ${JSON.stringify(cdpEvents)}\n`); } catch { /* best effort */ } });
cdp = await connect();
await cdp.send("Runtime.enable");
await cdp.send("Inspector.enable").catch(() => undefined);
await cdp.send("Performance.enable");
for (let i = 0; i < 60 && !(await js("return !!window.dbdj && window.dbdj.audio.getStatus().state === 'running';").catch(() => false)); i++) await sleep(500);

const track = (file, bpm) => JSON.stringify({ ref: file, title: path.basename(file, ".wav"), artist: "soak", album: "", source: "local", bpm, key: null });
report.environment = await js(`
  const a = window.dbdj, s = a.audio.getStatus();
  return { os: navigator.userAgent, cores: navigator.hardwareConcurrency, sampleRate: s.sampleRate, baseLatencyMs: s.baseLatency * 1000, outputLatencyMs: s.outputLatency * 1000, routing: s.routing, decks: a.engine.deckCount,
    renderCapacityApi: "renderCapacity" in AudioContext.prototype, playbackStatsApi: "playbackStats" in AudioContext.prototype };`);
report.environment.machine = { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 2 ** 30) };
log("environment", report.environment);

// Quiet master (-40 dB) for the whole run.
await js(`window.dbdj.bus.send("mixer.master.level", 0.1, "system"); window.dbdj.workspace?.setDeckMode(${deckCount === 4 ? 4 : 2});`);

if (!baseline) {
// 1) Four tracks loaded in quick succession.
{
  const loads = audioFiles.beats.slice(0, 4).map((b, i) => `a.engine.loadTrack(${i}, ${track(b.file, b.bpm)})`).join(", ");
  const r = await js(`const a = window.dbdj; const t0 = performance.now(); await Promise.all([${loads}]); return { ms: performance.now() - t0, status: a.engine.getState().decks.map((d) => d.status), loads: a.engine.getLoadStats() };`);
  report.checks.quickSuccessionLoad = r;
  if (r.status.some((s) => s !== "ready")) fail("quickSuccessionLoad", r.status);
  log("4 loads in parallel:", Math.round(r.ms), "ms", r.status.join(","));
}

// 2) Real summing on the master bus with tone tracks (pure sines; RMS of k uncorrelated sines = √k × one).
{
  const loads = audioFiles.tones.map((t, i) => `await a.engine.loadTrack(${i}, ${track(t.file, null)});`).join("\n");
  const r = await js(`
    const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let d = 1; d <= 4; d++) if (a.engine.getState().decks[d - 1].playing) a.bus.send("deck" + d + ".play", 1, "system");
    ${loads}
    const tap = a.audio.getAnalysisTap("master"), buf = new Float32Array(tap.fftSize);
    const rms = async () => { let acc = 0, n = 0; for (let k = 0; k < 20; k++) { await sleep(25); tap.getFloatTimeDomainData(buf); for (const v of buf) { acc += v * v; n++; } } return Math.sqrt(acc / n); };
    const out = { masterGain: a.engine.getState().mixer.masterLevel ** 2, rms: [] };
    for (let d = 1; d <= 4; d++) { a.bus.send("deck" + d + ".play", 1, "system"); await sleep(250); out.rms.push(await rms()); }
    // Crossfader routing: hard A — B and D drop out; D on THRU comes back.
    a.bus.send("mixer.crossfader", 0, "system"); await sleep(200); out.hardA = await rms();
    a.bus.send("mixer.channel4.xfader.thru", 1, "system"); await sleep(200); out.hardAThruD = await rms();
    a.bus.send("mixer.channel4.xfader.b", 1, "system"); a.bus.send("mixer.crossfader", 0.5, "system");
    // Channel isolation: only deck C's EQ changes deck C's level.
    const lv = () => a.audio.getLevels().channels.slice();
    await sleep(200); const before = lv(); a.bus.send("mixer.channel3.gain", 0.25, "system"); await sleep(250); out.levelsBefore = before; out.levelsAfterTrimC = lv(); a.bus.send("mixer.channel3.gain", 0.5, "system");
    for (let d = 1; d <= 4; d++) a.bus.send("deck" + d + ".play", 1, "system");
    return out;`);
  const one = r.rms[0];
  r.ratios = r.rms.map((v) => v / one);
  r.expectedRatios = [1, Math.SQRT2, Math.sqrt(3), 2];
  r.expectedRmsOneDeck = (0.25 / Math.SQRT2) * r.masterGain;
  report.checks.summing = r;
  const ok = r.ratios.every((x, i) => Math.abs(x - r.expectedRatios[i]) < 0.06) && Math.abs(one / r.expectedRmsOneDeck - 1) < 0.08;
  if (!ok) fail("summing", r);
  // Hard A: A + C only = √2 × one; THRU D adds D = √3 × one.
  if (Math.abs(r.hardA / one - Math.SQRT2) > 0.08 || Math.abs(r.hardAThruD / one - Math.sqrt(3)) > 0.08) fail("crossfaderRouting", { hardA: r.hardA / one, thruD: r.hardAThruD / one });
  const changed = r.levelsAfterTrimC.map((v, i) => Math.abs(v - r.levelsBefore[i]) / Math.max(1e-6, r.levelsBefore[i]));
  if (!(changed[2] > 0.3) || changed.some((c, i) => i !== 2 && c > 0.05)) fail("channelIsolation", changed);
  log("summing ratios", r.ratios.map((x) => x.toFixed(3)).join(" "), "hard-A", (r.hardA / one).toFixed(3), "THRU D", (r.hardAThruD / one).toFixed(3));
}

// 3) Beat tracks back on all four decks, synced to A, playing.
async function loadBeats(offset = 0) {
  const sel = [0, 1, 2, 3].map((i) => audioFiles.beats[(i + offset) % audioFiles.beats.length]);
  const loads = sel.map((b, i) => `await a.engine.loadTrack(${i}, ${track(b.file, b.bpm)});`).join("\n");
  return js(`const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let d = 1; d <= 4; d++) if (a.engine.getState().decks[d - 1].playing) a.bus.send("deck" + d + ".play", 1, "system");
    ${loads}
    for (let i = 0; i < 100 && !a.engine.getState().decks.every((d) => d.beatGrid); i++) await sleep(100);
    for (let d = 1; d <= 4; d++) a.bus.send("deck" + d + ".play", 1, "system");
    a.bus.send("deck1.master", 1, "system");
    for (const d of [2, 3, 4]) if (!a.engine.getState().decks[d - 1].sync) a.bus.send("deck" + d + ".sync", 1, "system");
    await sleep(1500);
    const s = a.engine.getState();
    return { playing: s.decks.map((d) => d.playing), bpm: [0, 1, 2, 3].map((d) => a.engine.getBpm(d)), master: s.masterDeck, phase: [1, 2, 3].map((d) => a.engine.phaseError(d, 0)), grids: s.decks.map((d) => d.beatGrid?.bpm ?? null) };`);
}
{
  const r = await loadBeats();
  report.checks.fourDeckSync = r;
  if (!r.playing.every(Boolean) || r.master !== 0 || r.bpm.some((b) => Math.abs(b - r.bpm[0]) > 0.05)) fail("fourDeckSync", r);
  log("sync", r.bpm.map((b) => b?.toFixed(2)).join(" "), "phase", r.phase.map((p) => p?.toFixed(3)).join(" "));
}

// 4) Mode-switch stress while all four play: playback must not be interrupted, reset or moved.
{
  const r = await js(`const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const snap = () => ({ pos: [0, 1, 2, 3].map((d) => a.engine.getPosition(d)), t: performance.now(), s: a.engine.getState() });
    const before = snap();
    const eq = JSON.stringify(before.s.mixer.channels), cues = JSON.stringify(before.s.decks.map((d) => d.hotcues)), grids = JSON.stringify(before.s.decks.map((d) => d.beatGrid));
    for (let i = 0; i < 200; i++) { a.workspace.toggleDeckMode(); if (i % 10 === 0) await sleep(16); }
    await sleep(300);
    const after = snap();
    const dt = (after.t - before.t) / 1000;
    return { modeNow: a.workspace.get().deckMode, playing: after.s.decks.map((d) => d.playing), advanced: after.pos.map((p, i) => (p - before.pos[i]) / (dt * after.s.decks[i].rate)),
      mixerUnchanged: JSON.stringify(after.s.mixer.channels) === eq, hotcuesUnchanged: JSON.stringify(after.s.decks.map((d) => d.hotcues)) === cues, gridsUnchanged: JSON.stringify(after.s.decks.map((d) => d.beatGrid)) === grids };`);
  report.checks.modeSwitchStress = r;
  if (!r.playing.every(Boolean) || r.advanced.some((x) => x < 0.9 || x > 1.1) || !r.mixerUnchanged || !r.hotcuesUnchanged || !r.gridsUnchanged) fail("modeSwitchStress", r);
  log("200 mode switches: playback advanced", r.advanced.map((x) => x.toFixed(3)).join(" "));
}

// 5) Screenshots of the workspace at the supported window sizes.
if (!flag("skip-shots")) {
  const shots = [];
  const set = (expr) => js(`const a = window.dbdj; ${expr}; await new Promise((r) => setTimeout(r, 400)); return true;`);
  for (const [w, h] of [[1920, 1080], [1440, 900], [1024, 640]]) {
    await set(`a.workspace.setDeckMode(2)`);
    shots.push(await shot("2deck", w, h));
    await set(`a.workspace.setDeckMode(4); a.workspace.setDensity(2, "compact"); a.workspace.setDensity(3, "compact")`);
    shots.push(await shot("4deck-compact", w, h));
  }
  await set(`a.workspace.setDensity(2, "micro"); a.workspace.setDensity(3, "full"); a.controllers.layers.set("left", 2)`);
  shots.push(await shot("4deck-micro-full-layerC", 1440, 900));
  await set(`a.controllers.layers.set("left", 0); a.workspace.setDensity(2, "compact"); a.workspace.setDensity(3, "compact"); a.workspace.setDeckMode(2)`);
  shots.push(await shot("2deck-hidden-playing-indicator", 1440, 900));
  await set(`a.workspace.setDeckMode(4)`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  report.checks.screenshots = shots;
  log("screenshots", shots.length);
}

// 6) STEMS on four playing decks (when a model is available): separation must not interrupt playback.
{
  const r = await js(`const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = a.stems.status;
    if (!st.available) return { available: false, reason: st.reason ?? null };
    // --stems-auto-only: leave STEMS off on the decks (default Automatic mode) — separation should wait while 3+ decks play.
    if (!${flag("stems-auto-only")}) for (let d = 1; d <= 4; d++) if (!a.engine.getState().decks[d - 1].stems.enabled) a.bus.send("deck" + d + ".stems", 1, "system");
    if (${flag("stems-auto-only")}) { await sleep(20000); const s = a.engine.getState(); return { available: true, autoOnly: true, seconds: 20, final: s.decks.map((d) => ({ status: d.stems.status, progress: d.stems.progress, message: d.stems.message ?? null })), playing: s.decks.map((d) => d.playing), timeline: [], rtf: a.stems.status.rtf ?? null }; }
    const t0 = performance.now(); const timeline = [];
    for (let i = 0; i < 240; i++) {
      const s = a.engine.getState();
      timeline.push(s.decks.map((d) => d.stems.status + ":" + Math.round(d.stems.progress * 100)).join(" "));
      if (s.decks.every((d) => d.stems.status === "ready" && d.stems.progress >= 0.999)) break;
      await sleep(1000);
    }
    const s = a.engine.getState();
    return { available: true, seconds: (performance.now() - t0) / 1000, final: s.decks.map((d) => ({ status: d.stems.status, progress: d.stems.progress })), playing: s.decks.map((d) => d.playing), timeline: timeline.filter((_, i) => i % 10 === 0), rtf: a.stems.status.rtf ?? null };`);
  report.checks.stemsFourDecks = r;
  if (r.available && !r.playing.every(Boolean)) fail("stemsFourDecks", r);
  log("stems", r.available ? `${r.final.map((f) => f.status + " " + Math.round(f.progress * 100) + "%").join(", ")} after ${Math.round(r.seconds)} s` : `unavailable: ${r.reason}`);
  // Mute vocals on C while all play, then all stems back.
  if (r.available) await js(`const a = window.dbdj; a.bus.send("deck3.stem.vocals.toggle", 1, "system"); await new Promise((r) => setTimeout(r, 1000)); a.bus.send("deck3.stem.vocals.toggle", 1, "system"); return true;`);
}

// 7) Background analysis is deferred while 3+ decks play, and resumes after.
{
  const lib = audioFiles.beats.slice(4).map((b) => ({ ref: b.file, name: path.basename(b.file) }));
  const r = await js(`const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await a.addFiles(${JSON.stringify(lib)});
    let deferred = null; for (let i = 0; i < 30 && !deferred; i++) { await sleep(500); deferred = a.analysis.getState().deferred ?? null; }
    return { deferred, playing: a.engine.getState().decks.filter((d) => d.playing).length, analysis: a.analysis.getState() };`);
  report.checks.backgroundDeferral = r;
  log("background analysis while 4 play:", r.deferred ?? "not deferred", `(${r.analysis.done}/${r.analysis.total})`);
}

} else {
  // Playback-only comparison: N beat tracks playing and synced, nothing else.
  const loads = audioFiles.beats.slice(0, deckCount).map((b, i) => `await a.engine.loadTrack(${i}, ${track(b.file, b.bpm)});`).join("\n");
  report.checks.baseline = await js(`const a = window.dbdj, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    ${loads}
    for (let i = 0; i < 100 && !a.engine.getState().decks.slice(0, ${deckCount}).every((d) => d.beatGrid); i++) await sleep(100);
    for (let d = 1; d <= ${deckCount}; d++) a.bus.send("deck" + d + ".play", 1, "system");
    for (let d = 2; d <= ${deckCount}; d++) a.bus.send("deck" + d + ".sync", 1, "system");
    await sleep(1000);
    return { decks: ${deckCount}, playing: a.engine.getState().decks.filter((d) => d.playing).length };`);
  log("baseline", report.checks.baseline);
}

// 8) Soak: decks playing for N minutes; reload a deck every 60 s, switch modes every 30 s (four-deck runs).
{
  const t0 = Date.now(), end = t0 + minutes * 60000;
  let lastReload = t0, lastSwitch = t0, reloads = 0, next = 0;
  let prev = null;
  while (Date.now() < end) {
    await sleep(5000);
    const now = Date.now();
    let event = null;
    if (!baseline && now - lastSwitch > 30000) { await js(`window.dbdj.workspace.toggleDeckMode(); await new Promise((r) => setTimeout(r, 200)); window.dbdj.workspace.toggleDeckMode(); return true;`); lastSwitch = now; event = "mode-switch"; }
    if (now - lastReload > 60000) {
      const deck = reloads % deckCount, b = audioFiles.beats[(deckCount + next++) % audioFiles.beats.length];
      event = "reload";
      const r = await js(`const a = window.dbdj; const d = ${deck};
        if (a.engine.getState().decks[d].playing) a.bus.send("deck" + (d + 1) + ".play", 1, "system");
        await a.engine.loadTrack(d, ${track(b.file, b.bpm)});
        a.bus.send("deck" + (d + 1) + ".play", 1, "system");
        if (d !== a.engine.getState().masterDeck && !a.engine.getState().decks[d].sync) a.bus.send("deck" + (d + 1) + ".sync", 1, "system");
        return a.engine.getLoadStats ? a.engine.getLoadStats().slice(-1)[0] : { deck: d };`);
      reloads++; lastReload = now;
      if (!r) fail("reload", deck);
    }
    // Restart any deck that reached its end (6-minute tracks) so all four keep playing.
    const sample = await js(`const a = window.dbdj, s = a.engine.getState(), n = ${deckCount};
      const restarted = [];
      for (const d of s.decks.slice(0, n)) if (!d.playing && d.status === "ready") { restarted.push(d.index); a.bus.send("deck" + (d.index + 1) + ".seek", 0.02, "system"); a.bus.send("deck" + (d.index + 1) + ".play", 1, "system"); }
      const p = a.audio.getPerformance ? a.audio.getPerformance() : null, m = performance.memory, ps = a.audio.ctx?.playbackStats;
      return { t: Date.now(), playing: s.decks.filter((d) => d.playing).length, restarted, pos: s.decks.slice(0, n).map((_, d) => a.engine.getPosition(d)), rates: s.decks.slice(0, n).map((d) => d.rate),
        heapMb: m ? Math.round(m.usedJSHeapSize / 1048576) : null, stalls: p?.clockStalls ?? null, stallMs: p?.clockStallMs ?? null, capacity: p?.renderCapacity ?? null,
        underruns: ps ? { events: ps.underrunEvents, ms: ps.underrunDuration * 1000, total: ps.totalDuration } : null, clip: p?.clipGuardEpisodes ?? null,
        wavMs: window.__waveStats?.avg() ?? null, deferred: a.analysis.getState().deferred ?? null, stemsBusy: s.decks.some((d) => d.stems.status === "analysing" || d.stems.status === "loading"), stems: s.decks.map((d) => d.stems.status + (d.stems.enabled ? "*" : "") + ":" + Math.round(d.stems.progress * 100)).join(" "), master: s.masterDeck };`);
    sample.event = event;
    if (prev) {
      // Each playing deck advanced by about rate × elapsed (a stall/reset would show here; restarts at a track end are excluded).
      sample.advance = sample.pos.map((p, i) => (prev.restarted.includes(i) || sample.restarted.includes(i) ? null : (p - prev.pos[i]) / (((sample.t - prev.t) / 1000) * sample.rates[i])));
      if (sample.underruns && prev.underruns) sample.newUnderruns = { events: sample.underruns.events - prev.underruns.events, ms: Math.round(sample.underruns.ms - prev.underruns.ms) };
    }
    if ((now - t0) % 60000 < 5500) sample.processMb = await processMemoryMb(child.pid);
    report.soak.samples.push(sample);
    prev = sample;
    if (report.soak.samples.length % 12 === 0) log(`soak ${Math.round((now - t0) / 60000)} min: playing ${sample.playing}, heap ${sample.heapMb} MB, processes ${sample.processMb?.total ?? "-"} MB, underruns ${sample.underruns?.events ?? "-"}, stalls ${sample.stalls} (${sample.stallMs} ms), reloads ${reloads}, stems ${sample.stemsBusy ? "busy" : "idle"}, waveform ${sample.wavMs?.toFixed(2)} ms`);
  }
  const s = report.soak.samples;
  const heaps = s.map((x) => x.heapMb).filter((x) => x != null), procs = s.map((x) => x.processMb?.total).filter((x) => x != null);
  const adv = s.flatMap((x) => x.advance ?? []).filter((x) => Number.isFinite(x));
  // Underruns by what else was going on in that 5 s window.
  const bucket = (pred) => { const w = s.filter((x) => x.newUnderruns && pred(x)); return { windows: w.length, events: w.reduce((a, x) => a + x.newUnderruns.events, 0), ms: w.reduce((a, x) => a + x.newUnderruns.ms, 0), windowsWithUnderruns: w.filter((x) => x.newUnderruns.events > 0).length }; };
  const first = s.find((x) => x.underruns), last = s.at(-1);
  report.soak.summary = {
    minutes, decks: deckCount, baseline, samples: s.length, reloads, minPlaying: Math.min(...s.map((x) => x.playing)),
    underrunsDuringSoak: first && last?.underruns ? { events: last.underruns.events - first.underruns.events, ms: Math.round(last.underruns.ms - first.underruns.ms), seconds: Math.round(last.underruns.total - first.underruns.total) } : null,
    underrunsByActivity: {
      steady: bucket((x) => !x.event && !x.stemsBusy),
      stemsSeparating: bucket((x) => !x.event && x.stemsBusy),
      reloadOrModeSwitch: bucket((x) => !!x.event),
    },
    clockStalls: last?.stalls, clockStallMs: last?.stallMs, renderCapacityLast: last?.capacity,
    heapMb: { first: heaps[0], last: heaps.at(-1), max: Math.max(...heaps) }, processMb: { first: s.find((x) => x.processMb)?.processMb, last: [...s].reverse().find((x) => x.processMb)?.processMb, maxTotal: Math.max(...procs) },
    advanceRatio: { min: Math.min(...adv), max: Math.max(...adv) },
    loadMs: await js(`const st = window.dbdj.engine.getLoadStats; if (!st) return null; const l = st.call(window.dbdj.engine).map((x) => x.ms); return { n: l.length, avg: l.reduce((a, b) => a + b, 0) / l.length, max: Math.max(...l), last10: l.slice(-10).map(Math.round) };`),
  };
  log("soak summary", report.soak.summary);
}

report.finishedAt = new Date().toISOString();
report.app = { exit: childExit, cdpEvents };
await saveDiagnostics();
await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
child.kill();
await sleep(500);
log(report.errors.length ? `${report.errors.length} problem(s) — see report.json` : "all checks passed", "→", path.join(out, "report.json"));
process.exit(report.errors.length ? 1 : 0);

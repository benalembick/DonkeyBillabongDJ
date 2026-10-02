/**
 * Electron main process.
 *
 * Responsibilities are deliberately small: window lifecycle, OS permissions
 * (MIDI / audio output selection), and filesystem access for the renderer via
 * a narrow IPC surface. All DJ, audio and controller logic lives in the
 * renderer's engine layers so it can also run in browser mode.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerStreamingIpc } from "./streaming/ipc";
import { registerStemIpc } from "./stems/host";
import { registerLightingIpc } from "./lighting/ipc";
import { registerUpdater } from "./updater";
import { handleArtProtocol, registerArtScheme } from "./library/artwork";

registerArtScheme();
import * as libraryDb from "./library/db";
import { readTags } from "./library/tags";
import { autoDJFixtures, runAutoDJSmoke } from "./autodjSmoke";
import { runLightingSmoke } from "./lightingSmoke";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".opus", ".aif", ".aiff"]);
const ALLOWED_PERMISSIONS = new Set(["midi", "midiSysex", "media", "speaker-selection", "clipboard-sanitized-write", "serial"]);

// Smoke tests run in a throwaway profile so they never touch the user's library, settings or credentials.
if (process.env.DBDJ_SMOKE_TEST) {
  app.setPath("userData", process.env.DBDJ_SMOKE_USERDATA ?? path.join(os.tmpdir(), `dbdj-smoke-${process.pid}`));
}

// A DJ app must keep processing controller input and audio when not focused / minimised.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function isAudioFile(p: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase());
}

async function scanFolder(root: string, maxDepth = 6): Promise<{ path: string; name: string; size: number }[]> {
  const out: { path: string; name: string; size: number }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip, never fail the whole scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && isAudioFile(e.name)) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, name: e.name, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function registerIpc(): void {
  ipcMain.handle("dbdj:preparation:load", () => libraryDb.loadPreparation());
  ipcMain.handle("dbdj:preparation:save", (_e, r) => libraryDb.savePreparation(r));
  ipcMain.handle("dbdj:preparation:waveform", (_e, id: string) => libraryDb.loadWaveform(String(id)));
  ipcMain.handle("dbdj:preparation:waveform-save", (_e, r) => libraryDb.saveWaveform(r));
  ipcMain.handle("dbdj:mashups:load", () => libraryDb.loadMashupRecipes());
  ipcMain.handle("dbdj:mashups:save", (_e, r) => libraryDb.saveMashupRecipe(r));
  ipcMain.handle("dbdj:mashups:remove", (_e, id: string) => libraryDb.removeMashupRecipe(String(id)));
  ipcMain.handle("dbdj:mashup:saveFile", async (e, name: string, data: ArrayBuffer) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const opts = { defaultPath: String(name).replace(/[<>:"/\\|?*]/g, "_"), filters: [{ name: "MP3 audio", extensions: ["mp3"] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, Buffer.from(data));
    return { ref: r.filePath, name: path.basename(r.filePath) };
  });
  // Dialogs are parented to the app window; unparented dialogs can open behind it on Windows.
  const open = (e: IpcMainInvokeEvent, opts: OpenDialogOptions) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts);
  };

  ipcMain.handle("dbdj:openAudioFiles", async (e) => {
    const r = await open(e, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS].map((x) => x.slice(1)) }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle("dbdj:openFolder", async (e) => {
    const r = await open(e, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("dbdj:scanFolder", async (_e, dir: string) => scanFolder(String(dir)));

  // Expand paths dropped from Explorer/Finder: audio files are kept, folders are scanned.
  ipcMain.handle("dbdj:expandPaths", async (_e, paths: unknown) => {
    const out: { path: string; name: string; size: number }[] = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      const p = String(raw);
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) out.push(...(await scanFolder(p)));
        else if (st.isFile() && isAudioFile(p)) out.push({ path: p, name: path.basename(p), size: st.size });
      } catch {
        /* vanished or unreadable: skip */
      }
    }
    return out;
  });

  // Local library database + tag reading (all local; nothing is uploaded anywhere).
  ipcMain.handle("dbdj:library:load", () => libraryDb.loadTracks());
  ipcMain.handle("dbdj:library:upsert", (_e, rows: libraryDb.TrackRow[]) => libraryDb.upsertTracks(Array.isArray(rows) ? rows : []));
  ipcMain.handle("dbdj:library:remove", (_e, refs: string[]) => libraryDb.removeTracks(Array.isArray(refs) ? refs.map(String) : []));
  ipcMain.handle("dbdj:playlists:load", () => libraryDb.loadPlaylists());
  ipcMain.handle("dbdj:playlists:save", (_e, p: libraryDb.PlaylistRow) => {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.refs)) throw new Error("invalid playlist");
    libraryDb.savePlaylist({ id: p.id, name: String(p.name ?? "Playlist"), created_at: Number(p.created_at) || Date.now(), updated_at: Date.now(), refs: p.refs.map(String) });
  });
  ipcMain.handle("dbdj:playlists:remove", (_e, id: string) => libraryDb.removePlaylist(String(id)));
  ipcMain.handle("dbdj:mappings:load", () => libraryDb.loadMappings());
  ipcMain.handle("dbdj:mappings:put", (_e, row: libraryDb.MappingRow) => libraryDb.putMapping(row));
  ipcMain.handle("dbdj:mappings:remove", (_e, key: string) => libraryDb.removeMapping(String(key)));
  ipcMain.handle("dbdj:tags:read", (_e, paths: string[]) => readTags((Array.isArray(paths) ? paths : []).map(String).filter(isAudioFile)));

  ipcMain.handle("dbdj:openExternal", async (_e, url: string) => {
    const u = new URL(String(url));
    const allowed = ["open.spotify.com", "developer.spotify.com", "music.apple.com", "developer.apple.com", "audius.co", "docs.audius.co", "api.audius.co"];
    if (u.protocol !== "https:" || !allowed.includes(u.hostname)) throw new Error("URL not allowed");
    await shell.openExternal(u.toString());
  });

  ipcMain.handle("dbdj:readAudioFile", async (_e, filePath: string) => {
    const p = String(filePath);
    // Only audio files are readable through this channel. Original files are never modified.
    if (!isAudioFile(p)) throw new Error(`Not a supported audio file: ${p}`);
    const buf = await fs.readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle("dbdj:readTextFile", async (_e, filePath: string) => {
    const p = String(filePath);
    if (![".xml", ".json"].includes(path.extname(p).toLowerCase())) throw new Error("Only .xml/.json mapping files");
    return fs.readFile(p, "utf8");
  });

  ipcMain.handle("dbdj:openMappingFile", async (e) => {
    const r = await open(e, {
      properties: ["openFile"],
      filters: [{ name: "Controller mappings", extensions: ["xml", "json"] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
}

/**
 * `npm run smoke`: launch, let the engines start, print a JSON health report
 * (audio status, MIDI devices, errors) to stdout and exit. Used to verify
 * the desktop build on each OS / CI without clicking through the UI.
 */
function runSmokeTest(win: BrowserWindow): void {
  const errors: string[] = [];
  let smokeLighting: unknown = null;
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      let report: unknown = null;
      try {
        // Optional playback check: DBDJ_SMOKE_TRACK=/path/to/file.wav loads it into deck A,
        // plays ~1.5 s through the real output device and reports playhead/levels.
        const track = JSON.stringify(process.env.DBDJ_SMOKE_TRACK ?? "");
        const autoFixtures = process.env.DBDJ_SMOKE_AUTODJ ? await autoDJFixtures() : null;
        smokeLighting = process.env.DBDJ_SMOKE_LIGHTING ? await runLightingSmoke(win, process.env.DBDJ_SMOKE_LIGHTING, process.env.DBDJ_SMOKE_LIGHTING_TRACK ?? "").catch((e) => ({ error: String(e) })) : null;
        report = await win.webContents.executeJavaScript(`(async () => {
          const a = window.dbdj;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          let playback = null;
          const ref = ${track};
          if (ref) {
            await a.engine.loadTrack(0, { ref, title: "smoke", artist: "", album: "", source: "local", bpm: null, key: null });
            a.bus.send("mixer.channel1.volume", 0.3);
            a.bus.send("deck1.play");
            let peak = 0;
            for (let i = 0; i < 15; i++) { await sleep(100); peak = Math.max(peak, a.audio.getLevels().channels[0]); }
            const pos1 = a.engine.getPosition(0);
            a.bus.send("deck1.tempo", 1);
            const rate = a.engine.getState().decks[0].rate;
            a.bus.send("deck1.play");
            await sleep(300);
            const posPaused = a.engine.getPosition(0);
            await sleep(300);
            playback = { state: a.engine.getState().decks[0].status, duration: a.engine.getState().decks[0].duration,
              positionAfter1500ms: pos1, peakLevel: peak, rateAtTempoMax: rate,
              pausedPositionStable: Math.abs(a.engine.getPosition(0) - posPaused) < 0.001 };
          }
          // Audius end-to-end (DBDJ_SMOKE_AUDIUS="search words"): search → controller LOAD A → play and
          // control via simulated DDJ-SB MIDI (same mapping path as the hardware) → measured output.
          const audiusQuery = ${JSON.stringify(process.env.DBDJ_SMOKE_AUDIUS ?? "")};
          let audius = null;
          if (audiusQuery) {
            const midi = (...b) => a.controllers.simulate("pioneer-ddj-sb", b);
            const level = async (ms) => { let p = 0; for (let i = 0; i < ms / 50; i++) { await sleep(50); p = Math.max(p, a.audio.getLevels().channels[0]); } return p; };
            const speed = async (ms) => { const p0 = a.engine.getPosition(0); await sleep(ms); return (a.engine.getPosition(0) - p0) / (ms / 1000); };
            audius = { steps: {} };
            const t0 = performance.now();
            await a.audius.search(audiusQuery);
            const st = a.audius.getState();
            audius.searchMs = Math.round(performance.now() - t0);
            audius.results = st.tracks.length;
            const idx = st.tracks.findIndex((t) => t.streamable && t.durationMs > 60000 && t.durationMs < 420000);
            audius.track = st.tracks[idx] && { id: st.tracks[idx].id, title: st.tracks[idx].title, artist: st.tracks[idx].artist, durationMs: st.tracks[idx].durationMs, bpm: st.tracks[idx].bpm, key: st.tracks[idx].key, isrc: st.tracks[idx].isrc };
            if (idx >= 0) {
              a.browser.setActive(a.audius);
              a.audius.select(idx);
              const progress = new Set();
              const off = a.engine.on("state", (s) => { const d = s.decks[0]; if (d.status === "loading") progress.add(d.loadProgress == null ? "?" : Math.round(d.loadProgress * 10) * 10); });
              const tl = performance.now();
              midi(0x96, 0x46, 0x7f); midi(0x96, 0x46, 0x00);                       // LOAD A
              for (let i = 0; i < 1200 && a.engine.getState().decks[0].status !== "ready" && a.engine.getState().decks[0].status !== "error"; i++) await sleep(50);
              off();
              const d = a.engine.getState().decks[0];
              audius.steps.load = { status: d.status, error: d.error, source: d.track?.source, loadMs: Math.round(performance.now() - tl), progressSeen: [...progress].join(","), duration: d.duration, stream: a.audius.client.stats.lastStream };
              if (d.status === "ready") {
                midi(0xb6, 0x1f, 0x00); midi(0xb6, 0x3f, 0x00);                     // crossfader full A
                midi(0xb0, 0x13, 0x5a); midi(0xb0, 0x33, 0x00);                     // channel fader A ~0.7
                midi(0x90, 0x0b, 0x7f); midi(0x90, 0x0b, 0x00);                     // PLAY A
                audius.steps.play = { playing: a.engine.getState().decks[0].playing, speed: +(await speed(1500)).toFixed(3), peak: +(await level(800)).toFixed(3) };
                midi(0xb0, 0x00, 0x7f); midi(0xb0, 0x20, 0x7f);                     // tempo slider fully down (+10%)
                audius.steps.tempo = { rate: a.engine.getState().decks[0].rate, measuredSpeed: +(await speed(1500)).toFixed(3) };
                midi(0xb0, 0x00, 0x40); midi(0xb0, 0x20, 0x00);                     // tempo centre
                const p0 = a.engine.getPosition(0);
                for (let i = 0; i < 25; i++) { midi(0xb0, 0x21, 0x48); await sleep(8); } // jog ring forward (nudge)
                const nudged = a.engine.getPosition(0) - p0;
                audius.steps.jog = { advancedDuring200ms: +nudged.toFixed(3), note: ">0.2 means the nudge sped playback up" };
                const before = await level(600);
                midi(0xb6, 0x17, 0x00); midi(0xb6, 0x37, 0x00);                     // FILTER A full left (low-pass)
                const filtered = await level(800);
                midi(0xb6, 0x17, 0x40); midi(0xb6, 0x37, 0x00);                     // FILTER centre
                midi(0xb0, 0x0f, 0x00); midi(0xb0, 0x2f, 0x00); midi(0xb0, 0x0b, 0x00); midi(0xb0, 0x2b, 0x00); midi(0xb0, 0x07, 0x00); midi(0xb0, 0x27, 0x00); // all EQs full cut
                const eqCut = await level(800);
                for (const cc of [0x07, 0x0b, 0x0f]) { midi(0xb0, cc, 0x40); midi(0xb0, cc + 0x20, 0x00); } // EQs centre
                audius.steps.eqFilter = { peakBefore: +before.toFixed(3), peakFilterLowpass: +filtered.toFixed(3), peakAllEqCut: +eqCut.toFixed(3) };
                midi(0xb6, 0x1f, 0x7f); midi(0xb6, 0x3f, 0x7f);                     // crossfader full B
                audius.steps.crossfader = { peakWithCrossfaderOnB: +(await level(600)).toFixed(4) };
                midi(0xb6, 0x1f, 0x00); midi(0xb6, 0x3f, 0x00);
                midi(0x97, 0x00, 0x7f); midi(0x97, 0x00, 0x00);                     // PAD A1 (hot cue 1)
                audius.steps.hotcue = { hotcue1: a.engine.getState().decks[0].hotcues[0] };
                a.bus.send("deck1.seek", 0.5);
                await sleep(300);
                audius.steps.seek = { requested: d.duration / 2, position: +a.engine.getPosition(0).toFixed(2) };
                midi(0x90, 0x0b, 0x7f); midi(0x90, 0x0b, 0x00);                     // PLAY A again → pause
                await sleep(300); const pp = a.engine.getPosition(0); await sleep(400); // let already-queued output drain first
                audius.steps.pause = { playing: a.engine.getState().decks[0].playing, stable: Math.abs(a.engine.getPosition(0) - pp) < 0.01 };
                audius.steps.waveform = { overviewReady: !!a.analysis.get(0) };
                audius.deckTrack = { title: a.engine.getState().decks[0].track?.title, bpm: a.engine.getState().decks[0].track?.bpm, key: a.engine.getState().decks[0].track?.key };
              }
            }
            audius.apiStats = { ...a.audius.client.stats, lastStream: undefined };
          }

          // STEMS (DBDJ_SMOKE_STEMS=/path/local.wav; model from DBDJ_STEMS_MODEL_PATH or userData): the deck keeps
          // playing normally while separating; then DDJ-SB STEMS pads (simulated MIDI) mute/solo stems and the output changes.
          const stemFile = ${JSON.stringify(process.env.DBDJ_SMOKE_STEMS ?? "")};
          let stems = null;
          if (stemFile) {
            const midi = (...b) => a.controllers.simulate("pioneer-ddj-sb", b);
            const lvl = async (ms) => { let p = 0; for (let i = 0; i < ms / 50; i++) { await sleep(50); p = Math.max(p, a.audio.getLevels().channels[1]); } return +p.toFixed(4); };
            const speed = async (ms) => { const p0 = a.engine.getPosition(1); await sleep(ms); return +((a.engine.getPosition(1) - p0) / (ms / 1000)).toFixed(3); };
            const deckStems = () => { const st = a.engine.getState().decks[1].stems; return { status: st.status, progress: +st.progress.toFixed(2), enabled: st.enabled, muted: st.muted.join(","), message: st.message }; };
            stems = { steps: {} };
            for (let i = 0; i < 100 && !a.stems.status.available; i++) await sleep(100);
            stems.available = a.stems.status.available;
            stems.reason = a.stems.status.reason;
            const t0 = performance.now();
            await a.engine.loadTrack(1, { ref: stemFile, title: "stems", artist: "", album: "", source: "local", bpm: null, key: null });
            a.bus.send("mixer.channel2.volume", 0.5);
            a.bus.send("mixer.crossfader", 1);
            a.bus.send("deck2.play");
            // 1. Normal playback while the worker loads the model and starts separating.
            stems.steps.playingWhileSeparating = { speeds: [await speed(2000), await speed(2000), await speed(2000)], peak: await lvl(500), stems: deckStems(), worker: a.stems.status.worker };
            a.bus.send("deck2.play"); // pause
            a.bus.send("deck2.seek", 0);
            let firstMs = null;
            for (let i = 0; i < 1500; i++) { await sleep(100); if (a.audio.stemsReadyAtPlayhead(1)) { firstMs = Math.round(performance.now() - t0); break; } }
            stems.steps.firstStems = { msFromLoad: firstMs, stems: deckStems(), worker: a.stems.status.worker, rtf: a.stems.status.rtf };
            a.bus.send("deck2.play");
            const original = await lvl(1500);
            midi(0x98, 0x30, 0x7f); midi(0x98, 0x30, 0x00);           // pad 1: vocals mute (switches STEMS on)
            const noVocals = await lvl(1500);
            const afterMute = deckStems();
            midi(0x98, 0x30, 0x7f); midi(0x98, 0x30, 0x00);           // vocals back: all four stems
            const allStems = await lvl(1500);
            const solo = {};
            for (const [n, note] of [["vocals", 0x38], ["drums", 0x39], ["bass", 0x3a], ["instruments", 0x3b]]) {
              midi(0x98, note, 0x7f); midi(0x98, note, 0x00);         // SHIFT + pad: solo
              solo[n] = await lvl(1500);
              midi(0x98, note, 0x7f); midi(0x98, note, 0x00);         // again: all back
            }
            stems.steps.mixing = { peakOriginal: original, peakVocalsMuted: noVocals, stateAfterPad1: afterMute, peakAllStems: allStems, peakSolo: solo,
              speedWithStems: await speed(1500), leds: ["vocals", "drums", "bass", "instruments"].map((n) => a.engine.getFeedback("deck2.stem." + n)) };
            // Per-stem FX: echo on vocals only.
            a.bus.send("fx.unit1.target.next", 1);
            a.bus.send("fx.unit1.assign.deck2", 1);
            a.bus.send("fx.unit1.on", 1);
            stems.steps.stemFx = { target: a.engine.getState().fx[0].target, peak: await lvl(1000) };
            a.bus.send("fx.unit1.on", 1);
            const env = a.stems.envelopes(1);
            if (env) {
              const sum = (x) => { let t = 0; for (let i = 0; i < x.length; i++) t += x[i]; return +t.toFixed(1); };
              stems.envelopeEnergy = { vocals: sum(env.vocals), drums: sum(env.drums), bass: sum(env.bass), instruments: sum(env.instruments) };
            }
            // 2. Seek ahead: separation re-prioritises from the new playhead.
            a.bus.send("deck2.seek", 0.75);
            const ts = performance.now();
            let seekMs = null;
            for (let i = 0; i < 600; i++) { await sleep(100); if (a.audio.stemsReadyAtPlayhead(1)) { seekMs = Math.round(performance.now() - ts); break; } }
            stems.steps.seek = { stemsAtNewPlayheadMs: seekMs, speed: await speed(1000) };
            // 3. Finish and reload: the second load comes from the cache.
            for (let i = 0; i < 2400 && a.engine.getState().decks[1].stems.status !== "ready" && a.engine.getState().decks[1].stems.status !== "error"; i++) await sleep(100);
            stems.steps.complete = { stems: deckStems(), msFromLoad: Math.round(performance.now() - t0), cache: await window.dbdjDesktop.stems.cacheInfo(), index: a.stems.index() };
            a.bus.send("deck2.play"); // pause so the reload is allowed
            const tc = performance.now();
            await a.engine.loadTrack(1, { ref: stemFile, title: "stems", artist: "", album: "", source: "local", bpm: null, key: null });
            for (let i = 0; i < 300 && a.engine.getState().decks[1].stems.status !== "ready"; i++) await sleep(50);
            stems.steps.cachedReload = { ms: Math.round(performance.now() - tc), stems: deckStems(), readyAtPlayhead: a.audio.stemsReadyAtPlayhead(1) };
            // 4. Library: Remove STEM Cache, then Analyse STEMS in the background (deck B keeps playing).
            a.bus.send("deck2.seek", 0.1);
            a.bus.send("deck2.play");
            await a.stems.removeCache([stemFile]);
            const removed = a.stems.index()[stemFile] ?? "none";
            const tl = performance.now();
            a.stems.analyse([{ ref: stemFile, title: "stems", artist: "", album: "", source: "local", bpm: null, key: null }], (r) => a.platform.readAudio(r));
            for (let i = 0; i < 1200 && a.stems.index()[stemFile] !== "complete"; i++) await sleep(100);
            stems.steps.libraryAnalyse = { indexAfterRemove: removed, index: a.stems.index()[stemFile] ?? "none", ms: Math.round(performance.now() - tl), deckSpeedMeanwhile: await speed(1000), worker: a.stems.status.worker };
            a.bus.send("mixer.channel2.volume", 0);
            // Leave the STEM waveform view on (screenshot), with drums muted to show the dimmed lane.
            document.querySelector(".wave-mode")?.click();
            a.bus.send("deck2.stem.drums.toggle", 1);
            await sleep(500);
          }

          // Demo (DBDJ_SMOKE_DEMO=1): two Audius tracks playing, hot cues and FX set — for layout screenshots.
          let demo = null;
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_DEMO)}) {
            const pool = (await a.audius.client.searchTracks("deep house", 20)).filter((t) => t.streamable && t.durationMs > 120000 && t.durationMs < 420000);
            for (let d = 0; d < 2 && pool[d]; d++) {
              const t = pool[d];
              await a.engine.loadTrack(d, { ref: "audius:" + t.id, title: t.title, artist: t.artist, album: "", source: "audius", bpm: t.bpm, key: t.key, durationMs: t.durationMs, artworkUrl: t.artworkUrl });
            }
            for (let i = 0; i < 600 && a.engine.getState().decks.some((d) => d.status === "loading"); i++) await sleep(50);
            for (let i = 0; i < 100 && a.engine.getState().decks.some((d) => d.status === "ready" && !d.beatGrid); i++) await sleep(50);
            a.bus.send("deck1.seek", 0.3); a.bus.send("deck2.seek", 0.45);
            a.bus.send("deck1.hotcue.1", 1); a.bus.send("deck1.hotcue.1", 0);
            a.bus.send("deck2.hotcue.3", 1); a.bus.send("deck2.hotcue.3", 0);
            a.bus.send("mixer.channel1.volume", 0.25); a.bus.send("mixer.channel2.volume", 0.25);
            a.bus.send("deck1.play"); a.bus.send("deck2.play");
            a.bus.send("fx.unit1.on");
            await sleep(1500);
            demo = a.engine.getState().decks.map((d) => ({ title: d.track?.title, status: d.status, playing: d.playing, grid: d.beatGrid }));
          }

          // Isolation (DBDJ_SMOKE_ISOLATION=/path/local.wav): local track plays on deck B while an Audius load fails on deck A.
          let isolation = null;
          const isoFile = ${JSON.stringify(process.env.DBDJ_SMOKE_ISOLATION ?? "")};
          if (isoFile) {
            await a.engine.loadTrack(1, { ref: isoFile, title: "local", artist: "", album: "", source: "local", bpm: null, key: null });
            a.bus.send("mixer.crossfader", 0.5);
            a.bus.send("deck2.play");
            await sleep(300);
            const p0 = a.engine.getPosition(1);
            const tl = performance.now();
            await a.engine.loadTrack(0, { ref: "audius:doesNotExist123", title: "Broken Audius track", artist: "", album: "", source: "audius", bpm: null, key: null });
            const loadFailMs = Math.round(performance.now() - tl);
            let peak = 0;
            for (let i = 0; i < 10; i++) { await sleep(50); peak = Math.max(peak, a.audio.getLevels().channels[1]); }
            const dA = a.engine.getState().decks[0];
            const dB = a.engine.getState().decks[1];
            isolation = { deckA: { status: dA.status, error: dA.error, failedAfterMs: loadFailMs },
              deckB: { playing: dB.playing, advancedSeconds: +(a.engine.getPosition(1) - p0).toFixed(2), peak: +peak.toFixed(3) } };
            a.bus.send("deck2.play");
          }

          // Milestone 2 (DBDJ_SMOKE_SPOTIFY_AUDIUS=1): Spotify-shaped metadata with no local file → Audius.
          let spotifyAudius = null;
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_SPOTIFY_AUDIUS)}) {
            spotifyAudius = {};
            let prompt = null;
            const offPrompt = a.matching.on("prompt", (p) => { prompt = p; });
            const summarize = (r) => r && { status: r.status, confidence: r.confidence, source: r.best?.source,
              candidates: r.candidates.slice(0, 3).map((c) => ({ source: c.source, title: c.identity.title, artist: c.identity.artists.join(", "), score: c.score, reasons: c.reasons.map((x) => (x.points > 0 ? "+" : "") + x.points + " " + x.label) })),
              notes: r.sourceNotes.map((n) => n.name + ": " + n.message.slice(0, 60)) };
            // Positive: a real Audius original presented as if Spotify supplied its metadata.
            const pool = (await a.audius.client.trending(undefined, 30)).filter((t) => t.streamable && !t.coverOf && !t.remixOf && t.durationMs > 60000 && t.durationMs < 420000);
            const src = pool[0];
            const sp = { provider: "spotify", id: "sp-positive", title: src.title, artist: src.artist, artists: [src.artist], album: "", durationMs: src.durationMs + 700 };
            const info = (t) => ({ ref: "spotify:" + t.id, title: t.title, artist: t.artist, album: t.album, source: "spotify", bpm: null, key: null, durationMs: t.durationMs, isrc: t.isrc ?? null });
            const t1 = performance.now();
            await a.matching.loadToDeck(1, info(sp), sp);
            for (let i = 0; i < 1200 && a.engine.getState().decks[1].status === "loading"; i++) await sleep(50);
            const dB = a.engine.getState().decks[1];
            spotifyAudius.positive = { requested: sp.title + " — " + sp.artist, deckStatus: dB.status, deckSource: dB.track?.source, resolvedFrom: dB.track?.resolvedFrom,
              ms: Math.round(performance.now() - t1), resolution: summarize(a.matching.resultFor(sp)) };
            // Negative: a famous track Audius only has covers/flips of — must not auto-load.
            const neg = { provider: "spotify", id: "sp-negative", title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk, Pharrell Williams",
              artists: ["Daft Punk", "Pharrell Williams"], album: "Random Access Memories", durationMs: 369626, isrc: "USQX91300108" };
            const before = a.engine.getState().decks[0].track?.ref;
            prompt = null;
            await a.matching.loadToDeck(0, info(neg), neg);
            spotifyAudius.negative = { deckAUnchanged: a.engine.getState().decks[0].track?.ref === before, promptedUser: !!prompt, resolution: summarize(a.matching.resultFor(neg)) };
            // Repeat → served from cache, no new API search.
            const reqs = a.audius.client.stats.requests;
            await a.matching.resolver.resolve(a.matching.resultFor(neg).requested);
            spotifyAudius.repeatSearchRequests = a.audius.client.stats.requests - reqs;
            offPrompt();
          }

          // File loading path used by drag & drop: expand a folder, add to library, load into deck B.
          const checks = {};
          if (ref && window.dbdjDesktop) {
            const dir = ref.replace(/[\\\\/][^\\\\/]+$/, "");
            const refs = (await window.dbdjDesktop.expandPaths([dir])).map((f) => ({ ref: f.path, name: f.name }));
            checks.expandedFolderFiles = refs.length;
            await a.addFiles(refs, 1);
            checks.deckBAfterDropLoad = a.engine.getState().decks[1].status;
            checks.libraryCount = a.library.getState().tracks.length;
          }
          // Smart Match demo: a Spotify track (metadata + ISRC only) resolved to a tagged local file and loaded.
          const matchFile = ${JSON.stringify(process.env.DBDJ_SMOKE_MATCH_FILE ?? "")};
          if (matchFile) {
            await a.addFiles([{ ref: matchFile, name: matchFile.split(/[\/]/).pop() }]);
            for (let i = 0; i < 50 && !a.library.getByRef(matchFile)?.tagsRead; i++) await sleep(100);
            await sleep(500); // local index refresh is debounced
            const sp = { provider: "spotify", id: "smoke-sp-1", title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk, Pharrell Williams",
              artists: ["Daft Punk", "Pharrell Williams"], album: "Random Access Memories", durationMs: 2000, isrc: "USQX91300809" };
            await a.matching.loadToDeck(1, { ref: "spotify:smoke-sp-1", title: sp.title, artist: sp.artist, album: sp.album, source: "spotify", bpm: null, key: null, durationMs: 2000, isrc: sp.isrc }, sp);
            const d = a.engine.getState().decks[1];
            const lt = a.library.getByRef(matchFile);
            checks.smartMatch = { deckStatus: d.status, deckTitle: d.track?.title, audioSource: d.track?.source, resolvedFrom: d.track?.resolvedFrom,
              localTags: { title: lt?.title, artist: lt?.artist, isrc: lt?.isrc, durationMs: lt?.durationMs } };
          }
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_INSPECT)} && a.matching.resolver.recent[0]) a.matching.emit("prompt", { deck: 1, result: a.matching.resolver.recent[0] });
          const persisted = ${JSON.stringify(process.env.DBDJ_SMOKE_EXPECT_LIBRARY ?? "")};
          if (persisted) checks.libraryAfterRestart = a.library.getState().tracks.map((t) => ({ title: t.title, isrc: t.isrc }));

          // Streaming IPC round-trips (no network sign-in).
          const bridge = window.dbdjDesktop;
          if (bridge) {
          checks.spotifyStatus = await bridge.streaming.status("spotify");
          checks.appleStatus = await window.dbdjDesktop.streaming.status("apple-music");
          try { await window.dbdjDesktop.streaming.configure("spotify", { clientId: "not-an-id" }); checks.badClientIdRejected = false; }
          catch { checks.badClientIdRejected = true; }
          }
          // Streaming track must be refused by the engine.
          await a.engine.loadTrack(0, { ref: "spotify:x", title: "Streamed", artist: "", album: "", source: "spotify", bpm: null, key: null });
          checks.streamingRefused = a.engine.getState().decks[0].track?.title !== "Streamed";

          // Render every tool tab, every layout and every library source once; collect crashes.
          const tabErrors = [];
          const crash = (what) => { const err = document.querySelector(".panel-error"); if (err) tabErrors.push(what + ": " + err.textContent); };
          document.querySelector(".open-tools")?.click();
          await sleep(200);
          for (const btn of document.querySelectorAll(".tools-overlay .tabs button")) { btn.click(); await sleep(250); crash(btn.textContent); }
          document.querySelector(".tools-overlay .modal-close")?.click();
          for (const btn of document.querySelectorAll(".browser-sources button[data-source]")) { btn.click(); await sleep(200); crash("library " + btn.textContent); }
          document.querySelector('.browser-sources [data-source="local-all"]')?.click();
          // Layout switching must not touch the engine: same tracks, positions and play state before/after.
          const snap = () => JSON.stringify(a.engine.getState().decks.map((d) => [d.track?.ref, d.status, d.playing, d.hotcues]));
          const before = snap();
          const layoutFps = {};
          for (const mode of ["vertical", "classic", "horizontal"]) {
            document.querySelectorAll(".layout-switch > button").forEach((b) => b.textContent === mode.toUpperCase() && b.click());
            await sleep(300);
            crash("layout " + mode);
            await sleep(1500); // steady state, not the mount
            if (window.__waveStats) window.__waveStats.samples.length = 0;
            let frames = 0; let worst = 0; let last = performance.now(); const t0 = last;
            await new Promise((r) => { const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; if (now - t0 < 2000) requestAnimationFrame(tick); else r(); }; requestAnimationFrame(tick); });
            layoutFps[mode] = Math.round(frames / 2) + " fps (worst frame " + worst.toFixed(0) + " ms)" + " fps, wave draw " + (window.__waveStats ? window.__waveStats.avg().toFixed(2) : "?") + " ms";
          }
          checks.layoutSwitchPreservedEngineState = snap() === before;
          checks.layoutFps = layoutFps;
          const wantLayout = ${JSON.stringify(process.env.DBDJ_SMOKE_LAYOUT ?? "")};
          if (wantLayout) {
            // Layout buttons live in the VIEW menu.
            document.querySelector(".view-menu-trigger")?.click();
            await sleep(200);
            document.querySelectorAll(".view-popover .layout-switch:not(.wave-style-picker) > button").forEach((b) => b.textContent.trim().toUpperCase() === wantLayout.toUpperCase() && b.click());
            await sleep(400);
          }
          // EQ-reactive waveform (DBDJ_SMOKE_EQ=1): sweep deck A's LOW/MID through the DDJ-SB mapping while
          // playing, measure frame times + playback speed, then kill LOW on deck A only for the screenshot.
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_EQ)} && a.engine.getState().decks[0].status === "ready") {
            const midi = (...b) => a.controllers.simulate("pioneer-ddj-sb", b);
            a.bus.send("mixer.channel1.volume", 0.3);
            if (!a.engine.getState().decks[0].playing) a.bus.send("deck1.play");
            await sleep(300);
            const p0 = a.engine.getPosition(0), t0 = performance.now();
            let frames = 0, worst = 0, last = performance.now(), running = true;
            const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; if (running) requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
            for (let i = 0; i < 150; i++) {
              const v = Math.round(64 + 63 * Math.sin(i / 5));
              if (${JSON.stringify(process.env.DBDJ_SMOKE_EQ ?? "")} === "filter") { midi(0xb6, 0x17, v); midi(0xb6, 0x37, 0); midi(0xb6, 0x17, 127 - v); midi(0xb6, 0x37, 0); } // baseline: FILTER A (no waveform change)
              else {
              midi(0xb0, 0x0f, v); midi(0xb0, 0x2f, 0);         // LOW knob A (14-bit MSB/LSB)
              midi(0xb0, 0x0b, 127 - v); midi(0xb0, 0x2b, 0);   // MID knob A
              }
              await sleep(16);
            }
            running = false;
            const secs = (performance.now() - t0) / 1000;
            checks.eqSweep = { midiMessages: 600, fps: Math.round(frames / secs), worstFrameMs: Math.round(worst), playbackSpeed: +((a.engine.getPosition(0) - p0) / secs).toFixed(3), waveDrawMs: window.__waveStats ? +window.__waveStats.avg().toFixed(2) : null };
            midi(0xb0, 0x0b, 0x40); midi(0xb0, 0x2b, 0);         // MID centre
            midi(0xb0, 0x0f, 0x00); midi(0xb0, 0x2f, 0);         // LOW fully down = kill
            await sleep(400);
            const c = a.engine.getState().mixer.channels;
            checks.eqState = { deckA: { low: c[0].eqLow, mid: c[0].eqMid }, deckB: { low: c[1].eqLow, mid: c[1].eqMid } };
          }
          // Headphone routing (DBDJ_SMOKE_HEADPHONES=1, no track loaded — nothing plays): 4-channel routing
          // on a 2-channel device falls back to stereo; switching only the device to the DDJ-SB must enable it.
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_HEADPHONES)}) {
            const outs = await a.audio.listOutputDevices();
            const ddj = outs.find((d) => /ddj[- ]?sb/i.test(d.label) && d.id !== "default" && !/^communications/i.test(d.id));
            const other = outs.find((d) => !/ddj[- ]?sb/i.test(d.label) && d.id !== "default" && !/^communications/i.test(d.id));
            const st = () => { const s = a.audio.getStatus(); return { routing: s.routing, channels: s.maxOutputChannels, state: s.state }; };
            const base = a.audio.getConfig();
            const hp = { devices: outs.map((d) => d.label) };
            if (ddj && other) {
              await a.audio.reconfigure({ ...base, outputDeviceId: other.id, routing: "quad" });
              hp.quadOnTwoChannelDevice = { device: other.label, ...st() };
              await a.audio.reconfigure({ ...a.audio.getConfig(), outputDeviceId: ddj.id }); // device-only change
              hp.thenDeviceOnlySwitchToDdj = { device: ddj.label, ...st() };
              await a.audio.reconfigure({ ...base, routing: "stereo" });
              hp.stereo = st();
              await a.audio.reconfigure({ ...a.audio.getConfig(), outputDeviceId: ddj.id, routing: "quad" }); // the Settings one-click button
              hp.oneClickDdjHeadphoneCue = st();
              a.bus.send("mixer.channel1.cue", 1); a.bus.send("mixer.channel1.cue", 0);
              await a.audio.reconfigure({ ...base, routing: "stereo" });
              a.bus.send("mixer.channel2.cue", 1); a.bus.send("mixer.channel2.cue", 0);
              hp.cueWarningWhenStereo = a.log.all().filter((e) => e.source === "audio" && /Headphone CUE/.test(e.message)).map((e) => e.message);
              await a.audio.reconfigure(base);
            }
            checks.headphones = hp;
          }
          // Waveform style (DBDJ_SMOKE_WAVESTYLE=Simple|Filtered|RGB|RGB L/R|HSV), picked in the VIEW menu like a user would.
          const wantStyle = ${JSON.stringify(process.env.DBDJ_SMOKE_WAVESTYLE ?? "")};
          if (wantStyle) {
            if (!document.querySelector(".view-popover")) document.querySelector(".view-menu-trigger")?.click();
            await sleep(200);
            document.querySelectorAll(".wave-style-picker > button").forEach((b) => b.textContent.trim() === wantStyle && b.click());
            await sleep(100);
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            await sleep(500);
            checks.waveStyle = JSON.parse(localStorage.getItem("dbdj.ui.layout.v1") || "{}").waveStyle;
          }
          // App updates (DBDJ_SMOKE_UPDATES=1): a real check against GitHub Releases, then the About page
          // (an installed Windows build downloads the update; set DBDJ_SMOKE_UPDATES_WAIT_MS to wait for it).
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_UPDATES)} && window.dbdjDesktop?.updates) {
            const u = window.dbdjDesktop.updates;
            const seen = [];
            const off = u.onStatus((s) => seen.push(s.state + (s.percent != null ? " " + s.percent + "%" : "")));
            await u.check();
            const until = performance.now() + ${Number(process.env.DBDJ_SMOKE_UPDATES_WAIT_MS ?? 0)};
            while (performance.now() < until && (await u.status()).state === "downloading") await sleep(250);
            off();
            checks.updates = { final: await u.status(), seen: [...new Set(seen)] };
            document.querySelector(".statuses .utility-button:last-child")?.click();
            await sleep(400);
          }
          // Simulate what an OS file drop does by default: navigate to the file. Must be blocked.
          if (ref) location.href = "file:///" + ref.replace(/\\\\/g, "/");
          await sleep(800);
          checks.stillOnAppAfterNavigationAttempt = !!document.querySelector(".topbar");
          const clickSel = ${JSON.stringify(process.env.DBDJ_SMOKE_BROWSER_CLICK ?? "")};
          const autoDJ = ${process.env.DBDJ_SMOKE_AUTODJ ? `await (${runAutoDJSmoke.toString()})(a, ${JSON.stringify(autoFixtures)})` : "null"};
          if (clickSel) { document.querySelector(clickSel)?.click(); await sleep(1500); }
          return {
            autoDJ,
            stems,
            demo,
            isolation,
            spotifyAudius,
            audius,
            checks,
            tabErrors,
            audio: a.audio.getStatus(),
            midi: a.controllers.getAvailability(),
            controllers: a.controllers.getControllers(),
            playback,
            log: a.log.all().map(e => e.level + " [" + e.source + "] " + e.message),
          };
        })()`);
      } catch (err) {
        errors.push(String(err));
      }
      for (const e of (report as { tabErrors?: string[] } | null)?.tabErrors ?? []) errors.push(`panel crashed: ${e}`);
      const shot = process.env.DBDJ_SMOKE_SCREENSHOT;
      if (shot) {
        try {
          await fs.writeFile(shot, (await win.webContents.capturePage()).toPNG());
        } catch (err) {
          errors.push(`screenshot: ${String(err)}`);
        }
      }
      const gpuStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
      const gpu = { canvas: gpuStatus["2d_canvas"], compositing: gpuStatus.gpu_compositing, rasterization: gpuStatus.rasterization };
      process.stdout.write(`DBDJ_SMOKE ${JSON.stringify({ report, errors, gpu, lighting: smokeLighting }, null, 2)}\n`);
      app.exit(errors.length ? 1 : 0);
    }, Number(process.env.DBDJ_SMOKE_WAIT_MS ?? 8000));
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0d0f12",
    title: "Donkey Billabong DJ",
    webPreferences: {
      // DBDJ_SMOKE_BROWSER=1 omits the desktop bridge to exercise browser mode in smoke tests.
      preload: process.env.DBDJ_SMOKE_BROWSER ? undefined : path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Dropping a file on the window must never navigate away from the app (Electron's default).
  win.webContents.on("will-navigate", (e, url) => {
    const devServer = process.env.DBDJ_DEV_SERVER;
    if (!(devServer && url.startsWith(devServer))) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const smokeSize = /^(\d+)x(\d+)$/.exec(process.env.DBDJ_SMOKE_SIZE ?? "");
  if (process.env.DBDJ_SMOKE_TEST && smokeSize) win.setContentSize(Number(smokeSize[1]), Number(smokeSize[2]));
  if (process.env.DBDJ_SMOKE_TEST) runSmokeTest(win);

  const devServer = process.env.DBDJ_DEV_SERVER;
  if (devServer) {
    void win.loadURL(devServer);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  handleArtProtocol();
  // USB DMX (Web Serial): choose a DMX interface automatically — FTDI-based interfaces
  // (Enttec DMX USB Pro, DMXking…) or ports that say DMX/Enttec — never an arbitrary COM port.
  ses.on("select-serial-port", (event, portList, _wc, callback) => {
    event.preventDefault();
    const text = (p: (typeof portList)[number]) => `${p.displayName ?? ""} ${p.portName ?? ""}`;
    // Electron reports vendorId in decimal ("1027" = 0x0403, FTDI); accept hex too, and the Windows device id.
    const isFtdi = (p: (typeof portList)[number]) =>
      Number(p.vendorId) === 0x0403 || (p.vendorId ?? "").toLowerCase() === "0403" || /VID_0403/i.test((p as { deviceInstanceId?: string }).deviceInstanceId ?? "");
    const pick = portList.find((p) => /dmx|enttec|ultradmx/i.test(text(p))) ?? portList.find(isFtdi);
    if (process.env.DBDJ_SMOKE_TEST) process.stderr.write(`[serial] ports: ${JSON.stringify(portList)} → ${pick?.portId ?? "none"}\n`);
    callback(pick ? pick.portId : "");
  });
  ses.setDevicePermissionHandler((details) => details.deviceType === "serial");
  registerIpc();
  registerStreamingIpc();
  registerLightingIpc();
  registerUpdater();
  void registerStemIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

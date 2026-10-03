/**
 * DBDJ_SMOKE_TRAINING="/a.wav|/b.wav": DJ Training end to end — set up a "performance session",
 * run Manual Beatmatching practice as the user would (PLAY, tempo fader, alignment), run an
 * assessed Quick Cut timed on the audio clock, then exit and check everything was restored and
 * ordinary mixing (incl. SYNC) works. DBDJ_SMOKE_TRAINING_STOP=coach stops in the coaching
 * panel for a screenshot.
 */
import type { BrowserWindow } from "electron";

export async function runTrainingSmoke(win: BrowserWindow, files: string, stopAt: string): Promise<unknown> {
  const [a, b] = files.split("|");
  return win.webContents.executeJavaScript(`(async () => {
    const app = window.dbdj, t = app.training, e = app.engine, bus = app.bus;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms = 30000) => { const t0 = performance.now(); while (!f()) { if (performance.now() - t0 > ms) return false; await sleep(10); } return true; };
    const name = (p) => p.split(/[\\\\/]/).pop();
    const A = ${JSON.stringify(a)}, B = ${JSON.stringify(b)};
    await app.addFiles([{ ref: A, name: name(A) }, { ref: B, name: name(B) }]);
    app.analysis.cancelBatch();
    for (const ref of [A, B]) await app.analysis.analyseOne(app.library.getByRef(ref));
    const out = {};
    // A "performance session" before training: B's track on deck A at +2%, faders moved.
    await e.loadTrack(0, app.library.getByRef(B));
    e.setRateDirect(0, 1.02);
    bus.send("mixer.channel1.volume", 0.4); bus.send("mixer.crossfader", 0.3); bus.send("mixer.channel2.eq.low", 0.7);
    const before = { ref: e.getState().decks[0].track.ref, rate: e.getState().decks[0].rate, vol: e.getState().mixer.channels[0].volume, xf: e.getState().mixer.crossfader, low2: e.getState().mixer.channels[1].eqLow };
    window.dispatchEvent(new CustomEvent("dbdj:navigate", { detail: "training" }));
    await sleep(300);
    if (${JSON.stringify(stopAt)} === "dashboard") return out;
    // ── Manual Beatmatching: guided practice ──
    t.selectLesson("beatmatch");
    out.suggestions = t.getState().suggestions.map((p) => p.a.title + " → " + p.b.title + ": " + p.reasons.join("; "));
    t.setTrack("a", A); t.setTrack("b", B);
    if (${JSON.stringify(stopAt)} === "setup") { await sleep(300); return out; }
    await t.start("practice");
    const s0 = e.getState();
    out.practiceStart = { phase: t.getState().phase, playing: s0.decks.map((d) => d.playing), bRate: +s0.decks[1].rate.toFixed(4), syncLocked: e.isSyncLocked(), assists: t.getState().assists };
    bus.send("deck2.sync");
    out.syncPressDuringLesson = e.getState().decks[1].sync;
    const g = e.getState().decks[0].beatGrid, gb = e.getState().decks[1].beatGrid, beat = 60 / g.bpm;
    bus.send("deck1.play");
    // Start B on one of A's downbeats.
    const nextBar = () => { const p = e.getPosition(0); const k = Math.ceil((p - g.firstBeat) / (beat * 4) + 0.05); return g.firstBeat + k * beat * 4; };
    let target = nextBar();
    await until(() => e.getPosition(0) >= target - 0.004, 10000);
    bus.send("deck2.play");
    await sleep(1500);
    out.afterStart = { step: t.getState().step, hints: t.getState().hints, meter: t.getState().meter, highlights: t.getState().highlights };
    // Move B's tempo to the match (what the tempo fader does), then align the phase (as nudging would).
    e.setRateDirect(1, (g.bpm * e.getState().decks[0].rate) / gb.bpm);
    await sleep(3500);
    out.afterTempo = { step: t.getState().step, hints: t.getState().hints, meter: t.getState().meter };
    // Align with the jog wheel, as the user would: small nudges through the normal control path.
    const nudges = [];
    const tAlign = performance.now();
    while (t.getState().step < 5 && performance.now() - tAlign < 45000) {
      const ph = t.getState().meter?.phaseMs ?? 0;
      if (Math.abs(ph) > 6) { const ticks = ph > 0 ? -2 : 2; bus.send("deck2.jog.ring", ticks, "midi"); nudges.push(Math.round(ph)); }
      await sleep(60);
    }
    out.nudges = nudges.length + " nudges, phase readings: " + nudges.slice(0, 12).join(", ");
    out.afterAlign = { step: t.getState().step, message: t.getState().message, meter: t.getState().meter };
    if (${JSON.stringify(stopAt)} === "coach") { t.retry(); await sleep(1200); bus.send("deck1.play"); await sleep(2500); return out; }
    // ── Quick Cut: assessed, cut on the phrase, timed from the audio clock ──
    await t.exit(); // leave the beatmatching lesson first: lessons aren't switched mid-session
    t.selectLesson("quickcut");
    t.setTrack("a", A); t.setTrack("b", B);
    t.setCutOn("phrase");
    await t.start("assess");
    out.quickcutAssists = t.getState().assists;
    bus.send("deck1.play");
    await sleep(300);
    const p0 = e.getPosition(0), phr = beat * 32;
    const boundary = g.firstBeat + Math.ceil((p0 - g.firstBeat) / phr + 0.01) * phr;
    await until(() => e.getPosition(0) >= boundary - 0.002, 40000);
    bus.send("deck2.play"); bus.send("mixer.channel2.volume", 1); bus.send("mixer.channel1.volume", 0);
    out.cutAt = { aPos: +e.getPosition(0).toFixed(4), boundary: +boundary.toFixed(4) };
    await until(() => t.getState().phase === "results", 30000);
    const r = t.getState().result;
    out.quickcutResult = r && { total: r.total, metrics: r.metrics.map((m) => m.label + ": " + (m.score ?? "n/a") + " — " + m.value), strengths: r.strengths, improvements: r.improvements };
    out.progress = Object.fromEntries(Object.entries(t.getState().progress).map(([k, v]) => [k, { completed: v.completed, best: v.best, attempts: v.attempts.length }]));
    // ── Exit: restore ──
    await t.exit();
    await sleep(300);
    const s1 = e.getState();
    out.restored = { ref: s1.decks[0].track?.ref === before.ref, rate: +s1.decks[0].rate.toFixed(4), expectRate: before.rate, vol: +s1.mixer.channels[0].volume.toFixed(3), expectVol: before.vol, xf: +s1.mixer.crossfader.toFixed(3), expectXf: before.xf, low2: +s1.mixer.channels[1].eqLow.toFixed(3), expectLow2: before.low2, syncLocked: e.isSyncLocked(), hidden: document.documentElement.classList.contains("practice-hide-bpm"), phase: t.getState().phase, message: t.getState().message };
    // Ordinary mixing still works.
    await e.loadTrack(1, app.library.getByRef(A));
    bus.send("deck2.sync");
    bus.send("deck1.play");
    await sleep(500);
    out.normalMixing = { deck1Playing: e.getState().decks[0].playing, deck2Sync: e.getState().decks[1].sync };
    bus.send("deck1.play");
    return out;
  })()`);
}

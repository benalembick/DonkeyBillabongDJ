/**
 * DBDJ_SMOKE_TRANSITIONS="/a.wav|/b.wav": Transition Intelligence end to end in the app —
 * import two tracks, analyse them from the Transitions page, read the plan, save/reopen it,
 * change a beat grid (plan recalculated), rehearse (press PLAY on B when the countdown says
 * NOW and measure the error on the audio clock), check a live deck blocks rehearsal, and
 * leave the page open for the screenshot.
 */
import type { BrowserWindow } from "electron";

export async function runTransitionSmoke(win: BrowserWindow, files: string): Promise<unknown> {
  const [a, b] = files.split("|");
  return win.webContents.executeJavaScript(`(async () => {
    const app = window.dbdj;
    const t = app.transitions;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms = 60000) => { const t0 = performance.now(); while (!f()) { if (performance.now() - t0 > ms) throw new Error("timeout"); await sleep(50); } };
    const name = (p) => p.split(/[\\\\/]/).pop();
    await app.addFiles([{ ref: ${JSON.stringify(a)}, name: name(${JSON.stringify(a)}) }, { ref: ${JSON.stringify(b)}, name: name(${JSON.stringify(b)}) }]);
    app.analysis.cancelBatch();
    document.querySelector('.main-navigation button[title="Transitions"]')?.click();
    await sleep(300);
    t.setTrack("out", ${JSON.stringify(a)});
    t.setTrack("in", ${JSON.stringify(b)});
    await sleep(300);
    const out = { missingBefore: t.getState().missing };
    // Analyse from the page (stages are shown while it runs).
    const stages = new Set();
    const off = t.on("change", (s) => { for (const j of Object.values(s.jobs)) stages.add(j.stage); });
    if (!t.getState().out?.analysed) await t.analyse("out");
    if (!t.getState().in?.analysed) await t.analyse("in");
    off();
    await until(() => t.getState().plan || t.getState().problem);
    out.stagesShown = [...stages];
    const s = t.getState();
    const p = s.plan;
    out.grids = { a: s.out.grid, b: s.in.grid };
    out.options = s.options.map((o) => ({ id: o.info.id, available: o.available, recommended: o.recommended, confidence: o.confidence, why: o.why.slice(0, 90) }));
    out.plan = p && { technique: p.technique, bars: p.bars, outStart: p.outStart, outStartBar: p.outStartBar, inCue: p.inCue, inCueBar: p.inCueBar, seconds: p.seconds, targetBpm: p.targetBpm, inTempoPct: p.inTempoPct, swapAtBar: p.swapAtBar, summary: p.summary, warnings: p.warnings.map((w) => w.level + ": " + w.text.slice(0, 80)), steps: p.steps.map((x) => x.n + " [" + x.atBeat + "] " + x.text.slice(0, 100)) };
    // Recalculation: 32-bar bass swap, then back.
    t.setSettings({ technique: "bass-swap", bars: 32 });
    out.bassSwap32 = { seconds: t.getState().plan?.seconds, swapAtBar: t.getState().plan?.swapAtBar };
    t.setSettings({ technique: "blend", bars: 16 });
    // Save, clear, reopen.
    t.save();
    const key = t.getState().savedKey;
    t.setTrack("out", null);
    await sleep(200);
    t.open(key);
    await until(() => t.getState().plan);
    out.reopened = { key, sameStart: Math.abs(t.getState().plan.outStart - p.outStart) < 1e-6, saved: t.getState().saved.length };
    // Analysis change → recalculated and said so.
    t.nudgeGrid("out", { beats: 1 });
    await until(() => t.getState().notice);
    const moved = t.getState().plan.outStart - p.outStart;
    out.gridChange = { notice: t.getState().notice, outStartMovedBy: +moved.toFixed(4), oneBeat: +(60 / s.out.grid.bpm).toFixed(4) };
    t.nudgeGrid("out", { beats: -1 });
    await sleep(400);
    // Rehearsal: 2 bars lead-in; press PLAY on B when the countdown reaches the start.
    t.setLeadBars(2);
    await t.rehearse();
    out.rehearsalStatus = t.getState().rehearsal.status;
    const r = t.getState().rehearsal;
    const plan = t.getState().plan;
    const g = t.getState().out.grid;
    const bStart = g.firstBeat + plan.bStartsAtBar * 240 / g.bpm;
    const samples = [];
    let pressedAt = null;
    for (let i = 0; i < 2000 && !pressedAt; i++) {
      const c = t.cue();
      if (c) samples.push({ beat: +c.beat.toFixed(3), countdown: c.countdown?.totalBeats });
      if (c && c.beat >= -0.005) { app.bus.send("deck" + (r.inDeck + 1) + ".play"); pressedAt = app.engine.getPosition(r.outDeck); }
      await sleep(4);
    }
    await sleep(200);
    out.rehearsal = { outDeck: r.outDeck, inDeck: r.inDeck, leadBars: 2, firstBeatSeen: samples[0], pressedAtA: pressedAt, plannedBStart: bStart,
      measuredStartError: t.getState().rehearsal.startError, inDeckAt: +app.engine.getPosition(r.inDeck).toFixed(3), inCue: plan.inCue, inRate: app.engine.getState().decks[r.inDeck].rate,
      cueAfter: t.cue() && { bar: t.cue().transitionBar, current: t.cue().current?.text.slice(0, 60) } };
    // Live-mix guard: stop, play a deck yourself, then ask to rehearse.
    t.stopRehearsal();
    await sleep(200);
    app.bus.send("deck1.play");
    await sleep(200);
    await t.rehearse();
    out.liveGuard = { status: t.getState().rehearsal.status, message: t.getState().rehearsal.message };
    await t.stopDecksAndRehearse();
    out.afterExplicitStop = t.getState().rehearsal.status;
    await sleep(1500);
    out.markersOnA = t.markersFor(t.getState().out.trackId).map((m) => m.label + "@" + m.t.toFixed(2));
    const scrollTo = ${JSON.stringify(process.env.DBDJ_SMOKE_TX_SCROLL ?? "")};
    if (scrollTo) { document.querySelector(scrollTo)?.scrollIntoView({ block: "start" }); await sleep(600); }
    return out;
  })()`);
}

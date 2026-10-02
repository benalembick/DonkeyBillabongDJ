/**
 * DBDJ_SMOKE_SCRATCH=/path/track.wav: scratches deck A's scrolling waveform with real
 * OS mouse input — hold still, drag back, drag forward, release — while playing and
 * while paused, reporting the playhead and output level after each step.
 */
import type { BrowserWindow } from "electron";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScratchSmoke(win: BrowserWindow, file: string): Promise<unknown> {
  const wc = win.webContents;
  const js = <T>(code: string) => wc.executeJavaScript(code) as Promise<T>;
  await js(`(async () => {
    const a = window.dbdj;
    await a.engine.loadTrack(0, { ref: ${JSON.stringify(file)}, title: "scratch", artist: "", album: "", source: "local", bpm: null, key: null });
    a.bus.send("mixer.channel1.volume", 0.4);
    a.bus.send("mixer.crossfader", 0);
    a.bus.send("deck1.seek", 0.25);
  })()`);
  await sleep(500);
  const box = await js<{ x: number; y: number; w: number; secPerPx: number } | null>(`(() => {
    const c = document.querySelectorAll("canvas.scroll-wave")[0];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const zoom = JSON.parse(localStorage.getItem("dbdj.ui.layout.v1") || "{}").zoomSeconds ?? 10; // layout.ts default
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), secPerPx: zoom / r.width };
  })()`);
  if (!box) return { error: "scrolling waveform not found" };
  const pos = () => js<number>("window.dbdj.engine.getPosition(0)");
  const state = () => js<{ playing: boolean; scratching: boolean }>("(({ playing, scratching }) => ({ playing, scratching }))(window.dbdj.engine.getState().decks[0])");
  const level = async (ms: number) => {
    let peak = 0;
    for (let t = 0; t < ms; t += 50) {
      peak = Math.max(peak, await js<number>("window.dbdj.audio.getLevels().channels[0]"));
      await sleep(50);
    }
    return +peak.toFixed(3);
  };
  const speed = async (ms: number) => {
    const p0 = await pos();
    await sleep(ms);
    return +(((await pos()) - p0) / (ms / 1000)).toFixed(2);
  };
  const { x, y } = box;
  let cx = x;
  const down = () => wc.sendInputEvent({ type: "mouseDown", x: cx, y, button: "left", clickCount: 1 });
  const up = () => wc.sendInputEvent({ type: "mouseUp", x: cx, y, button: "left", clickCount: 1 });
  const move = async (dx: number, ms: number) => {
    const steps = Math.max(1, Math.round(ms / 16));
    const from = cx;
    for (let i = 1; i <= steps; i++) {
      cx = Math.round(from + (dx * i) / steps);
      wc.sendInputEvent({ type: "mouseMove", x: cx, y, button: "left", modifiers: ["leftbuttondown"] });
      await sleep(16);
    }
  };
  const step = async (label: string, run: () => Promise<void>) => {
    const before = await pos();
    await run();
    await sleep(250); // let the platter catch up with the hand
    out[label] = { moved: +((await pos()) - before).toFixed(3), ...(await state()) };
  };

  const out: Record<string, unknown> = { secPerPx: +box.secPerPx.toFixed(4) };
  await js(`window.dbdj.bus.send("deck1.play")`);
  await sleep(600);
  out.playingSpeed = await speed(800);
  down();
  await sleep(50);
  out.holdStill = { speed: await speed(600), peak: await level(400), ...(await state()) };
  // 150 px right = pull the record back; expected move ≈ -150 × secPerPx.
  await step("dragBack150px", () => move(150, 300));
  out.dragBack150px = { ...(out.dragBack150px as object), expected: +(-150 * box.secPerPx).toFixed(3) };
  await step("dragForward300px", () => move(-300, 400));
  out.dragForward300px = { ...(out.dragForward300px as object), expected: +(300 * box.secPerPx).toFixed(3) };
  const peakWhileDragging = await (async () => { const p = level(500); await move(80, 250); await move(-80, 250); return p; })();
  out.peakWhileScratching = peakWhileDragging;
  up();
  await sleep(400);
  out.afterRelease = { speed: await speed(800), ...(await state()) };

  // Paused: a drag moves the record (audibly) and it stays paused afterwards.
  await js(`window.dbdj.bus.send("deck1.play")`);
  await sleep(300);
  down();
  await step("pausedDragForward200px", () => move(-200, 300));
  out.pausedDragForward200px = { ...(out.pausedDragForward200px as object), expected: +(200 * box.secPerPx).toFixed(3) };
  up();
  await sleep(300);
  out.pausedAfterRelease = { speed: await speed(600), ...(await state()) };
  await js(`window.dbdj.bus.send("mixer.channel1.volume", 0)`);
  return out;
}

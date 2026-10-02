/**
 * DBDJ_SMOKE_KNOBS=1: real OS-level mouse input (not synthetic DOM events) on
 * deck A's LOW knob — click, drag, Shift+drag, wheel, double-click — and the
 * resulting EQ value after each, so on-screen knob feel is verified in the app.
 */
import type { BrowserWindow } from "electron";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runKnobSmoke(win: BrowserWindow): Promise<unknown> {
  const wc = win.webContents;
  const js = <T>(code: string) => wc.executeJavaScript(code) as Promise<T>;
  const rect = await js<{ x: number; y: number } | null>(`(() => {
    const el = document.querySelector('.knob-dial[aria-label="LOW"]');
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!rect) return { error: "LOW knob not found" };
  const { x, y } = rect;
  const value = async () => +(await js<number>("window.dbdj.engine.getState().mixer.channels[0].eqLow")).toFixed(3);
  const set = async (v: number) => {
    await js(`window.dbdj.bus.send("mixer.channel1.eq.low", ${v})`);
    await sleep(80);
  };
  const drag = async (dy: number, shift = false) => {
    const modifiers: ("shift" | "leftbuttondown")[] = shift ? ["shift"] : [];
    // Moves must say the button is held, or Chromium treats them as hover and ends the capture.
    const held = [...modifiers, "leftbuttondown" as const];
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1, modifiers });
    const steps = Math.max(1, Math.abs(dy) / 5);
    for (let i = 1; i <= steps; i++) {
      wc.sendInputEvent({ type: "mouseMove", x, y: Math.round(y + (dy * i) / steps), button: "left", modifiers: held });
      await sleep(10);
    }
    wc.sendInputEvent({ type: "mouseUp", x, y: y + dy, button: "left", clickCount: 1, modifiers });
    await sleep(80);
  };
  const wheel = async (notches: number, shift = false) => {
    for (let i = 0; i < Math.abs(notches); i++) {
      // Electron: positive deltaY = wheel turned away from the user ("up").
      wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: 100 * Math.sign(notches), wheelTicksY: Math.sign(notches), canScroll: true, modifiers: shift ? ["shift"] : [] });
      await sleep(40);
    }
    await sleep(80);
  };
  const scrollTops = () => js<number>("[...document.querySelectorAll('*')].reduce((s, e) => s + e.scrollTop, 0)");

  const out: Record<string, unknown> = { knobAt: rect };
  await set(0.2);
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await sleep(300); // past the double-click interval
  out.clickWithoutDrag = { from: 0.2, to: await value() };
  await drag(-40);
  out.drag40pxUp = { from: 0.2, to: await value(), expected: 0.4 };
  await drag(-50, true);
  out.shiftDrag50pxUp = { from: 0.4, to: await value(), expected: 0.45 };
  await drag(-16);
  out.dragIntoCentreDetent = { from: 0.45, to: await value(), expected: 0.5 };
  await set(0.3);
  const scrollBefore = await scrollTops();
  await wheel(2);
  out.wheelUp2Notches = { from: 0.3, to: await value(), expected: 0.35 };
  await wheel(-4);
  out.wheelDown4Notches = { from: 0.35, to: await value(), expected: 0.25 };
  await wheel(10, true);
  out.shiftWheelUp10Notches = { from: 0.25, to: await value(), expected: 0.3 };
  out.pageScrolledByWheel = (await scrollTops()) !== scrollBefore;
  await set(0.8);
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 2 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 2 });
  await sleep(150);
  out.doubleClickCentres = { from: 0.8, to: await value(), expected: 0.5 };
  await set(0.5);
  return out;
}

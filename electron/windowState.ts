/**
 * Main window size: on first launch it fills most of the screen (maximised on screens up to
 * ~1680×1050, where a smaller window would squash the decks); afterwards it reopens at the
 * size, position and maximised state it was left in — if that's still on a connected screen.
 */
import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Saved {
  bounds: Rectangle;
  maximized: boolean;
}

const file = () => path.join(app.getPath("userData"), "window-state.json");

/** Below this work area the app opens maximised. */
const MAXIMISE_BELOW = { width: 1680, height: 1050 };

function load(): Saved | null {
  try {
    const s = JSON.parse(readFileSync(file(), "utf8")) as Saved;
    const b = s?.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    // Still (mostly) on a connected screen? A monitor may have been unplugged.
    const visible = screen.getAllDisplays().some((d) => {
      const w = Math.min(b.x + b.width, d.workArea.x + d.workArea.width) - Math.max(b.x, d.workArea.x);
      const h = Math.min(b.y + b.height, d.workArea.y + d.workArea.height) - Math.max(b.y, d.workArea.y);
      return w >= 300 && h >= 200;
    });
    return visible ? { bounds: b, maximized: !!s.maximized } : null;
  } catch {
    return null;
  }
}

/** Where the main window should open. */
export function initialWindowState(): { bounds: Rectangle; maximized: boolean } {
  const saved = load();
  if (saved) return saved;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const small = wa.width <= MAXIMISE_BELOW.width || wa.height <= MAXIMISE_BELOW.height;
  // Size used when not maximised: 90% of the screen on large displays, 1440×900 (fitted) on small ones.
  const width = Math.round(Math.min(wa.width, small ? 1440 : Math.min(2400, wa.width * 0.9)));
  const height = Math.round(Math.min(wa.height, small ? 900 : Math.min(1500, wa.height * 0.9)));
  return { bounds: { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height }, maximized: small };
}

/** Remember the window's size, position and maximised state for next time. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      writeFileSync(file(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() } satisfies Saved));
    } catch {
      /* not critical */
    }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"] as const) win.on(ev as "resize", later);
  win.on("close", save);
}

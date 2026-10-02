/**
 * Mouse / wheel / keyboard response of on-screen knobs (Knob in Mixer.tsx).
 *
 * Knobs move by relative drag, not by where you click. Bipolar knobs (EQ,
 * filter…) have a centre detent: a short stretch of travel that holds at 0.5,
 * so centring them by hand is easy. "Raw" is the knob position including that
 * stretch; the value is raw with the detent removed.
 */

/** Pixels of drag for the full 0..1 range. */
export const DRAG_PX_FULL_RANGE = 200;
/** Shift / Ctrl / Alt: this much finer. */
export const FINE_FACTOR = 0.2;
/** One wheel notch (≈100 px of deltaY in Chromium). */
export const WHEEL_STEP = 0.025;
export const KEY_STEP = 0.01;
/** Half-width of the centre detent, in raw units (≈6 px of drag each side). */
export const DETENT = 0.03;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function valueToRaw(value: number, bipolar: boolean): number {
  const v = clamp01(value);
  if (!bipolar) return v;
  if (Math.abs(v - 0.5) < 1e-6) return 0.5 + DETENT;
  return v < 0.5 ? v : v + 2 * DETENT;
}

export function rawToValue(raw: number, bipolar: boolean): number {
  if (!bipolar) return clamp01(raw);
  const r = Math.min(1 + 2 * DETENT, Math.max(0, raw));
  if (r <= 0.5) return r;
  if (r < 0.5 + 2 * DETENT) return 0.5;
  return r - 2 * DETENT;
}

export const clampRaw = (raw: number, bipolar: boolean) => Math.min(bipolar ? 1 + 2 * DETENT : 1, Math.max(0, raw));

/** Change in value for a pointer move: up or right turns the knob up. */
export function dragDelta(dx: number, dy: number, fine: boolean): number {
  return ((dx - dy) / DRAG_PX_FULL_RANGE) * (fine ? FINE_FACTOR : 1);
}

/**
 * Change in value for a wheel event. Mouse wheels send ~100 px per notch,
 * trackpads many small deltas; both scale by distance. Shift+wheel arrives
 * as deltaX in Chromium, so either axis counts.
 */
export function wheelDelta(e: { deltaX: number; deltaY: number; deltaMode: number }, fine: boolean): number {
  const px = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1; // lines / pages → pixels
  const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * px;
  return (-d / 100) * WHEEL_STEP * (fine ? FINE_FACTOR : 1);
}

/** Wheel and key steps stop at the centre of a bipolar knob instead of skipping past it. */
export function stepValue(value: number, delta: number, bipolar: boolean): number {
  const next = clamp01(value + delta);
  if (bipolar && value !== 0.5 && (value - 0.5) * (next - 0.5) < 0) return 0.5;
  return next;
}

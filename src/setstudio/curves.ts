/**
 * Energy curves: templates as normalised control points (x = 0..1 of set time, y = 0..1 of the
 * energy range), monotone cubic interpolation (no overshoot between points), anchor-generated curves,
 * per-slot targets from real cumulative durations, and the track-count estimate.
 */
import type { CurvePoint, CurveTemplateId, DJSet } from "./types";

export interface CurveTemplate { id: CurveTemplateId; name: string; description: string; points: CurvePoint[] }

const p = (...xy: number[]): CurvePoint[] => { const out: CurvePoint[] = []; for (let i = 0; i < xy.length; i += 2) out.push({ x: xy[i], y: xy[i + 1] }); return out; };

export const CURVE_TEMPLATES: CurveTemplate[] = [
  { id: "slow-burn", name: "Slow Burn", description: "Build steadily, dip mid-set for tension, then a triumphant final peak.", points: p(0, 0.12, 0.22, 0.3, 0.42, 0.48, 0.55, 0.36, 0.7, 0.62, 0.86, 0.9, 0.94, 1, 1, 0.82) },
  { id: "peak-valley", name: "Peak & Valley", description: "Quick rise, deliberate release, rebuild higher each cycle.", points: p(0, 0.2, 0.12, 0.66, 0.2, 0.78, 0.3, 0.42, 0.45, 0.84, 0.56, 0.52, 0.72, 0.92, 0.82, 0.62, 0.93, 1, 1, 0.86) },
  { id: "man-in-hole", name: "Man in Hole", description: "Start comfortable, sink deep and hypnotic, then climb out with force.", points: p(0, 0.56, 0.16, 0.5, 0.34, 0.26, 0.5, 0.16, 0.66, 0.42, 0.86, 0.94, 1, 0.84) },
  { id: "opener", name: "The Opener", description: "Start near-zero and build the entire time. Setting the table.", points: p(0, 0.02, 0.3, 0.3, 0.62, 0.62, 1, 0.95) },
  { id: "closer", name: "The Closer", description: "Start high, sustain with variation, then go supernova.", points: p(0, 0.7, 0.2, 0.76, 0.4, 0.72, 0.6, 0.8, 0.8, 0.84, 0.95, 1, 1, 0.94) },
  { id: "freehand", name: "Freehand", description: "Draw your own shape. Drag points; double-click to add one.", points: p(0, 0.5, 0.5, 0.5, 1, 0.5) },
];

export function templatePoints(id: CurveTemplateId): CurvePoint[] {
  return (CURVE_TEMPLATES.find((t) => t.id === id) ?? CURVE_TEMPLATES[CURVE_TEMPLATES.length - 1]).points.map((q) => ({ ...q }));
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Sorted, de-duplicated, clamped, always spanning x = 0..1. */
export function normalisePoints(points: CurvePoint[]): CurvePoint[] {
  const sorted = points.map((q) => ({ x: clamp01(q.x), y: clamp01(q.y) })).sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const q of sorted) { if (out.length && Math.abs(out[out.length - 1].x - q.x) < 1e-4) out[out.length - 1] = q; else out.push(q); }
  if (!out.length) return [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
  if (out[0].x > 0) out.unshift({ x: 0, y: out[0].y });
  if (out[out.length - 1].x < 1) out.push({ x: 1, y: out[out.length - 1].y });
  return out;
}

/** Fritsch–Carlson monotone cubic: value at x (0..1). */
export function curveAt(points: CurvePoint[], x: number): number {
  const pts = normalisePoints(points), n = pts.length;
  if (n === 1) return pts[0].y;
  const t = clamp01(x);
  let i = 0; while (i < n - 2 && t > pts[i + 1].x) i++;
  const d: number[] = [], m: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((pts[k + 1].y - pts[k].y) / Math.max(1e-9, pts[k + 1].x - pts[k].x));
  m.push(d[0]);
  for (let k = 1; k < n - 1; k++) m.push(d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2);
  m.push(d[n - 2]);
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[k] = tau * a * d[k]; m[k + 1] = tau * b * d[k]; }
  }
  const x0 = pts[i].x, x1 = pts[i + 1].x, h = Math.max(1e-9, x1 - x0), u = clamp01((t - x0) / h);
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return clamp01(h00 * pts[i].y + h10 * h * m[i] + h01 * pts[i + 1].y + h11 * h * m[i + 1]);
}

export const toEnergy = (y: number, min: number, max: number) => Math.round((min + (max - min) * clamp01(y)) * 10) / 10;
export const fromEnergy = (e: number, min: number, max: number) => (max > min ? clamp01((e - min) / (max - min)) : 0.5);

/** Curve through the anchors' energies at their positions (Anchor Points mode). */
export function curveFromAnchors(anchors: { x: number; energy: number }[], min: number, max: number): CurvePoint[] {
  if (!anchors.length) return templatePoints("freehand");
  return normalisePoints(anchors.map((a) => ({ x: a.x, y: fromEnergy(a.energy, min, max) })));
}

/** Curve that follows actual track energies (Improve a Set's starting target). */
export function curveFromEnergies(energies: (number | null)[], min: number, max: number): CurvePoint[] {
  const known = energies.map((e, i) => ({ e, i })).filter((q): q is { e: number; i: number } => q.e !== null);
  if (!known.length) return templatePoints("freehand");
  const n = Math.max(1, energies.length);
  return normalisePoints(known.map(({ e, i }) => ({ x: n === 1 ? 0.5 : (i + 0.5) / n, y: fromEnergy(e, min, max) })));
}

/** Seconds of a track that are heard on their own in a set (duration minus the transition overlap). */
export function playedSeconds(durationSec: number | null, overlapSec: number, fallbackSec: number): number {
  const d = durationSec && durationSec > 0 ? durationSec : fallbackSec;
  return Math.max(30, d - overlapSec);
}

/**
 * Track-count estimate from the library's real durations (clamped to 1.5–12 min to ignore stingers and
 * full mixes) minus the overlap. Durations differ per track, so the mean played length is used.
 */
export function estimateTrackCount(durationSec: number, durations: (number | null | undefined)[], overlapSec: number): { count: number; avgPlayedSec: number; basis: number } {
  const known = durations.filter((d): d is number => !!d && d > 0).map((d) => Math.min(720, Math.max(90, d)));
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 360;
  const played = Math.max(45, avg - overlapSec);
  return { count: Math.max(1, Math.round(durationSec / played)), avgPlayedSec: Math.round(played), basis: known.length };
}

/** Slot start/mid times (s) from actual durations where known, the expected played length otherwise. */
export function slotTimeline(durations: (number | null)[], overlapSec: number, fallbackSec: number): { start: number; mid: number; end: number }[] {
  let t = 0;
  return durations.map((d) => { const len = playedSeconds(d, overlapSec, fallbackSec); const r = { start: t, mid: t + len / 2, end: t + len }; t += len; return r; });
}

/** Target energy for every slot: the curve sampled at the slot's mid-time over the planned duration. */
export function slotTargets(set: Pick<DJSet, "curveControlPoints" | "energyMin" | "energyMax" | "durationTargetSec" | "overlapSec">, durations: (number | null)[], fallbackSec: number): number[] {
  const tl = slotTimeline(durations, set.overlapSec, fallbackSec);
  const span = Math.max(set.durationTargetSec, tl.length ? tl[tl.length - 1].end : 0, 1);
  return tl.map((s) => toEnergy(curveAt(set.curveControlPoints, s.mid / span), set.energyMin, set.energyMax));
}

/** SVG path for a curve in a w×h box (y up = more energy). */
export function curvePath(points: CurvePoint[], w: number, h: number, samples = 96, pad = 0): string {
  let d = "";
  for (let i = 0; i <= samples; i++) { const x = i / samples, y = curveAt(points, x); d += `${i ? "L" : "M"}${(pad + x * (w - 2 * pad)).toFixed(1)},${(pad + (1 - y) * (h - 2 * pad)).toFixed(1)}`; }
  return d;
}

/** The app's energy gradient: cool cyan/blue → purple → magenta → orange/yellow. */
export const ENERGY_STOPS = [["0%", "#38c8ff"], ["35%", "#8b6cff"], ["62%", "#ff4fb8"], ["85%", "#ff8a3d"], ["100%", "#ffd23f"]] as const;
export function energyColour(e: number | null): string {
  if (e === null) return "#5b6475";
  const t = clamp01((e - 1) / 9), stops = [[0, [56, 200, 255]], [0.35, [139, 108, 255]], [0.62, [255, 79, 184]], [0.85, [255, 138, 61]], [1, [255, 210, 63]]] as const;
  let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [a, ca] = stops[i], [b, cb] = stops[i + 1], u = (t - a) / (b - a);
  return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * u)).join(",")})`;
}

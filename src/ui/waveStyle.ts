/**
 * Waveform display styles (Mixxx-style), shared by the scrolling and overview
 * waveforms so every view of a track looks the same at any zoom.
 *
 *  - simple:   overall amplitude in one colour; stereo tracks show L above / R below the centre
 *  - filtered: red lows, green mids, blue highs as stacked bands
 *  - rgb:      one waveform whose colour mixes low (R), mid (G) and high (B) energy
 *  - rgbLR:    RGB colouring with the left channel above and the right below the centre
 *  - hsv:      hue follows the spectral balance; highs desaturate, strong lows darken
 *
 * Data comes from the track analysis (per-channel display bands at ~250 Hz /
 * 4 kHz). Tracks analysed before these styles fall back to the mono bands
 * until the background upgrade adds the stereo data.
 */
import type { TrackAnalysis } from "../analysis/analyzeTrack";

export type WaveStyle = "simple" | "filtered" | "rgb" | "rgbLR" | "hsv";

export const WAVE_STYLES: { id: WaveStyle; label: string; title: string }[] = [
  { id: "simple", label: "Simple", title: "Overall amplitude in one colour (stereo: left above, right below)" },
  { id: "filtered", label: "Filtered", title: "Red = lows (kick, bass) · Green = mids (vocals, synths) · Blue = highs (hats, cymbals)" },
  { id: "rgb", label: "RGB", title: "Low/mid/high energy blended into one colour: red kicks, green vocals, blue hats, mixes in between" },
  { id: "rgbLR", label: "RGB L/R", title: "RGB colouring with the left channel above and the right channel below the centre" },
  { id: "hsv", label: "HSV", title: "Hue = spectral balance, less saturated for highs, darker for strong lows" },
];

export const DEFAULT_WAVE_STYLE: WaveStyle = "rgb";

const SIMPLE = "#4fa3ff";
const F_LOW = "#ff3b30";
const F_MID = "#30d158";
const F_HIGH = "#2f7bff";

type Chan = { all: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array };

export interface WaveData {
  fps: number;
  n: number;
  L: Chan;
  R: Chan;
  stereo: boolean;
  /** 99.5th-percentile full-band peak and band peak (robust normalisation). */
  normAll: number;
  normBand: number;
}

const cache = new WeakMap<TrackAnalysis, WaveData>();

/** Display data for an analysis (memoised per analysis object). */
export function waveData(ov: TrackAnalysis): WaveData {
  let d = cache.get(ov);
  if (d) return d;
  const b = ov.bands;
  let L: Chan;
  let R: Chan;
  let stereo = false;
  if (b) {
    L = { all: b.allL, low: b.lowL, mid: b.midL, high: b.highL };
    R = { all: b.allR, low: b.lowR, mid: b.midR, high: b.highR };
    stereo = b.stereo;
  } else {
    // Older cache: mono bands only; approximate the full-band peak from them.
    const n = ov.low.length;
    const all = new Float32Array(n);
    for (let i = 0; i < n; i++) all[i] = Math.max(ov.low[i], ov.mid[i], ov.high[i]) * 1.15;
    L = R = { all, low: ov.low, mid: ov.mid, high: ov.high };
  }
  const n = L.all.length;
  d = { fps: ov.fps, n, L, R, stereo, normAll: percentile(n, (i) => Math.max(L.all[i], R.all[i])), normBand: percentile(n, (i) => Math.max(L.low[i], L.mid[i], L.high[i], R.low[i], R.mid[i], R.high[i])) };
  cache.set(ov, d);
  return d;
}

function percentile(n: number, at: (i: number) => number): number {
  const s: number[] = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) s.push(at(i));
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.995)] || 1;
}

/** Peak values of one column (frames i0..i1) per channel: [all, low, mid, high]. */
export interface Column {
  L: [number, number, number, number];
  R: [number, number, number, number];
}

export function column(d: WaveData, i0: number, i1: number, out: Column): Column {
  const a = out.L;
  const b = out.R;
  a[0] = a[1] = a[2] = a[3] = b[0] = b[1] = b[2] = b[3] = 0;
  if (i0 < 0) i0 = 0;
  if (i1 > d.n) i1 = d.n;
  for (let i = i0; i < i1; i++) {
    if (d.L.all[i] > a[0]) a[0] = d.L.all[i];
    if (d.L.low[i] > a[1]) a[1] = d.L.low[i];
    if (d.L.mid[i] > a[2]) a[2] = d.L.mid[i];
    if (d.L.high[i] > a[3]) a[3] = d.L.high[i];
    if (d.R.all[i] > b[0]) b[0] = d.R.all[i];
    if (d.R.low[i] > b[1]) b[1] = d.R.low[i];
    if (d.R.mid[i] > b[2]) b[2] = d.R.mid[i];
    if (d.R.high[i] > b[3]) b[3] = d.R.high[i];
  }
  return out;
}

export function newColumn(): Column {
  return { L: [0, 0, 0, 0], R: [0, 0, 0, 0] };
}

/** Mixed colour for low/mid/high energy (RGB style): normalised so the strongest band is full brightness. */
export function rgbColor(lo: number, md: number, hi: number): string {
  const m = Math.max(lo, md, hi);
  if (m <= 0) return "rgb(40,40,40)";
  // A little gamma keeps secondary bands visible (orange, purple, yellow where bands overlap).
  const c = (v: number) => Math.round(255 * Math.pow(v / m, 0.8));
  return `rgb(${c(lo)},${c(md)},${c(hi)})`;
}

/** HSV style: hue from the spectral balance, saturation drops with highs, value drops with strong lows. */
export function hsvColor(lo: number, md: number, hi: number): string {
  const t = lo + md + hi;
  if (t <= 0) return "rgb(40,40,40)";
  const lr = lo / t;
  const mr = md / t;
  const hr = hi / t;
  const hue = (mr * 0.5 + hr) * 270; // 0° red (lows) → 135° green (mids) → 270° violet (highs)
  const sat = 1 - 0.8 * hr;
  const val = 1 - 0.5 * lr;
  return hsvToRgb(hue, sat, val);
}

function hsvToRgb(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
}

/** Filtered-style stacked band heights (low outermost, highs innermost). */
function bandHeights(lo: number, md: number, hi: number, scale: number, half: number): [number, number, number] {
  return [Math.min(half * 0.96, (lo + md * 0.35) * scale), Math.min(half * 0.9, md * scale * 0.78), Math.min(half * 0.76, hi * scale * 0.58)];
}

/**
 * Draw one 1-px column at \`pos\` along the time axis. \`center\` is the centre line and
 * \`half\` the available half-height (both in px on the amplitude axis).
 */
export function drawColumn(g: CanvasRenderingContext2D, style: WaveStyle, col: Column, d: WaveData, pos: number, center: number, half: number, vertical: boolean): void {
  const bar = (from: number, len: number, color: string) => {
    if (len <= 0) return;
    g.fillStyle = color;
    if (vertical) g.fillRect(from, pos, len, 1);
    else g.fillRect(pos, from, 1, len);
  };
  const L = col.L;
  const R = col.R;
  const split = style === "rgbLR" || (style === "simple" && d.stereo);
  const allScale = (half * 0.94) / d.normAll;
  switch (style) {
    case "filtered": {
      // Mono view (max of L/R), like Mixxx's filtered renderer.
      const [hl, hm, hh] = bandHeights(Math.max(L[1], R[1]), Math.max(L[2], R[2]), Math.max(L[3], R[3]), (half * 0.94) / d.normBand, half);
      bar(center - hl, hl * 2, F_LOW);
      bar(center - hm, hm * 2, F_MID);
      bar(center - hh, hh * 2, F_HIGH);
      return;
    }
    case "simple":
      if (split) {
        const up = Math.min(half, L[0] * allScale);
        const dn = Math.min(half, R[0] * allScale);
        bar(center - up, up, SIMPLE);
        bar(center, dn, SIMPLE);
      } else {
        const h = Math.min(half, Math.max(L[0], R[0]) * allScale);
        bar(center - h, h * 2, SIMPLE);
      }
      return;
    case "rgbLR": {
      const up = Math.min(half, L[0] * allScale);
      const dn = Math.min(half, R[0] * allScale);
      bar(center - up, up, rgbColor(L[1], L[2], L[3]));
      bar(center, dn, rgbColor(R[1], R[2], R[3]));
      return;
    }
    case "rgb":
    case "hsv": {
      const lo = Math.max(L[1], R[1]);
      const md = Math.max(L[2], R[2]);
      const hi = Math.max(L[3], R[3]);
      const h = Math.min(half, Math.max(L[0], R[0]) * allScale);
      bar(center - h, h * 2, style === "rgb" ? rgbColor(lo, md, hi) : hsvColor(lo, md, hi));
      return;
    }
  }
}

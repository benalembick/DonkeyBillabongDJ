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
import type { EngineState } from "../core/engine/DJEngine";
import { eqVisualGain } from "../core/engine/mixerMath";

export type WaveStyle = "simple" | "filtered" | "rgb" | "rgbLR" | "hsv";

export const WAVE_STYLES: { id: WaveStyle; label: string; title: string }[] = [
  { id: "simple", label: "Simple", title: "Overall amplitude in one colour (stereo: left above, right below)" },
  { id: "filtered", label: "Filtered", title: "Red = lows (kick, bass) · Green = mids (vocals, synths) · Blue = highs (hats, cymbals)" },
  { id: "rgb", label: "RGB", title: "Low/mid/high energy blended into one colour: red kicks, green vocals, blue hats, mixes in between" },
  { id: "rgbLR", label: "RGB L/R", title: "RGB colouring with the left channel above and the right channel below the centre" },
  { id: "hsv", label: "HSV", title: "Hue = spectral balance, less saturated for highs, darker for strong lows" },
];

export const DEFAULT_WAVE_STYLE: WaveStyle = "rgb";

const SIMPLE = 0x4fa3ff;
const F_LOW = 0xff3b30;
const F_MID = 0x30d158;
const F_HIGH = 0x2f7bff;

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

/** Packed colour 0xRRGGBB → CSS. */
export const css = (c: number) => `rgb(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255})`;
const pack = (r: number, g: number, b: number) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
const DIM = 0x282828;

/** Mixed colour for low/mid/high energy (RGB style), packed: the strongest band is full brightness. */
export function rgbPacked(lo: number, md: number, hi: number): number {
  const m = Math.max(lo, md, hi);
  if (m <= 0) return DIM;
  // A little gamma keeps secondary bands visible (orange, purple, yellow where bands overlap).
  return pack(255 * Math.pow(lo / m, 0.8), 255 * Math.pow(md / m, 0.8), 255 * Math.pow(hi / m, 0.8));
}
export const rgbColor = (lo: number, md: number, hi: number) => css(rgbPacked(lo, md, hi));

/** HSV style, packed: hue from the spectral balance, saturation drops with highs, value drops with strong lows. */
export function hsvPacked(lo: number, md: number, hi: number): number {
  const t = lo + md + hi;
  if (t <= 0) return DIM;
  const lr = lo / t;
  const mr = md / t;
  const hr = hi / t;
  const hue = (mr * 0.5 + hr) * 270; // 0° red (lows) → 135° green (mids) → 270° violet (highs)
  const sat = 1 - 0.8 * hr;
  const val = 1 - 0.5 * lr;
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return pack((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
export const hsvColor = (lo: number, md: number, hi: number) => css(hsvPacked(lo, md, hi));

/** Filtered-style stacked band heights (low outermost, highs innermost). */
function bandHeights(lo: number, md: number, hi: number, scale: number, half: number): [number, number, number] {
  // Each layer is its band alone, so an EQ kill removes exactly that colour.
  return [Math.min(half * 0.96, lo * scale), Math.min(half * 0.9, md * scale * 0.78), Math.min(half * 0.76, hi * scale * 0.58)];
}

/** Display gains [low, mid, high] from a deck's EQ (1 = neutral, 0 = killed). */
export type EqGains = readonly [number, number, number];
export const NEUTRAL_EQ: EqGains = [1, 1, 1];

/** A deck's EQ as display gains, read from the engine's mixer state — the same state the UI knobs,
 * keyboard, MIDI mappings and the DDJ-SB hardware knobs all write to. */
export function deckEq(s: Pick<EngineState, "mixer">, deck: number): EqGains {
  const c = s.mixer.channels[deck];
  if (!c) return NEUTRAL_EQ;
  return [eqVisualGain(c.eqLow, c.killLow), eqVisualGain(c.eqMid, c.killMid), eqVisualGain(c.eqHigh, c.killHigh)];
}

/**
 * Smooths a deck's EQ gains for display (fast one-pole, ~35 ms) and quantises them so
 * cached waveform tiles are only redrawn when the picture actually changes.
 */
export class EqSmoother {
  private v = [1, 1, 1];
  private last = 0;
  /** Returns the gains to draw with this frame, and a key that changes only when they do. */
  step(target: EqGains, now: number): { gains: EqGains; key: string } {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1;
    this.last = now;
    const a = 1 - Math.exp(-dt / 0.035);
    for (let k = 0; k < 3; k++) {
      this.v[k] += (target[k] - this.v[k]) * a;
      if (Math.abs(target[k] - this.v[k]) < 0.004) this.v[k] = target[k];
    }
    // ~3 % steps: visually continuous, but tiles are only redrawn when the picture really changes.
    const q = this.v.map((x) => Math.round(x * 32) / 32) as unknown as EqGains;
    return { gains: q, key: q.join(",") };
  }
}

/** Post-EQ band values for one channel, and how much the overall peak shrinks or grows with them. */
function applyEq(ch: readonly number[], eq: EqGains, out: number[]): number {
  const lo = ch[1] * eq[0];
  const md = ch[2] * eq[1];
  const hi = ch[3] * eq[2];
  out[0] = lo;
  out[1] = md;
  out[2] = hi;
  const pre = ch[1] * ch[1] + ch[2] * ch[2] + ch[3] * ch[3];
  if (pre <= 0) return 1;
  return Math.min(1.25, Math.sqrt((lo * lo + md * md + hi * hi) / pre));
}
// Scratch buffers (drawColumn runs for every pixel column; no per-column allocation).
const eqL = [0, 0, 0];
const eqR = [0, 0, 0];
const postL = [0, 0, 0, 0];
const postR = [0, 0, 0, 0];

/** Receives the bars of each column (packed 0xRRGGBB colour). */
export interface BarSink {
  bar(pos: number, from: number, len: number, rgb: number, vertical: boolean): void;
}

/**
 * Writes bars straight into an ImageData buffer: one typed-array fill per bar, one
 * putImageData per tile. Far cheaper than per-column fillStyle/fillRect, which matters
 * when EQ moves force tiles to be redrawn every frame.
 */
export class PixelSink implements BarSink {
  readonly img: ImageData;
  private readonly px: Uint32Array;
  private readonly w: number;
  private readonly h: number;
  constructor(w: number, h: number) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.img = new ImageData(this.w, this.h);
    this.px = new Uint32Array(this.img.data.buffer);
  }
  /** Reset to transparent before redrawing into the same buffer. */
  clear(): void {
    this.px.fill(0);
  }
  bar(pos: number, from: number, len: number, rgb: number, vertical: boolean): void {
    if (len <= 0) return;
    const extent = vertical ? this.w : this.h;
    const a = Math.max(0, Math.round(from));
    const b = Math.min(extent, Math.max(a + 1, Math.round(from + len)));
    if (b <= a) return;
    // ImageData is RGBA in memory → little-endian 0xAABBGGRR.
    const c = (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
    if (vertical) {
      const row = (pos | 0) * this.w;
      this.px.fill(c, row + a, row + b);
    } else {
      const x = pos | 0;
      for (let y = a; y < b; y++) this.px[y * this.w + x] = c;
    }
  }
}

/**
 * Draw one 1-px column at `pos` along the time axis. `center` is the centre line and
 * `half` the available half-height (both in px on the amplitude axis). `eq` = the deck's
 * current EQ as display gains: the analysed data is never changed, only what is drawn.
 */
export function drawColumn(sink: BarSink, style: WaveStyle, col: Column, d: WaveData, pos: number, center: number, half: number, vertical: boolean, eq: EqGains = NEUTRAL_EQ): void {
  const bar = (from: number, len: number, rgb: number) => sink.bar(pos, from, len, rgb, vertical);
  // What the deck's EQ lets through: bands scaled by their EQ gain, overall peak by the change in band energy.
  const fL = applyEq(col.L, eq, eqL);
  const fR = applyEq(col.R, eq, eqR);
  const L = postL;
  const R = postR;
  L[0] = col.L[0] * fL;
  L[1] = eqL[0];
  L[2] = eqL[1];
  L[3] = eqL[2];
  R[0] = col.R[0] * fR;
  R[1] = eqR[0];
  R[2] = eqR[1];
  R[3] = eqR[2];
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
      bar(center - up, up, rgbPacked(L[1], L[2], L[3]));
      bar(center, dn, rgbPacked(R[1], R[2], R[3]));
      return;
    }
    case "rgb":
    case "hsv": {
      const lo = Math.max(L[1], R[1]);
      const md = Math.max(L[2], R[2]);
      const hi = Math.max(L[3], R[3]);
      const h = Math.min(half, Math.max(L[0], R[0]) * allScale);
      bar(center - h, h * 2, style === "rgb" ? rgbPacked(lo, md, hi) : hsvPacked(lo, md, hi));
      return;
    }
  }
}

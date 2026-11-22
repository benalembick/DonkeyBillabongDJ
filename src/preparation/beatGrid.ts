/**
 * Beat grids: the one place that says what a trustworthy grid is, plus the pure maths behind every
 * grid edit (the deck's Beat grid editor, Transition Guides' nudges, waveform dragging).
 *
 * A grid is a BPM and a first downbeat (`firstBeat`, bar 1); every 4th beat from it is a bar line.
 * Edits keep the downbeat inside the first bar of the track ([0, bar)) — the same convention the
 * analyser and the waveform already use.
 */

/** Analysis confidence (comb peak / mean) from which a detected grid is trusted. */
export const GRID_CONFIDENT = 1.4;
/** Phrases are counted in 8-bar (32-beat) blocks across the app. */
export const PHRASE_BARS = 8;

export interface GridLike { bpm: number; firstBeat: number; confidence: number; manual?: boolean; manuallyAdjusted?: boolean }
export type GridStatus = "none" | "manual" | "analysed" | "unreliable";

export const isManualGrid = (g: Pick<GridLike, "manual" | "manuallyAdjusted"> | null | undefined): boolean => !!(g && (g.manual || g.manuallyAdjusted));

/** A grid Auto DJ, Transition Lab, Auto Cue and DJ Training may beat-match on: set by hand, or confidently detected. */
export function gridReliable(g: GridLike | null | undefined): boolean {
  return !!g && g.bpm > 0 && (isManualGrid(g) || g.confidence >= GRID_CONFIDENT);
}

export function gridStatus(g: GridLike | null | undefined): GridStatus {
  if (!g || !(g.bpm > 0)) return "none";
  if (isManualGrid(g)) return "manual";
  return g.confidence >= GRID_CONFIDENT ? "analysed" : "unreliable";
}

export interface GridPoint { bpm: number; firstBeat: number }

export const beatSeconds = (bpm: number) => 60 / bpm;
export const barSeconds = (bpm: number) => 240 / bpm;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Typed/tapped BPMs outside this range are refused (the analyser searches 60–190; ×2 of a slow track can go higher). */
export const MIN_BPM = 40, MAX_BPM = 300;
export const validBpm = (bpm: number) => Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM;

/** Same grid, with the downbeat moved into the first bar ([0, bar)). */
export function normaliseGrid(g: GridPoint): GridPoint {
  const bpm = round3(g.bpm), bar = barSeconds(bpm);
  let first = g.firstBeat % bar;
  if (first < 0) first += bar;
  if (bar - first < 1e-6) first = 0;
  return { bpm, firstBeat: Math.round(first * 1e5) / 1e5 };
}

/** The bar line (downbeat) closest to `t`. */
export function downbeatNear(g: GridPoint, t: number): number {
  const bar = barSeconds(g.bpm);
  return g.firstBeat + Math.round((t - g.firstBeat) / bar) * bar;
}

/** The beat closest to `t`. */
export function beatNear(g: GridPoint, t: number): number {
  const beat = beatSeconds(g.bpm);
  return g.firstBeat + Math.round((t - g.firstBeat) / beat) * beat;
}

/**
 * New tempo, keeping `anchor` on a downbeat (default: the current first downbeat). Typed BPM, tap tempo
 * and ×2 / ÷2 anchor at the bar under the playhead so the part you're listening to stays lined up.
 */
export function withBpm(g: GridPoint, bpm: number, anchor = g.firstBeat): GridPoint {
  return normaliseGrid({ bpm, firstBeat: anchor });
}
export const doubled = (g: GridPoint, anchor?: number) => withBpm(g, g.bpm * 2, anchor);
export const halved = (g: GridPoint, anchor?: number) => withBpm(g, g.bpm / 2, anchor);

/** Make the beat at `t` the downbeat (bar 1). */
export const withDownbeat = (g: GridPoint, t: number): GridPoint => normaliseGrid({ bpm: g.bpm, firstBeat: t });

/** Slide the whole grid by `seconds` (waveform drag, ±10 ms). */
export const shifted = (g: GridPoint, seconds: number): GridPoint => normaliseGrid({ bpm: g.bpm, firstBeat: g.firstBeat + seconds });

/**
 * Fine nudges, as in Transition Guides: whole beats move which beat is the downbeat, milliseconds slide
 * the grid, ±BPM changes the tempo keeping the first downbeat where it is.
 */
export function nudged(g: GridPoint, by: { beats?: number; ms?: number; bpm?: number }): GridPoint {
  const bpm = g.bpm + (by.bpm ?? 0);
  return normaliseGrid({ bpm, firstBeat: g.firstBeat + (by.beats ?? 0) * beatSeconds(g.bpm) + (by.ms ?? 0) / 1000 });
}

/**
 * Tap tempo: BPM from tap times (ms, oldest first). Uses up to the last 16 taps. An accidental extra tap splits
 * one beat into two short gaps, so short gaps are merged back together; a missed tap (a double-length gap) is
 * ignored by keeping only gaps within 35 % of the median. Needs at least 3 good gaps.
 */
export function tapTempo(taps: readonly number[]): number | null {
  const recent = taps.slice(-16);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) { const d = recent[i] - recent[i - 1]; if (d > 0) gaps.push(d); }
  if (gaps.length < 3) return null;
  const sorted = [...gaps].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const merged: number[] = [];
  let carry = 0;
  for (const d of gaps) {
    const v = carry + d;
    if (v < median * 0.65) { carry = v; continue; }
    merged.push(v); carry = 0;
  }
  const good = merged.filter((d) => Math.abs(d - median) <= median * 0.35);
  if (good.length < 3) return null;
  const bpm = 60000 / (good.reduce((a, b) => a + b, 0) / good.length);
  return validBpm(bpm) ? Math.round(bpm * 100) / 100 : null;
}
/** Taps further apart than this start a new count. */
export const TAP_RESET_MS = 2000;

/**
 * Onset strength from the cached analysis bands (150 fps): rises in the low band (kicks) plus half the
 * mid band (snares/claps), on a log scale so quiet intros still register.
 */
export function onsetEnvelope(low: ArrayLike<number>, mid: ArrayLike<number>): Float32Array {
  const n = Math.min(low.length, mid.length), out = new Float32Array(n);
  let pl = 0, pm = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.log1p(low[i] * 100), m = Math.log1p(mid[i] * 100);
    out[i] = Math.max(0, l - pl) + 0.5 * Math.max(0, m - pm);
    pl = l; pm = m;
  }
  return out;
}

/** The strongest onset within ±`window` s of `t` (snap to the kick/snare), or `t` when there's none. */
export function snapToOnset(env: ArrayLike<number>, fps: number, t: number, window = 0.07): number {
  const a = Math.max(1, Math.floor((t - window) * fps)), b = Math.min(env.length - 1, Math.ceil((t + window) * fps));
  let best = -1, bestV = 0;
  for (let i = a; i <= b; i++) if (env[i] > bestV) { bestV = env[i]; best = i; }
  return best < 0 ? t : Math.round((best / fps) * 1e5) / 1e5;
}

/**
 * Keep the tempo, find where the beats really fall: the phase (within one beat) where onsets pile up across
 * the whole track, then the matching downbeat closest to the current one (so bar 1 doesn't jump to a
 * different beat of the bar). Returns null when the audio has no usable pulse.
 */
export function alignedToOnsets(g: GridPoint, env: ArrayLike<number>, fps: number): GridPoint | null {
  const P = (60 * fps) / g.bpm;
  if (!(P > 2) || env.length < P * 8) return null;
  const BINS = 64, hist = new Float64Array(BINS);
  let total = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i];
    if (v <= 0) continue;
    hist[Math.floor(((i % P) / P) * BINS) % BINS] += v;
    total += v;
  }
  if (total <= 0) return null;
  let bestBin = 0, best = -1;
  for (let k = 0; k < BINS; k++) {
    const s = hist[k] + 0.5 * (hist[(k + 1) % BINS] + hist[(k + BINS - 1) % BINS]);
    if (s > best) { best = s; bestBin = k; }
  }
  // Too flat → no clear beat to align to.
  if (best / (total / BINS) < 1.15) return null;
  const phase = (((bestBin + 0.5) / BINS) * P) / fps, beat = beatSeconds(g.bpm);
  return normaliseGrid({ bpm: g.bpm, firstBeat: phase + Math.round((g.firstBeat - phase) / beat) * beat });
}

/** Bars from the first downbeat to the phrase anchor, as an offset within an 8-bar phrase (0–7). */
export function phraseOffsetBars(g: GridPoint, anchor: number | null | undefined): number {
  if (anchor === null || anchor === undefined || !Number.isFinite(anchor)) return 0;
  const bars = Math.round((anchor - g.firstBeat) / barSeconds(g.bpm));
  return ((bars % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS;
}

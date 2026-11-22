/**
 * Whole-track beat-grid fitting: makes a detected grid accurate across the entire track and decides
 * whether Beat Mix can trust it.
 *
 * The first-pass detector (`detectBeats`) estimates BPM and phase from a 150 s slice and scores how
 * *peaked* that slice's beat histogram is. That isn't what Beat Mix needs. Busy hats, syncopation or an
 * off-beat bassline flatten the histogram on plenty of perfectly steady tracks, and a BPM that's a
 * fraction off drifts by tens of milliseconds by the outro, which is exactly where Auto DJ mixes out.
 *
 * This pass checks the grid against every 16-beat window of the whole track. In each window it folds
 * the onset envelope over one beat and finds the strongest peak within a quarter beat of where the grid
 * puts the beat. Then:
 *   1. a fine tempo scan (±0.4 %) finds the BPM at which the most of the track lines up, keeping the
 *      grid on the same rhythm stream it started on (tracks often have two, e.g. kick and percussion);
 *   2. a weighted line fit through the offsets removes any remaining drift;
 *   3. a whole-number BPM is preferred when it fits as well (most produced music sits on one);
 *   4. trust is decided from the evidence (`gridTrusted`): far more windows on the grid than chance
 *      would allow, and the grid confirmed in both the intro and the outro. Beatless breakdowns don't
 *      count for or against it.
 *
 * The result is reported on the existing confidence scale, where 1.4 or more means "trusted", so every
 * feature that checks `gridReliable` benefits without change.
 *
 * Input is the onset envelope from the cached analysis bands (`onsetEnvelope(low, mid)`), so a fresh
 * analysis and an upgrade of an old cached analysis give the same grid without decoding the audio again.
 */

/** Bump when the fit changes, so cached grids are re-fitted (see PreparationStore). */
export const GRID_FIT_VERSION = 1;

/** Beats per measurement window (4 bars). */
const WINDOW_BEATS = 16;
/** A window's beats land "on the grid" within this many seconds. */
export const ON_GRID_S = 0.025;
/** Windows needed before the evidence means anything (~45 s at 128 BPM). */
const MIN_WINDOWS = 6;
/** Peak-to-mean ratio of a window's folded beat for it to count as carrying a beat. */
const MIN_PROMINENCE = 1.6;
/** Standard deviations above chance for a grid to be trusted (see `gridTrusted`). */
const TRUST_Z = 4;
/** The tempo scan: ± this fraction of the first-pass BPM, in steps of SCAN_STEP BPM. */
const SCAN_RANGE = 0.004, SCAN_STEP = 0.02;
const BINS = 64;

export interface GridEvidence {
  /** Loudness share of beat windows on the grid (±25 ms). */
  stability: number;
  /** RMS offset (s) of the on-grid windows. */
  rms: number;
  /** On-grid share in the first / last 30 % of the track (1 when that part has no beat to judge). */
  intro: number;
  outro: number;
  /** How far the on-grid count is above chance, in standard deviations. */
  z: number;
  /**
   * How strong the beat the grid sits on is: on-grid share weighted by each window's peak prominence.
   * Compares phases and tempo families of the same track (the kick beats a 16th-note hat or the off-beat bass).
   */
  salience: number;
  /** Mean time (s) of the on-grid windows: where the grid is best confirmed (NaN when none are). */
  anchor: number;
  /** Loudness share of on-grid windows whose pattern points to a wrong tempo family (4:3, 2:3). */
  suspect: number;
}

export interface GridFit {
  bpm: number;
  firstBeat: number;
  /** On the analyser's confidence scale: ≥ 1.4 is trusted. */
  confidence: number;
  /** Beat-carrying windows measured. */
  windows: number;
  evidence: GridEvidence;
}

/** A window's centre time (s), how far its beat peak sits from the grid (s, + = later), its weight (onset energy) and the peak's prominence (peak / mean). */
interface Win { t: number; dev: number; weight: number; prom: number; suspect: boolean }

/**
 * Onset envelope for grid fitting, from the cached analysis bands (peaks per frame): rises in the combined
 * low + mid energy, log-compressed after combining. Combining first keeps the kick on top. Compressing
 * each band separately (as `onsetEnvelope` does for snapping) lifts quieter bass and percussion onsets
 * to the kick's level, and a rolling or off-beat bassline then competes with the beat.
 */
export function gridEnvelope(low: ArrayLike<number>, mid: ArrayLike<number>): Float32Array {
  const n = Math.min(low.length, mid.length), out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.log1p(100 * Math.sqrt(low[i] * low[i] + 0.35 * mid[i] * mid[i]));
    out[i] = v > prev ? v - prev : 0;
    prev = v;
  }
  return out;
}

/** Onset envelope minus its local mean (~0.25 s), so loud sections and sustained notes don't dominate. */
function sharpen(env: ArrayLike<number>, fps: number): Float32Array {
  const n = env.length, w = Math.max(3, Math.round(fps * 0.25)), out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    const v = env[i] - acc / Math.min(i + 1, w);
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

const hist = new Float64Array(BINS), sm = new Float64Array(BINS);
/**
 * For each 16-beat window: fold the envelope over one beat, centred on the grid's beat, and find the
 * strongest peak within ±¼ beat. Windows that are quiet or have no clear peak are left out.
 */
function measure(x: Float32Array, fps: number, bpm: number, first: number): Win[] {
  const P = (60 * fps) / bpm, len = Math.max(8, Math.round(P * WINDOW_BEATS)), n = x.length;
  const origin = first * fps - P / 2; // bin BINS/2 = the grid's beat
  const raw: Win[] = [];
  for (let s = 0; s + len / 2 <= n; s += len) {
    const e0 = Math.min(n, s + len);
    hist.fill(0);
    let energy = 0;
    for (let i = s; i < e0; i++) {
      const v = x[i];
      if (v <= 0) continue;
      let ph = ((i - origin) % P) / P;
      if (ph < 0) ph += 1;
      hist[Math.min(BINS - 1, Math.floor(ph * BINS))] += v;
      energy += v;
    }
    if (energy <= 0) continue;
    let mean = 0;
    for (let b = 0; b < BINS; b++) { sm[b] = 0.5 * hist[b] + 0.25 * (hist[(b + 1) % BINS] + hist[(b + BINS - 1) % BINS]); mean += sm[b]; }
    mean /= BINS;
    let best = BINS / 2, peak = -1;
    for (let b = BINS / 4; b <= (3 * BINS) / 4; b++) if (sm[b] > peak) { peak = sm[b]; best = b; }
    if (!(mean > 0) || peak / mean < MIN_PROMINENCE) continue;
    // Parabolic interpolation for a sub-bin peak position.
    const l = sm[best - 1], r = sm[best + 1], den = l - 2 * peak + r;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    // Tempo-family check: with the grid at 4:3 (or 2:3) of the real tempo, the real beats also fall a third and
    // two thirds of the way through each grid beat. Straight 4/4 music keeps those positions low.
    const at = (frac: number) => { const c = best + Math.round(frac * BINS); let m = 0; for (let d = -1; d <= 1; d++) m = Math.max(m, sm[(((c + d) % BINS) + BINS) % BINS]); return m / peak; };
    // Busy but straight windows (16th hats, off-beat bass) raise every position, so only a distinctly
    // triplet-shaped window counts: strong thirds, weak quarters and half.
    const suspect = Math.min(at(1 / 3), at(2 / 3)) >= 0.75 && Math.max(at(1 / 4), at(1 / 2), at(3 / 4)) <= 0.5;
    raw.push({ t: (s + e0) / 2 / fps, dev: (((best + 0.5 + off - BINS / 2) / BINS) * P) / fps, weight: energy, prom: peak / mean, suspect });
  }
  if (!raw.length) return [];
  // Quiet windows (silence, fades) say nothing about the grid.
  const sorted = raw.map((r) => r.weight).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  return raw.filter((r) => r.weight >= median * 0.25);
}

/** Weighted median of the offsets: the loudest-supported rhythm stream. */
function weightedMedian(ws: Win[]): number {
  const s = [...ws].sort((a, b) => a.dev - b.dev), half = s.reduce((a, w) => a + w.weight, 0) / 2;
  let acc = 0;
  for (const w of s) { acc += w.weight; if (acc >= half) return w.dev; }
  return 0;
}

/** Weighted mean offset of the windows within `limit` s of `around` (null when none are). */
function meanNear(ws: Win[], around: number, limit = 0.035): number | null {
  let sw = 0, sd = 0;
  for (const v of ws) if (Math.abs(v.dev - around) <= limit) { sw += v.weight; sd += v.weight * v.dev; }
  return sw > 0 ? sd / sw : null;
}

/** dev(t) ≈ a + s·t through the windows near the line, starting from offset `a0` (the stream being tracked). */
function fitLine(ws: Win[], a0: number): { a: number; s: number } | null {
  let a = a0, s = 0;
  for (const limit of [0.04, 0.03]) {
    let sw = 0, st = 0, sd = 0, stt = 0, std = 0, used = 0;
    for (const v of ws) {
      if (Math.abs(v.dev - (a + s * v.t)) > limit) continue;
      sw += v.weight; st += v.weight * v.t; sd += v.weight * v.dev; stt += v.weight * v.t * v.t; std += v.weight * v.t * v.dev; used++;
    }
    if (used < 3 || sw <= 0) return null;
    const den = sw * stt - st * st;
    s = Math.abs(den) > 1e-9 ? (sw * std - st * sd) / den : 0;
    a = (sd - s * st) / sw;
  }
  return { a, s };
}

/** How well the windows support the grid (see `GridEvidence`). `bpm` and `duration` set the chance level and the mix regions. */
function scoreWindows(ws: Win[], bpm: number, duration: number): GridEvidence {
  let total = 0, on = 0, sq = 0, k = 0, sal = 0, at = 0, sus = 0;
  const part = (from: number, to: number) => {
    let t = 0, o = 0;
    for (const v of ws) if (v.t >= from && v.t < to) { t += v.weight; if (Math.abs(v.dev) <= ON_GRID_S) o += v.weight; }
    return t > 0 ? o / t : 1;
  };
  for (const v of ws) {
    total += v.weight;
    if (Math.abs(v.dev) <= ON_GRID_S) { on += v.weight; sq += v.weight * v.dev * v.dev; sal += v.weight * v.prom; at += v.weight * v.t; if (v.suspect) sus += v.weight; k++; }
  }
  // Each window searches ±¼ beat, so a random onset lands on the grid with probability (2 × 25 ms) / (½ beat).
  const p0 = Math.min(0.9, (2 * ON_GRID_S) / (30 / bpm)), n = ws.length;
  return {
    stability: total > 0 ? on / total : 0, rms: on > 0 ? Math.sqrt(sq / on) : Infinity,
    intro: part(0, duration * 0.3), outro: part(duration * 0.7, Infinity),
    z: n > 0 ? (k - n * p0) / Math.sqrt(n * p0 * (1 - p0)) : 0,
    salience: total > 0 ? sal / total : 0, anchor: on > 0 ? at / on : NaN, suspect: on > 0 ? sus / on : 0,
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Whether the evidence shows a real, constant grid that Beat Mix can rely on:
 *  - far more windows on the grid than chance would put there (z ≥ 4: about a 1-in-30,000 fluke),
 *  - at least half of the track's beat (by loudness) on it, or at least half of the intro's and outro's,
 *  - confirmed at both ends. The intro and outro are where Auto DJ mixes, and a constant tempo that
 *    holds at both ends holds in between. Windows that miss are usually other strong hits (snares,
 *    vocals, off-beat bass) being louder than the beat in that stretch, not the grid drifting.
 */
export function gridTrusted(e: GridEvidence): boolean {
  const ends = Math.min(e.intro, e.outro);
  // Either most of the track is on the grid and both ends confirm it, or the ends themselves are solidly
  // on it (a louder second rhythm in the middle — percussion, bass — doesn't stop a clean mix in/out).
  // And the beat pattern mustn't point to a wrong tempo family.
  return e.z >= TRUST_Z && ((e.stability >= 0.5 && ends >= 0.25) || ends >= 0.5) && e.suspect < 0.3;
}

/** On the confidence scale (≥ 1.4 trusted): trusted grids 1.4–2.0 by strength of evidence, others below 1.4. */
export function evidenceConfidence(e: GridEvidence): number {
  if (gridTrusted(e)) return round(1.4 + 0.6 * Math.min(1, (e.z - TRUST_Z) / 6), 2);
  return round(Math.max(0, Math.min(1.35, (1.35 * e.z) / TRUST_Z)), 2);
}

/** The whole-track evidence for a given grid as it is (no fitting), or null when the track has too little beat to judge. */
export function checkGrid(env: ArrayLike<number>, fps: number, bpm: number, firstBeat: number): GridEvidence | null {
  if (!(bpm > 0) || !Number.isFinite(firstBeat) || env.length < fps * 20) return null;
  const x = sharpen(env, fps), ws = measure(x, fps, bpm, firstBeat);
  return ws.length < MIN_WINDOWS ? null : scoreWindows(ws, bpm, x.length / fps);
}

/** Candidate grid: tempo, first beat, the windows measured against it and their evidence. */
interface Candidate { bpm: number; first: number; ws: Win[]; e: GridEvidence }

/** Better evidence first: on-grid count above chance, then loudness share. */
const better = (a: GridEvidence, b: GridEvidence) => a.z > b.z + 0.25 || (Math.abs(a.z - b.z) <= 0.25 && a.stability > b.stability);

/**
 * Refine a detected grid across the whole track. `env` is an onset envelope at `fps` (see
 * `onsetEnvelope`). Returns null when there isn't enough steady beat to judge. Callers keep the
 * first-pass grid and its confidence then.
 */
export function fitGrid(env: ArrayLike<number>, fps: number, bpm: number, firstBeat: number): GridFit | null {
  if (!(bpm > 0) || !Number.isFinite(firstBeat) || env.length < fps * 20) return null;
  const x = sharpen(env, fps), duration = x.length / fps;
  // Changing the tempo pivots the grid on a beat where the first-pass grid is confirmed (the middle of its
  // on-grid windows; mid-track if none), so a slightly wrong BPM that has drifted elsewhere doesn't throw
  // every candidate tempo off the stream the grid is on.
  const firstLook = measure(x, fps, bpm, firstBeat);
  const anchorAt = firstLook.length ? scoreWindows(firstLook, bpm, duration).anchor : NaN;
  const k = Math.round(((Number.isFinite(anchorAt) ? anchorAt : duration / 2) - firstBeat) / (60 / bpm)), pivot = firstBeat + k * (60 / bpm);
  const grid = (b: number, shift = 0): Candidate | null => {
    let first = pivot + shift - k * (60 / b), ws = measure(x, fps, b, first);
    if (ws.length < MIN_WINDOWS) return null;
    // Centre on the stream the grid is already on (small moves only — never jump to another stream).
    const m = meanNear(ws, 0);
    if (m !== null && Math.abs(m) > 0.002) { first += m; ws = measure(x, fps, b, first); if (ws.length < MIN_WINDOWS) return null; }
    return { bpm: b, first, ws, e: scoreWindows(ws, b, duration) };
  };

  const original = grid(bpm);
  if (!original) return null;
  // The first pass leaves the grid where it was, with confidence from the whole-track evidence.
  const keep = (): GridFit => {
    const ws = measure(x, fps, bpm, firstBeat), e = scoreWindows(ws, bpm, duration);
    return { bpm, firstBeat, confidence: Math.min(evidenceConfidence(e), 1.35), windows: ws.length, evidence: e };
  };

  /** The strongest-beat phase (first-pass, or a ¼, ½ or ¾ beat shift) at tempo `b`, pivoting on beat k at pivot + `around`. */
  const strongestPhase = (b: number, around: number, incumbent: Candidate | null): Candidate | null => {
    let pick = incumbent;
    for (const q of [0, 0.25, 0.5, 0.75]) {
      const c = grid(b, around + q * (60 / b));
      if (!c || !gridTrusted(c.e)) continue;
      // Trying four phases is four chances of a fluke: moving off the first pass's phase needs much stronger evidence.
      if (q > 0 && (c.e.z < TRUST_Z + 2 || c.e.stability < 0.7)) continue;
      // The incumbent stays unless it isn't trusted or the other beat is clearly stronger.
      if (!pick || !gridTrusted(pick.e) || c.e.salience >= pick.e.salience * 1.25) pick = c;
    }
    return pick;
  };

  // `grid` puts beat k at pivot + shift, so around(c) is the shift that reproduces candidate c at any tempo.
  const around = (c: Candidate) => c.first + k * (60 / c.bpm) - pivot;

  /** Steps 1–4 from a seed grid: fine tempo scan, phase re-check, drift line, whole BPM, stream switch. */
  const refine = (seed: Candidate): Candidate => {
    // 1) Fine tempo scan: the BPM at which the most of the track lands on the grid, pivoting on the seed's stream.
    let best = seed;
    const onStream = around(seed), lo = seed.bpm * (1 - SCAN_RANGE), hi = seed.bpm * (1 + SCAN_RANGE);
    for (let b = Math.ceil(lo / SCAN_STEP) * SCAN_STEP; b <= hi; b += SCAN_STEP) {
      const c = grid(round(b, 4), onStream);
      if (c && better(c.e, best.e)) best = c;
    }
    // A drifting tempo can hide the strongest beat until the tempo is right: check the phase again.
    best = strongestPhase(best.bpm, around(best), best) ?? best;

    // 2) Remove any remaining drift with a line through the offsets (a few passes; keep only improvements).
    for (let pass = 0; pass < 3; pass++) {
      const line = fitLine(best.ws, 0);
      if (!line || Math.abs(line.s) > 0.004) break;
      const nb = best.bpm * (1 - line.s), nf = best.first + line.a + line.s * best.first;
      const ws = measure(x, fps, nb, nf);
      if (ws.length < MIN_WINDOWS) break;
      const e = scoreWindows(ws, nb, duration);
      if (better(best.e, e)) break;
      const moved = Math.abs(nb - best.bpm) > 1e-4 || Math.abs(nf - best.first) > 1e-4;
      best = { bpm: nb, first: nf, ws, e };
      if (!moved) break;
    }

    // 3) Prefer the nearest whole BPM when it fits as well (within measurement noise).
    const whole = Math.round(best.bpm);
    if (whole !== best.bpm && Math.abs(whole - best.bpm) <= 0.1) {
      const c = grid(whole, around(best));
      if (c && c.e.z >= best.e.z - 0.5 && c.e.stability >= best.e.stability - 0.03) best = c;
    }

    // 4) If the grid sits on a weak stream while another is clearly stronger in the intro and outro (where
    //    Auto DJ mixes), move to it.
    if (!gridTrusted(best.e)) {
      const m = weightedMedian(best.ws);
      if (Math.abs(m) > ON_GRID_S) {
        const ws = measure(x, fps, best.bpm, best.first + m);
        if (ws.length >= MIN_WINDOWS) {
          const e = scoreWindows(ws, best.bpm, duration);
          if (gridTrusted(e) && Math.min(e.intro, e.outro) >= Math.min(best.e.intro, best.e.outro) + 0.15) best = { bpm: best.bpm, first: best.first + m, ws, e };
        }
      }
    }
    return best;
  };

  // 0) Which stream: keep the first-pass phase unless a ¼, ½ or ¾ beat shift carries a clearly stronger beat
  //    (the first pass occasionally locks onto a 16th-note hat or bassline, or the off-beat, instead of the kick).
  let best = refine(strongestPhase(bpm, around(original), original) ?? original);

  // 5) Tempo family. Pop, hip-hop, reggaeton and dancehall often have a 3-3-2 rhythm: a strong accent every
  //    1½ beats. The first pass can lock onto that and double it, landing at 4:3 of the real tempo (a 104 BPM
  //    track read as 138.67), where every grid beat still meets some hit. Those grids show beats a third and
  //    two thirds of the way through each grid beat (`suspect`). For those, and for grids that didn't hold,
  //    try ¾ and 3⁄2 of the tempo and take one that is strongly confirmed and clean.
  if (best.e.suspect >= 0.3 || !gridTrusted(best.e)) {
    let alt: Candidate | null = null;
    for (const r of [3 / 4, 3 / 2]) {
      const b = best.bpm * r;
      if (b < 55 || b > 200) continue;
      const seed = strongestPhase(b, around(best), null);
      if (!seed) continue;
      const c = refine(seed);
      if (gridTrusted(c.e) && c.e.z >= TRUST_Z + 2 && c.e.stability >= 0.7 && (!alt || c.e.z > alt.e.z)) alt = c;
    }
    if (alt) best = alt;
  }

  // An unconfirmed fit isn't better evidence than the first pass: leave that grid alone (its confidence drops
  // below the trust line, so Beat Mix won't rely on it).
  if (!gridTrusted(best.e)) return keep();

  // 6) First beat: the beat nearest the original first beat (bar 1 shouldn't jump by a whole beat
  //    just because the fit moved slightly), kept at or after 0.
  const T = 60 / best.bpm;
  let first = best.first + Math.round((firstBeat - best.first) / T) * T;
  while (first < 0) first += T;
  return { bpm: round(best.bpm, 3), firstBeat: round(first, 5), confidence: evidenceConfidence(best.e), windows: best.ws.length, evidence: best.e };
}

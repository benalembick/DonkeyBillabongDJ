/**
 * Track analysis (runs in a Web Worker; pure so it can be unit-tested).
 *
 *  - 3-band waveform (low / mid / high peaks) at WAVE_FPS frames per second,
 *    used for the colour-coded scrolling and overview waveforms.
 *  - Tempo + beat phase: onset-strength envelope → autocorrelation for the
 *    tempo family → fine comb search for exact BPM and phase. Produces an
 *    estimated beat grid (first beat + BPM); downbeats are assumed every 4 beats.
 */

export const WAVE_FPS = 150;

export interface TrackAnalysis {
  /** Overview (fixed number of buckets): peak and RMS, 0..1-ish. */
  peaks: Float32Array;
  rms: Float32Array;
  /** Detailed 3-band waveform, one value per frame at `fps`. */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  fps: number;
  bpm: number | null;
  /** Time (s) of the first beat of the grid (≥ 0). */
  firstBeat: number | null;
  /** Beat detection confidence (comb peak / mean, ~1 = none, > 2 = good). */
  confidence: number;
  bpmSource: "analysis" | "metadata" | "none";
}

export function analyzeTrack(channels: Float32Array[], sampleRate: number, buckets: number, metaBpm: number | null = null): TrackAnalysis {
  const n = channels[0]?.length ?? 0;
  const L = channels[0];
  const R = channels[1] ?? channels[0];
  const frames = Math.max(1, Math.ceil((n / sampleRate) * WAVE_FPS));
  const hop = sampleRate / WAVE_FPS;
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const onsetEnv = new Float32Array(frames);

  // One-pole filters: low < 200 Hz, high > 2.5 kHz, mid = the rest.
  const aLow = Math.exp((-2 * Math.PI * 200) / sampleRate);
  const aHi = Math.exp((-2 * Math.PI * 2500) / sampleRate);
  let yLow = 0;
  let yHi = 0;
  let f = 0;
  let next = hop;
  let pL = 0;
  let pM = 0;
  let pH = 0;
  let eSum = 0;
  let eCount = 0;
  for (let i = 0; i < n; i++) {
    const x = (L[i] + R[i]) * 0.5;
    yLow += (1 - aLow) * (x - yLow);
    yHi += (1 - aHi) * (x - yHi);
    const lo = yLow;
    const hi = x - yHi;
    const md = yHi - yLow;
    const al = lo < 0 ? -lo : lo;
    const am = md < 0 ? -md : md;
    const ah = hi < 0 ? -hi : hi;
    if (al > pL) pL = al;
    if (am > pM) pM = am;
    if (ah > pH) pH = ah;
    eSum += lo * lo + 0.35 * md * md;
    eCount++;
    if (i + 1 >= next || i === n - 1) {
      if (f < frames) {
        low[f] = pL;
        mid[f] = pM;
        high[f] = pH;
        onsetEnv[f] = Math.sqrt(eSum / Math.max(1, eCount));
      }
      f++;
      next += hop;
      pL = pM = pH = eSum = 0;
      eCount = 0;
    }
  }

  // Overview buckets from the detailed data (max over each span).
  const peaks = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor((b * frames) / buckets);
    const e = Math.max(s + 1, Math.floor(((b + 1) * frames) / buckets));
    let p = 0;
    let q = 0;
    for (let k = s; k < e && k < frames; k++) {
      const v = Math.max(low[k], mid[k], high[k]);
      if (v > p) p = v;
      q += onsetEnv[k] * onsetEnv[k];
    }
    peaks[b] = p;
    rms[b] = Math.sqrt(q / (e - s));
  }

  const beat = detectBeats(onsetEnv, WAVE_FPS, metaBpm);
  return { peaks, rms, low, mid, high, fps: WAVE_FPS, ...beat };
}

/** Onset strength = positive change of the (log-compressed) energy envelope. */
function onsetStrength(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  let prev = 0;
  for (let i = 0; i < env.length; i++) {
    const v = Math.log1p(env[i] * 100);
    const d = v - prev;
    out[i] = d > 0 ? d : 0;
    prev = v;
  }
  // Remove slow trend (local mean over ~0.5 s) so loud sections don't dominate.
  const w = 37;
  const res = new Float32Array(out.length);
  let acc = 0;
  for (let i = 0; i < out.length; i++) {
    acc += out[i];
    if (i >= w) acc -= out[i - w];
    const mean = acc / Math.min(i + 1, w);
    res[i] = Math.max(0, out[i] - mean);
  }
  return res;
}

/** Comb score for a period P (frames): how peaked the onset histogram folded at P is. Returns [score, bestPhaseFrames]. */
function comb(flux: Float32Array, start: number, end: number, P: number): [number, number] {
  const BINS = 48;
  const hist = new Float32Array(BINS);
  let total = 0;
  for (let i = start; i < end; i++) {
    const v = flux[i];
    if (v <= 0) continue;
    const ph = (i % P) / P;
    hist[Math.min(BINS - 1, Math.floor(ph * BINS))] += v;
    total += v;
  }
  if (total <= 0) return [0, 0];
  // Smooth circularly (beats smear across neighbouring bins).
  let best = 0;
  let bestBin = 0;
  for (let b = 0; b < BINS; b++) {
    const s = hist[b] + 0.5 * (hist[(b + 1) % BINS] + hist[(b + BINS - 1) % BINS]);
    if (s > best) {
      best = s;
      bestBin = b;
    }
  }
  return [(best / (total / BINS)) / 2, ((bestBin + 0.5) / BINS) * P];
}

export function detectBeats(env: Float32Array, fps: number, metaBpm: number | null): Pick<TrackAnalysis, "bpm" | "firstBeat" | "confidence" | "bpmSource"> {
  const flux = onsetStrength(env);
  // Analyse up to ~150 s from the body of the track (skip the first 10 s when long enough).
  const start = flux.length > fps * 60 ? Math.floor(fps * 10) : 0;
  const end = Math.min(flux.length, start + Math.floor(fps * 150));
  if (end - start < fps * 8) return { bpm: metaBpm, firstBeat: null, confidence: 0, bpmSource: metaBpm ? "metadata" : "none" };

  // 1) Autocorrelation over 60..190 BPM for the tempo family.
  const lagMin = Math.floor((60 * fps) / 190);
  const lagMax = Math.ceil((60 * fps) / 60);
  const acf = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = start; i + lag < end; i++) s += flux[i] * flux[i + lag];
    acf[lag] = s / (end - start - lag);
  }
  let bestLag = lagMin;
  let bestScore = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    // Reward lags whose double also correlates (suppresses off-beat/triplet errors).
    const s = acf[lag] + 0.5 * (2 * lag <= lagMax ? acf[2 * lag] : 0);
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  let bpm = (60 * fps) / bestLag;
  while (bpm < 80) bpm *= 2;
  while (bpm > 175) bpm /= 2;

  // Metadata BPM (tags / service) as a prior: accept it when the audio agrees with it or an octave of it.
  let source: TrackAnalysis["bpmSource"] = "analysis";
  if (metaBpm && metaBpm > 40 && metaBpm < 250) {
    // Keep the audio's octave (dance-range preference), take the metadata's precision.
    const r = [1, 2, 0.5].find((x) => Math.abs(bpm * x - metaBpm) / metaBpm < 0.04);
    if (r) bpm = metaBpm / r;
  }

  // 2) Fine search ±2 % around the estimate for the sharpest comb (exact tempo) + phase.
  let fine = { bpm, score: 0, phase: 0 };
  for (let b = bpm * 0.98; b <= bpm * 1.02; b += 0.02) {
    const [score, phase] = comb(flux, start, end, (60 * fps) / b);
    if (score > fine.score) fine = { bpm: b, score, phase };
  }
  const refined = Math.round(fine.bpm * 100) / 100;
  if (metaBpm && Math.abs(refined - metaBpm) / metaBpm < 0.005) source = "metadata";
  const periodS = 60 / refined;
  let firstBeat = fine.phase / fps;
  firstBeat = ((firstBeat % periodS) + periodS) % periodS;
  return { bpm: refined, firstBeat, confidence: Math.round(fine.score * 100) / 100, bpmSource: source };
}

/**
 * Track analysis (runs in a Web Worker; pure so it can be unit-tested).
 *
 *  - 3-band waveform (low / mid / high peaks) at WAVE_FPS frames per second,
 *    used for the colour-coded scrolling and overview waveforms.
 *  - Tempo + beat phase: onset-strength envelope → autocorrelation for the
 *    tempo family → fine comb search for exact BPM and phase. Produces an
 *    estimated beat grid (first beat + BPM); downbeats are assumed every 4 beats.
 */

import { EQ_HIGH_HZ, EQ_LOW_HZ } from "../core/engine/mixerMath";

export const WAVE_FPS = 150;
/** Display crossovers for the waveform styles = the channel EQ's low-shelf / high-shelf corners. */
export const DISPLAY_LOW_HZ = EQ_LOW_HZ;
export const DISPLAY_HIGH_HZ = EQ_HIGH_HZ;

/** Per-channel display bands (peaks per frame at `fps`): full-band, low, mid, high for L and R. */
export interface DisplayBands {
  allL: Float32Array;
  lowL: Float32Array;
  midL: Float32Array;
  highL: Float32Array;
  allR: Float32Array;
  lowR: Float32Array;
  midR: Float32Array;
  highR: Float32Array;
  /** False for mono sources (R duplicates L). */
  stereo: boolean;
}
export const DISPLAY_KEYS = ["allL", "lowL", "midL", "highL", "allR", "lowR", "midR", "highR"] as const;

export interface TrackAnalysis {
  /** Overview (fixed number of buckets): peak and RMS, 0..1-ish. */
  peaks: Float32Array;
  rms: Float32Array;
  /** Detailed 3-band waveform, one value per frame at `fps`. */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** Waveform-style display data (absent in caches made before waveform styles; upgraded on next load). */
  bands?: DisplayBands;
  fps: number;
  bpm: number | null;
  /** Time (s) of the first beat of the grid (≥ 0). */
  firstBeat: number | null;
  /** Beat detection confidence (comb peak / mean, ~1 = none, > 2 = good). */
  confidence: number;
  bpmSource: "analysis" | "metadata" | "none";
  /** Perceptual estimates. Unknown values stay null rather than being guessed. */
  key: string | null;
  keyConfidence: number;
  energy: number | null;
  energyConfidence: number;
  gainDb: number | null;
  peak: number;
  sections: AnalysisSection[];
  recommendedCues: RecommendedCue[];
  /**
   * Exactly 8 structural hot cue suggestions (Intro 1/2, Build 1, Drop 1, Build 2,
   * Drop 2, Outro 1/2) in that fixed order, for the hot cue pads — or empty when
   * the track is too short or its tempo isn't known confidently enough to place them.
   */
  hotCueSuggestions: RecommendedCue[];
}

export type SectionKind = "intro" | "verse" | "breakdown" | "build" | "drop" | "chorus" | "outro" | "section";
export interface AnalysisSection { kind: SectionKind; start: number; end: number; confidence: number; energy: number }
export interface RecommendedCue { kind: "mix-in" | "mix-out" | SectionKind; timestamp: number; confidence: number; label: string }

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
  // Display bands per channel: 2-pole (12 dB/oct) splits at ~250 Hz and ~4 kHz. Separate from the
  // mono 200 Hz / 2.5 kHz bands above, which drive beat, energy and cue detection and stay unchanged.
  const stereo = !!channels[1] && channels[1] !== channels[0];
  const bands: DisplayBands = { stereo } as DisplayBands;
  for (const k of DISPLAY_KEYS) bands[k] = new Float32Array(frames);
  const dLo = Math.exp((-2 * Math.PI * DISPLAY_LOW_HZ) / sampleRate);
  const dHi = Math.exp((-2 * Math.PI * DISPLAY_HIGH_HZ) / sampleRate);
  let l1L = 0, l2L = 0, h1L = 0, h2L = 0, l1R = 0, l2R = 0, h1R = 0, h2R = 0;
  let aL = 0, bL = 0, cL = 0, eL = 0, aR = 0, bR = 0, cR = 0, eR = 0;

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
    const xl = L[i];
    const xr = R[i];
    l1L += (1 - dLo) * (xl - l1L); l2L += (1 - dLo) * (l1L - l2L);
    h1L += (1 - dHi) * (xl - h1L); h2L += (1 - dHi) * (h1L - h2L);
    let v = xl < 0 ? -xl : xl; if (v > aL) aL = v;
    v = l2L < 0 ? -l2L : l2L; if (v > bL) bL = v;
    v = h2L - l2L; if (v < 0) v = -v; if (v > cL) cL = v;
    v = xl - h2L; if (v < 0) v = -v; if (v > eL) eL = v;
    if (stereo) {
      l1R += (1 - dLo) * (xr - l1R); l2R += (1 - dLo) * (l1R - l2R);
      h1R += (1 - dHi) * (xr - h1R); h2R += (1 - dHi) * (h1R - h2R);
      v = xr < 0 ? -xr : xr; if (v > aR) aR = v;
      v = l2R < 0 ? -l2R : l2R; if (v > bR) bR = v;
      v = h2R - l2R; if (v < 0) v = -v; if (v > cR) cR = v;
      v = xr - h2R; if (v < 0) v = -v; if (v > eR) eR = v;
    }
    const x = (xl + xr) * 0.5;
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
        bands.allL[f] = aL; bands.lowL[f] = bL; bands.midL[f] = cL; bands.highL[f] = eL;
        bands.allR[f] = stereo ? aR : aL; bands.lowR[f] = stereo ? bR : bL; bands.midR[f] = stereo ? cR : cL; bands.highR[f] = stereo ? eR : eL;
      }
      aL = bL = cL = eL = aR = bR = cR = eR = 0;
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

  const duration = Math.max(0.001, n / sampleRate);
  const beat = detectBeats(onsetEnv, WAVE_FPS, metaBpm);
  const musicalKey = detectKey(channels, sampleRate);
  const structure = analyseStructure(rms, duration);
  const hotCueSuggestions = suggestHotCues(low, onsetEnv, WAVE_FPS, duration, beat.bpm);
  let peak = 0, square = 0;
  for (const v of peaks) { peak = Math.max(peak, v); square += v * v; }
  const perceived = Math.sqrt(square / Math.max(1, peaks.length));
  const gainDb = perceived > 0 ? Math.max(-18, Math.min(18, 20 * Math.log10(0.18 / perceived))) : null;
  return { peaks, rms, low, mid, high, bands, fps: WAVE_FPS, ...beat,
    key: musicalKey.key, keyConfidence: musicalKey.confidence, energy: structure.energy, energyConfidence: structure.confidence,
    gainDb, peak, sections: structure.sections, recommendedCues: structure.cues, hotCueSuggestions };
}

/** Lightweight chroma estimate. Low-confidence or tonally ambiguous audio remains unknown. */
export function detectKey(channels: Float32Array[], sampleRate: number): { key: string | null; confidence: number } {
  const left = channels[0]; if (!left || left.length < sampleRate * 8) return { key: null, confidence: 0 };
  const right = channels[1] ?? left, chroma = new Float64Array(12);
  const semitone = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const windows = 18, size = 4096;
  for (let w = 0; w < windows; w++) {
    const start = Math.floor((left.length - size) * (w + 1) / (windows + 1));
    for (let pc = 0; pc < 12; pc++) for (const midi of [48 + pc, 60 + pc]) {
      const omega = 2 * Math.PI * semitone(midi) / sampleRate; let re = 0, im = 0;
      for (let i = 0; i < size; i += 2) {
        const x = (left[start + i] + right[start + i]) * 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
        re += x * Math.cos(omega * i); im -= x * Math.sin(omega * i);
      }
      chroma[pc] += Math.sqrt(re * re + im * im);
    }
  }
  const major = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const minor = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const scores: { key: string; score: number }[] = [];
  for (let root = 0; root < 12; root++) for (const [profile, suffix] of [[major, ""], [minor, "m"]] as const) {
    let score = 0; for (let pc = 0; pc < 12; pc++) score += chroma[(pc + root) % 12] * profile[pc];
    scores.push({ key: `${names[root]}${suffix}`, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const confidence = scores[0].score ? Math.max(0, Math.min(1, (scores[0].score - scores[1].score) / scores[0].score * 5)) : 0;
  return confidence >= 0.12 ? { key: scores[0].key, confidence } : { key: null, confidence };
}

/** Conservative structure estimates from smoothed energy. Labels other than intro/outro/build/drop need strong contrast. */
export function analyseStructure(rms: Float32Array, duration: number): { energy: number | null; confidence: number; sections: AnalysisSection[]; cues: RecommendedCue[] } {
  if (rms.length < 8 || duration < 8) return { energy: null, confidence: 0, sections: [], cues: [] };
  const values = [...rms].sort((a, b) => a - b);
  const p90 = values[Math.floor(values.length * 0.9)] || 0;
  if (!p90) return { energy: null, confidence: 0, sections: [], cues: [] };
  const bins = 32, e: number[] = [];
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * rms.length / bins), to = Math.max(from + 1, Math.floor((b + 1) * rms.length / bins));
    let sum = 0; for (let i = from; i < to; i++) sum += rms[i];
    e.push(Math.min(1, sum / (to - from) / p90));
  }
  const mean = e.reduce((a, b) => a + b, 0) / bins;
  const variance = e.reduce((s, x) => s + (x - mean) ** 2, 0) / bins;
  const energy = Math.max(1, Math.min(10, Math.round(1 + mean * 7 + Math.sqrt(variance) * 3)));
  const confidence = Math.min(1, 0.45 + Math.sqrt(variance) * 1.5);
  const time = (i: number) => i / bins * duration;
  let introEnd = Math.min(4, bins - 2); while (introEnd < bins / 3 && e[introEnd] < mean * 0.75) introEnd++;
  let outroStart = bins - Math.min(4, bins - 2); while (outroStart > bins * 2 / 3 && e[outroStart] < mean * 0.75) outroStart--;
  const sections: AnalysisSection[] = [];
  sections.push({ kind: "intro", start: 0, end: time(introEnd), confidence: 0.65, energy: Math.round(e.slice(0, introEnd).reduce((a, b) => a + b, 0) / introEnd * 10) });
  let last = introEnd;
  for (let i = introEnd + 1; i < outroStart; i++) {
    const delta = e[i] - e[i - 1];
    if (Math.abs(delta) < 0.3) continue;
    if (i - last >= 2) sections.push({ kind: delta > 0 ? "build" : "breakdown", start: time(last), end: time(i), confidence: Math.min(0.9, Math.abs(delta) + 0.4), energy: Math.round(e.slice(last, i).reduce((a, b) => a + b, 0) / (i - last) * 10) });
    last = i;
    if (delta > 0.35) sections.push({ kind: "drop", start: time(i), end: time(Math.min(outroStart, i + 3)), confidence: Math.min(0.9, delta + 0.4), energy: Math.round(e[i] * 10) });
  }
  if (last < outroStart) sections.push({ kind: mean > 0.6 ? "chorus" : "verse", start: time(last), end: time(outroStart), confidence: 0.4, energy: Math.round(mean * 10) });
  sections.push({ kind: "outro", start: time(outroStart), end: duration, confidence: 0.65, energy: Math.round(e.slice(outroStart).reduce((a, b) => a + b, 0) / Math.max(1, bins - outroStart) * 10) });
  const firstBeat = 0;
  const mixIn = Math.max(firstBeat, time(introEnd));
  const mixOut = time(outroStart);
  const cues: RecommendedCue[] = [
    { kind: "mix-in", timestamp: mixIn, confidence: 0.65, label: "Recommended Mix In" },
    { kind: "mix-out", timestamp: mixOut, confidence: 0.65, label: "Recommended Mix Out" },
    ...sections.filter((s) => s.kind === "drop" || s.kind === "breakdown").slice(0, 4).map((s) => ({ kind: s.kind, timestamp: s.start, confidence: s.confidence, label: s.kind === "drop" ? "Drop" : "Breakdown" })),
  ];
  return { energy, confidence, sections, cues };
}

/**
 * Suggests 8 structural hot cues for standard 4/4 dance-music phrasing, bar-aligned
 * from the track's start: Intro 1 (0:00) / Intro 2 (+8 bars) / Build 1 / Drop 1 /
 * Build 2 / Drop 2 / Outro 1 / Outro 2 (+8 bars after Outro 1). A drop is a bar
 * whose bass energy jumps sharply above its preceding bars and stays up (not a
 * one-bar transient); a build's start is the quietest bar in the lookback before
 * a drop, snapped to the nearest canonical 8/16/32-bar phrase length. Requires a
 * confidently detected tempo and enough bars for the structure to exist at all —
 * otherwise returns no suggestions rather than guessing.
 */
export function suggestHotCues(low: Float32Array, power: Float32Array, fps: number, duration: number, bpm: number | null): RecommendedCue[] {
  // Duration, not bar count, gates this: a bar-count minimum is tempo-biased and would silently
  // reject plenty of ordinary full-length songs just for having a slower tempo (e.g. at 88 BPM a
  // typical ~3-minute track is only ~65 bars — a flat 64-bar floor rejected it for no good reason).
  if (!bpm || bpm <= 0 || duration < 90) return [];
  const barLength = 240 / bpm; // 4 beats/bar, 4/4 assumed
  const totalBars = Math.floor(duration / barLength);
  const bass = barAverages(low, fps, barLength, totalBars);
  const level = barAverages(power, fps, barLength, totalBars);
  normalizeInPlace(bass);
  normalizeInPlace(level);

  const drops = findDropBars(bass, level, 16);
  const drop1 = drops[0] ?? Math.round(totalBars * 0.35);
  const drop2 = drops.find((b) => b >= drop1 + 16) ?? Math.min(totalBars - 9, Math.max(drop1 + 24, Math.round(totalBars * 0.7)));
  const build1 = findBuildStartBar(level, drop1, 16);
  const build2 = findBuildStartBar(level, drop2, drop1 + 8);
  const outro1 = findOutroStartBar(level, drop2, totalBars);

  const bars = enforceBarOrder([0, 8, build1, drop1, build2, drop2, outro1, outro1 + 8], 4, totalBars - 1);
  const meta: { kind: SectionKind; label: string }[] = [
    { kind: "intro", label: "Intro 1" }, { kind: "intro", label: "Intro 2" },
    { kind: "build", label: "Build 1" }, { kind: "drop", label: "Drop 1" },
    { kind: "build", label: "Build 2" }, { kind: "drop", label: "Drop 2" },
    { kind: "outro", label: "Outro 1" }, { kind: "outro", label: "Outro 2" },
  ];
  return bars.map((b, i) => ({ kind: meta[i].kind, label: meta[i].label, confidence: 0.75, timestamp: Math.min(duration, b * barLength) }));
}

/** Mean of `signal` (at `fps`) within each bar of length `barLength` seconds, `totalBars` of them from t=0. */
function barAverages(signal: Float32Array, fps: number, barLength: number, totalBars: number): Float32Array {
  const out = new Float32Array(totalBars);
  for (let b = 0; b < totalBars; b++) {
    const f0 = Math.floor(b * barLength * fps);
    const f1 = Math.min(signal.length, Math.max(f0 + 1, Math.floor((b + 1) * barLength * fps)));
    let sum = 0;
    for (let f = f0; f < f1; f++) sum += signal[f];
    out[b] = sum / Math.max(1, f1 - f0);
  }
  return out;
}

/** Scales in place so the 90th percentile sits at 1.0 (a stand-in for "loud" that's robust to outliers). */
function normalizeInPlace(values: Float32Array): void {
  const sorted = [...values].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;
  for (let i = 0; i < values.length; i++) values[i] = Math.min(1.5, values[i] / p90);
}

function barRangeAvg(arr: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return to > from ? s / (to - from) : 0;
}

/** Bars where bass jumps sharply above its preceding 8 bars, stays up for 4 bars (not a one-bar hit), and is objectively loud. */
function findDropBars(bass: Float32Array, level: Float32Array, minBar: number): number[] {
  const n = bass.length, lookback = 8, sustain = 4;
  const events: number[] = [];
  for (let b = minBar; b < n - sustain; b++) {
    const before = barRangeAvg(bass, Math.max(0, b - lookback), b);
    if (bass[b] - before < 0.3) continue;
    if (level[b] < 0.55) continue;
    if (barRangeAvg(bass, b, b + sustain) < before + 0.2) continue;
    if (events.length && b - events[events.length - 1] <= sustain) continue; // one event per run of nearby hits
    events.push(b);
  }
  return events;
}

/** The quietest bar in the lookback before a drop, with the gap snapped to the nearest canonical 8/16/32-bar phrase. */
function findBuildStartBar(level: Float32Array, dropBar: number, earliestBar: number): number {
  const from = Math.max(earliestBar, dropBar - 32);
  if (from >= dropBar) return Math.max(earliestBar, dropBar - 8);
  let minBar = from;
  for (let b = from; b < dropBar; b++) if (level[b] < level[minBar]) minBar = b;
  const rawGap = dropBar - minBar;
  const snapped = [8, 16, 32].reduce((best, c) => (Math.abs(c - rawGap) < Math.abs(best - rawGap) ? c : best));
  return Math.max(earliestBar, dropBar - snapped);
}

/** Where the outro's drums return after the comedown following the second drop, or (failing that) where the closing tail begins. */
function findOutroStartBar(level: Float32Array, afterBar: number, totalBars: number): number {
  const tailStart = Math.max(afterBar + 1, Math.floor(totalBars * 0.75));
  if (tailStart >= totalBars - 1) return Math.max(afterBar + 4, totalBars - 9);
  let dipBar = tailStart;
  for (let b = tailStart; b < totalBars; b++) if (level[b] < level[dipBar]) dipBar = b;
  const recoveredTo = Math.max(0.4, level[dipBar] + 0.15);
  for (let b = dipBar + 1; b < totalBars; b++) if (level[b] >= recoveredTo) return b;
  // No return of the drums detected (the track just fades): fall back to where the low tail begins.
  const mean = barRangeAvg(level, afterBar, totalBars);
  let b = totalBars - 1;
  while (b > afterBar + 8 && level[b] < mean * 0.75) b--;
  return b;
}

/** Forces strictly increasing bar indices at least `minGap` apart, clamped to `maxBar`; `bars[0]`/`bars[1]` (Intro 1/2) stay fixed anchors. */
function enforceBarOrder(bars: number[], minGap: number, maxBar: number): number[] {
  const out = bars.map((b) => Math.max(0, Math.min(maxBar, Math.round(b))));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + minGap);
  for (let i = out.length - 1; i >= 1; i--) {
    if (out[i] > maxBar) out[i] = maxBar;
    if (out[i] <= out[i - 1]) out[i - 1] = Math.max(0, out[i] - minGap);
  }
  return out;
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

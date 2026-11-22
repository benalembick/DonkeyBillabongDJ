/**
 * Onset detection for the Drum Transcriber.
 *
 * Novelty = multi-band log spectral flux (SuperFlux-style: each band is compared with the maximum of its neighbours
 * two frames earlier, which ignores slow swells and small frequency wobble). Peaks are picked against an adaptive
 * threshold (local mean over the preceding ~100 ms plus a sensitivity-scaled offset of the track's robust peak flux),
 * with a 25 ms minimum spacing. Each peak is then refined in the time domain to the start of its attack (≈1 ms
 * resolution) so the stored onset is the hit's real start, not an STFT frame time.
 */
import { blockEnvelope, percentile, type BandSpectrogram } from "./dsp";

export interface Onset {
  /** Refined attack start (seconds). */
  time: number;
  /** Spectrogram frame of the novelty peak. */
  frame: number;
  /** Novelty peak, relative to the track's robust maximum (≈0–1+). */
  strength: number;
}

export interface OnsetOptions { sensitivity?: number; minSpacing?: number }

/** Log-compressed, level-independent band magnitudes (global max → 1, then log1p(1000·x)). */
export function logBands(spec: BandSpectrogram): Float32Array {
  let max = 1e-12; for (let i = 0; i < spec.data.length; i++) if (spec.data[i] > max) max = spec.data[i];
  const out = new Float32Array(spec.data.length); for (let i = 0; i < out.length; i++) out[i] = Math.log1p(1000 * spec.data[i] / max);
  return out;
}

/** Frequency regions picked separately so a quiet hi-hat is not judged against a kick's whole-spectrum flux. */
export const ONSET_REGIONS: [number, number][] = [[0, 200], [200, 5000], [5000, Infinity]];

/**
 * Positive log-flux per frame for each region: per band, the rise against the max of its neighbouring bands two
 * frames back (SuperFlux-style), summed over the region's bands.
 */
export function regionFlux(spec: BandSpectrogram, log = logBands(spec)): Float32Array[] {
  const { frames, bands, centres } = spec; const region = centres.map((c) => ONSET_REGIONS.findIndex(([lo, hi]) => c >= lo && c < hi));
  const out = ONSET_REGIONS.map(() => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const p = f - 2;
    for (let b = 0; b < bands; b++) {
      let prev = 0; if (p >= 0) for (let k = Math.max(0, b - 1); k <= Math.min(bands - 1, b + 1); k++) prev = Math.max(prev, log[p * bands + k]);
      const d = log[f * bands + b] - prev; if (d > 0) out[region[b]][f] += d;
    }
  }
  return out;
}
/** Whole-spectrum flux (sum of the regions). */
export function spectralFlux(spec: BandSpectrogram, log = logBands(spec)): Float32Array {
  const parts = regionFlux(spec, log); const out = new Float32Array(spec.frames);
  for (const r of parts) for (let f = 0; f < out.length; f++) out[f] += r[f]; return out;
}

/** Frame energy (sum of band magnitudes) gate: frames > 60 dB below the loudest frame never start an onset. */
function energyGate(spec: BandSpectrogram): Uint8Array {
  const { frames, bands, data } = spec; const e = new Float32Array(frames); let max = 1e-12;
  for (let f = 0; f < frames; f++) { let s = 0; for (let b = 0; b < bands; b++) s += data[f * bands + b]; e[f] = s; if (s > max) max = s; }
  const out = new Uint8Array(frames); for (let f = 0; f < frames; f++) out[f] = e[f] > max * 1e-3 ? 1 : 0; return out;
}

/**
 * Peak picking on one novelty curve: a local maximum (±17 ms) above the mean of the preceding ~100 ms plus a
 * sensitivity-scaled offset of the curve's robust peak (98th percentile), and above `floor` (absolute).
 */
function peaksOf(flux: Float32Array, fps: number, gate: Uint8Array, sens: number, floor: number): { frame: number; strength: number }[] {
  const nonzero = Array.from(flux).filter((x) => x > 1e-6); const scale = Math.max(1e-6, percentile(nonzero, .98));
  const delta = Math.max(floor, scale * (.27 - .24 * sens)); const pre = Math.round(.1 * fps), post = Math.round(.03 * fps), local = Math.max(1, Math.round(.017 * fps));
  const peaks: { frame: number; strength: number }[] = [];
  for (let f = 0; f < flux.length; f++) {
    const v = flux[f]; if (v <= delta || !gate[Math.min(flux.length - 1, f + 2)]) continue;
    let isMax = true; for (let k = Math.max(0, f - local); k <= Math.min(flux.length - 1, f + local); k++) if (flux[k] > v || (flux[k] === v && k < f)) { isMax = false; break; }
    if (!isMax) continue;
    let mean = 0, n = 0; for (let k = Math.max(0, f - pre); k <= Math.min(flux.length - 1, f + post); k++) { mean += flux[k]; n++; }
    if (v < mean / Math.max(1, n) + delta) continue;
    peaks.push({ frame: f, strength: v / scale });
  }
  return peaks;
}

export function pickPeaks(spec: BandSpectrogram, options: OnsetOptions = {}, log = logBands(spec)): { frame: number; strength: number }[] {
  const sens = Math.max(0, Math.min(1, options.sensitivity ?? .5)); const fps = spec.rate / spec.hop; const gate = energyGate(spec);
  const regions = regionFlux(spec, log); const total = new Float32Array(spec.frames); for (const r of regions) for (let f = 0; f < total.length; f++) total[f] += r[f];
  const globalScale = Math.max(1e-6, percentile(Array.from(total).filter((x) => x > 1e-6), .98));
  // A region only contributes onsets of a meaningful absolute size (cross-talk in an otherwise empty region is ignored).
  const floor = globalScale * (.05 - .04 * sens);
  const all = [...peaksOf(total, fps, gate, sens, 0), ...regions.flatMap((r) => peaksOf(r, fps, gate, sens, floor))].sort((a, b) => a.frame - b.frame);
  // Minimum spacing: peaks closer than minSpacing are one onset (the earliest frame, strongest strength).
  const minFrames = Math.round((options.minSpacing ?? .025) * fps); const kept: typeof all = [];
  for (const p of all) { const last = kept[kept.length - 1]; if (last && p.frame - last.frame < minFrames) last.strength = Math.max(last.strength, p.strength); else kept.push({ ...p }); }
  return kept;
}

/**
 * Refines a novelty peak to the start of its attack using ≈1 ms peak envelopes of the signal and of its first
 * difference (so hi-hat attacks are as visible as kick attacks). Searches ±25 ms around the frame centre, bounded by
 * the neighbouring peaks, for the largest envelope jump, then walks back to where the attack leaves the floor.
 */
export function refineOnset(env: Float32Array, block: number, rate: number, centre: number, lo: number, hi: number): number {
  const ms = rate / block / 1000; const from = Math.max(0, Math.floor(Math.max(lo, centre - .025) * rate / block)), to = Math.min(env.length - 1, Math.ceil(Math.min(hi, centre + .025) * rate / block));
  let best = -1, bestAt = -1;
  for (let i = from; i <= to; i++) { let prev = 0; for (let k = i - 5; k < i; k++) prev = Math.max(prev, k >= 0 ? env[k] : 0); const jump = env[i] - prev; if (jump > best) { best = jump; bestAt = i; } }
  if (bestAt < 0 || best <= 0) return centre;
  // Peak of this attack (within 6 ms) and the floor just before it.
  let peak = env[bestAt]; for (let k = bestAt; k < Math.min(env.length, bestAt + Math.round(6 * ms)); k++) peak = Math.max(peak, env[k]);
  let floor = Infinity; for (let k = Math.max(0, bestAt - Math.round(8 * ms)); k < bestAt; k++) floor = Math.min(floor, env[k]); if (!Number.isFinite(floor)) floor = 0;
  const level = floor + .1 * (peak - floor); const lowest = Math.max(0, from - 5);
  const walkBack = (i: number) => { let j = i; while (j > lowest && env[j - 1] > level) j--; return j; };
  let j = walkBack(bestAt);
  // Multi-burst sounds (claps, flams): if an earlier burst within 25 ms genuinely *rises* out of a floor (not a previous
  // hit's smooth decay), the hit starts there.
  // Judged on a ±2-block max-smoothed envelope so a low sine's zero crossings (a kick's tail) never look like a new burst.
  const smooth = (i: number) => { let v = 0; for (let q = i - 2; q <= i + 2; q++) if (q >= 0 && q < env.length) v = Math.max(v, env[q]); return v; };
  for (let guard = 0; guard < 4; guard++) {
    let earlier = -1;
    for (let k = Math.max(lowest + 10, j - Math.round(25 * ms)); k < j - 2; k++) {
      if (env[k] < .35 * peak) continue; let before = Infinity; for (let q = k - 10; q <= k - 4; q++) before = Math.min(before, smooth(q));
      if (env[k] >= 3 * before) { earlier = k; break; }
    }
    if (earlier < 0) break; j = walkBack(earlier);
  }
  return j * block / rate;
}

/** Full onset detection over a band spectrogram and the analysis-rate mono signal. */
export function detectOnsets(spec: BandSpectrogram, mono: Float32Array, options: OnsetOptions = {}): Onset[] {
  const peaks = pickPeaks(spec, options);
  const block = Math.max(1, Math.round(spec.rate / 1000)); const a = blockEnvelope(mono, block), d = blockEnvelope(mono, block, true); const env = new Float32Array(a.length);
  for (let i = 0; i < env.length; i++) env[i] = Math.max(a[i], d[i] * .7);
  const onsets: Onset[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const centre = spec.timeOf(peaks[i].frame); const prev = i > 0 ? spec.timeOf(peaks[i - 1].frame) : -1, next = i + 1 < peaks.length ? spec.timeOf(peaks[i + 1].frame) : Infinity;
    const time = refineOnset(env, block, spec.rate, centre, onsets.length ? Math.max((prev + centre) / 2, onsets[onsets.length - 1].time + .012) : 0, (centre + next) / 2);
    onsets.push({ time: Math.max(0, time), frame: peaks[i].frame, strength: peaks[i].strength });
  }
  return onsets;
}

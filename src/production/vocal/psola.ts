/**
 * TD-PSOLA pitch shifting (Phase 2) — offline render of a corrected take.
 *
 * Analysis: pitch marks exactly one tracked period apart on voiced frames; fixed 5 ms marks on unvoiced audio. Synthesis: Hann grains two periods long, taken around the nearest analysis
 * mark and overlap-added one *target* period apart. Grains keep the original spectral envelope, so formants are
 * preserved; with `formant: false` each grain is resampled by the pitch ratio so formants move with the pitch.
 * Output is normalised by the summed window, so level and timing are unchanged.
 */
import { midiToHz, type PitchTrack } from "./pitchTrack";

export function psolaShift(data: Float32Array, rate: number, track: PitchTrack, cents: Float32Array, opts: { formant?: boolean } = {}): Float32Array {
  const N = data.length; const hop = track.hop; const unvoicedStep = Math.round(rate * .005); const preserveFormant = opts.formant !== false;
  const last = track.f0.length - 1;
  const frameAt = (s: number) => Math.min(last, Math.max(0, Math.floor(s / rate / hop)));
  /** Linear interpolation between 5 ms frames (frames are centred on f·hop) — avoids up to ~9 ¢ lag on fast vibrato. */
  const lerp = (arr: Float32Array, s: number) => { const x = Math.min(last, Math.max(0, s / rate / hop)); const i = Math.floor(x), fr = x - i; const a = arr[i], b = arr[Math.min(last, i + 1)]; return b && a ? a + (b - a) * fr : a; };
  const periodAt = (s: number) => { if (!track.f0[frameAt(s)]) return 0; const m = lerp(track.f0, s); return m > 0 ? rate / midiToHz(m) : 0; };
  // 1. Analysis marks.
  const marks: number[] = [], periods: number[] = [];
  // Marks advance by the tracked period (fractional accumulation), so consecutive voiced marks are exactly one
  // period apart: grains taken from neighbouring cycles line up in phase (snapping to peaks jitters and makes subharmonics).
  for (let t = 0; t < N;) {
    const P = periodAt(Math.round(t));
    if (P > 0) { marks.push(Math.round(t)); periods.push(P); t += P; }
    else { marks.push(Math.round(t)); periods.push(0); t += unvoicedStep; }
  }
  if (!marks.length) return data.slice();
  const lerpCents = (s: number) => { const x = Math.min(last, Math.max(0, s / rate / hop)); const i = Math.floor(x), fr = x - i; return cents[i] + ((cents[Math.min(last, i + 1)] ?? cents[i]) - cents[i]) * fr; };
  // 2. Synthesis.
  const out = new Float32Array(N), wsum = new Float32Array(N); let k = 0;
  for (let tf = 0; tf < N;) {
    const ts = Math.round(tf); // fractional synthesis time: whole-sample spacing would detune by up to ~5 cents
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
    const P = periods[k]; const ratio = P > 0 ? 2 ** (lerpCents(ts) / 1200) : 1;
    const half = P > 0 ? Math.round(P) : unvoicedStep; const center = marks[k];
    const outHalf = P > 0 && !preserveFormant ? Math.max(2, Math.round(half / ratio)) : half;
    for (let j = -outHalf; j < outHalf; j++) {
      const o = ts + j; if (o < 0 || o >= N) continue;
      const w = .5 + .5 * Math.cos(Math.PI * j / outHalf);
      let x: number;
      if (outHalf === half) { const src = center + j; x = src >= 0 && src < N ? data[src] : 0; }
      else { const pos = center + j * ratio; const i0 = Math.floor(pos), fr = pos - i0; const a = data[i0] ?? 0, b = data[i0 + 1] ?? 0; x = a + (b - a) * fr; }
      out[o] += x * w; wsum[o] += w;
    }
    tf += P > 0 ? Math.max(1, P / ratio) : unvoicedStep;
  }
  for (let i = 0; i < N; i++) out[i] = wsum[i] > .05 ? out[i] / wsum[i] : out[i];
  return out;
}

/** RMS over samples above a small gate (for loudness-matching ORIGINAL vs TUNED). */
export function activeRms(data: Float32Array): number { let e = 0, n = 0; for (let i = 0; i < data.length; i++) { const v = data[i]; if (Math.abs(v) > 1e-3) { e += v * v; n++; } } return n ? Math.sqrt(e / n) : 0; }

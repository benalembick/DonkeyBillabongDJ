/**
 * Vocal pitch tracking (Phase 2): YIN f0 every 5 ms on a 16 kHz copy, voicing from clarity + level,
 * octave-error cleanup, then segmentation into sung notes with drift and vibrato measurements.
 * Pure and chunked (yields between blocks) so it runs in a Worker or on the main thread without freezing the UI.
 */

export interface PitchTrack { hop: number; f0: Float32Array; clarity: Float32Array; levelDb: Float32Array }
/** A sung note. `detected` = median pitch (fractional MIDI); `target` null = auto (nearest scale note). */
export interface VocalNote { id: string; start: number; end: number; detected: number; target: number | null; bypass: boolean; transitionMs: number | null; driftCents: number; vibrato: { rateHz: number; depthCents: number } | null }

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

const TARGET_RATE = 16_000;

/** Low-passed decimation to ~16 kHz (vocal f0 < 1.1 kHz, so this keeps YIN accurate and 3× cheaper). */
function downsample(data: Float32Array, rate: number): { data: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(rate / TARGET_RATE)); if (factor === 1) return { data, rate };
  const out = new Float32Array(Math.floor(data.length / factor)); const taps = factor * 2;
  for (let i = 0; i < out.length; i++) { let sum = 0, w = 0; const c = i * factor; for (let k = -taps; k <= taps; k++) { const j = c + k; if (j < 0 || j >= data.length) continue; const wk = 1 - Math.abs(k) / (taps + 1); sum += data[j] * wk; w += wk; } out[i] = sum / w; }
  return { data: out, rate: rate / factor };
}

/** f0 track: MIDI pitch per hop (0 = unvoiced), YIN clarity (0–1) and frame level (dBFS). */
export async function trackPitch(input: Float32Array, rate: number, opts: { hop?: number; minHz?: number; maxHz?: number; onProgress?: (p: number) => void } = {}): Promise<PitchTrack> {
  const hop = opts.hop ?? .005; const { data, rate: sr } = downsample(input, rate);
  const W = Math.round(sr * .04), maxLag = Math.min(Math.floor(sr / (opts.minHz ?? 65)), W - 2), minLag = Math.max(2, Math.floor(sr / (opts.maxHz ?? 1100)));
  const frames = Math.max(0, Math.floor((input.length / rate) / hop)); const f0 = new Float32Array(frames), clarity = new Float32Array(frames), levelDb = new Float32Array(frames);
  const d = new Float32Array(maxLag + 2), cm = new Float32Array(maxLag + 2); let peak = 0;
  for (let f = 0; f < frames; f++) {
    const c = Math.round(f * hop * sr); const from = c - (W >> 1);
    let e = 0; for (let i = 0; i < W; i++) { const x = data[from + i] ?? 0; e += x * x; } const rms = Math.sqrt(e / W); levelDb[f] = 20 * Math.log10(Math.max(1e-6, rms)); peak = Math.max(peak, rms);
    if (rms < 1e-4) { if (f % 400 === 399) { opts.onProgress?.(f / frames); await new Promise((r) => setTimeout(r, 0)); } continue; }
    for (let tau = 1; tau <= maxLag; tau++) { let s = 0; for (let i = 0; i < W - maxLag; i++) { const a = (data[from + i] ?? 0) - (data[from + i + tau] ?? 0); s += a * a; } d[tau] = s; }
    cm[0] = 1; let run = 0; for (let tau = 1; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let best = -1; for (let tau = minLag; tau <= maxLag; tau++) if (cm[tau] < .15) { while (tau + 1 <= maxLag && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
    if (best < 0) { let m = Infinity; for (let tau = minLag; tau <= maxLag; tau++) if (cm[tau] < m) { m = cm[tau]; best = tau; } }
    const a = cm[best - 1] ?? cm[best], b = cm[best], cc = cm[best + 1] ?? cm[best]; const den = a - 2 * b + cc; const shift = den ? (a - cc) / (2 * den) : 0;
    clarity[f] = Math.max(0, 1 - b); f0[f] = hzToMidi(sr / (best + (Math.abs(shift) < 1 ? shift : 0)));
    if (f % 400 === 399) { opts.onProgress?.(f / frames); await new Promise((r) => setTimeout(r, 0)); }
  }
  // Voicing: clear periodicity and within 45 dB of the loudest frame.
  const gate = Math.max(-50, 20 * Math.log10(Math.max(1e-6, peak)) - 45);
  for (let f = 0; f < frames; f++) if (clarity[f] < .6 || levelDb[f] < gate) f0[f] = 0;
  // Octave errors: fold isolated ±12 jumps back toward the local median; drop 1–2 frame voiced islands.
  const med = (i: number) => { const w: number[] = []; for (let k = i - 4; k <= i + 4; k++) if (f0[k] > 0) w.push(f0[k]); w.sort((x, y) => x - y); return w.length ? w[w.length >> 1] : 0; };
  const fixed = f0.slice(); for (let f = 0; f < frames; f++) { if (!f0[f]) continue; const m = med(f); if (m && Math.abs(f0[f] - m - 12) < 1.5) fixed[f] = f0[f] - 12; else if (m && Math.abs(f0[f] - m + 12) < 1.5) fixed[f] = f0[f] + 12; }
  for (let f = 0; f < frames; f++) if (fixed[f] && !fixed[f - 1] && !fixed[f + 1]) fixed[f] = 0;
  opts.onProgress?.(1);
  return { hop, f0: fixed, clarity, levelDb };
}

/** Linear fit (slope, intercept) of y over x. */
function fit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length; const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n; let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; } const slope = den ? num / den : 0; return { slope, intercept: my - slope * mx };
}

/**
 * Notes from voiced runs: a new note starts after an unvoiced gap (> 30 ms) or where the pitch settles more than
 * 0.75 semitone away (median over the next 100 ms, so vibrato is not split). Notes shorter than 60 ms are dropped
 * (left uncorrected).
 */
export function segmentNotes(track: PitchTrack): VocalNote[] {
  const { f0, hop } = track; const notes: VocalNote[] = []; const gapFrames = Math.round(.03 / hop), settle = Math.round(.1 / hop); // 100 ms: vibrato (±50¢ at 4–7 Hz) never reads as a new note
  let start = -1, lastVoiced = -1; const frames: number[] = [];
  const median = (idx: number[]) => { const v = idx.map((i) => f0[i]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const close = (endFrame: number) => {
    if (frames.length * hop >= .06) {
      const detected = median(frames); const xs = frames.map((i) => i * hop), ys = frames.map((i) => f0[i]); const line = fit(xs, ys);
      const residual = frames.map((_, k) => (ys[k] - (line.slope * xs[k] + line.intercept)) * 100); let crossings = 0; for (let k = 1; k < residual.length; k++) if ((residual[k - 1] < 0) !== (residual[k] < 0)) crossings++;
      const duration = frames.length * hop; const rate = crossings / 2 / duration; const depth = Math.sqrt(residual.reduce((s, r) => s + r * r, 0) / residual.length) * Math.SQRT2;
      notes.push({ id: `n${Math.round(start * hop * 1000)}`, start: start * hop, end: (endFrame + 1) * hop, detected: Math.round(detected * 1000) / 1000, target: null, bypass: false, transitionMs: null, driftCents: Math.round(line.slope * 100), vibrato: duration > .35 && rate >= 3 && rate <= 9 && depth > 15 ? { rateHz: Math.round(rate * 10) / 10, depthCents: Math.round(depth) } : null });
    }
    frames.length = 0; start = -1;
  };
  for (let f = 0; f < f0.length; f++) {
    if (!f0[f]) { if (start >= 0 && f - lastVoiced > gapFrames) close(lastVoiced); continue; }
    if (start < 0) start = f;
    if (frames.length >= settle) {
      const current = median(frames.slice(0, Math.max(settle, frames.length - settle))); const ahead: number[] = []; for (let k = f; k < f0.length && ahead.length < settle; k++) if (f0[k]) ahead.push(k);
      if (ahead.length === settle && Math.abs(median(ahead) - current) > .75 && Math.abs(f0[f] - current) > .5) { close(f - 1); start = f; }
    }
    frames.push(f); lastVoiced = f;
  }
  if (start >= 0) close(lastVoiced);
  return notes;
}

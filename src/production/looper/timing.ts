/**
 * Live Looper timing (pure, unit-tested). Times are AudioContext seconds; the transport's bar 0 starts at `origin`.
 * Phase 1 keeps every loop a whole number of bars: recording starts on a bar line and LOOP closes on the nearest
 * one, so loops of any bar count stay in phase. (Phase 2 adds configurable quantize, BPM detection, master loop.)
 */

export const barSeconds = (bpm: number, beatsPerBar: number): number => beatsPerBar * 60 / bpm;

/** First bar line at or after `t + lead` (lead = time needed to react, e.g. for scheduling). */
export function nextBar(origin: number, bar: number, t: number, lead = 0): { index: number; time: number } {
  const index = Math.max(0, Math.ceil((t + lead - origin) / bar - 1e-9)); return { index, time: origin + index * bar };
}

/** Bar position (fractional) at time t. */
export const barAt = (origin: number, bar: number, t: number): number => (t - origin) / bar;

/** LOOP pressed at `pressed` while recording from `start`: round to the nearest whole bar count (≥ 1). */
export function closeLoop(start: number, bar: number, pressed: number, maxBars = 64): { bars: number; end: number } {
  const bars = Math.max(1, Math.min(maxBars, Math.round((pressed - start) / bar))); return { bars, end: start + bars * bar };
}

/**
 * Capture samples that belong to musical time [start, start + length): a sound performed in time with what the
 * performer heard reaches the input `latency` seconds later.
 */
export function loopRegion(captureStart: number, rate: number, start: number, latency: number, length: number): { from: number; frames: number } {
  return { from: Math.round((start + latency - captureStart) * rate), frames: Math.round(length * rate) };
}

/** Copies [from, from + frames) out of `data`, zero-filling anything outside it. */
export function extract(data: Float32Array, from: number, frames: number): Float32Array {
  const out = new Float32Array(Math.max(0, frames)); const a = Math.max(0, from), b = Math.min(data.length, from + frames);
  if (b > a) out.set(data.subarray(a, b), a - from); return out;
}

/** 3 ms fade at both ends so the loop seam never clicks (the audio in between is untouched). */
export function sealLoop(data: Float32Array, rate: number, ms = 3): Float32Array {
  const out = data.slice(); const n = Math.min(Math.floor(out.length / 2), Math.round(rate * ms / 1000));
  for (let i = 0; i < n; i++) { const g = i / n; out[i] *= g; out[out.length - 1 - i] *= g; } return out;
}

/** Seconds into a loop (`bars` long, anchored at `anchorBar`) that should be heard at time t. */
export function loopPhase(t: number, origin: number, bar: number, anchorBar: number, bars: number): number {
  const length = bars * bar; const x = t - origin - anchorBar * bar; return ((x % length) + length) % length;
}

/**
 * How to start a just-closed loop so its first repeat is seamless even though the capture finishes after the loop
 * end (latency + transfer): play what was already captured (`haveSeconds` of the loop) as a provisional pass from
 * `end`, then the rest from the final audio, then the repeating loop from `end + length`. When the loop end has
 * already passed (LOOP pressed late), the repeating loop simply starts in phase.
 */
export function firstPassPlan(end: number, length: number, haveSeconds: number, now: number): { provisional: { at: number; duration: number } | null; restFrom: number; loopAt: number } {
  if (end - now > .03 && haveSeconds > .05) { const have = Math.min(length, haveSeconds); return { provisional: { at: end, duration: have }, restFrom: have, loopAt: end + length }; }
  return { provisional: null, restFrom: length, loopAt: Math.max(now + .02, end) };
}

/** Peaks for the loop thumbnail. */
export function loopPeaks(data: Float32Array, count = 240): number[] {
  const out: number[] = []; const per = Math.max(1, Math.floor(data.length / count));
  for (let i = 0; i < count; i++) { let m = 0; for (let j = i * per; j < Math.min(data.length, (i + 1) * per); j++) { const v = Math.abs(data[j]); if (v > m) m = v; } out.push(Math.round(m * 1000) / 1000); }
  return out;
}

/** Combined waveform for several equal-length peak arrays (Phase 2: the active overdub layers), clamped to 1. */
export function mixPeaks(peaksList: number[][]): number[] {
  if (!peaksList.length) return []; const len = peaksList[0].length; const out = new Array<number>(len).fill(0);
  for (const p of peaksList) for (let i = 0; i < len; i++) out[i] = Math.min(1, out[i] + (p[i] ?? 0));
  return out.map((v) => Math.round(v * 1000) / 1000);
}

/**
 * Phase 2 overdub: a dub pass can span several full loop cycles (the performer holds OVERDUB through more than
 * one repeat). Each cycle is summed into one loop-length layer, so dubbing never grows the loop's length.
 */
export function foldCycles(data: Float32Array, cycleFrames: number): Float32Array {
  const out = new Float32Array(cycleFrames);
  for (let from = 0; from < data.length; from += cycleFrames) for (let i = 0; i < cycleFrames && from + i < data.length; i++) out[i] += data[from + i];
  return out;
}

/** dBFS → linear amplitude, for comparing against raw PCM samples (threshold recording). */
export const dbToLinear = (db: number): number => 10 ** (db / 20);

/** Index of the first sample whose magnitude reaches `linear` (threshold recording's auto-start trigger), or -1. */
export function thresholdCrossing(data: Float32Array, linear: number): number {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) >= linear) return i;
  return -1;
}

/** Seconds into a loop cycle that should actually play at phase `phase` once a Manual Trim in-point is applied. */
export const trimmedOffset = (phase: number, trimIn: number, duration: number): number => trimIn ? (phase + trimIn) % duration : phase;

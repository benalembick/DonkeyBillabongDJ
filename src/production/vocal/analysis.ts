/**
 * Vocal Studio Phase 1 maths: placing a captured take on the arrangement, level analysis, and round-trip
 * latency measurement. Pure functions so they run in tests.
 */
import type { VocalTakeAnalysis } from "../types";

const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v));

/**
 * Where a capture lands on the arrangement. The arrangement position at audio-clock time t is
 * `clock.position + (t - clock.contextTime)`; a sound the singer made in time with what they heard reaches the
 * input `latency` seconds later, so captured sample i belongs at
 * `clock.position + (captureStart + i / rate - clock.contextTime) - latency`.
 * The take keeps the whole recording (`offset` = seconds of file before `from`) and plays [from, to).
 */
export function placeTake(o: { captureStart: number; clock: { contextTime: number; position: number }; latency: number; sampleRate: number; frames: number; from: number; to: number | null }): { start: number; offset: number; duration: number; sourceDuration: number } | null {
  const sourceDuration = o.frames / o.sampleRate; const firstPos = o.clock.position + (o.captureStart - o.clock.contextTime) - o.latency; const lastPos = firstPos + sourceDuration;
  const start = Math.max(o.from, firstPos, 0); const end = Math.min(o.to ?? Infinity, lastPos);
  if (end - start < .05) return null;
  return { start, offset: start - firstPos, duration: end - start, sourceDuration };
}

/** Peak / RMS / clipping / noise floor (10th percentile of 50 ms windows) / share of windows clearly above it. */
export function analyseTake(data: Float32Array, sampleRate: number): VocalTakeAnalysis {
  let peak = 0, energy = 0, clipped = 0;
  for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; energy += v * v; if (v >= .999) clipped++; }
  const win = Math.max(1, Math.round(sampleRate * .05)); const windows: number[] = [];
  for (let i = 0; i + win <= data.length; i += win) { let e = 0; for (let j = i; j < i + win; j++) e += data[j] * data[j]; windows.push(db(Math.sqrt(e / win))); }
  const sorted = [...windows].sort((a, b) => a - b); const noiseFloorDb = Math.max(-120, sorted.length ? sorted[Math.floor(sorted.length * .1)] : -120); // digital silence reads as -120
  const active = windows.filter((w) => w > noiseFloorDb + 12 && w > -60).length;
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(energy / Math.max(1, data.length))), clippedSamples: clipped, noiseFloorDb, activeRatio: windows.length ? active / windows.length : 0 };
}

/** Max-abs peaks per `per` samples (live waveform). */
export function blockPeaks(data: Float32Array, per: number): number[] {
  const out: number[] = []; for (let i = 0; i < data.length; i += per) { let m = 0; for (let j = i; j < Math.min(data.length, i + per); j++) { const v = Math.abs(data[j]); if (v > m) m = v; } out.push(m); } return out;
}

/**
 * Round-trip latency from test clicks played at known audio-clock `clickTimes` and captured from `captureStart`:
 * the first sharp onset after each click (within `window` s) is matched; the median offset is returned.
 * Null when fewer than half the clicks are heard consistently (headphones not near the mic, no loopback, or other
 * sounds during the test).
 */
export function measureClickLatency(data: Float32Array, sampleRate: number, captureStart: number, clickTimes: number[], window = .5): { latencyMs: number; matched: number; spreadMs: number } | null {
  let noise = 0; const lead = Math.min(data.length, Math.round(sampleRate * Math.max(.02, (clickTimes[0] ?? 0) - captureStart)));
  for (let i = 0; i < lead; i++) noise = Math.max(noise, Math.abs(data[i]));
  const threshold = Math.max(.02, noise * 4); const offsets: number[] = [];
  for (const click of clickTimes) {
    const from = Math.max(0, Math.round((click - captureStart) * sampleRate)), to = Math.min(data.length, from + Math.round(window * sampleRate));
    for (let i = from; i < to; i++) if (Math.abs(data[i]) > threshold) { offsets.push((i / sampleRate + captureStart - click) * 1000); break; }
  }
  if (offsets.length < Math.ceil(clickTimes.length / 2)) return null;
  // A real round trip is the same for every click; onsets that disagree are other sounds (voice, noise).
  offsets.sort((a, b) => a - b); const median = offsets[Math.floor(offsets.length / 2)]; const agree = offsets.filter((o) => Math.abs(o - median) <= 3);
  if (agree.length < Math.max(3, Math.ceil(clickTimes.length / 2))) return null;
  const mean = agree.reduce((sum, o) => sum + o, 0) / agree.length;
  return { latencyMs: mean, matched: agree.length, spreadMs: agree[agree.length - 1] - agree[0] };
}

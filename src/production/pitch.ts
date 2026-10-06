/**
 * Root (fundamental) note detection for pitched samples, for the Sampler's CHROMATIC mode.
 * YIN (de Cheveigné & Kawahara 2002) over a few windows of the sustained part of the sound;
 * the median of confident windows wins. Unpitched material (drums, noise) returns null.
 */

export interface RootDetection { note: number; frequency: number; /** 0–1, 1 = perfectly periodic. */ confidence: number }

const MIN_HZ = 30, MAX_HZ = 2000, THRESHOLD = .15;

/** YIN f0 estimate of one window, or null when it is not periodic enough. */
function yin(data: Float32Array, from: number, size: number, sampleRate: number): { hz: number; clarity: number } | null {
  const maxLag = Math.min(Math.floor(sampleRate / MIN_HZ), Math.floor(size / 2)), minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const diff = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) { let sum = 0; for (let i = 0; i < size - maxLag; i++) { const d = data[from + i] - data[from + i + lag]; sum += d * d; } diff[lag] = sum; }
  // Cumulative mean normalised difference.
  const cmnd = new Float32Array(maxLag + 1); cmnd[0] = 1; let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) { running += diff[lag]; cmnd[lag] = running > 0 ? diff[lag] * lag / running : 1; }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) if (cmnd[lag] < THRESHOLD) { while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++; best = lag; break; }
  if (best < 0) return null;
  // Parabolic interpolation around the dip.
  const a = cmnd[best - 1] ?? cmnd[best], b = cmnd[best], c = cmnd[best + 1] ?? cmnd[best]; const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return { hz: sampleRate / (best + (Math.abs(shift) < 1 ? shift : 0)), clarity: 1 - b };
}

export function frequencyToMidi(hz: number): number { return 69 + 12 * Math.log2(hz / 440); }

/** Detects the root note of [start, end] (seconds) of mono `data`, skipping the attack. */
export function detectRootNote(data: Float32Array, sampleRate: number, start = 0, end = data.length / sampleRate): RootDetection | null {
  const size = 2 ** Math.ceil(Math.log2(sampleRate / MIN_HZ * 2.2)); // ~2 periods of the lowest note
  const from = Math.floor(start * sampleRate), to = Math.min(data.length, Math.floor(end * sampleRate));
  const skip = Math.floor(sampleRate * .03); const usable = to - from - skip;
  if (usable < size) return null;
  const windows = Math.min(8, Math.max(1, Math.floor(usable / (size / 2)) - 1)); const estimates: { hz: number; clarity: number }[] = [];
  for (let w = 0; w < windows; w++) {
    const at = from + skip + Math.floor((usable - size) * (windows === 1 ? 0 : w / (windows - 1)));
    let energy = 0; for (let i = at; i < at + size; i++) energy += data[i] * data[i];
    if (Math.sqrt(energy / size) < .003) continue; // silence
    const estimate = yin(data, at, size, sampleRate); if (estimate) estimates.push(estimate);
  }
  if (estimates.length < Math.max(1, Math.ceil(windows / 2))) return null;
  estimates.sort((a, b) => a.hz - b.hz); const median = estimates[Math.floor(estimates.length / 2)];
  const agreeing = estimates.filter((e) => Math.abs(frequencyToMidi(e.hz) - frequencyToMidi(median.hz)) < .5);
  const confidence = agreeing.length / windows * agreeing.reduce((sum, e) => sum + e.clarity, 0) / agreeing.length;
  if (confidence < .5) return null;
  return { note: Math.round(frequencyToMidi(median.hz)), frequency: median.hz, confidence };
}

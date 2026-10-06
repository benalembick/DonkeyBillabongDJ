/**
 * Sampler Phase 2 analysis: transient detection, slice marker generation, zero-crossing snapping
 * and the conservative Auto Clean analysis. Pure functions over mono PCM so they run in tests.
 */

export interface Transient { /** Source time in seconds. */ time: number; /** 0–1, relative to the strongest attack in the source. */ strength: number }
export interface SliceRegion { index: number; start: number; end: number }
export interface CleanReport {
  start: number; end: number;
  leadingSilence: number; trailingSilence: number;
  fadeIn: number; fadeOut: number;
  peakDb: number; rmsDb: number; clippedSamples: number;
}

const db = (value: number): number => 20 * Math.log10(Math.max(1e-9, value));

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const data of channels) for (let i = 0; i < out.length; i++) out[i] += data[i] / channels.length;
  return out;
}

/**
 * Onset detection on 5 ms frames: the rise in log energy of the full band (kicks, chords, vocals)
 * and of the first difference (snares, hats, clicks) against the preceding frames. Local maxima
 * are refined to the start of the attack and snapped back to a zero crossing.
 */
export function detectTransients(data: Float32Array, sampleRate: number): Transient[] {
  const hop = Math.max(1, Math.round(sampleRate * .005)); const win = hop * 2; const frames = Math.max(0, Math.floor((data.length - win) / hop) + 1);
  if (frames < 3) return [];
  const full = new Float32Array(frames), high = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0, h = 0; const from = f * hop;
    for (let i = from; i < from + win; i++) { const x = data[i]; e += x * x; const d = x - (i > 0 ? data[i - 1] : 0); h += d * d; }
    full[f] = 10 * Math.log10(1e-10 + e / win); high[f] = 10 * Math.log10(1e-10 + h / win);
  }
  // Onset strength: dB rise over the loudest of the previous three frames (ignores slow swells). Audio before the
  // start counts as silence so a sound starting at 0 is an attack; frames 40 dB under the loudest one (tails,
  // encoder padding) or below -55 dBFS are ignored.
  const onset = new Float32Array(frames); const gate = Math.max(-55, Math.max(...full) - 40);
  for (let f = 0; f < frames; f++) {
    if (full[f] < gate) continue;
    let prevFull = gate, prevHigh = gate;
    for (let k = Math.max(0, f - 3); k < f; k++) { prevFull = Math.max(prevFull, full[k]); prevHigh = Math.max(prevHigh, high[k]); }
    onset[f] = Math.max(0, full[f] - prevFull) * .5 + Math.max(0, high[f] - prevHigh) * .5;
  }
  const radius = 6; const minGapFrames = Math.round(.04 / .005); const floor = 1.5;
  const peaks: { frame: number; value: number }[] = [];
  for (let f = 0; f < frames; f++) {
    const v = onset[f]; if (v < floor) continue;
    let isMax = true; for (let k = Math.max(0, f - radius); k <= Math.min(frames - 1, f + radius) && isMax; k++) if (onset[k] > v || (onset[k] === v && k < f)) isMax = false;
    if (!isMax) continue;
    const last = peaks[peaks.length - 1];
    if (last && f - last.frame < minGapFrames) { if (v > last.value) peaks[peaks.length - 1] = { frame: f, value: v }; continue; }
    peaks.push({ frame: f, value: v });
  }
  const strongest = Math.max(1e-9, ...peaks.map((p) => p.value));
  return peaks.map(({ frame, value }) => ({ time: attackStart(data, sampleRate, frame, hop, win) / sampleRate, strength: Math.min(1, value / strongest) }));
}

/** First sample whose level clearly rises above the preceding level, backed off 1 ms and snapped to a zero crossing. */
function attackStart(data: Float32Array, sampleRate: number, frame: number, hop: number, win: number): number {
  const from = Math.max(0, (frame - 2) * hop), to = Math.min(data.length, frame * hop + win);
  let before = 0; for (let i = Math.max(0, from - win); i < from; i++) before = Math.max(before, Math.abs(data[i]));
  let peak = 0; for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
  const threshold = before + (peak - before) * .3; let at = from;
  for (let i = from; i < to; i++) if (Math.abs(data[i]) > threshold) { at = i; break; }
  at = Math.max(0, at - Math.round(sampleRate * .001));
  return zeroCrossingBefore(data, at, Math.round(sampleRate * .003));
}

function zeroCrossingBefore(data: Float32Array, index: number, maxSearch: number): number {
  for (let i = index; i > Math.max(0, index - maxSearch); i--) if (data[i] === 0 || Math.sign(data[i]) !== Math.sign(data[i - 1])) return i;
  return index;
}

/** Nearest zero crossing to `time` within `maxMs` (either side); `time` unchanged when there is none. */
export function nearestZeroCrossing(data: Float32Array, sampleRate: number, time: number, maxMs = 3): number {
  const center = Math.round(time * sampleRate); const max = Math.round(sampleRate * maxMs / 1000);
  for (let d = 0; d <= max; d++) for (const i of [center - d, center + d]) {
    if (i <= 0 || i >= data.length) continue;
    if (data[i] === 0 || Math.sign(data[i]) !== Math.sign(data[i - 1])) return i / sampleRate;
  }
  return time;
}

/** Transients at or above the sensitivity cut (sensitivity 1 keeps every detected attack). */
export function transientMarkers(detected: Transient[], sensitivity: number, start: number, end: number): number[] {
  const cut = Math.max(0, Math.min(1, 1 - sensitivity)) ** 1.5;
  return detected.filter((t) => t.strength >= cut && t.time > start + .01 && t.time < end - .01).map((t) => t.time);
}

/** Markers every `beats` beats from the region start (the start is treated as the downbeat). */
export function beatMarkers(start: number, end: number, bpm: number, beats: number): number[] {
  const step = beats * 60 / Math.max(1, bpm); const out: number[] = [];
  for (let t = start + step; t < end - .01 && out.length < 1024; t += step) out.push(t);
  return out;
}

export function equalMarkers(start: number, end: number, count: number): number[] {
  const n = Math.max(1, Math.round(count)); return Array.from({ length: n - 1 }, (_, i) => start + (end - start) * (i + 1) / n);
}

/** Slices between the region bounds and the markers inside it. */
export function sliceRegions(start: number, end: number, markers: number[]): SliceRegion[] {
  const cuts = [...new Set(markers.filter((m) => m > start + .001 && m < end - .001))].sort((a, b) => a - b);
  const bounds = [start, ...cuts, end];
  return bounds.slice(0, -1).map((s, index) => ({ index, start: s, end: bounds[index + 1] }));
}

/**
 * Conservative clean-up of the region [start, end]: trims leading/trailing silence below -60 dBFS
 * (keeping 2 ms of headroom), snaps both edges to zero crossings and suggests 2–3 ms anti-click fades.
 * Level is only measured (peak, RMS, clipping), never changed.
 */
export function analyseClean(data: Float32Array, sampleRate: number, start: number, end: number): CleanReport {
  const from = Math.max(0, Math.floor(start * sampleRate)), to = Math.min(data.length, Math.ceil(end * sampleRate)); const silence = 10 ** (-60 / 20);
  let first = from, last = to - 1;
  while (first < to && Math.abs(data[first]) < silence) first++;
  while (last > first && Math.abs(data[last]) < silence) last--;
  if (first >= to) return { start, end, leadingSilence: 0, trailingSilence: 0, fadeIn: 0, fadeOut: 0, peakDb: -Infinity, rmsDb: -Infinity, clippedSamples: 0 };
  const pad = Math.round(sampleRate * .002);
  const cleanStart = nearestZeroCrossing(data, sampleRate, Math.max(from, first - pad) / sampleRate, 2);
  const cleanEnd = nearestZeroCrossing(data, sampleRate, Math.min(to, last + pad + 1) / sampleRate, 2);
  let peak = 0, energy = 0, clipped = 0;
  for (let i = from; i < to; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; energy += v * v; if (v >= .999) clipped++; }
  const length = Math.max(.001, cleanEnd - cleanStart);
  return {
    start: Math.max(start, cleanStart), end: Math.min(end, Math.max(cleanStart + .001, cleanEnd)),
    leadingSilence: Math.max(0, cleanStart - start), trailingSilence: Math.max(0, end - cleanEnd),
    fadeIn: Math.min(.002, length / 8), fadeOut: Math.min(.003, length / 8),
    peakDb: db(peak), rmsDb: db(Math.sqrt(energy / Math.max(1, to - from))), clippedSamples: clipped,
  };
}

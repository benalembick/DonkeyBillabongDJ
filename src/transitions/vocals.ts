/**
 * Vocal activity for transition planning, from separated STEMS (the only real vocal data the
 * app has): regions [start, end] in seconds where the vocal stem is clearly audible.
 */

/** Short gaps between phrases (breaths) are bridged; blips are dropped. */
const MERGE_GAP_S = 0.8;
const MIN_REGION_S = 0.6;

/** Regions where an envelope (one value per `hop` seconds) is above a level relative to its loud parts. */
export function regionsFromEnvelope(env: ArrayLike<number>, hop: number): [number, number][] {
  const values = Array.from(env);
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  if (p95 <= 1e-4) return []; // no vocal at all (instrumental)
  const threshold = Math.max(p95 * 0.18, 0.01);
  const raw: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const on = i < values.length && values[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      raw.push([start * hop, i * hop]);
      start = -1;
    }
  }
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < MERGE_GAP_S) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([s, e]) => e - s >= MIN_REGION_S).map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]);
}

/** Vocal RMS every 0.1 s from cached STEMS PCM (Int16 interleaved [vL vR dL dR bL bR]). */
export function vocalEnvelopeFromStems(pcm: Int16Array, rate: number, hop = 0.1): Float32Array {
  const frames = Math.floor(pcm.length / 6);
  const per = Math.max(1, Math.round(rate * hop));
  const out = new Float32Array(Math.ceil(frames / per));
  for (let w = 0; w < out.length; w++) {
    let sum = 0;
    const end = Math.min(frames, (w + 1) * per);
    for (let f = w * per; f < end; f++) {
      const v = (pcm[f * 6] + pcm[f * 6 + 1]) / 65536; // mid of the vocal stem, −1..1
      sum += v * v;
    }
    out[w] = Math.sqrt(sum / Math.max(1, end - w * per));
  }
  return out;
}

/**
 * Master clipping protection for the summed four-channel mix.
 *
 * A zero-latency soft clipper (WaveShaper): exactly linear (bit-transparent within float precision)
 * up to CLIP_KNEE (≈ -1 dBFS), then a tanh knee that approaches — never exceeds — full scale. Four decks
 * at unity can sum to about +12 dBFS; instead of hard digital clipping at the output, peaks above
 * -1 dBFS are rounded off. It never changes the level of a mix that stays below -1 dBFS, and it never
 * turns channels down: gain staging stays with the DJ (meters still show the pre-protection peak).
 *
 * The WaveShaper's input range is ±1, so the signal is scaled by 1/CLIP_RANGE going in and by
 * CLIP_RANGE coming out; the curve covers ±CLIP_RANGE (±4 = +12 dBFS) of real signal.
 */
export const CLIP_RANGE = 4;
/** Linear up to here (linear gain; 0.891 ≈ -1 dBFS). */
export const CLIP_KNEE = 0.891;

/** Odd length so 0 maps exactly onto a curve point. */
export function clipGuardCurve(points = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * CLIP_RANGE;
    c[i] = clipGuardSample(x) / CLIP_RANGE;
  }
  return c;
}

/** The transfer function on real signal values (also used by tests). */
export function clipGuardSample(x: number): number {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const y = CLIP_KNEE + (1 - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) / (1 - CLIP_KNEE));
  return Math.sign(x) * y;
}

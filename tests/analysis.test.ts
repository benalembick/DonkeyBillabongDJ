import { describe, expect, it } from "vitest";
import { analyzeTrack } from "../src/analysis/analyzeTrack";

/** Synthetic 4/4 track: kick on every beat, hi-hat on off-beats, a little noise. */
function synth(bpm: number, offsetS: number, seconds: number, sr = 22050): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const beat = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let t = offsetS; t < seconds; t += beat) {
    const s = Math.round(t * sr);
    for (let k = 0; k < sr * 0.12 && s + k < out.length; k++) {
      out[s + k] += Math.sin((2 * Math.PI * 55 * k) / sr) * Math.exp(-k / (sr * 0.04)) * 0.9; // kick
    }
    const h = Math.round((t + beat / 2) * sr);
    for (let k = 0; k < sr * 0.03 && h + k < out.length; k++) out[h + k] += rnd() * 0.25 * Math.exp(-k / (sr * 0.006)); // hat
  }
  return out;
}

describe("track analysis", () => {
  it("produces 3-band waveform data at the frame rate", () => {
    const sr = 22050;
    const a = analyzeTrack([synth(128, 0.25, 20, sr)], sr, 400);
    expect(a.low.length).toBe(Math.ceil(20 * a.fps));
    expect(Math.max(...a.low)).toBeGreaterThan(Math.max(...a.high)); // kick-heavy
    expect(a.peaks.length).toBe(400);
  });

  for (const [bpm, offset] of [
    [128, 0.25],
    [174, 0.1],
    [96, 0.4],
  ] as const) {
    it(`detects ${bpm} BPM and the beat phase`, () => {
      const sr = 22050;
      const a = analyzeTrack([synth(bpm, offset, 40, sr)], sr, 200);
      expect(a.bpm).not.toBeNull();
      expect(Math.abs(a.bpm! - bpm)).toBeLessThan(0.3);
      const period = 60 / bpm;
      const phaseErr = Math.min(Math.abs(a.firstBeat! - offset), period - Math.abs(a.firstBeat! - offset));
      expect(phaseErr).toBeLessThan(0.03);
    });
  }

  it("uses a metadata BPM when the audio agrees (octave-aware)", () => {
    const sr = 22050;
    const a = analyzeTrack([synth(128, 0.2, 30, sr)], sr, 100, 64);
    expect(a.bpm).toBeCloseTo(128, 0);
  });
});

import { describe, expect, it } from "vitest";
import { deinterleaveStem, stemClipPlacement, stemFrames, stemTrackName, STEM_PARTS } from "../src/production/stemTracks";

const FRAMES = 64;
/** Cached STEM PCM: Int16 interleaved [vL vR dL dR bL bR], each channel a distinct ramp. */
function cachedPcm(frames = FRAMES): Int16Array {
  const raw = new Int16Array(frames * 6);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 6; c++) raw[i * 6 + c] = (c + 1) * 400 + i * (c % 2 ? -7 : 5);
  return raw;
}
const original = () => ({ left: Float32Array.from({ length: FRAMES }, (_, i) => Math.sin(i / 5) * 0.8), right: Float32Array.from({ length: FRAMES }, (_, i) => Math.cos(i / 7) * 0.8) });

describe("stem de-interleaving", () => {
  it("takes each stem from its own channel pair, scaled to float", () => {
    const raw = cachedPcm();
    for (const [part, c] of [["vocals", 0], ["drums", 2], ["bass", 4]] as const) {
      const s = deinterleaveStem(raw, FRAMES, part);
      for (const i of [0, 17, FRAMES - 1]) {
        expect(s.left[i]).toBeCloseTo(raw[i * 6 + c] / 32768, 9);
        expect(s.right[i]).toBeCloseTo(raw[i * 6 + c + 1] / 32768, 9);
      }
    }
  });

  it("derives instruments as the original minus vocals, drums and bass, so all four sum back to the original", () => {
    const raw = cachedPcm(); const o = original();
    const [v, d, b, inst] = STEM_PARTS.map(({ part }) => deinterleaveStem(raw, FRAMES, part, o));
    for (let i = 0; i < FRAMES; i++) {
      expect(v.left[i] + d.left[i] + b.left[i] + inst.left[i]).toBeCloseTo(o.left[i], 5);
      expect(v.right[i] + d.right[i] + b.right[i] + inst.right[i]).toBeCloseTo(o.right[i], 5);
    }
  });

  it("needs the original for instruments", () => {
    expect(() => deinterleaveStem(cachedPcm(), FRAMES, "instruments")).toThrow(/original/);
  });

  it("never reads past the PCM the cache actually holds", () => {
    expect(stemFrames(cachedPcm(10), 50)).toBe(10);
    expect(stemFrames(cachedPcm(10), 8)).toBe(8);
  });
});

describe("stem track placement", () => {
  it("puts every stem exactly where the source clip is (phase-aligned), including a trimmed clip", () => {
    const source = { start: 12.5, offset: 3.25, duration: 40, gain: 0.8 };
    const placements = STEM_PARTS.map(() => stemClipPlacement(source, 180));
    for (const p of placements) expect(p).toEqual({ start: 12.5, offset: 3.25, duration: 40, gain: 0.8 });
  });

  it("clamps length to the stem's own audio", () => {
    expect(stemClipPlacement({ start: 0, offset: 10, duration: 200, gain: 1 }, 100).duration).toBeCloseTo(90);
  });

  it("names tracks after the song, then the stem", () => {
    expect(STEM_PARTS.map(({ part }) => stemTrackName("Song Name", part))).toEqual(["Song Name - Vocals", "Song Name - Drums", "Song Name - Bass", "Song Name - Instruments"]);
  });
});

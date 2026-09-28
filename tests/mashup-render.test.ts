import { describe, expect, it } from "vitest";
import { mashupDuration } from "../src/mashup/renderMath";

describe("mashup offline render duration", () => {
  it("renders through the longest remaining tempo-matched source", () => {
    const duration = mashupDuration(120,
      { sampleRate: 100, sampleCount: 30_000, bpm: 120, entry: 15 },
      { sampleRate: 100, sampleCount: 24_000, bpm: 100, entry: 0 },
    );
    expect(duration).toBe(285);
  });

  it("accounts for a faster tempo-match playback rate", () => {
    expect(mashupDuration(128, { sampleRate: 48_000, sampleCount: 48_000 * 256, bpm: 120, entry: 0 })).toBeCloseTo(240);
  });
});

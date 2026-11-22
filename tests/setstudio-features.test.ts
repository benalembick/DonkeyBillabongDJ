import { describe, expect, it } from "vitest";
import { computeSetFeatures, intelStale, moodRules, onsetFeatures, registerExtractor, SET_FEATURES_VERSION, splitGenre, SET_FEATURES_ALGORITHM } from "../src/setstudio/features";
import { synth } from "./setstudio-helpers";

describe("set features: energy", () => {
  it("does not equate loudness with energy: a loud sustained pad scores below a quieter busy percussive track", () => {
    const pad = computeSetFeatures(synth({ pad: 0.8 }), { duration: 120 }, 1);
    const groove = computeSetFeatures(synth({ kickEvery: 0.5, hatEvery: 0.125, kick: 0.35, hat: 0.12 }), { duration: 120 }, 1);
    expect(pad.loudnessDb!).toBeGreaterThan(groove.loudnessDb!); // the pad really is louder
    expect(groove.energy!).toBeGreaterThan(pad.energy! + 0.5);
    expect(pad.energy!).toBeLessThan(4); // no beat: low energy however loud
    expect(groove.onsetDensity!).toBeGreaterThan(4);
    expect(pad.onsetDensity!).toBeLessThan(0.5);
    for (const e of [pad.energy!, groove.energy!]) { expect(e).toBeGreaterThanOrEqual(1); expect(e).toBeLessThanOrEqual(10); }
  });

  it("refuses to score a silent/corrupt cached analysis instead of inventing a low energy", () => {
    const f = computeSetFeatures(synth({ floor: 0.0005, high: 0.0002 }), { duration: 120 }, 1);
    expect(f.energy).toBeNull();
    expect(f.unsupported.energy).toMatch(/corrupt/);
  });

  it("is deterministic and versioned", () => {
    const a = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 42, 1000), b = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 42, 1000);
    expect(a).toEqual(b);
    expect(a.version).toBe(SET_FEATURES_VERSION);
    expect(a.algorithm).toBe(SET_FEATURES_ALGORITHM);
    expect(a.derivedFrom).toBe(42);
  });

  it("redistributes the tempo weight when BPM is unknown instead of guessing", () => {
    const f = computeSetFeatures(synth({ kickEvery: 0.5, bpm: null }), { duration: 120 }, 1);
    expect(f.energy).not.toBeNull();
    expect(f.unsupported.tempo).toMatch(/unknown/i);
  });

  it("marks fields unsupported rather than fabricating them", () => {
    const f = computeSetFeatures(synth({ seconds: 4 }), { duration: 4 }, 1);
    expect(f.energy).toBeNull();
    expect(f.moods).toEqual([]);
    expect(f.unsupported.energy).toBeTruthy();
    const g = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 1);
    expect(g.vocalPresence).toBeNull();
    expect(g.vocalSource).toBeNull();
    expect(g.unsupported.vocalPresence).toMatch(/STEMS/);
    expect(g.unsupported.genre).toBeTruthy();
    const h = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120, vocalPresence: 0.4, genreTag: "House / Deep House" }, 1);
    expect(h.vocalPresence).toBe(0.4);
    expect(h.vocalSource).toBe("stems");
    expect(h.genre).toBe("House");
    expect(h.subgenre).toBe("Deep House");
  });

  it("reads structure markers from the existing sections", () => {
    const f = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 1);
    expect(f.introSec).toBe(16);
    expect(f.dropSec).toBe(32);
    expect(f.breakdownSec).toBeNull();
    expect(f.unsupported.breakdownSec).toBeTruthy();
  });
});

describe("set features: helpers", () => {
  it("counts onsets in a pulse train", () => {
    const fps = 150, env = new Float32Array(fps * 10);
    for (let i = 0; i < env.length; i++) env[i] = 0.02 + 0.5 * Math.exp(-((i / fps) % 0.25) / 0.03);
    expect(onsetFeatures(env, fps).density).toBeCloseTo(4, 0);
  });
  it("derives moods by explicit rules", () => {
    expect(moodRules({ energy: 7, brightness: 0.2, bassIntensity: 0.7, percussive: 0.7, density: 0.6, variation: 0.1, danceability: 0.7 }, "Am")).toEqual(expect.arrayContaining(["dark", "driving", "hypnotic", "groovy"]));
    expect(moodRules({ energy: 8.5, brightness: 0.85, bassIntensity: 0.3, percussive: 0.8, density: 0.6, variation: 0.3, danceability: 0.5 }, "C")).toEqual(expect.arrayContaining(["bright", "uplifting", "euphoric", "aggressive"]));
    expect(moodRules({ energy: 3, brightness: 0.4, bassIntensity: 0.3, percussive: 0.1, density: 0.1, variation: 0.4, danceability: 0.2 }, null)).toEqual(["chill"]);
  });
  it("splits genre tags", () => {
    expect(splitGenre("Electronic; Nu-Disco")).toEqual({ genre: "Electronic", subgenre: "Nu-Disco" });
    expect(splitGenre("Techno")).toEqual({ genre: "Techno", subgenre: null });
    expect(splitGenre(undefined)).toEqual({ genre: null, subgenre: null });
  });
  it("detects stale intel by analysis time and version", () => {
    const f = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 5);
    expect(intelStale(f, 5)).toBe(false);
    expect(intelStale(f, 6)).toBe(true);
    expect(intelStale({ ...f, version: 0 }, 5)).toBe(true);
    expect(intelStale(undefined, 5)).toBe(true);
  });
  it("merges pluggable extractors and clears their unsupported flags", () => {
    const off = registerExtractor({ id: "test-genre", version: 1, fields: ["genre"], run: () => ({ genre: "Detected" }) });
    try {
      const f = computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 1);
      expect(f.genre).toBe("Detected");
      expect(f.unsupported.genre).toBeUndefined();
    } finally { off(); }
    expect(computeSetFeatures(synth({ kickEvery: 0.5 }), { duration: 120 }, 1).genre).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { camelotKey, compatibility, recommendSequence } from "../src/analysis/discovery";
import type { TrackInfo } from "../src/core/engine/types";
import type { TrackPreparation } from "../src/preparation/types";

const track = (ref: string, key: string, bpm: number, energy: number, genre = "House"): TrackInfo => ({ ref, title: ref, artist: "DJ", album: "", source: "local", key, bpm, energy, genre });
const prep = (t: TrackInfo): TrackPreparation => ({ schemaVersion: 1, trackId: t.ref, refs: [t.ref], fileSize: 1, title: t.title, artist: t.artist, album: "", isrc: null,
  duration: 240, bpm: t.bpm, key: t.key, keyConfidence: .8, energy: t.energy ?? null, energyConfidence: .8, sections: [], gain: null, analysisVersion: 1, analysedAt: 1, updatedAt: 1,
  beatGrid: null, cuePoint: 0, cues: [], savedLoops: [], lastLoop: null, recommendedCues: [{ kind: "mix-in", timestamp: 16, confidence: .8, label: "Mix In" }, { kind: "mix-out", timestamp: 210, confidence: .8, label: "Mix Out" }] });

describe("music discovery", () => {
  it("maps standard keys and recognises Camelot neighbours", () => {
    expect(camelotKey("A minor")).toBe("8A");
    const a = track("a", "Am", 126, 7), b = track("b", "Em", 127, 8);
    const m = compatibility(a, b, prep(a), prep(b));
    expect(m.score).toBeGreaterThan(80);
    expect(m.reasons.some((r) => r.includes("adjacent Camelot"))).toBe(true);
    expect(m.mixIn).toBe(16);
  });

  it("orders a DJMix as a compatibility chain", () => {
    const a = track("a", "Am", 126, 6), close = track("close", "Am", 127, 7), far = track("far", "C#", 150, 2, "Classical");
    const records = new Map([a, close, far].map((t) => [t.ref, prep(t)]));
    expect(recommendSequence(a, [far, close], (t) => records.get(t.ref))[0].track.ref).toBe("close");
  });
});

import { describe, expect, it } from "vitest";
import { PreparationStore } from "../src/preparation/PreparationStore";
import type { PreparationPersistence, TrackPreparation } from "../src/preparation/types";
import type { TrackAnalysis, RecommendedCue } from "../src/analysis/analyzeTrack";
import type { TrackInfo } from "../src/core/engine/types";

function memoryPersistence(): PreparationPersistence {
  const rows = new Map<string, TrackPreparation>();
  return {
    list: async () => [...rows.values()],
    save: async (r) => { rows.set(r.trackId, r); },
    loadWaveform: async () => null,
    saveWaveform: async () => {},
  };
}

const track: TrackInfo = { ref: "song.mp3", title: "Song", artist: "", album: "", source: "local", bpm: null, key: null };

function analysis(suggestions: RecommendedCue[]): TrackAnalysis {
  return {
    peaks: new Float32Array(0), rms: new Float32Array(0), low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0),
    fps: 150, bpm: 128, firstBeat: 0, confidence: 1, bpmSource: "analysis",
    key: null, keyConfidence: 0, energy: 5, energyConfidence: 0.5, gainDb: null, peak: 0,
    sections: [], recommendedCues: [], hotCueSuggestions: suggestions,
  };
}

const suggestion = (_slot: number, label: string, timestamp: number): RecommendedCue => ({ kind: "drop", label, timestamp, confidence: 0.75 });

describe("re-suggesting hot cues", () => {
  it("populates empty hot cues from the first analysis, same as before", async () => {
    const store = new PreparationStore(memoryPersistence());
    await store.ready;
    const prep = await store.identify(track, new Uint8Array([1]).buffer, 300);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "Intro 1", 0), suggestion(1, "Drop 1", 45)]), 300, track);
    const r = store.get(prep.trackId)!;
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ slot: 0, name: "Intro 1", timestamp: 0, source: "analysis" });
  });

  it("without resuggest, never touches hot cues that already exist", async () => {
    const store = new PreparationStore(memoryPersistence());
    await store.ready;
    const prep = await store.identify(track, new Uint8Array([1]).buffer, 300);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "Intro 1", 0)]), 300, track);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "Totally Different", 99)]), 300, track); // not resuggest
    const r = store.get(prep.trackId)!;
    expect(r.cues[0].name).toBe("Intro 1");
  });

  it("with resuggest, replaces stale auto-suggested cues with fresh ones", async () => {
    const store = new PreparationStore(memoryPersistence());
    await store.ready;
    const prep = await store.identify(track, new Uint8Array([1]).buffer, 300);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "Old Intro 1", 0), suggestion(1, "Old Drop 1", 45)]), 300, track);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "New Intro 1", 0), suggestion(1, "New Drop 1", 50)]), 300, track, true);
    const r = store.get(prep.trackId)!;
    expect(r.cues.map((c) => c.name)).toEqual(["New Intro 1", "New Drop 1"]);
  });

  it("with resuggest, never overwrites a hot cue the user placed or edited by hand", async () => {
    const store = new PreparationStore(memoryPersistence());
    await store.ready;
    const prep = await store.identify(track, new Uint8Array([1]).buffer, 300);
    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "Old Intro 1", 0), suggestion(1, "Old Drop 1", 45)]), 300, track);
    // The user renames/moves slot 1 by hand (no `source`, as DJEngine's editHotcue/onHotcue set it).
    const r1 = store.get(prep.trackId)!;
    const handEdited = r1.cues.map((c) => (c.slot === 1 ? { ...c, name: "My Drop", timestamp: 46, source: undefined } : c));
    await store["commit"]({ ...r1, cues: handEdited });

    await store.saveAnalysis(prep.trackId, analysis([suggestion(0, "New Intro 1", 0), suggestion(1, "New Drop 1", 50)]), 300, track, true);
    const r2 = store.get(prep.trackId)!;
    const slot1 = r2.cues.find((c) => c.slot === 1)!;
    expect(slot1.name).toBe("My Drop"); // kept, not overwritten
    const slot0 = r2.cues.find((c) => c.slot === 0)!;
    expect(slot0.name).toBe("New Intro 1"); // this one was still auto-suggested, so it refreshed
  });
});

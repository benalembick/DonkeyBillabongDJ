/**
 * Live playback first (docs/architecture/four-deck-performance-engine.md §15): background library analysis
 * waits while enough decks play; an explicit "Analyse selected" runs straight away.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisService } from "../src/analysis/AnalysisService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { AudioEngine, TrackInfo } from "../src/core/engine/types";
import type { PreparationStore } from "../src/preparation/PreparationStore";

const track = (ref: string): TrackInfo => ({ ref, title: ref, artist: "", album: "", source: "local", bpm: null, key: null });

function setup(deferred: { reason: string | null }) {
  const read: string[] = [];
  const engine = { on: () => () => {}, getState: () => ({ decks: [] }) } as unknown as DJEngine;
  // Every track is "already analysed" (cached), so the batch only reads and identifies it.
  const preparation = { identify: async (t: TrackInfo) => ({ trackId: t.ref }), waveform: async () => ({ gridFitVersion: 99 }) } as unknown as PreparationStore;
  const service = new AnalysisService(engine, {
    preparation,
    audio: {} as AudioEngine,
    readAudio: async (ref) => { read.push(ref); return new ArrayBuffer(16); },
    onError: () => {},
    storage: null,
    deferWhile: () => deferred.reason,
  });
  return { service, read };
}

afterEach(() => vi.useRealTimers());

describe("background analysis deferral", () => {
  it("a background batch waits while decks play, then resumes", async () => {
    vi.useFakeTimers();
    const gate = { reason: "4 decks playing" as string | null };
    const { service, read } = setup(gate);
    const done = service.analyseTracks([track("a"), track("b")], false, false, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toEqual([]);
    expect(service.getState().deferred).toBe("4 decks playing");
    gate.reason = null;
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(read).toEqual(["a", "b"]);
    expect(service.getState().deferred).toBeNull();
  });

  it("an explicit analysis runs straight away even while decks play", async () => {
    const { service, read } = setup({ reason: "4 decks playing" });
    await service.analyseTracks([track("x")]);
    expect(read).toEqual(["x"]);
  });

  it("cancelling a deferred batch stops it without analysing anything", async () => {
    vi.useFakeTimers();
    const { service, read } = setup({ reason: "3 decks playing" });
    const done = service.analyseTracks([track("a")], false, false, true);
    await vi.advanceTimersByTimeAsync(1500);
    service.cancelBatch();
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(read).toEqual([]);
  });
});

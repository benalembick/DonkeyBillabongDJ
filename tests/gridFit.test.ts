import { afterEach, describe, expect, it } from "vitest";
import { checkGrid, fitGrid, gridEnvelope, gridTrusted, GRID_FIT_VERSION } from "../src/analysis/gridFit";
import { refineBeats } from "../src/analysis/analyzeTrack";
import { AnalysisService } from "../src/analysis/AnalysisService";
import type { AudioEngine } from "../src/core/engine/types";
import type { DJEngine } from "../src/core/engine/DJEngine";
import { PreparationStore } from "../src/preparation/PreparationStore";
import { packWaveform, type PreparationPersistence, type TrackPreparation, type WaveformRecord } from "../src/preparation/types";
import { GRID_CONFIDENT } from "../src/preparation/beatGrid";
import { synth } from "./setstudio-helpers";

const FPS = 150;

/** Deterministic noise. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

/**
 * Cached-style analysis bands (peaks per frame at 150 fps) for a constant-tempo track: a kick on every
 * beat, optionally an off-beat bassline and 16th-note hats, over a noise floor.
 */
function bands(o: { seconds?: number; bpm: number; first: number; offbeatBass?: number; hats?: number; noise?: number; beats?: boolean }) {
  const n = Math.round((o.seconds ?? 240) * FPS), low = new Float32Array(n), mid = new Float32Array(n), r = rng(7);
  for (let i = 0; i < n; i++) { low[i] = 0.02 + (o.noise ?? 0.03) * r(); mid[i] = 0.02 + (o.noise ?? 0.03) * r(); }
  const hit = (arr: Float32Array, t: number, amp: number, decay: number) => {
    const f = Math.round(t * FPS);
    for (let j = 0; j < 24 && f + j < n; j++) if (f + j >= 0) arr[f + j] = Math.max(arr[f + j], amp * Math.exp(-j / decay));
  };
  if (o.beats === false) return { low, mid };
  const T = 60 / o.bpm;
  for (let t = o.first; t < n / FPS; t += T) {
    hit(low, t, 0.9 + 0.1 * r(), 4);
    if (o.offbeatBass) hit(low, t + T / 2, o.offbeatBass, 8);
    if (o.hats) for (let q = 0; q < 4; q++) hit(mid, t + (q * T) / 4, o.hats, 2);
  }
  return { low, mid };
}

/** Signed difference between two beat phases (s), wrapped to ±½ beat. */
const phaseErr = (a: number, b: number, bpm: number) => { const T = 60 / bpm; return ((((a - b) % T) + 1.5 * T) % T) - T / 2; };

describe("whole-track grid fit", () => {
  it("trusts a correct grid and keeps it in place", () => {
    const { low, mid } = bands({ bpm: 128, first: 0.31, offbeatBass: 0.5, hats: 0.3 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 128, 0.31)!;
    expect(f.bpm).toBe(128);
    expect(Math.abs(phaseErr(f.firstBeat, 0.31, 128))).toBeLessThan(0.008);
    expect(gridTrusted(f.evidence)).toBe(true);
    expect(f.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
  });

  it("corrects a slightly wrong BPM that would drift by the outro, preferring the whole BPM", () => {
    const { low, mid } = bands({ bpm: 128, first: 0.31, hats: 0.25 });
    // 0.05 BPM off: about 90 ms adrift by the end of a 4-minute track.
    const f = fitGrid(gridEnvelope(low, mid), FPS, 128.05, 0.322)!;
    expect(f.bpm).toBe(128);
    expect(Math.abs(phaseErr(f.firstBeat, 0.31, 128))).toBeLessThan(0.008);
    expect(f.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
  });

  it("finds a non-whole BPM exactly rather than rounding it", () => {
    const { low, mid } = bands({ bpm: 157.24, first: 0.12, hats: 0.2 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 157.0, 0.12)!;
    expect(Math.abs(f.bpm - 157.24)).toBeLessThan(0.01);
    expect(f.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
  });

  it("moves a grid that sits a quarter beat off (on a 16th) back onto the kick", () => {
    const { low, mid } = bands({ bpm: 125, first: 0.2, hats: 0.3, offbeatBass: 0.4 });
    const T = 60 / 125;
    const f = fitGrid(gridEnvelope(low, mid), FPS, 125, 0.2 + T / 4)!;
    expect(Math.abs(phaseErr(f.firstBeat, 0.2, 125))).toBeLessThan(0.01);
    expect(f.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
  });

  it("stays on the kick when an off-beat bassline is nearly as loud", () => {
    const { low, mid } = bands({ bpm: 124, first: 0.05, offbeatBass: 0.8 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 124, 0.05)!;
    expect(Math.abs(phaseErr(f.firstBeat, 0.05, 124))).toBeLessThan(0.008);
  });

  it("corrects a grid at 4:3 of the real tempo (a 3-3-2 rhythm read as the beat and doubled)", () => {
    // A 120 BPM track detected at 160: every grid beat still meets a kick or bass note, but the real beats
    // also sit a third and two thirds of the way through each grid beat.
    const { low, mid } = bands({ bpm: 120, first: 0.1, offbeatBass: 0.5 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 160, 0.1)!;
    expect(f.bpm).toBe(120);
    expect(Math.abs(phaseErr(f.firstBeat, 0.1, 120))).toBeLessThan(0.01);
    expect(f.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
  });

  it("doesn't trust (or move) a grid it can't confirm at any related tempo", () => {
    // Kicks every 0.5 s, but the grid is at an unrelated tempo.
    const { low, mid } = bands({ bpm: 120, first: 0.1 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 137, 0.1);
    if (f) {
      expect(f.confidence).toBeLessThan(GRID_CONFIDENT);
      expect(f.bpm).toBe(137);
      expect(f.firstBeat).toBe(0.1);
    }
  });

  it("can't trust a track with no beat", () => {
    const { low, mid } = bands({ bpm: 128, first: 0, beats: false, noise: 0.3 });
    const f = fitGrid(gridEnvelope(low, mid), FPS, 128, 0.2);
    if (f) { expect(f.confidence).toBeLessThan(GRID_CONFIDENT); expect(f.bpm).toBe(128); }
    expect(checkGrid(gridEnvelope(low, mid), FPS, 128, 0.2)?.z ?? 0).toBeLessThan(4);
  });

  it("refineBeats marks the fit version and drops a tag BPM it had to move away from", () => {
    const { low, mid } = bands({ bpm: 128, first: 0.31 });
    const r = refineBeats({ bpm: 128.3, firstBeat: 0.31, confidence: 1.2, bpmSource: "metadata" }, low, mid, FPS);
    expect(r.gridFitVersion).toBe(GRID_FIT_VERSION);
    expect(r.bpm).toBe(128);
    expect(r.bpmSource).toBe("analysis");
    expect(refineBeats({ bpm: null, firstBeat: null, confidence: 0, bpmSource: "none" }, low, mid, FPS).gridFitVersion).toBe(GRID_FIT_VERSION);
  });
});

// ── Upgrading cached analyses: re-fitted grids are saved, hand-set grids are kept ──
const rec = (id: string, manual: boolean): TrackPreparation => ({ schemaVersion: 1, trackId: id, refs: [`${id}.wav`], fileSize: 1, title: id, artist: "", album: "", isrc: null, duration: 240, bpm: 128.05, key: null, keyConfidence: 0, energy: null, energyConfidence: 0,
  sections: [], recommendedCues: [], gain: null, analysisVersion: 1, analysedAt: 1, updatedAt: 1,
  beatGrid: { bpm: manual ? 127 : 128.05, firstBeat: 0.3, confidence: 1.2, offset: 0, beatPositions: [], manuallyAdjusted: manual, source: "analysis" },
  cuePoint: 0, cues: [], savedLoops: [], lastLoop: null });

describe("PreparationStore grid re-fit", () => {
  const realWorker = globalThis.Worker;
  afterEach(() => { globalThis.Worker = realWorker; });
  async function setup() {
    const waves = new Map<string, WaveformRecord>();
    for (const id of ["auto", "hand"]) waves.set(id, packWaveform(id, { ...synth({ seconds: 60, kickEvery: 60 / 128, bpm: 128.05 }), firstBeat: 0.3, confidence: 1.2 }, 111));
    const persistence: PreparationPersistence = {
      list: async () => [rec("auto", false), rec("hand", true)], save: async () => undefined,
      loadWaveform: async (id) => waves.get(id) ?? null, saveWaveform: async (r) => void waves.set(r.trackId, r),
    };
    const store = new PreparationStore(persistence);
    await store.ready;
    return { store, waves };
  }
  const fitted = { bpm: 128, firstBeat: 0.31, confidence: 1.8, bpmSource: "analysis" as const, gridFitVersion: GRID_FIT_VERSION };

  it("lists analysed tracks that predate the fit, then saves the fitted grid and the version", async () => {
    const { store, waves } = await setup();
    expect(store.needingGridFit(GRID_FIT_VERSION).sort()).toEqual(["auto", "hand"]);
    await store.saveGridFit("auto", fitted);
    const r = store.get("auto")!;
    expect(r.beatGrid).toMatchObject({ bpm: 128, firstBeat: 0.31, confidence: 1.8, manuallyAdjusted: false });
    expect(r.bpm).toBe(128);
    expect(r.analysedAt).toBe(1);
    expect(waves.get("auto")).toMatchObject({ bpm: 128, firstBeat: 0.31, confidence: 1.8, gridFitVersion: GRID_FIT_VERSION, analysedAt: 111 });
    expect(store.needingGridFit(GRID_FIT_VERSION)).toEqual(["hand"]);
  });

  it("keeps a hand-set grid (only the cached analysis and version change)", async () => {
    const { store, waves } = await setup();
    await store.saveGridFit("hand", fitted);
    expect(store.get("hand")!.beatGrid).toMatchObject({ bpm: 127, firstBeat: 0.3, manuallyAdjusted: true });
    expect(waves.get("hand")!.bpm).toBe(128);
    expect(store.needingGridFit(GRID_FIT_VERSION)).toEqual(["auto"]);
  });

  it("AnalysisService.refitLibrary re-fits each outdated cached analysis once, in the worker", async () => {
    const { store, waves } = await setup();
    // Realistic bands for both cached analyses: a 128 BPM track whose first pass said 128.05.
    for (const id of ["auto", "hand"]) {
      const b = bands({ bpm: 128, first: 0.31, hats: 0.25 });
      waves.set(id, packWaveform(id, { ...synth({ seconds: 240, bpm: 128.05 }), ...b, firstBeat: 0.3, confidence: 1.2 }, 111));
    }
    // Stand-in for overview.worker: answers refit requests with the same refineBeats call.
    const posted: unknown[] = [];
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(m: { id: number; refit: { low: Float32Array; mid: Float32Array; fps: number; bpm: number; firstBeat: number; confidence: number; bpmSource: "analysis" } }) {
        posted.push(m);
        const { low, mid, fps, ...beat } = m.refit;
        setTimeout(() => this.onmessage?.({ data: { id: m.id, grid: refineBeats(beat, low, mid, fps) } }), 0);
      }
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const engine = { on: () => () => {}, getState: () => ({ decks: [] }) } as unknown as DJEngine;
    const infos: string[] = [];
    const service = new AnalysisService(engine, { preparation: store, audio: {} as AudioEngine, readAudio: async () => new ArrayBuffer(0), onError: () => {}, onInfo: (m) => infos.push(m), storage: null });

    const first = await service.refitLibrary();
    expect(first.refitted).toBe(2);
    expect(store.get("auto")!.beatGrid).toMatchObject({ bpm: 128, manuallyAdjusted: false });
    expect(store.get("auto")!.beatGrid!.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENT);
    expect(store.get("hand")!.beatGrid).toMatchObject({ bpm: 127, manuallyAdjusted: true });
    expect(store.needingGridFit(GRID_FIT_VERSION)).toEqual([]);
    expect(infos.at(-1)).toMatch(/re-fitted .* 2 analysed track/);

    // Nothing left to do: no more worker requests.
    const before = posted.length;
    expect((await service.refitLibrary()).refitted).toBe(0);
    expect(posted.length).toBe(before);
  });

  it("round-trips the fit version through the waveform cache", async () => {
    const { store } = await setup();
    expect((await store.waveform("auto"))!.gridFitVersion).toBe(0);
    await store.saveGridFit("auto", fitted);
    expect((await store.waveform("auto"))!.gridFitVersion).toBe(GRID_FIT_VERSION);
  });
});

import { describe, expect, it } from "vitest";
import {
  alignedToOnsets, barSeconds, beatSeconds, doubled, downbeatNear, gridReliable, gridStatus, halved, normaliseGrid, nudged, phraseOffsetBars, snapToOnset, tapTempo, withBpm, withDownbeat,
} from "../src/preparation/beatGrid";
import { BeatGridService } from "../src/preparation/BeatGridService";
import { PreparationStore } from "../src/preparation/PreparationStore";
import { packWaveform, type PreparationPersistence, type TrackPreparation } from "../src/preparation/types";
import { DEFAULT_AUTO_DJ, planTransition } from "../src/autodj/transition";
import { DJEngine, type BeatGrid, type DeckState } from "../src/core/engine/DJEngine";
import { CommandBus } from "../src/core/commands";
import { EventLog } from "../src/core/log";
import { LibraryStore } from "../src/library/LibraryStore";
import { FakeAudioEngine } from "./fakes";
import { synth } from "./setstudio-helpers";

const FPS = 150;
/** An onset envelope with a sharp hit every `every` seconds starting at `start`. */
function hits(seconds: number, every: number, start: number): Float32Array {
  const env = new Float32Array(Math.round(seconds * FPS));
  for (let t = start; t < seconds; t += every) env[Math.round(t * FPS)] = 1;
  return env;
}

describe("beat grid rules", () => {
  it("trusts a confident or hand-set grid, flags a low-confidence one", () => {
    expect(gridStatus(null)).toBe("none");
    expect(gridStatus({ bpm: 90, firstBeat: 0, confidence: 1.1 })).toBe("unreliable");
    expect(gridReliable({ bpm: 90, firstBeat: 0, confidence: 1.1 })).toBe(false);
    expect(gridStatus({ bpm: 90, firstBeat: 0, confidence: 1.1, manuallyAdjusted: true })).toBe("manual");
    expect(gridReliable({ bpm: 90, firstBeat: 0, confidence: 1.1, manual: true })).toBe(true);
    expect(gridStatus({ bpm: 124, firstBeat: 0, confidence: 2.2 })).toBe("analysed");
  });
});

describe("beat grid edit maths", () => {
  const g = { bpm: 120, firstBeat: 0.1 };
  it("keeps the downbeat inside the first bar", () => {
    expect(normaliseGrid({ bpm: 120, firstBeat: 4.3 }).firstBeat).toBeCloseTo(0.3, 5);
    expect(normaliseGrid({ bpm: 120, firstBeat: -0.5 }).firstBeat).toBeCloseTo(1.5, 5);
  });
  it("changes the BPM keeping the bar under the playhead in place", () => {
    const anchor = downbeatNear(g, 30.05);
    const next = withBpm(g, 124, anchor);
    expect(next.bpm).toBe(124);
    expect(downbeatNear(next, anchor)).toBeCloseTo(anchor, 4);
  });
  it("×2 and ÷2 keep the anchored downbeat", () => {
    const anchor = downbeatNear({ bpm: 90, firstBeat: 0.2 }, 60);
    const d = doubled({ bpm: 90, firstBeat: 0.2 }, anchor);
    expect(d.bpm).toBe(180);
    expect(downbeatNear(d, anchor)).toBeCloseTo(anchor, 4);
    const h = halved({ bpm: 174, firstBeat: 0.05 }, 0.05);
    expect(h.bpm).toBe(87);
    expect(h.firstBeat).toBeCloseTo(0.05, 5);
  });
  it("makes any beat the downbeat, and nudges by beats, milliseconds and BPM", () => {
    const t = 47.31;
    expect(downbeatNear(withDownbeat(g, t), t)).toBeCloseTo(t, 4);
    expect(nudged(g, { beats: 1 }).firstBeat).toBeCloseTo(0.1 + beatSeconds(120), 5);
    expect(nudged(g, { beats: -1 }).firstBeat).toBeCloseTo(0.1 - beatSeconds(120) + barSeconds(120), 5);
    expect(nudged(g, { ms: 10 }).firstBeat).toBeCloseTo(0.11, 5);
    expect(nudged(g, { bpm: 0.01 })).toEqual({ bpm: 120.01, firstBeat: 0.1 });
  });
  it("tap tempo: averages steady taps, ignores a stray one, needs enough taps", () => {
    const taps = [0, 500, 1000, 1500, 2000, 2500];
    expect(tapTempo(taps)).toBe(120);
    expect(tapTempo([0, 500, 1000, 1080, 1500, 2000, 2500])).toBeCloseTo(120, 0);
    expect(tapTempo([0, 500, 1000])).toBeNull();
    expect(tapTempo([0, 689.66, 1379.32, 2068.98, 2758.64])).toBeCloseTo(87, 1);
  });
  it("snaps to the nearest kick onset within the window, else leaves the time alone", () => {
    const env = hits(20, 0.5, 0.13);
    expect(snapToOnset(env, FPS, 10.17)).toBeCloseTo(10.13, 2);
    expect(snapToOnset(new Float32Array(3000), FPS, 10.17)).toBe(10.17);
  });
  it("auto-align keeps the BPM and moves the grid onto where the beats fall", () => {
    const env = hits(120, 0.5, 0.13);
    const a = alignedToOnsets({ bpm: 120, firstBeat: 0 }, env, FPS)!;
    expect(a.bpm).toBe(120);
    expect(a.firstBeat % 0.5).toBeCloseTo(0.13, 1);
    expect(alignedToOnsets({ bpm: 120, firstBeat: 0 }, new Float32Array(120 * FPS), FPS)).toBeNull();
  });
  it("phrase offset counts bars from the first downbeat, within an 8-bar phrase", () => {
    expect(phraseOffsetBars({ bpm: 120, firstBeat: 0 }, 2 * 3)).toBe(3);
    expect(phraseOffsetBars({ bpm: 120, firstBeat: 0 }, 2 * 11)).toBe(3);
    expect(phraseOffsetBars({ bpm: 120, firstBeat: 0 }, null)).toBe(0);
  });
});

// ── Service: every edit is saved as set by hand, pushed to decks, undoable, and resettable ──
const ID = "sha256:t";
const rec = (): TrackPreparation => ({ schemaVersion: 1, trackId: ID, refs: ["t.wav"], fileSize: 1, title: "T", artist: "", album: "", isrc: null, duration: 180, bpm: 90, key: "Am", keyConfidence: 0.5, energy: 6, energyConfidence: 0.5,
  sections: [], recommendedCues: [], gain: null, analysisVersion: 1, analysedAt: 1, updatedAt: 1,
  beatGrid: { bpm: 90, firstBeat: 0.2, confidence: 1.1, offset: 0, beatPositions: [], manuallyAdjusted: false, source: "analysis" },
  cuePoint: 12, cues: [{ slot: 0, type: "hotcue", name: "A", colour: "#f00", timestamp: 30 }], savedLoops: [], lastLoop: null });

async function setup() {
  const analysed = { ...synth({ seconds: 180, kickEvery: 60 / 87, bpm: 90 }), firstBeat: 0.2, confidence: 1.1 };
  const saved: TrackPreparation[] = [];
  const persistence: PreparationPersistence = { list: async () => [rec()], save: async (r) => void saved.push(r), loadWaveform: async (id) => (id === ID ? packWaveform(ID, analysed) : null), saveWaveform: async () => undefined };
  const preparation = new PreparationStore(persistence);
  await preparation.ready;
  const pushed: BeatGrid[] = [];
  const svc = new BeatGridService({ preparation, engine: { refreshPreparation: (_id, f) => void pushed.push(f.beatGrid) } });
  return { preparation, svc, pushed, saved, analysed };
}

describe("BeatGridService", () => {
  it("saves a typed BPM as set by hand and pushes it to the decks", async () => {
    const { preparation, svc, pushed } = await setup();
    expect(svc.setBpm(ID, 87, 40)).toEqual({ ok: true });
    const g = preparation.get(ID)!.beatGrid!;
    expect(g.bpm).toBe(87);
    expect(g.manuallyAdjusted).toBe(true);
    expect(gridReliable(g)).toBe(true);
    expect(pushed.at(-1)?.bpm).toBe(87);
    expect(preparation.get(ID)!.bpm).toBe(87);
    expect(svc.setBpm(ID, 12)).toMatchObject({ ok: false });
  });
  it("'Grid looks right' trusts the grid unchanged; Undo restores the previous state", async () => {
    const { preparation, svc } = await setup();
    svc.confirm(ID);
    let g = preparation.get(ID)!.beatGrid!;
    expect([g.bpm, g.firstBeat, g.manuallyAdjusted]).toEqual([90, 0.2, true]);
    expect(svc.canUndo(ID)).toBe(true);
    svc.undo(ID);
    g = preparation.get(ID)!.beatGrid!;
    expect(g.manuallyAdjusted).toBe(false);
    expect(svc.canUndo(ID)).toBe(false);
  });
  it("Reset restores the analysed grid from the cache without touching cues", async () => {
    const { preparation, svc } = await setup();
    svc.setBpm(ID, 174);
    svc.nudge(ID, { ms: 30 });
    expect((await svc.resetToAnalysed(ID)).ok).toBe(true);
    const r = preparation.get(ID)!;
    expect([r.beatGrid!.bpm, r.beatGrid!.firstBeat, r.beatGrid!.manuallyAdjusted, r.beatGrid!.confidence]).toEqual([90, 0.2, false, 1.1]);
    expect(r.cues).toEqual(rec().cues);
    expect(r.cuePoint).toBe(12);
  });
  it("a hand-set grid survives re-analysis", async () => {
    const { preparation, svc, analysed } = await setup();
    svc.setBpm(ID, 87);
    await preparation.saveAnalysis(ID, { ...analysed, bpm: 91, confidence: 1.2 }, 180, { ref: "t.wav", title: "T", artist: "", album: "", source: "local", bpm: null, key: null });
    expect(preparation.get(ID)!.beatGrid!.bpm).toBe(87);
    expect(preparation.get(ID)!.beatGrid!.manuallyAdjusted).toBe(true);
  });
  it("phrase start is saved on the grid and kept through later grid edits", async () => {
    const { preparation, svc } = await setup();
    svc.setBpm(ID, 120, 0);
    svc.setPhraseStart(ID, 6.1);
    expect(preparation.get(ID)!.beatGrid!.phraseAnchor).toBeCloseTo(downbeatNear(preparation.get(ID)!.beatGrid!, 6.1), 4);
    svc.nudge(ID, { bpm: 0.01 });
    expect(preparation.get(ID)!.beatGrid!.phraseAnchor).not.toBeNull();
    svc.setPhraseStart(ID, null);
    expect(preparation.get(ID)!.beatGrid!.phraseAnchor ?? null).toBeNull();
  });
  it("Set downbeat snaps to the nearest kick from the cached analysis", async () => {
    const { preparation, svc } = await setup();
    // synth() kicks fall every 60/87 s from 0; ask 40 ms after one.
    const kick = 30 * (60 / 87);
    await svc.setDownbeat(ID, kick + 0.04, true);
    const g = preparation.get(ID)!.beatGrid!;
    expect(Math.abs(downbeatNear(g, kick) - kick)).toBeLessThan(0.02);
  });
});

// ── Auto DJ honours hand-set grids (it previously ignored them in its own planner) ──
async function deck(index: number, grid: BeatGrid): Promise<DeckState> {
  const bus = new CommandBus(), audio = new FakeAudioEngine(), library = new LibraryStore();
  library.addFiles([{ ref: "a", name: "a.wav" }]);
  const engine = new DJEngine({ bus, audio, log: new EventLog(), browser: library, loadBytes: async () => new ArrayBuffer(180) });
  await engine.loadTrack(0, library.getByRef("a")!);
  engine.setBeatGrid(0, grid);
  return { ...engine.getState().decks[0], index };
}
describe("Auto DJ and hand-set grids", () => {
  it("doesn't blame a grid that was set by hand", async () => {
    const out = await deck(0, { bpm: 124, firstBeat: 0, confidence: 3, source: "analysis" });
    const weak = await deck(1, { bpm: 124, firstBeat: 0, confidence: 1.0, source: "analysis" });
    const fixed = await deck(1, { bpm: 124, firstBeat: 0, confidence: 1.0, source: "analysis", manuallyAdjusted: true });
    expect(planTransition(out, weak, DEFAULT_AUTO_DJ).reason).toMatch(/beat grid isn't reliable enough for Deck B/);
    expect(planTransition(out, fixed, DEFAULT_AUTO_DJ).reason).not.toMatch(/beat grid/);
  });
});

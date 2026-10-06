import { describe, expect, it } from "vitest";
import { barAt, barSeconds, closeLoop, dbToLinear, extract, firstPassPlan, foldCycles, loopPeaks, loopPhase, loopRegion, mixPeaks, nextBar, sealLoop, thresholdCrossing, trimmedOffset } from "../src/production/looper/timing";
import { estimateTempo } from "../src/production/looper/tempo";
import { blankLooper, blankProject, LOOPER_DEFAULT_TRACKS, migrateProject } from "../src/production/types";
import { isRecordingRef } from "../src/production/recordings";

const BAR = barSeconds(120, 4); // 2 s

describe("looper transport maths", () => {
  it("bar length and next bar line", () => {
    expect(BAR).toBe(2);
    expect(nextBar(10, BAR, 10)).toEqual({ index: 0, time: 10 });
    expect(nextBar(10, BAR, 10.01)).toEqual({ index: 1, time: 12 });
    expect(nextBar(10, BAR, 11.97, .05)).toEqual({ index: 2, time: 14 }); // too close to schedule → next bar
    expect(barAt(10, BAR, 15)).toBe(2.5);
  });
  it("LOOP rounds to the nearest whole bar (early or late presses), never below one bar", () => {
    expect(closeLoop(10, BAR, 13.7)).toEqual({ bars: 2, end: 14 }); // pressed 0.3 s early → records on to bar 2
    expect(closeLoop(10, BAR, 14.4)).toEqual({ bars: 2, end: 14 }); // pressed 0.4 s late → cut at bar 2
    expect(closeLoop(10, BAR, 10.3)).toEqual({ bars: 1, end: 12 });
    expect(closeLoop(10, BAR, 10 + 4 * BAR + .9)).toEqual({ bars: 4, end: 18 });
  });
  it("takes the latency-compensated capture region", () => {
    expect(loopRegion(9.5, 48_000, 10, .025, 4)).toEqual({ from: Math.round(.525 * 48_000), frames: 192_000 });
    expect(Array.from(extract(Float32Array.from([1, 2, 3, 4]), 2, 4))).toEqual([3, 4, 0, 0]);
    expect(Array.from(extract(Float32Array.from([1, 2, 3, 4]), -1, 3))).toEqual([0, 1, 2]);
  });
  it("loops of different lengths stay in phase with the bar grid", () => {
    // origin 10 s; a 1-bar loop anchored at bar 0 and a 2-bar loop recorded from bar 3 (anchor 3 mod 2 = 1)
    expect(loopPhase(16, 10, BAR, 0, 1)).toBeCloseTo(0); // bar 3 downbeat: 1-bar loop restarts
    expect(loopPhase(16, 10, BAR, 1, 2)).toBeCloseTo(0); // …and the 2-bar loop is at its own start
    expect(loopPhase(17, 10, BAR, 1, 2)).toBeCloseTo(1);
    expect(loopPhase(18, 10, BAR, 1, 2)).toBeCloseTo(2); // second bar of the 2-bar loop
    expect(loopPhase(20, 10, BAR, 1, 2)).toBeCloseTo(0);
  });
  it("seals the loop seam with short fades and keeps the middle untouched", () => {
    const sealed = sealLoop(new Float32Array(1000).fill(1), 48_000, 3);
    expect(sealed[0]).toBe(0); expect(sealed[999]).toBe(0); expect(sealed[500]).toBe(1); expect(sealed[150]).toBe(1);
  });
  it("plans a seamless first repeat from the audio already captured", () => {
    expect(firstPassPlan(14, 4, 3.9, 13.8)).toEqual({ provisional: { at: 14, duration: 3.9 }, restFrom: 3.9, loopAt: 18 });
    // LOOP pressed after the bar line: just start the loop in phase as soon as possible
    expect(firstPassPlan(14, 4, 4, 14.3)).toEqual({ provisional: null, restFrom: 4, loopAt: 14.32 });
  });
  it("makes thumbnail peaks", () => { const p = loopPeaks(Float32Array.from({ length: 480 }, (_, i) => (i === 100 ? -.8 : .1)), 24); expect(p).toHaveLength(24); expect(Math.max(...p)).toBe(.8); });
});

describe("Phase 2 — overdub layers", () => {
  it("folds an overdub that spans several loop cycles into one cycle by summing", () => {
    const cycle = 4; const data = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]); // 3 cycles, a single sample lands at a different offset each time
    const folded = foldCycles(data, cycle);
    expect(Array.from(folded)).toEqual([1, 1, 1, 0]);
  });
  it("sums a single-cycle overdub unchanged", () => {
    const data = Float32Array.from([.2, .4, .1, -.3]); expect(Array.from(foldCycles(data, 4))).toEqual(Array.from(data));
  });
  it("mixes peaks from the active layers, clamped to 1", () => {
    expect(mixPeaks([[.2, .5], [.3, .6]])).toEqual([.5, 1]);
    expect(mixPeaks([])).toEqual([]);
  });
});

describe("Threshold Recording (Auto-Start)", () => {
  it("converts dB to a linear amplitude threshold", () => {
    expect(dbToLinear(0)).toBeCloseTo(1); expect(dbToLinear(-6)).toBeCloseTo(.501, 2); expect(dbToLinear(-36)).toBeCloseTo(.01585, 4);
  });
  it("finds the first sample past the threshold", () => {
    const linear = dbToLinear(-20); // ≈ .1
    expect(thresholdCrossing(Float32Array.from([0, .01, -.02, .3, .9]), linear)).toBe(3);
    expect(thresholdCrossing(Float32Array.from([0, .01, -.02]), linear)).toBe(-1);
    expect(thresholdCrossing(Float32Array.from([-.5, 0]), linear)).toBe(0); // negative-going sample still crosses
  });
});

describe("Manual Trim", () => {
  it("rotates the playback offset by the in-point and wraps within the loop", () => {
    expect(trimmedOffset(1, 0, 4)).toBe(1); // no trim: untouched
    expect(trimmedOffset(1, .5, 4)).toBe(1.5);
    expect(trimmedOffset(3.7, .5, 4)).toBeCloseTo(.2); // wraps past the end back to the start
  });
});

describe("Phase 2 — master loop tempo detection", () => {
  it("finds the BPM and downbeat of a steady click track", () => {
    const bpm = 120; const period = 60 / bpm; const bars = 2; const duration = bars * 4 * period; const downbeatOffset = .37;
    const onsets = Array.from({ length: Math.floor((duration - downbeatOffset) / period) }, (_, i) => ({ time: downbeatOffset + i * period, strength: 1 }));
    const estimate = estimateTempo(onsets, duration, 4);
    expect(estimate).not.toBeNull();
    expect(estimate!.bpm).toBeCloseTo(bpm, 0);
    expect(estimate!.bars).toBe(bars);
    expect(estimate!.downbeat).toBeCloseTo(downbeatOffset, 1);
    expect(estimate!.confidence).toBeGreaterThan(.8);
  });
  it("returns null with no onsets or no duration", () => {
    expect(estimateTempo([], 4)).toBeNull();
    expect(estimateTempo([{ time: 0, strength: 1 }], 0)).toBeNull();
  });
});

describe("looper session data", () => {
  it("starts with the default tracks and the first one selected", () => {
    const s = blankLooper(); expect(s.tracks.map((t) => t.name)).toEqual(LOOPER_DEFAULT_TRACKS); expect(s.selectedTrackId).toBe(s.tracks[0].id); expect(s.countIn).toBe(true); expect(s.quantize).toBe("off"); expect(s.thresholdRecord).toBe(false); expect(s.thresholdDb).toBe(-36);
  });
  it("stores loop audio as recordings and saves / reopens the session, overdub layers included", () => {
    expect(isRecordingRef("production-loop://loop_1")).toBe(true);
    const project = blankProject("Live"); project.looper = blankLooper(); project.looper.quantize = "1-bar";
    project.looper.tracks[0].loop = { layers: [{ ref: "production-loop://a", peaks: [.1, .5], recordedAt: 1 }, { ref: "production-loop://b", peaks: [.2, .4], recordedAt: 2 }], active: 2, bars: 2, anchorBar: 1, bpm: 120, beatsPerBar: 4, sampleRate: 48_000, duration: 4, latencyMs: 30, recordedAt: 1, trimIn: .05 };
    project.looper.tracks[1].muted = true; project.looper.tracks[2].volume = .6; project.looper.click = false;
    expect(migrateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(migrateProject(JSON.parse(JSON.stringify(blankProject())))?.looper).toBeUndefined(); // created when first opened
  });
  it("migrates a Phase 1 (single-ref) loop into a one-layer Phase 2 loop", () => {
    const project = blankProject("Old"); project.looper = blankLooper();
    const legacy = { ref: "production-loop://old", bars: 1, anchorBar: 0, bpm: 120, beatsPerBar: 4, sampleRate: 48_000, duration: 2, latencyMs: 20, peaks: [.3], recordedAt: 5 };
    (project.looper.tracks[0] as unknown as { loop: unknown }).loop = legacy;
    delete (project.looper as unknown as { quantize?: unknown }).quantize;
    delete (project.looper as unknown as { thresholdRecord?: unknown }).thresholdRecord;
    const migrated = migrateProject(JSON.parse(JSON.stringify(project)));
    expect(migrated?.looper?.quantize).toBe("off");
    expect(migrated?.looper?.thresholdRecord).toBe(false);
    expect(migrated?.looper?.thresholdDb).toBe(-36);
    expect(migrated?.looper?.tracks[0].loop).toEqual({ layers: [{ ref: "production-loop://old", peaks: [.3], recordedAt: 5 }], active: 1, bars: 1, anchorBar: 0, bpm: 120, beatsPerBar: 4, sampleRate: 48_000, duration: 2, latencyMs: 20, recordedAt: 5, trimIn: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { midiName, quantizeToGrid } from "../src/production/midi";
import { detectRootNote, frequencyToMidi } from "../src/production/pitch";
import { blankProject, migrateProject, QUANTIZE_BEATS, type MidiNote } from "../src/production/types";

const RATE = 44_100;
const note = (start: number, pitch = 36): MidiNote => ({ id: `n${start}`, pitch, start, duration: .2, velocity: 100, channel: 1 });

describe("pattern quantize", () => {
  const played = [note(0.02), note(0.48), note(1.13), note(1.62)];
  it("snaps completely at 100% and keeps durations", () => {
    expect(quantizeToGrid(played, QUANTIZE_BEATS["1/8"], 1).map((n) => n.start)).toEqual([0, .5, 1, 1.5]);
    expect(quantizeToGrid(played, QUANTIZE_BEATS["1/16"], 1).map((n) => n.start)).toEqual([0, .5, 1.25, 1.5]); // 1.62 is nearer 1.5 than 1.75
    expect(quantizeToGrid(played, QUANTIZE_BEATS["1/8"], 1).every((n) => n.duration === .2)).toBe(true);
  });
  it("moves notes part of the way at lower strength", () => {
    const half = quantizeToGrid(played, QUANTIZE_BEATS["1/8"], .5).map((n) => n.start);
    expect(half[0]).toBeCloseTo(.01); expect(half[1]).toBeCloseTo(.49); expect(half[2]).toBeCloseTo(1.065); expect(half[3]).toBeCloseTo(1.56);
  });
  it("supports 1/4, 1/32 and triplet grids, and OFF leaves timing alone", () => {
    expect(quantizeToGrid([note(.6)], QUANTIZE_BEATS["1/4"], 1)[0].start).toBe(1);
    expect(quantizeToGrid([note(.07)], QUANTIZE_BEATS["1/32"], 1)[0].start).toBe(.125);
    expect(quantizeToGrid([note(.3), note(.7)], QUANTIZE_BEATS.triplet, 1).map((n) => n.start)).toEqual([.333333, .666667]);
    expect(quantizeToGrid(played, QUANTIZE_BEATS.off, 1)).toEqual(played);
  });
  it("does not change the recorded notes", () => { const copy = structuredClone(played); quantizeToGrid(played, .25, 1); expect(played).toEqual(copy); });
});

describe("root note detection", () => {
  const tone = (hz: number, seconds = 1, harmonics = [1, .5, .3, .2]) => Float32Array.from({ length: RATE * seconds }, (_, i) => harmonics.reduce((sum, a, h) => sum + a * Math.sin(2 * Math.PI * hz * (h + 1) * i / RATE), 0) * .3 * Math.exp(-i / RATE * 1.5));
  it("finds the fundamental of pitched tones", () => {
    expect(detectRootNote(tone(65.41), RATE)?.note).toBe(36); // C2 bass
    expect(detectRootNote(tone(277.18), RATE)?.note).toBe(61); // C#4
    expect(detectRootNote(tone(440, 1, [1]), RATE)?.note).toBe(69);
    expect(midiName(61)).toBe("C#4");
  });
  it("finds the fundamental even when it is weaker than its harmonics", () => {
    expect(detectRootNote(tone(110, 1, [.4, 1, .8, .5]), RATE)?.note).toBe(45);
  });
  it("returns null for noise, silence and very short sounds", () => {
    let x = 1; const noise = Float32Array.from({ length: RATE }, () => { x = (x * 16_807) % 2_147_483_647; return x / 1_073_741_823 - 1; });
    expect(detectRootNote(noise, RATE)).toBeNull();
    expect(detectRootNote(new Float32Array(RATE), RATE)).toBeNull();
    expect(detectRootNote(tone(220, .02), RATE)).toBeNull();
  });
  it("converts frequency to MIDI", () => { expect(frequencyToMidi(440)).toBe(69); expect(Math.round(frequencyToMidi(261.63))).toBe(60); });
});

describe("sampler MIDI project data", () => {
  it("maps pads chromatically from the base note and starts in SLICES", () => {
    const sampler = blankProject().sampler;
    expect(sampler.mode).toBe("slices"); expect(sampler.baseNote).toBe(36);
    expect(sampler.pads.slice(0, 3).map((p) => midiName(p.midiNote))).toEqual(["C2", "C#2", "D2"]);
    expect(sampler.quantize).toEqual({ grid: "1/16", strength: 1 });
  });
  it("upgrades Phase 2 projects and keeps patterns, chromatic settings and remaps when reopened", () => {
    const phase2 = blankProject("Old") as unknown as { sampler: Record<string, unknown> };
    for (const key of ["mode", "baseNote", "chromatic", "pattern", "quantize"]) delete phase2.sampler[key];
    const upgraded = migrateProject(JSON.parse(JSON.stringify(phase2)))!;
    expect(upgraded.sampler).toMatchObject({ mode: "slices", baseNote: 36, pattern: null, chromatic: { sample: null, rootNote: 60, detectedRoot: null } });

    const project = blankProject("Pattern");
    project.sampler.mode = "chromatic"; project.sampler.chromatic.rootNote = 49; project.sampler.chromatic.detectedRoot = 49; project.sampler.chromatic.params.release = .3;
    project.sampler.pads[0].midiNote = 40; project.sampler.pads[4].midiNote = 36;
    project.sampler.pattern = { notes: [note(0, 49), note(.52, 52)], bars: 1, mode: "chromatic", recordedAt: 1 }; project.sampler.quantize = { grid: "triplet", strength: .6 };
    const reopened = migrateProject(JSON.parse(JSON.stringify(project)))!;
    expect(reopened).toEqual(project);
  });
});

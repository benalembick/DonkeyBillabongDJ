import { describe, expect, it } from "vitest";
import { blankProject, migrateProject, sampleToClip } from "../src/production/types";
import { encodeWav } from "../src/production/wav";
import { humanizeNotes, midiFrequency, midiName, quantizeNotes, scalePitchClasses } from "../src/production/midi";

describe("Production Studio project format", () => {
  it("creates a portable, versioned project with audio tracks", () => {
    const project = blankProject("Beat Maker");
    expect(project.format).toBe("DonkeyBillabongDJ Production Project");
    expect(project.version).toBe(3);
    expect(project.name).toBe("Beat Maker");
    expect(project.tracks).toHaveLength(4);
    expect(project.tracks.every((track) => track.output === "master")).toBe(true);
    expect(project.tracks.filter((track) => track.kind === "instrument")).toHaveLength(2);
    expect(project.sampler.pads).toHaveLength(64); // banks A–D × 16
    expect(project.sampler.pads.map((pad) => pad.midiNote)).toEqual(Array.from({ length: 64 }, (_, index) => 36 + index));
  });

  it("migrates version 2 projects with an empty persistent sampler", () => {
    const current = blankProject("Legacy");
    const legacy = { ...current, version: 2 } as Record<string, unknown>;
    delete legacy.sampler;
    const migrated = migrateProject(legacy);
    expect(migrated?.version).toBe(3);
    expect(migrated?.sampler.pads).toHaveLength(64);
    expect(migrated?.sampler.savedSamples).toEqual([]);
  });

  it("round-trips sampler edits and pad assignments in project JSON", () => {
    const project = blankProject("Sampler Set");
    const sample = { id: "sample_1", sourceRef: "C:/audio/kick.wav", name: "Kick", sourceDuration: 2, start: .1, end: .8, gain: 1.2, playbackMode: "one-shot" as const, edits: { reverse: false, normalize: true, fadeIn: .01, fadeOut: .04 }, peaks: [.2, .8, .4], createdAt: 123 };
    project.sampler.editor = sample; project.sampler.savedSamples.push(sample); project.sampler.pads[3].sample = sample;
    const restored = migrateProject(JSON.parse(JSON.stringify(project)));
    expect(restored?.sampler.editor).toEqual(sample);
    expect(restored?.sampler.pads[3]).toMatchObject({ midiNote: 39, sample: { name: "Kick", start: .1, end: .8 } });
  });
});

describe("Sampler samples in the arrangement", () => {
  const sample = { id: "s", sourceRef: "C:/audio/vox.wav", name: "Vox", sourceDuration: 4, start: 1, end: 3, gain: 1, playbackMode: "one-shot" as const, edits: { reverse: false, normalize: false, fadeIn: .05, fadeOut: .2 }, peaks: [.1, .2, .3, .4, .5, .6, .7, .8], createdAt: 1 };
  it("keeps the trimmed region, gain and fades", () => {
    const clip = sampleToClip(sample, 2);
    expect(clip).toMatchObject({ type: "audio", ref: "C:/audio/vox.wav", start: 2, offset: 1, duration: 2, sourceDuration: 4, gain: 1, fadeIn: .05, fadeOut: .2 });
    expect(clip.reverse).toBeUndefined();
    expect(clip.peaks).toEqual([.3, .4, .5, .6]);
  });
  it("measures a reversed region from the end of the source and applies normalize", () => {
    const clip = sampleToClip({ ...sample, edits: { ...sample.edits, reverse: true, normalize: true } }, 0);
    expect(clip.offset).toBe(1);
    expect(clip.reverse).toBe(true);
    expect(clip.gain).toBeCloseTo(1 / .8);
    expect(clip.peaks).toEqual([.6, .5, .4, .3]);
  });
});

describe("Production Studio MIDI engine", () => {
  const notes = [{ id: "n", pitch: 61, start: .29, duration: .4, velocity: 100, channel: 1 }];
  it("uses standard MIDI pitch and note names", () => { expect(midiFrequency(69)).toBe(440); expect(midiName(60)).toBe("C4"); });
  it("quantizes without mutating source notes", () => { const out = quantizeNotes(notes, 16); expect(out[0].start).toBe(.25); expect(notes[0].start).toBe(.29); });
  it("humanizes deterministically within valid ranges", () => { const out = humanizeNotes(notes); expect(out[0].start).not.toBe(notes[0].start); expect(out[0].velocity).toBeGreaterThan(0); });
  it("highlights notes in the requested scale", () => { const cMinor = scalePitchClasses(0, "minor"); expect(cMinor.has(0)).toBe(true); expect(cMinor.has(3)).toBe(true); expect(cMinor.has(4)).toBe(false); });
});

describe("Production Studio WAV export", () => {
  it("writes a stereo 16-bit PCM RIFF file", () => {
    const wav = encodeWav({ sampleRate: 44_100, left: new Float32Array([0, 1, -1]), right: new Float32Array([.5, -.5, 0]) });
    const view = new DataView(wav);
    const text = (start: number, length: number) => new TextDecoder().decode(new Uint8Array(wav, start, length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
  });
});

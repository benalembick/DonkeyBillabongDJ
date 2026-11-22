/**
 * Drum Transcriber — timing/quantise, velocity, MIDI mapping & export (re-read with the independent `midi-file`
 * parser), persistence, undo/redo, editing, invalid input, cancellation and grid precedence through the service.
 */
import { parseMidi } from "midi-file";
import { describe, expect, it, vi } from "vitest";
import { DrumTranscriber, type DecodedSource, type DrumTranscriberDeps } from "../src/production/drums/DrumTranscriber";
import { transcriptionToJson, transcriptionToMidi, writeSmf } from "../src/production/drums/midiFile";
import { deriveNotes, gridOrigin, velocityOf } from "../src/production/drums/timing";
import { transcribeDrums } from "../src/production/drums/transcribe";
import { DRUM_SCHEMA, GM_DRUM_MAP, defaultSettings, migrateTranscription, type DrumHit, type DrumMapPreset, type DrumTranscription } from "../src/production/drums/types";
import { encodeWav } from "../src/production/wav";
import { contentTrackId } from "../src/preparation/types";
import { DocStore, LocalStorageDocs } from "../src/setstudio/DocStore";
import { pattern, RATE, render } from "./drums-helpers";

const hit = (id: string, lane: DrumHit["lane"], time: number, extra: Partial<DrumHit> = {}): DrumHit => ({ id, lane, time, onset: time, detected: lane, confidence: .9, strength: .8, velocity: null, review: null, group: null, ...extra });
function project(hits: DrumHit[], patch: Partial<DrumTranscription> = {}): DrumTranscription {
  return { schemaVersion: DRUM_SCHEMA, id: "drumtx_test", name: "Test Loop", createdAt: 1, updatedAt: 1, source: { ref: "/loops/test.wav", name: "test.wav", hash: "sha256:x", duration: 4, sampleRate: 44100, channels: 1, origin: "file" },
    grid: { bpm: 120, firstBeat: 0, beatsPerBar: 4, source: "manual", confidence: 1 }, hits, mapping: { ...GM_DRUM_MAP }, mappingPresetId: null, settings: defaultSettings(), analysis: null, ...patch };
}

describe("quantisation keeps the original timing", () => {
  const hits = [hit("a", "kick", .0), hit("b", "snare", .53), hit("c", "closed-hat", .74)]; // 120 BPM: 1/16 = .125 s
  it("off / 100 % / 50 % strength on 1/16", () => {
    const p = project(hits);
    expect(deriveNotes(p).notes.map((n) => n.quantisedTime)).toEqual([0, .53, .74]);
    p.settings.quantize = { grid: "1/16", strength: 1 };
    expect(deriveNotes(p).notes.map((n) => +n.quantisedTime.toFixed(4))).toEqual([0, .5, .75]);
    p.settings.quantize = { grid: "1/16", strength: .5 };
    expect(deriveNotes(p).notes.map((n) => +n.quantisedTime.toFixed(4))).toEqual([0, .515, .745]);
    p.settings.quantize = { grid: "off", strength: 1 };
    expect(deriveNotes(p).notes.map((n) => n.quantisedTime)).toEqual([0, .53, .74]); // reversible: hits never changed
    expect(p.hits.map((h) => h.time)).toEqual([0, .53, .74]);
  });
  it("triplet grids", () => {
    const p = project([hit("a", "kick", .17)]); p.settings.quantize = { grid: "1/8T", strength: 1 }; // 1/8T = 1/3 beat = .1667 s
    expect(deriveNotes(p).notes[0].quantisedTime).toBeCloseTo(1 / 6, 4);
    p.settings.quantize = { grid: "1/16T", strength: 1 }; p.hits[0].time = .09; // 1/16T = .0833 s
    expect(deriveNotes(p).notes[0].quantisedTime).toBeCloseTo(1 / 12, 4);
  });
  it("respects the beat-grid offset (downbeat not at 0)", () => {
    const p = project([hit("a", "kick", .32), hit("b", "kick", .83)], { grid: { bpm: 120, firstBeat: .3, beatsPerBar: 4, source: "manual", confidence: 1 } });
    p.settings.quantize = { grid: "1/4", strength: 1 };
    const { origin, notes } = deriveNotes(p);
    expect(origin).toBeCloseTo(.3); expect(notes.map((n) => +n.quantisedTime.toFixed(4))).toEqual([.3, .8]); expect(notes.map((n) => n.beat)).toEqual([0, 1]);
  });
  it("hits before the first downbeat move the origin one bar earlier (no negative positions)", () => {
    const p = project([hit("a", "kick", .1), hit("b", "kick", 1.1)], { grid: { bpm: 120, firstBeat: .6, beatsPerBar: 4, source: "manual", confidence: 1 } });
    expect(gridOrigin(p.grid, p.hits)).toBeCloseTo(-1.4); expect(deriveNotes(p).notes[0].beat).toBeCloseTo(3);
  });
});

describe("velocity", () => {
  const v = { sensitivity: 1, min: 20, max: 120, compression: 0, fixed: null };
  it("scales strength into min…max, with sensitivity, compression, fixed and manual override", () => {
    expect(velocityOf({ strength: 1, velocity: null }, v)).toBe(120);
    expect(velocityOf({ strength: 0, velocity: null }, v)).toBe(20);
    expect(velocityOf({ strength: .5, velocity: null }, v)).toBe(70);
    expect(velocityOf({ strength: .5, velocity: null }, { ...v, sensitivity: 0 })).toBe(120);
    expect(velocityOf({ strength: .25, velocity: null }, { ...v, compression: 1 })).toBeGreaterThan(velocityOf({ strength: .25, velocity: null }, v));
    expect(velocityOf({ strength: .1, velocity: null }, { ...v, fixed: 99 })).toBe(99);
    expect(velocityOf({ strength: .1, velocity: 33 }, { ...v, fixed: 99 })).toBe(33);
    expect(velocityOf({ strength: 1, velocity: null }, { ...v, min: 1, max: 127 })).toBe(127);
  });
  it("analysed velocity follows how hard each hit was played (per instrument)", async () => {
    const truth = [{ time: .1, lane: "kick" as const, gain: .9 }, { time: .6, lane: "kick" as const, gain: .25 }, { time: 1.1, lane: "kick" as const, gain: .6 }];
    const r = await transcribeDrums(render(truth, 1.6), RATE, { sensitivity: .5, minConfidence: .45, mode: "loop" });
    const s = r.hits.map((h) => h.strength); expect(s[0]).toBeGreaterThan(s[2]); expect(s[2]).toBeGreaterThan(s[1]);
  });
});

describe("MIDI export", () => {
  const p = project([hit("a", "kick", 0), hit("b", "closed-hat", 0), hit("c", "snare", .5, { velocity: 101 }), hit("d", "unknown", .75), hit("e", "open-hat", 1.0)]);
  it("General MIDI mapping, unknown lane skipped and reported", () => {
    const r = transcriptionToMidi(p);
    expect(r.notes).toBe(4); expect(r.skipped).toBe(1); expect(r.skippedLanes).toEqual(["unknown"]);
  });
  it("is a format-1 SMF an independent parser reads back exactly: tempo, time signature, channel 10, ticks, velocities, simultaneous hits", () => {
    const midi = parseMidi(transcriptionToMidi(p).bytes);
    expect(midi.header.format).toBe(1); expect(midi.header.numTracks).toBe(2); expect(midi.header.ticksPerBeat).toBe(480);
    const tempo = midi.tracks[0].find((e) => e.type === "setTempo") as { microsecondsPerBeat: number }; expect(tempo.microsecondsPerBeat).toBe(500000);
    const ts = midi.tracks[0].find((e) => e.type === "timeSignature") as { numerator: number; denominator: number }; expect([ts.numerator, ts.denominator]).toEqual([4, 4]);
    let tick = 0; const ons: { tick: number; note: number; velocity: number; channel: number }[] = [];
    for (const e of midi.tracks[1]) { tick += e.deltaTime; if (e.type === "noteOn" && e.velocity > 0) ons.push({ tick, note: e.noteNumber, velocity: e.velocity, channel: e.channel }); }
    expect(ons.every((n) => n.channel === 9)).toBe(true); // channel 10, zero-based in the status byte
    expect(ons.filter((n) => n.tick === 0).map((n) => n.note).sort()).toEqual([36, 42]); // kick + hat together
    expect(ons.find((n) => n.note === 38)).toEqual({ tick: 480, note: 38, velocity: 101, channel: 9 });
    expect(ons.find((n) => n.note === 46)?.tick).toBe(960);
  });
  it("custom mapping and per-lane tracks", () => {
    const custom = { ...p, mapping: { ...p.mapping, kick: 35, unknown: 76 } };
    const r = transcriptionToMidi(custom, { split: true }); expect(r.skipped).toBe(0);
    const midi = parseMidi(r.bytes); expect(midi.header.numTracks).toBe(1 + 5);
    const notes = midi.tracks.slice(1).flatMap((t) => t.filter((e) => e.type === "noteOn").map((e) => (e as { noteNumber: number }).noteNumber));
    expect(notes).toContain(35); expect(notes).toContain(76); expect(notes).not.toContain(36);
  });
  it("note-offs come before a re-trigger of the same note at the same tick", () => {
    const bytes = writeSmf({ name: "t", bpm: 100, tracks: [{ name: "d", channel: 10, notes: [{ pitch: 42, tick: 0, duration: 240, velocity: 90 }, { pitch: 42, tick: 120, duration: 240, velocity: 90 }] }] });
    let tick = 0; const ev: string[] = []; for (const e of parseMidi(bytes).tracks[1]) { tick += e.deltaTime; if (e.type === "noteOn" || e.type === "noteOff") ev.push(`${tick}:${e.type}`); }
    expect(ev).toEqual(["0:noteOn", "120:noteOff", "120:noteOn", "360:noteOff"]);
  });
  it("tempo is exported from the grid", () => {
    const midi = parseMidi(transcriptionToMidi({ ...p, grid: { ...p.grid, bpm: 87.5 } }).bytes);
    expect((midi.tracks[0].find((e) => e.type === "setTempo") as { microsecondsPerBeat: number }).microsecondsPerBeat).toBe(Math.round(60e6 / 87.5));
  });
  it("JSON event list carries original onsets, positions and ticks", () => {
    const json = JSON.parse(transcriptionToJson(p)); expect(json.format).toBe("dbdj-drum-transcription"); expect(json.notes).toHaveLength(5);
    expect(json.notes.find((n: { hitId: string }) => n.hitId === "c")).toMatchObject({ time: .5, beat: 1, tick: 480, velocity: 101, pitch: 38 });
    expect(json.project.hits[0].onset).toBe(0);
  });
});

// ─────────────────────────── service ───────────────────────────
function decodeWav(bytes: ArrayBuffer): DecodedSource {
  const v = new DataView(bytes); if (v.byteLength < 44 || v.getUint32(0, false) !== 0x52494646) throw new Error("not a wav");
  const ch = v.getUint16(22, true), rate = v.getUint32(24, true), frames = v.getUint32(40, true) / (ch * 2);
  const channels = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) channels[c][i] = v.getInt16(44 + (i * ch + c) * 2, true) / 32768;
  return { channels, sampleRate: rate, duration: frames / rate, buffer: null };
}
function memoryStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; }
const loopWav = (bpm = 120) => encodeWav({ sampleRate: RATE, left: render(pattern(bpm, { kick: "x.......x.......", snare: "....x.......x...", "closed-hat": "..x...x...x...x." }, 0, 2), 2 * 240 / bpm) });

function setup(files: Record<string, ArrayBuffer>, storage = memoryStorage(), extra: Partial<DrumTranscriberDeps> = {}) {
  const docs = new LocalStorageDocs("t.", storage);
  const analyse = vi.fn((mono: Float32Array, rate: number, options: Parameters<typeof transcribeDrums>[2], onProgress: (s: never, p: number) => void, signal: AbortSignal) => transcribeDrums(mono, rate, options, { onProgress, signal, yieldControl: () => new Promise((r) => setTimeout(r, 0)) }));
  const deps: DrumTranscriberDeps = {
    readBytes: async (ref) => { const f = files[ref]; if (!f) throw new Error("File not found"); return f.slice(0); },
    decode: async (b) => decodeWav(b), hash: contentTrackId,
    store: new DocStore<DrumTranscription>("drumtx", docs, migrateTranscription), presets: new DocStore<DrumMapPreset>("drummap", docs, (r) => r as DrumMapPreset),
    analyse, storage, download: vi.fn(), saveText: vi.fn(async () => true), ...extra,
  };
  const s = new DrumTranscriber(deps); return { s, deps, analyse, storage };
}

describe("DrumTranscriber service", () => {
  it("import → analyse → edit → undo/redo", async () => {
    const { s } = setup({ "/a.wav": loopWav() }); await s.init();
    await s.importRef("/a.wav", "a.wav"); expect(s.getState().project?.hits).toEqual([]); expect(s.getState().source).toBe("ready");
    await s.analyse(); const p = s.getState().project!;
    expect(p.hits.length).toBe(16); expect(p.grid.bpm).toBeCloseTo(120, 0); expect(p.analysis?.onsets.length).toBe(16); expect(p.analysis?.classifier).toBe("template-nmf@1");
    expect(p.hits.every((h) => h.onset === h.time && h.detected === h.lane)).toBe(true);
    const kick = p.hits.find((h) => h.lane === "kick")!;
    s.moveHits([kick.id], .01, 1, true); s.moveHits([kick.id], .02, 1, true); s.endGesture("Moved");
    let moved = s.getState().project!.hits.find((h) => h.id === kick.id)!; expect(moved.lane).toBe("snare"); expect(moved.time).toBeCloseTo(kick.time + .02); expect(moved.onset).toBe(kick.onset);
    s.undo(); moved = s.getState().project!.hits.find((h) => h.id === kick.id)!; expect(moved.lane).toBe("kick"); expect(moved.time).toBe(kick.time); // one gesture = one undo step
    s.redo(); expect(s.getState().project!.hits.find((h) => h.id === kick.id)!.lane).toBe("snare");
    s.setVelocity([kick.id], 64); s.reclassify([kick.id], "clap"); expect(s.getState().project!.hits.find((h) => h.id === kick.id)).toMatchObject({ velocity: 64, lane: "clap", review: null, edited: true });
    const added = s.addHit("crash", 1.5)!; s.copy([added, kick.id]); const pasted = s.paste(1); expect(pasted).toHaveLength(2);
    expect(s.getState().project!.hits.filter((h) => pasted.includes(h.id)).map((h) => +h.time.toFixed(3)).sort()).toEqual([1, +(1 + (1.5 - (kick.time + .02))).toFixed(3)].sort());
    expect(s.getState().project!.hits.filter((h) => pasted.includes(h.id)).map((h) => h.lane).sort()).toEqual(["clap", "crash"]);
    s.deleteHits(pasted); expect(s.getState().project!.hits.some((h) => pasted.includes(h.id))).toBe(false);
    s.undo(); expect(s.getState().project!.hits.filter((h) => pasted.includes(h.id))).toHaveLength(2);
    for (let i = 0; i < 5; i++) s.undo(); // paste, add, reclassify, velocity, move expect(s.getState().project!.hits.find((h) => h.id === kick.id)!.lane).toBe("kick");
    s.undo(); expect(s.getState().project!.hits).toEqual([]); // undo the analysis itself
  }, 20000);

  it("saves, and a new session reopens the transcription exactly — without re-running analysis", async () => {
    const files = { "/a.wav": loopWav() }; const a = setup(files); await a.s.init();
    await a.s.importRef("/a.wav", "a.wav"); await a.s.analyse(); a.s.setGrid({ bpm: 121 }); a.s.setSettings({ quantize: { grid: "1/16", strength: .75 } }); a.s.setMapping("kick", 35);
    const first = a.s.getState().project!.hits[0]; a.s.setVelocity([first.id], 77); await a.s.flush();
    const b = setup(files, a.storage); await b.s.init();
    const p = b.s.getState().project!; expect(b.analyse).not.toHaveBeenCalled();
    expect(p.id).toBe(a.s.getState().project!.id); expect(p.hits).toEqual(a.s.getState().project!.hits);
    expect(p.grid).toMatchObject({ bpm: 121, source: "manual" }); expect(p.settings.quantize).toEqual({ grid: "1/16", strength: .75 }); expect(p.mapping.kick).toBe(35);
    expect(p.source.hash).toBe(await contentTrackId(files["/a.wav"])); expect(p.analysis?.onsets.length).toBe(16);
    await vi.waitFor(() => expect(b.s.getState().source).toBe("ready"));
  }, 20000);

  it("a missing source keeps the notes; relink refuses different audio unless forced", async () => {
    const files: Record<string, ArrayBuffer> = { "/a.wav": loopWav() }; const a = setup(files); await a.s.init();
    await a.s.importRef("/a.wav", "a.wav"); await a.s.analyse(); await a.s.flush(); const hits = a.s.getState().project!.hits;
    delete files["/a.wav"]; files["/other.wav"] = loopWav(100); files["/moved.wav"] = loopWav();
    const b = setup(files, a.storage); await b.s.init(); await vi.waitFor(() => expect(b.s.getState().source).toBe("missing"));
    expect(b.s.getState().sourceError).toMatch(/unavailable/); expect(b.s.getState().project!.hits).toEqual(hits);
    expect(await b.s.relink(false, { ref: "/other.wav", name: "other.wav" })).toBe("mismatch"); expect(b.s.getState().project!.source.ref).toBe("/a.wav");
    expect(await b.s.relink(false, { ref: "/moved.wav", name: "moved.wav" })).toBe("ok"); expect(b.s.getState().source).toBe("ready"); expect(b.s.getState().project!.source.ref).toBe("/moved.wav");
  }, 20000);

  it("invalid or silent audio is reported, never crashes, and changes nothing", async () => {
    const { s } = setup({ "/bad.mp3": new TextEncoder().encode("not audio").buffer, "/empty.wav": new ArrayBuffer(0), "/silent.wav": encodeWav({ sampleRate: RATE, left: new Float32Array(RATE) }) });
    await s.importRef("/bad.mp3", "bad.mp3"); expect(s.getState().error).toMatch(/could not be decoded/); expect(s.getState().project).toBeNull();
    await s.importRef("/empty.wav", "empty.wav"); expect(s.getState().error).toMatch(/empty/);
    await s.importRef("/nope.wav", "nope.wav"); expect(s.getState().error).toMatch(/not found/);
    await s.importRef("/silent.wav", "silent.wav"); expect(s.getState().project).not.toBeNull(); await s.analyse();
    expect(s.getState().error).toMatch(/silent/); expect(s.getState().project!.hits).toEqual([]); expect(s.getState().analysis).toBeNull();
  });

  it("analysis can be cancelled and leaves the transcription untouched", async () => {
    const long = encodeWav({ sampleRate: RATE, left: render(pattern(120, { kick: "x...x...x...x..." }, 0, 10), 20) });
    const { s } = setup({ "/long.wav": long }); await s.importRef("/long.wav", "long.wav");
    const run = s.analyse(); await vi.waitFor(() => expect(s.getState().analysis?.stage).toBe("spectrum")); s.cancelAnalysis(); await run;
    expect(s.getState().project!.hits).toEqual([]); expect(s.getState().analysis).toBeNull(); expect(s.getState().message).toMatch(/cancelled/);
  }, 20000);

  it("grid precedence: a hand-edited library grid is inherited and survives analysis; a manual grid survives re-analysis", async () => {
    const wav = loopWav(); const hash = await contentTrackId(wav);
    const { s } = setup({ "/a.wav": wav }, memoryStorage(), { libraryGrid: (h) => (h === hash ? { bpm: 119.5, firstBeat: .02, confidence: 1, manual: true } : null) });
    await s.importRef("/a.wav", "a.wav"); expect(s.getState().project!.grid).toMatchObject({ bpm: 119.5, source: "library-manual" });
    await s.analyse(); expect(s.getState().project!.grid).toMatchObject({ bpm: 119.5, firstBeat: .02 });
    s.setGrid({ bpm: 60 }); await s.analyse(); expect(s.getState().project!.grid).toMatchObject({ bpm: 60, source: "manual" });
    s.resetGrid(); expect(s.getState().project!.grid.source).toBe("library-manual");
  }, 20000);

  it("full-song mode is refused honestly (Phase 2)", async () => {
    const { s } = setup({ "/a.wav": loopWav() }); await s.importRef("/a.wav", "a.wav"); s.setSettings({ mode: "song" }); await s.analyse();
    expect(s.getState().error).toMatch(/Phase 2/); expect(s.getState().project!.hits).toEqual([]);
  });

  it("drum map presets are saved and applied; MIDI export downloads a .mid", async () => {
    const { s, deps } = setup({ "/a.wav": loopWav() }); await s.init(); await s.importRef("/a.wav", "a.wav"); await s.analyse();
    s.setMapping("kick", 35); s.setMapping("unknown", 56); const preset = s.savePreset("My kit")!; s.resetMapping(); expect(s.getState().project!.mapping.kick).toBe(36);
    s.applyPreset(preset.id); expect(s.getState().project!.mapping).toMatchObject({ kick: 35, unknown: 56 }); expect(s.presets().map((x) => x.name)).toEqual(["My kit"]);
    const report = s.exportMidi()!; expect(report.notes).toBe(16);
    expect(deps.download).toHaveBeenCalledWith("a.mid", expect.any(Uint8Array), "audio/midi");
    expect(parseMidi(report.bytes).tracks[1].some((e) => e.type === "noteOn" && e.noteNumber === 35)).toBe(true);
  }, 20000);
});

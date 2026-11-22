/** Drum Transcriber → Arrangement placement, and the storage fallback for an Electron main that predates the doc kinds. */
import { describe, expect, it } from "vitest";
import { arrangementClip, sendToArrangement, type ArrangementTarget } from "../src/production/drums/toArrangement";
import { DRUM_SCHEMA, GM_DRUM_MAP, defaultSettings, type DrumHit, type DrumTranscription } from "../src/production/drums/types";
import type { MidiNote, ProductionTrack } from "../src/production/types";
import { DocStore, LocalStorageDocs, withLocalFallback, type DocPersistence } from "../src/setstudio/DocStore";

const hit = (id: string, lane: DrumHit["lane"], time: number, velocity: number | null = 100): DrumHit => ({ id, lane, time, onset: time, detected: lane, confidence: .9, strength: .8, velocity, review: null, group: null });
const proj = (hits: DrumHit[], bpm = 100, ref = "/stem.wav"): DrumTranscription => ({ schemaVersion: DRUM_SCHEMA, id: "drumtx_a", name: "Hey", createdAt: 1, updatedAt: 1,
  source: { ref, name: "stem.wav", hash: "h", duration: 10, sampleRate: 48000, channels: 2, origin: "arrangement" }, grid: { bpm, firstBeat: 0, beatsPerBar: 4, source: "detected", confidence: 1 },
  hits, mapping: { ...GM_DRUM_MAP }, mappingPresetId: null, settings: defaultSettings(), analysis: null });

function fakeStudio(bpm: number, tracks: Partial<ProductionTrack>[] = [], position = 0) {
  const state = { project: { bpm, tracks: tracks as ProductionTrack[] }, position };
  const added: { trackId: string; clip: { name: string; start: number; duration: number; notes: Omit<MidiNote, "id">[] } }[] = []; const newTracks: string[] = [];
  const studio: ArrangementTarget = {
    getState: () => state,
    updateProject: (patch) => { state.project = { ...state.project, ...patch }; },
    addInstrumentTrack: (_type, o) => { newTracks.push(o.name ?? ""); return `track_${newTracks.length}`; },
    addMidiClip: (trackId, clip) => { added.push({ trackId, clip }); return "clip_1"; },
  };
  return { studio, added, newTracks, state };
}

describe("send to Arrangement", () => {
  it("lines notes up under the source clip (offset + start), at the arrangement tempo, skipping unmapped and out-of-region hits", () => {
    const p = proj([hit("a", "kick", 1), hit("b", "snare", 1.6), hit("c", "unknown", 2), hit("d", "kick", 9.5)]);
    const anchor = { start: 30, offset: .4, duration: 8 }; // clip shows source 0.4–8.4 s, starting at arrangement 30 s
    const c = arrangementClip(p, 120, anchor);
    expect(c.start).toBe(30); expect(c.skipped).toBe(1); expect(c.outside).toBe(1);
    expect(c.notes.map((n) => [n.pitch, n.start, n.velocity, n.channel])).toEqual([[36, 1.2, 100, 10], [38, 2.4, 100, 10]]); // (1−.4)·2 beats/s
  });
  it("finds the source clip in the arrangement; matching tempo converts with the transcription's BPM", () => {
    const tracks = [{ name: "Drums stem", clips: [{ type: "audio", ref: "/stem.wav", start: 12, offset: 0, duration: 10 }] }] as unknown as ProductionTrack[];
    const f = fakeStudio(120, tracks);
    const r = sendToArrangement(f.studio, proj([hit("a", "kick", 0), hit("b", "kick", .6)], 100), { matchTempo: true });
    expect(f.state.project.bpm).toBe(100); expect(r.bpm).toBe(100); expect(r.alignedTo).toBe("Drums stem"); expect(r.start).toBe(12);
    expect(f.added[0].clip.notes.map((n) => n.start)).toEqual([0, 1]); expect(f.newTracks).toEqual(["Hey (MIDI)"]);
  });
  it("keeping the arrangement tempo still plays notes at the right seconds; a file source goes at the playhead", () => {
    const f = fakeStudio(120, [], 4);
    const r = sendToArrangement(f.studio, proj([hit("a", "kick", .5)], 100, "/file.wav"), { matchTempo: false });
    expect(f.state.project.bpm).toBe(120); expect(r.start).toBe(4); expect(r.alignedTo).toBeNull(); expect(f.added[0].clip.notes[0].start).toBe(1); // .5 s at 120 BPM
  });
  it("a hit at 0 s quantised to a bar line just before the audio stays at 0 and is sent (regression)", () => {
    const p = proj([hit("a", "kick", 0), hit("b", "kick", .5)], 119.98); p.grid.firstBeat = 1.99512; p.settings.quantize = { grid: "1/16", strength: 1 };
    const c = arrangementClip(p, 119.98, { start: 0, offset: 0, duration: 10 });
    expect(c.outside).toBe(0); expect(c.notes).toHaveLength(2); expect(c.notes[0].start).toBe(0);
    expect(arrangementClip(p, 120, { start: 5, offset: 1, duration: 2 }).outside).toBe(2); // genuinely outside stays out
  });
  it("refuses an empty send with a readable reason", () => {
    expect(() => sendToArrangement(fakeStudio(120).studio, proj([hit("a", "unknown", 1)]), { matchTempo: false })).toThrow(/unmapped/);
  });
});

describe("document storage fallback", () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  it("saves to localStorage when the desktop store refuses the kind, and lists both (newest wins)", async () => {
    const refusing: DocPersistence = { list: async () => { throw new Error("Error invoking remote method 'dbdj:docs:load': Error: Invalid document kind"); }, save: async () => { throw new Error("Error: Invalid document kind"); }, remove: async () => { throw new Error("Invalid document kind"); } };
    const store = withLocalFallback(refusing, new LocalStorageDocs("t.", memory()));
    await store.save("drumtx", { id: "drumtx_1", updatedAt: 5 }); expect(await store.list("drumtx")).toEqual([{ id: "drumtx_1", updatedAt: 5 }]);
    const errors: unknown[] = []; const docs = new DocStore("drumtx", store, (r) => r as { id: string; updatedAt: number }, (e) => errors.push(e));
    await docs.load(); docs.save({ id: "drumtx_2", updatedAt: 6 }); await docs.flush(); expect(errors).toEqual([]);
    await store.remove("drumtx", "drumtx_1"); expect((await store.list("drumtx")).map((d) => (d as { id: string }).id)).toEqual(["drumtx_2"]);
  });
  it("other errors are not hidden", async () => {
    const broken: DocPersistence = { list: async () => [], save: async () => { throw new Error("disk full"); }, remove: async () => undefined };
    await expect(withLocalFallback(broken, new LocalStorageDocs("t.", memory())).save("drumtx", { id: "drumtx_1", updatedAt: 1 })).rejects.toThrow(/disk full/);
  });
  it("merges: a newer local copy beats an older desktop copy", async () => {
    const desktop: DocPersistence = { list: async () => [{ id: "x_1", updatedAt: 1, v: "old" }], save: async () => undefined, remove: async () => undefined };
    const local = new LocalStorageDocs("t.", memory()); await local.save("drumtx", { id: "x_1", updatedAt: 9, v: "new" } as never);
    expect(await withLocalFallback(desktop, local).list("drumtx")).toEqual([{ id: "x_1", updatedAt: 9, v: "new" }]);
  });
});

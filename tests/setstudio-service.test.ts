import { describe, expect, it, vi } from "vitest";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { PreparationStore, effectiveEnergy } from "../src/preparation/PreparationStore";
import { packWaveform, type PreparationPersistence, type TrackPreparation, type WaveformRecord } from "../src/preparation/types";
import type { TrackInfo } from "../src/core/engine/types";
import type { AnalysisProgress } from "../src/analysis/AnalysisService";
import type { PlaylistPersistence } from "../src/platform";
import { LibraryIntelligence } from "../src/setstudio/LibraryIntelligence";
import { SetStudioService } from "../src/setstudio/SetStudioService";
import { SetStore } from "../src/setstudio/SetStore";
import { Emitter } from "../src/core/events";
import { ops } from "../src/setstudio/editor";
import { synth } from "./setstudio-helpers";
import { isExcluded, scoreCandidate } from "../src/setstudio/scoring";

const keys = ["8A", "9A", "8A", "10A", "3B", "9A", "8B", "7A"];
const lib: TrackInfo[] = keys.map((_, i) => ({ ref: `/m/${i}.mp3`, title: `Song ${i}`, artist: `Artist ${i}`, album: "", source: "local", bpm: 120 + i, key: null, genre: i % 2 ? "House / Deep House" : "House", durationMs: (240 + i * 20) * 1000 }));
const keyName: Record<string, string> = { "8A": "Am", "9A": "Em", "10A": "Bm", "3B": "Db", "8B": "C", "7A": "Dm" };

function prepRecord(i: number, analysed = true): TrackPreparation {
  return { schemaVersion: 1, trackId: `sha256:${i}`, refs: [lib[i].ref], fileSize: 1, title: lib[i].title, artist: lib[i].artist, album: "", isrc: null, duration: 240 + i * 20,
    bpm: 120 + i, key: keyName[keys[i]], keyConfidence: 0.5, energy: analysed ? 3 + i * 0.7 : null, energyConfidence: 0.5, sections: [], recommendedCues: [], gain: null,
    analysisVersion: analysed ? 1 : null, analysedAt: analysed ? 1000 + i : null, updatedAt: 1, beatGrid: null, cuePoint: 0, cues: [{ slot: 0, type: "hotcue", timestamp: 12, name: "Mine", colour: "#fff", source: "manual" }], savedLoops: [], lastLoop: null };
}

class FakeAnalysis extends Emitter<{ change: AnalysisProgress }> {
  state: AnalysisProgress = { busy: false, done: 0, total: 0, current: "", errors: [], skipped: [], cacheHits: 0, runs: 0 };
  calls: string[][] = [];
  constructor(private prep: PreparationStore, private waves: Map<string, WaveformRecord>) { super(); }
  getState() { return this.state; }
  cancelBatch() {}
  async analyseTracks(tracks: TrackInfo[]) {
    this.calls.push(tracks.map((t) => t.ref));
    for (const t of tracks) {
      const i = lib.findIndex((x) => x.ref === t.ref);
      if (i === 7) { this.state = { ...this.state, errors: [...this.state.errors, `${t.artist} – ${t.title}: decode failed`] }; continue; }
      const rec = this.prep.forRef(t.ref)!;
      this.waves.set(rec.trackId, packWaveform(rec.trackId, synth({ kickEvery: 0.5, hatEvery: 0.25 }), 5000 + i));
      // Simulates PreparationStore.saveAnalysis: analysis fields change, cues untouched.
      (this.prep as unknown as { commit(r: TrackPreparation): void }).commit({ ...rec, analysisVersion: 1, analysedAt: 5000 + i, energy: 5 });
    }
  }
}

async function setup(opts: { unanalysed?: number[] } = {}) {
  const waves = new Map<string, WaveformRecord>();
  const records = lib.map((_, i) => prepRecord(i, !opts.unanalysed?.includes(i)));
  for (const r of records) if (r.analysisVersion !== null) waves.set(r.trackId, packWaveform(r.trackId, synth({ kickEvery: 0.5, hatEvery: r.trackId.endsWith("3") ? 0.125 : 0, pad: r.trackId.endsWith("0") ? 0.5 : 0 }), r.analysedAt!));
  const saved: TrackPreparation[] = [];
  const persistence: PreparationPersistence = { list: async () => structuredClone(records), save: async (r) => void saved.push(r), loadWaveform: async (id) => waves.get(id) ?? null, saveWaveform: async (w) => void waves.set(w.trackId, w) };
  const preparation = new PreparationStore(persistence); await preparation.ready;
  const library = new LibraryStore(); library.hydrate(lib.map((t) => ({ ...t })));
  const plRows = new Map(); const plPersist: PlaylistPersistence = { load: async () => [...plRows.values()], save: async (p) => void plRows.set(p.id, structuredClone(p)), remove: async (id) => void plRows.delete(id) };
  const playlists = new PlaylistStore(plPersist); await playlists.load();
  const analysis = new FakeAnalysis(preparation, waves);
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const intel = new LibraryIntelligence({ library, preparation, analysis, storage, yieldFn: async () => undefined });
  const setDb = new Map<string, unknown>();
  const store = new SetStore({ list: async () => [...setDb.values()], save: async (s) => void setDb.set(s.id, structuredClone(s)), remove: async (id) => void setDb.delete(id) });
  await store.load();
  const autoDJ = { getState: () => ({ status: "OFF", played: [] as string[] }), start: vi.fn(async () => undefined), playNextRefs: vi.fn(), add: vi.fn() };
  const engine = { loadTrack: vi.fn(async () => undefined) };
  const studio = new SetStudioService({ library, preparation, playlists, store, intel, autoDJ, engine });
  return { preparation, library, playlists, analysis, intel, store, studio, storage, mem, autoDJ, engine, waves, saved };
}

describe("Library Intelligence", () => {
  it("analyses only unanalysed tracks through the existing analysis service, derives set features and keeps cues", async () => {
    const { intel, analysis, preparation } = await setup({ unanalysed: [6, 7] });
    await intel.analyse();
    expect(analysis.calls).toEqual([["/m/6.mp3", "/m/7.mp3"]]);
    const s = intel.getState();
    expect(s.items.find((i) => i.ref === "/m/7.mp3")).toMatchObject({ status: "failed", message: "decode failed" });
    expect(s.items.filter((i) => i.status === "done")).toHaveLength(7);
    const r = preparation.get("sha256:6")!;
    expect(r.intel?.energy).toBeGreaterThan(1);
    expect(r.intel?.derivedFrom).toBe(r.analysedAt);
    expect(r.cues).toEqual([expect.objectContaining({ name: "Mine", timestamp: 12 })]);
    expect(intel.coverage()).toMatchObject({ local: 8, analysed: 7, intel: 7, stale: 0 });
  });

  it("skips unchanged tracks with valid cached intel on the next run", async () => {
    const { intel } = await setup();
    await intel.analyse();
    await intel.analyse();
    expect(intel.getState().items.every((i) => i.status === "cached")).toBe(true);
    expect(intel.getState().lastRun).toMatchObject({ done: 0, cached: 8 });
  });

  it("keeps user overrides when re-deriving, and the original value stays available", async () => {
    const { intel, preparation, studio } = await setup();
    await intel.analyse();
    intel.setOverrides("sha256:2", { energy: 9.5, moods: ["dark"] });
    await intel.analyse(undefined, { force: true }); // full re-analysis + re-derivation
    const r = preparation.get("sha256:2")!;
    expect(r.setOverrides).toMatchObject({ energy: 9.5, moods: ["dark"] });
    const derived = r.intel!.energy;
    expect(derived).not.toBe(9.5); // the analysed value is kept separately
    expect(r.intel!.derivedFrom).toBe(r.analysedAt);
    expect(effectiveEnergy(r)).toBe(9.5);
    await Promise.resolve();
    expect(studio.profile("/m/2.mp3")).toMatchObject({ energy: 9.5, energySource: "override", moods: ["dark"] });
    intel.setOverrides("sha256:2", null);
    expect(effectiveEnergy(preparation.get("sha256:2")!)).toBe(derived);
  });

  it("can be cancelled and resumed (pending work survives a restart)", async () => {
    const env = await setup();
    let n = 0;
    const intel = new LibraryIntelligence({ library: env.library, preparation: env.preparation, analysis: env.analysis, storage: env.storage, yieldFn: async () => { if (++n === 3) intel.cancel(); } });
    await intel.analyse();
    expect(intel.getState().lastRun?.cancelled).toBe(true);
    const left = intel.getState().resumable;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(8);
    const restarted = new LibraryIntelligence({ library: env.library, preparation: env.preparation, analysis: env.analysis, storage: env.storage, yieldFn: async () => undefined });
    expect(restarted.getState().resumable).toBe(left);
    await restarted.resume();
    expect(restarted.getState().resumable).toBe(0);
    expect(restarted.coverage().intel).toBe(8);
  });
});

describe("SetStudioService", () => {
  it("creates a set and produces real ranked recommendations from the library", async () => {
    const { studio, intel } = await setup();
    await intel.analyse();
    const set = studio.create({ name: "Test", mode: "curve", durationTargetSec: 1800, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 4 });
    studio.edit((s) => ops.assign(s, s.slots[0].id, studio.toRef(studio.profile("/m/0.mp3")!), 3));
    const rec = studio.recommend(studio.current()!, 1);
    expect(rec.ranked.length).toBe(7);
    expect(rec.ranked.some((r) => r.track.ref === "/m/0.mp3")).toBe(false);
    expect(rec.ranked[0].score).toBeGreaterThanOrEqual(rec.ranked[rec.ranked.length - 1].score);
    expect(rec.ranked[0].explanation).toMatch(/% match/);
    expect(set.slots).toHaveLength(4);
  });

  it("shows the same score for a track in the Recommended and Library views (one shared context)", async () => {
    const { studio, intel } = await setup();
    await intel.analyse();
    studio.create({ name: "Same", mode: "curve", durationTargetSec: 1800, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 3 });
    studio.edit((s) => ops.assign(s, s.slots[0].id, studio.toRef(studio.profile("/m/0.mp3")!), 3));
    const set = studio.current()!, ctx = studio.scoreContext(set, 1)!;
    for (const r of studio.recommend(set, 1).ranked) {
      const lib = scoreCandidate(r.track, ctx);
      expect(isExcluded(lib) ? null : (lib as { score: number }).score).toBe(r.score);
    }
    expect(studio.energySpan()).not.toBeNull();
  });

  it("recomputes targets and transitions when slots are reordered; undo restores", async () => {
    const { studio, intel } = await setup();
    await intel.analyse();
    studio.create({ name: "T", mode: "curve", durationTargetSec: 1200, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 3 });
    for (const [i, r] of ["/m/0.mp3", "/m/4.mp3", "/m/7.mp3"].entries()) studio.edit((s) => ops.assign(s, s.slots[i].id, studio.toRef(studio.profile(r)!), studio.profile(r)!.energy));
    const before = studio.view(studio.current()!);
    expect(before.transitions[0]?.warnings.join()).toMatch(/harmonic clash/);
    expect(studio.current()!.transitions).toHaveLength(2);
    studio.edit((s) => ops.moveSlot(s, 1, 3));
    const after = studio.view(studio.current()!);
    expect(after.slots.map((s) => s.track?.ref)).toEqual(["/m/0.mp3", "/m/7.mp3", "/m/4.mp3"]);
    expect(after.slots[2].target).not.toBe(before.slots[2].target);
    studio.undo();
    expect(studio.view(studio.current()!).slots.map((s) => s.track?.ref)).toEqual(["/m/0.mp3", "/m/4.mp3", "/m/7.mp3"]);
  });

  it("Auto Fill preview keeps locked anchors and only applies on request", async () => {
    const { studio, intel } = await setup();
    await intel.analyse();
    studio.create({ name: "F", mode: "curve", durationTargetSec: 1800, energyMin: 1, energyMax: 10, curveTemplate: "slow-burn", slotCount: 5 });
    studio.edit((s) => ops.assign(s, s.slots[2].id, studio.toRef(studio.profile("/m/5.mp3")!), 5));
    studio.edit((s) => ops.toggleLock(s, s.slots[2].id));
    const preview = studio.autoFillPreview(studio.current()!);
    expect(studio.current()!.slots.filter((s) => s.track)).toHaveLength(1);
    expect(preview.refs[2]).toBe("/m/5.mp3");
    studio.applyRefs(preview.refs, "filled");
    const slots = studio.current()!.slots;
    expect(slots.every((s) => s.track)).toBe(true);
    expect(slots[2]).toMatchObject({ isLocked: true, track: expect.objectContaining({ ref: "/m/5.mp3" }) });
    expect(new Set(slots.map((s) => s.track!.ref)).size).toBe(5);
  });

  it("Improve a Set never modifies the source playlist without confirmation", async () => {
    const { studio, playlists, intel } = await setup();
    await intel.analyse();
    const p = playlists.create("Gig", ["/m/0.mp3", "/m/4.mp3", "/m/1.mp3", "/m/6.mp3"]);
    const set = studio.importPlaylist(p.id)!;
    expect(set.mode).toBe("improve");
    expect(set.origin).toMatchObject({ kind: "playlist", sourceId: p.id, refs: ["/m/0.mp3", "/m/4.mp3", "/m/1.mp3", "/m/6.mp3"] });
    expect(set.origin!.energies.every((e) => e !== null)).toBe(true);
    // The "before" snapshot records the same states the builder shows for the original order.
    expect(set.origin!.transitionStates).toEqual(studio.view(set).transitions.map((t) => t?.state ?? null));
    const res = studio.resequencePreview(studio.current()!);
    studio.applyRefs(res.refs, "reseq");
    studio.edit((s) => ops.removeSlot(s, s.slots[3].id));
    expect(playlists.get(p.id)!.refs).toEqual(["/m/0.mp3", "/m/4.mp3", "/m/1.mp3", "/m/6.mp3"]);
    expect(studio.writeBackToPlaylist(false)).toBe(false);
    expect(playlists.get(p.id)!.refs).toHaveLength(4);
    const created = studio.loadToPlaylist(studio.current()!)!;
    expect(created.id).not.toBe(p.id);
    expect(created.refs).toHaveLength(3);
    expect(playlists.get(p.id)!.refs).toHaveLength(4);
    expect(studio.writeBackToPlaylist(true)).toBe(true);
    expect(playlists.get(p.id)!.refs).toEqual(studio.orderedRefs(studio.current()!));
  });

  it("resolves moved files by audio content and flags missing ones with a relink suggestion", async () => {
    const { studio, library, preparation } = await setup();
    const moved = studio.resolve({ trackId: "sha256:3", ref: "/old/path/3.mp3", title: "Song 3", artist: "Artist 3", durationSec: 300 });
    expect(moved).toMatchObject({ status: "moved", track: expect.objectContaining({ ref: "/m/3.mp3" }) });
    const missing = studio.resolve({ trackId: "sha256:nope", ref: "/gone.mp3", title: "Song 5", artist: "Artist 5", durationSec: 300 });
    expect(missing.status).toBe("missing");
    expect(missing.suggestion?.ref).toBe("/m/5.mp3");
    expect(library.getState().tracks).toHaveLength(8);
    expect(preparation.get("sha256:3")).toBeTruthy();
  });

  it("integrates with Auto DJ and the decks through their public APIs", async () => {
    const { studio, autoDJ, engine } = await setup();
    studio.create({ name: "AD", mode: "curve", durationTargetSec: 600, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 2 });
    studio.edit((s) => ops.assign(s, s.slots[0].id, studio.toRef(studio.profile("/m/1.mp3")!)));
    await studio.openInAutoDJ(studio.current()!);
    expect(autoDJ.start).toHaveBeenCalledTimes(1);
    await studio.sendToDeck("/m/1.mp3", 1);
    expect(engine.loadTrack).toHaveBeenCalledWith(1, expect.objectContaining({ ref: "/m/1.mp3" }), "manual");
    studio.queueNext("/m/2.mp3");
    expect(autoDJ.add).toHaveBeenCalledWith(["/m/2.mp3"]);
  });

  it("autosaves edits to the set store", async () => {
    vi.useFakeTimers();
    try {
      const { studio, store } = await setup();
      const s = studio.create({ name: "Auto", mode: "curve", durationTargetSec: 600, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 2 });
      studio.edit((x) => ops.rename(x, "Renamed"));
      expect(store.get(s.id)!.name).toBe("Auto");
      vi.advanceTimersByTime(500);
      expect(store.get(s.id)!.name).toBe("Renamed");
    } finally { vi.useRealTimers(); }
  });
});

describe("auditions without headphones", () => {
  function fakeDecks(opts: { playing?: number[]; crossfader?: number } = {}) {
    const decks = [0, 1].map((i) => ({ playing: !!opts.playing?.includes(i), track: null as TrackInfo | null, status: "empty", pos: 0 }));
    const calls: string[] = [];
    const engine = {
      getState: () => ({ decks, mixer: { crossfader: opts.crossfader ?? 0.5, channels: [{ volume: 1, mute: false }, { volume: 1, mute: false }] } }),
      loadTrack: async (d: number, t: TrackInfo) => { calls.push(`load${d}:${t.ref}`); decks[d].track = t; decks[d].status = "ready"; },
      seekTo: (d: number, s: number) => { calls.push(`seek${d}:${s}`); decks[d].pos = s; },
    };
    const play = (d: number, on: boolean) => { calls.push(`play${d}:${on}`); decks[d].playing = on; };
    return { engine, play, decks, calls };
  }
  async function make(f: ReturnType<typeof fakeDecks>, headphones = false) {
    const base = await setup();
    const toggles: [string, number | undefined][] = [];
    const preview = { state: { ref: null as string | null, status: "idle", available: headphones }, toggle: async (t: TrackInfo, o?: number) => { toggles.push([t.ref, o]); } };
    const studio = new SetStudioService({ library: base.library, preparation: base.preparation, playlists: base.playlists, store: base.store, intel: base.intel, engine: f.engine, play: f.play, preview });
    return { studio, toggles };
  }

  it("plays on Deck A from the cue when nothing is playing, and the same ▶ stops it", async () => {
    const f = fakeDecks(), { studio } = await make(f);
    expect(await studio.audition("/m/2.mp3", 42)).toBe("deck");
    expect(f.calls).toEqual(["load0:/m/2.mp3", "seek0:42", "play0:true"]);
    expect(studio.getState().audition).toMatchObject({ ref: "/m/2.mp3", where: "deck", deck: 0 });
    expect(await studio.audition("/m/2.mp3", 42)).toBe("stopped");
    expect(f.decks[0].playing).toBe(false);
    // Another cue of the same track jumps there instead of stopping.
    await studio.audition("/m/2.mp3", 42);
    expect(await studio.audition("/m/2.mp3", 90)).toBe("deck");
    expect(f.decks[0].pos).toBe(90);
  });

  it("never plays over a live deck — only cues the track, paused, on the free deck", async () => {
    const f = fakeDecks({ playing: [0] }), { studio } = await make(f);
    expect(await studio.audition("/m/3.mp3", 30)).toBe("cued");
    expect(f.calls).toEqual(["load1:/m/3.mp3", "seek1:30"]);
    expect(f.decks[0].playing).toBe(true);
    expect(f.decks[1].playing).toBe(false);
    const both = fakeDecks({ playing: [0, 1] }), b = await make(both);
    expect(await b.studio.audition("/m/3.mp3", 30)).toBe("none");
    expect(both.calls).toEqual([]);
  });

  it("uses the headphone preview (never the decks) when 4-channel routing exists", async () => {
    const f = fakeDecks(), { studio, toggles } = await make(f, true);
    expect(await studio.audition("/m/4.mp3", 12)).toBe("headphones");
    expect(toggles).toEqual([["/m/4.mp3", 12]]);
    expect(f.calls).toEqual([]);
  });

  it("uses Deck B when Deck A can't be heard (crossfader hard right)", async () => {
    const f = fakeDecks({ crossfader: 1 }), { studio } = await make(f);
    await studio.audition("/m/1.mp3", 5);
    expect(f.calls[0]).toBe("load1:/m/1.mp3");
  });
});

describe("hold-to-play hot cue pads", () => {
  function rig(opts: { playing?: number[]; hotcues?: (number | null)[]; headphones?: boolean; slowLoad?: boolean } = {}) {
    const decks = [0, 1].map((i) => ({ playing: !!opts.playing?.includes(i), track: null as TrackInfo | null, status: "empty", hotcues: [] as (number | null)[], pos: 0 }));
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const engine = {
      getState: () => ({ decks, mixer: { crossfader: 0.5, channels: [{ volume: 1, mute: false }, { volume: 1, mute: false }] } }),
      loadTrack: async (d: number, tr: TrackInfo) => { if (opts.slowLoad) await new Promise<void>((r) => (release = r)); calls.push(`load${d}`); decks[d].track = tr; decks[d].status = "ready"; decks[d].hotcues = opts.hotcues ?? []; },
      seekTo: (d: number, s: number) => { calls.push(`seek${d}:${s}`); decks[d].pos = s; },
    };
    const play = (d: number, on: boolean) => { calls.push(`play${d}:${on}`); decks[d].playing = on; };
    const send = (a: string, v: number) => calls.push(`${a}=${v}`);
    const stops: number[] = [], toggles: number[] = [];
    const preview = { state: { ref: null as string | null, status: "idle", available: !!opts.headphones }, toggle: async (_t: TrackInfo, o?: number) => void toggles.push(o ?? 0), stop: () => void stops.push(1) };
    return { engine, play, send, preview, decks, calls, stops, toggles, finishLoad: () => release() };
  }
  async function studioFor(r: ReturnType<typeof rig>) {
    const b = await setup();
    return new SetStudioService({ library: b.library, preparation: b.preparation, playlists: b.playlists, store: b.store, intel: b.intel, engine: r.engine, play: r.play, send: r.send, preview: r.preview });
  }

  it("uses the deck's own hot cue press/release when its pad holds this cue", async () => {
    const r = rig({ hotcues: [null, 64.2] }), s = await studioFor(r);
    expect(await s.holdStart("/m/1.mp3", 1, 64.2)).toBe("deck");
    expect(r.calls).toEqual(["load0", "deck1.hotcue.2=1"]);
    s.holdEnd();
    expect(r.calls.at(-1)).toBe("deck1.hotcue.2=0");
  });

  it("otherwise seeks and plays while held, then pauses back on the cue", async () => {
    const r = rig(), s = await studioFor(r);
    await s.holdStart("/m/1.mp3", 3, 30);
    expect(r.calls).toEqual(["load0", "seek0:30", "play0:true"]);
    r.decks[0].pos = 34;
    s.holdEnd();
    expect(r.calls.slice(-2)).toEqual(["play0:false", "seek0:30"]);
  });

  it("won't play into the room while another deck is playing", async () => {
    const r = rig({ playing: [1] }), s = await studioFor(r);
    expect(await s.holdStart("/m/1.mp3", 0, 10)).toBe("blocked");
    expect(r.calls).toEqual([]);
  });

  it("a tap released before the track finished loading just cues it", async () => {
    const r = rig({ slowLoad: true }), s = await studioFor(r);
    const p = s.holdStart("/m/1.mp3", 0, 12);
    s.holdEnd();
    r.finishLoad(); await p;
    expect(r.calls).toEqual(["load0", "seek0:12"]);
    expect(r.decks[0].playing).toBe(false);
  });

  it("uses the headphones when available and stops on release", async () => {
    const r = rig({ headphones: true }), s = await studioFor(r);
    expect(await s.holdStart("/m/1.mp3", 0, 50)).toBe("headphones");
    expect(r.toggles).toEqual([50]);
    s.holdEnd();
    expect(r.stops).toHaveLength(1);
    expect(r.calls).toEqual([]);
  });
});

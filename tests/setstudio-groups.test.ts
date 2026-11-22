import { describe, expect, it } from "vitest";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { PreparationStore } from "../src/preparation/PreparationStore";
import type { PreparationPersistence, TrackPreparation } from "../src/preparation/types";
import type { TrackInfo } from "../src/core/engine/types";
import { BlendGroupService, constraintMisses, migrateGroup, migrateJourney, type BlendGroup, type GroupJourney } from "../src/setstudio/BlendGroups";
import { DocStore, type DocPersistence } from "../src/setstudio/DocStore";
import { LibraryIntelligence } from "../src/setstudio/LibraryIntelligence";
import { SetStudioService } from "../src/setstudio/SetStudioService";
import { SetStore } from "../src/setstudio/SetStore";
import { ops } from "../src/setstudio/editor";
import { isExcluded, scoreCandidate } from "../src/setstudio/scoring";
import { Emitter } from "../src/core/events";

const KEYS = ["Am", "Em", "Am", "Bm", "C", "Em", "G", "Dm", "Am", "Em", "F#m", "Am"];
const lib: TrackInfo[] = KEYS.map((_, i) => ({ ref: `/m/${i}.mp3`, title: `Song ${i}`, artist: `Artist ${i}`, album: "", source: "local", bpm: 118 + i, key: null, genre: i < 6 ? "House" : "Disco", durationMs: 300_000 }));
const rec = (i: number): TrackPreparation => ({ schemaVersion: 1, trackId: i === 11 ? "sha256:5" : `sha256:${i}`, refs: [lib[i].ref], fileSize: 1, title: lib[i].title, artist: lib[i].artist, album: "", isrc: null, duration: 300,
  bpm: 118 + i, key: KEYS[i], keyConfidence: 0.5, energy: 2 + (i % 9), energyConfidence: 0.5, sections: [], recommendedCues: [], gain: null, analysisVersion: 1, analysedAt: 1, updatedAt: 1, beatGrid: null, cuePoint: 0, cues: [], savedLoops: [], lastLoop: null });

function memDocs(): DocPersistence & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return { rows, list: async (k) => [...rows].filter(([key]) => key.startsWith(k + "/")).map(([, v]) => v), save: async (k, d) => void rows.set(`${k}/${d.id}`, structuredClone(d)), remove: async (k, id) => void rows.delete(`${k}/${id}`) };
}
class NoAnalysis extends Emitter<{ change: never }> { getState() { return { busy: false, done: 0, total: 0, current: "", errors: [], skipped: [], cacheHits: 0, runs: 0 }; } cancelBatch() {} async analyseTracks() {} }

async function setup() {
  // Track 11 is a second copy of track 5's audio (same content hash).
  const records = lib.map((_, i) => rec(i)).filter((_, i) => i !== 11);
  records[5].refs.push(lib[11].ref);
  const persistence: PreparationPersistence = { list: async () => structuredClone(records), save: async () => undefined, loadWaveform: async () => null, saveWaveform: async () => undefined };
  const preparation = new PreparationStore(persistence); await preparation.ready;
  const library = new LibraryStore(); library.hydrate(lib.map((t) => ({ ...t })));
  const playlists = new PlaylistStore(null); await playlists.load();
  const store = new SetStore(null); await store.load();
  const intel = new LibraryIntelligence({ library, preparation, analysis: new NoAnalysis() as never, storage: null });
  const studio = new SetStudioService({ library, preparation, playlists, store, intel });
  const docs = memDocs();
  const groupDocs = new DocStore<BlendGroup>("group", docs, migrateGroup), journeyDocs = new DocStore<GroupJourney>("journey", docs, migrateJourney);
  await groupDocs.load(); await journeyDocs.load();
  const deleted: string[] = [];
  const groups = new BlendGroupService({ groups: groupDocs, journeys: journeyDocs, pool: () => studio.pool(), resolve: (r) => studio.resolve(r).track, toRef: (t) => studio.toRef(t),
    usedInSets: () => new Set(store.getState().sets.flatMap((s) => s.slots.map((x) => x.track?.ref).filter((r): r is string => !!r))), recentlyPlayed: () => new Set(), onDeleted: (id) => { deleted.push(id); studio.onGroupDeleted(id); } });
  studio.attachGroups(groups);
  const p = (i: number) => studio.profile(lib[i].ref)!;
  return { studio, groups, groupDocs, docs, library, store, deleted, p };
}

describe("Blend Steering Groups", () => {
  it("creates, edits, duplicates and persists groups", async () => {
    const { groups, docs, p } = await setup();
    const g = groups.create("Warm-Up", { description: "Early doors" });
    expect(g).toMatchObject({ energyMin: 2, energyMax: 5, orderingMode: "flexible" });
    expect(groups.addTracks(g.id, [p(0), p(1), p(2)])).toBe(3);
    groups.update(g.id, { name: "Warm-Up (Fri)", bpmMin: 118, colour: "#ff4fb8" });
    const copy = groups.duplicate(g.id)!;
    expect(copy.tracks).toHaveLength(3);
    expect(copy.id).not.toBe(g.id);
    await new Promise((r) => setTimeout(r, 0));
    const reloaded = new DocStore<BlendGroup>("group", docs, migrateGroup); await reloaded.load();
    expect(reloaded.get(g.id)).toMatchObject({ name: "Warm-Up (Fri)", bpmMin: 118, description: "Early doors" });
    expect(reloaded.get(g.id)!.tracks.map((t) => t.ref.ref)).toEqual([lib[0].ref, lib[1].ref, lib[2].ref]);
  });

  it("skips duplicates by path and by audio content, and honours the membership lock", async () => {
    const { groups, p } = await setup();
    const g = groups.create("Vocal House");
    expect(groups.addTracks(g.id, [p(5), p(5), p(11)])).toBe(1); // 11 is the same audio as 5
    groups.update(g.id, { locked: true });
    expect(groups.addTracks(g.id, [p(6)])).toBe(0);
    expect(groups.removeTrack(g.id, lib[5].ref)).toBe(false);
    expect(groups.get(g.id)!.tracks).toHaveLength(1);
  });

  it("deleting a group never deletes tracks, and removes it from sets and journeys", async () => {
    const { groups, studio, library, deleted, p } = await setup();
    const g = groups.create("Peak Time");
    groups.addTracks(g.id, [p(7), p(8)]);
    groups.saveJourney({ id: "journey_1", name: "Night", groupIds: [g.id] });
    studio.create({ name: "S", mode: "curve", durationTargetSec: 3600, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 6 });
    studio.edit((s) => ops.addSection(s, g.id, 0.5, 1));
    await groups.remove(g.id);
    expect(deleted).toEqual([g.id]);
    expect(library.getState().tracks).toHaveLength(12);
    expect(studio.current()!.groupSections).toEqual([]);
    expect(groups.journeys()[0].groupIds).toEqual([]);
  });

  it("suggestions come from the Phase 1 scorer (same numbers)", async () => {
    const { groups, p } = await setup();
    const g = groups.create("House", { energyMin: 1, energyMax: 10 });
    groups.addTracks(g.id, [p(0)]);
    const s = groups.suggest(g.id, "similar");
    expect(s.length).toBeGreaterThan(0);
    for (const r of s.slice(0, 5)) {
      const direct = scoreCandidate(r.track, { prev: p(0), targetEnergy: p(0).energy, move: "keep" });
      expect(isExcluded(direct) ? null : (direct as { score: number }).score).toBe(r.score);
    }
    expect(s.some((r) => r.track.ref === lib[0].ref)).toBe(false);
    // Same audio is suggested once.
    expect(s.filter((r) => r.track.trackId === "sha256:5").length).toBeLessThanOrEqual(1);
    expect(groups.suggest(g.id, "higher").every((r) => (r.track.energy ?? 0) >= 0)).toBe(true);
    const bridges = groups.suggest(g.id, "bridges");
    expect(bridges.every((r) => r.track.genre !== "House")).toBe(true);
    const expand = groups.suggest(groups.create("Tight", { energyMin: 5, energyMax: 6 }).id, "expand");
    expect(expand.every((r) => !constraintMisses(groups.get(groups.all()[0].id)!, r.track).length)).toBe(true);
  });

  it("stats stay pair-specific and flexible groups keep no imposed order", async () => {
    const { groups, p } = await setup();
    const g = groups.create("Mix", { energyMin: 1, energyMax: 10 });
    groups.addTracks(g.id, [p(3), p(0), p(4)]);
    const st = groups.stats(g.id)!;
    expect(st.count).toBe(3);
    expect(st.pairs.green + st.pairs.amber + st.pairs.red).toBe(3 * 2);
    const order = groups.suggestedOrder(g.id);
    expect([...order].sort()).toEqual([lib[0].ref, lib[3].ref, lib[4].ref].sort());
    expect(groups.get(g.id)!.tracks.map((t) => t.ref.ref)).toEqual([lib[3].ref, lib[0].ref, lib[4].ref]); // unchanged until applied
    groups.applyOrder(g.id, order);
    expect(groups.get(g.id)!.orderingMode).toBe("ordered");
  });

  it("steers into a destination group and finds bridges between groups", async () => {
    const { groups, p } = await setup();
    const a = groups.create("Low", { energyMin: 1, energyMax: 5 }), b = groups.create("High", { energyMin: 6, energyMax: 10 });
    groups.addTracks(a.id, [p(0), p(1)]); groups.addTracks(b.id, [p(6), p(7)]);
    const into = groups.steerInto(lib[1].ref, b.id, "lift");
    expect(into.map((r) => r.track.ref).sort()).toEqual([lib[6].ref, lib[7].ref].sort());
    const br = groups.bridges(a.id, b.id);
    expect(br.every((r) => ![0, 1, 6, 7].some((i) => lib[i].ref === r.track.ref))).toBe(true);
  });
});

describe("groups in the set builder", () => {
  it("assigns a group to a curve section; Auto Fill draws only from the group there", async () => {
    const { groups, studio, p } = await setup();
    const peak = groups.create("Peak", { energyMin: 1, energyMax: 10 });
    groups.addTracks(peak.id, [p(8), p(9), p(10)]);
    studio.create({ name: "Sections", mode: "curve", durationTargetSec: 1500, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 5 });
    studio.edit((s) => ops.addSection(s, peak.id, 0.6, 1));
    const set = studio.current()!;
    const inSection = set.slots.map((_, i) => studio.sectionAt(set, i)?.groupId === peak.id);
    expect(inSection.some(Boolean)).toBe(true);
    const r = studio.autoFillPreview(set);
    r.refs.forEach((ref, i) => { if (inSection[i] && ref) expect([8, 9, 10].map((k) => lib[k].ref)).toContain(ref); });
  });

  it("Auto Fill from a group fills only that section, anchors first", async () => {
    const { groups, studio, p } = await setup();
    const g = groups.create("Warm", { energyMin: 1, energyMax: 10 });
    groups.addTracks(g.id, [p(0), p(1), p(2)]);
    groups.setTrack(g.id, lib[2].ref, { isAnchor: true });
    studio.create({ name: "G", mode: "curve", durationTargetSec: 1500, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 5 });
    studio.edit((s) => ops.addSection(s, g.id, 0, 0.45));
    const set = studio.current()!, sec = set.groupSections![0];
    const r = studio.autoFillPreview(set, { sectionId: sec.id });
    const inSec = set.slots.map((_, i) => studio.sectionAt(set, i)?.id === sec.id);
    r.refs.forEach((ref, i) => { if (!inSec[i]) expect(ref).toBeNull(); });
    expect(r.refs).toContain(lib[2].ref);
  });

  it("a set group can link to a reusable group and is reused across sets", async () => {
    const { groups, studio, p } = await setup();
    const g = groups.create("Disco Groove", { energyMin: 1, energyMax: 10 });
    groups.addTracks(g.id, [p(6), p(7)]);
    for (const name of ["One", "Two"]) {
      const s = studio.create({ name, mode: "groups", durationTargetSec: 3600, energyMin: 1, energyMax: 10, curveTemplate: "freehand", slotCount: 0, groups: ["Disco"] });
      studio.edit((x) => ops.linkGroup(x, s.groups[0].id, g.id));
      expect(studio.orderedRefs(studio.current()!)).toEqual([lib[6].ref, lib[7].ref]);
    }
    groups.addTracks(g.id, [p(8)]);
    expect(studio.orderedRefs(studio.current()!)).toHaveLength(3); // live membership
  });
});

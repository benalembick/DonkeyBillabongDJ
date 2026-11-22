import { describe, expect, it } from "vitest";
import { LocalStorageSets, migrateSet, SetStore } from "../src/setstudio/SetStore";
import { createSet, History, ops } from "../src/setstudio/editor";
import { fromNative, toM3U8, toNative } from "../src/setstudio/exporters";
import type { DJSet, SetPersistence } from "../src/setstudio/types";

function memory(): SetPersistence & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return { rows, list: async () => [...rows.values()], save: async (s) => void rows.set(s.id, structuredClone(s)), remove: async (id) => void rows.delete(id) };
}
const ref = (n: string, d = 300) => ({ trackId: `sha256:${n}`, ref: `/music/${n}.mp3`, title: n, artist: "Artist", durationSec: d });
const base = () => createSet({ name: "Friday", mode: "curve", durationTargetSec: 3600, energyMin: 2, energyMax: 9, curveTemplate: "slow-burn", slotCount: 4 });

describe("SetStore persistence", () => {
  it("saves, reopens after a restart, duplicates, renames and deletes", async () => {
    const db = memory(), store = new SetStore(db);
    await store.load();
    let s = base();
    s = ops.assign(s, s.slots[0].id, ref("one"), 4);
    s = ops.toggleLock(s, s.slots[0].id);
    s = ops.setNotes(s, s.slots[0].id, "open with the dub");
    store.save(s);
    await store.flush();

    const reopened = new SetStore(db); await reopened.load();
    const back = reopened.get(s.id)!;
    expect(back.slots[0]).toMatchObject({ track: ref("one"), isLocked: true, isAnchor: true, notes: "open with the dub" });
    expect(back.curveControlPoints).toEqual(s.curveControlPoints);
    expect(back.profile.weights.energy).toBe(25);

    const copy = reopened.duplicate(s.id)!;
    expect(copy.id).not.toBe(s.id);
    expect(copy.name).toBe("Friday copy");
    expect(copy.slots[0].id).not.toBe(s.slots[0].id);
    expect(copy.slots[0].track).toEqual(ref("one"));
    const v2 = reopened.duplicate(s.id, true)!;
    expect(v2).toMatchObject({ version: 2, parentId: s.id, name: "Friday (v2)" });

    reopened.rename(s.id, "Saturday");
    await reopened.remove(copy.id);
    await reopened.flush();
    const third = new SetStore(db); await third.load();
    expect(third.getState().sets.map((x) => x.name).sort()).toEqual(["Friday (v2)", "Saturday"]);
  });

  it("keeps documents from a newer schema untouched and reports them", async () => {
    const db = memory();
    db.rows.set("set_future", { id: "set_future", name: "Future", schemaVersion: 99, slots: [] });
    const errors: unknown[] = [], store = new SetStore(db, (e) => errors.push(e));
    await store.load();
    expect(store.getState().sets).toHaveLength(0);
    expect(store.getState().unreadable).toBe(1);
    expect(db.rows.has("set_future")).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("migrates older/partial documents with defaults", () => {
    const m = migrateSet({ id: "set_old", name: "Old", slots: [{ track: ref("x") }] });
    expect(m.schemaVersion).toBe(1);
    expect(m.slots[0]).toMatchObject({ position: 0, isLocked: false, flexible: false, notes: "" });
    expect(m.profile.energyDirection).toBe("keep");
  });

  it("browser fallback persists in storage", async () => {
    const mem = new Map<string, string>(), ls = new LocalStorageSets("k", { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
    const s = base(); await ls.save(s);
    expect((await ls.list()).length).toBe(1);
    await ls.remove(s.id);
    expect(await ls.list()).toEqual([]);
  });
});

describe("set editing", () => {
  it("adds, removes and reorders slots and renumbers positions", () => {
    let s = base();
    s = ops.assign(s, s.slots[0].id, ref("a"));
    s = ops.assign(s, s.slots[1].id, ref("b"));
    s = ops.moveSlot(s, 0, 2);
    expect(s.slots.map((x) => x.track?.title ?? null)).toEqual(["b", "a", null, null]);
    expect(s.slots.map((x) => x.position)).toEqual([0, 1, 2, 3]);
    s = ops.addSlot(s, 1);
    expect(s.slots).toHaveLength(5);
    s = ops.removeSlot(s, s.slots[1].id);
    expect(s.slots.map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });
  it("places into the next empty slot, growing the set when full", () => {
    let s = createSet({ name: "x", mode: "curve", durationTargetSec: 600, energyMin: 1, energyMax: 10, curveTemplate: "opener", slotCount: 1 });
    s = ops.place(s, ref("a"), 3);
    s = ops.place(s, ref("b"), 5);
    expect(s.slots.map((x) => x.track?.title)).toEqual(["a", "b"]);
  });
  it("flexible slots hold no track and anchors require a track", () => {
    let s = base();
    s = ops.toggleLock(s, s.slots[0].id);
    expect(s.slots[0].isLocked).toBe(false);
    s = ops.toggleFlexible(s, s.slots[1].id);
    expect(s.slots[1]).toMatchObject({ flexible: true, track: null });
  });
  it("applyRefs never overwrites locked slots", () => {
    let s = base();
    s = ops.assign(s, s.slots[0].id, ref("anchor")); s = ops.toggleLock(s, s.slots[0].id);
    s = ops.applyRefs(s, ["other", "b", null, "c"], (r) => ({ track: ref(r), energy: 5 }));
    expect(s.slots.map((x) => x.track?.title ?? null)).toEqual(["anchor", "b", null, "c"]);
  });
  it("undo/redo across edits", () => {
    const h = new History<DJSet>(base());
    const a = h.push(ops.rename(h.current, "One")); h.push(ops.rename(a, "Two"));
    expect(h.undo()!.name).toBe("One");
    expect(h.undo()!.name).toBe("Friday");
    expect(h.undo()).toBeNull();
    expect(h.redo()!.name).toBe("One");
    h.push(ops.rename(h.current, "Three"));
    expect(h.canRedo).toBe(false);
    const start = h.current; h.replace(ops.rename(h.current, "drag1")); h.replace(ops.rename(h.current, "drag2")); h.commitFrom(start);
    expect(h.current.name).toBe("drag2");
    expect(h.undo()!.name).toBe("Three");
  });
  it("anchors in the wizard are locked and never collide", () => {
    const s = createSet({ name: "A", mode: "anchors", durationTargetSec: 3600, energyMin: 1, energyMax: 10, curveTemplate: "anchors", slotCount: 5,
      anchors: [{ index: 0, track: ref("open"), energy: 3 }, { index: 3, track: ref("peak1"), energy: 9 }, { index: 3, track: ref("peak2"), energy: 9 }, { index: 4, track: ref("close"), energy: 6 }] });
    expect(s.slots.filter((x) => x.isLocked).map((x) => x.track!.title).sort()).toEqual(["close", "open", "peak1", "peak2"]);
  });
  it("groups mode creates default phase groups without fixed order", () => {
    const s = createSet({ name: "G", mode: "groups", durationTargetSec: 3600, energyMin: 1, energyMax: 10, curveTemplate: "freehand", slotCount: 10 });
    expect(s.groups.map((g) => g.name)).toEqual(["Intro", "Warm-Up", "Build", "Peak", "Closing"]);
    expect(s.slots).toHaveLength(0);
    const g = ops.addToGroup(ops.addToGroup(s, s.groups[0].id, ref("a")), s.groups[0].id, ref("a"));
    expect(g.groups[0].tracks).toHaveLength(1);
  });
});

describe("export", () => {
  it("writes M3U8 with order, duration, label and path only, skipping missing files", () => {
    let s = base();
    s = ops.assign(s, s.slots[0].id, ref("one", 301.4)); s = ops.assign(s, s.slots[2].id, ref("gone"));
    const { text, skipped } = toM3U8(s, (r) => (r.title === "gone" ? null : r.ref));
    expect(text).toBe("#EXTM3U\n#PLAYLIST:Friday\n#EXTINF:301,Artist - one\n/music/one.mp3\n");
    expect(skipped).toBe(1);
  });
  it("round-trips the native format as a new set", () => {
    const b = base(), s = ops.assign(b, b.slots[0].id, ref("one"));
    const back = fromNative(toNative(s, "0.1.38"));
    expect(back.id).not.toBe(s.id);
    expect(back.name).toBe("Friday (imported)");
    expect(back.curveControlPoints).toEqual(s.curveControlPoints);
    expect(() => fromNative('{"hello":1}')).toThrow(/Not a Donkey Billabong DJ set file/);
  });
});

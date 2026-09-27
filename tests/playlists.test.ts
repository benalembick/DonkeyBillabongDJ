import { describe, expect, it, vi } from "vitest";
import { moveItem, PlaylistStore } from "../src/library/PlaylistStore";
import type { PlaylistPersistence, PlaylistRow } from "../src/platform";

function memoryPersistence(initial: PlaylistRow[] = []): PlaylistPersistence & { rows: Map<string, PlaylistRow> } {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    rows,
    load: async () => [...rows.values()],
    save: async (p) => void rows.set(p.id, structuredClone(p)),
    remove: async (id) => void rows.delete(id),
  };
}

describe("PlaylistStore", () => {
  it("creates, renames, adds (no duplicates), reorders, removes and persists", async () => {
    vi.useFakeTimers();
    const db = memoryPersistence();
    const store = new PlaylistStore(db);
    await store.load();
    const p = store.create("Warm-up", ["a", "b"]);
    expect(store.create("Warm-up").name).toBe("Warm-up 2");
    expect(store.addTracks(p.id, ["b", "c", "d"])).toBe(2);
    expect(store.get(p.id)!.refs).toEqual(["a", "b", "c", "d"]);
    store.move(p.id, 3, 0); // drag d to the top
    expect(store.get(p.id)!.refs).toEqual(["d", "a", "b", "c"]);
    store.removeAt(p.id, [1]);
    store.rename(p.id, "Opening set");
    await vi.runAllTimersAsync();
    expect(db.rows.get(p.id)).toMatchObject({ name: "Opening set", refs: ["d", "b", "c"] });

    const reloaded = new PlaylistStore(db);
    await reloaded.load();
    expect(reloaded.getState().playlists.map((x) => x.name)).toEqual(["Warm-up 2", "Opening set"].sort((a, b) => (a === "Opening set" ? -1 : b === "Opening set" ? 1 : 0)));
    await reloaded.remove(p.id);
    expect(db.rows.has(p.id)).toBe(false);
    vi.useRealTimers();
  });

  it("summarises count and duration", () => {
    const tracks: Record<string, { durationMs?: number }> = { a: { durationMs: 180_000 }, b: { durationMs: 200_000 } };
    const s = PlaylistStore.summary({ id: "x", name: "x", refs: ["a", "b", "gone"], createdAt: 0, updatedAt: 0 }, (r) =>
      tracks[r] ? ({ ref: r, title: r, artist: "", album: "", source: "local", bpm: null, key: null, ...tracks[r] }) : undefined,
    );
    expect(s).toEqual({ count: 3, durationMs: 380_000, missing: 1 });
  });

  it("moveItem handles drags in both directions", () => {
    expect(moveItem([1, 2, 3, 4], 0, 3)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 0, 4)).toEqual([2, 3, 4, 1]);
    expect(moveItem([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StemCache, type CacheMeta } from "../electron/stems/cache";

/**
 * `cleanup()` evicts least-recently-used cache entries once the cache exceeds its size
 * limit. Before this fix it deleted the entry's files but left `index.json` still pointing
 * at it, so the library kept showing that track's STEMS as "ready" (cached, instant load)
 * when the data was actually gone — the next load on a deck silently fell back to a full
 * re-analysis instead of the quick cache read the badge promised.
 */

let dir: string;
let cache: StemCache;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-stem-cache-"));
  cache = new StemCache(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeEntry(key: string, bytes: number, lastUsed: number): Promise<void> {
  const keyDir = path.join(dir, key);
  await fs.mkdir(keyDir, { recursive: true });
  const meta: CacheMeta = { version: 1, key, total: 100, stride: 100, regions: 1, quality: "balanced", done: [1], complete: true, bytes, createdAt: lastUsed, lastUsed };
  await fs.writeFile(path.join(keyDir, "meta.json"), JSON.stringify(meta));
}

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

describe("StemCache.cleanup prunes index.json entries it evicts", () => {
  it("drops the ref for an evicted (older) entry but keeps the one still on disk", async () => {
    await writeEntry(KEY_A, 1000, 1000); // older: evicted first
    await writeEntry(KEY_B, 1000, 2000);
    await cache.setIndex("track-a.mp3", KEY_A);
    await cache.setIndex("track-b.mp3", KEY_B);

    const freed = await cache.cleanup(1000); // only room for one entry

    expect(freed).toBe(1000);
    expect(await cache.meta(KEY_A)).toBeNull();
    const idx = await cache.readIndex();
    expect(idx).toEqual({ "track-b.mp3": KEY_B });
  });

  it("leaves the index untouched when nothing is evicted", async () => {
    await writeEntry(KEY_A, 1000, 1000);
    await cache.setIndex("track-a.mp3", KEY_A);

    const freed = await cache.cleanup(10_000);

    expect(freed).toBe(0);
    expect(await cache.readIndex()).toEqual({ "track-a.mp3": KEY_A });
  });

  it("never evicts a key named in `keep`, and its index entry survives too", async () => {
    await writeEntry(KEY_A, 1000, 1000);
    await writeEntry(KEY_B, 1000, 2000);
    await cache.setIndex("track-a.mp3", KEY_A);
    await cache.setIndex("track-b.mp3", KEY_B);

    await cache.cleanup(1000, new Set([KEY_A]));

    expect(await cache.meta(KEY_A)).not.toBeNull();
    expect(await cache.meta(KEY_B)).toBeNull();
    expect(await cache.readIndex()).toEqual({ "track-a.mp3": KEY_A });
  });
});

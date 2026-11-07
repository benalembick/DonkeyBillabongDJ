import { describe, expect, it } from "vitest";
import { CueIoQueue } from "../src/platform/CueIoQueue";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("CueIoQueue", () => {
  it("a read for a file waits for a write already queued for that same file (the embedded-cue toggle race)", async () => {
    const q = new CueIoQueue();
    const write = deferred<void>();
    let diskState = "empty";

    const writePromise = q.run("song.mp3", async () => { await write.promise; diskState = "has cues"; });
    // Mode switched back to "embedded" immediately — before the write above has settled.
    const readPromise = q.run("song.mp3", async () => diskState);

    // The write hasn't resolved yet, so the read must not have run either.
    await Promise.race([readPromise, Promise.resolve("not yet")]).then((v) => expect(v).toBe("not yet"));

    write.resolve();
    await writePromise;
    expect(await readPromise).toBe("has cues");
  });

  it("operations on different files never block each other", async () => {
    const q = new CueIoQueue();
    const a = deferred<void>();
    const order: string[] = [];

    const blockedOnA = q.run("a.mp3", async () => { await a.promise; order.push("a"); });
    const bRuns = q.run("b.mp3", async () => { order.push("b"); });

    await bRuns;
    expect(order).toEqual(["b"]);
    a.resolve();
    await blockedOnA;
    expect(order).toEqual(["b", "a"]);
  });

  it("a failed operation doesn't jam the queue for later operations on the same file", async () => {
    const q = new CueIoQueue();
    await expect(q.run("song.mp3", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(await q.run("song.mp3", async () => "ok")).toBe("ok");
  });
});

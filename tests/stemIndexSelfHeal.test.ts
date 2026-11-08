import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StemService } from "../src/stems/StemService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { EventLog } from "../src/core/log";
import { FakeAudioEngine } from "./fakes";

/**
 * The library badge reads `StemService`'s own cached `index()` (refreshed only on certain
 * events), separate from the worker's on-disk truth. If those ever disagree — e.g. the
 * cache entry was evicted for space after the badge last refreshed — loading that track
 * onto a deck gets a "cache miss" from the worker. Without a fix, the badge still says
 * "ready" until something unrelated happens to trigger a full re-fetch of the index, so a
 * track that promises an instant cached load silently falls back to analysing from scratch.
 * This checks the miss handler corrects `idx` (and the emitted "index" event) immediately.
 */
beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeBridge(setIndex = vi.fn().mockResolvedValue(undefined)) {
  return {
    onWorkerExit: () => {},
    status: async () => ({ model: { name: "", installed: true, bytes: 0, path: "" }, config: { cacheDir: "", maxCacheGB: 20, device: "auto" }, platform: { ok: true } }),
    index: async () => ({}),
    setIndex,
  } as unknown as import("../src/stems/StemService").StemBridge;
}

async function makeService() {
  const decks = [{ stems: { enabled: false } }];
  const setStemStatus = vi.fn();
  const engine = { setStemsSupport: () => {}, getState: () => ({ decks }), setStemStatus, on: () => () => {} } as unknown as DJEngine;
  const setIndex = vi.fn().mockResolvedValue(undefined);
  const audio = new FakeAudioEngine();
  const service = new StemService(engine, audio, {} as unknown as EventLog, makeBridge(setIndex));
  await Promise.resolve(); // let the constructor's refresh()/refreshIndex() settle
  // Pre-analyse mode so a "miss" just waits for the user instead of trying to decode a fake buffer.
  service.updateSettings({ mode: "preanalyse" });
  return { service, setStemStatus, setIndex };
}

function registerDeckJob(service: StemService, ref: string): void {
  const job = { id: 1, deck: 0, track: { ref }, persist: true, key: "k", buffer: {}, total: 0, inited: false, runSent: false, awaitingUser: false, regionsDone: 0, regions: 0, started: 0 };
  (service as unknown as { deckJobs: unknown[] }).deckJobs[0] = job;
}

function deliver(service: StemService, message: unknown): void {
  (service as unknown as { onWorker: (m: unknown) => void }).onWorker(message);
}

describe("StemService corrects a stale 'complete' index entry on a real cache miss", () => {
  it("drops the ref from idx and emits the correction when the worker reports a miss", async () => {
    const { service, setIndex } = await makeService();
    (service as unknown as { idx: Record<string, string> }).idx = { "stale.mp3": "complete" };
    registerDeckJob(service, "stale.mp3");
    const events: Record<string, "complete" | "partial">[] = [];
    service.on("index", (idx) => events.push(idx));

    deliver(service, { type: "cache", jobId: 1, state: "miss" });

    expect(service.index()).toEqual({});
    expect(events.at(-1)).toEqual({});
    expect(setIndex).toHaveBeenCalledWith("stale.mp3", null);
  });

  it("leaves other refs' index entries untouched", async () => {
    const { service } = await makeService();
    (service as unknown as { idx: Record<string, string> }).idx = { "stale.mp3": "complete", "other.mp3": "complete" };
    registerDeckJob(service, "stale.mp3");

    deliver(service, { type: "cache", jobId: 1, state: "miss" });

    expect(service.index()).toEqual({ "other.mp3": "complete" });
  });

  it("does nothing extra on a miss for a track the index never claimed was cached", async () => {
    const { service, setIndex } = await makeService();
    (service as unknown as { idx: Record<string, string> }).idx = {};
    registerDeckJob(service, "never-seen.mp3");

    expect(() => deliver(service, { type: "cache", jobId: 1, state: "miss" })).not.toThrow();
    expect(service.index()).toEqual({});
    expect(setIndex).not.toHaveBeenCalled();
  });

  it("still waits for the user in Pre-analyse mode after correcting the index", async () => {
    const { service, setStemStatus } = await makeService();
    (service as unknown as { idx: Record<string, string> }).idx = { "stale.mp3": "complete" };
    registerDeckJob(service, "stale.mp3");

    deliver(service, { type: "cache", jobId: 1, state: "miss" });

    expect(setStemStatus).toHaveBeenCalledWith(0, { status: "waiting", message: "Switch STEMS on to analyse this track" });
    expect((service as unknown as { deckJobs: { awaitingUser: boolean }[] }).deckJobs[0].awaitingUser).toBe(true);
  });
});

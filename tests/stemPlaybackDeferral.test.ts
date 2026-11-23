/**
 * Live playback first (docs/architecture/four-deck-performance-engine.md §15): in Automatic mode, separating
 * a track nobody switched STEMS on for waits while enough decks play, and starts once fewer decks play.
 * A deck with STEMS switched on is never held back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StemService, type StemBridge } from "../src/stems/StemService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { EventLog } from "../src/core/log";
import { FakeAudioEngine } from "./fakes";

beforeEach(() => vi.stubGlobal("window", { addEventListener: () => {} }));
afterEach(() => vi.unstubAllGlobals());

type Job = { awaitingUser: boolean; runSent: boolean; deferredAuto?: boolean };

async function setup(stemsEnabled: boolean) {
  const decks = [{ stems: { enabled: stemsEnabled }, status: "ready", track: { ref: "t.mp3" } }];
  const stateListeners: ((s: unknown) => void)[] = [];
  const setStemStatus = vi.fn();
  const engine = {
    setStemsSupport: () => {},
    getState: () => ({ decks }),
    getPosition: () => 0,
    setStemStatus,
    on: (event: string, cb: (s: unknown) => void) => {
      if (event === "state") stateListeners.push(cb);
      return () => {};
    },
  } as unknown as DJEngine;
  const bridge = {
    onWorkerExit: () => {},
    status: async () => ({ model: { name: "", installed: true, bytes: 0, path: "" }, config: { cacheDir: "", maxCacheGB: 20, device: "auto" }, platform: { ok: true } }),
    index: async () => ({}),
    setIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as StemBridge;
  const service = new StemService(engine, new FakeAudioEngine(), { info: () => {}, warn: () => {}, error: () => {} } as unknown as EventLog, bridge);
  await Promise.resolve();
  service.updateSettings({ mode: "automatic" });
  const gate = { reason: "3 decks playing" as string | null };
  service.setDeferral(() => gate.reason);
  (service as unknown as { deckJobs: unknown[] }).deckJobs[0] = { id: 1, deck: 0, track: { ref: "t.mp3", source: "local" }, persist: true, source: "manual", key: "k", buffer: {}, total: 0, inited: false, runSent: false, awaitingUser: false, regionsDone: 0, regions: 0, started: 0 };
  const job = () => (service as unknown as { deckJobs: Job[] }).deckJobs[0];
  const miss = () => (service as unknown as { onWorker: (m: unknown) => void }).onWorker({ type: "cache", jobId: 1, state: "miss" });
  const fireState = () => stateListeners.forEach((l) => l({ decks }));
  (service as unknown as { loadedBuffers: unknown[] }).loadedBuffers[0] = { getChannelData: () => new Float32Array(1), sampleRate: 44100, length: 1, numberOfChannels: 1 };
  return { gate, job, miss, fireState, setStemStatus, service };
}

describe("automatic STEMS separation yields to live playback", () => {
  it("waits while 3+ decks play, then starts when fewer play", async () => {
    const { gate, job, miss, fireState, setStemStatus } = await setup(false);
    miss();
    expect(job().runSent).toBe(false);
    expect(job().deferredAuto).toBe(true);
    expect(setStemStatus).toHaveBeenCalledWith(0, expect.objectContaining({ status: "waiting", message: expect.stringContaining("waits while 3 decks playing") }));
    fireState(); // still deferred
    expect(job().runSent).toBe(false);
    gate.reason = null;
    fireState();
    expect(job().runSent).toBe(true);
  });

  it("a deck with STEMS switched on separates straight away, even while 4 decks play", async () => {
    const { job, miss } = await setup(true);
    miss();
    expect(job().runSent).toBe(true);
  });

  it("pauses an automatic separation that is already running when 3+ decks start playing, and resumes it after", async () => {
    const { gate, job, fireState, setStemStatus, service } = await setup(false);
    gate.reason = null;
    Object.assign(job(), { runSent: true, regions: 10, regionsDone: 2 });
    fireState(); // fewer than 3 decks: keeps running
    expect(job()).not.toBeNull();
    gate.reason = "4 decks playing";
    fireState();
    expect((service as unknown as { deckJobs: unknown[] }).deckJobs[0]).toBeNull();
    expect(setStemStatus).toHaveBeenCalledWith(0, expect.objectContaining({ status: "waiting", message: expect.stringContaining("paused while 4 decks playing") }));
    gate.reason = null;
    fireState(); // resumes: the deck is opened again (its finished regions come back from the cache)
    expect((service as unknown as { deckJobs: unknown[] }).deckJobs[0]).not.toBeNull();
  });
});

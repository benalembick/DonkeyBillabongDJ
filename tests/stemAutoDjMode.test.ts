import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StemService } from "../src/stems/StemService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { EventLog } from "../src/core/log";
import { FakeAudioEngine } from "./fakes";

/**
 * In "automatic"/"realtime" mode, a track loaded onto a deck by hand is separated eagerly so
 * STEMS feel instant when switched on. Auto DJ never touches a deck's STEMS toggle on its own,
 * so eagerly separating every auto-advanced track during an unattended set burns CPU/GPU/memory
 * (and a full structured-clone copy of the track across the worker process boundary) for a
 * feature that track will likely never use — this is what the DJ actually noticed as "glitchy
 * and using 5GB of memory" while running Auto DJ. These tests lock in the fix: an Auto-DJ-loaded
 * track waits for the DJ to switch STEMS on for that deck, exactly like Pre-analyse mode, unless
 * STEMS are already enabled on that deck.
 */
beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeBridge() {
  return {
    onWorkerExit: () => {},
    status: async () => ({ model: { name: "", installed: true, bytes: 0, path: "" }, config: { cacheDir: "", maxCacheGB: 20, device: "auto" }, platform: { ok: true } }),
    index: async () => ({}),
    setIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("../src/stems/StemService").StemBridge;
}

async function makeService(mode: "automatic" | "realtime" | "preanalyse", stemsEnabled: boolean) {
  const decks = [{ stems: { enabled: stemsEnabled } }];
  const setStemStatus = vi.fn();
  const engine = { setStemsSupport: () => {}, getState: () => ({ decks }), setStemStatus, on: () => () => {} } as unknown as DJEngine;
  const audio = new FakeAudioEngine();
  const service = new StemService(engine, audio, {} as unknown as EventLog, makeBridge());
  await Promise.resolve(); // let the constructor's refresh()/refreshIndex() settle
  service.updateSettings({ mode });
  return { service, setStemStatus };
}

function registerDeckJob(service: StemService, source: "manual" | "auto-dj"): void {
  const job = { id: 1, deck: 0, track: { ref: "t.mp3" }, persist: true, source, key: "k", buffer: {}, total: 0, inited: false, runSent: false, awaitingUser: false, regionsDone: 0, regions: 0, started: 0 };
  (service as unknown as { deckJobs: unknown[] }).deckJobs[0] = job;
}

function deliverMiss(service: StemService): void {
  (service as unknown as { onWorker: (m: unknown) => void }).onWorker({ type: "cache", jobId: 1, state: "miss" });
}

describe("StemService defers automatic separation for Auto DJ loads", () => {
  it("waits for the user instead of auto-running an Auto-DJ-loaded track in Automatic mode", async () => {
    const { service, setStemStatus } = await makeService("automatic", false);
    registerDeckJob(service, "auto-dj");

    deliverMiss(service);

    expect(setStemStatus).toHaveBeenCalledWith(0, { status: "waiting", message: "Switch STEMS on to analyse this track" });
    expect((service as unknown as { deckJobs: { awaitingUser: boolean }[] }).deckJobs[0].awaitingUser).toBe(true);
  });

  it("waits for the user instead of auto-running an Auto-DJ-loaded track in Real-time mode", async () => {
    const { service, setStemStatus } = await makeService("realtime", false);
    registerDeckJob(service, "auto-dj");

    deliverMiss(service);

    expect(setStemStatus).toHaveBeenCalledWith(0, { status: "waiting", message: "Switch STEMS on to analyse this track" });
  });

  it("still auto-runs a manually loaded track in Automatic mode (unchanged behaviour)", async () => {
    const { service, setStemStatus } = await makeService("automatic", false);
    registerDeckJob(service, "manual");

    deliverMiss(service);

    expect(setStemStatus).toHaveBeenCalledWith(0, { status: "analysing", message: "Analysing STEMS…" });
    expect((service as unknown as { deckJobs: { runSent: boolean }[] }).deckJobs[0].runSent).toBe(true);
  });

  it("still auto-runs an Auto-DJ-loaded track when STEMS are already switched on for that deck", async () => {
    const { service, setStemStatus } = await makeService("automatic", true);
    registerDeckJob(service, "auto-dj");

    deliverMiss(service);

    expect(setStemStatus).toHaveBeenCalledWith(0, { status: "analysing", message: "Analysing STEMS…" });
    expect((service as unknown as { deckJobs: { runSent: boolean }[] }).deckJobs[0].runSent).toBe(true);
  });
});

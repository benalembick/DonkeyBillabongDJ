import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StemService } from "../src/stems/StemService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { StemBridge } from "../src/stems/StemService";
import { FakeAudioEngine } from "./fakes";

// This suite runs under the "node" test environment (see vite.config.ts) — StemService's
// constructor listens for a window message (the stem worker's MessagePort handshake), so it
// needs a minimal stand-in here, same as it would get from Electron's real renderer window.
beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A rebuilt WebAudioEngine (e.g. after an output device/routing change) replaces every deck's
 * AudioWorkletNode. The fresh worklet starts with no STEM region data, even though the deck's
 * `stems.status` still reads "ready" and the on-disk cache still has the separation — until
 * StemService notices the "rebuilt" event and re-primes it. This is a renderer-only unit test
 * of that noticing/dispatch logic (which deck gets re-synced and how) — it stubs out
 * `onDeckLoaded` itself rather than faking the full worker/cache round trip.
 */
function makeDeck(overrides: Partial<{ status: "empty" | "loading" | "ready" | "error"; track: { ref: string } | null; enabled: boolean }>) {
  return {
    status: overrides.status ?? "empty",
    track: overrides.track ?? null,
    stems: { enabled: overrides.enabled ?? false, volume: [1, 1, 1, 1], muted: [false, false, false, false], status: "ready", progress: 1 },
  };
}

function makeBridge(): StemBridge {
  return {
    onWorkerExit: () => {},
    status: async () => ({ model: { name: "", installed: true, bytes: 0, path: "" }, config: { cacheDir: "", maxCacheGB: 20, device: "auto" }, platform: { ok: true } }),
    index: async () => ({}),
  } as unknown as StemBridge;
}

describe("StemService re-primes STEMS after the audio engine rebuilds", () => {
  it("re-sends cached regions and mix state for every ready deck with a loaded buffer, and only those", async () => {
    const decks = [
      makeDeck({ status: "ready", track: { ref: "a.mp3" }, enabled: true }), // has a buffer below
      makeDeck({ status: "ready", track: { ref: "b.mp3" }, enabled: false }), // no buffer: nothing to resync
      makeDeck({ status: "empty" }), // no track: nothing to resync even if a buffer lingers
    ];
    const setStemsEnabled = vi.fn();
    const audio = new FakeAudioEngine();
    const engine = { getState: () => ({ decks }), setStemsEnabled, setStemsSupport: () => {}, on: () => () => {} } as unknown as DJEngine;
    const service = new StemService(engine, audio, {} as unknown as import("../src/core/log").EventLog, makeBridge());
    await Promise.resolve(); // let the constructor's refresh()/refreshIndex() settle

    const onDeckLoaded = vi.fn();
    (service as unknown as { onDeckLoaded: typeof onDeckLoaded }).onDeckLoaded = onDeckLoaded;
    (service as unknown as { loadedBuffers: unknown[] }).loadedBuffers = ["buf-a", null, "stale-buf"];

    audio.fire({ type: "rebuilt" });

    expect(onDeckLoaded).toHaveBeenCalledTimes(1);
    expect(onDeckLoaded).toHaveBeenCalledWith(0, decks[0].track, "buf-a");
    expect(setStemsEnabled).toHaveBeenCalledTimes(1);
    expect(setStemsEnabled).toHaveBeenCalledWith(0, true);
  });

  it("does nothing on the very first build (nothing loaded yet)", async () => {
    const decks = [makeDeck({ status: "empty" }), makeDeck({ status: "empty" })];
    const setStemsEnabled = vi.fn();
    const audio = new FakeAudioEngine();
    const engine = { getState: () => ({ decks }), setStemsEnabled, setStemsSupport: () => {}, on: () => () => {} } as unknown as DJEngine;
    const service = new StemService(engine, audio, {} as unknown as import("../src/core/log").EventLog, makeBridge());
    await Promise.resolve();

    const onDeckLoaded = vi.fn();
    (service as unknown as { onDeckLoaded: typeof onDeckLoaded }).onDeckLoaded = onDeckLoaded;

    audio.fire({ type: "rebuilt" }); // the real WebAudioEngine also emits this on its first build

    expect(onDeckLoaded).not.toHaveBeenCalled();
    expect(setStemsEnabled).not.toHaveBeenCalled();
  });
});

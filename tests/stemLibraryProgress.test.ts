import { describe, expect, it } from "vitest";
import { StemService } from "../src/stems/StemService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { AudioEngine } from "../src/core/engine/types";
import type { EventLog } from "../src/core/log";

/** `bridge: null` makes the constructor return early (desktop-only feature), so no real IPC/worker is needed. */
function makeService(): StemService {
  const engine = { setStemsSupport: () => {}, getState: () => ({ decks: [] }) } as unknown as DJEngine;
  return new StemService(engine, {} as unknown as AudioEngine, {} as unknown as EventLog, null);
}

function registerLibraryJob(service: StemService, id: number, ref: string): void {
  (service as any).libJobs.set(id, { id, ref, resolve: () => {}, reject: () => {} });
}

function deliver(service: StemService, message: unknown): void {
  (service as any).onWorker(message);
}

describe("StemService background (library) separation progress", () => {
  it("tracks and emits per-ref progress from worker 'progress' messages, clearing it when the job finishes", () => {
    const service = makeService();
    const events: Record<string, number>[] = [];
    service.on("libraryProgress", (p) => events.push(p));
    registerLibraryJob(service, 1, "song.mp3");

    deliver(service, { type: "progress", jobId: 1, done: 5, regions: 20 });
    expect(service.libraryProgress()).toEqual({ "song.mp3": 0.25 });
    expect(events.at(-1)).toEqual({ "song.mp3": 0.25 });

    deliver(service, { type: "progress", jobId: 1, done: 20, regions: 20 });
    expect(service.libraryProgress()).toEqual({ "song.mp3": 1 });

    deliver(service, { type: "done", jobId: 1, cached: true });
    expect(service.libraryProgress()).toEqual({});
  });

  it("clears progress on error too", () => {
    const service = makeService();
    registerLibraryJob(service, 2, "other.mp3");
    deliver(service, { type: "progress", jobId: 2, done: 1, regions: 4 });
    expect(service.libraryProgress()).toEqual({ "other.mp3": 0.25 });
    deliver(service, { type: "error", jobId: 2, message: "boom" });
    expect(service.libraryProgress()).toEqual({});
  });

  it("tracks multiple concurrent library jobs independently", () => {
    const service = makeService();
    registerLibraryJob(service, 3, "a.mp3");
    registerLibraryJob(service, 4, "b.mp3");
    deliver(service, { type: "progress", jobId: 3, done: 1, regions: 2 });
    deliver(service, { type: "progress", jobId: 4, done: 1, regions: 4 });
    expect(service.libraryProgress()).toEqual({ "a.mp3": 0.5, "b.mp3": 0.25 });
    deliver(service, { type: "done", jobId: 3, cached: true });
    expect(service.libraryProgress()).toEqual({ "b.mp3": 0.25 });
  });

  it("never reports progress above 1 even if done exceeds regions", () => {
    const service = makeService();
    registerLibraryJob(service, 5, "weird.mp3");
    deliver(service, { type: "progress", jobId: 5, done: 99, regions: 10 });
    expect(service.libraryProgress()["weird.mp3"]).toBe(1);
  });

  it("ignores messages for an unknown jobId instead of throwing", () => {
    const service = makeService();
    expect(() => deliver(service, { type: "progress", jobId: 999, done: 1, regions: 2 })).not.toThrow();
    expect(service.libraryProgress()).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { AnalysisService, MAX_BATCH_SECONDS } from "../src/analysis/AnalysisService";
import type { DJEngine } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import type { PreparationStore } from "../src/preparation/PreparationStore";
import type { AudioEngine } from "../src/core/engine/types";

const track = (ref: string, extra: Partial<TrackInfo> = {}): TrackInfo => ({ ref, title: ref, artist: "", album: "", source: "local", bpm: null, key: null, ...extra });

function setup(opts: { decode?: (ref: string) => Promise<unknown>; storage?: Map<string, string>; probe?: (ref: string) => Promise<number | null> } = {}) {
  const storage = opts.storage ?? new Map<string, string>();
  const errors: string[] = [], infos: string[] = [], decoded: string[] = [];
  let reading = "";
  const engine = { on: () => () => {}, getState: () => ({ decks: [] }) } as unknown as DJEngine;
  const preparation = { identify: async (t: TrackInfo) => ({ trackId: t.ref }), waveform: async () => null } as unknown as PreparationStore;
  const audio = {
    decode: async () => {
      decoded.push(reading);
      // Simulate what crashing would leave behind: the guard is set while decoding.
      expect(storage.get("dbdj.analysis.current")).toBe(reading);
      return (opts.decode ?? (() => Promise.reject(Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" }))))(reading);
    },
  } as unknown as AudioEngine;
  const service = new AnalysisService(engine, {
    preparation, audio,
    readAudio: async (ref) => { reading = ref; return new ArrayBuffer(16); },
    onError: (e) => errors.push((e as Error).message),
    onInfo: (m) => infos.push(m),
    probeDuration: opts.probe,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) },
  });
  return { service, storage, errors, infos, decoded };
}

describe("library analysis batch", () => {
  it("skips very long files without decoding them", async () => {
    const s = setup();
    await s.service.analyseTracks([track("mix.mp3", { durationMs: (MAX_BATCH_SECONDS + 60) * 1000 })]);
    expect(s.decoded).toEqual([]);
    expect(s.service.getState().skipped[0]).toMatch(/too long/);
  });

  it("reports undecodable files once per batch, naming them in Diagnostics, not one notification each", async () => {
    const s = setup();
    await s.service.analyseTracks([track("a.aiff"), track("b.m4a"), track("c.mp3")]);
    expect(s.service.getState().errors).toHaveLength(3);
    expect(s.infos.filter((m) => m.includes("EncodingError"))).toHaveLength(3);
    expect(s.infos[0]).toContain("a.aiff");
    expect(s.errors).toEqual(["Library analysis: 3 couldn't be analysed — see Diagnostics for the list"]);
    expect(s.storage.has("dbdj.analysis.current")).toBe(false);
  });

  it("skips the file that was being analysed when the app crashed, until reanalysed explicitly", async () => {
    const storage = new Map([["dbdj.analysis.current", "/music/huge.wav"]]);
    const s = setup({ storage });
    await Promise.resolve();
    expect(s.errors[0]).toMatch(/closed while analysing huge\.wav/);
    expect(JSON.parse(storage.get("dbdj.analysis.skip")!)).toEqual(["/music/huge.wav"]);

    await s.service.analyseTracks([track("/music/huge.wav"), track("/music/ok.mp3")]);
    expect(s.decoded).toEqual(["/music/ok.mp3"]);
    expect(s.service.getState().skipped[0]).toMatch(/closed unexpectedly/);

    // A later session still remembers it.
    const again = setup({ storage });
    await again.service.analyseTracks([track("/music/huge.wav")]);
    expect(again.decoded).toEqual([]);

    // Reanalyse (force) tries it; success clears it from the skip list.
    const forced = setup({ storage, decode: async () => ({ duration: 1, handle: null }) });
    await forced.service.analyseTracks([track("/music/huge.wav")], true);
    expect(forced.decoded).toEqual(["/music/huge.wav"]);
  });
});

describe("library analysis duration probe", () => {
  it("reads the duration from the file header when tags weren't read yet, and skips long files before decoding", async () => {
    const probed: string[] = [];
    const s = setup({ probe: async (ref) => { probed.push(ref); return ref.includes("mix") ? 3600 : 240; }, decode: async () => ({ duration: 240, handle: null }) });
    await s.service.analyseTracks([track("mix.mp3"), track("song.mp3"), track("tagged.mp3", { durationMs: 200_000 })]);
    expect(probed).toEqual(["mix.mp3", "song.mp3"]);
    expect(s.decoded).toEqual(["song.mp3", "tagged.mp3"]);
    expect(s.service.getState().skipped).toEqual(["mix.mp3: too long for background analysis (60 min)"]);
  });
});

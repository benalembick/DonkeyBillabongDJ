import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine, cueSourceFor, withCueSource, type CueSource, type DeckState, type EngineSettings, type PreparationPort } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { CueSourceRouter } from "../src/preparation/CueSourceRouter";
import type { EmbeddedCue, EmbeddedCueResult } from "../src/library/embeddedCues";
import { FakeAudioEngine } from "./fakes";

const track = (title: string): TrackInfo => ({ ref: `${title}.mp3`, title, artist: "", album: "", source: "local", bpm: null, key: null });

class FakeInnerPort implements PreparationPort {
  changedCalls: Partial<DeckState>[] = [];
  nextRestore: Partial<DeckState> = {};
  async restore(): Promise<Partial<DeckState>> { return this.nextRestore; }
  changed(_previous: DeckState, _next: DeckState, patch: Partial<DeckState>): void { this.changedCalls.push(patch); }
}

class FakeEmbeddedBridge {
  reads: string[] = [];
  writes: { ref: string; cues: EmbeddedCue[] }[] = [];
  nextRead: EmbeddedCueResult = { ok: true, supported: true, cues: [] };
  async read(ref: string): Promise<EmbeddedCueResult> { this.reads.push(ref); return this.nextRead; }
  async write(ref: string, cues: EmbeddedCue[]): Promise<{ ok: boolean; error?: string }> { this.writes.push({ ref, cues }); return { ok: true }; }
}

let bus: CommandBus;
let audio: FakeAudioEngine;
let engine: DJEngine;
let inner: FakeInnerPort;
let embedded: FakeEmbeddedBridge;
let errors: string[];

beforeEach(() => {
  bus = new CommandBus();
  audio = new FakeAudioEngine();
  inner = new FakeInnerPort();
  embedded = new FakeEmbeddedBridge();
  errors = [];
  engine = new DJEngine({
    bus,
    audio,
    log: new EventLog(),
    browser: { moveSelection: () => {}, getSelected: () => null },
    loadBytes: async () => new ArrayBuffer(300),
  });
  engine.setPreparationPort(new CueSourceRouter(inner, embedded, (deck) => cueSourceFor(engine.getSettings(), deck), (msg) => errors.push(msg)));
});

async function loaded(deck = 0) {
  await engine.loadTrack(deck, track(`t${deck}`));
  expect(engine.getState().decks[deck].status).toBe("ready");
}

describe("cue source: suggested (default)", () => {
  it("routes edits straight to the inner (suggested) port, never touching the embedded bridge", async () => {
    await loaded();
    bus.send("deck1.hotcue.1", 1);
    bus.send("deck1.hotcue.1", 0);
    expect(engine.getState().decks[0].hotcues[0]).toBe(0);
    expect(inner.changedCalls.some((p) => p.hotcues)).toBe(true);
    expect(embedded.writes).toHaveLength(0);
  });
});

describe("cue source: embedded", () => {
  beforeEach(() => {
    engine.updateSettings({ cueSource: ["embedded", "embedded"] });
  });

  it("populates hot cue pads from the track's embedded tag on load, not the suggested database", async () => {
    inner.nextRestore = { hotcues: [99, null, null, null, null, null, null, null], cueDetails: [] };
    embedded.nextRead = { ok: true, supported: true, cues: [{ slot: 0, timestamp: 5, name: "Drop", colour: "#abcdef" }] };
    await loaded();
    const d = engine.getState().decks[0];
    expect(d.hotcues[0]).toBe(5);
    expect(d.cueDetails[0]?.name).toBe("Drop");
    expect(embedded.reads).toEqual(["t0.mp3"]);
  });

  it("saves a newly created hot cue to the embedded tag, and keeps it out of the suggested database", async () => {
    embedded.nextRead = { ok: true, supported: true, cues: [{ slot: 0, timestamp: 5, name: "Drop", colour: "#abcdef" }] };
    await loaded();
    bus.send("deck1.hotcue.2", 1);
    bus.send("deck1.hotcue.2", 0);
    expect(inner.changedCalls.some((p) => p.hotcues || p.cueDetails)).toBe(false);
    expect(embedded.writes).toHaveLength(1);
    const cues = embedded.writes[0].cues;
    expect(embedded.writes[0].ref).toBe("t0.mp3");
    expect(cues.find((c) => c.slot === 0)).toMatchObject({ timestamp: 5, name: "Drop" });
    expect(cues.find((c) => c.slot === 1)).toMatchObject({ timestamp: 0, name: "B" });
  });

  it("clearing a hot cue removes it from the embedded tag", async () => {
    embedded.nextRead = { ok: true, supported: true, cues: [{ slot: 0, timestamp: 5, name: "Drop", colour: "#abcdef" }] };
    await loaded();
    bus.send("deck1.hotcue.1.clear", 1);
    expect(embedded.writes.at(-1)?.cues).toHaveLength(0);
  });

  it("falls back to empty pads (not the suggested cues) for a file type that can't carry embedded cues", async () => {
    inner.nextRestore = { hotcues: [42, null, null, null, null, null, null, null], cueDetails: [] };
    embedded.nextRead = { ok: true, supported: false, cues: [] };
    await loaded();
    expect(engine.getState().decks[0].hotcues[0]).toBeNull();
    expect(errors.some((m) => m.includes("embedded hot cue support"))).toBe(true);
  });

  it("reports a read failure and falls back to the suggested fields already returned by the inner port", async () => {
    inner.nextRestore = { hotcues: [42, null, null, null, null, null, null, null], cueDetails: [] };
    embedded.nextRead = { ok: false, supported: true, cues: [], error: "boom" };
    await loaded();
    expect(engine.getState().decks[0].hotcues[0]).toBe(42);
    expect(errors.some((m) => m.includes("boom"))).toBe(true);
  });
});

describe("cue source: migrates settings saved before it was per-deck", () => {
  // Before this feature, EngineSettings.cueSource was a single string, not an array — this is
  // exactly what a user's localStorage still holds until they save settings again.
  const legacySettings = (value: CueSource) => ({ cueSource: value as unknown as CueSource[] }) as Partial<EngineSettings>;

  it("turns a legacy \"embedded\" string into an array applying to every deck, without throwing", () => {
    const legacyEngine = new DJEngine({
      bus: new CommandBus(), audio: new FakeAudioEngine(),
      log: new EventLog(), browser: { moveSelection: () => {}, getSelected: () => null },
      loadBytes: async () => new ArrayBuffer(300),
      settings: legacySettings("embedded"),
    });
    const settings = legacyEngine.getSettings();
    expect(Array.isArray(settings.cueSource)).toBe(true);
    expect(cueSourceFor(settings, 0)).toBe("embedded");
    expect(cueSourceFor(settings, 1)).toBe("embedded");
    // The bug this guards against: mutating a bare string threw "Cannot assign to read only property".
    expect(() => withCueSource(settings, 0, "suggested")).not.toThrow();
  });

  it("turns a legacy \"suggested\" string into an array the same way", () => {
    const legacyEngine = new DJEngine({
      bus: new CommandBus(), audio: new FakeAudioEngine(),
      log: new EventLog(), browser: { moveSelection: () => {}, getSelected: () => null },
      loadBytes: async () => new ArrayBuffer(300),
      settings: legacySettings("suggested"),
    });
    const settings = legacyEngine.getSettings();
    expect(Array.isArray(settings.cueSource)).toBe(true);
    expect(cueSourceFor(settings, 0)).toBe("suggested");
  });
});

describe("cue source: independent per deck", () => {
  it("lets deck A stay suggested while deck B is embedded, and keeps their saves separate", async () => {
    engine.updateSettings({ cueSource: ["suggested", "embedded"] });
    embedded.nextRead = { ok: true, supported: true, cues: [{ slot: 0, timestamp: 7, name: "B-side cue", colour: "#abcdef" }] };
    await loaded(0);
    await loaded(1);

    // Deck A (suggested): embedded bridge is never consulted on load.
    expect(embedded.reads).toEqual(["t1.mp3"]);
    expect(engine.getState().decks[1].hotcues[0]).toBe(7);

    bus.send("deck1.hotcue.1", 1); bus.send("deck1.hotcue.1", 0); // deck A
    bus.send("deck2.hotcue.3", 1); bus.send("deck2.hotcue.3", 0); // deck B

    expect(inner.changedCalls.some((p) => p.hotcues?.[0] === 0)).toBe(true); // deck A's cue reached the suggested port
    expect(embedded.writes).toHaveLength(1); // only deck B's edit went to the embedded bridge
    expect(embedded.writes[0].ref).toBe("t1.mp3");
  });

  it("switching deck A to embedded doesn't affect deck B's suggested mode", async () => {
    await loaded(0);
    await loaded(1);
    engine.updateSettings({ cueSource: ["embedded", "suggested"] });

    bus.send("deck2.hotcue.1", 1); bus.send("deck2.hotcue.1", 0); // deck B, still suggested
    expect(embedded.writes).toHaveLength(0);
    expect(inner.changedCalls.some((p) => p.hotcues)).toBe(true);
  });
});

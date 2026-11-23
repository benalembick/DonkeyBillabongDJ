/**
 * Four-deck engine (docs/architecture/four-deck-performance-engine.md §29 "Audio engine" and
 * "Synchronisation"): four independent decks, per-channel routing and crossfader A/THRU/B,
 * shared master sync with a defined handover policy, and deck reservation for automation.
 * The audio graph itself (real summing, clip protection) is verified in the Electron soak
 * test (scripts/four-deck-soak.mjs); here the engine drives a recording fake.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine, normaliseEngineSettings, DEFAULT_ENGINE_SETTINGS, type BeatGrid, type EngineSettings } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { faderToGain } from "../src/core/engine/mixerMath";
import { audibility } from "../src/core/engine/audibility";
import { FakeAudioEngine } from "./fakes";

const track = (title: string): TrackInfo => ({ ref: title, title, artist: "", album: "", source: "local", bpm: null, key: null });
const grid = (bpm: number, firstBeat = 0, extra: Partial<BeatGrid> = {}): BeatGrid => ({ bpm, firstBeat, confidence: 3, source: "analysis", ...extra });

let bus: CommandBus;
let audio: FakeAudioEngine;
let engine: DJEngine;

beforeEach(() => {
  bus = new CommandBus();
  audio = new FakeAudioEngine(4);
  engine = new DJEngine({ bus, audio, log: new EventLog(), deckCount: 4, browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(300) });
});

async function loadAll(titles = ["a", "b", "c", "d"]) {
  for (let i = 0; i < 4; i++) await engine.loadTrack(i, track(titles[i]));
  for (let i = 0; i < 4; i++) expect(engine.getState().decks[i].status).toBe("ready");
}
const callsSince = (n: number) => audio.calls.slice(n);

describe("four independent decks", () => {
  it("all four decks play simultaneously and each one pauses on its own", async () => {
    await loadAll();
    for (let d = 1; d <= 4; d++) bus.send(`deck${d}.play`, 1, "ui");
    expect(audio.playing).toEqual([true, true, true, true]);
    expect(engine.getState().decks.map((d) => d.playing)).toEqual([true, true, true, true]);
    bus.send("deck3.play", 1, "ui");
    expect(audio.playing).toEqual([true, true, false, true]);
  });

  it("loading and ejecting one deck sends nothing to the other decks", async () => {
    await loadAll();
    for (const d of [1, 2, 4]) bus.send(`deck${d}.play`, 1, "ui");
    const mark = audio.calls.length;
    await engine.loadTrack(2, track("new"));
    bus.send("deck3.eject", 1, "ui");
    const touched = new Set(callsSince(mark).map((c) => c.deck));
    expect([...touched]).toEqual([2]);
    expect(audio.playing).toEqual([true, true, false, true]);
  });

  it("the same track on two decks keeps separate playheads, EQ and play state", async () => {
    await engine.loadTrack(0, track("same"));
    await engine.loadTrack(2, track("same"));
    bus.send("deck1.play", 1, "ui");
    bus.send("deck3.seek", 0.5, "ui");
    bus.send("mixer.channel3.eq.low", 0, "ui");
    bus.send("mixer.channel3.volume", 0.3, "ui");
    const [a, , c] = engine.getState().decks;
    expect(a.track?.ref).toBe(c.track?.ref);
    expect(a.playing).toBe(true);
    expect(c.playing).toBe(false);
    expect(audio.positions[0]).toBe(0);
    expect(audio.positions[2]).toBeCloseTo(150);
    expect(engine.getState().mixer.channels[0]).toMatchObject({ eqLow: 0.5, volume: 1 });
    expect(engine.getState().mixer.channels[2]).toMatchObject({ eqLow: 0, volume: 0.3 });
  });

  it("key lock, tempo and loops are per deck", async () => {
    await loadAll();
    bus.send("deck4.keylock", 1, "ui");
    bus.send("deck2.tempo", 0.25, "ui");
    engine.setBeatGrid(2, grid(120));
    audio.positions[2] = 10;
    bus.send("deck3.beatloop.4", 1, "ui");
    expect(audio.keylock).toEqual([false, false, false, true]);
    expect(audio.rates[1]).not.toBe(1);
    expect([audio.rates[0], audio.rates[2], audio.rates[3]]).toEqual([1, 1, 1]);
    expect(audio.loops[2]).toEqual({ start: 10, end: 12 });
    expect([audio.loops[0], audio.loops[1], audio.loops[3]]).toEqual([null, null, null]);
  });

  it("eight hot cues per deck, independent per deck", async () => {
    await loadAll();
    audio.positions[3] = 42;
    bus.send("deck4.hotcue.8", 1, "ui");
    bus.send("deck4.hotcue.8", 0, "ui");
    expect(engine.getState().decks[3].hotcues[7]).toBe(42);
    expect(engine.getState().decks.slice(0, 3).every((d) => d.hotcues.every((h) => h === null))).toBe(true);
  });
});

describe("four-channel mixer routing", () => {
  it("every channel gets its own DSP; EQ and gain changes touch only the intended channel", async () => {
    await loadAll();
    const before = audio.channels.map((c) => ({ ...c }));
    bus.send("mixer.channel3.eq.low", 0, "ui");
    bus.send("mixer.channel3.gain", 0.8, "ui");
    expect(audio.channels).toHaveLength(4);
    expect(audio.channels[2].eqLowDb).toBeLessThan(before[2].eqLowDb);
    expect(audio.channels[2].trimGain).toBeGreaterThan(before[2].trimGain);
    for (const i of [0, 1, 3]) expect(audio.channels[i]).toEqual(before[i]);
  });

  it("default crossfader assignment: A, C on side A; B, D on side B", () => {
    expect([0, 1, 2, 3].map((d) => engine.getCrossfaderAssign(d))).toEqual(["left", "right", "left", "right"]);
  });

  it("crossfader A / THRU / B routing works per channel", async () => {
    await loadAll();
    bus.send("mixer.crossfader", 0, "ui"); // hard A
    expect(audio.channels.map((c) => c.outputGain > 0)).toEqual([true, false, true, false]);
    bus.send("mixer.channel4.xfader.thru", 1, "ui");
    expect(audio.channels[3].outputGain).toBeCloseTo(faderToGain(1)); // THRU: only the channel fader
    bus.send("mixer.crossfader", 1, "ui"); // hard B
    expect(audio.channels.map((c) => c.outputGain > 0)).toEqual([false, true, false, true]);
    bus.send("mixer.channel1.xfader.b", 1, "ui");
    expect(audio.channels[0].outputGain).toBeGreaterThan(0);
    bus.send("mixer.channel3.xfader.cycle", 1, "ui"); // left → thru
    expect(engine.getCrossfaderAssign(2)).toBe("thru");
    expect(audio.channels[2].outputGain).toBeCloseTo(faderToGain(1));
  });

  it("a crossfader assignment change asks the app to persist settings", () => {
    const events: string[] = [];
    engine.on("event", (e) => events.push(e.type));
    bus.send("mixer.channel2.xfader.thru", 1, "midi");
    expect(events).toContain("settingsChanged");
    expect(engine.getSettings().crossfaderAssign[1]).toBe("thru");
  });

  it("channel volumes are never changed when more decks start playing (no auto-normalisation)", async () => {
    await loadAll();
    bus.send("mixer.channel1.volume", 0.9, "ui");
    const gains = audio.channels.map((c) => c.outputGain);
    for (let d = 1; d <= 4; d++) bus.send(`deck${d}.play`, 1, "ui");
    expect(audio.channels.map((c) => c.outputGain)).toEqual(gains);
  });

  it("headphone cue (PFL) is independent per channel and never changes the master send", async () => {
    await loadAll();
    const out = audio.channels.map((c) => c.outputGain);
    bus.send("mixer.channel3.cue", 1, "ui");
    bus.send("mixer.channel4.cue", 1, "ui");
    expect(audio.channels.map((c) => c.pfl)).toEqual([false, false, true, true]);
    expect(audio.channels.map((c) => c.outputGain)).toEqual(out);
  });

  it("ON AIR follows routing and playback, not playback alone", async () => {
    await loadAll();
    bus.send("deck3.play", 1, "ui");
    const mg = faderToGain(engine.getState().mixer.masterLevel);
    const air = (d: number) => audibility({ playing: engine.getState().decks[d].playing, outputGain: engine.channelRouting(d).outputGain, masterGain: mg, level: 0 });
    expect(air(2)).toBe("on-air");
    bus.send("mixer.crossfader", 1, "ui"); // deck C is on side A
    expect(air(2)).toBe("off-air");
    bus.send("mixer.channel3.xfader.thru", 1, "ui");
    expect(air(2)).toBe("on-air");
    bus.send("mixer.channel3.volume", 0, "ui");
    expect(air(2)).toBe("off-air");
    expect(audibility({ playing: false, outputGain: 1, masterGain: 1, level: 0.2 })).toBe("tail");
    expect(audibility({ playing: false, outputGain: 1, masterGain: 1, level: 0 })).toBe("stopped");
  });

  it("soft-takeover reads back the software value of absolute controls", async () => {
    await loadAll();
    bus.send("mixer.channel3.volume", 0.2, "ui");
    bus.send("deck4.tempo", 0.25, "ui");
    expect(engine.getActionValue("mixer.channel3.volume")).toBeCloseTo(0.2);
    expect(engine.getActionValue("deck4.tempo")).toBeCloseTo(0.25, 3);
    expect(engine.getActionValue("mixer.crossfader")).toBeCloseTo(0.5);
    expect(engine.getActionValue("deck1.play")).toBeNull();
  });
});

describe("settings migration", () => {
  it("settings saved for two decks gain defaults for decks C and D; a legacy cue source applies to all", () => {
    const old = { ...DEFAULT_ENGINE_SETTINGS, crossfaderAssign: ["thru", "left"], cueSource: "embedded" } as unknown as EngineSettings;
    const s = normaliseEngineSettings(old, 4);
    expect(s.crossfaderAssign).toEqual(["thru", "left", "left", "right"]);
    expect(s.cueSource).toEqual(["embedded", "embedded", "embedded", "embedded"]);
    expect(normaliseEngineSettings({ ...DEFAULT_ENGINE_SETTINGS, crossfaderAssign: ["nope"] } as unknown as EngineSettings, 4).crossfaderAssign[0]).toBe("left");
  });
});

describe("shared master sync across four decks", () => {
  async function fourPlaying(bpms = [120, 124, 118, 126]) {
    await loadAll();
    bpms.forEach((b, i) => engine.setBeatGrid(i, grid(b)));
    for (let d = 1; d <= 4; d++) bus.send(`deck${d}.play`, 1, "ui");
  }

  it("four decks follow one master", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    for (const d of [2, 3, 4]) bus.send(`deck${d}.sync`, 1, "ui");
    expect(engine.getState().masterDeck).toBe(0);
    for (const d of [1, 2, 3]) expect(engine.getBpm(d)).toBeCloseTo(120, 5);
  });

  it("manual master reassignment re-matches followers without jumping any playhead", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    for (const d of [2, 3, 4]) bus.send(`deck${d}.sync`, 1, "ui");
    const mark = audio.calls.length;
    bus.send("deck4.master", 1, "ui");
    expect(engine.getState().masterDeck).toBe(3);
    expect(callsSince(mark).filter((c) => c.fn === "seek")).toEqual([]);
    for (const d of [1, 2]) expect(engine.getBpm(d)).toBeCloseTo(engine.getBpm(3)!, 5);
  });

  it("hands the master to a playing synced deck when the master stops, with no tempo change", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    bus.send("deck3.sync", 1, "ui");
    const rate = engine.getState().decks[2].rate;
    bus.send("deck1.play", 1, "ui"); // pause the master
    engine.tick();
    expect(engine.getState().masterDeck).toBe(2);
    expect(engine.getState().decks[2].rate).toBe(rate);
    expect(audio.rates[2]).toBeCloseTo(rate, 9);
  });

  it("keeps the master when no synced deck is playing", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    bus.send("deck1.play", 1, "ui");
    engine.tick();
    expect(engine.getState().masterDeck).toBe(0);
  });

  it("loading an unsynced deck never changes the master clock", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    bus.send("deck2.sync", 1, "ui");
    bus.send("deck4.play", 1, "ui"); // pause D, then load it
    await engine.loadTrack(3, track("other"));
    engine.setBeatGrid(3, grid(90));
    expect(engine.getState().masterDeck).toBe(0);
    expect(engine.getBpm(1)).toBeCloseTo(120, 5);
  });

  it("reloading the master deck hands the master on first, so synced decks keep their tempo", async () => {
    await fourPlaying();
    bus.send("deck1.master", 1, "ui");
    bus.send("deck2.sync", 1, "ui");
    bus.send("deck1.play", 1, "ui"); // pause master A (B keeps playing, synced)
    await engine.loadTrack(0, track("new-a"));
    engine.setBeatGrid(0, grid(90));
    expect(engine.getState().masterDeck).toBe(1);
    expect(engine.getBpm(1)).toBeCloseTo(120, 5);
  });

  it("a half-time follower phase-locks on every other master beat", async () => {
    await loadAll();
    engine.setBeatGrid(0, grid(140));
    engine.setBeatGrid(1, grid(70));
    bus.send("deck1.play", 1, "ui");
    bus.send("deck2.play", 1, "ui");
    bus.send("deck1.master", 1, "ui");
    bus.send("deck2.sync", 1, "ui");
    expect(engine.syncMultiple(1, 0)).toBe(0.5);
    expect(audio.rates[1]).toBeCloseTo(1);
    // A half-time beat spans two master beats; landing on any master beat (here an odd one) is aligned.
    audio.positions[0] = 9 * (60 / 140);
    audio.positions[1] = 4 * (60 / 70);
    expect(Math.abs(engine.phaseError(1, 0)!)).toBeLessThan(1e-9);
    audio.positions[1] += 0.1 * (60 / 70); // a tenth of a follower beat late
    expect(engine.phaseError(1, 0)!).toBeCloseTo(0.1, 6);
  });

  it("a double-time follower phase-locks two beats per master beat", async () => {
    await loadAll();
    engine.setBeatGrid(0, grid(85));
    engine.setBeatGrid(1, grid(170));
    for (const d of [1, 2]) bus.send(`deck${d}.play`, 1, "ui");
    bus.send("deck1.master", 1, "ui");
    bus.send("deck2.sync", 1, "ui");
    expect(engine.syncMultiple(1, 0)).toBe(2);
    audio.positions[0] = 3 * (60 / 85);
    audio.positions[1] = 7.25 * (60 / 170);
    expect(engine.phaseError(1, 0)!).toBeCloseTo(0.25, 6);
  });

  it("phase uses each deck's own (hand-corrected) beat grid", async () => {
    await loadAll();
    engine.setBeatGrid(0, grid(120, 0));
    engine.setBeatGrid(1, grid(120, 0.123, { manuallyAdjusted: true }));
    for (const d of [1, 2]) bus.send(`deck${d}.play`, 1, "ui");
    bus.send("deck1.master", 1, "ui");
    bus.send("deck2.sync", 1, "ui");
    audio.positions[0] = 10;
    audio.positions[1] = 10.123; // on its own (manual) grid's beat
    expect(Math.abs(engine.phaseError(1, 0)!)).toBeLessThan(1e-9);
  });

  it("after a seek the follower is corrected gradually (never jumped), and loops keep their phase", async () => {
    await fourPlaying([120, 120, 120, 120]);
    bus.send("deck1.master", 1, "ui");
    bus.send("deck3.sync", 1, "ui");
    audio.positions[0] = 20;
    bus.send("deck3.seek", 30.1 / 300, "ui"); // 30.1 s: 0.2 beat late
    const mark = audio.calls.length;
    engine.tick();
    expect(callsSince(mark).filter((c) => c.fn === "seek")).toEqual([]);
    expect(audio.rates[2]).toBeLessThan(1);
    expect(audio.rates[2]).toBeGreaterThanOrEqual(0.97);
    // A 4-beat loop on a beat keeps the follower on the grid: positions inside it compare by grid phase.
    audio.positions[2] = 32;
    bus.send("deck3.beatloop.4", 1, "ui");
    audio.positions[2] = 33.5; // wrapped inside the loop, on a beat
    audio.positions[0] = 41.5;
    expect(Math.abs(engine.phaseError(2, 0)!)).toBeLessThan(1e-9);
  });
});

describe("deck reservation (automation never takes over manual decks)", () => {
  it("decks A/B are available to automation, C/D are manual", () => {
    expect(engine.getState().reservations).toEqual(["automation", "automation", "manual", "manual"]);
  });

  it("an Auto DJ load onto a manual deck is refused; a manual load works", async () => {
    await engine.loadTrack(2, track("auto"), "auto-dj");
    expect(engine.getState().decks[2].status).toBe("empty");
    await engine.loadTrack(2, track("me"), "manual");
    expect(engine.getState().decks[2].status).toBe("ready");
    engine.setDeckReservation(2, "automation");
    await engine.loadTrack(2, track("auto2"), "auto-dj");
    expect(engine.getState().decks[2].track?.ref).toBe("auto2");
  });

  it("records load latency per deck for diagnostics", async () => {
    await loadAll();
    expect(engine.getLoadStats().map((l) => l.deck)).toEqual([0, 1, 2, 3]);
    expect(engine.getLoadStats().every((l) => l.ms >= 0)).toBe(true);
  });
});

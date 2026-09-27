import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { FakeAudioEngine } from "./fakes";

const track = (title: string): TrackInfo => ({ ref: title, title, artist: "", album: "", source: "local", bpm: null, key: null });

let bus: CommandBus;
let audio: FakeAudioEngine;
let engine: DJEngine;
let selected: TrackInfo | null;

async function loaded(deck = 0, seconds = 300) {
  await engine.loadTrack(deck, track(`t${deck}`));
  expect(engine.getState().decks[deck].status).toBe("ready");
  expect(engine.getState().decks[deck].duration).toBe(seconds);
}

beforeEach(() => {
  bus = new CommandBus();
  audio = new FakeAudioEngine();
  selected = null;
  engine = new DJEngine({
    bus,
    audio,
    log: new EventLog(),
    browser: { moveSelection: () => {}, getSelected: () => selected },
    loadBytes: async () => new ArrayBuffer(300), // fake decode: duration = byte length
  });
});

describe("transport", () => {
  it("play toggles", async () => {
    await loaded();
    bus.send("deck1.play", 1, "midi");
    bus.send("deck1.play", 0, "midi");
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(audio.playing[0]).toBe(true);
    bus.send("deck1.play", 1, "midi");
    expect(engine.getState().decks[0].playing).toBe(false);
  });

  it("ignores play on an empty deck", () => {
    bus.send("deck1.play", 1, "midi");
    expect(engine.getState().decks[0].playing).toBe(false);
  });

  it("CUE while playing returns to cue point and pauses", async () => {
    await loaded();
    bus.send("deck1.play");
    audio.positions[0] = 42;
    bus.send("deck1.cue", 1);
    expect(engine.getState().decks[0].playing).toBe(false);
    expect(audio.last("seek")?.args[0]).toBe(0);
  });

  it("CUE while paused away from cue sets a new cue point", async () => {
    await loaded();
    audio.positions[0] = 12.5;
    bus.send("deck1.cue", 1);
    bus.send("deck1.cue", 0);
    expect(engine.getState().decks[0].cuePoint).toBe(12.5);
    expect(engine.getState().decks[0].playing).toBe(false);
  });

  it("holding CUE at the cue point previews, release returns", async () => {
    await loaded();
    bus.send("deck1.cue", 1);
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(engine.getState().decks[0].previewing).toBe(true);
    audio.positions[0] = 3;
    bus.send("deck1.cue", 0);
    expect(engine.getState().decks[0].playing).toBe(false);
    expect(audio.last("seek")?.args[0]).toBe(0);
  });

  it("PLAY during CUE preview keeps playing after release", async () => {
    await loaded();
    bus.send("deck1.cue", 1);
    bus.send("deck1.play", 1);
    bus.send("deck1.cue", 0);
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(engine.getState().decks[0].previewing).toBe(false);
  });

  it("track end stops the deck", async () => {
    await loaded();
    bus.send("deck1.play");
    audio.fire({ type: "ended", deck: 0 });
    expect(engine.getState().decks[0].playing).toBe(false);
  });
});

describe("hot cues", () => {
  it("sets, jumps and clears", async () => {
    await loaded();
    audio.positions[0] = 10;
    bus.send("deck1.hotcue.1", 1);
    bus.send("deck1.hotcue.1", 0);
    expect(engine.getState().decks[0].hotcues[0]).toBe(10);
    expect(engine.getFeedback("deck1.hotcue.1")).toBe(1);

    bus.send("deck1.play");
    audio.positions[0] = 50;
    bus.send("deck1.hotcue.1", 1);
    expect(audio.last("seek")?.args[0]).toBe(10);
    expect(engine.getState().decks[0].playing).toBe(true);

    bus.send("deck1.hotcue.1.clear", 1);
    expect(engine.getState().decks[0].hotcues[0]).toBeNull();
    expect(engine.getFeedback("deck1.hotcue.1")).toBe(0);
  });
});

describe("tempo", () => {
  it("maps slider (down = faster by default) through the pitch range", async () => {
    await loaded();
    bus.send("deck1.tempo", 1); // slider fully down
    expect(audio.rates[0]).toBeCloseTo(1.1);
    bus.send("deck1.tempo", 0); // fully up
    expect(audio.rates[0]).toBeCloseTo(0.9);
    bus.send("deck1.tempo", 0.5);
    expect(audio.rates[0]).toBe(1);
  });

  it("cycles ranges 6/10/16/WIDE and rescales rate", () => {
    bus.send("deck1.tempo", 1);
    bus.send("deck1.tempo.range");
    expect(engine.getState().decks[0].tempoRange).toBe(0.16);
    expect(audio.rates[0]).toBeCloseTo(1.16);
    bus.send("deck1.tempo.range");
    expect(engine.getState().decks[0].tempoRange).toBe(1);
    bus.send("deck1.tempo.range");
    expect(engine.getState().decks[0].tempoRange).toBe(0.06);
  });

  it("respects the inverted direction setting", () => {
    engine.updateSettings({ tempoDownIsFaster: false });
    bus.send("deck1.tempo", 1);
    expect(audio.rates[0]).toBeCloseTo(0.9);
  });
});

describe("jog", () => {
  it("nudges while playing", async () => {
    await loaded();
    bus.send("deck1.play");
    bus.send("deck1.jog.ring", 4, "midi");
    expect(audio.last("nudge")?.args[0]).toBeGreaterThan(0);
  });

  it("seeks precisely while paused", async () => {
    await loaded();
    audio.positions[0] = 10;
    bus.send("deck1.jog.ring", 720, "midi"); // one revolution
    expect(audio.last("seek")?.args[0]).toBeCloseTo(11.8);
    expect(engine.getJogTicks(0)).toBe(720);
  });

  it("scratches when the platter is touched in vinyl mode", async () => {
    await loaded();
    bus.send("deck1.jog.touch", 1, "midi");
    expect(audio.scratching[0]).toBe(true);
    bus.send("deck1.jog.platter", -10, "midi");
    expect(audio.last("scratchMove")?.args[0]).toBeLessThan(0);
    bus.send("deck1.jog.touch", 0, "midi");
    expect(audio.scratching[0]).toBe(false);
  });

  it("does not scratch with vinyl mode off (touch + platter = nudge/seek)", async () => {
    await loaded();
    bus.send("deck1.vinyl", 1);
    bus.send("deck1.jog.touch", 1);
    bus.send("deck1.jog.platter", 5);
    expect(audio.last("scratchMove")).toBeUndefined();
    expect(audio.last("seek")).toBeDefined();
  });
});

describe("mixer", () => {
  it("channel fader and crossfader shape output gains", () => {
    bus.send("mixer.crossfader", 0); // full left
    expect(audio.channels[0].outputGain).toBe(1);
    expect(audio.channels[1].outputGain).toBe(0);
    bus.send("mixer.channel1.volume", 0.5);
    expect(audio.channels[0].outputGain).toBeCloseTo(0.25);
  });

  it("EQ kill forces the band to the kill level", () => {
    bus.send("mixer.channel2.eq.low.kill", 1);
    expect(audio.channels[1].eqLowDb).toBe(-40);
    expect(engine.getFeedback("mixer.channel2.eq.low.kill")).toBe(1);
  });

  it("PFL toggles and is reported as LED feedback", () => {
    bus.send("mixer.channel1.cue", 1);
    expect(audio.channels[0].pfl).toBe(true);
    expect(engine.getFeedback("mixer.channel1.cue")).toBe(1);
  });
});

describe("loading", () => {
  it("loads the browser selection", async () => {
    selected = track("selected");
    bus.send("browser.load.deck2", 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.getState().decks[1].track?.title).toBe("selected");
  });

  it("refuses to load into a playing deck", async () => {
    await loaded();
    bus.send("deck1.play");
    await engine.loadTrack(0, track("other"));
    expect(engine.getState().decks[0].track?.title).toBe("t0");
  });

  it("unimplemented actions are accepted without throwing", () => {
    expect(bus.send("deck1.loop.in", 1)).toBe(true);
    expect(bus.send("fx.unit1.knob", 0.3)).toBe(true);
  });
});

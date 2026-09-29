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

describe("manual mashup setup", () => {
  it("captures and restores deck, STEM, mixer and FX controls", async () => {
    await loaded(0); await loaded(1);
    engine.setStemsSupport(true);
    engine.setRateDirect(0, 1.06);
    engine.setStemMix(0, [true, false, true, false], [0.9, 0.8, 0.7, 0.6]);
    bus.send("mixer.channel1.filter", 0.72);
    bus.send("mixer.channel1.volume", 0.61);
    bus.send("mixer.crossfader", 0.27);
    const saved = engine.captureManualMashupSetup();

    engine.setRateDirect(0, 0.9);
    engine.setStemMix(0, [false, true, false, true], [0.1, 0.2, 0.3, 0.4]);
    bus.send("mixer.channel1.filter", 0.1);
    bus.send("mixer.crossfader", 0.9);
    engine.restoreManualMashupSetup(saved);

    expect(engine.getState().decks[0].rate).toBeCloseTo(1.06);
    expect(engine.getState().decks[0].stems.muted).toEqual([false, true, false, true]);
    expect(engine.getState().decks[0].stems.volume).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(engine.getState().mixer.channels[0].filter).toBeCloseTo(0.72);
    expect(engine.getState().mixer.channels[0].volume).toBeCloseTo(0.61);
    expect(engine.getState().mixer.crossfader).toBeCloseTo(0.27);
    expect(audio.rates[0]).toBeCloseTo(1.06);
    expect(audio.stems[0].mix).toEqual({ enabled: true, gains: [0.9, 0, 0.7, 0] });
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
    expect(bus.send("deck1.slip", 1)).toBe(true);
    expect(bus.send("fx.unit1.knob", 0.3)).toBe(true);
  });
});

describe("FX", () => {
  it("three slots per unit: FX1/FX2/FX3 buttons, effect cycling, level and deck assignment", async () => {
    await loaded();
    expect(audio.fx[0].slots.map((s) => s.type)).toEqual(["echo", "reverb", "flanger"]);
    bus.send("fx.unit1.button1", 1);
    bus.send("fx.unit1.button3", 1);
    expect(audio.fx[0].slots.map((s) => s.enabled)).toEqual([true, false, true]);
    expect(audio.fx[0].decks).toEqual([true, false]);
    expect(engine.getFeedback("fx.unit1.slot1.on")).toBe(1);
    expect(engine.getFeedback("fx.unit1.slot2.on")).toBe(0);
    expect(engine.getFeedback("fx.unit1.on")).toBe(1);
    bus.send("fx.unit1.slot1.next", 1); // SHIFT+FX1 on the DDJ-SB
    expect(audio.fx[0].slots[0].type).toBe("delay");
    expect(engine.getSettings().fxAssign[0]).toEqual(["delay", "reverb", "flanger"]);
    bus.send("fx.unit1.knob", 0.8);
    expect(audio.fx[0].mix).toBeCloseTo(0.8);
    bus.send("fx.unit1.knob.shift", 0.2); // parameter of all slots
    expect(audio.fx[0].slots.every((s) => Math.abs(s.param - 0.2) < 1e-9)).toBe(true);
    bus.send("fx.unit1.assign.deck2", 1);
    expect(audio.fx[0].decks).toEqual([true, true]);
    bus.send("fx.unit1.on", 1); // unit off = every slot off
    expect(audio.fx[0].slots.some((s) => s.enabled)).toBe(false);
  });

  it("effect assignments can be set and are restored from settings", () => {
    engine.setFxSlotType(1, 2, "bitcrusher");
    const saved = engine.getSettings().fxAssign;
    const e2 = new DJEngine({ bus: new CommandBus(), audio: new FakeAudioEngine(), log: new EventLog(), browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(1), settings: { fxAssign: saved } });
    expect(e2.getState().fx[1].slots[2].type).toBe("bitcrusher");
  });

  it("echo time follows the deck's beat grid and pitch", async () => {
    await loaded();
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0.1, confidence: 3, source: "analysis" });
    // default 3/4 beat at 120 BPM = 0.375 s
    expect(audio.fx[0].timeSec).toBeCloseTo(0.375);
    bus.send("deck1.tempo", 1); // +10% → 132 BPM
    expect(audio.fx[0].timeSec).toBeCloseTo((0.75 * 60) / 132);
    bus.send("fx.unit1.beats.next", 1); // next beat length (1 beat)
    expect(audio.fx[0].timeSec).toBeCloseTo(60 / 132);
    expect(engine.getBpm(0)).toBeCloseTo(132);
  });
});

describe("STEMS", () => {
  it("is unavailable until the stem service enables it; the original plays untouched", async () => {
    await loaded();
    bus.send("deck1.stems", 1);
    expect(engine.getState().decks[0].stems.enabled).toBe(false);
    expect(engine.getState().decks[0].stems.status).toBe("unavailable");
    expect(audio.stems[0].mix).toEqual({ enabled: false, gains: [1, 1, 1, 1] });
  });

  it("mute, volume and isolate reach the audio engine", async () => {
    engine.setStemsSupport(true);
    await loaded();
    expect(engine.getState().decks[0].stems.status).toBe("waiting");
    bus.send("deck1.stem.drums.toggle", 1); // auto-enables STEMS
    expect(audio.stems[0].mix).toEqual({ enabled: true, gains: [1, 0, 1, 1] });
    bus.send("deck1.stem.vocals.volume", 0.5);
    expect(audio.stems[0].mix?.gains).toEqual([0.5, 0, 1, 1]);
    bus.send("deck1.stem.bass.isolate", 1);
    expect(audio.stems[0].mix?.gains).toEqual([0, 0, 1, 0]);
    expect(engine.getFeedback("deck1.stem.bass")).toBe(1);
    expect(engine.getFeedback("deck1.stem.vocals")).toBe(0);
    bus.send("deck1.stem.bass.isolate", 1); // solo again → everything back
    expect(audio.stems[0].mix?.gains).toEqual([0.5, 1, 1, 1]);
    bus.send("deck1.stems", 1);
    expect(audio.stems[0].mix?.enabled).toBe(false);
  });

  it("a new track resets mutes but keeps STEMS mode and volumes", async () => {
    engine.setStemsSupport(true);
    await loaded();
    bus.send("deck1.stem.vocals.toggle", 1);
    await loaded();
    const st = engine.getState().decks[0].stems;
    expect(st.enabled).toBe(true);
    expect(st.muted).toEqual([false, false, false, false]);
    expect(audio.stems[0].mix).toEqual({ enabled: true, gains: [1, 1, 1, 1] });
  });

  it("disabling support switches STEMS off", async () => {
    engine.setStemsSupport(true);
    await loaded();
    bus.send("deck1.stems", 1);
    engine.setStemsSupport(false, "model missing");
    expect(engine.getState().decks[0].stems).toMatchObject({ enabled: false, status: "unavailable", message: "model missing" });
    expect(audio.stems[0].mix?.enabled).toBe(false);
  });

  it("FX target sends a single stem", () => {
    bus.send("fx.unit1.button1", 1);
    expect(audio.fx[0].stemMask).toBeNull();
    bus.send("fx.unit1.target.next", 1); // vocals
    expect(audio.fx[0].stemMask).toEqual([1, 0, 0, 0]);
  });
});

describe("loops", () => {
  const grid = (bpm: number, firstBeat: number) => ({ bpm, firstBeat, confidence: 1, source: "analysis" as const });

  it("auto loop starts on the current beat, is beat-long and toggles off", async () => {
    await loaded();
    engine.setBeatGrid(0, grid(120, 0.1));
    audio.positions[0] = 10.3;
    bus.send("deck1.beatloop.4", 1);
    expect(audio.loops[0]!.start).toBeCloseTo(10.1);
    expect(audio.loops[0]!.end).toBeCloseTo(12.1);
    expect(engine.getFeedback("deck1.loop")).toBe(1);
    bus.send("deck1.loop.halve", 1);
    expect(audio.loops[0]!.end).toBeCloseTo(11.1);
    expect(engine.getState().decks[0].loop?.beats).toBe(2);
    bus.send("deck1.beatloop.2", 1); // same size again = exit
    expect(audio.loops[0]).toBeNull();
    expect(engine.getState().decks[0].loop).toMatchObject({ active: false });
  });

  it("sub-beat loops snap to their own grid", async () => {
    await loaded();
    engine.setBeatGrid(0, grid(120, 0.1));
    audio.positions[0] = 10.3;
    bus.send("deck1.beatloop.0.25", 1);
    expect(audio.loops[0]!.start).toBeCloseTo(10.225);
    expect(audio.loops[0]!.end).toBeCloseTo(10.35);
  });

  it("manual loop in/out quantizes to the grid; exit and reloop", async () => {
    await loaded();
    engine.setBeatGrid(0, grid(120, 0.1));
    audio.positions[0] = 20.02;
    bus.send("deck1.loop.in", 1);
    audio.positions[0] = 22.08;
    bus.send("deck1.loop.out", 1);
    expect(audio.loops[0]).toEqual({ start: expect.closeTo(20.1), end: expect.closeTo(22.1) });
    expect(engine.getState().decks[0].loop?.beats).toBe(4);
    bus.send("deck1.loop.exit", 1);
    expect(audio.loops[0]).toBeNull();
    audio.positions[0] = 40;
    bus.send("deck1.loop.exit", 1); // reloop jumps back in
    expect(audio.loops[0]).not.toBeNull();
    expect(audio.positions[0]).toBeCloseTo(20.1);
  });

  it("seeking out of an active loop exits it; moving shifts it", async () => {
    await loaded();
    engine.setBeatGrid(0, grid(120, 0));
    audio.positions[0] = 10;
    bus.send("deck1.beatloop.4", 1);
    bus.send("deck1.loop.move.forward", 1);
    expect(audio.loops[0]).toEqual({ start: expect.closeTo(12), end: expect.closeTo(14) });
    bus.send("deck1.seek", 0.5);
    expect(audio.loops[0]).toBeNull();
  });

  it("loop roll returns to where playback would have been (slip)", async () => {
    await loaded();
    engine.setBeatGrid(0, grid(120, 0));
    audio.positions[0] = 10.3;
    bus.send("deck1.beatloop.roll.0.5", 1);
    expect(audio.loops[0]!.end - audio.loops[0]!.start).toBeCloseTo(0.25);
    bus.send("deck1.beatloop.roll.0.5", 0);
    expect(audio.loops[0]).toBeNull();
    expect(audio.positions[0]).toBeCloseTo(10.3); // paused deck: no time passed
  });
});

describe("sync", () => {
  const grid = (bpm: number, firstBeat = 0) => ({ bpm, firstBeat, confidence: 1, source: "analysis" as const });

  it("follows the master's BPM and its tempo changes; master is indicated", async () => {
    await loaded(0);
    await loaded(1);
    engine.setBeatGrid(0, grid(120));
    engine.setBeatGrid(1, grid(125));
    bus.send("deck2.sync", 1);
    expect(engine.getState().masterDeck).toBe(0);
    expect(engine.getFeedback("deck1.master")).toBe(1);
    expect(audio.rates[1]).toBeCloseTo(0.96);
    expect(engine.getBpm(1)).toBeCloseTo(120);
    bus.send("deck1.tempo", 0.25); // master +5% (pull down = faster)
    expect(engine.getBpm(1)).toBeCloseTo(engine.getBpm(0)!);
  });

  it("half/double tempo tracks sync without extreme pitch", async () => {
    await loaded(0);
    await loaded(1);
    engine.setBeatGrid(0, grid(140));
    engine.setBeatGrid(1, grid(70));
    bus.send("deck2.sync", 1);
    expect(audio.rates[1]).toBeCloseTo(1);
  });

  it("moving a follower's tempo slider hands control back to the DJ", async () => {
    await loaded(0);
    await loaded(1);
    engine.setBeatGrid(0, grid(120));
    engine.setBeatGrid(1, grid(122));
    bus.send("deck2.sync", 1);
    bus.send("deck2.tempo", 0.6);
    expect(engine.getState().decks[1].sync).toBe(false);
  });

  it("snaps onto the beat when engaged and phase-locks with small corrections", async () => {
    await loaded(0);
    await loaded(1);
    engine.setBeatGrid(0, grid(120));
    engine.setBeatGrid(1, grid(120));
    bus.send("deck1.play");
    bus.send("deck2.play");
    audio.positions[0] = 10; // on a beat
    audio.positions[1] = 20.125; // a quarter beat late
    bus.send("deck2.sync", 1);
    expect(audio.positions[1]).toBeCloseTo(20); // one de-clicked jump onto the beat
    audio.positions[1] = 20.01; // small drift afterwards
    engine.tick();
    expect(audio.rates[1]).toBeLessThan(1);
    expect(audio.rates[1]).toBeGreaterThan(0.97); // correction is gentle
  });
});

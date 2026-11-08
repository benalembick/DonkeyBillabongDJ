import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine, type DeckState } from "../src/core/engine/DJEngine";
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

  it("scratches from the on-screen waveform, playing or paused, whatever the vinyl setting", async () => {
    expect(engine.beginScratch(0)).toBe(false); // nothing loaded
    await loaded();
    bus.send("deck1.vinyl", 1); // vinyl off: the waveform still scratches
    expect(engine.beginScratch(0)).toBe(true);
    expect(audio.scratching[0]).toBe(true);
    expect(engine.getState().decks[0].scratching).toBe(true);
    engine.scratchBy(0, -0.25);
    expect(audio.last("scratchMove")?.args[0]).toBe(-0.25);
    engine.endScratch(0);
    expect(audio.scratching[0]).toBe(false);
    expect(engine.getState().decks[0].scratching).toBe(false);
    expect(engine.getState().decks[0].playing).toBe(false); // paused stays paused
    const moves = audio.calls.filter((c) => c.fn === "scratchMove").length;
    engine.scratchBy(0, 1); // ignored once released
    expect(audio.calls.filter((c) => c.fn === "scratchMove").length).toBe(moves);
  });

  it("KEY LOCK toggles time-stretching in the audio engine and survives ejecting the track", async () => {
    await loaded();
    bus.send("deck1.keylock", 1);
    expect(audio.keylock[0]).toBe(true);
    expect(engine.getState().decks[0].keylock).toBe(true);
    expect(engine.getFeedback("deck1.keylock")).toBe(1);
    bus.send("deck1.eject", 1);
    expect(engine.getState().decks[0].keylock).toBe(true);
    expect(audio.keylock[0]).toBe(true);
    bus.send("deck1.keylock", 1);
    expect(audio.keylock[0]).toBe(false);
    expect(engine.getState().decks[0].keylock).toBe(false);
  });

  it("releasing the waveform doesn't end a scratch held on the hardware platter", async () => {
    await loaded();
    bus.send("deck1.jog.touch", 1, "midi");
    engine.beginScratch(0);
    engine.endScratch(0);
    expect(audio.scratching[0]).toBe(true);
    bus.send("deck1.jog.touch", 0, "midi");
    expect(audio.scratching[0]).toBe(false);
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

  it("an Auto DJ load turns STEMS back off instead of carrying it over from whatever played here before", async () => {
    engine.setStemsSupport(true);
    await loaded();
    bus.send("deck1.stem.vocals.toggle", 1);
    expect(engine.getState().decks[0].stems.enabled).toBe(true);
    await engine.loadTrack(0, track("next"), "auto-dj");
    const st = engine.getState().decks[0].stems;
    expect(st.enabled).toBe(false);
    expect(audio.stems[0].mix?.enabled).toBe(false);
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

  describe("live Adjust Loop Out (DDJ-SB: LOOP OUT again, then jog)", () => {
    it("OUT on an active manual loop enters adjust mode; the jog wheel then moves only the end", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1); // loop [10, 12]
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
      bus.send("deck1.loop.out", 1); // enter
      expect(engine.getState().decks[0].loopOutAdjust).toBe(true);
      bus.send("deck1.jog.ring", -360, "midi"); // half a revolution back: shortens by 0.9s
      const lp = engine.getState().decks[0].loop!;
      expect(lp.start).toBeCloseTo(10);
      expect(lp.end).toBeCloseTo(11.1);
      expect(audio.loops[0]).toEqual({ start: expect.closeTo(10), end: expect.closeTo(11.1) });
      bus.send("deck1.loop.out", 1); // finish
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
      expect(engine.getState().decks[0].loop?.active).toBe(true); // the edited loop stays active
    });

    it("turning the other way lengthens the loop; the IN point never moves", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1); // loop [10, 12]
      bus.send("deck1.loop.out", 1);
      bus.send("deck1.jog.platter", 720, "midi"); // one full revolution forward: +1.8s
      const lp = engine.getState().decks[0].loop!;
      expect(lp.start).toBeCloseTo(10);
      expect(lp.end).toBeCloseTo(13.8);
    });

    it("shrinking past the playhead wraps playback back to IN, clamped at the minimum length", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1); // loop [10, 12]
      audio.positions[0] = 11.9; // playhead near the (old) end
      bus.send("deck1.loop.out", 1);
      bus.send("deck1.jog.ring", -1200, "midi"); // way more than the loop's own length
      const lp = engine.getState().decks[0].loop!;
      expect(lp.end).toBeCloseTo(lp.start + 0.01, 2); // clamped to the minimum playable length
      // the old playhead (11.9) was left of the new end: wrapped back inside [start, end)
      expect(audio.positions[0]).toBeGreaterThanOrEqual(lp.start);
      expect(audio.positions[0]).toBeLessThan(lp.end + 1e-6);
    });

    it("extending back out towards the end of the track keeps the endpoint valid", async () => {
      await loaded(); // duration 300
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      bus.send("deck1.jog.ring", 1_000_000, "midi"); // absurdly large: clamp at the track's duration
      const lp = engine.getState().decks[0].loop!;
      expect(lp.end).toBeCloseTo(300);
      expect(lp.end).toBeLessThanOrEqual(300);
      bus.send("deck1.loop.out", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
    });

    it("touching or releasing the wheel while adjusting never scratches, nudges or seeks", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.vinyl", 1); // ensure vinyl mode is on (initialDeck default)
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      bus.send("deck1.jog.touch", 1, "midi");
      expect(audio.scratching[0]).toBe(false);
      expect(engine.getState().decks[0].jogTouched).toBe(true);
      bus.send("deck1.jog.platter", -10, "midi");
      expect(audio.last("scratchMove")).toBeUndefined();
      expect(audio.last("nudge")).toBeUndefined();
      bus.send("deck1.jog.touch", 0, "midi");
      expect(audio.scratching[0]).toBe(false);
    });

    it("deactivating (EXIT) or replacing the loop leaves adjust mode", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(true);
      bus.send("deck1.loop.exit", 1); // deactivate
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
      expect(engine.getState().decks[0].loop?.active).toBe(false);
    });

    it("pressing IN to start a new loop leaves adjust mode on the old one", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(true);
      bus.send("deck1.loop.in", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
    });

    it("loading a new track onto the deck leaves adjust mode", async () => {
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(true);
      await engine.loadTrack(0, track("replacement"));
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
    });

    it("exitAllLoopOutAdjust leaves adjust mode on every deck independently (e.g. the controller disconnects)", async () => {
      await loaded(0);
      await loaded(1);
      engine.setBeatGrid(0, grid(120, 0));
      engine.setBeatGrid(1, grid(120, 0));
      audio.positions[0] = 10;
      audio.positions[1] = 20;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck2.beatloop.4", 1);
      bus.send("deck1.loop.out", 1);
      expect(engine.getState().decks[0].loopOutAdjust).toBe(true);
      expect(engine.getState().decks[1].loopOutAdjust).toBe(false); // deck 2 never entered it
      engine.exitAllLoopOutAdjust();
      expect(engine.getState().decks[0].loopOutAdjust).toBe(false);
      expect(engine.getState().decks[0].loop?.active).toBe(true); // the loop itself is untouched
      expect(engine.getState().decks[1].loopOutAdjust).toBe(false);
    });

    it("other deck, auto loops and the other manual loop controls are unaffected", async () => {
      await loaded(0);
      await loaded(1);
      engine.setBeatGrid(0, grid(120, 0));
      engine.setBeatGrid(1, grid(120, 0));
      audio.positions[0] = 10;
      audio.positions[1] = 10;
      bus.send("deck1.beatloop.4", 1);
      bus.send("deck1.loop.out", 1); // deck 1 adjusting
      bus.send("deck2.beatloop.4", 1); // deck 2: ordinary auto loop, untouched by deck 1's mode
      expect(audio.loops[1]).toEqual({ start: expect.closeTo(10), end: expect.closeTo(12) });
      bus.send("deck1.jog.ring", -360, "midi"); // shortens to [10, 11.1]
      bus.send("deck1.loop.out", 1); // finish deck 1
      bus.send("deck1.loop.halve", 1); // normal loop control still works afterwards
      expect(engine.getState().decks[0].loop?.end).toBeCloseTo(10.55);
    });

    it("a live drag does not push the loop to preparation on every tick, only once it finishes", async () => {
      const changes: Partial<DeckState>[] = [];
      engine.setPreparationPort({
        restore: async () => ({}),
        changed: (_previous, _next, patch) => {
          if ("loop" in patch) changes.push(patch);
        },
      });
      await loaded();
      engine.setBeatGrid(0, grid(120, 0));
      audio.positions[0] = 10;
      bus.send("deck1.beatloop.4", 1); // a durable loop change: reaches preparation once
      expect(changes).toHaveLength(1);
      bus.send("deck1.loop.out", 1); // enter adjust (no "loop" key in this patch)
      bus.send("deck1.jog.ring", -120, "midi");
      bus.send("deck1.jog.ring", -120, "midi");
      bus.send("deck1.jog.ring", -120, "midi");
      expect(changes).toHaveLength(1); // none of the drag ticks reached preparation
      bus.send("deck1.loop.out", 1); // finish: the settled end reaches preparation once
      expect(changes).toHaveLength(2);
      expect(changes[1].loop?.end).toBeCloseTo(engine.getState().decks[0].loop!.end);
    });
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

describe("Auto DJ EQ automation", () => {
  it("emits a state change for the UI on every automation step — the engine state alone isn't enough for the mixer to re-render", () => {
    const seen: number[] = [];
    const off = engine.on("state", (s) => seen.push(s.autoEq[0].lowDb));
    engine.setAutoEq(0, { low: -5, mid: 0, high: 0 });
    expect(seen.at(-1)).toBe(-5);
    bus.send("mixer.channel1.eq.low", 0.5); // takeover
    engine.cancelAutoEq(0);
    engine.tick(); // the decay step
    expect(seen.at(-1)).toBeLessThan(-0.01); // decaying, and the UI was told about it
    engine.resetAutoEq(0);
    expect(seen.at(-1)).toBe(0);
    off();
  });

  it("adds on top of the manual EQ and clamps at the kill floor, without changing the stored knob", () => {
    engine.setAutoEq(0, { low: -6, mid: 0, high: 0 }); // flat manual EQ (0.5) minus a 6 dB auto cut
    expect(audio.channels[0].eqLowDb).toBeCloseTo(-6, 5);
    bus.send("mixer.channel1.gain", 0.9); // touch something unrelated — the knob stays exactly where it was
    engine.setAutoEq(0, { low: -6, mid: 0, high: 0 });
    expect(engine.getState().mixer.channels[0].eqLow).toBe(0.5); // automation never writes the stored knob
    engine.setAutoEq(0, { low: -60, mid: 0, high: 0 }); // far past the kill floor
    expect(audio.channels[0].eqLowDb).toBe(-40);
  });

  it("only writes bands that are still under automation", () => {
    engine.setAutoEq(0, { low: -10, mid: -5, high: -2 });
    expect(engine.getState().autoEq[0]).toMatchObject({ lowDb: -10, midDb: -5, highDb: -2 });
    bus.send("mixer.channel1.eq.low", 0.5); // manual move: low is handed back
    expect(engine.getState().autoEq[0].lowActive).toBe(false);
    engine.setAutoEq(0, { low: -30, mid: -8, high: -3 }); // further pushes ignore the taken-over band
    expect(engine.getState().autoEq[0].midDb).toBe(-8);
    expect(engine.getState().autoEq[0].highDb).toBe(-3);
    expect(engine.getState().autoEq[0].lowDb).toBe(-10); // frozen at its last automated value, not re-targeted
  });

  it("treats a kill press the same as a knob move: hands back only that band", () => {
    engine.setAutoEq(0, { low: -10, mid: -10, high: -10 });
    bus.send("mixer.channel1.eq.high.kill", 1);
    expect(engine.getState().autoEq[0]).toMatchObject({ lowActive: true, midActive: true, highActive: false });
  });

  it("decays a taken-over band smoothly toward neutral over subsequent ticks, without affecting an active band", () => {
    engine.setAutoEq(0, { low: -10, mid: -10, high: -10 });
    bus.send("mixer.channel1.eq.low", 0.5); // hands back low only
    const before = engine.getState().autoEq[0].lowDb;
    engine.tick();
    const afterOneTick = engine.getState().autoEq[0].lowDb;
    expect(afterOneTick).toBeLessThan(0);
    expect(Math.abs(afterOneTick)).toBeLessThan(Math.abs(before)); // decaying toward 0
    expect(engine.getState().autoEq[0].midDb).toBe(-10); // mid is still active and untouched by decay
    for (let i = 0; i < 30; i++) engine.tick();
    expect(engine.getState().autoEq[0].lowDb).toBe(0); // settles at exactly neutral, not asymptotically close
  });

  it("cancelAutoEq hands every band back at once and lets them all decay out", () => {
    engine.setAutoEq(0, { low: -10, mid: -10, high: -10 });
    engine.cancelAutoEq(0);
    expect(engine.getState().autoEq[0]).toMatchObject({ lowActive: false, midActive: false, highActive: false });
    for (let i = 0; i < 30; i++) engine.tick();
    expect(engine.getState().autoEq[0]).toMatchObject({ lowDb: 0, midDb: 0, highDb: 0 });
  });

  it("resetAutoEq clears everything immediately and re-arms every band for the next transition", () => {
    engine.setAutoEq(0, { low: -10, mid: -10, high: -10 });
    bus.send("mixer.channel1.eq.low", 0.5);
    engine.resetAutoEq(0);
    expect(engine.getState().autoEq[0]).toEqual({ lowDb: 0, midDb: 0, highDb: 0, lowActive: true, midActive: true, highActive: true });
  });

  it("a newly loaded track never inherits the previous track's in-flight automation", async () => {
    await loaded(0);
    engine.setAutoEq(0, { low: -10, mid: -10, high: -10 });
    bus.send("mixer.channel1.eq.mid", 0.5);
    await loaded(0);
    expect(engine.getState().autoEq[0]).toEqual({ lowDb: 0, midDb: 0, highDb: 0, lowActive: true, midActive: true, highActive: true });
  });
});

describe("Auto DJ tempo lead-in", () => {
  it("steps the rate toward the target by at most maxStep per call, converging without overshoot", async () => {
    await loaded(0);
    engine.stepTempoLeadIn(0, 1.08, 0.0004);
    expect(engine.getState().decks[0].rate).toBeCloseTo(1.0004, 6);
    for (let i = 0; i < 1000; i++) engine.stepTempoLeadIn(0, 1.08, 0.0004);
    expect(engine.getState().decks[0].rate).toBeCloseTo(1.08, 6);
  });

  it("is eligible by default and widens the tempo range if the target needs it (same honesty rule as setRateDirect)", async () => {
    await loaded(0);
    for (let i = 0; i < 500; i++) engine.stepTempoLeadIn(0, 1.14, 0.0004);
    expect(engine.getState().decks[0].rate).toBeCloseTo(1.14, 5);
    expect(engine.getState().decks[0].tempoRange).toBe(0.16);
  });

  it("a manual tempo-fader move hands the deck back and freezes it against further nudging", async () => {
    await loaded(0);
    engine.stepTempoLeadIn(0, 1.08, 0.0004);
    bus.send("deck1.tempo", 0.5); // centre detent: the fader itself, not AutoDJ
    const rateAfterTakeover = engine.getState().decks[0].rate;
    expect(engine.getState().tempoLeadInActive[0]).toBe(false);
    for (let i = 0; i < 100; i++) engine.stepTempoLeadIn(0, 1.08, 0.0004);
    expect(engine.getState().decks[0].rate).toBe(rateAfterTakeover); // unchanged: the nudge is a no-op now
  });

  it("cycling the tempo range by hand is also a takeover", async () => {
    await loaded(0);
    bus.send("deck1.tempo.range");
    expect(engine.getState().tempoLeadInActive[0]).toBe(false);
  });

  it("a fresh track load re-arms eligibility", async () => {
    await loaded(0);
    bus.send("deck1.tempo", 0.5);
    expect(engine.getState().tempoLeadInActive[0]).toBe(false);
    await loaded(0);
    expect(engine.getState().tempoLeadInActive[0]).toBe(true);
  });
});

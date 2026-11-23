/**
 * DDJ-SB deck layers (docs/architecture/four-deck-performance-engine.md §9, §29 "Controller integration").
 * Real DDJ-SB MIDI bytes go through the built-in mapping, ControllerManager (layer routing + soft takeover)
 * and the command bus into a four-deck engine — the same path as hardware, minus the USB port.
 * Physical verification on a DDJ-SB is still required (docs/HARDWARE-TEST-PLAN.md).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { ControllerManager } from "../src/controllers/ControllerManager";
import { DeckLayers, registerLayerActions } from "../src/controllers/layers";
import { SoftTakeover } from "../src/controllers/softTakeover";
import { buildDdjSbMapping } from "../src/controllers/profiles/pioneer-ddj-sb";
import { FakeAudioEngine } from "./fakes";

const track = (title: string): TrackInfo => ({ ref: title, title, artist: "", album: "", source: "local", bpm: null, key: null });

let bus: CommandBus;
let audio: FakeAudioEngine;
let engine: DJEngine;
let layers: DeckLayers;
let controllers: ControllerManager;
const midi = (...bytes: number[]) => controllers.simulate("pioneer-ddj-sb", bytes);
/** A 14-bit control (MSB then LSB) at a 0..1 position. */
const cc14 = (status: number, msb: number, v: number) => {
  const full = Math.round(v * 16383);
  midi(status, msb, full >> 7);
  midi(status, msb + 0x20, full & 0x7f);
};

beforeEach(async () => {
  bus = new CommandBus();
  audio = new FakeAudioEngine(4);
  engine = new DJEngine({ bus, audio, log: new EventLog(), deckCount: 4, browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(300) });
  layers = new DeckLayers();
  registerLayerActions(bus, layers);
  controllers = new ControllerManager({ bus, feedback: engine, log: new EventLog(), mappings: [buildDdjSbMapping()], layers, takeover: new SoftTakeover((a) => engine.getActionValue(a)) });
  for (let i = 0; i < 4; i++) await engine.loadTrack(i, track(`t${i}`));
});

describe("DDJ-SB deck layers", () => {
  it("SHIFT + KEY LOCK toggles the left side between decks A and C, the right side between B and D", () => {
    layers.setEnabled(true);
    midi(0x90, 0x60, 0x7f);
    midi(0x90, 0x60, 0x00);
    expect(layers.getState()).toMatchObject({ left: 2, right: 1 });
    midi(0x91, 0x60, 0x7f);
    expect(layers.getState()).toMatchObject({ left: 2, right: 3 });
    midi(0x90, 0x60, 0x7f);
    expect(layers.getState()).toMatchObject({ left: 0, right: 3 });
  });

  it("in 2 DECK mode SHIFT + KEY LOCK stays TEMPO RANGE and layers don't move", () => {
    const before = engine.getState().decks[0].tempoRange;
    midi(0x90, 0x60, 0x7f);
    expect(layers.getState()).toMatchObject({ left: 0, right: 1 });
    expect(engine.getState().decks[0].tempoRange).not.toBe(before);
  });

  it("transport commands reach the selected deck", () => {
    layers.setEnabled(true);
    layers.set("left", 2);
    midi(0x90, 0x0b, 0x7f); // PLAY A side
    midi(0x90, 0x0b, 0x00);
    expect(engine.getState().decks.map((d) => d.playing)).toEqual([false, false, true, false]);
    layers.set("right", 3);
    midi(0x91, 0x0b, 0x7f);
    expect(engine.getState().decks[3].playing).toBe(true);
  });

  it("jog wheel ticks reach the selected deck", () => {
    layers.setEnabled(true);
    layers.set("left", 2);
    midi(0xb0, 0x21, 0x44); // ring +4
    expect(engine.getJogTicks(2)).toBe(4);
    expect(engine.getJogTicks(0)).toBe(0);
  });

  it("hot cue pad banks are independent of the deck layer", () => {
    layers.setEnabled(true);
    layers.set("left", 2);
    audio.positions[2] = 12;
    midi(0x97, 0x00, 0x7f); // HOT CUE mode, pad 1 → hot cue 1
    midi(0x97, 0x00, 0x00);
    audio.positions[2] = 34;
    midi(0x97, 0x40, 0x7f); // alternate bank, pad 1 → hot cue 5
    midi(0x97, 0x40, 0x00);
    expect(engine.getState().decks[2].hotcues[0]).toBe(12);
    expect(engine.getState().decks[2].hotcues[4]).toBe(34);
    expect(engine.getState().decks[0].hotcues.every((h) => h === null)).toBe(true);
    expect(layers.getState().left).toBe(2); // pad bank presses never move the layer
    layers.set("left", 0);
    audio.positions[0] = 56;
    midi(0x97, 0x40, 0x7f);
    expect(engine.getState().decks[0].hotcues[4]).toBe(56);
  });

  it("a button release goes to the deck its press went to, even if the layer changed in between", () => {
    layers.setEnabled(true);
    midi(0x90, 0x0c, 0x7f); // CUE held on deck A (paused at the cue point → preview)
    expect(engine.getState().decks[0].previewing).toBe(true);
    layers.set("left", 2);
    midi(0x90, 0x0c, 0x00);
    expect(engine.getState().decks[0].previewing).toBe(false);
    expect(engine.getState().decks[2].previewing).toBe(false);
  });

  it("LED feedback follows the selected deck, and the layer LED lights for deck C/D", () => {
    layers.setEnabled(true);
    bus.send("deck3.play", 1, "ui");
    expect(controllers.feedbackValue("deck1.playing")).toBe(0);
    expect(controllers.feedbackValue("controller.layer.left.alt")).toBe(0);
    layers.set("left", 2);
    expect(controllers.feedbackValue("deck1.playing")).toBe(1);
    expect(controllers.feedbackValue("controller.layer.left.alt")).toBe(1);
    expect(controllers.feedbackValue("mixer.channel1.cue")).toBe(0);
    bus.send("mixer.channel3.cue", 1, "ui");
    expect(controllers.feedbackValue("mixer.channel1.cue")).toBe(1);
    // The mapping lights the SHIFT+KEY LOCK LED (0x60) from the layer state, as Mixxx's DDJ-SB script does.
    expect(buildDdjSbMapping().outputs).toContainEqual(expect.objectContaining({ feedback: "controller.layer.left.alt", midi: { type: "note", channel: 1, number: 0x60 } }));
  });

  it("the MIDI monitor shows where the layer routed an action", () => {
    layers.setEnabled(true);
    layers.set("right", 3);
    const seen: string[] = [];
    controllers.on("monitor", (e) => e.translations.forEach((t) => seen.push(t.routed ?? t.action)));
    midi(0x91, 0x0b, 0x7f);
    expect(seen).toEqual(["deck4.play"]);
  });

  it("leaving 4 DECK mode puts both sides back on A and B", () => {
    layers.setEnabled(true);
    layers.set("left", 2);
    layers.set("right", 3);
    layers.setEnabled(false);
    expect(layers.getState()).toMatchObject({ left: 0, right: 1 });
    midi(0x90, 0x0b, 0x7f);
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(layers.set("left", 2)).toBe(false);
  });

  it("global controls keep their global behaviour on any layer", () => {
    layers.setEnabled(true);
    layers.set("left", 2);
    layers.set("right", 3);
    cc14(0xb6, 0x1f, 0.5); // crossfader (ch 7) — primed on first connection, applies at once
    cc14(0xb6, 0x1f, 0.2);
    expect(engine.getState().mixer.crossfader).toBeCloseTo(0.2, 3);
  });
});

describe("DDJ-SB soft takeover across layers", () => {
  it("switching layers never jumps the new deck's volume to the fader position", () => {
    layers.setEnabled(true);
    cc14(0xb0, 0x13, 0.8); // channel fader A side → deck A volume 0.8 (primed: applies)
    expect(engine.getState().mixer.channels[0].volume).toBeCloseTo(0.8, 3);
    bus.send("mixer.channel3.volume", 0.2, "ui");
    midi(0x90, 0x60, 0x7f); // SHIFT + KEY LOCK: left side → deck C
    cc14(0xb0, 0x13, 0.78);
    expect(engine.getState().mixer.channels[2].volume).toBeCloseTo(0.2, 6);
    expect(engine.getState().mixer.channels[0].volume).toBeCloseTo(0.8, 3); // deck A untouched too
    expect(controllers.takeover!.getPickups()).toEqual([expect.objectContaining({ target: "mixer.channel3.volume", direction: -1 })]);
    cc14(0xb0, 0x13, 0.5);
    expect(engine.getState().mixer.channels[2].volume).toBeCloseTo(0.2, 6);
    cc14(0xb0, 0x13, 0.21); // within the pickup tolerance
    expect(engine.getState().mixer.channels[2].volume).toBeCloseTo(0.21, 3);
    cc14(0xb0, 0x13, 0.6);
    expect(engine.getState().mixer.channels[2].volume).toBeCloseTo(0.6, 3);
    expect(controllers.takeover!.getPickups()).toEqual([]);
  });

  it("the tempo slider and EQ knobs wait for pickup too; jog and buttons never do", () => {
    layers.setEnabled(true);
    cc14(0xb0, 0x0f, 0.5); // LOW A at centre (primed)
    cc14(0xb0, 0x00, 0.5); // tempo A at centre
    bus.send("mixer.channel3.eq.low", 0.9, "ui");
    bus.send("deck3.tempo", 0.3, "ui");
    const rate = engine.getState().decks[2].rate;
    layers.set("left", 2);
    cc14(0xb0, 0x0f, 0.45);
    cc14(0xb0, 0x00, 0.55);
    expect(engine.getState().mixer.channels[2].eqLow).toBeCloseTo(0.9, 6);
    expect(engine.getState().decks[2].rate).toBe(rate);
    midi(0xb0, 0x21, 0x41); // jog: relative, never held back
    expect(engine.getJogTicks(2)).toBe(1);
  });

  it("returning to deck A after moving the fader on deck C requires pickup on A", () => {
    layers.setEnabled(true);
    cc14(0xb0, 0x13, 0.8);
    layers.set("left", 2);
    bus.send("mixer.channel3.volume", 0.3, "ui");
    cc14(0xb0, 0x13, 0.31); // picks up C
    cc14(0xb0, 0x13, 0.1);
    layers.set("left", 0);
    cc14(0xb0, 0x13, 0.12); // the fader is at 0.12, deck A is still at 0.8
    expect(engine.getState().mixer.channels[0].volume).toBeCloseTo(0.8, 3);
  });
});

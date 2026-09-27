/**
 * Built-in mapping: Pioneer DDJ-SB (a.k.a. "Serato DJ Intro" DDJ-SB).
 *
 * MIDI message numbers, LED addresses and shift/pad-mode layers were taken
 * from the Mixxx project's DDJ-SB mapping (res/controllers/Pioneer-DDJ-SB.midi.xml
 * and Pioneer-DDJ-SB-scripts.js, by Joan Ardiaca Jové, based on work by wingcom
 * and Hilton Rudham; the script declares the MIT licence). No Mixxx code is
 * executed or copied: this is an independent description in our own format.
 * See docs/CONTROLLER-MAPPINGS.md for provenance and verification status.
 *
 * MIDI channel layout (1-based):
 *   1 / 2  deck A / B buttons (notes) and deck/mixer controls (CC, 14-bit MSB+LSB)
 *   5 / 6  FX unit 1 / 2
 *   7      global: browse encoder, load buttons, crossfader, headphone mix, filters
 *   8 / 9  performance pads for deck A / B (note number depends on pad mode)
 */
import type { ControllerMapping, InputBinding, OutputBinding, PhysicalControl } from "../mapping/schema";
import { MAPPING_SCHEMA } from "../mapping/schema";

const LOOP_SIZES = ["1", "2", "4", "8", "16", "32", "64"];
const ROLL_SIZES = ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"];

export function buildDdjSbMapping(): ControllerMapping {
  const controls: PhysicalControl[] = [];
  const inputs: InputBinding[] = [];
  const outputs: OutputBinding[] = [];

  const control = (id: string, label: string, kind: PhysicalControl["kind"], section: string, short?: string) =>
    controls.push({ id, label, kind, section, short: short ?? label.toUpperCase() });
  const note = (ctl: string, channel: number, n: number, action: string, extra: Partial<InputBinding> = {}) =>
    inputs.push({ control: ctl, midi: { type: "note", channel, note: n }, action, confidence: "exact", ...extra });
  const cc14 = (ctl: string, channel: number, msb: number, action: string, extra: Partial<InputBinding> = {}) =>
    inputs.push({ control: ctl, midi: { type: "cc14", channel, msb, lsb: msb + 0x20 }, action, encoding: "absolute", confidence: "exact", ...extra });
  const rel = (ctl: string, channel: number, cc: number, action: string, encoding: InputBinding["encoding"], extra: Partial<InputBinding> = {}) =>
    inputs.push({ control: ctl, midi: { type: "cc", channel, cc }, action, encoding, confidence: "exact", ...extra });
  const led = (ctl: string, channel: number, n: number, feedback: string) =>
    outputs.push({ control: ctl, feedback, midi: { type: "note", channel, number: n }, on: 0x7f, off: 0x00 });

  for (let s = 0; s < 2; s++) {
    const L = s === 0 ? "A" : "B";
    const sec = `deck${L}`;
    const d = `deck${s + 1}`;
    const m = `mixer.channel${s + 1}`;
    const ch = s + 1; // deck buttons + mixer CCs
    const padCh = 8 + s;
    const fxCh = 5 + s;
    const c = (name: string) => `${sec}.${name}`;

    // ── transport ──
    control(c("play"), `Play/Pause ${L}`, "button", sec, `PLAY ${L}`);
    note(c("play"), ch, 0x0b, `${d}.play`);
    note(c("play"), ch, 0x47, `${d}.reverse`, { note: "SHIFT+PLAY (Mixxx: reverse roll)" });
    led(c("play"), ch, 0x0b, `${d}.playing`);
    led(c("play"), ch, 0x47, `${d}.playing`);

    control(c("cue"), `Cue ${L}`, "button", sec, `CUE ${L}`);
    note(c("cue"), ch, 0x0c, `${d}.cue`);
    note(c("cue"), ch, 0x48, `${d}.brake`, { note: "SHIFT+CUE (Mixxx: brake)" });
    led(c("cue"), ch, 0x0c, `${d}.cue`);
    led(c("cue"), ch, 0x48, `${d}.cue`);

    control(c("sync"), `Sync ${L}`, "button", sec, `SYNC ${L}`);
    note(c("sync"), ch, 0x58, `${d}.sync`);
    note(c("sync"), ch, 0x5c, `${d}.quantize`, { note: "SHIFT+SYNC" });
    led(c("sync"), ch, 0x58, `${d}.sync`);

    control(c("keylock"), `Key Lock ${L}`, "button", sec, `KEY LOCK ${L}`);
    note(c("keylock"), ch, 0x1a, `${d}.keylock`);
    note(c("keylock"), ch, 0x60, `${d}.tempo.range`, { note: "SHIFT+KEY LOCK = TEMPO RANGE (Mixxx uses it as deck 3/4 toggle)" });
    led(c("keylock"), ch, 0x1a, `${d}.keylock`);

    control(c("vinyl"), `Vinyl ${L}`, "button", sec, `VINYL ${L}`);
    note(c("vinyl"), ch, 0x17, `${d}.vinyl`);
    note(c("vinyl"), ch, 0x4e, `${d}.slip`, { note: "SHIFT+VINYL" });
    led(c("vinyl"), ch, 0x17, `${d}.vinyl`);

    control(c("shift"), `Shift ${L}`, "button", sec, `SHIFT ${L}`);
    note(c("shift"), ch, 0x3f, "modifier.shift", {
      note: s === 0 ? undefined : "Deck B SHIFT assumed to mirror deck A on channel 2 (Mixxx binds only channel 1) — verify",
      confidence: s === 0 ? "exact" : "heuristic",
    });

    control(c("load"), `Load ${L}`, "button", "browser", `LOAD ${L}`);
    note(c("load"), 7, 0x46 + s, `browser.load.deck${s + 1}`);

    control(c("pfl"), `Headphone cue ${L}`, "button", "mixer", `HP CUE ${L}`);
    note(c("pfl"), ch, 0x54, `${m}.cue`);
    note(c("pfl"), ch, 0x68, `${m}.cue`, { note: "SHIFT+CUE(headphone)" });
    led(c("pfl"), ch, 0x54, `${m}.cue`);
    led(c("pfl"), ch, 0x68, `${m}.cue`);

    // ── tempo + jog ──
    control(c("tempo"), `Tempo slider ${L}`, "slider", sec, `TEMPO ${L}`);
    cc14(c("tempo"), ch, 0x00, `${d}.tempo`);

    control(c("jog"), `Jog wheel ${L}`, "jog", sec, `JOG ${L}`);
    rel(c("jog"), ch, 0x22, `${d}.jog.platter`, "relative-offset64", { note: "Top of platter (touched)" });
    rel(c("jog"), ch, 0x23, `${d}.jog.platter`, "relative-offset64", { note: "Top of platter, alternate message (Mixxx treats as platter)" });
    rel(c("jog"), ch, 0x21, `${d}.jog.ring`, "relative-offset64", { note: "Outer ring / side" });
    rel(c("jog"), ch, 0x26, `${d}.jog.search`, "relative-offset64", { note: "SHIFT + ring" });
    rel(c("jog"), ch, 0x1f, `${d}.jog.search`, "relative-offset64", { note: "SHIFT + platter" });

    control(c("jogtouch"), `Jog touch ${L}`, "jog-touch", sec, `JOG TOUCH ${L}`);
    note(c("jogtouch"), ch, 0x36, `${d}.jog.touch`);
    note(c("jogtouch"), ch, 0x35, `${d}.jog.touch`, { note: "Alternate touch message (bound by Mixxx)" });
    note(c("jogtouch"), ch, 0x67, `${d}.jog.touch`, { note: "SHIFT + touch" });

    // ── mixer channel ──
    control(c("eqhigh"), `EQ High ${L}`, "knob", "mixer", `EQ HIGH ${L}`);
    cc14(c("eqhigh"), ch, 0x07, `${m}.eq.high`);
    control(c("eqmid"), `EQ Mid ${L}`, "knob", "mixer", `EQ MID ${L}`);
    cc14(c("eqmid"), ch, 0x0b, `${m}.eq.mid`);
    control(c("eqlow"), `EQ Low ${L}`, "knob", "mixer", `EQ LOW ${L}`);
    cc14(c("eqlow"), ch, 0x0f, `${m}.eq.low`);
    control(c("fader"), `Channel fader ${L}`, "fader", "mixer", `VOLUME ${L}`);
    cc14(c("fader"), ch, 0x13, `${m}.volume`);
    control(c("filter"), `Filter ${L}`, "knob", "mixer", `FILTER ${L}`);
    cc14(c("filter"), 7, 0x17 + s, `${m}.filter`);
    cc14(c("filter"), 7, 0x17 + s, `${m}.gain`, { modifier: "shift", note: "DDJ-SB has no trim knob: SHIFT+FILTER = gain (as in Mixxx)" });

    // ── performance pads (4 physical pads; note depends on pad mode + shift) ──
    for (let p = 0; p < 4; p++) {
      const pad = c(`pad${p + 1}`);
      control(pad, `Pad ${L}${p + 1}`, "pad", sec, `PAD ${L}${p + 1}`);
      // HOT CUE mode: pads 1-4 → hot cues 1-4; alternate bank (0x40) → hot cues 5-8; SHIFT → clear
      note(pad, padCh, 0x00 + p, `${d}.hotcue.${p + 1}`);
      note(pad, padCh, 0x08 + p, `${d}.hotcue.${p + 1}.clear`);
      note(pad, padCh, 0x40 + p, `${d}.hotcue.${p + 5}`);
      note(pad, padCh, 0x48 + p, `${d}.hotcue.${p + 5}.clear`);
      led(pad, padCh, 0x00 + p, `${d}.hotcue.${p + 1}`);
      led(pad, padCh, 0x08 + p, `${d}.hotcue.${p + 1}`);
      led(pad, padCh, 0x40 + p, `${d}.hotcue.${p + 5}`);
      led(pad, padCh, 0x48 + p, `${d}.hotcue.${p + 5}`);
      // AUTO LOOP mode
      note(pad, padCh, 0x10 + p, `${d}.beatloop.${LOOP_SIZES[p]}`);
      if (p < 3) note(pad, padCh, 0x18 + p, `${d}.beatloop.${LOOP_SIZES[p + 4]}`);
      note(pad, padCh, 0x50 + p, `${d}.beatloop.roll.${ROLL_SIZES[p]}`);
      note(pad, padCh, 0x58 + p, `${d}.beatloop.roll.${ROLL_SIZES[p + 4]}`);
      // SAMPLER pad mode = STEMS: pads 1-4 mute/unmute vocals/drums/bass/instruments,
      // SHIFT + pad solos that stem (press again to bring all stems back). LEDs = stem audible.
      const stem = ["vocals", "drums", "bass", "instruments"][p];
      note(pad, padCh, 0x30 + p, `${d}.stem.${stem}.toggle`);
      note(pad, padCh, 0x38 + p, `${d}.stem.${stem}.isolate`);
      led(pad, padCh, 0x30 + p, `${d}.stem.${stem}`);
      led(pad, padCh, 0x38 + p, `${d}.stem.${stem}`);
      note(pad, padCh, 0x70 + p, `sampler${p + 1}.load`);
      note(pad, padCh, 0x78 + p, `sampler${p + 1}.eject`);
    }
    // MANUAL LOOP mode
    const pad = (n: number) => c(`pad${n}`);
    note(pad(1), padCh, 0x20, `${d}.loop.in`);
    note(pad(2), padCh, 0x21, `${d}.loop.out`);
    note(pad(3), padCh, 0x22, `${d}.loop.exit`);
    note(pad(4), padCh, 0x23, `${d}.loop.halve`);
    note(pad(1), padCh, 0x28, `${d}.loop.move.back`);
    note(pad(2), padCh, 0x29, `${d}.loop.move.forward`);
    note(pad(4), padCh, 0x2b, `${d}.loop.double`);
    note(pad(1), padCh, 0x60, `${m}.eq.low.kill`);
    note(pad(2), padCh, 0x61, `${m}.eq.mid.kill`);
    note(pad(3), padCh, 0x62, `${m}.eq.high.kill`);
    note(pad(4), padCh, 0x63, `${m}.mute`);
    led(pad(1), padCh, 0x60, `${m}.eq.low.kill`);
    led(pad(2), padCh, 0x61, `${m}.eq.mid.kill`);
    led(pad(3), padCh, 0x62, `${m}.eq.high.kill`);
    led(pad(4), padCh, 0x63, `${m}.mute`);
    note(pad(1), padCh, 0x68, `fx.unit${s + 1}.chain.prev`, { note: "Mixxx: prev_chain" });
    note(pad(2), padCh, 0x69, `fx.unit${s + 1}.chain.next`, { note: "Mixxx: next_chain" });

    // ── FX unit on this side ──
    const fx = `fx${s + 1}`;
    for (let b = 0; b < 3; b++) {
      const id = `${fx}.button${b + 1}`;
      control(id, `FX${s + 1} button ${b + 1}`, "button", fx, `FX${s + 1}-${b + 1}`);
      note(id, fxCh, 0x47 + b, `fx.unit${s + 1}.button${b + 1}`);
      note(id, fxCh, 0x63 + b, `fx.unit${s + 1}.button${b + 1}`, { note: "SHIFT layer" });
      if (b === 0) {
        // FX button 1 lights while the unit is on.
        led(id, fxCh, 0x47, `fx.unit${s + 1}.on`);
        led(id, fxCh, 0x63, `fx.unit${s + 1}.on`);
      }
    }
    control(`${fx}.knob`, `FX${s + 1} knob`, "knob", fx, `FX${s + 1} KNOB`);
    cc14(`${fx}.knob`, fxCh, 0x06, `fx.unit${s + 1}.knob`);
    cc14(`${fx}.knob`, fxCh, 0x00, `fx.unit${s + 1}.knob.shift`, { note: "SHIFT + FX knob" });
  }

  // ── global section ──
  control("mixer.crossfader", "Crossfader", "crossfader", "mixer", "CROSSFADER");
  cc14("mixer.crossfader", 7, 0x1f, "mixer.crossfader");
  control("mixer.headmix", "Headphone mix", "knob", "mixer", "HP MIX");
  cc14("mixer.headmix", 7, 0x05, "mixer.headphone.mix");
  control("browser.encoder", "Browse encoder", "encoder", "browser", "BROWSE");
  rel("browser.encoder", 7, 0x40, "browser.scroll", "relative-twos-complement");
  rel("browser.encoder", 7, 0x64, "browser.playlist.scroll", "relative-twos-complement", { note: "SHIFT + turn" });
  control("browser.push", "Browse push", "button", "browser", "BROWSE PUSH");
  note("browser.push", 7, 0x41, "browser.select");
  note("browser.push", 7, 0x42, "browser.back", { note: "SHIFT + push" });

  return {
    schema: MAPPING_SCHEMA,
    id: "pioneer-ddj-sb",
    name: "Pioneer DDJ-SB",
    vendor: "Pioneer DJ",
    version: "1.0.0",
    description: "Mixxx DDJ-SB compatible mapping (two decks).",
    match: { portNamePatterns: ["DDJ[- ]?SB(?![0-9])"] },
    provenance: {
      source: "Derived from the Mixxx Pioneer DDJ-SB mapping (Pioneer-DDJ-SB.midi.xml / Pioneer-DDJ-SB-scripts.js)",
      license: "MIT (as declared in the Mixxx DDJ-SB script header)",
      url: "https://github.com/mixxxdj/mixxx/tree/main/res/controllers",
      authors: ["Joan Ardiaca Jové", "wingcom", "Hilton Rudham"],
      notes: "MIDI numbers re-expressed in the dbdj normalised schema; behaviour implemented independently.",
    },
    controls,
    inputs,
    outputs,
    hints: { jogTicksPerRevolution: 720, tempoSliderDownIsFaster: true },
  };
}

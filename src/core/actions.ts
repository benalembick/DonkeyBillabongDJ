/**
 * The application action catalogue: the stable, serialisable vocabulary that
 * controller mappings, keyboard shortcuts and the UI all use to drive the DJ
 * engine (e.g. "deck1.play", "mixer.channel2.eq.high", "browser.load.deck1").
 *
 * Value conventions (what an input delivers for each value type):
 *  - button:   1 = pressed, 0 = released
 *  - absolute: 0..1 (0.5 = centre for bipolar controls such as EQ/filter/tempo)
 *  - relative: signed tick delta (e.g. jog wheel +4 / -2)
 */
export type ActionValueType = "button" | "absolute" | "relative";

export interface ActionMeta {
  id: string;
  label: string;
  valueType: ActionValueType;
  group: string;
  /** False when the action is part of the vocabulary but the engine does not implement it yet. */
  implemented: boolean;
}

export const MAX_DECKS = 4;
export const STEM_NAMES = ["vocals", "drums", "bass", "instruments"] as const;
export type StemName = (typeof STEM_NAMES)[number];
export const STEM_LABELS: Record<StemName, string> = { vocals: "Vocals", drums: "Drums", bass: "Bass", instruments: "Instruments" };
export const HOTCUE_COUNT = 8;
export const BEATLOOP_SIZES = ["0.03125", "0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8", "16", "32", "64"] as const;

export function deckLetter(deckIndex: number): string {
  return String.fromCharCode(65 + deckIndex);
}

/** Builds the catalogue for `deckCount` decks. Pure: usable without an engine (validation, editors, docs). */
export function buildActionCatalog(deckCount = MAX_DECKS): ActionMeta[] {
  const out: ActionMeta[] = [];
  const add = (id: string, label: string, valueType: ActionValueType, group: string, implemented = true) =>
    out.push({ id, label, valueType, group, implemented });

  for (let d = 1; d <= deckCount; d++) {
    const L = deckLetter(d - 1);
    const g = `Deck ${L}`;
    const p = `deck${d}`;
    add(`${p}.play`, `Play/Pause ${L}`, "button", g);
    add(`${p}.cue`, `Cue ${L}`, "button", g);
    add(`${p}.sync`, `Sync ${L}`, "button", g);
    add(`${p}.master`, `Master ${L}`, "button", g);
    add(`${p}.keylock`, `Key Lock ${L}`, "button", g, false);
    add(`${p}.vinyl`, `Vinyl/Scratch mode ${L}`, "button", g);
    add(`${p}.slip`, `Slip ${L}`, "button", g, false);
    add(`${p}.quantize`, `Quantize ${L}`, "button", g, false);
    add(`${p}.reverse`, `Reverse ${L}`, "button", g, false);
    add(`${p}.brake`, `Brake ${L}`, "button", g, false);
    add(`${p}.eject`, `Eject ${L}`, "button", g);
    add(`${p}.deckToggle`, `Deck toggle ${L}`, "button", g, false);
    add(`${p}.seek`, `Seek (track position) ${L}`, "absolute", g);
    add(`${p}.stems`, `STEMS on/off ${L}`, "button", g);
    for (const s of STEM_NAMES) {
      const n = STEM_LABELS[s];
      add(`${p}.stem.${s}.toggle`, `${n} mute/unmute ${L}`, "button", g);
      add(`${p}.stem.${s}.isolate`, `${n} solo ${L}`, "button", g);
      add(`${p}.stem.${s}.volume`, `${n} volume ${L}`, "absolute", g);
    }
    add(`${p}.tempo`, `Tempo ${L}`, "absolute", g);
    add(`${p}.tempo.range`, `Tempo range cycle ${L}`, "button", g);
    add(`${p}.tempo.reset`, `Tempo reset ${L}`, "button", g);
    add(`${p}.jog.touch`, `Jog touch ${L}`, "button", g);
    add(`${p}.jog.platter`, `Jog platter (top) ${L}`, "relative", g);
    add(`${p}.jog.ring`, `Jog ring (side) ${L}`, "relative", g);
    add(`${p}.jog.search`, `Jog fast search ${L}`, "relative", g);
    for (let h = 1; h <= HOTCUE_COUNT; h++) {
      add(`${p}.hotcue.${h}`, `Hot cue ${h} ${L}`, "button", g);
      add(`${p}.hotcue.${h}.clear`, `Clear hot cue ${h} ${L}`, "button", g);
    }
    add(`${p}.loop.in`, `Loop in ${L}`, "button", g);
    add(`${p}.loop.out`, `Loop out ${L}`, "button", g);
    add(`${p}.loop.exit`, `Loop exit/reloop ${L}`, "button", g);
    add(`${p}.loop.halve`, `Loop halve ${L}`, "button", g);
    add(`${p}.loop.double`, `Loop double ${L}`, "button", g);
    add(`${p}.loop.move.back`, `Loop move back ${L}`, "button", g);
    add(`${p}.loop.move.forward`, `Loop move forward ${L}`, "button", g);
    for (const s of BEATLOOP_SIZES) {
      add(`${p}.beatloop.${s}`, `Auto loop ${s} beats ${L}`, "button", g);
      add(`${p}.beatloop.roll.${s}`, `Loop roll ${s} beats ${L}`, "button", g);
    }

    const m = `mixer.channel${d}`;
    const mg = `Mixer ch ${d}`;
    add(`${m}.gain`, `Gain/Trim ch${d}`, "absolute", mg);
    add(`${m}.eq.high`, `EQ High ch${d}`, "absolute", mg);
    add(`${m}.eq.mid`, `EQ Mid ch${d}`, "absolute", mg);
    add(`${m}.eq.low`, `EQ Low ch${d}`, "absolute", mg);
    add(`${m}.eq.high.kill`, `EQ High kill ch${d}`, "button", mg);
    add(`${m}.eq.mid.kill`, `EQ Mid kill ch${d}`, "button", mg);
    add(`${m}.eq.low.kill`, `EQ Low kill ch${d}`, "button", mg);
    add(`${m}.filter`, `Filter ch${d}`, "absolute", mg);
    add(`${m}.volume`, `Channel fader ch${d}`, "absolute", mg);
    add(`${m}.cue`, `Headphone cue ch${d}`, "button", mg);
    add(`${m}.mute`, `Mute ch${d}`, "button", mg);

    add(`browser.load.deck${d}`, `Load selected into deck ${L}`, "button", "Browser");
  }

  add("mixer.crossfader", "Crossfader", "absolute", "Mixer");
  add("mixer.master.level", "Master level", "absolute", "Mixer");
  add("mixer.headphone.mix", "Headphone cue/master mix", "absolute", "Mixer");
  add("mixer.headphone.level", "Headphone level", "absolute", "Mixer");

  add("browser.scroll", "Browse scroll", "relative", "Browser");
  add("browser.select", "Browse select/enter", "button", "Browser", false);
  add("browser.back", "Browse back", "button", "Browser", false);
  add("browser.playlist.scroll", "Browse playlists", "relative", "Browser", false);
  add("browser.preview", "Preview selected", "button", "Browser", false);

  for (let u = 1; u <= 2; u++) {
    const G = `FX ${u}`;
    for (let k = 1; k <= 3; k++) {
      add(`fx.unit${u}.button${k}`, `FX${u} button ${k} (slot ${k} on/off)`, "button", G);
      add(`fx.unit${u}.slot${k}.toggle`, `FX${u} slot ${k} on/off`, "button", G);
      add(`fx.unit${u}.slot${k}.next`, `FX${u} slot ${k} next effect`, "button", G);
      add(`fx.unit${u}.slot${k}.prev`, `FX${u} slot ${k} previous effect`, "button", G);
      add(`fx.unit${u}.slot${k}.param`, `FX${u} slot ${k} parameter`, "absolute", G);
    }
    add(`fx.unit${u}.knob`, `FX${u} level (dry/wet)`, "absolute", G);
    add(`fx.unit${u}.knob.shift`, `FX${u} parameter (all slots)`, "absolute", G);
    add(`fx.unit${u}.chain.next`, `FX${u} slot 1 next effect`, "button", G);
    add(`fx.unit${u}.chain.prev`, `FX${u} slot 1 previous effect`, "button", G);
    add(`fx.unit${u}.on`, `FX${u} on/off (all slots)`, "button", G);
    add(`fx.unit${u}.mix`, `FX${u} level (dry/wet)`, "absolute", G);
    add(`fx.unit${u}.param`, `FX${u} parameter (all slots)`, "absolute", G);
    add(`fx.unit${u}.beats.next`, `FX${u} longer beat`, "button", G);
    add(`fx.unit${u}.beats.prev`, `FX${u} shorter beat`, "button", G);
    for (let d = 1; d <= deckCount; d++) add(`fx.unit${u}.assign.deck${d}`, `FX${u} assign deck ${deckLetter(d - 1)}`, "button", G);
    add(`fx.unit${u}.target.next`, `FX${u} target (deck / single stem)`, "button", G);
  }
  for (let s = 1; s <= 4; s++) {
    add(`sampler${s}.play`, `Sampler ${s} play`, "button", "Sampler", false);
    add(`sampler${s}.stop`, `Sampler ${s} stop`, "button", "Sampler", false);
    add(`sampler${s}.load`, `Sampler ${s} load`, "button", "Sampler", false);
    add(`sampler${s}.eject`, `Sampler ${s} eject`, "button", "Sampler", false);
  }
  // Lighting (stable ids so a DDJ-SB / MIDI controller can be mapped to them)
  add("lighting.blackout", "Lighting blackout (toggle)", "button", "Lighting");
  add("lighting.master", "Lighting master brightness", "absolute", "Lighting");
  add("lighting.desk.clear", "Lighting desk clear", "button", "Lighting");
  add("lighting.sound.enable", "Sound-to-light on/off", "button", "Lighting");
  add("lighting.sound.beatFlash", "Sound-to-light beat flash on/off", "button", "Lighting");
  add("lighting.sound.downbeatAccent", "Sound-to-light downbeat accent on/off", "button", "Lighting");
  add("lighting.sound.brightness", "Sound-to-light brightness", "absolute", "Lighting");
  add("lighting.sound.sensitivity", "Sound-to-light sensitivity", "absolute", "Lighting");
  add("lighting.sound.speed", "Sound-to-light speed / response", "absolute", "Lighting");
  add("recording.toggle", "Record", "button", "Recording", false);
  add("modifier.shift", "Shift (mapping modifier)", "button", "Controller");
  return out;
}

let cachedCatalog: Map<string, ActionMeta> | null = null;
export function actionCatalog(): Map<string, ActionMeta> {
  if (!cachedCatalog) cachedCatalog = new Map(buildActionCatalog().map((a) => [a.id, a]));
  return cachedCatalog;
}

/**
 * Normalised controller mapping format ("dbdj.controller-mapping/1").
 *
 * This is the application's own format. Built-in mappings, user edits, the
 * mapping editor and the Mixxx importer all produce this shape; the mapping
 * runtime only ever consumes this shape.
 */

export const MAPPING_SCHEMA = "dbdj.controller-mapping/1";

/** Physical controls (used by the controller test screen and the mapping editor). */
export type PhysicalControlKind = "button" | "pad" | "knob" | "fader" | "slider" | "crossfader" | "jog" | "jog-touch" | "encoder";

export interface PhysicalControl {
  id: string;
  label: string;
  kind: PhysicalControlKind;
  /** Layout grouping, e.g. "deckA", "deckB", "mixer", "browser", "fx1". */
  section: string;
  /** Short label used in the live event feed, e.g. "PLAY A". */
  short?: string;
}

/** MIDI channels are 1-16. */
export type MidiSelector =
  | { type: "note"; channel: number; note: number }
  | { type: "cc"; channel: number; cc: number }
  | { type: "cc14"; channel: number; msb: number; lsb: number }
  | { type: "pitchbend"; channel: number };

export type InputEncoding =
  /** Absolute value scaled to 0..1 (7-bit, 14-bit or pitchbend). Default for cc/cc14/pitchbend. */
  | "absolute"
  /** Relative, centred on 64: value - 64 (Pioneer jog wheels). */
  | "relative-offset64"
  /** Relative, 7-bit two's complement: 1..63 positive, 127..65 negative (browse encoders). */
  | "relative-twos-complement"
  /** Relative, sign bit: 1..63 positive, 65..127 = -(v-64). */
  | "relative-signed-bit"
  /** Button: note-on velocity > 0 → 1, note-off / 0 → 0. Default for notes. */
  | "button";

export interface InputBinding {
  /** Physical control this message belongs to. */
  control: string;
  midi: MidiSelector;
  /** Application action id, e.g. "deck1.play". */
  action: string;
  encoding?: InputEncoding;
  invert?: boolean;
  /** Multiplier for relative encodings. */
  scale?: number;
  /** Only active while this modifier (e.g. "shift") is held. Bindings without it apply when no bound modifier matches. */
  modifier?: string;
  /** Provenance for imported bindings. */
  confidence?: "exact" | "heuristic" | "manual";
  note?: string;
}

export interface OutputBinding {
  /** Feedback key from the DJ engine, e.g. "deck1.playing", "deck1.hotcue.3", "mixer.channel1.cue". */
  feedback: string;
  midi: { type: "note" | "cc"; channel: number; number: number };
  on: number;
  off: number;
  control?: string;
}

export interface ControllerMapping {
  schema: typeof MAPPING_SCHEMA;
  id: string;
  name: string;
  vendor?: string;
  version?: string;
  description?: string;
  /** Regular expressions matched (case-insensitive) against MIDI port names. */
  match: { portNamePatterns: string[] };
  provenance?: { source: string; license?: string; url?: string; authors?: string[]; notes?: string };
  controls: PhysicalControl[];
  inputs: InputBinding[];
  outputs: OutputBinding[];
  /** Controller-specific behaviour hints consumed by the engine (e.g. jog resolution). */
  hints?: { jogTicksPerRevolution?: number; tempoSliderDownIsFaster?: boolean };
}

export function selectorKey(sel: MidiSelector): string[] {
  switch (sel.type) {
    case "note":
      return [`n:${sel.channel}:${sel.note}`];
    case "cc":
      return [`c:${sel.channel}:${sel.cc}`];
    case "cc14":
      return [`c:${sel.channel}:${sel.msb}`, `c:${sel.channel}:${sel.lsb}`];
    case "pitchbend":
      return [`p:${sel.channel}`];
  }
}

export function describeSelector(sel: MidiSelector): string {
  const h = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");
  switch (sel.type) {
    case "note":
      return `Note ch${sel.channel} ${h(sel.note)}`;
    case "cc":
      return `CC ch${sel.channel} ${h(sel.cc)}`;
    case "cc14":
      return `CC14 ch${sel.channel} ${h(sel.msb)}/${h(sel.lsb)}`;
    case "pitchbend":
      return `Pitchbend ch${sel.channel}`;
  }
}

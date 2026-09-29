/**
 * Fixture definitions (a small JSON schema in the spirit of QLC+ / Open Fixture
 * Library) and the patch: which fixture sits at which universe/address.
 *
 * A definition lists modes; each mode is an ordered list of channels with a
 * *type* (red, dimmer, pan…). Everything that reacts to fixtures — the desk
 * labels, grand master, sound-to-light, future scenes/chases — works from these
 * types, never from hard-coded channel numbers.
 */

export type ChannelType =
  | "intensity" // master dimmer
  | "red"
  | "green"
  | "blue"
  | "white"
  | "amber"
  | "uv"
  | "strobe"
  | "pan"
  | "panFine"
  | "tilt"
  | "tiltFine"
  | "speed"
  | "colorWheel"
  | "gobo"
  | "macro"
  | "laser" // laser on/pattern/colour — never driven automatically
  | "unknown" // function not known yet (no fixture definition imported) — never driven automatically
  | "generic";

/** Channel types scaled by the grand master (light output). Position/effect channels are not. */
export const INTENSITY_TYPES = new Set<ChannelType>(["intensity", "red", "green", "blue", "white", "amber", "uv", "generic"]);

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  intensity: "DIMMER",
  red: "RED",
  green: "GREEN",
  blue: "BLUE",
  white: "WHITE",
  amber: "AMBER",
  uv: "UV",
  strobe: "STROBE",
  pan: "PAN",
  panFine: "PAN FINE",
  tilt: "TILT",
  tiltFine: "TILT FINE",
  speed: "SPEED",
  colorWheel: "COLOUR",
  gobo: "GOBO",
  macro: "MACRO",
  laser: "LASER",
  unknown: "CH",
  generic: "LEVEL",
};

/** A value range of a channel, e.g. 135–239 "Strobe slow → fast" (from QLC+ / OFL definitions). */
export interface ChannelCapability {
  min: number;
  max: number;
  name: string;
}

export interface FixtureChannelDef {
  name: string;
  type: ChannelType;
  capabilities?: ChannelCapability[];
}

export interface FixtureModeDef {
  name: string;
  channels: FixtureChannelDef[];
}

export interface FixtureDef {
  /** Stable id, e.g. "generic/rgb-par". */
  id: string;
  manufacturer: string;
  model: string;
  category: "par" | "bar" | "moving-head" | "strobe" | "dimmer" | "laser" | "other";
  modes: FixtureModeDef[];
  /** Contains a laser: excluded from sound-to-light and FULL ON unless explicitly allowed. */
  laser?: boolean;
  /** Stand-in for a fixture whose definition hasn't been imported (all channels "unknown"). */
  placeholder?: boolean;
  /** Where the definition came from, e.g. "Built-in", "QLC+ file Betopper-LM30A.qxf". */
  source?: string;
}

const ch = (type: ChannelType, name = CHANNEL_LABELS[type]): FixtureChannelDef => ({ name, type });

/** Built-in generic fixtures. Real fixtures can be added in the same format later (or imported from QLC+/OFL). */
export const GENERIC_FIXTURES: FixtureDef[] = [
  {
    id: "generic/rgb-par",
    manufacturer: "Generic",
    model: "RGB PAR",
    category: "par",
    modes: [
      { name: "5-channel (RGB + dimmer + strobe)", channels: [ch("red"), ch("green"), ch("blue"), ch("intensity"), ch("strobe")] },
      { name: "3-channel (RGB)", channels: [ch("red"), ch("green"), ch("blue")] },
    ],
  },
  {
    id: "generic/rgbw-par",
    manufacturer: "Generic",
    model: "RGBW PAR",
    category: "par",
    modes: [
      { name: "6-channel (dimmer + RGBW + strobe)", channels: [ch("intensity"), ch("red"), ch("green"), ch("blue"), ch("white"), ch("strobe")] },
      { name: "4-channel (RGBW)", channels: [ch("red"), ch("green"), ch("blue"), ch("white")] },
    ],
  },
  {
    id: "generic/rgbwauv-par",
    manufacturer: "Generic",
    model: "RGBWAUV PAR",
    category: "par",
    modes: [
      { name: "8-channel (dimmer + RGBWA-UV + strobe)", channels: [ch("intensity"), ch("red"), ch("green"), ch("blue"), ch("white"), ch("amber"), ch("uv"), ch("strobe")] },
      { name: "6-channel (RGBWA-UV)", channels: [ch("red"), ch("green"), ch("blue"), ch("white"), ch("amber"), ch("uv")] },
    ],
  },
  {
    id: "generic/moving-head",
    manufacturer: "Generic",
    model: "Moving Head (spot)",
    category: "moving-head",
    modes: [
      {
        name: "11-channel",
        channels: [ch("pan"), ch("panFine"), ch("tilt"), ch("tiltFine"), ch("speed", "PAN/TILT SPEED"), ch("intensity"), ch("strobe"), ch("colorWheel"), ch("gobo"), ch("macro", "GOBO ROTATION"), ch("macro", "RESET")],
      },
      { name: "8-channel (RGBW wash)", channels: [ch("pan"), ch("tilt"), ch("intensity"), ch("red"), ch("green"), ch("blue"), ch("white"), ch("strobe")] },
    ],
  },
  {
    id: "generic/led-bar",
    manufacturer: "Generic",
    model: "LED Bar (RGB)",
    category: "bar",
    modes: [
      { name: "4-channel (dimmer + RGB)", channels: [ch("intensity"), ch("red"), ch("green"), ch("blue")] },
      {
        name: "12-channel (4 × RGB segments)",
        channels: [1, 2, 3, 4].flatMap((s) => [ch("red", `RED ${s}`), ch("green", `GREEN ${s}`), ch("blue", `BLUE ${s}`)]),
      },
    ],
  },
  {
    id: "generic/strobe",
    manufacturer: "Generic",
    model: "Strobe",
    category: "strobe",
    modes: [{ name: "2-channel (dimmer + rate)", channels: [ch("intensity"), ch("strobe", "RATE")] }],
  },
  {
    id: "generic/dimmer",
    manufacturer: "Generic",
    model: "Dimmer",
    category: "dimmer",
    modes: [{ name: "1-channel", channels: [ch("intensity")] }],
  },
  {
    id: "generic/single",
    manufacturer: "Generic",
    model: "Generic single channel",
    category: "other",
    modes: [{ name: "1-channel", channels: [ch("generic")] }],
  },
];

/** A fixture placed in the rig. */
export interface PatchedFixture {
  id: string;
  /** User's name, e.g. "Front PAR Left". */
  name: string;
  defId: string;
  mode: string;
  universe: number;
  /** First DMX address, 1..512. */
  address: number;
  /** Channel count of the chosen mode (kept for display and custom fixtures). */
  channelCount: number;
  /** Output curves per channel (0-based within the fixture), e.g. inverted pan on a mirrored head. */
  modifiers?: { channel: number; curve: "invert" | "linear" }[];
}

/** Capability name for a channel value (e.g. "Strobe slow → fast"), if the definition has one. */
export function capabilityAt(ch: FixtureChannelDef | undefined, value: number): string | undefined {
  return ch?.capabilities?.find((c) => value >= c.min && value <= c.max)?.name;
}

export function findDef(defs: FixtureDef[], id: string): FixtureDef | undefined {
  return defs.find((d) => d.id === id);
}

export function modeOf(defs: FixtureDef[], f: Pick<PatchedFixture, "defId" | "mode">): FixtureModeDef | undefined {
  const d = findDef(defs, f.defId);
  return d?.modes.find((m) => m.name === f.mode) ?? d?.modes[0];
}

/** Occupied addresses [first, last] (inclusive), e.g. start 21 with 5 channels → 21–25. */
export function addressRange(f: Pick<PatchedFixture, "address" | "channelCount">): [number, number] {
  return [f.address, f.address + f.channelCount - 1];
}

/** Does the fixture fit in the universe? */
export function fitsUniverse(f: Pick<PatchedFixture, "address" | "channelCount">): boolean {
  return f.address >= 1 && f.channelCount >= 1 && f.address + f.channelCount - 1 <= 512;
}

/** Fixtures in the same universe whose addresses overlap `f` (ignoring `f` itself). */
export function overlaps(all: PatchedFixture[], f: Pick<PatchedFixture, "id" | "universe" | "address" | "channelCount">): PatchedFixture[] {
  const [a0, a1] = addressRange(f);
  return all.filter((o) => {
    if (o.id === f.id || o.universe !== f.universe) return false;
    const [b0, b1] = addressRange(o);
    return a0 <= b1 && b0 <= a1;
  });
}

/** First free address in a universe with room for `count` channels (null if the universe is full). */
export function nextFreeAddress(all: PatchedFixture[], universe: number, count: number): number | null {
  const used = new Uint8Array(513);
  for (const f of all) if (f.universe === universe) for (let a = f.address; a < f.address + f.channelCount && a <= 512; a++) used[a] = 1;
  for (let start = 1; start + count - 1 <= 512; start++) {
    let ok = true;
    for (let a = start; a < start + count; a++) if (used[a]) { ok = false; start = a; break; }
    if (ok) return start;
  }
  return null;
}

/** Per-channel info for a universe: which fixture and function owns each address (1-based index). */
export interface ChannelInfo {
  fixture: PatchedFixture;
  channel: FixtureChannelDef;
  /** 0-based channel within the fixture. */
  offset: number;
}

export function channelMap(defs: FixtureDef[], all: PatchedFixture[], universe: number): (ChannelInfo | undefined)[] {
  const out: (ChannelInfo | undefined)[] = new Array(513);
  for (const f of all) {
    if (f.universe !== universe) continue;
    const mode = modeOf(defs, f);
    for (let i = 0; i < f.channelCount; i++) {
      const a = f.address + i;
      if (a < 1 || a > 512 || out[a]) continue; // first fixture wins where overlapping
      out[a] = { fixture: f, channel: mode?.channels[i] ?? ch("generic"), offset: i };
    }
  }
  return out;
}

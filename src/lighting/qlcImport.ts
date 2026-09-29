/**
 * QLC+ import: fixture lists (.qxfl), workspaces (.qxw — fixtures only) and fixture
 * definitions (.qxf). QLC+ numbers universes and addresses from 0; DMX (and this app)
 * from 1, so both are shifted by one.
 *
 * Channel functions come from QLC+ presets (IntensityRed, PositionPan…) or groups
 * (Intensity + Colour, Pan, Tilt, Shutter, Gobo…). Anything that isn't clearly a light
 * output, position or speed channel is imported as an effect/macro channel so automation
 * (sound-to-light, FULL ON, grand master) never drives it. Fixtures whose definition says
 * or names "laser" are flagged as lasers.
 */
import { XMLParser } from "fast-xml-parser";
import type { ChannelCapability, ChannelType, FixtureChannelDef, FixtureDef, FixtureModeDef } from "./fixtures";

type Obj = Record<string, unknown>;
const parser = () =>
  new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ["Fixture", "Channel", "Mode", "Capability", "Modifier", "Head"].includes(name),
  });

const text = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return String((v as Obj)["#text"] ?? "");
  return String(v);
};
const num = (v: unknown, d = 0) => {
  const n = Number(text(v));
  return Number.isFinite(n) ? n : d;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

export const qlcDefId = (manufacturer: string, model: string) => `qlc/${slug(manufacturer)}/${slug(model)}`;

/** Makers of MIDI controllers that QLC+ lists as "fixtures" for button feedback (not lights). */
const CONTROLLER_MAKERS = /^(novation|akai|korg|native instruments|arturia|ableton|behringer x-touch|livid|midiplus)$/i;

export interface QlcPatchEntry {
  manufacturer: string;
  model: string;
  mode: string;
  name: string;
  /** 1-based */
  universe: number;
  /** 1-based DMX start address */
  address: number;
  channels: number;
  modifiers: { channel: number; curve: "invert" | "linear" }[];
  /** Modifiers QLC+ applied that this app doesn't reproduce yet. */
  unsupportedModifiers: string[];
}

export interface QlcFixtureList {
  fixtures: QlcPatchEntry[];
  skipped: { name: string; reason: string }[];
}

/** Parse a .qxfl fixture list or the fixtures of a .qxw workspace. */
export function parseQlcFixtureList(xml: string): QlcFixtureList {
  const doc = parser().parse(xml) as Obj;
  const root = (doc.FixtureList ?? (doc.Workspace as Obj | undefined)?.Engine) as Obj | undefined;
  if (!root) throw new Error("Not a QLC+ fixture list or workspace");
  const list = (root.Fixture as Obj[] | undefined) ?? [];
  const out: QlcFixtureList = { fixtures: [], skipped: [] };
  for (const f of list) {
    const manufacturer = text(f.Manufacturer);
    const name = text(f.Name) || `${manufacturer} ${text(f.Model)}`;
    if (CONTROLLER_MAKERS.test(manufacturer)) {
      out.skipped.push({ name, reason: `${manufacturer} ${text(f.Model)} is a MIDI controller (QLC+ uses it for button feedback), not a light` });
      continue;
    }
    const modifiers: QlcPatchEntry["modifiers"] = [];
    const unsupported: string[] = [];
    for (const m of (f.Modifier as Obj[] | undefined) ?? []) {
      const ch = num(m["@_Channel"], -1);
      const kind = String(m["@_Name"] ?? "");
      if (ch < 0) continue;
      if (/^invert$/i.test(kind)) modifiers.push({ channel: ch, curve: "invert" });
      else if (/^linear$/i.test(kind)) modifiers.push({ channel: ch, curve: "linear" });
      else unsupported.push(`channel ${ch + 1}: ${kind}`);
    }
    out.fixtures.push({
      manufacturer,
      model: text(f.Model),
      mode: text(f.Mode),
      name,
      universe: num(f.Universe) + 1,
      address: num(f.Address) + 1,
      channels: num(f.Channels, 1),
      modifiers,
      unsupportedModifiers: unsupported,
    });
  }
  return out;
}

const PRESET_TYPES: [RegExp, ChannelType][] = [
  [/^Intensity(Master)?Dimmer$/, "intensity"],
  [/^IntensityRed$/, "red"],
  [/^IntensityGreen$/, "green"],
  [/^IntensityBlue$/, "blue"],
  [/^IntensityWhite$/, "white"],
  [/^IntensityAmber$/, "amber"],
  [/^IntensityUV$/, "uv"],
  [/^PositionPan$/, "pan"],
  [/^PositionPanFine$/, "panFine"],
  [/^PositionTilt$/, "tilt"],
  [/^PositionTiltFine$/, "tiltFine"],
  [/^Speed/, "speed"],
  [/^Shutter/, "strobe"],
  [/^Color(Wheel|Macro)/, "colorWheel"],
  [/^Gobo/, "gobo"],
];

/** Channel function from a QLC+ <Channel> element. */
export function qlcChannelType(c: Obj): ChannelType {
  const name = String(c["@_Name"] ?? "");
  if (/laser/i.test(name)) return "laser";
  const preset = String(c["@_Preset"] ?? "");
  if (preset) {
    if (/Fine$/.test(preset) && !/^Position/.test(preset)) return "macro"; // 16-bit fine bytes of colours/dimmers
    for (const [re, t] of PRESET_TYPES) if (re.test(preset)) return t;
    return "macro";
  }
  const group = text(c.Group);
  const colour = text(c.Colour).toLowerCase();
  const fine = /fine/i.test(name);
  switch (group) {
    case "Intensity":
      if (fine) return "macro";
      if (colour === "red") return "red";
      if (colour === "green") return "green";
      if (colour === "blue") return "blue";
      if (colour === "white") return "white";
      if (colour === "amber") return "amber";
      if (colour === "uv") return "uv";
      if (colour) return "macro"; // cyan/magenta/yellow/lime… not mapped yet
      return "intensity";
    case "Pan":
      return fine ? "panFine" : "pan";
    case "Tilt":
      return fine ? "tiltFine" : "tilt";
    case "Speed":
      return "speed";
    case "Shutter":
      return "strobe";
    case "Colour":
      return "colorWheel";
    case "Gobo":
      return "gobo";
    default:
      return "macro"; // Effect, Maintenance, Prism, Beam, Nothing…
  }
}

/** Parse a .qxf fixture definition. */
export function parseQlcDefinition(xml: string, fileName = "definition.qxf"): FixtureDef {
  const doc = parser().parse(xml) as Obj;
  const d = doc.FixtureDefinition as Obj | undefined;
  if (!d) throw new Error("Not a QLC+ fixture definition");
  const manufacturer = text(d.Manufacturer);
  const model = text(d.Model);
  const type = text(d.Type);
  const channels = new Map<string, FixtureChannelDef>();
  for (const c of (d.Channel as Obj[] | undefined) ?? []) {
    const name = String(c["@_Name"] ?? "");
    const caps: ChannelCapability[] = ((c.Capability as Obj[] | undefined) ?? []).map((k) => ({ min: num(k["@_Min"]), max: num(k["@_Max"], 255), name: text(k) }));
    channels.set(name, { name, type: qlcChannelType(c), ...(caps.length ? { capabilities: caps } : {}) });
  }
  const modes: FixtureModeDef[] = ((d.Mode as Obj[] | undefined) ?? []).map((m) => {
    const list = ((m.Channel as Obj[] | undefined) ?? []).map((ch) => ({ n: num(ch["@_Number"]), name: text(ch) })).sort((a, b) => a.n - b.n);
    return { name: String(m["@_Name"] ?? `${list.length} channel`), channels: list.map((x) => channels.get(x.name) ?? { name: x.name, type: "unknown" as ChannelType }) };
  });
  if (!modes.length) throw new Error(`${manufacturer} ${model}: no modes in the definition`);
  const laser = /laser/i.test(`${type} ${model} ${manufacturer}`) || [...channels.values()].some((c) => c.type === "laser");
  const category: FixtureDef["category"] = laser && !/moving|head/i.test(type) ? "laser" : /moving head/i.test(type) ? "moving-head" : /strobe/i.test(type) ? "strobe" : /dimmer/i.test(type) ? "dimmer" : /bar/i.test(type) ? "bar" : /color changer|par/i.test(type) ? "par" : "other";
  return { id: qlcDefId(manufacturer, model), manufacturer, model, category, modes, ...(laser ? { laser: true } : {}), source: `QLC+ file ${fileName}` };
}

/**
 * Stand-in definition for a patched fixture without an imported .qxf: the right channel
 * count, every channel "unknown" (shown as CH 1…n, never driven automatically).
 */
export function placeholderDef(e: Pick<QlcPatchEntry, "manufacturer" | "model" | "mode" | "channels">): FixtureDef {
  const laser = /laser/i.test(`${e.manufacturer} ${e.model}`);
  return {
    id: qlcDefId(e.manufacturer, e.model),
    manufacturer: e.manufacturer,
    model: e.model,
    category: laser ? "laser" : "other",
    placeholder: true,
    ...(laser ? { laser: true } : {}),
    source: "QLC+ fixture list — definition not imported yet",
    modes: [{ name: e.mode, channels: Array.from({ length: e.channels }, (_, i) => ({ name: `CH ${i + 1}`, type: "unknown" as ChannelType })) }],
  };
}

/** Merge a placeholder with more modes seen in the patch (same model used in different modes). */
export function addPlaceholderMode(def: FixtureDef, e: Pick<QlcPatchEntry, "mode" | "channels">): FixtureDef {
  if (def.modes.some((m) => m.name === e.mode)) return def;
  return { ...def, modes: [...def.modes, { name: e.mode, channels: Array.from({ length: e.channels }, (_, i) => ({ name: `CH ${i + 1}`, type: "unknown" as ChannelType })) }] };
}

/** What kind of QLC+ file this is. */
export function qlcFileKind(xml: string): "fixtureList" | "workspace" | "definition" | null {
  const head = xml.slice(0, 600);
  if (/<FixtureDefinition[\s>]/.test(head) || /<!DOCTYPE FixtureDefinition>/.test(head)) return "definition";
  if (/<FixtureList[\s>]/.test(head) || /<!DOCTYPE FixtureList>/.test(head)) return "fixtureList";
  if (/<Workspace[\s>]/.test(head) || /<!DOCTYPE Workspace>/.test(head)) return "workspace";
  return null;
}

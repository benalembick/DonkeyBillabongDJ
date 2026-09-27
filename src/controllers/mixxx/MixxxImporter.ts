/**
 * Mixxx mapping importer / compatibility layer.
 *
 *   Mixxx *.midi.xml → parse → translate (exact table + script heuristics) → ControllerMapping + report
 *
 * Design rules:
 *  - We read the user's Mixxx XML at runtime; we never bundle or execute Mixxx
 *    scripts (they may be GPL and they target Mixxx's engine API).
 *  - Controls bound to <script-binding/> are inferred from their function name
 *    and flagged "heuristic" so the user can review them in the mapping editor.
 *  - Anything we cannot translate is listed in the report, never silently dropped.
 */
import { XMLParser } from "fast-xml-parser";
import { actionCatalog } from "../../core/actions";
import type { ControllerMapping, InputBinding, InputEncoding, OutputBinding, PhysicalControl } from "../mapping/schema";
import { MAPPING_SCHEMA, describeSelector } from "../mapping/schema";
import { guessScriptBinding, mapMixxxInput, mapMixxxOutput, type ScriptGuess } from "./mixxxControlMap";

export interface ImportIssue {
  status: string;
  midino: string;
  group: string;
  key: string;
  reason: string;
}

export interface ImportReport {
  controllerName: string;
  author?: string;
  scriptFiles: string[];
  totalControls: number;
  totalOutputs: number;
  exact: number;
  heuristic: number;
  outputsMapped: number;
  unresolved: ImportIssue[];
  warnings: string[];
}

export interface ImportResult {
  mapping: ControllerMapping;
  report: ImportReport;
}

interface RawControl {
  group?: string;
  key?: string;
  status?: string;
  midino?: string;
  options?: Record<string, unknown> | string;
}
interface RawOutput extends RawControl {
  on?: string;
  off?: string;
  minimum?: string;
  maximum?: string;
}

function num(v: string | undefined): number {
  if (v == null) return NaN;
  const s = String(v).trim();
  return s.toLowerCase().startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
}

function optionNames(o: RawControl["options"]): string[] {
  if (!o || typeof o === "string") return [];
  return Object.keys(o).map((k) => k.toLowerCase());
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mixxx-mapping";
}

export function importMixxxMapping(xml: string, opts: { fileName?: string } = {}): ImportResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ["control", "output", "file"].includes(name),
  });
  const doc = parser.parse(xml);
  const preset = doc?.MixxxControllerPreset ?? doc?.MixxxMIDIPreset;
  if (!preset) throw new Error("Not a Mixxx controller mapping (missing <MixxxControllerPreset>)");
  const info = preset.info ?? {};
  const controller = preset.controller ?? {};
  const name: string = String(info.name ?? opts.fileName ?? "Imported Mixxx mapping");

  const report: ImportReport = {
    controllerName: name,
    author: info.author ? String(info.author) : undefined,
    scriptFiles: asArray(controller.scriptfiles?.file).map((f: Record<string, string>) => String(f["@_filename"] ?? "")),
    totalControls: 0,
    totalOutputs: 0,
    exact: 0,
    heuristic: 0,
    outputsMapped: 0,
    unresolved: [],
    warnings: [],
  };
  if (report.scriptFiles.length > 0) {
    report.warnings.push(
      `This mapping uses ${report.scriptFiles.length} script file(s) (${report.scriptFiles.join(", ")}). ` +
        "Script logic is not executed; script-bound controls are inferred from function names and marked for review.",
    );
  }

  const catalog = actionCatalog();
  const inputs: InputBinding[] = [];
  const controls = new Map<string, PhysicalControl>();
  const rawControls: RawControl[] = asArray(controller.controls?.control);
  report.totalControls = rawControls.length;

  // Pending 14-bit halves keyed by (channel, target action, modifier-less).
  const halves = new Map<string, { channel: number; msb?: number; lsb?: number; binding: Omit<InputBinding, "midi"> }>();
  // Indexed script functions (hot cues etc.) collected so we can assign indices by MIDI order.
  const indexed = new Map<string, { status: number; midino: number; guess: ScriptGuess; raw: RawControl }[]>();

  const controlIdFor = (status: number, midino: number, action: string) => {
    const id = `midi.${status.toString(16)}.${midino.toString(16)}`;
    if (!controls.has(id)) {
      const kind: PhysicalControl["kind"] =
        /jog\.touch/.test(action) ? "jog-touch" : /\.jog\./.test(action) ? "jog" : /crossfader/.test(action) ? "crossfader"
        : /volume|tempo/.test(action) ? "fader" : /scroll/.test(action) ? "encoder" : (status & 0xf0) === 0xb0 ? "knob" : "button";
      const label = catalog.get(action)?.label ?? action;
      controls.set(id, { id, label, kind, section: sectionFor(action), short: label.toUpperCase() });
    }
    return id;
  };

  const pushBinding = (status: number, midino: number, target: { action: string; encoding?: InputEncoding; note?: string }, confidence: "exact" | "heuristic", invert: boolean) => {
    const hi = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const midi =
      hi === 0x90 || hi === 0x80
        ? ({ type: "note", channel, note: midino } as const)
        : hi === 0xe0
          ? ({ type: "pitchbend", channel } as const)
          : ({ type: "cc", channel, cc: midino } as const);
    const encoding = target.encoding ?? (midi.type === "note" ? "button" : "absolute");
    inputs.push({
      control: controlIdFor(status, midino, target.action),
      midi,
      action: target.action,
      encoding,
      invert: invert || undefined,
      confidence,
      note: target.note,
    });
    if (confidence === "exact") report.exact++;
    else report.heuristic++;
  };

  for (const raw of rawControls) {
    const status = num(raw.status);
    const midino = num(raw.midino);
    const group = String(raw.group ?? "");
    const key = String(raw.key ?? "");
    const opts = optionNames(raw.options);
    const issue = (reason: string) => report.unresolved.push({ status: String(raw.status), midino: String(raw.midino), group, key, reason });
    if (Number.isNaN(status) || Number.isNaN(midino)) {
      issue("Invalid status/midino");
      continue;
    }
    const channel = (status & 0x0f) + 1;
    const invert = opts.includes("invert");

    if (opts.includes("script-binding")) {
      const guess = guessScriptBinding(key, group);
      if (!guess) {
        issue(`Script function "${key}" has no known equivalent`);
        continue;
      }
      if (guess.indexed) {
        const k = `${status}:${guess.action}`;
        let list = indexed.get(k);
        if (!list) indexed.set(k, (list = []));
        list.push({ status, midino, guess, raw });
        continue;
      }
      if (guess.half) {
        const k = `${channel}:${guess.action}:${key.replace(/(msb|lsb)$/i, "")}`;
        const h = halves.get(k) ?? { channel, binding: { control: "", action: guess.action, encoding: "absolute", confidence: "heuristic", note: `Mixxx script ${key.replace(/(MSB|LSB)$/i, "")}` } };
        if (guess.half === "msb") h.msb = midino;
        else h.lsb = midino;
        halves.set(k, h);
        continue;
      }
      pushBinding(status, midino, { ...guess, note: `Mixxx script ${key}` }, "heuristic", invert);
      continue;
    }

    const target = mapMixxxInput(group, key);
    if (!target) {
      issue(`No equivalent for ${group} ${key}`);
      continue;
    }
    if (opts.includes("fourteen-bit-msb") || opts.includes("fourteen-bit-lsb")) {
      const k = `${channel}:${target.action}`;
      const h = halves.get(k) ?? { channel, binding: { control: "", action: target.action, encoding: "absolute", confidence: "exact", invert: invert || undefined } };
      if (opts.includes("fourteen-bit-msb")) h.msb = midino;
      else h.lsb = midino;
      halves.set(k, h);
      continue;
    }
    let encoding = target.encoding;
    if (opts.includes("selectknob") || opts.includes("relative")) encoding = "relative-twos-complement";
    else if (opts.includes("diff")) encoding = "relative-twos-complement";
    else if (opts.includes("spread64")) encoding = "relative-offset64";
    else if (opts.includes("button")) encoding = "button";
    pushBinding(status, midino, { ...target, encoding }, "exact", invert);
  }

  // Resolve 14-bit pairs.
  for (const [, h] of halves) {
    const status = 0xb0 | (h.channel - 1);
    if (h.msb != null && h.lsb != null) {
      inputs.push({ ...h.binding, control: controlIdFor(status, h.msb, h.binding.action), midi: { type: "cc14", channel: h.channel, msb: h.msb, lsb: h.lsb } });
      if (h.binding.confidence === "exact") report.exact++;
      else report.heuristic++;
    } else {
      const only = (h.msb ?? h.lsb)!;
      inputs.push({ ...h.binding, control: controlIdFor(status, only, h.binding.action), midi: { type: "cc", channel: h.channel, cc: only } });
      report.warnings.push(`Only one half of a 14-bit pair found for ${h.binding.action}; using 7-bit CC ${only}.`);
      report.heuristic++;
    }
  }

  // Assign indices to indexed script functions by ascending MIDI note within each (status, function).
  for (const [, list] of indexed) {
    list.sort((a, b) => a.midino - b.midino);
    list.forEach((item, i) => {
      const n = i + 1;
      let action = item.guess.action.replace("?", String(n));
      if (item.guess.indexed === "beatloop" || item.guess.indexed === "roll") {
        const sizes = item.guess.indexed === "roll" ? ["0.0625", "0.125", "0.25", "0.5", "1", "2", "4", "8"] : ["1", "2", "4", "8", "16", "32", "64"];
        action = item.guess.action.replace("?", sizes[i] ?? sizes[sizes.length - 1]);
      }
      if (!catalog.has(action)) {
        report.unresolved.push({ status: String(item.raw.status), midino: String(item.raw.midino), group: String(item.raw.group), key: String(item.raw.key), reason: `Inferred ${action}, which is out of range` });
        return;
      }
      pushBinding(item.status, item.midino, { action, note: `Mixxx script ${item.raw.key} (index inferred from MIDI order — verify)` }, "heuristic", false);
    });
  }

  // Outputs (LEDs).
  const outputs: OutputBinding[] = [];
  const rawOutputs: RawOutput[] = asArray(controller.outputs?.output);
  report.totalOutputs = rawOutputs.length;
  for (const raw of rawOutputs) {
    const feedback = mapMixxxOutput(String(raw.group ?? ""), String(raw.key ?? ""));
    const status = num(raw.status);
    const midino = num(raw.midino);
    if (!feedback || Number.isNaN(status) || Number.isNaN(midino)) {
      report.unresolved.push({ status: String(raw.status), midino: String(raw.midino), group: String(raw.group), key: String(raw.key), reason: "LED output not translated" });
      continue;
    }
    const on = Number.isNaN(num(raw.on)) ? 0x7f : num(raw.on);
    const off = Number.isNaN(num(raw.off)) ? 0x00 : num(raw.off);
    outputs.push({
      feedback,
      midi: { type: (status & 0xf0) === 0xb0 ? "cc" : "note", channel: (status & 0x0f) + 1, number: midino },
      on,
      off,
    });
    report.outputsMapped++;
  }
  if (rawOutputs.length === 0 && report.scriptFiles.length > 0) {
    report.warnings.push("No <outputs> in the XML: LED feedback for this controller is driven by its script and must be added in the mapping editor.");
  }

  // Detect conflicts: same MIDI selector bound to different actions without modifiers.
  const seen = new Map<string, string>();
  for (const b of inputs) {
    const k = describeSelector(b.midi) + (b.modifier ?? "");
    const prev = seen.get(k);
    if (prev && prev !== b.action) report.warnings.push(`${k} is bound to both ${prev} and ${b.action}.`);
    seen.set(k, b.action);
  }

  const mapping: ControllerMapping = {
    schema: MAPPING_SCHEMA,
    id: `mixxx-${slug(name)}`,
    name,
    description: `Imported from Mixxx mapping${opts.fileName ? ` ${opts.fileName}` : ""}`,
    match: { portNamePatterns: [guessPortPattern(name)] },
    provenance: {
      source: `Mixxx controller mapping${opts.fileName ? ` (${opts.fileName})` : ""}`,
      authors: report.author ? [report.author] : undefined,
      notes: "Imported at runtime from a user-supplied file. Respect the original mapping's licence when redistributing.",
    },
    controls: [...controls.values()],
    inputs,
    outputs,
  };
  return { mapping, report };
}

function sectionFor(action: string): string {
  const m = /^deck(\d+)\./.exec(action);
  if (m) return `deck${String.fromCharCode(64 + Number(m[1]))}`;
  if (action.startsWith("mixer.")) return "mixer";
  if (action.startsWith("browser.")) return "browser";
  if (action.startsWith("fx.")) return "fx";
  if (action.startsWith("sampler")) return "sampler";
  return "other";
}

/** Build a port-name regex from a mapping name such as "Pioneer DDJ-SB" → "DDJ[- ]?SB(?![0-9])". */
function guessPortPattern(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const model = words.length > 1 ? words.slice(1).join(" ") : name;
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[- ]?");
  return `${escaped}(?![0-9A-Za-z])`;
}

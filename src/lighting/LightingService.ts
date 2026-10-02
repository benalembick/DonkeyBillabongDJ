/**
 * Lighting composition root: DMX engine + fixture patch + sound-to-light + outputs.
 *
 *   control sources ──► DmxEngine layers ──► compute() @ 40 Hz ──► output providers
 *   (desk, virtual console,                                          (Art-Net / sACN in the main process,
 *    sound-to-light, Art-Net in,                                      USB DMX Pro via Web Serial)
 *    later scenes/chases/MIDI/Auto DJ)
 *
 * Controls are also exposed as command-bus actions (lighting.*) so the DDJ-SB or any
 * MIDI controller can be mapped to them later without touching this module.
 */
import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { DJEngine } from "../core/engine/DJEngine";
import type { EventLog } from "../core/log";
import { DmxEngine, LAYER_DESK, LAYER_INPUT } from "./DmxEngine";
import { DMX_SLOTS } from "./protocol";
import { GENERIC_FIXTURES, INTENSITY_TYPES, findDef, fitsUniverse, modeOf, nextFreeAddress, overlaps, type FixtureDef, type PatchedFixture } from "./fixtures";
import { addPlaceholderMode, parseQlcDefinition, parseQlcFixtureList, placeholderDef, qlcDefId, qlcFileKind } from "./qlcImport";
import { defaultIo, type ExitBehaviour, type IoStatus, type UniverseIo } from "./io";
import { DEFAULT_SOUND_SETTINGS, SoundToLight, type ChannelLink, type MovementSettings, type SoundSettings } from "./SoundToLight";
import { makeBeatSource, makeProbe, MicInput, type AnalysisTapProvider } from "./audioInputs";
import { UsbProOutput } from "./usbPro";

/** Virtual Console widgets: the MVP ships Sound-to-Light; new types register here. */
export type VcWidgetType = "soundToLight";
export interface VcWidget {
  id: string;
  type: VcWidgetType;
  title: string;
}
export const VC_WIDGET_TYPES: { type: VcWidgetType; label: string; description: string }[] = [
  { type: "soundToLight", label: "Sound Activated Light Control", description: "Bass / mid / high and beats from the DJ mix drive the selected fixtures" },
];

export interface LightingConfig {
  version: 1;
  universes: UniverseIo[];
  fixtures: PatchedFixture[];
  sound: SoundSettings;
  console: { widgets: VcWidget[] };
  exitBehaviour: ExitBehaviour;
  master: number;
  /** Imported fixture definitions (QLC+ .qxf) and stand-ins for ones not imported yet. */
  customDefs: FixtureDef[];
}

export interface QlcImportReport {
  fixtures: number;
  withDefinition: string[];
  needDefinition: string[];
  definitions: string[];
  skipped: string[];
  notes: string[];
  errors: string[];
}

export function defaultLightingConfig(): LightingConfig {
  return {
    version: 1,
    universes: [defaultIo(1)],
    fixtures: [],
    sound: { ...DEFAULT_SOUND_SETTINGS },
    console: { widgets: [{ id: "vc-stl-1", type: "soundToLight", title: "Sound Activated Light Control" }] },
    exitBehaviour: "blackout",
    master: 1,
    customDefs: [],
  };
}

/** Main-process side (desktop): network outputs, input and the config file. */
export interface LightingBridge {
  load(): Promise<unknown>;
  save(cfg: LightingConfig): Promise<void>;
  configure(io: UniverseIo[], exit: ExitBehaviour): Promise<void>;
  frame(universe: number, data: Uint8Array): void;
  onStatus(cb: (universe: number, s: IoStatus) => void): () => void;
  onInput(cb: (universe: number, data: Uint8Array) => void): () => void;
}

const STORAGE_KEY = "dbdj.lighting.v1";
const TICK_MS = 25; // 40 Hz — the usual DMX refresh

export class LightingService extends Emitter<{ config: LightingConfig; status: void }> {
  readonly engine = new DmxEngine();
  private defsCache: { custom: FixtureDef[]; all: FixtureDef[] } | null = null;
  /** Built-in generic fixtures + imported definitions. */
  get defs(): FixtureDef[] {
    const custom = this.cfg?.customDefs ?? [];
    if (this.defsCache?.custom !== custom) this.defsCache = { custom, all: [...GENERIC_FIXTURES, ...custom] };
    return this.defsCache.all;
  }
  readonly sound: SoundToLight;
  readonly mic = new MicInput();
  readonly usb: UsbProOutput;
  private cfg: LightingConfig = defaultLightingConfig();
  private netStatus = new Map<number, IoStatus>();
  private lastSent = new Map<number, { data: Uint8Array; at: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private readonly bridge: LightingBridge | null;
  private readonly log: EventLog;

  constructor(opts: { bus: CommandBus; log: EventLog; dj: DJEngine; audio: AnalysisTapProvider; bridge: LightingBridge | null }) {
    super();
    this.bridge = opts.bridge;
    this.log = opts.log;
    this.usb = new UsbProOutput(() => this.emit("status", undefined));
    this.sound = new SoundToLight({
      engine: this.engine,
      probe: makeProbe(opts.audio, this.mic),
      beats: makeBeatSource(opts.dj, opts.audio),
      rig: () => ({ defs: this.defs, fixtures: this.cfg.fixtures }),
    });
    this.bridge?.onStatus((u, s) => {
      this.netStatus.set(u, s);
      this.emit("status", undefined);
    });
    this.bridge?.onInput((u, data) => {
      const f = new Uint8Array(DMX_SLOTS);
      f.set(data.subarray(0, DMX_SLOTS));
      this.engine.writeLayer(LAYER_INPUT, u, f);
    });
    this.registerActions(opts.bus);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(): Promise<void> {
    await this.load();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.cfg.universes.some((u) => u.output === "usb-pro")) void this.usb.reconnect();
    if (typeof window !== "undefined") window.addEventListener("beforeunload", () => this.shutdown());
  }

  /** Safe output on exit: zero the lights unless the user chose "hold". (Network outputs are also zeroed by the main process.) */
  shutdown(): void {
    if (this.cfg.exitBehaviour === "blackout") void this.usb.zero();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getConfig(): LightingConfig {
    return this.cfg;
  }

  private async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = this.bridge ? await this.bridge.load() : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch (err) {
      this.log.warn("lighting", `Couldn't read the lighting setup: ${String(err)}`);
    }
    const base = defaultLightingConfig();
    const c = (raw && typeof raw === "object" ? raw : {}) as Partial<LightingConfig>;
    this.cfg = {
      ...base,
      ...c,
      universes: Array.isArray(c.universes) && c.universes.length ? c.universes.map((u) => ({ ...defaultIo(u.universe), ...u, artnet: { ...defaultIo(u.universe).artnet, ...u.artnet }, sacn: { ...defaultIo(u.universe).sacn, ...u.sacn } })) : base.universes,
      fixtures: Array.isArray(c.fixtures) ? c.fixtures : [],
      customDefs: Array.isArray(c.customDefs) ? c.customDefs : [],
      // Sound control never starts by itself; movement settings merged so older setups get the new fields.
      sound: { ...base.sound, ...c.sound, enabled: false, movement: { ...base.sound.movement, ...c.sound?.movement }, channelLinks: Array.isArray(c.sound?.channelLinks) ? c.sound.channelLinks : [] },
      console: c.console?.widgets ? c.console : base.console,
    };
    if (raw) this.log.info("lighting", `Lighting setup restored: ${this.cfg.fixtures.length} fixture(s), ${this.cfg.universes.length} universe(s)`);
    this.apply(true);
  }

  private update(patch: Partial<LightingConfig>, reconfigureOutputs = false): void {
    this.cfg = { ...this.cfg, ...patch };
    this.apply(reconfigureOutputs);
    this.emit("config", this.cfg);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 300);
  }

  private async persist(): Promise<void> {
    try {
      if (this.bridge) await this.bridge.save(this.cfg);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cfg));
    } catch (err) {
      this.log.warn("lighting", `Couldn't save the lighting setup: ${String(err)}`);
    }
  }

  private apply(reconfigureOutputs: boolean): void {
    const wanted = new Set(this.cfg.universes.map((u) => u.universe));
    for (const u of this.engine.getUniverses()) if (!wanted.has(u)) this.engine.removeUniverse(u);
    for (const u of wanted) this.engine.addUniverse(u);
    // Grand master scales light output only: position/strobe/effect channels are masked out.
    for (const u of wanted) {
      const mask = new Uint8Array(DMX_SLOTS).fill(1);
      for (const f of this.cfg.fixtures) {
        if (f.universe !== u) continue;
        const mode = modeOf(this.defs, f);
        mode?.channels.forEach((c, i) => {
          const a = f.address + i;
          if (a >= 1 && a <= DMX_SLOTS && !INTENSITY_TYPES.has(c.type)) mask[a - 1] = 0;
        });
      }
      this.engine.setMasterMask(u, mask);
      // QLC+-style output modifiers (e.g. inverted pan on a mirrored moving head).
      const inv: number[] = [];
      for (const f of this.cfg.fixtures) if (f.universe === u) for (const m of f.modifiers ?? []) if (m.curve === "invert") inv.push(f.address + m.channel);
      this.engine.setInvertedChannels(u, inv);
    }
    this.engine.setMaster(this.cfg.master);
    this.sound.settings = this.cfg.sound;
    if (reconfigureOutputs) void this.bridge?.configure(this.cfg.universes, this.cfg.exitBehaviour).catch((err) => this.log.error("lighting", `DMX output: ${String(err)}`));
  }

  // ───────────────────────── output loop ─────────────────────────

  private tick(): void {
    const now = performance.now();
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : TICK_MS / 1000;
    this.lastTick = now;
    const s = this.cfg.sound;
    const wantMic = s.enabled && s.source === "mic";
    if (wantMic && this.mic.state === "off") void this.mic.start().then(() => this.emit("status", undefined));
    if (!wantMic && this.mic.state !== "off") this.mic.stop();
    this.sound.update(dt);
    let usbUsed = false;
    for (const io of this.cfg.universes) {
      if (io.output === "none") continue;
      const frame = this.engine.compute(io.universe);
      const prev = this.lastSent.get(io.universe);
      const changed = !prev || prev.data.some((v, i) => v !== frame[i]);
      if (io.output === "usb-pro") {
        if (usbUsed) continue; // one USB interface → one universe
        usbUsed = true;
        if (changed || now - (prev?.at ?? 0) > 1000) this.usb.send(frame);
      } else if (changed) this.bridge?.frame(io.universe, frame);
      if (changed || now - (prev?.at ?? 0) > 1000) this.lastSent.set(io.universe, { data: frame, at: now });
    }
  }

  // ───────────────────────── status ─────────────────────────

  statusOf(u: number): IoStatus {
    const io = this.cfg.universes.find((x) => x.universe === u);
    if (!io) return { output: "disabled", input: "disabled", detail: "" };
    const net = this.netStatus.get(u);
    const input = io.input === "none" ? "disabled" : !this.bridge ? "unavailable" : (net?.input ?? "disconnected");
    switch (io.output) {
      case "none":
        return { output: "disabled", input, detail: "" };
      case "usb-pro": {
        const first = this.cfg.universes.find((x) => x.output === "usb-pro")?.universe === u;
        return first ? { output: this.usb.state, input, detail: this.usb.detail } : { output: "error", input, detail: "Only one USB DMX interface is supported — it is used by another universe" };
      }
      default:
        if (!this.bridge) return { output: "unavailable", input, detail: "Art-Net / sACN need the desktop app (browsers can't send UDP)" };
        return net ? { ...net, input } : { output: "disconnected", input, detail: "Starting…" };
    }
  }

  // ───────────────────────── universes & I/O ─────────────────────────

  addUniverse(): number {
    const u = Math.max(0, ...this.cfg.universes.map((x) => x.universe)) + 1;
    this.update({ universes: [...this.cfg.universes, defaultIo(u)] }, true);
    return u;
  }

  removeUniverse(u: number): void {
    if (this.cfg.universes.length <= 1) return;
    this.update({ universes: this.cfg.universes.filter((x) => x.universe !== u), fixtures: this.cfg.fixtures.filter((f) => f.universe !== u) }, true);
  }

  setIo(u: number, patch: Partial<UniverseIo>): void {
    this.update({ universes: this.cfg.universes.map((x) => (x.universe === u ? { ...x, ...patch, artnet: { ...x.artnet, ...patch.artnet }, sacn: { ...x.sacn, ...patch.sacn } } : x)) }, true);
  }

  setExitBehaviour(b: ExitBehaviour): void {
    this.update({ exitBehaviour: b }, true);
  }

  // ───────────────────────── fixtures ─────────────────────────

  /**
   * Add or update a fixture. Returns the overlapping fixtures instead of saving when the
   * addresses collide and `allowOverlap` isn't set (the UI asks the user to confirm).
   */
  saveFixture(f: PatchedFixture, allowOverlap = false): { ok: true } | { ok: false; overlaps?: PatchedFixture[]; error?: string } {
    if (!fitsUniverse(f)) return { ok: false, error: `Doesn't fit: DMX ${f.address}–${f.address + f.channelCount - 1} runs past channel 512` };
    const hits = overlaps(this.cfg.fixtures, f);
    if (hits.length && !allowOverlap) return { ok: false, overlaps: hits };
    const exists = this.cfg.fixtures.some((x) => x.id === f.id);
    this.update({ fixtures: exists ? this.cfg.fixtures.map((x) => (x.id === f.id ? f : x)) : [...this.cfg.fixtures, f] });
    return { ok: true };
  }

  removeFixture(id: string): void {
    this.update({ fixtures: this.cfg.fixtures.filter((f) => f.id !== id), sound: { ...this.cfg.sound, fixtures: this.cfg.sound.fixtures.filter((x) => x !== id) } });
  }

  suggestAddress(universe: number, count: number): number | null {
    return nextFreeAddress(this.cfg.fixtures, universe, count);
  }

  // ───────────────────────── desk ─────────────────────────

  setDesk(u: number, channel: number, value: number): void {
    this.engine.setChannel(LAYER_DESK, u, channel, value);
  }

  setDeskMany(u: number, values: [number, number][]): void {
    this.engine.setChannels(LAYER_DESK, u, values);
  }

  /** Full on: every light-output channel of the universe to 255 (never pan/tilt/strobe/effects). */
  deskFullOn(u: number): void {
    const mask = new Uint8Array(DMX_SLOTS).fill(1);
    for (const f of this.cfg.fixtures) {
      if (f.universe !== u) continue;
      const laser = !!findDef(this.defs, f.defId)?.laser;
      const mode = modeOf(this.defs, f);
      for (let i = 0; i < f.channelCount && f.address + i <= DMX_SLOTS; i++) {
        const c = mode?.channels[i];
        // Never switch on lasers, unknown channels, position or effect channels.
        if (laser || !c || !INTENSITY_TYPES.has(c.type)) mask[f.address + i - 1] = 0;
      }
    }
    const vals: [number, number][] = [];
    for (let c = 1; c <= DMX_SLOTS; c++) if (mask[c - 1]) vals.push([c, 255]);
    this.engine.setChannels(LAYER_DESK, u, vals);
  }

  deskClear(u?: number): void {
    this.engine.clearLayer(LAYER_DESK, u);
  }

  // ───────────────────────── master / blackout / sound ─────────────────────────

  setMaster(v: number): void {
    this.update({ master: Math.max(0, Math.min(1, v)) });
  }

  setBlackout(on: boolean): void {
    this.engine.setBlackout(on);
    this.emit("status", undefined);
  }

  setSound(patch: Partial<SoundSettings>): void {
    this.update({ sound: { ...this.cfg.sound, ...patch } });
  }

  setMovement(patch: Partial<MovementSettings>): void {
    this.setSound({ movement: { ...this.cfg.sound.movement, ...patch } });
  }

  /** Allocate a DMX Desk channel to part of the music (null removes the link). */
  setChannelLink(universe: number, channel: number, link: Omit<ChannelLink, "universe" | "channel"> | null): void {
    const others = this.cfg.sound.channelLinks.filter((x) => x.universe !== universe || x.channel !== channel);
    this.setSound({ channelLinks: link ? [...others, { ...link, universe, channel }] : others });
  }

  channelLink(universe: number, channel: number): ChannelLink | undefined {
    return this.cfg.sound.channelLinks.find((x) => x.universe === universe && x.channel === channel);
  }

  /**
   * Import QLC+ files: fixture lists (.qxfl) / workspaces (.qxw) recreate the patch;
   * fixture definitions (.qxf) give each channel its real function. Files can come in any
   * order or separately — patched fixtures pick up definitions imported later.
   */
  importQlc(files: { name: string; text: string }[], opts: { replaceFixtures: boolean }): QlcImportReport {
    const report: QlcImportReport = { fixtures: 0, withDefinition: [], needDefinition: [], definitions: [], skipped: [], notes: [], errors: [] };
    const defs = new Map(this.cfg.customDefs.map((d) => [d.id, d]));
    // Definitions first, so a list imported together with them links straight away.
    for (const f of files) {
      if (qlcFileKind(f.text) !== "definition") continue;
      try {
        const d = parseQlcDefinition(f.text, f.name);
        defs.set(d.id, d);
        report.definitions.push(`${d.manufacturer} ${d.model} (${d.modes.map((m) => m.name).join(", ")})${d.laser ? " — laser" : ""}`);
      } catch (err) {
        report.errors.push(`${f.name}: ${String(err)}`);
      }
    }
    let fixtures = this.cfg.fixtures;
    let universes = this.cfg.universes;
    const lists = files.filter((f) => {
      const k = qlcFileKind(f.text);
      if (!k) report.errors.push(`${f.name}: not a QLC+ fixture list, workspace or fixture definition`);
      return k === "fixtureList" || k === "workspace";
    });
    if (lists.length && opts.replaceFixtures) fixtures = [];
    let n = 0;
    for (const f of lists) {
      try {
        const list = parseQlcFixtureList(f.text);
        report.skipped.push(...list.skipped.map((s) => `${s.name}: ${s.reason}`));
        for (const e of list.fixtures) {
          const id = qlcDefId(e.manufacturer, e.model);
          const existing = defs.get(id);
          if (!existing) defs.set(id, placeholderDef(e));
          else if (existing.placeholder) defs.set(id, addPlaceholderMode(existing, e));
          const def = defs.get(id)!;
          const mode = def.modes.find((m) => m.name === e.mode) ?? def.modes.find((m) => m.channels.length === e.channels);
          if (!mode) report.notes.push(`${e.name}: definition has no "${e.mode}" mode — using its channel count (${e.channels})`);
          const pf: PatchedFixture = {
            id: `qlc-${Date.now().toString(36)}-${n++}`,
            name: e.name,
            defId: id,
            mode: mode?.name ?? e.mode,
            universe: e.universe,
            address: e.address,
            channelCount: e.channels,
            ...(e.modifiers.length ? { modifiers: e.modifiers } : {}),
          };
          if (e.unsupportedModifiers.length) report.notes.push(`${e.name}: QLC+ curve(s) not reproduced yet — ${e.unsupportedModifiers.join("; ")} (output is linear)`);
          const clash = overlaps(fixtures, pf);
          if (clash.length) report.notes.push(`${e.name} (DMX ${pf.address}–${pf.address + pf.channelCount - 1}) overlaps ${clash.map((c) => c.name).join(", ")}`);
          fixtures = [...fixtures.filter((x) => !(opts.replaceFixtures === false && x.name === pf.name && x.universe === pf.universe)), pf];
          if (!universes.some((u) => u.universe === pf.universe)) universes = [...universes, defaultIo(pf.universe)].sort((a, b) => a.universe - b.universe);
          report.fixtures++;
        }
      } catch (err) {
        report.errors.push(`${f.name}: ${String(err)}`);
      }
    }
    // Report which patched fixtures have a real definition.
    for (const pf of fixtures) {
      const d = defs.get(pf.defId) ?? findDef(GENERIC_FIXTURES, pf.defId);
      const label = `${pf.name} — ${d?.manufacturer ?? "?"} ${d?.model ?? ""}`.trim();
      if (!d || d.placeholder) report.needDefinition.push(label);
      else report.withDefinition.push(label);
    }
    // Lasers stay out of sound control unless allowed.
    const customDefs = [...defs.values()];
    const all = [...GENERIC_FIXTURES, ...customDefs];
    const soundFixtures = this.cfg.sound.fixtures.filter((id) => fixtures.some((f) => f.id === id && (!findDef(all, f.defId)?.laser || this.cfg.sound.allowLasers)));
    this.update({ customDefs, fixtures, universes, sound: { ...this.cfg.sound, fixtures: soundFixtures } }, true);
    return report;
  }

  setWidgets(widgets: VcWidget[]): void {
    this.update({ console: { widgets } });
  }

  /** Stable, MIDI-mappable control ids (see actions.ts "Lighting"). */
  private registerActions(bus: CommandBus): void {
    const pressed = (fn: () => void) => (v: number) => {
      if (v > 0) fn();
    };
    bus.handle("lighting.blackout", pressed(() => this.setBlackout(!this.engine.isBlackout())));
    bus.handle("lighting.master", (v) => this.setMaster(v));
    bus.handle("lighting.desk.clear", pressed(() => this.deskClear()));
    bus.handle("lighting.sound.enable", pressed(() => this.setSound({ enabled: !this.cfg.sound.enabled })));
    bus.handle("lighting.sound.beatFlash", pressed(() => this.setSound({ beatFlash: !this.cfg.sound.beatFlash })));
    bus.handle("lighting.sound.downbeatAccent", pressed(() => this.setSound({ downbeatAccent: !this.cfg.sound.downbeatAccent })));
    bus.handle("lighting.sound.brightness", (v) => this.setSound({ brightness: Math.max(0, Math.min(1, v)) }));
    bus.handle("lighting.sound.sensitivity", (v) => this.setSound({ sensitivity: Math.max(0, Math.min(1, v)) }));
    bus.handle("lighting.sound.speed", (v) => this.setSound({ speed: Math.max(0, Math.min(1, v)) }));
    bus.handle("lighting.sound.movement", pressed(() => this.setMovement({ enabled: !this.cfg.sound.movement.enabled })));
    bus.handle("lighting.sound.movement.size", (v) => this.setMovement({ size: Math.max(0, Math.min(1, v)) }));
  }
}

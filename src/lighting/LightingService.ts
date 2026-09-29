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
import { GENERIC_FIXTURES, INTENSITY_TYPES, fitsUniverse, modeOf, nextFreeAddress, overlaps, type FixtureDef, type PatchedFixture } from "./fixtures";
import { defaultIo, type ExitBehaviour, type IoStatus, type UniverseIo } from "./io";
import { DEFAULT_SOUND_SETTINGS, SoundToLight, type SoundSettings } from "./SoundToLight";
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
  readonly defs: FixtureDef[] = GENERIC_FIXTURES;
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
    if (this.cfg.exitBehaviour === "blackout") this.usb.send(new Uint8Array(DMX_SLOTS));
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
      sound: { ...base.sound, ...c.sound, enabled: false }, // sound control never starts by itself
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
      modeOf(this.defs, f)?.channels.forEach((c, i) => {
        if (!INTENSITY_TYPES.has(c.type) && f.address + i <= DMX_SLOTS) mask[f.address + i - 1] = 0;
      });
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
  }
}

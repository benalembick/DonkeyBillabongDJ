/**
 * Controller engine: discovers MIDI devices (with hot-plug), attaches the
 * matching mapping to each device, feeds the MIDI monitor, and keeps
 * controller LEDs in sync with engine state.
 *
 * Resilience: a disconnect never touches the audio engine; decks keep playing.
 */
import type { CommandBus } from "../core/commands";
import { Emitter } from "../core/events";
import type { EventLog } from "../core/log";
import { parseMidi, type MidiMessage } from "./midi/message";
import { MappingRuntime, type Translation } from "./mapping/MappingRuntime";
import type { ControllerMapping } from "./mapping/schema";

export interface MonitorEntry {
  id: number;
  message: MidiMessage;
  translations: Translation[];
  /** Name of the mapping that handled it, if any. */
  mapping?: string;
}

export interface ControllerInfo {
  /** Stable key: the input port name. */
  portName: string;
  mappingId: string | null;
  mappingName: string | null;
  connected: boolean;
  hasOutput: boolean;
}

export type MidiAvailability = "pending" | "available" | "unsupported" | "denied";

interface Attached {
  input: MIDIInput;
  output: MIDIOutput | null;
  runtime: MappingRuntime | null;
}

export interface FeedbackSource {
  getFeedback(key: string): number;
  on(event: "state", listener: () => void): () => void;
}

export class ControllerManager extends Emitter<{
  controllers: ControllerInfo[];
  monitor: MonitorEntry;
  availability: MidiAvailability;
}> {
  private access: MIDIAccess | null = null;
  private attached = new Map<string, Attached>(); // key: input port id
  private known = new Map<string, ControllerInfo>(); // key: port name (survives disconnects)
  private snapshot: ControllerInfo[] | null = null;
  private mappings: ControllerMapping[];
  private overrides = new Map<string, ControllerMapping>(); // port name → user-selected mapping
  private availability: MidiAvailability = "pending";
  private monitorId = 1;
  private msgTimes: number[] = [];
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private ledPending = false;
  private simRuntimes = new Map<string, MappingRuntime>();

  private readonly bus: CommandBus;
  private readonly feedback: FeedbackSource;
  private readonly log: EventLog;

  constructor(opts: { bus: CommandBus; feedback: FeedbackSource; log: EventLog; mappings: ControllerMapping[] }) {
    super();
    this.bus = opts.bus;
    this.feedback = opts.feedback;
    this.log = opts.log;
    this.mappings = opts.mappings;
    // LED feedback: coalesce engine state changes to one refresh per animation frame.
    this.feedback.on("state", () => this.scheduleLedRefresh());
  }

  async init(): Promise<void> {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      this.setAvailability("unsupported");
      this.log.warn("controllers", "Web MIDI is not available in this environment. Use the desktop app or a Chromium browser.");
      return;
    }
    const t0 = performance.now();
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.log.info(
        "controllers",
        `MIDI ready in ${Math.round(performance.now() - t0)} ms: ${this.access.inputs.size} input(s), ${this.access.outputs.size} output(s)`,
      );
    } catch (err) {
      this.setAvailability("denied");
      this.log.error("controllers", `MIDI access was denied: ${String(err)}`);
      return;
    }
    this.setAvailability("available");
    this.access.onstatechange = () => this.scheduleRescan();
    this.rescan();
  }

  getAvailability(): MidiAvailability {
    return this.availability;
  }

  /** Stable snapshot (same array until something changes) — safe for useSyncExternalStore. */
  getControllers(): ControllerInfo[] {
    if (!this.snapshot) this.snapshot = [...this.known.values()];
    return this.snapshot;
  }

  private publishControllers(): void {
    this.snapshot = null;
    this.emit("controllers", this.getControllers());
  }

  getMappings(): ControllerMapping[] {
    return this.mappings;
  }

  /** Runtime for the first connected device using `mappingId` (for the test screen). */
  getActiveMapping(): ControllerMapping | null {
    for (const a of this.attached.values()) if (a.runtime) return a.runtime.mapping;
    return null;
  }

  /** Install a mapping (e.g. imported from Mixxx) and optionally force it onto a port. */
  addMapping(mapping: ControllerMapping, forcePortName?: string): void {
    // Newest mapping takes priority over built-ins for matching ports.
    this.mappings = [mapping, ...this.mappings.filter((m) => m.id !== mapping.id)];
    if (forcePortName) this.overrides.set(forcePortName, mapping);
    this.reattachAll();
  }

  /** Messages per second over the last second (diagnostics). */
  messagesPerSecond(): number {
    const now = performance.now();
    while (this.msgTimes.length && now - this.msgTimes[0] > 1000) this.msgTimes.shift();
    return this.msgTimes.length;
  }

  /**
   * Feed raw MIDI bytes through a mapping exactly as if they came from the
   * device (same parser, runtime and command bus). Used by the controller
   * simulator and automated tests; physical hardware is still the real test.
   */
  simulate(mappingId: string, bytes: number[]): Translation[] {
    const mapping = this.mappings.find((m) => m.id === mappingId);
    if (!mapping) throw new Error(`No mapping ${mappingId}`);
    let rt = this.simRuntimes.get(mappingId);
    if (!rt) {
      rt = new MappingRuntime(mapping, (action, value) => this.bus.dispatch({ action, value, source: "midi" }), () => undefined, (k) => this.feedback.getFeedback(k));
      this.simRuntimes.set(mappingId, rt);
    }
    const msg = parseMidi(bytes, "simulator", `${mapping.name} (simulated)`, performance.now());
    const translations = rt.handle(msg);
    this.emit("monitor", { id: this.monitorId++, message: msg, translations, mapping: mapping.name });
    return translations;
  }

  /** Turn LEDs off (call on shutdown). */
  shutdown(): void {
    for (const a of this.attached.values()) {
      try {
        a.runtime?.clearOutputs();
      } catch {
        /* device may already be gone */
      }
    }
  }

  // ───────────────────────────── discovery ─────────────────────────────

  private setAvailability(a: MidiAvailability): void {
    this.availability = a;
    this.emit("availability", a);
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    // Ports appear/disappear in bursts during USB enumeration; debounce.
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan();
    }, 250);
  }

  private findMapping(portName: string): ControllerMapping | null {
    const o = this.overrides.get(portName);
    if (o) return o;
    for (const m of this.mappings) {
      for (const p of m.match.portNamePatterns) {
        try {
          if (new RegExp(p, "i").test(portName)) return m;
        } catch {
          /* invalid user pattern */
        }
      }
    }
    return null;
  }

  private findOutput(portName: string): MIDIOutput | null {
    if (!this.access) return null;
    let best: MIDIOutput | null = null;
    for (const out of this.access.outputs.values()) {
      if (out.state !== "connected") continue;
      if (out.name === portName) return out;
      // Windows sometimes decorates names differently for in/out ports.
      if (out.name && (portName.includes(out.name) || out.name.includes(portName))) best = out;
    }
    return best;
  }

  private rescan(): void {
    if (!this.access) return;
    const seen = new Set<string>();
    for (const input of this.access.inputs.values()) {
      if (input.state !== "connected") continue;
      seen.add(input.id);
      if (!this.attached.has(input.id)) this.attach(input);
    }
    for (const [id, a] of this.attached) {
      if (!seen.has(id)) this.detach(id, a);
    }
    this.publishControllers();
  }

  private reattachAll(): void {
    for (const [id, a] of [...this.attached]) {
      this.detach(id, a, true);
      this.attach(a.input);
    }
    this.publishControllers();
  }

  private attach(input: MIDIInput): void {
    const portName = input.name ?? input.id;
    const mapping = this.findMapping(portName);
    const output = this.findOutput(portName);
    let runtime: MappingRuntime | null = null;
    if (mapping) {
      runtime = new MappingRuntime(
        mapping,
        (action, value) => this.bus.dispatch({ action, value, source: "midi" }),
        (bytes) => this.sendTo(output, bytes),
        (key) => this.feedback.getFeedback(key),
      );
    }
    const a: Attached = { input, output, runtime };
    this.attached.set(input.id, a);
    input.onmidimessage = (e: MIDIMessageEvent) => this.onMessage(a, e);

    const wasKnown = this.known.get(portName);
    this.known.set(portName, {
      portName,
      mappingId: mapping?.id ?? null,
      mappingName: mapping?.name ?? null,
      connected: true,
      hasOutput: !!output,
    });
    const label = mapping?.name ?? portName;
    if (wasKnown && !wasKnown.connected) this.log.info("controllers", `${label} reconnected`);
    else this.log.info("controllers", `${label} connected${mapping ? ` (mapping: ${mapping.name})` : " (no mapping — monitor only)"}`);
    if (mapping && !output) this.log.warn("controllers", `${label}: no MIDI output port found, LEDs disabled`);
    runtime?.refreshOutputs(true);
  }

  private detach(id: string, a: Attached, silent = false): void {
    a.input.onmidimessage = null;
    this.attached.delete(id);
    if (silent) return;
    const portName = a.input.name ?? a.input.id;
    const info = this.known.get(portName);
    if (info) this.known.set(portName, { ...info, connected: false });
    // Audio is intentionally untouched: playback continues.
    this.log.warn("controllers", `${a.runtime?.mapping.name ?? portName} disconnected — playback continues`);
  }

  private sendTo(output: MIDIOutput | null, bytes: number[]): void {
    if (!output || output.state !== "connected") return;
    try {
      output.send(bytes);
    } catch {
      /* device vanished mid-send; rescan will clean up */
    }
  }

  private onMessage(a: Attached, e: MIDIMessageEvent): void {
    if (!e.data) return;
    const msg = parseMidi(e.data, a.input.id, a.input.name ?? a.input.id, e.timeStamp);
    this.msgTimes.push(performance.now());
    if (this.msgTimes.length > 4000) this.msgTimes.splice(0, 2000);
    let translations: Translation[] = [];
    try {
      translations = a.runtime ? a.runtime.handle(msg) : [];
    } catch (err) {
      this.log.error("controllers", `Mapping error: ${String(err)}`);
    }
    this.emit("monitor", { id: this.monitorId++, message: msg, translations, mapping: a.runtime?.mapping.name });
  }

  private scheduleLedRefresh(): void {
    // Coalesce bursts of state changes (e.g. a knob sweep) into one diff pass.
    // A microtask (not rAF) so LEDs still update while the window is hidden.
    if (this.ledPending) return;
    this.ledPending = true;
    queueMicrotask(() => {
      this.ledPending = false;
      for (const a of this.attached.values()) a.runtime?.refreshOutputs();
    });
  }
}

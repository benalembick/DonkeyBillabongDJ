/**
 * Executes a normalised ControllerMapping for one connected device:
 * MIDI in → (control, action, value) → CommandBus, and engine feedback → LEDs.
 * Controller-agnostic: no DDJ-SB specifics live here.
 */
import type { MidiMessage } from "../midi/message";
import type { ControllerMapping, InputBinding, OutputBinding, PhysicalControl } from "./schema";
import { selectorKey } from "./schema";

export interface Translation {
  binding: InputBinding;
  control: PhysicalControl | undefined;
  action: string;
  value: number;
}

export type DispatchFn = (action: string, value: number) => void;
export type SendFn = (bytes: number[]) => void;
export type FeedbackFn = (key: string) => number;

export function decodeRelative(encoding: InputBinding["encoding"], v: number): number {
  switch (encoding) {
    case "relative-offset64":
      return v - 64;
    case "relative-twos-complement":
      return v < 64 ? v : v - 128;
    case "relative-signed-bit":
      return v < 64 ? v : -(v - 64);
    default:
      return 0;
  }
}

function isRelative(enc: InputBinding["encoding"]): boolean {
  return enc === "relative-offset64" || enc === "relative-twos-complement" || enc === "relative-signed-bit";
}

export class MappingRuntime {
  readonly mapping: ControllerMapping;
  private index = new Map<string, InputBinding[]>();
  private controls = new Map<string, PhysicalControl>();
  private msb = new Map<string, number>();
  private modifiers = new Set<string>();
  private lastOut = new Map<string, number>();
  private readonly dispatch: DispatchFn;
  private readonly send: SendFn;
  private readonly feedback: FeedbackFn;

  constructor(mapping: ControllerMapping, dispatch: DispatchFn, send: SendFn, feedback: FeedbackFn) {
    this.mapping = mapping;
    this.dispatch = dispatch;
    this.send = send;
    this.feedback = feedback;
    for (const c of mapping.controls) this.controls.set(c.id, c);
    for (const b of mapping.inputs) {
      for (const k of selectorKey(b.midi)) {
        let list = this.index.get(k);
        if (!list) this.index.set(k, (list = []));
        list.push(b);
      }
    }
  }

  getControl(id: string): PhysicalControl | undefined {
    return this.controls.get(id);
  }

  isModifierActive(name: string): boolean {
    return this.modifiers.has(name);
  }

  /** Translate and dispatch one incoming message. Returns what it resolved to (for the MIDI monitor). */
  handle(msg: MidiMessage): Translation[] {
    let key: string;
    if (msg.type === "noteon" || msg.type === "noteoff") key = `n:${msg.channel}:${msg.data1}`;
    else if (msg.type === "cc") key = `c:${msg.channel}:${msg.data1}`;
    else if (msg.type === "pitchbend") key = `p:${msg.channel}`;
    else return [];

    const candidates = this.index.get(key);
    if (!candidates) return [];
    const active = candidates.filter((b) => b.modifier && this.modifiers.has(b.modifier));
    const bindings = active.length > 0 ? active : candidates.filter((b) => !b.modifier);

    const out: Translation[] = [];
    for (const b of bindings) {
      const value = this.valueFor(b, msg);
      if (value === null) continue;
      const t: Translation = { binding: b, control: this.controls.get(b.control), action: b.action, value };
      out.push(t);
      if (b.action.startsWith("modifier.")) {
        const name = b.action.slice("modifier.".length);
        if (value > 0) this.modifiers.add(name);
        else this.modifiers.delete(name);
      } else {
        this.dispatch(b.action, value);
      }
    }
    return out;
  }

  private valueFor(b: InputBinding, msg: MidiMessage): number | null {
    const sel = b.midi;
    switch (sel.type) {
      case "note": {
        if (b.encoding === "absolute") {
          const v = msg.type === "noteon" ? msg.data2 / 127 : 0;
          return b.invert ? 1 - v : v;
        }
        return msg.type === "noteon" ? 1 : 0;
      }
      case "cc": {
        if (isRelative(b.encoding)) {
          const d = decodeRelative(b.encoding, msg.data2) * (b.scale ?? 1);
          return b.invert ? -d : d;
        }
        if (b.encoding === "button") return msg.data2 > 0 ? 1 : 0;
        const v = msg.data2 / 127;
        return b.invert ? 1 - v : v;
      }
      case "cc14": {
        const k = `${sel.channel}:${sel.msb}`;
        if (msg.data1 === sel.msb) {
          this.msb.set(k, msg.data2);
          return null; // wait for the LSB, which completes the value
        }
        const full = ((this.msb.get(k) ?? 0) << 7) | msg.data2;
        const v = full / 16383;
        return b.invert ? 1 - v : v;
      }
      case "pitchbend": {
        const v = ((msg.data2 << 7) | msg.data1) / 16383;
        return b.invert ? 1 - v : v;
      }
    }
  }

  /** Push LED state to the device, sending only changes unless `force`. */
  refreshOutputs(force = false): void {
    for (const o of this.mapping.outputs) {
      const v = this.feedback(o.feedback) > 0.5 ? o.on : o.off;
      const k = outputKey(o);
      if (!force && this.lastOut.get(k) === v) continue;
      this.lastOut.set(k, v);
      this.sendOutput(o, v);
    }
  }

  /** Turn every mapped LED off (on shutdown). */
  clearOutputs(): void {
    for (const o of this.mapping.outputs) this.sendOutput(o, o.off);
    this.lastOut.clear();
  }

  private sendOutput(o: OutputBinding, value: number): void {
    const status = (o.midi.type === "note" ? 0x90 : 0xb0) | ((o.midi.channel - 1) & 0x0f);
    this.send([status, o.midi.number & 0x7f, value & 0x7f]);
  }
}

function outputKey(o: OutputBinding): string {
  return `${o.midi.type}:${o.midi.channel}:${o.midi.number}`;
}

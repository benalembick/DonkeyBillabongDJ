/**
 * The single DMX state for the whole app: Universe → Channel → Value (0–255).
 *
 * Every control source writes into its own *layer* (desk, sound-to-light, Art-Net
 * input; later scenes, chases, MIDI, Auto DJ lighting). The output of a universe
 * is the HTP (highest-takes-precedence) merge of all layers, then the grand
 * master is applied to intensity channels, then blackout. Layers are never
 * modified by master/blackout, so releasing blackout restores the exact state.
 *
 * No UI or hardware code lives here: the desk and virtual console read/write
 * layers, output providers read computed frames.
 */
import { Emitter } from "../core/events";
import { DMX_SLOTS } from "./protocol";

export type LayerId = string;
export const LAYER_DESK = "desk";
export const LAYER_SOUND = "sound";
export const LAYER_INPUT = "input";

export class DmxEngine extends Emitter<{ change: void }> {
  private universes = new Set<number>([1]);
  /** layer → universe → 512 values (index 0 = channel 1). */
  private layers = new Map<LayerId, Map<number, Uint8Array>>();
  /** universe → 1 where the grand master applies (light output channels). */
  private masterMask = new Map<number, Uint8Array>();
  private master = 1;
  private blackout = false;
  /** Bumped on every change: cheap "did anything change" check for UIs and outputs. */
  version = 0;

  // ─────────────── universes ───────────────

  getUniverses(): number[] {
    return [...this.universes].sort((a, b) => a - b);
  }

  addUniverse(u: number): void {
    if (!Number.isInteger(u) || u < 1 || u > 32767 || this.universes.has(u)) return;
    this.universes.add(u);
    this.touch();
  }

  removeUniverse(u: number): void {
    if (!this.universes.delete(u)) return;
    for (const l of this.layers.values()) l.delete(u);
    this.masterMask.delete(u);
    this.touch();
  }

  // ─────────────── layers ───────────────

  private buf(layer: LayerId, u: number): Uint8Array {
    let l = this.layers.get(layer);
    if (!l) this.layers.set(layer, (l = new Map()));
    let b = l.get(u);
    if (!b) l.set(u, (b = new Uint8Array(DMX_SLOTS)));
    return b;
  }

  /** Channel is 1-based (1..512); value clamped to 0..255. */
  setChannel(layer: LayerId, u: number, channel: number, value: number): void {
    if (!this.universes.has(u) || channel < 1 || channel > DMX_SLOTS) return;
    const v = Math.max(0, Math.min(255, Math.round(value)));
    const b = this.buf(layer, u);
    if (b[channel - 1] === v) return;
    b[channel - 1] = v;
    this.touch();
  }

  /** Several channels at once (one change notification). */
  setChannels(layer: LayerId, u: number, values: Iterable<[channel: number, value: number]>): void {
    if (!this.universes.has(u)) return;
    const b = this.buf(layer, u);
    let changed = false;
    for (const [c, value] of values) {
      if (c < 1 || c > DMX_SLOTS) continue;
      const v = Math.max(0, Math.min(255, Math.round(value)));
      if (b[c - 1] !== v) {
        b[c - 1] = v;
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  /** Replace a whole layer for a universe (e.g. sound-to-light writes its frame). */
  writeLayer(layer: LayerId, u: number, frame: Uint8Array): void {
    if (!this.universes.has(u)) return;
    const b = this.buf(layer, u);
    let changed = false;
    for (let i = 0; i < DMX_SLOTS; i++) {
      const v = frame[i] ?? 0;
      if (b[i] !== v) {
        b[i] = v;
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  getLayerValue(layer: LayerId, u: number, channel: number): number {
    return this.layers.get(layer)?.get(u)?.[channel - 1] ?? 0;
  }

  getLayer(layer: LayerId, u: number): Uint8Array {
    return this.buf(layer, u);
  }

  clearLayer(layer: LayerId, u?: number): void {
    const l = this.layers.get(layer);
    if (!l) return;
    for (const [uu, b] of l) if (u === undefined || uu === u) b.fill(0);
    this.touch();
  }

  // ─────────────── master / blackout ───────────────

  /** Which channels of a universe the grand master scales (1 = light output). Unpatched channels count as intensity. */
  setMasterMask(u: number, mask: Uint8Array): void {
    this.masterMask.set(u, mask);
    this.touch();
  }

  getMaster(): number {
    return this.master;
  }

  setMaster(v: number): void {
    const m = Math.max(0, Math.min(1, v));
    if (m === this.master) return;
    this.master = m;
    this.touch();
  }

  isBlackout(): boolean {
    return this.blackout;
  }

  setBlackout(on: boolean): void {
    if (on === this.blackout) return;
    this.blackout = on;
    this.touch();
  }

  // ─────────────── output ───────────────

  /** Final values sent to the fixtures for a universe (index 0 = channel 1). */
  compute(u: number, out: Uint8Array = new Uint8Array(DMX_SLOTS)): Uint8Array {
    out.fill(0);
    if (this.blackout || !this.universes.has(u)) return out;
    for (const l of this.layers.values()) {
      const b = l.get(u);
      if (!b) continue;
      for (let i = 0; i < DMX_SLOTS; i++) if (b[i] > out[i]) out[i] = b[i];
    }
    if (this.master < 1) {
      const mask = this.masterMask.get(u);
      for (let i = 0; i < DMX_SLOTS; i++) if (!mask || mask[i]) out[i] = Math.round(out[i] * this.master);
    }
    return out;
  }

  private touch(): void {
    this.version++;
    this.emit("change", undefined);
  }
}

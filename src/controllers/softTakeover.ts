/**
 * Soft takeover ("pickup") for absolute hardware controls — faders, knobs, the tempo slider.
 *
 * A physical control and the software value it drives can disagree: after a deck-layer switch (the
 * fader still sits where deck A left it, deck C is elsewhere), after something else moved the value
 * (mouse, Auto DJ, Transition Lab, a restored mashup) or after the controller reconnects. Applying the
 * hardware value then would jump the volume, EQ or pitch. Instead the control is "waiting for pickup":
 * hardware moves are ignored until the control comes within `tolerance` of the software value or moves
 * across it (crossing detection), then it takes over seamlessly.
 *
 * Optional "relative" mode: while waiting, hardware moves change the software value proportionally to
 * the travel left in that direction (so both meet at the end stop), instead of doing nothing.
 *
 * Only absolute controls go through here: relative encoders (jog, browse) and buttons never do.
 * Pure logic (no MIDI, no engine): the caller reads software values through `read` and dispatches.
 */
import { Emitter } from "../core/events";

export type PickupMode = "pickup" | "relative" | "off";

export interface TakeoverSettings {
  mode: PickupMode;
  /** How close (0..1 of travel) the control must come to the software value to take over. */
  tolerance: number;
}

export const DEFAULT_TAKEOVER: TakeoverSettings = { mode: "pickup", tolerance: 0.03 };

/** A move bigger than this between two consecutive messages isn't trusted as a real crossing (glitch / jump). */
export const MAX_CROSSING_JUMP = 0.5;
/** Software changes smaller than this are rounding, not someone else moving the value. */
const DRIFT_EPSILON = 0.002;

/** A control currently waiting for pickup, for on-screen guidance. */
export interface Pickup {
  /** Engine action the control drives now, e.g. "mixer.channel3.volume". */
  target: string;
  /** Where the hardware control physically is (0..1). */
  hardware: number;
  /** The software value it has to reach, when last checked. */
  software: number;
  /** +1: move the control up/right to pick up; -1: down/left. */
  direction: 1 | -1;
  at: number;
}

interface TargetState {
  engaged: boolean;
  /** The software value right after this control last set it (detects changes from elsewhere). */
  expected: number | null;
}

/** Proportional move toward the end stop: software and hardware meet when the control reaches 0 or 1. */
export function relativeScale(software: number, prevHardware: number, hardware: number): number {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  if (hardware > prevHardware) return prevHardware >= 1 ? software : c(software + ((hardware - prevHardware) * (1 - software)) / (1 - prevHardware));
  if (hardware < prevHardware) return prevHardware <= 0 ? software : c(software - ((prevHardware - hardware) * software) / prevHardware);
  return software;
}

export class SoftTakeover extends Emitter<{ change: Pickup[] }> {
  private targets = new Map<string, TargetState>();
  /** Last value seen from each physical control (key: port + control id) — the position doesn't depend on the layer. */
  private physical = new Map<string, number>();
  private pending = new Map<string, Pickup>();
  private settings: TakeoverSettings;
  private snapshot: Pickup[] = [];

  constructor(private readonly read: (target: string) => number | null, settings: Partial<TakeoverSettings> = {}) {
    super();
    this.settings = { ...DEFAULT_TAKEOVER, ...settings };
  }

  getSettings(): TakeoverSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<TakeoverSettings>): void {
    this.settings = { ...this.settings, ...patch, tolerance: Math.max(0.005, Math.min(0.2, patch.tolerance ?? this.settings.tolerance)) };
    if (this.settings.mode === "off") this.clearPending();
  }

  /**
   * First connection: the hardware is trusted to drive these targets from where the software is now
   * (the controller's first move applies, as without takeover). A change from elsewhere before that
   * first move still requires pickup.
   */
  prime(targets: Iterable<string>): void {
    for (const t of targets) if (!this.targets.has(t)) this.targets.set(t, { engaged: true, expected: this.read(t) });
  }

  /** These targets wait for pickup (deck layer switched to/from them). Untracked targets already do. */
  requirePickup(match: (target: string) => boolean): void {
    for (const [t, s] of this.targets) if (match(t)) s.engaged = false;
    // Guidance for a control that has just moved to another deck would point at the wrong value.
    let dropped = false;
    for (const t of [...this.pending.keys()]) if (match(t)) dropped = this.pending.delete(t) || dropped;
    if (dropped) this.publish();
  }

  /** Controller reconnected: every control waits for pickup, and its old physical positions are forgotten. */
  reset(physicalPrefix?: string): void {
    for (const s of this.targets.values()) s.engaged = false;
    if (physicalPrefix === undefined) this.physical.clear();
    else for (const k of [...this.physical.keys()]) if (k.startsWith(physicalPrefix)) this.physical.delete(k);
    this.clearPending();
  }

  isEngaged(target: string): boolean {
    return this.targets.get(target)?.engaged ?? false;
  }

  getPickups(): Pickup[] {
    return this.snapshot;
  }

  /**
   * A hardware move of an absolute control. Returns the value to dispatch to `target`, or null to ignore
   * the move (waiting for pickup). Call `commit(target)` after dispatching.
   */
  process(target: string, physicalKey: string, hardware: number, now = Date.now()): number | null {
    const prev = this.physical.get(physicalKey);
    this.physical.set(physicalKey, hardware);
    const software = this.read(target);
    if (software === null || this.settings.mode === "off") {
      this.resolvePending(target);
      return hardware;
    }
    let s = this.targets.get(target);
    if (!s) this.targets.set(target, (s = { engaged: false, expected: null }));
    // Someone else (mouse, automation, another controller) moved the value since this control last set it.
    if (s.engaged && s.expected !== null && Math.abs(software - s.expected) > DRIFT_EPSILON) s.engaged = false;
    if (!s.engaged) {
      const near = Math.abs(hardware - software) <= this.settings.tolerance;
      const crossed = prev !== undefined && Math.abs(hardware - prev) <= MAX_CROSSING_JUMP && (prev - software) * (hardware - software) <= 0;
      if (near || crossed) s.engaged = true;
      else if (this.settings.mode === "relative" && prev !== undefined && prev !== hardware) {
        this.markPending(target, hardware, software, now);
        return relativeScale(software, prev, hardware);
      } else {
        this.markPending(target, hardware, software, now);
        return null;
      }
    }
    this.resolvePending(target);
    return hardware;
  }

  /** After dispatching: remember the value the engine settled on (it may differ, e.g. the tempo centre detent). */
  commit(target: string): void {
    const s = this.targets.get(target);
    if (s) s.expected = this.read(target);
  }

  private markPending(target: string, hardware: number, software: number, at: number): void {
    const prev = this.pending.get(target);
    const direction: 1 | -1 = software >= hardware ? 1 : -1;
    if (prev && Math.abs(prev.hardware - hardware) < 0.004 && prev.direction === direction && Math.abs(prev.software - software) < 0.004) return;
    this.pending.set(target, { target, hardware, software, direction, at });
    this.publish();
  }

  private resolvePending(target: string): void {
    if (this.pending.delete(target)) this.publish();
  }

  private clearPending(): void {
    if (!this.pending.size) return;
    this.pending.clear();
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.pending.values()];
    this.emit("change", this.snapshot);
  }
}

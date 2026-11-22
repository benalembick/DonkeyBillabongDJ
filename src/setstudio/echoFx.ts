/**
 * Echo Out through the existing FX unit (no separate effect): the deck's FX unit is switched to a
 * single Echo slot on that deck for the echo window, and the unit's previous state is restored
 * exactly afterwards (types, on/off, level, beats, target, deck assignment).
 */
import type { FxUnitState } from "../core/engine/DJEngine";

interface FxEngine { getState(): { fx: FxUnitState[] }; setFxUnit(u: number, patch: Partial<FxUnitState>): void }

export class EchoFx {
  private saved: { u: number; state: FxUnitState } | null = null;
  constructor(private engine: FxEngine) {}
  static available(engine: FxEngine): boolean { return engine.getState().fx.length > 0; }
  /** level > 0: echo on `deck` at that wet level; 0: restore. Idempotent per tick. */
  set(deck: number, level: number): void {
    const fx = this.engine.getState().fx;
    if (!fx.length) return;
    if (level <= 0) { this.restore(); return; }
    const u = Math.min(deck, fx.length - 1);
    if (!this.saved) this.saved = { u, state: structuredClone(fx[u]) };
    const cur = fx[u];
    const slots = cur.slots.map((s, k) => ({ ...s, type: k === 0 ? ("echo" as const) : s.type, on: k === 0 }));
    const decks = cur.decks.map((_, d) => d === deck);
    if (cur.mix !== level || !cur.slots[0].on || cur.slots[0].type !== "echo" || cur.slots.some((s, k) => k > 0 && s.on) || cur.decks.some((on, d) => on !== (d === deck)) || cur.target !== "deck")
      this.engine.setFxUnit(u, { slots, decks, mix: level, target: "deck", beats: cur.beats || 0.75 });
  }
  restore(): void {
    if (!this.saved) return;
    this.engine.setFxUnit(this.saved.u, this.saved.state);
    this.saved = null;
  }
  get active(): boolean { return !!this.saved; }
}

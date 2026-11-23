/**
 * Controller deck layers: a two-channel controller (DDJ-SB) drives four decks by switching each
 * side between two decks — left = deck A or C, right = deck B or D — independently.
 *
 * Mappings keep describing the hardware: the left side's controls are bound to deck1 / mixer.channel1
 * actions, the right side's to deck2 / mixer.channel2. This router rewrites those "physical" actions to
 * the deck the side currently controls, and does the reverse for LED feedback keys, so LEDs always show
 * the selected deck. Global actions (crossfader, browse, FX units, sampler…) are never rewritten.
 *
 * In two-deck mode layers are fixed at A/B and nothing is rewritten. Hot cue pad banks (the DDJ-SB's
 * pad modes / SHIFT) are untouched: they are separate MIDI notes, so layer and bank are independent.
 */
import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { InputBinding } from "./mapping/schema";

export type ControllerSide = "left" | "right";
export const CONTROLLER_SIDES: readonly ControllerSide[] = ["left", "right"];
/** Deck indices each side can control: [principal, alternate]. */
export const SIDE_DECKS: Record<ControllerSide, readonly [number, number]> = { left: [0, 2], right: [1, 3] };

export interface LayerSettings {
  /** In 4-deck mode, the mapping's layer button (DDJ-SB: SHIFT + KEY LOCK, printed TEMPO RANGE) switches decks. */
  layerButton: boolean;
  /** When a hardware layer changes, the deck it now controls is highlighted and a collapsed (micro) deck opens. */
  followHardwareLayer: boolean;
  /** Clicking/focusing a deck on screen also moves that side of the controller to it (off by default). */
  hardwareFollowsFocus: boolean;
}

export const DEFAULT_LAYER_SETTINGS: LayerSettings = { layerButton: true, followHardwareLayer: true, hardwareFollowsFocus: false };

export interface LayerState {
  /** Four-deck mode: layers can move off A/B. */
  enabled: boolean;
  left: number;
  right: number;
  /** Bumped on every change (for UI flash / "just switched" highlights). */
  seq: number;
  /** Which side changed last, if any. */
  changed: ControllerSide | null;
}

const PHYSICAL_SIDE: Record<string, ControllerSide> = { "1": "left", "2": "right" };

/**
 * Bus actions for layer selection (controller buttons, keyboard, UI): controller.layer.<side>.toggle and
 * controller.layer.<side>.deck<N>. A toggle outside four-deck mode does nothing (`onDisabled` explains why).
 */
export function registerLayerActions(bus: CommandBus, layers: DeckLayers, onDisabled?: () => void): void {
  const pressed = (fn: () => void) => (v: number) => {
    if (v > 0) fn();
  };
  for (const side of CONTROLLER_SIDES) {
    bus.handle(`controller.layer.${side}.toggle`, pressed(() => {
      if (!layers.getState().enabled) onDisabled?.();
      else layers.toggle(side);
    }));
    for (const d of SIDE_DECKS[side]) bus.handle(`controller.layer.${side}.deck${d + 1}`, pressed(() => layers.set(side, d)));
  }
}

export class DeckLayers extends Emitter<{ change: LayerState }> {
  private state: LayerState = { enabled: false, left: 0, right: 1, seq: 0, changed: null };
  private settings: LayerSettings;

  constructor(settings: Partial<LayerSettings> = {}) {
    super();
    this.settings = { ...DEFAULT_LAYER_SETTINGS, ...settings };
  }

  getState(): LayerState {
    return this.state;
  }

  getSettings(): LayerSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<LayerSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.publish(null);
  }

  /** Four-deck mode on/off. Leaving it puts both sides back on decks A/B. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.state.enabled) return;
    const back = !enabled && (this.state.left !== 0 || this.state.right !== 1);
    this.state = { ...this.state, enabled, ...(enabled ? null : { left: 0, right: 1 }) };
    this.publish(back ? "left" : null);
  }

  /** Point one side at a deck. Returns false if that side can't control it (or four-deck mode is off). */
  set(side: ControllerSide, deck: number): boolean {
    if (!SIDE_DECKS[side].includes(deck)) return false;
    if (!this.state.enabled && deck !== SIDE_DECKS[side][0]) return false;
    if (this.state[side] === deck) return true;
    this.state = { ...this.state, [side]: deck };
    this.publish(side);
    return true;
  }

  toggle(side: ControllerSide): boolean {
    const [a, b] = SIDE_DECKS[side];
    return this.set(side, this.state[side] === a ? b : a);
  }

  deckFor(side: ControllerSide): number {
    return this.state[side];
  }

  /** The side that can control a deck (A/C left, B/D right). */
  static sideOf(deck: number): ControllerSide {
    return deck % 2 === 0 ? "left" : "right";
  }

  /** Which side currently controls this deck, or null when neither does. */
  controllingSide(deck: number): ControllerSide | null {
    if (this.state.left === deck) return "left";
    if (this.state.right === deck) return "right";
    return null;
  }

  /** The action a binding stands for right now: its `fourDeckAction` when the layer button applies. */
  resolve(binding: Pick<InputBinding, "action" | "fourDeckAction">): string {
    const raw = this.state.enabled && this.settings.layerButton && binding.fourDeckAction ? binding.fourDeckAction : binding.action;
    return this.route(raw);
  }

  /** Physical (mapping) action → the deck action it controls now, e.g. "deck1.play" → "deck3.play". */
  route(action: string): string {
    if (!this.state.enabled) return action;
    const m = /^(deck|mixer\.channel|browser\.load\.deck)([12])(\..*)?$/.exec(action);
    if (!m) return action;
    const deck = this.state[PHYSICAL_SIDE[m[2]]];
    return `${m[1]}${deck + 1}${m[3] ?? ""}`;
  }

  /** LED feedback key on the hardware → the engine key for the deck that side controls. */
  routeFeedback(key: string): string {
    return this.route(key);
  }

  /** Feedback for layer indicators: "controller.layer.left.alt" = 1 while the left side is on deck C. */
  feedback(key: string): number | null {
    const m = /^controller\.layer\.(left|right)\.alt$/.exec(key);
    if (!m) return null;
    const side = m[1] as ControllerSide;
    return this.state.enabled && this.state[side] === SIDE_DECKS[side][1] ? 1 : 0;
  }

  private publish(changed: ControllerSide | null): void {
    this.state = { ...this.state, seq: this.state.seq + 1, changed };
    this.emit("change", this.state);
  }
}

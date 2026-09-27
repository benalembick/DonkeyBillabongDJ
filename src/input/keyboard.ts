/**
 * Configurable keyboard shortcuts → CommandBus. The app stays usable without a controller.
 * Bindings are data (exportable/editable), never hard-coded handlers.
 */
import type { CommandBus } from "../core/commands";

export interface KeyBinding {
  /** KeyboardEvent.code, e.g. "Space", "KeyC", "Digit1", "ArrowLeft". */
  code: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  action: string;
  /** Value sent on key down (default 1). For relative actions, the tick delta. */
  value?: number;
  /** Send value 0 on key up (momentary buttons such as CUE). Default true. */
  release?: boolean;
  /** Allow OS key-repeat (useful for relative actions). Default false. */
  repeat?: boolean;
}

export const DEFAULT_KEYMAP: KeyBinding[] = [
  { code: "Space", action: "deck1.play" },
  { code: "Space", shift: true, action: "deck2.play" },
  { code: "KeyC", action: "deck1.cue" },
  { code: "KeyM", action: "deck2.cue" },
  { code: "Digit1", action: "deck1.hotcue.1" },
  { code: "Digit2", action: "deck1.hotcue.2" },
  { code: "Digit3", action: "deck1.hotcue.3" },
  { code: "Digit4", action: "deck1.hotcue.4" },
  { code: "Digit7", action: "deck2.hotcue.1" },
  { code: "Digit8", action: "deck2.hotcue.2" },
  { code: "Digit9", action: "deck2.hotcue.3" },
  { code: "Digit0", action: "deck2.hotcue.4" },
  { code: "KeyA", action: "deck1.jog.ring", value: -8, release: false, repeat: true },
  { code: "KeyD", action: "deck1.jog.ring", value: 8, release: false, repeat: true },
  { code: "KeyJ", action: "deck2.jog.ring", value: -8, release: false, repeat: true },
  { code: "KeyL", action: "deck2.jog.ring", value: 8, release: false, repeat: true },
  { code: "ArrowUp", action: "browser.scroll", value: -1, release: false, repeat: true },
  { code: "ArrowDown", action: "browser.scroll", value: 1, release: false, repeat: true },
  { code: "ArrowLeft", shift: true, action: "browser.load.deck1" },
  { code: "ArrowRight", shift: true, action: "browser.load.deck2" },
];

function matches(b: KeyBinding, e: KeyboardEvent): boolean {
  return b.code === e.code && !!b.shift === e.shiftKey && !!b.ctrl === (e.ctrlKey || e.metaKey) && !!b.alt === e.altKey;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (target.isContentEditable) return true;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "button";
  }
  return false;
}

export class KeyboardShortcuts {
  private held = new Map<string, KeyBinding>();
  private keymap: KeyBinding[];
  private readonly bus: CommandBus;

  constructor(bus: CommandBus, keymap: KeyBinding[] = DEFAULT_KEYMAP) {
    this.bus = bus;
    this.keymap = keymap;
  }

  setKeymap(keymap: KeyBinding[]): void {
    this.keymap = keymap;
  }

  getKeymap(): KeyBinding[] {
    return this.keymap;
  }

  attach(target: Window): () => void {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const b = this.keymap.find((k) => matches(k, e));
      if (!b) return;
      e.preventDefault();
      if (e.repeat && !b.repeat) return;
      this.held.set(e.code, b);
      this.bus.dispatch({ action: b.action, value: b.value ?? 1, source: "keyboard" });
    };
    const up = (e: KeyboardEvent) => {
      const b = this.held.get(e.code);
      if (!b) return;
      this.held.delete(e.code);
      if (b.release !== false) this.bus.dispatch({ action: b.action, value: 0, source: "keyboard" });
    };
    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    return () => {
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
    };
  }
}

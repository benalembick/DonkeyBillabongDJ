/**
 * Four-deck workspace preferences: 2 DECK / 4 DECK mode, the density of decks C/D, waveform lanes,
 * mixer channel order and the focused deck. Presentation only — switching never touches the engine:
 * playback, loaded tracks, positions, EQ/volume, beat grids, hot cues and loops are untouched, and
 * nothing resumes playback on restart. Persisted in localStorage (no database migration needed).
 * See docs/architecture/four-deck-performance-engine.md §5–§6.
 */
import { Emitter } from "../core/events";

export type DeckMode = 2 | 4;
export type DeckDensity = "full" | "compact" | "micro";
/** Mixer strip order in 4-deck mode (deck numbers). "3-1-2-4" follows the controller sides (C A | B D). */
export type MixerOrder = "3-1-2-4" | "1-2-3-4";

export interface WorkspacePrefs {
  deckMode: DeckMode;
  /** Density of the secondary decks C (index 2) and D (index 3). Decks A/B follow the deck view. */
  density: [DeckDensity, DeckDensity];
  /** Waveform lanes the user collapsed, per deck. */
  laneCollapsed: [boolean, boolean, boolean, boolean];
  mixerOrder: MixerOrder;
  /** Keyboard focus: the target of "Load to focused deck" and deck shortcuts. */
  focusedDeck: number;
  version: 1;
}

export const WORKSPACE_KEY = "dbdj.workspace.v1";

export const DEFAULT_WORKSPACE: WorkspacePrefs = {
  deckMode: 2,
  density: ["compact", "compact"],
  laneCollapsed: [false, false, false, false],
  mixerOrder: "3-1-2-4",
  focusedDeck: 0,
  version: 1,
};

const DENSITIES: DeckDensity[] = ["full", "compact", "micro"];

/** Saved (possibly partial, older or hand-edited) prefs → valid prefs. */
export function migrateWorkspace(raw: unknown): WorkspacePrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof WorkspacePrefs, unknown>>;
  const density = Array.isArray(r.density) ? r.density : [];
  const lanes = Array.isArray(r.laneCollapsed) ? r.laneCollapsed : [];
  return {
    deckMode: r.deckMode === 4 ? 4 : 2,
    density: [0, 1].map((i) => (DENSITIES.includes(density[i] as DeckDensity) ? density[i] : DEFAULT_WORKSPACE.density[i])) as [DeckDensity, DeckDensity],
    laneCollapsed: [0, 1, 2, 3].map((i) => lanes[i] === true) as [boolean, boolean, boolean, boolean],
    mixerOrder: r.mixerOrder === "1-2-3-4" ? "1-2-3-4" : "3-1-2-4",
    focusedDeck: typeof r.focusedDeck === "number" && r.focusedDeck >= 0 && r.focusedDeck <= 3 ? Math.floor(r.focusedDeck) : 0,
    version: 1,
  };
}

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class WorkspaceStore extends Emitter<{ change: WorkspacePrefs }> {
  private prefs: WorkspacePrefs;

  constructor(private readonly storage: WorkspaceStorage | null = safeLocalStorage()) {
    super();
    let raw: unknown = null;
    try {
      raw = JSON.parse(storage?.getItem(WORKSPACE_KEY) ?? "null");
    } catch {
      raw = null;
    }
    this.prefs = migrateWorkspace(raw);
  }

  get(): WorkspacePrefs {
    return this.prefs;
  }

  set(patch: Partial<WorkspacePrefs>): void {
    const next = migrateWorkspace({ ...this.prefs, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.prefs)) return;
    this.prefs = next;
    try {
      this.storage?.setItem(WORKSPACE_KEY, JSON.stringify(next));
    } catch {
      /* best effort */
    }
    this.emit("change", next);
  }

  setDeckMode(deckMode: DeckMode): void {
    // The focused deck stays where it is; in 2-deck mode a hidden C/D focus falls back to its side's A/B.
    const focusedDeck = deckMode === 2 && this.prefs.focusedDeck > 1 ? this.prefs.focusedDeck - 2 : this.prefs.focusedDeck;
    this.set({ deckMode, focusedDeck });
  }

  toggleDeckMode(): void {
    this.setDeckMode(this.prefs.deckMode === 4 ? 2 : 4);
  }

  /** Density of deck C (2) or D (3). */
  setDensity(deck: number, density: DeckDensity): void {
    if (deck !== 2 && deck !== 3) return;
    const d = this.prefs.density.slice() as [DeckDensity, DeckDensity];
    d[deck - 2] = density;
    this.set({ density: d });
  }

  densityOf(deck: number): DeckDensity {
    return deck === 2 || deck === 3 ? this.prefs.density[deck - 2] : "full";
  }

  setLaneCollapsed(deck: number, collapsed: boolean): void {
    if (deck < 0 || deck > 3) return;
    const l = this.prefs.laneCollapsed.slice() as WorkspacePrefs["laneCollapsed"];
    l[deck] = collapsed;
    this.set({ laneCollapsed: l });
  }

  focus(deck: number): void {
    if (deck < 0 || deck > 3 || (this.prefs.deckMode === 2 && deck > 1)) return;
    this.set({ focusedDeck: deck });
  }
}

/** Decks shown as full members of the workspace (2 DECK: A, B; 4 DECK: A–D). */
export function workspaceDecks(prefs: Pick<WorkspacePrefs, "deckMode">): number[] {
  return prefs.deckMode === 4 ? [0, 1, 2, 3] : [0, 1];
}

/** Mixer strips left → right, around the master section (which sits between the two halves). */
export function mixerLayout(prefs: Pick<WorkspacePrefs, "deckMode" | "mixerOrder">): { left: number[]; right: number[] } {
  if (prefs.deckMode === 2) return { left: [0], right: [1] };
  return prefs.mixerOrder === "1-2-3-4" ? { left: [0, 1], right: [2, 3] } : { left: [2, 0], right: [1, 3] };
}

function safeLocalStorage(): WorkspaceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

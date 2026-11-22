/**
 * Which deck's Beat grid editor is open (one at a time), plus "Fix grid…": the one action every grid
 * warning in the app links to (Transition Lab, Auto DJ, Transition Guides, Auto Cue, DJ Training,
 * the track menu). It brings the decks into view, makes sure the track is on a deck, and opens the editor.
 */
import { useSyncExternalStore } from "react";
import type { App } from "../app/createApp";

let openDeck: number | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function openGridEditor(deck: number): void {
  // The decks may be hidden (expanded library, AI Set Studio, Lighting, Production Studio).
  window.dispatchEvent(new CustomEvent("dbdj:show-decks"));
  openDeck = deck; notify();
}
export function closeGridEditor(): void { if (openDeck !== null) { openDeck = null; notify(); } }
export function toggleGridEditor(deck: number): void { if (openDeck === deck) closeGridEditor(); else openGridEditor(deck); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getGridEditorDeck = () => openDeck;
export function useGridEditorDeck(): number | null { return useSyncExternalStore(subscribe, getGridEditorDeck, getGridEditorDeck); }

/**
 * Open the grid editor for a library track: on the deck that already has it, else load it onto a free
 * deck (empty first, then one that isn't playing). Never loads over a playing deck or while Auto DJ is
 * using the decks — it says so instead. Returns the deck, or null.
 */
export function fixGridFor(app: Pick<App, "engine" | "library" | "log" | "autoDJ">, ref: string): number | null {
  const decks = app.engine.getState().decks;
  const loaded = decks.find((d) => d.track?.ref === ref && (d.status === "ready" || d.status === "loading"));
  if (loaded) { openGridEditor(loaded.index); return loaded.index; }
  const track = app.library.getByRef(ref);
  if (!track) { app.log.warn("engine", "That track isn't in the library, so its beat grid can't be edited here."); return null; }
  if (app.autoDJ.getState().status !== "OFF") { app.log.warn("engine", `Auto DJ is using the decks — stop Auto DJ (or wait until "${track.title}" is loaded) to edit its beat grid.`); return null; }
  const free = decks.find((d) => d.status === "empty") ?? decks.find((d) => !d.playing);
  if (!free) { app.log.warn("engine", `Both decks are playing — pause one to edit the beat grid of "${track.title}".`); return null; }
  void app.engine.loadTrack(free.index, track);
  openGridEditor(free.index);
  return free.index;
}

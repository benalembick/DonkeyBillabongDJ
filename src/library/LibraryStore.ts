/**
 * Library engine (Phase 1: in-memory track list with a browse cursor).
 * Phase 3 replaces the storage with SQLite + tag reading behind the same API.
 */
import { Emitter } from "../core/events";
import type { BrowserPort } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import type { AudioFileRef } from "../platform";

export interface LibraryState {
  tracks: TrackInfo[];
  selected: number;
}

/** "Artist - Title.mp3" → { artist, title } (until real tag reading lands in Phase 3). */
export function trackInfoFromFileName(ref: string, fileName: string): TrackInfo {
  const base = fileName.replace(/\.[^.]+$/, "");
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(base);
  return {
    ref,
    title: m ? m[2].trim() : base,
    artist: m ? m[1].trim() : "",
    album: "",
    source: "local",
    bpm: null,
    key: null,
  };
}

export class LibraryStore extends Emitter<{ change: LibraryState }> implements BrowserPort {
  private state: LibraryState = { tracks: [], selected: -1 };

  getState(): LibraryState {
    return this.state;
  }

  /** Adds new files; returns the tracks that were actually added (duplicates skipped). */
  addFiles(files: AudioFileRef[]): TrackInfo[] {
    const existing = new Set(this.state.tracks.map((t) => t.ref));
    const added = files.filter((f) => !existing.has(f.ref)).map((f) => trackInfoFromFileName(f.ref, f.name));
    if (added.length === 0) return [];
    const tracks = [...this.state.tracks, ...added];
    this.set({ tracks, selected: this.state.selected < 0 ? 0 : this.state.selected });
    return added;
  }

  /** Replace the library with persisted tracks (startup). */
  hydrate(tracks: TrackInfo[]): void {
    this.set({ tracks, selected: tracks.length ? 0 : -1 });
  }

  /** Update tracks in place (e.g. after reading tags). */
  patchTracks(updated: TrackInfo[]): void {
    if (updated.length === 0) return;
    const byRef = new Map(updated.map((t) => [t.ref, t]));
    this.set({ ...this.state, tracks: this.state.tracks.map((t) => byRef.get(t.ref) ?? t) });
  }

  getByRef(ref: string): TrackInfo | null {
    return this.state.tracks.find((t) => t.ref === ref) ?? null;
  }

  select(index: number): void {
    if (this.state.tracks.length === 0) return;
    this.set({ ...this.state, selected: Math.max(0, Math.min(this.state.tracks.length - 1, index)) });
  }

  moveSelection(delta: number): void {
    this.select((this.state.selected < 0 ? 0 : this.state.selected) + delta);
  }

  getSelected(): TrackInfo | null {
    return this.state.tracks[this.state.selected] ?? null;
  }

  private set(s: LibraryState): void {
    this.state = s;
    this.emit("change", s);
  }
}

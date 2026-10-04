/**
 * Playlists: named, ordered lists of library tracks (by ref). The single
 * source of truth for the playlist UI and Auto DJ. Persisted through the
 * platform (SQLite on desktop, localStorage in the browser); saves are
 * serialized so overlapping saves and deletion cannot resurrect stale data.
 */
import { Emitter } from "../core/events";
import type { TrackInfo } from "../core/engine/types";
import type { PlaylistPersistence, PlaylistRow } from "../platform";

export interface Playlist {
  id: string;
  name: string;
  refs: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistState {
  playlists: Playlist[];
  loaded: boolean;
}

export class PlaylistStore extends Emitter<{ change: PlaylistState }> {
  private state: PlaylistState = { playlists: [], loaded: false };
  private writing: Promise<void> = Promise.resolve();
  private readonly persist: PlaylistPersistence | null;
  private readonly onError: (err: unknown) => void;

  constructor(persist: PlaylistPersistence | null, onError: (err: unknown) => void = () => undefined) {
    super();
    this.persist = persist;
    this.onError = onError;
  }

  async load(): Promise<void> {
    if (!this.persist) {
      this.set({ loaded: true });
      return;
    }
    try {
      const rows = await this.persist.load();
      this.set({ playlists: rows.map(fromRow), loaded: true });
    } catch (err) {
      this.onError(err);
      this.set({ loaded: true });
    }
  }

  getState(): PlaylistState {
    return this.state;
  }

  get(id: string): Playlist | undefined {
    return this.state.playlists.find((p) => p.id === id);
  }

  duplicate(id: string): Playlist | undefined {
    const p = this.get(id);
    return p ? this.create(`${p.name} copy`, p.refs) : undefined;
  }

  replaceTracks(id: string, refs: string[]): void {
    this.update(id, (p) => ({ ...p, refs: dedupe(refs) }));
  }

  /**
   * Replace the list keeping intentional repeats (Spotify-linked playlists mirror the source
   * order, where a track may appear twice). No-op when nothing changed.
   */
  setOrderedRefs(id: string, refs: string[]): void {
    const p = this.get(id);
    if (!p || (p.refs.length === refs.length && p.refs.every((r, i) => r === refs[i]))) return;
    this.update(id, (x) => ({ ...x, refs: [...refs] }));
  }

  create(name: string, refs: string[] = []): Playlist {
    const now = Date.now();
    const p: Playlist = { id: newId(), name: uniqueName(name.trim() || "New Playlist", this.state.playlists), refs: dedupe(refs), createdAt: now, updatedAt: now };
    this.set({ playlists: [...this.state.playlists, p] });
    this.save(p.id, true);
    return p;
  }

  rename(id: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.update(id, (p) => ({ ...p, name: n }));
  }

  async remove(id: string): Promise<void> {
    this.set({ playlists: this.state.playlists.filter((p) => p.id !== id) });
    this.writing = this.writing.then(() => this.persist?.remove(id)).catch(this.onError);
    await this.writing;
  }

  /** Add tracks (duplicates within a playlist are skipped). Inserts at \`index\`, default the end. */
  addTracks(id: string, refs: string[], index?: number): number {
    let added = 0;
    this.update(id, (p) => {
      const fresh = dedupe(refs).filter((r) => !p.refs.includes(r));
      added = fresh.length;
      const at = index === undefined ? p.refs.length : Math.max(0, Math.min(p.refs.length, index));
      return { ...p, refs: [...p.refs.slice(0, at), ...fresh, ...p.refs.slice(at)] };
    });
    return added;
  }

  removeAt(id: string, indices: number[]): void {
    const drop = new Set(indices);
    this.update(id, (p) => ({ ...p, refs: p.refs.filter((_, i) => !drop.has(i)) }));
  }

  /** Move one entry (drag to reorder). \`to\` is the index in the list before removal. */
  move(id: string, from: number, to: number): void {
    this.update(id, (p) => ({ ...p, refs: moveItem(p.refs, from, to) }));
  }

  /** Remove a track from every playlist (e.g. it was deleted from the library). */
  forgetTrack(ref: string): void {
    for (const p of this.state.playlists) if (p.refs.includes(ref)) this.update(p.id, (x) => ({ ...x, refs: x.refs.filter((r) => r !== ref) }));
  }

  /** Number of tracks and total duration of a playlist (tracks without a known duration count as 0). */
  static summary(p: Playlist, lookup: (ref: string) => TrackInfo | undefined): { count: number; durationMs: number; missing: number } {
    let durationMs = 0;
    let missing = 0;
    for (const r of p.refs) {
      const t = lookup(r);
      if (!t) missing++;
      else durationMs += t.durationMs ?? 0;
    }
    return { count: p.refs.length, durationMs, missing };
  }

  /** Write pending changes now (e.g. before the window closes). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private update(id: string, fn: (p: Playlist) => Playlist): void {
    const i = this.state.playlists.findIndex((p) => p.id === id);
    if (i < 0) return;
    const playlists = this.state.playlists.slice();
    playlists[i] = { ...fn(playlists[i]), updatedAt: Date.now() };
    this.set({ playlists });
    this.save(id);
  }

  private save(id: string, _now = false): void {
    const p = this.get(id);
    if (!p || !this.persist) return;
    const row = toRow(p);
    this.writing = this.writing.then(() => this.persist!.save(row)).catch(this.onError);
  }

  private set(patch: Partial<PlaylistState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || from === to) return list.slice();
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to > from ? to - 1 : to)), 0, x);
  return out;
}

function dedupe(refs: string[]): string[] {
  return [...new Set(refs)];
}

function uniqueName(name: string, existing: Playlist[]): string {
  const names = new Set(existing.map((p) => p.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

function newId(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const fromRow = (r: PlaylistRow): Playlist => ({ id: r.id, name: r.name, refs: r.refs, createdAt: r.created_at, updatedAt: r.updated_at });
const toRow = (p: Playlist): PlaylistRow => ({ id: p.id, name: p.name, refs: p.refs, created_at: p.createdAt, updated_at: p.updatedAt });

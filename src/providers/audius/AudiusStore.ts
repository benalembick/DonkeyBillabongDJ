/**
 * Audius browser state (search / trending / artist / playlist views) and the
 * browse cursor used by the controller's browse encoder + LOAD buttons.
 * Network failures stay inside this store; they never touch the decks.
 */
import { Emitter } from "../../core/events";
import type { BrowserPort } from "../../core/engine/DJEngine";
import type { TrackInfo } from "../../core/engine/types";
import type { EventLog } from "../../core/log";
import type { AudiusClient, AudiusPlaylist, AudiusTrack, AudiusUser } from "./AudiusClient";
import { audiusToTrackInfo } from "./audiusTracks";

export type AudiusTab = "tracks" | "artists" | "playlists";

export interface AudiusState {
  connection: "unknown" | "testing" | "ok" | "error";
  connectionError?: string;
  tab: AudiusTab;
  query: string;
  /** What the track list shows, e.g. "Trending", "Search: daft punk", "Artist: …". */
  context: string;
  tracks: AudiusTrack[];
  users: AudiusUser[];
  playlists: AudiusPlaylist[];
  selected: number;
  loading: boolean;
  error?: string;
}

export class AudiusStore extends Emitter<{ change: AudiusState }> implements BrowserPort {
  private state: AudiusState = { connection: "unknown", tab: "tracks", query: "", context: "", tracks: [], users: [], playlists: [], selected: -1, loading: false };
  private token = 0;
  readonly client: AudiusClient;
  private readonly log: EventLog;

  constructor(client: AudiusClient, log: EventLog) {
    super();
    this.client = client;
    this.log = log;
  }

  getState(): AudiusState {
    return this.state;
  }

  private set(p: Partial<AudiusState>): void {
    this.state = { ...this.state, ...p };
    this.emit("change", this.state);
  }

  async testConnection(): Promise<boolean> {
    this.set({ connection: "testing", connectionError: undefined });
    const r = await this.client.testConnection();
    this.set({ connection: r.ok ? "ok" : "error", connectionError: r.error });
    if (r.ok) this.log.info("audius", `Audius API reachable (${r.latencyMs} ms)`);
    else this.log.warn("audius", `Audius API unreachable: ${r.error}`);
    return r.ok;
  }

  /** Run a request for the current view; stale responses (user moved on) are dropped. */
  private async run<T>(context: string, fn: () => Promise<T>, apply: (v: T) => Partial<AudiusState>): Promise<void> {
    const token = ++this.token;
    this.set({ loading: true, error: undefined, context });
    try {
      const v = await fn();
      if (token !== this.token) return;
      this.set({ ...apply(v), loading: false, connection: "ok" });
    } catch (err) {
      if (token !== this.token) return;
      const message = err instanceof Error ? err.message : String(err);
      this.set({ loading: false, error: message });
      this.log.warn("audius", message);
    }
  }

  setTab(tab: AudiusTab): void {
    this.set({ tab });
    if (this.state.query) void this.search(this.state.query);
  }

  loadTrending(): Promise<void> {
    return this.run("Trending on Audius", () => this.client.trending(undefined, 40), (tracks) => ({ tracks, selected: tracks.length ? 0 : -1, tab: "tracks" as const }));
  }

  search(query: string): Promise<void> {
    const q = query.trim();
    this.set({ query: q });
    if (!q) return this.loadTrending();
    switch (this.state.tab) {
      case "artists":
        return this.run(`Artists: ${q}`, () => this.client.searchUsers(q), (users) => ({ users }));
      case "playlists":
        return this.run(`Playlists: ${q}`, () => this.client.searchPlaylists(q), (playlists) => ({ playlists }));
      default:
        return this.run(`Search: ${q}`, () => this.client.searchTracks(q, 30), (tracks) => ({ tracks, selected: tracks.length ? 0 : -1 }));
    }
  }

  openArtist(u: AudiusUser): Promise<void> {
    return this.run(`Artist: ${u.name}`, () => this.client.userTracks(u.id), (tracks) => ({ tracks, selected: tracks.length ? 0 : -1, tab: "tracks" as const }));
  }

  openPlaylist(p: AudiusPlaylist): Promise<void> {
    return this.run(`${p.isAlbum ? "Album" : "Playlist"}: ${p.name}`, () => this.client.playlistTracks(p.id), (tracks) => ({ tracks, selected: tracks.length ? 0 : -1, tab: "tracks" as const }));
  }

  select(i: number): void {
    if (!this.state.tracks.length) return;
    this.set({ selected: Math.max(0, Math.min(this.state.tracks.length - 1, i)) });
  }

  // BrowserPort (controller browse encoder + LOAD A/B)
  moveSelection(delta: number): void {
    this.select((this.state.selected < 0 ? 0 : this.state.selected) + delta);
  }

  getSelected(): TrackInfo | null {
    const t = this.state.tracks[this.state.selected];
    return t ? audiusToTrackInfo(t) : null;
  }
}

/** Routes the controller's browse/load actions to whichever list is on screen. */
export class BrowserRouter implements BrowserPort {
  private active: BrowserPort;
  constructor(initial: BrowserPort) {
    this.active = initial;
  }
  setActive(port: BrowserPort): void {
    this.active = port;
  }
  moveSelection(delta: number): void {
    this.active.moveSelection(delta);
  }
  getSelected(): TrackInfo | null {
    return this.active.getSelected();
  }
}

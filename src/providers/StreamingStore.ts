/**
 * Renderer-side state for streaming providers (status, playlists, current
 * track list). All network work happens in the main process; failures stay
 * inside this store and never affect decks.
 */
import { Emitter } from "../core/events";
import type { EventLog } from "../core/log";
import type { TrackInfo } from "../core/engine/types";
import type { StreamingBridge } from "../platform";
import type { ProviderStatus, StreamingConfig, StreamingPlaylist, StreamingProviderId, StreamingTrack } from "./streamingTypes";

export const PROVIDER_NAMES: Record<StreamingProviderId, string> = { spotify: "Spotify", "apple-music": "Apple Music" };

export interface ProviderView {
  status: ProviderStatus | null;
  playlists: StreamingPlaylist[];
  /** Selected playlist id, or "search". */
  selected: string | null;
  tracks: StreamingTrack[];
  loading: boolean;
  busy: boolean;
  error?: string;
}

const emptyView = (): ProviderView => ({ status: null, playlists: [], selected: null, tracks: [], loading: false, busy: false });

export function toTrackInfo(t: StreamingTrack): TrackInfo {
  return {
    ref: `${t.provider}:${t.id}`,
    title: t.title,
    artist: t.artist,
    album: t.album,
    source: t.provider,
    bpm: null,
    key: null,
    durationMs: t.durationMs,
    artworkUrl: t.artworkUrl,
    externalUrl: t.externalUrl,
    isrc: t.isrc ?? null,
  };
}

export class StreamingStore extends Emitter<{ change: Record<StreamingProviderId, ProviderView> }> {
  private state: Record<StreamingProviderId, ProviderView> = { spotify: emptyView(), "apple-music": emptyView() };
  private readonly bridge: StreamingBridge | null;
  private readonly log: EventLog;

  constructor(bridge: StreamingBridge | null, log: EventLog) {
    super();
    this.bridge = bridge;
    this.log = log;
  }

  get available(): boolean {
    return !!this.bridge;
  }

  getState(): Record<StreamingProviderId, ProviderView> {
    return this.state;
  }

  private patch(id: StreamingProviderId, p: Partial<ProviderView>): void {
    this.state = { ...this.state, [id]: { ...this.state[id], ...p } };
    this.emit("change", this.state);
  }

  /** Run a main-process call, keeping errors inside the provider view. */
  private async run<T>(id: StreamingProviderId, fn: (b: StreamingBridge) => Promise<T>, flag: "loading" | "busy" = "loading"): Promise<T | null> {
    if (!this.bridge) return null;
    this.patch(id, { [flag]: true, error: undefined });
    try {
      return await fn(this.bridge);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      this.patch(id, { error: message });
      this.log.warn("streaming", `${PROVIDER_NAMES[id]}: ${message}`);
      return null;
    } finally {
      this.patch(id, { [flag]: false });
    }
  }

  async refresh(id: StreamingProviderId): Promise<void> {
    const status = await this.run(id, (b) => b.status(id));
    if (!status) return;
    this.patch(id, { status });
    if (status.connected && this.state[id].playlists.length === 0) await this.loadPlaylists(id);
  }

  async configure(id: StreamingProviderId, cfg: StreamingConfig): Promise<boolean> {
    const status = await this.run(id, (b) => b.configure(id, cfg), "busy");
    if (status) this.patch(id, { status });
    return !!status;
  }

  async connect(id: StreamingProviderId): Promise<void> {
    const status = await this.run(id, (b) => b.connect(id), "busy");
    if (!status) return;
    this.patch(id, { status });
    this.log.info("streaming", `${PROVIDER_NAMES[id]} connected${status.account ? ` as ${status.account}` : ""}`);
    await this.loadPlaylists(id);
  }

  async disconnect(id: StreamingProviderId, forget = false): Promise<void> {
    const status = await this.run(id, (b) => b.disconnect(id, forget), "busy");
    if (status) this.patch(id, { ...emptyView(), status });
  }

  async loadPlaylists(id: StreamingProviderId): Promise<void> {
    const playlists = await this.run(id, (b) => b.playlists(id));
    if (playlists) this.patch(id, { playlists });
  }

  async openPlaylist(id: StreamingProviderId, playlistId: string): Promise<void> {
    this.patch(id, { selected: playlistId, tracks: [] });
    const tracks = await this.run(id, (b) => b.playlistTracks(id, playlistId));
    if (tracks && this.state[id].selected === playlistId) this.patch(id, { tracks });
  }

  async search(id: StreamingProviderId, q: string): Promise<void> {
    this.patch(id, { selected: "search", tracks: [] });
    const tracks = await this.run(id, (b) => b.search(id, q));
    if (tracks && this.state[id].selected === "search") this.patch(id, { tracks });
  }
}

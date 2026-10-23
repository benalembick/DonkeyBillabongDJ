import { Emitter } from "../core/events";
import type { StreamingTrack } from "../providers/streamingTypes";

export type SpotifyAcquisitionAvailability = "local-library" | "authorized-download" | "playback-only" | "authorized-recording";
export type SpotifySessionEntryState = "preparing" | "recording" | "finalizing" | "completed" | "interrupted" | "failed" | "cancelled";

export interface SpotifyPlaybackDevice { id: string; name: string; local: boolean; active: boolean }
export interface SpotifyPlaybackState { connected: boolean; mode: "external" | "web-playback"; device: SpotifyPlaybackDevice | null; playingTrackId: string | null }

/**
 * Official-playback boundary. The default adapter intentionally opens Spotify instead of
 * exposing protected audio to the DJ engine. A Web Playback implementation can replace it
 * without changing the recording contract.
 */
export class SpotifyPlaybackAdapter extends Emitter<{ change: SpotifyPlaybackState }> {
  private state: SpotifyPlaybackState = { connected: false, mode: "external", device: null, playingTrackId: null };
  constructor(private readonly openExternal: (url: string) => Promise<void>) { super(); }
  getState(): SpotifyPlaybackState { return { ...this.state, device: this.state.device ? { ...this.state.device } : null }; }
  setConnected(connected: boolean): void { this.state = { ...this.state, connected }; this.emit("change", this.getState()); }
  selectDevice(device: SpotifyPlaybackDevice | null): void { this.state = { ...this.state, device }; this.emit("change", this.getState()); }
  async openTrack(track: Pick<StreamingTrack, "id" | "externalUrl">): Promise<void> {
    const url = track.externalUrl ?? `https://open.spotify.com/track/${encodeURIComponent(track.id)}`;
    if (!/^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}(?:[?#].*)?$/.test(url)) throw new Error("Invalid Spotify track link.");
    await this.openExternal(url);
    this.state = { ...this.state, playingTrackId: track.id };
    this.emit("change", this.getState());
  }
}

export interface RecordingCapability {
  providerAuthorized: boolean;
  processCaptureAvailable: boolean;
  silentRouting: boolean;
  reason?: string;
}

/** Separate policy/capability gate: playback success can never enable recording. */
export class RecordingSourceAdapter {
  constructor(private capability: RecordingCapability) {}
  getCapability(): RecordingCapability { return { ...this.capability }; }
  updateCapability(capability: RecordingCapability): void { this.capability = { ...capability }; }
  assertReady(device: SpotifyPlaybackDevice | null): void {
    if (!this.capability.providerAuthorized) throw new Error(this.capability.reason ?? "No Spotify provider agreement authorizes recording.");
    if (!this.capability.processCaptureAvailable) throw new Error(this.capability.reason ?? "Application-isolated recording is unavailable.");
    if (device && !device.local) throw new Error(`“${device.name}” is a remote Spotify device; its audio is not available to this computer's capture backend.`);
  }
}

export interface SpotifySessionEntry {
  id: string;
  position: number;
  spotifyTrackId: string;
  title: string;
  artist: string;
  expectedDurationMs: number;
  availability: SpotifyAcquisitionAvailability;
  method: "local" | "download" | "record" | "unresolved";
  metadataRevision: number;
  state: SpotifySessionEntryState;
  resultRef: string | null;
  error: string | null;
}

export interface SpotifySession {
  id: string;
  playlistName: string;
  destinationPlaylistId: string;
  createdAt: number;
  entries: SpotifySessionEntry[];
}

export interface SpotifySessionStore { load(): SpotifySession[]; save(sessions: SpotifySession[]): void }

export class SpotifySessionCoordinator extends Emitter<{ change: SpotifySession[] }> {
  private sessions: SpotifySession[];
  constructor(public readonly playback: SpotifyPlaybackAdapter, public readonly recording: RecordingSourceAdapter, private readonly store: SpotifySessionStore) {
    super(); this.sessions = store.load();
  }
  list(): SpotifySession[] { return structuredClone(this.sessions); }
  create(playlistName: string, destinationPlaylistId: string, tracks: StreamingTrack[], availability: (track: StreamingTrack) => SpotifyAcquisitionAvailability): SpotifySession {
    const id = `spotify_session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const entries = tracks.map((t, position): SpotifySessionEntry => {
      const a = availability(t), method = a === "local-library" ? "local" : a === "authorized-download" ? "download" : a === "authorized-recording" ? "record" : "unresolved";
      return { id: `${id}_${position}`, position, spotifyTrackId: t.id, title: t.title, artist: t.artist, expectedDurationMs: t.durationMs, availability: a, method, metadataRevision: 1, state: "preparing", resultRef: null, error: null };
    });
    const session = { id, playlistName, destinationPlaylistId, createdAt: Date.now(), entries };
    this.sessions = [...this.sessions, session]; this.commit(); return structuredClone(session);
  }
  prepareRecording(sessionId: string, entryId: string): SpotifySessionEntry {
    this.recording.assertReady(this.playback.getState().device);
    return this.update(sessionId, entryId, (e) => {
      if (e.availability !== "authorized-recording") throw new Error("This track is not eligible for an authorized recording session.");
      if (e.resultRef) return { ...e, state: "completed" };
      return { ...e, state: "recording", error: null };
    });
  }
  complete(sessionId: string, entryId: string, resultRef: string): SpotifySessionEntry {
    if (!resultRef) throw new Error("A verified local asset reference is required.");
    return this.update(sessionId, entryId, (e) => ({ ...e, state: "completed", resultRef, error: null }));
  }
  fail(sessionId: string, entryId: string, error: string, interrupted = false): SpotifySessionEntry {
    return this.update(sessionId, entryId, (e) => ({ ...e, state: interrupted ? "interrupted" : "failed", error }));
  }
  retry(sessionId: string, entryId: string): SpotifySessionEntry {
    return this.update(sessionId, entryId, (e) => e.resultRef ? e : { ...e, state: "preparing", error: null });
  }
  private update(sessionId: string, entryId: string, fn: (e: SpotifySessionEntry) => SpotifySessionEntry): SpotifySessionEntry {
    let result: SpotifySessionEntry | null = null;
    this.sessions = this.sessions.map((s) => s.id !== sessionId ? s : { ...s, entries: s.entries.map((e) => e.id !== entryId ? e : (result = fn(e))) });
    if (!result) throw new Error("Spotify session entry not found.");
    this.commit(); return structuredClone(result);
  }
  private commit(): void { this.store.save(this.sessions); this.emit("change", this.list()); }
}

export function browserSpotifySessionStore(storage: Pick<Storage, "getItem" | "setItem">, key = "dbdj.spotifySessions.v1"): SpotifySessionStore {
  return {
    load: () => { try { const value = JSON.parse(storage.getItem(key) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; } },
    save: (sessions) => storage.setItem(key, JSON.stringify(sessions)),
  };
}

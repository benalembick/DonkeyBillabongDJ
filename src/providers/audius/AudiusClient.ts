/**
 * Audius API client (official REST API, https://api.audius.co/v1).
 *
 * - No API key or secret needed; requests identify the app with `app_name`.
 * - Free tier: 10 requests/s, 500k/month. We throttle to 5 req/s, retry with
 *   backoff on 429/5xx, de-duplicate in-flight requests and cache metadata.
 * - Audio: /v1/tracks/{id}/stream redirects to a content node serving the full
 *   MP3 with CORS and HTTP Range support. We download it into memory (with
 *   Range-resume on network errors) for the DJ engine; nothing is written to disk.
 *
 * Runs in the renderer (desktop and browser) — no credentials are involved.
 */
import { Emitter } from "../../core/events";

export const AUDIUS_API = "https://api.audius.co";
export const AUDIUS_APP_NAME = (import.meta.env?.VITE_AUDIUS_APP_NAME as string | undefined) || "DonkeyBillabongDJ";

export interface AudiusTrack {
  id: string;
  title: string;
  artist: string;
  artistHandle: string;
  artistId: string;
  album: string;
  durationMs: number;
  genre: string;
  mood: string;
  bpm: number | null;
  key: string | null;
  isrc: string | null;
  artworkUrl?: string;
  permalink: string;
  license: string;
  releaseDate?: string;
  playCount: number;
  /** Cover of another song (never treated as the original recording). */
  coverOf?: { title: string; artist: string };
  remixOf: boolean;
  /** Stream is open to API apps (not gated / premium / opted out). */
  streamable: boolean;
  unavailableReason?: string;
}

export interface AudiusUser {
  id: string;
  name: string;
  handle: string;
  trackCount: number;
  followerCount: number;
  avatarUrl?: string;
}

export interface AudiusPlaylist {
  id: string;
  name: string;
  owner: string;
  trackCount: number;
  isAlbum: boolean;
  artworkUrl?: string;
}

export interface AudiusStats {
  requests: number;
  errors: number;
  retries: number;
  cacheHits: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  lastError?: string;
  lastOkAt?: number;
  host: string;
  /** "unknown" until the first successful request. */
  apiStatus: "unknown" | "ok" | "error";
  lastStream?: { trackId: string; ttfbMs: number; totalMs: number; bytes: number; retries: number };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const RATE_PER_SEC = 5;
const CACHE_TTL_MS = 10 * 60_000;

export class AudiusClient extends Emitter<{ stats: AudiusStats }> {
  private queue: (() => void)[] = [];
  private stamps: number[] = [];
  private pumping = false;
  private inflight = new Map<string, Promise<Json>>();
  private cache = new Map<string, { at: number; value: Json }>();
  private latencies: number[] = [];
  readonly stats: AudiusStats = { requests: 0, errors: 0, retries: 0, cacheHits: 0, lastLatencyMs: null, avgLatencyMs: null, host: AUDIUS_API, apiStatus: "unknown" };
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    super();
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  // ─────────────── low-level ───────────────

  /** Token-bucket style throttle: at most RATE_PER_SEC requests start per rolling second. */
  private slot(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const step = () => {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 1000);
      while (this.queue.length && this.stamps.length < RATE_PER_SEC) {
        this.stamps.push(now);
        this.queue.shift()!();
      }
      if (this.queue.length) setTimeout(step, 1000 - (now - this.stamps[0]) + 5);
      else this.pumping = false;
    };
    step();
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(AUDIUS_API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    u.searchParams.set("app_name", AUDIUS_APP_NAME);
    return u.toString();
  }

  /** GET JSON with throttling, retry/backoff, de-duplication and a TTL cache. */
  async get(path: string, params: Record<string, string | number | undefined> = {}, opts: { cache?: boolean } = {}): Promise<Json> {
    const url = this.url(path, params);
    const cached = this.cache.get(url);
    if (opts.cache !== false && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      this.stats.cacheHits++;
      return cached.value;
    }
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const p = this.fetchWithRetry(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    const value = await p;
    this.cache.set(url, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private async fetchWithRetry(url: string, attempt = 0): Promise<Json> {
    await this.slot();
    const t0 = performance.now();
    this.stats.requests++;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          this.stats.retries++;
          const retryAfter = Number(res.headers.get("retry-after")) * 1000;
          await sleep(retryAfter > 0 ? retryAfter : 500 * 2 ** attempt);
          return this.fetchWithRetry(url, attempt + 1);
        }
        throw new Error(res.status === 429 ? "Audius rate limit reached — try again shortly." : `Audius API error ${res.status}`);
      }
      if (!res.ok) throw new Error(`Audius API error ${res.status}`);
      const body = await res.json();
      this.recordOk(performance.now() - t0);
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && /network|fetch|timed? ?out|abort/i.test(message)) {
        this.stats.retries++;
        await sleep(600 * 2 ** attempt);
        return this.fetchWithRetry(url, attempt + 1);
      }
      this.stats.errors++;
      this.stats.lastError = message;
      this.stats.apiStatus = "error";
      this.emit("stats", this.stats);
      throw new Error(/fetch|network/i.test(message) ? "Can't reach Audius (network)." : message);
    }
  }

  private recordOk(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 50) this.latencies.shift();
    this.stats.lastLatencyMs = Math.round(ms);
    this.stats.avgLatencyMs = Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length);
    this.stats.apiStatus = "ok";
    this.stats.lastOkAt = Date.now();
    this.emit("stats", this.stats);
  }

  // ─────────────── API ───────────────

  /** Health check used by Settings "Test connection" and provider availability. */
  async testConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const t0 = performance.now();
    try {
      await this.get("/v1/tracks/trending", { limit: 1 }, { cache: false });
      return { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async searchTracks(query: string, limit = 20): Promise<AudiusTrack[]> {
    if (!query.trim()) return [];
    const r = await this.get("/v1/tracks/search", { query: query.trim(), limit });
    return (r.data ?? []).map(mapTrack);
  }

  async trending(genre?: string, limit = 30): Promise<AudiusTrack[]> {
    const r = await this.get("/v1/tracks/trending", { genre, limit });
    return (r.data ?? []).map(mapTrack);
  }

  async searchUsers(query: string, limit = 20): Promise<AudiusUser[]> {
    if (!query.trim()) return [];
    const r = await this.get("/v1/users/search", { query: query.trim(), limit });
    return (r.data ?? []).map(mapUser);
  }

  async searchPlaylists(query: string, limit = 20): Promise<AudiusPlaylist[]> {
    if (!query.trim()) return [];
    const r = await this.get("/v1/playlists/search", { query: query.trim(), limit });
    return (r.data ?? []).map(mapPlaylist);
  }

  async getTrack(id: string): Promise<AudiusTrack | null> {
    try {
      const r = await this.get(`/v1/tracks/${encodeURIComponent(id)}`);
      return r.data ? mapTrack(r.data) : null;
    } catch (err) {
      if (/404/.test(String(err))) return null;
      throw err;
    }
  }

  async userTracks(userId: string, limit = 50): Promise<AudiusTrack[]> {
    const r = await this.get(`/v1/users/${encodeURIComponent(userId)}/tracks`, { limit });
    return (r.data ?? []).map(mapTrack);
  }

  async playlistTracks(playlistId: string): Promise<AudiusTrack[]> {
    const r = await this.get(`/v1/playlists/${encodeURIComponent(playlistId)}/tracks`);
    return (r.data ?? []).map(mapTrack);
  }

  streamUrl(trackId: string): string {
    return this.url(`/v1/tracks/${encodeURIComponent(trackId)}/stream`);
  }

  /**
   * Download a track's audio into memory for the DJ engine, reporting progress.
   * On a dropped connection it resumes with an HTTP Range request (up to 5 retries).
   */
  async downloadAudio(
    trackId: string,
    onProgress?: (p: { fraction: number | null; message?: string }) => void,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const url = this.streamUrl(trackId);
    const t0 = performance.now();
    let ttfb = 0;
    const chunks: Uint8Array[] = [];
    let received = 0;
    let total: number | null = null;
    let retries = 0;
    for (;;) {
      try {
        await this.slot();
        this.stats.requests++;
        const headers: Record<string, string> = received > 0 ? { Range: `bytes=${received}-` } : {};
        const res = await this.fetchImpl(url, { headers, signal });
        if (res.status === 429 || res.status === 408 || res.status >= 500) throw new Error(`Audius stream error ${res.status}`);
        // Other client errors (bad id, removed, gated, opted out) won't fix themselves: fail at once.
        if (!res.ok) throw new PermanentError(res.status === 400 || res.status === 403 || res.status === 404 ? "This track is not available for streaming via the Audius API." : `Audius stream error ${res.status}`);
        if (received > 0 && res.status !== 206) {
          // Server ignored the Range header: start again from scratch.
          chunks.length = 0;
          received = 0;
        }
        if (!ttfb) ttfb = performance.now() - t0;
        const len = Number(res.headers.get("content-length"));
        if (total == null) total = len > 0 ? received + len : null;
        const reader = res.body?.getReader();
        if (!reader) {
          const buf = new Uint8Array(await res.arrayBuffer());
          chunks.push(buf);
          received += buf.length;
        } else {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress?.({ fraction: total ? received / total : null });
          }
        }
        if (total != null && received < total) throw new Error("Connection closed early");
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof PermanentError || retries >= 5) {
          this.stats.errors++;
          this.stats.lastError = message;
          this.emit("stats", this.stats);
          throw new Error(retries >= 5 ? `Audius connection interrupted: ${message}` : message);
        }
        retries++;
        this.stats.retries++;
        onProgress?.({ fraction: total ? received / total : null, message: `Audius connection interrupted — retrying (${retries}/5)…` });
        await sleep(Math.min(8000, 700 * 2 ** (retries - 1)));
      }
    }
    const out = new Uint8Array(received);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.stats.lastStream = { trackId, ttfbMs: Math.round(ttfb), totalMs: Math.round(performance.now() - t0), bytes: received, retries };
    this.recordOk(ttfb);
    return out.buffer;
  }
}

class PermanentError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function mapTrack(t: Json): AudiusTrack {
  const gated = !!t.is_stream_gated || (t.stream_conditions != null && Object.keys(t.stream_conditions).length > 0);
  const streamable = t.is_streamable !== false && t.access?.stream !== false && !gated && t.is_available !== false && !t.is_delete;
  return {
    id: String(t.id),
    title: String(t.title ?? ""),
    artist: String(t.user?.name ?? ""),
    artistHandle: String(t.user?.handle ?? ""),
    artistId: String(t.user?.id ?? t.user_id ?? ""),
    album: String(t.album_backlink?.playlist_name ?? ""),
    durationMs: Math.round(Number(t.duration ?? 0) * 1000),
    genre: String(t.genre ?? ""),
    mood: String(t.mood ?? ""),
    bpm: typeof t.bpm === "number" && t.bpm > 0 ? Math.round(t.bpm * 10) / 10 : null,
    key: t.musical_key ? String(t.musical_key) : null,
    isrc: t.isrc ? String(t.isrc) : null,
    artworkUrl: t.artwork?.["150x150"],
    permalink: t.permalink ? `https://audius.co${t.permalink}` : "",
    license: String(t.license ?? ""),
    releaseDate: t.release_date ?? undefined,
    playCount: Number(t.play_count ?? 0),
    coverOf: t.cover_original_song_title ? { title: String(t.cover_original_song_title), artist: String(t.cover_original_artist ?? "") } : undefined,
    remixOf: !!t.remix_of?.tracks?.length,
    streamable,
    unavailableReason: streamable ? undefined : gated ? "Gated (premium / follow / purchase) — not streamable via the API" : "Not available for API streaming",
  };
}

function mapUser(u: Json): AudiusUser {
  return {
    id: String(u.id),
    name: String(u.name ?? ""),
    handle: String(u.handle ?? ""),
    trackCount: Number(u.track_count ?? 0),
    followerCount: Number(u.follower_count ?? 0),
    avatarUrl: u.profile_picture?.["150x150"],
  };
}

function mapPlaylist(p: Json): AudiusPlaylist {
  return {
    id: String(p.id),
    name: String(p.playlist_name ?? ""),
    owner: String(p.user?.name ?? ""),
    trackCount: Number(p.track_count ?? p.total_play_count ?? 0),
    isAlbum: !!p.is_album,
    artworkUrl: p.artwork?.["150x150"],
  };
}

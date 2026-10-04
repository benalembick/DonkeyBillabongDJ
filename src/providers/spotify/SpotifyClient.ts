/**
 * Spotify Web API client shared by the desktop app (main process) and browser
 * mode. Only storage and the sign-in hop differ, and they are injected:
 *  - desktop: OS-keychain storage + loopback redirect in the system browser
 *  - browser: localStorage + a popup that redirects back to this web app
 *
 * Auth: Authorization Code + PKCE (no client secret). Read-only scopes; no
 * audio is ever requested (Spotify's terms prohibit mixing its content).
 * Endpoints follow the February 2026 Development Mode changes.
 */
import type { ProviderStatus, SpotifyConfig, StreamingPlaylist, StreamingTrack } from "../streamingTypes";
import type { JobSource, SourceTrack, SpotifySourceResult } from "../../acquire/types";
import { b64url, fetchJson, randomToken, sha256, type KeyValueStore } from "../web";

const SCOPES = ["user-read-private", "playlist-read-private", "playlist-read-collaborative", "user-library-read"];
const API = "https://api.spotify.com/v1";
const STORE_KEY = "spotify";
/** Shown only when Spotify actually refuses a playlist's tracks (it depends on the app's access level). */
const RESTRICTED =
  "Spotify didn't return this playlist's tracks to this app. Newer Spotify developer apps can only read playlists the account owns or collaborates on — copy its tracks into one of your playlists in Spotify (select all → Add to playlist → New playlist) and open that copy.";

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
}
interface SpotifyState {
  clientId?: string;
  tokens?: Tokens;
  user?: { id: string; name: string; product?: string };
}

export interface SpotifySignIn {
  redirectUri: string;
  /** Open the authorise URL and resolve with the callback's query parameters. */
  authorize(authUrl: string, state: string): Promise<URLSearchParams>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export class SpotifyClient {
  private state: SpotifyState = {};
  private loaded = false;
  private readonly store: KeyValueStore;
  private readonly signIn: SpotifySignIn;
  private readonly storageNote?: string;

  constructor(store: KeyValueStore, signIn: SpotifySignIn, storageNote?: string) {
    this.store = store;
    this.signIn = signIn;
    this.storageNote = storageNote;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.state = (await this.store.get<SpotifyState>(STORE_KEY)) ?? {};
    this.loaded = true;
  }

  private persist(): Promise<void> {
    return this.store.set(STORE_KEY, this.state);
  }

  async status(): Promise<ProviderStatus> {
    await this.load();
    const u = this.state.user;
    const notPremium = u?.product && u.product !== "premium";
    return {
      provider: "spotify",
      configured: !!this.state.clientId,
      connected: !!this.state.tokens,
      account: u ? `${u.name}${u.product ? ` (${u.product})` : ""}` : undefined,
      detail: notPremium ? "This account is not Premium — Spotify requires Premium for developer-mode apps." : this.storageNote,
      redirectUri: this.signIn.redirectUri,
    };
  }

  async configure(cfg: SpotifyConfig): Promise<void> {
    await this.load();
    const clientId = String(cfg.clientId ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) throw new Error("That doesn't look like a Spotify Client ID (32 hex characters).");
    if (clientId !== this.state.clientId) this.state = { clientId };
    await this.persist();
  }

  async disconnect(forget = false): Promise<void> {
    await this.load();
    this.state = forget ? {} : { clientId: this.state.clientId };
    await this.persist();
  }

  async connect(): Promise<ProviderStatus> {
    await this.load();
    const clientId = this.state.clientId;
    if (!clientId) throw new Error("Enter your Spotify Client ID first.");
    const verifier = randomToken(64);
    const challenge = b64url(await sha256(verifier));
    const oauthState = `dbdj-sp-${randomToken(16)}`;
    const auth = new URL("https://accounts.spotify.com/authorize");
    auth.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: this.signIn.redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state: oauthState,
      scope: SCOPES.join(" "),
    }).toString();

    const params = await this.signIn.authorize(auth.toString(), oauthState);
    const err = params.get("error");
    if (err) throw new Error(err === "access_denied" ? "Spotify sign-in was cancelled." : `Spotify sign-in failed: ${err}`);
    if (params.get("state") !== oauthState) throw new Error("Spotify sign-in failed: state mismatch.");
    const code = params.get("code");
    if (!code) throw new Error("Spotify sign-in failed: no code returned.");

    const tok = await fetchJson<Json>("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.signIn.redirectUri, client_id: clientId, code_verifier: verifier }),
    });
    if (tok.status !== 200) throw new Error(`Spotify token exchange failed: ${tok.body?.error_description ?? tok.status}`);
    this.state.tokens = { access: tok.body.access_token, refresh: tok.body.refresh_token, expiresAt: Date.now() + tok.body.expires_in * 1000 };
    const me = await this.api("/me");
    this.state.user = { id: me.id, name: me.display_name ?? me.id, product: me.product };
    await this.persist();
    return this.status();
  }

  private async refresh(): Promise<void> {
    const t = this.state.tokens;
    if (!t || !this.state.clientId) throw new Error("Spotify is not connected.");
    const r = await fetchJson<Json>("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: this.state.clientId }),
    });
    if (r.status !== 200) {
      this.state.tokens = undefined;
      await this.persist();
      throw new Error("Spotify session expired — please connect again.");
    }
    this.state.tokens = { access: r.body.access_token, refresh: r.body.refresh_token ?? t.refresh, expiresAt: Date.now() + r.body.expires_in * 1000 };
    await this.persist();
  }

  private async api(pathOrUrl: string, retried = false, rateLimited = 0): Promise<Json> {
    await this.load();
    if (!this.state.tokens) throw new Error("Spotify is not connected.");
    if (Date.now() > this.state.tokens.expiresAt - 60_000) await this.refresh();
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    if (!url.startsWith(API + "/")) throw new Error("Unexpected Spotify API URL.");
    const r = await fetchJson<Json>(url, { headers: { Authorization: `Bearer ${this.state.tokens!.access}` } });
    if (r.status === 401 && !retried) {
      await this.refresh();
      return this.api(pathOrUrl, true, rateLimited);
    }
    if (r.status === 429) {
      // Honour Retry-After a couple of times (capped), then give up with the wait time.
      const wait = Number(r.headers.get("retry-after")) || 2;
      if (rateLimited < 2 && wait <= 30) {
        await new Promise((res) => setTimeout(res, wait * 1000));
        return this.api(pathOrUrl, retried, rateLimited + 1);
      }
      throw new Error(`Spotify rate limit — retry in ${wait} s.`);
    }
    if (r.status === 403) throw new Error(r.body?.error?.message ?? "Spotify refused this request (403). Development-mode apps can only use a limited set of endpoints.");
    if (r.status >= 400) throw new Error(r.body?.error?.message ?? `Spotify error ${r.status}`);
    return r.body;
  }

  /** Every playlist in the user's library (owned, followed and shared), all pages. */
  async playlists(): Promise<StreamingPlaylist[]> {
    const out: StreamingPlaylist[] = [{ id: "__liked__", name: "Liked Songs", trackCount: 0, readable: true }];
    let next: string | null = "/me/playlists?limit=50";
    let reported = 0;
    while (next && out.length < 5000) {
      const page: Json = await this.api(next);
      if (typeof page?.total === "number") reported = page.total;
      for (const p of page.items ?? []) {
        if (!p?.id) continue;
        const own = p.owner?.id === this.state.user?.id || p.collaborative;
        out.push({
          id: p.id,
          name: p.name,
          trackCount: p.items?.total ?? p.tracks?.total ?? 0,
          artworkUrl: p.images?.[p.images.length - 1]?.url ?? p.images?.[0]?.url,
          // Spotify (2026 rules, verified: 403) only returns tracks of playlists you own or collaborate on.
          readable: !!own,
          note: own ? undefined : `By ${p.owner?.display_name ?? p.owner?.id ?? "someone else"}`,
        });
      }
      next = page.next;
    }
    // Never silently show "Liked Songs" only when Spotify said there are playlists.
    if (reported > 0 && out.length === 1) throw new Error(`Spotify reported ${reported} playlists but none could be read — press ↻ to try again.`);
    // Viewable playlists first (Spotify's order kept within each group).
    return [...out.filter((p) => p.readable), ...out.filter((p) => !p.readable)];
  }

  private playlistFallback: ((playlistId: string) => Promise<SourceTrack[]>) | null = null;

  /**
   * Desktop: when Spotify won't return a playlist's tracks to this app (playlists by other
   * people, for apps under the 2026 rules), read them another way (spotDL's own Spotify access).
   */
  setPlaylistFallback(fn: ((playlistId: string) => Promise<SourceTrack[]>) | null): void {
    this.playlistFallback = fn;
  }

  /** Items via Spotify, or via the fallback when Spotify refuses this playlist. */
  private async itemsOrFallback(id: string, query: string): Promise<{ items: Json[] } | { tracks: SourceTrack[] }> {
    try {
      return { items: await this.playlistItems(id, query) };
    } catch (e) {
      if (!(e instanceof Error) || e.message !== RESTRICTED || !this.playlistFallback) throw e;
      try {
        return { tracks: await this.playlistFallback(id) };
      } catch (f) {
        throw new Error(`${RESTRICTED} Reading it with spotDL also failed: ${f instanceof Error ? f.message : String(f)}`);
      }
    }
  }

  async playlistTracks(id: string): Promise<StreamingTrack[]> {
    if (id === "__liked__") {
      const out: StreamingTrack[] = [];
      let next: string | null = "/me/tracks?limit=50";
      while (next && out.length < 10_000) {
        const page: Json = await this.api(next);
        for (const entry of page.items ?? []) {
          const t = mapSpotifyTrack(entry?.track ?? entry?.item);
          if (t) out.push(t);
        }
        next = page.next;
      }
      return out;
    }
    const got = await this.itemsOrFallback(id, "limit=50");
    if ("tracks" in got) return got.tracks.filter((t) => t.id).map(sourceToStreaming);
    return got.items.map((entry) => mapSpotifyTrack(entry?.item ?? entry?.track)).filter((t): t is StreamingTrack => !!t);
  }

  /**
   * All raw items of a playlist, every page. Uses /items (2026) and falls back to /tracks for
   * apps that don't have the new endpoint. Throws an explanation only when Spotify actually
   * refuses or returns the playlist without its track list.
   */
  private async playlistItems(id: string, query: string): Promise<Json[]> {
    const base = `/playlists/${encodeURIComponent(id)}`;
    const items: Json[] = [];
    let next: string | null = `${base}/items?${query}`;
    let fellBack = false;
    while (next && items.length < 10_000) {
      let page: Json;
      try {
        page = await this.api(next);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (!fellBack && items.length === 0 && /404|not found|invalid|unknown/i.test(m)) {
          fellBack = true;
          next = `${base}/tracks?${query}`;
          continue;
        }
        if (/403|refused|forbidden/i.test(m)) throw new Error(RESTRICTED);
        throw e;
      }
      if (!Array.isArray(page?.items)) throw new Error(RESTRICTED);
      items.push(...page.items);
      next = page.next ?? null;
    }
    return items;
  }

  /**
   * Spotify → Local: a playlist, Liked Songs or one track as ordered entries, keeping
   * repeats, removed tracks, podcast episodes and Spotify "local file" entries in place.
   * Development Mode only returns playlist items for playlists the user owns or collaborates on.
   */
  async resolveSource(ref: { type: "playlist" | "track" | "liked"; id: string }): Promise<SpotifySourceResult> {
    await this.load();
    if (!this.state.tokens) throw new Error("Spotify isn't connected — open Library → Spotify and connect your account first.");
    if (ref.type === "track") {
      const t: Json = await this.api(`/tracks/${encodeURIComponent(ref.id)}`).catch((e) => {
        throw new Error(/404|not found|invalid/i.test(String(e)) ? "Spotify couldn't find that track." : String(e instanceof Error ? e.message : e));
      });
      const track = toSourceTrack(t);
      return {
        source: { kind: "track", spotifyId: ref.id, name: `${track.artists.join(", ")} – ${track.title}`, owner: null, url: track.url, snapshotId: null },
        entries: [{ kind: "track", track, addedAt: null }],
      };
    }
    const entries: SpotifySourceResult["entries"] = [];
    let next: string | null;
    let source: JobSource;
    if (ref.type === "liked") {
      source = { kind: "liked", spotifyId: "__liked__", name: "Liked Songs", owner: this.state.user?.name ?? null, url: "https://open.spotify.com/collection/tracks", snapshotId: null };
      next = "/me/tracks?limit=50";
    } else {
      let meta: Json;
      try {
        meta = await this.api(`/playlists/${encodeURIComponent(ref.id)}?fields=id,name,owner(id,display_name),snapshot_id,collaborative,external_urls`);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        throw new Error(/not found|404/i.test(m) ? "Spotify couldn't find that playlist — it may be private, deleted, or a Spotify-generated mix this app can't read." : m);
      }
      source = { kind: "playlist", spotifyId: ref.id, name: String(meta.name ?? "Spotify playlist"), owner: meta.owner?.display_name ?? meta.owner?.id ?? null, url: meta.external_urls?.spotify ?? null, snapshotId: meta.snapshot_id ?? null };
      // Ask for the tracks whoever owns it; Spotify decides what this app may read.
      const got = await this.itemsOrFallback(ref.id, "limit=50&market=from_token&additional_types=track,episode");
      if ("tracks" in got) for (const track of got.tracks) entries.push({ kind: track.id ? "track" : "unavailable", track, addedAt: null });
      else for (const entry of got.items) entries.push(mapPlaylistEntry(entry));
      return { source, entries };
    }
    while (next && entries.length < 10_000) {
      const page: Json = await this.api(next);
      for (const entry of page.items ?? []) entries.push(mapPlaylistEntry(entry));
      next = page.next ?? null;
    }
    return { source, entries };
  }

  async search(q: string): Promise<StreamingTrack[]> {
    const term = q.trim();
    if (!term) return [];
    const out: StreamingTrack[] = [];
    // Development-mode search returns at most 10 results per request.
    for (let offset = 0; offset < 30; offset += 10) {
      const r: Json = await this.api(`/search?type=track&limit=10&offset=${offset}&q=${encodeURIComponent(term)}`);
      const items = r.tracks?.items ?? [];
      for (const it of items) {
        const t = mapSpotifyTrack(it);
        if (t) out.push(t);
      }
      if (items.length < 10) break;
    }
    return out;
  }
}

export function mapSpotifyTrack(t: Json): StreamingTrack | null {
  if (!t || (t.type && t.type !== "track") || !t.id) return null;
  const images = t.album?.images ?? [];
  return {
    provider: "spotify",
    id: t.id,
    title: t.name ?? "",
    artist: (t.artists ?? []).map((a: Json) => a.name).join(", "),
    artists: (t.artists ?? []).map((a: Json) => String(a.name)),
    album: t.album?.name ?? "",
    durationMs: t.duration_ms ?? 0,
    releaseDate: t.album?.release_date,
    explicit: t.explicit,
    artworkUrl: images[images.length - 1]?.url ?? images[0]?.url,
    isrc: t.external_ids?.isrc,
    externalUrl: t.external_urls?.spotify,
  };
}

export function sourceToStreaming(t: SourceTrack): StreamingTrack {
  return {
    provider: "spotify",
    id: t.id ?? "",
    title: t.title,
    artist: t.artists.join(", "),
    artists: t.artists,
    album: t.album,
    durationMs: t.durationMs ?? 0,
    explicit: t.explicit ?? undefined,
    isrc: t.isrc ?? undefined,
    externalUrl: t.url ?? undefined,
  };
}

/** Spotify track object → source metadata (missing fields stay null; nothing is guessed). */
export function toSourceTrack(t: Json): SourceTrack {
  const artists = (t?.artists ?? []).map((a: Json) => String(a?.name ?? "")).filter(Boolean);
  return {
    id: typeof t?.id === "string" && t.id ? t.id : null,
    uri: typeof t?.uri === "string" ? t.uri : null,
    title: String(t?.name ?? ""),
    artists,
    album: String(t?.album?.name ?? ""),
    durationMs: typeof t?.duration_ms === "number" && t.duration_ms > 0 ? t.duration_ms : null,
    explicit: typeof t?.explicit === "boolean" ? t.explicit : null,
    isrc: typeof t?.external_ids?.isrc === "string" && t.external_ids.isrc ? t.external_ids.isrc : null,
    url: t?.external_urls?.spotify ?? null,
  };
}

/** One playlist / saved-tracks item → entry kind + metadata. */
export function mapPlaylistEntry(entry: Json): SpotifySourceResult["entries"][number] {
  const item = entry?.item ?? entry?.track ?? null;
  const addedAt = typeof entry?.added_at === "string" ? entry.added_at : null;
  if (!item) return { kind: "unavailable", track: { id: null, uri: null, title: "Removed from Spotify", artists: [], album: "", durationMs: null, explicit: null, isrc: null, url: null }, addedAt };
  if (item.type === "episode") return { kind: "episode", track: { ...toSourceTrack(item), album: String(item.show?.name ?? ""), artists: item.show?.publisher ? [String(item.show.publisher)] : [] }, addedAt };
  if (entry?.is_local || item.is_local) return { kind: "spotify-local-file", track: { ...toSourceTrack(item), id: null }, addedAt };
  const track = toSourceTrack(item);
  return { kind: item.is_playable === false || !track.id ? "unavailable" : "track", track, addedAt };
}

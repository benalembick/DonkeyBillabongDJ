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
import { b64url, fetchJson, randomToken, sha256, type KeyValueStore } from "../web";

const SCOPES = ["user-read-private", "playlist-read-private", "playlist-read-collaborative", "user-library-read"];
const API = "https://api.spotify.com/v1";
const STORE_KEY = "spotify";

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

  private async api(pathOrUrl: string, retried = false): Promise<Json> {
    await this.load();
    if (!this.state.tokens) throw new Error("Spotify is not connected.");
    if (Date.now() > this.state.tokens.expiresAt - 60_000) await this.refresh();
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    const r = await fetchJson<Json>(url, { headers: { Authorization: `Bearer ${this.state.tokens!.access}` } });
    if (r.status === 401 && !retried) {
      await this.refresh();
      return this.api(pathOrUrl, true);
    }
    if (r.status === 429) throw new Error(`Spotify rate limit — retry in ${r.headers.get("retry-after") ?? "a few"} s.`);
    if (r.status === 403) throw new Error(r.body?.error?.message ?? "Spotify refused this request (403). Development-mode apps can only use a limited set of endpoints.");
    if (r.status >= 400) throw new Error(r.body?.error?.message ?? `Spotify error ${r.status}`);
    return r.body;
  }

  async playlists(): Promise<StreamingPlaylist[]> {
    const out: StreamingPlaylist[] = [{ id: "__liked__", name: "Liked Songs", trackCount: 0, readable: true }];
    let next: string | null = "/me/playlists?limit=50";
    while (next && out.length < 300) {
      const page: Json = await this.api(next);
      for (const p of page.items ?? []) {
        if (!p) continue;
        const own = p.owner?.id === this.state.user?.id || p.collaborative;
        out.push({
          id: p.id,
          name: p.name,
          trackCount: p.items?.total ?? p.tracks?.total ?? 0,
          artworkUrl: p.images?.[p.images.length - 1]?.url ?? p.images?.[0]?.url,
          readable: !!own,
          note: own ? undefined : "Spotify only returns tracks of playlists you own or collaborate on.",
        });
      }
      next = page.next;
    }
    return out;
  }

  async playlistTracks(id: string): Promise<StreamingTrack[]> {
    const out: StreamingTrack[] = [];
    let next: string | null = id === "__liked__" ? "/me/tracks?limit=50" : `/playlists/${encodeURIComponent(id)}/items?limit=50`;
    while (next && out.length < 1000) {
      const page: Json = await this.api(next);
      for (const entry of page.items ?? []) {
        const t = mapSpotifyTrack(entry?.item ?? entry?.track);
        if (t) out.push(t);
      }
      next = page.next;
    }
    return out;
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
    album: t.album?.name ?? "",
    durationMs: t.duration_ms ?? 0,
    artworkUrl: images[images.length - 1]?.url ?? images[0]?.url,
    isrc: t.external_ids?.isrc,
    externalUrl: t.external_urls?.spotify,
  };
}

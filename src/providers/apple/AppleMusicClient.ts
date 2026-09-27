/**
 * Apple Music API client shared by the desktop app and browser mode.
 *
 * Needs a MusicKit developer token (Apple Developer Program): pasted, or signed
 * here (ES256 JWT via WebCrypto) from Team ID + Key ID + .p8 key. The user's
 * account is authorised with MusicKit JS (injected `signIn`), which yields a
 * Music User Token. Only metadata is requested: Apple Music audio is
 * DRM-protected and cannot enter a third-party mixer.
 */
import type { AppleMusicConfig, ProviderStatus, StreamingPlaylist, StreamingTrack } from "../streamingTypes";
import { b64url, fetchJson, type KeyValueStore } from "../web";

const API = "https://api.music.apple.com";
const STORE_KEY = "apple-music";
export const APPLE_TOKEN_LIFETIME_S = 60 * 60 * 24 * 150; // Apple allows up to ~6 months

interface AppleState {
  config?: AppleMusicConfig;
  userToken?: string;
  storefront?: string;
}

export interface AppleSignIn {
  /** Run MusicKit authorisation and resolve with the Music User Token. */
  obtainUserToken(developerToken: string): Promise<string>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Sign a MusicKit developer token (ES256 JWT, raw r||s signature). */
export async function signDeveloperToken(teamId: string, keyId: string, privateKeyPem: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: nowS, exp: nowS + APPLE_TOKEN_LIFETIME_S }));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("That .p8 file isn't a valid MusicKit private key.");
  }
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export class AppleMusicClient {
  private state: AppleState = {};
  private loaded = false;
  private devToken: { token: string; expires: number } | null = null;
  private readonly store: KeyValueStore;
  private readonly signIn: AppleSignIn;
  /** False in the browser: sign a token once and never store the private key. */
  private readonly keepPrivateKey: boolean;

  constructor(store: KeyValueStore, signIn: AppleSignIn, opts: { keepPrivateKey: boolean }) {
    this.store = store;
    this.signIn = signIn;
    this.keepPrivateKey = opts.keepPrivateKey;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.state = (await this.store.get<AppleState>(STORE_KEY)) ?? {};
    this.loaded = true;
  }

  private persist(): Promise<void> {
    return this.store.set(STORE_KEY, this.state);
  }

  private async developerToken(): Promise<string> {
    const c = this.state.config;
    if (!c) throw new Error("Apple Music is not configured.");
    if (c.developerToken) return c.developerToken.trim();
    if (!c.teamId || !c.keyId || !c.privateKey) throw new Error("Apple Music needs a developer token or Team ID + Key ID + .p8 key.");
    const now = Date.now();
    if (!this.devToken || this.devToken.expires < now + 86_400_000) {
      this.devToken = { token: await signDeveloperToken(c.teamId, c.keyId, c.privateKey), expires: now + APPLE_TOKEN_LIFETIME_S * 1000 };
    }
    return this.devToken.token;
  }

  async status(): Promise<ProviderStatus> {
    await this.load();
    return {
      provider: "apple-music",
      configured: !!this.state.config,
      connected: !!this.state.userToken,
      account: this.state.userToken ? `Apple Music (storefront ${this.state.storefront ?? "?"})` : undefined,
    };
  }

  async configure(cfg: AppleMusicConfig): Promise<void> {
    await this.load();
    let config: AppleMusicConfig = cfg.developerToken?.trim()
      ? { developerToken: cfg.developerToken.trim() }
      : { teamId: cfg.teamId?.trim(), keyId: cfg.keyId?.trim(), privateKey: cfg.privateKey?.trim() };
    if (!config.developerToken && !this.keepPrivateKey) {
      config = { developerToken: await signDeveloperToken(config.teamId ?? "", config.keyId ?? "", config.privateKey ?? "") };
    }
    this.state = { config };
    this.devToken = null;
    // Validate against the catalogue (developer token only, no user needed).
    const r = await fetchJson<Json>(`${API}/v1/catalog/us/search?types=songs&limit=1&term=test`, {
      headers: { Authorization: `Bearer ${await this.developerToken()}` },
    });
    if (r.status === 401 || r.status === 403) {
      this.state = {};
      throw new Error("Apple rejected the developer token. Check Team ID, Key ID and that the key has MusicKit enabled.");
    }
    await this.persist();
  }

  async disconnect(forget = false): Promise<void> {
    await this.load();
    this.state = forget ? {} : { config: this.state.config };
    await this.persist();
  }

  async connect(): Promise<ProviderStatus> {
    await this.load();
    this.state.userToken = await this.signIn.obtainUserToken(await this.developerToken());
    try {
      const sf = await this.api("/v1/me/storefront");
      this.state.storefront = sf.data?.[0]?.id ?? "us";
    } catch {
      this.state.storefront = "us";
    }
    await this.persist();
    return this.status();
  }

  private async api(pathOrUrl: string): Promise<Json> {
    await this.load();
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.developerToken()}` };
    if (this.state.userToken) headers["Music-User-Token"] = this.state.userToken;
    const r = await fetchJson<Json>(pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl, { headers });
    if (r.status === 401 || r.status === 403) {
      if (this.state.userToken && pathOrUrl.includes("/me/")) {
        this.state.userToken = undefined;
        await this.persist();
        throw new Error("Apple Music session expired — please connect again.");
      }
      throw new Error("Apple Music refused the request (check the developer token).");
    }
    if (r.status === 429) throw new Error("Apple Music rate limit — try again shortly.");
    if (r.status >= 400) throw new Error(r.body?.errors?.[0]?.detail ?? `Apple Music error ${r.status}`);
    return r.body;
  }

  private async paged(first: string, max: number, each: (x: Json) => void): Promise<void> {
    let next: string | null = first;
    let count = 0;
    while (next && count < max) {
      const page: Json = await this.api(next);
      for (const x of page.data ?? []) {
        each(x);
        count++;
      }
      next = page.next ?? null;
    }
  }

  async playlists(): Promise<StreamingPlaylist[]> {
    const out: StreamingPlaylist[] = [{ id: "__songs__", name: "Library Songs", trackCount: 0, readable: true }];
    await this.paged("/v1/me/library/playlists?limit=100", 500, (p) =>
      out.push({ id: p.id, name: p.attributes?.name ?? "Playlist", trackCount: 0, artworkUrl: artwork(p.attributes?.artwork), readable: true }),
    );
    return out;
  }

  async playlistTracks(id: string): Promise<StreamingTrack[]> {
    const out: StreamingTrack[] = [];
    const first = id === "__songs__" ? "/v1/me/library/songs?limit=100" : `/v1/me/library/playlists/${encodeURIComponent(id)}/tracks?limit=100`;
    await this.paged(first, 1000, (s) => {
      const t = mapAppleSong(s);
      if (t) out.push(t);
    });
    return out;
  }

  async search(q: string): Promise<StreamingTrack[]> {
    await this.load();
    const term = q.trim();
    if (!term) return [];
    const sf = this.state.storefront ?? "us";
    const r = await this.api(`/v1/catalog/${sf}/search?types=songs&limit=25&term=${encodeURIComponent(term)}`);
    return (r.results?.songs?.data ?? []).map(mapAppleSong).filter(Boolean) as StreamingTrack[];
  }
}

function artwork(a: Json): string | undefined {
  return a?.url ? String(a.url).replace("{w}", "80").replace("{h}", "80") : undefined;
}

export function mapAppleSong(s: Json): StreamingTrack | null {
  const a = s?.attributes;
  if (!a) return null;
  return {
    provider: "apple-music",
    id: s.id,
    title: a.name ?? "",
    artist: a.artistName ?? "",
    album: a.albumName ?? "",
    durationMs: a.durationInMillis ?? 0,
    releaseDate: a.releaseDate,
    explicit: a.contentRating === "explicit",
    artworkUrl: artwork(a.artwork),
    isrc: a.isrc,
    externalUrl: a.url,
  };
}

/** Load MusicKit JS v3 (browser only) and return the configured instance. */
export async function loadMusicKit(developerToken: string, doc: Document = document): Promise<Json> {
  const w = doc.defaultView as Json;
  if (!w.MusicKit) {
    await new Promise<void>((resolve, reject) => {
      const done = () => resolve();
      doc.addEventListener("musickitloaded", done, { once: true });
      const s = doc.createElement("script");
      s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
      s.async = true;
      s.dataset.webComponents = "";
      s.onerror = () => reject(new Error("Could not load Apple MusicKit JS (network or content blocker)."));
      doc.head.appendChild(s);
      setTimeout(() => (w.MusicKit ? resolve() : reject(new Error("Timed out loading MusicKit JS."))), 20000);
    });
  }
  await w.MusicKit.configure({ developerToken, app: { name: "Donkey Billabong DJ", build: "0.1.0" } });
  return w.MusicKit.getInstance();
}

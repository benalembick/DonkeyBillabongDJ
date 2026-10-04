import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyClient } from "../src/providers/spotify/SpotifyClient";
import type { KeyValueStore } from "../src/providers/web";
import { spotifyRedirectUri } from "../src/providers/browser/browserStreaming";

class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get<T>(k: string) {
    return (this.data.get(k) as T) ?? null;
  }
  async set(k: string, v: unknown) {
    if (v === null) this.data.delete(k);
    else this.data.set(k, JSON.parse(JSON.stringify(v)));
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("SpotifyClient", () => {
  it("runs PKCE sign-in, maps playlists and tracks, refreshes on 401", async () => {
    const calls: string[] = [];
    let meCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/token")) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "authorization_code") {
          expect(body.get("code")).toBe("CODE123");
          expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
          return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 3600 });
        }
        return json(200, { access_token: "A2", expires_in: 3600 });
      }
      if (url.endsWith("/v1/me")) return json(200, { id: "ben", display_name: "Ben", product: "premium" });
      if (url.includes("/me/playlists")) return json(200, { items: [{ id: "p1", name: "Own", owner: { id: "ben" }, items: { total: 2 } }, { id: "p2", name: "Theirs", owner: { id: "x" } }], next: null });
      if (url.includes("/playlists/p1/items")) {
        meCalls++;
        if (meCalls === 1) return json(401, { error: { message: "expired" } });
        return json(200, { items: [{ item: { type: "track", id: "t1", name: "One More Time", artists: [{ name: "Daft Punk" }], album: { name: "Discovery", images: [{ url: "big" }, { url: "small" }] }, duration_ms: 320000, external_urls: { spotify: "https://open.spotify.com/track/t1" } } }, { item: { type: "episode", id: "e1" } }], next: null });
      }
      return json(404, {});
    }));

    let seenAuthUrl = "";
    const client = new SpotifyClient(new MemStore(), {
      redirectUri: "http://127.0.0.1:43821/callback",
      authorize: async (authUrl, state) => {
        seenAuthUrl = authUrl;
        return new URLSearchParams({ code: "CODE123", state });
      },
    });

    await expect(client.configure({ clientId: "nope" })).rejects.toThrow(/Client ID/);
    await client.configure({ clientId: "0123456789abcdef0123456789abcdef" });
    const status = await client.connect();
    const auth = new URL(seenAuthUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43821/callback");
    expect(auth.searchParams.get("scope")).not.toMatch(/streaming|modify/);
    expect(status).toMatchObject({ connected: true, account: "Ben (premium)" });

    const pls = await client.playlists();
    // Playlists by other people are listed after the viewable ones, locked (Spotify answers 403 for them).
    expect(pls.map((p) => [p.name, p.readable])).toEqual([["Liked Songs", true], ["Own", true], ["Theirs", false]]);

    const tracks = await client.playlistTracks("p1");
    expect(tracks).toEqual([{ provider: "spotify", id: "t1", title: "One More Time", artist: "Daft Punk", artists: ["Daft Punk"], album: "Discovery", durationMs: 320000, artworkUrl: "small", isrc: undefined, externalUrl: "https://open.spotify.com/track/t1" }]);
    expect(calls.filter((c) => c.includes("/api/token"))).toHaveLength(2); // exchange + refresh after 401
  });

  it("rejects a callback with the wrong state", async () => {
    const client = new SpotifyClient(new MemStore(), {
      redirectUri: "http://127.0.0.1:1/cb",
      authorize: async () => new URLSearchParams({ code: "x", state: "dbdj-sp-other" }),
    });
    await client.configure({ clientId: "0123456789abcdef0123456789abcdef" });
    await expect(client.connect()).rejects.toThrow(/state mismatch/);
  });

  it("browser redirect URI swaps localhost for 127.0.0.1", () => {
    expect(spotifyRedirectUri({ protocol: "http:", hostname: "localhost", port: "5173", pathname: "/" } as Location)).toBe("http://127.0.0.1:5173/");
    expect(spotifyRedirectUri({ protocol: "https:", hostname: "dj.example.com", port: "", pathname: "/app/" } as Location)).toBe("https://dj.example.com/app/");
  });
});

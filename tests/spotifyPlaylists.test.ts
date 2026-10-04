/**
 * Spotify playlists: every playlist is offered (owned or not), tracks are always requested,
 * /items falls back to /tracks, and an explanation appears only when Spotify really refuses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyClient } from "../src/providers/spotify/SpotifyClient";
import { spotdlSongToSource } from "../electron/acquire/spotdl";

const API = "https://api.spotify.com/v1";
const track = (id: string, name: string) => ({ type: "track", id, name, artists: [{ name: "Artist" }], album: { name: "LP" }, duration_ms: 200_000 });

function client(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace(API, "").replace("https://accounts.spotify.com", "");
    calls.push(path);
    const hit = routes[path] ?? { status: 404, body: { error: { status: 404, message: "Not found" } } };
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  });
  const store = { get: async () => ({ clientId: "a".repeat(32), tokens: { access: "t", refresh: "r", expiresAt: Date.now() + 3_600_000 }, user: { id: "me", name: "Ben" } }), set: async () => undefined };
  return { c: new SpotifyClient(store as never, { redirectUri: "", authorize: async () => new URLSearchParams() }), calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("Spotify playlists", () => {
  it("lists every playlist across pages: viewable first, other people's after them and locked", async () => {
    const mine = { id: "p1", name: "Mine", owner: { id: "me" }, tracks: { total: 2 } };
    const theirs = { id: "p2", name: "House", owner: { id: "someone", display_name: "Someone" }, tracks: { total: 104 } };
    const shared = { id: "p3", name: "Shared", owner: { id: "friend" }, collaborative: true, tracks: { total: 5 } };
    const { c } = client({
      "/me/playlists?limit=50": { status: 200, body: { items: [theirs, mine], next: `${API}/me/playlists?limit=50&offset=50`, total: 3 } },
      "/me/playlists?limit=50&offset=50": { status: 200, body: { items: [shared], next: null, total: 3 } },
    });
    const lists = await c.playlists();
    expect(lists.map((p) => [p.name, p.readable])).toEqual([["Liked Songs", true], ["Mine", true], ["Shared", true], ["House", false]]);
    expect(lists[3]).toMatchObject({ trackCount: 104, note: "By Someone" });
  });

  it("never silently shows only Liked Songs when Spotify reports playlists", async () => {
    const { c } = client({ "/me/playlists?limit=50": { status: 200, body: { items: [null], next: null, total: 45 } } });
    await expect(c.playlists()).rejects.toThrow(/reported 45 playlists but none could be read/);
  });

  it("returns the tracks of someone else's playlist when Spotify allows it", async () => {
    const { c } = client({
      "/playlists/p2/items?limit=50": { status: 200, body: { items: [{ item: track("t1", "One") }], next: `${API}/playlists/p2/items?limit=50&offset=50` } },
      "/playlists/p2/items?limit=50&offset=50": { status: 200, body: { items: [{ track: track("t2", "Two") }], next: null } },
    });
    expect((await c.playlistTracks("p2")).map((t) => t.title)).toEqual(["One", "Two"]);
  });

  it("falls back to /tracks for apps without the /items endpoint", async () => {
    const { c, calls } = client({ "/playlists/p2/tracks?limit=50": { status: 200, body: { items: [{ track: track("t1", "One") }], next: null } } });
    expect((await c.playlistTracks("p2")).map((t) => t.title)).toEqual(["One"]);
    expect(calls).toContain("/playlists/p2/tracks?limit=50");
  });

  it("explains only when Spotify actually refuses", async () => {
    const { c } = client({ "/playlists/p3/items?limit=50": { status: 403, body: { error: { status: 403, message: "Forbidden" } } } });
    await expect(c.playlistTracks("p3")).rejects.toThrow(/didn't return this playlist's tracks/);
  });

  it("reads a refused playlist through the fallback (spotDL on desktop)", async () => {
    const { c } = client({ "/playlists/p3/items?limit=50": { status: 403, body: { error: { status: 403, message: "Forbidden" } } }, "/playlists/p3/tracks?limit=50": { status: 403, body: {} } });
    const seen: string[] = [];
    c.setPlaylistFallback(async (id) => {
      seen.push(id);
      return [spotdlSongToSource({ name: "Strobe", artists: ["deadmau5"], album_name: "For Lack", duration: 634.5, isrc: "USUS11000412", song_id: "4uLU6hMCjMI75M1A2tKUQC", list_position: 1 })];
    });
    const tracks = await c.playlistTracks("p3");
    expect(seen).toEqual(["p3"]);
    expect(tracks).toEqual([{ provider: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC", title: "Strobe", artist: "deadmau5", artists: ["deadmau5"], album: "For Lack", durationMs: 634_500, explicit: undefined, isrc: "USUS11000412", externalUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" }]);
  });

  it("says both routes failed when the fallback fails too", async () => {
    const { c } = client({ "/playlists/p3/items?limit=50": { status: 403, body: {} } });
    c.setPlaylistFallback(async () => {
      throw new Error("spotDL isn't installed");
    });
    await expect(c.playlistTracks("p3")).rejects.toThrow(/Reading it with spotDL also failed: spotDL isn't installed/);
  });

  it("maps spotDL's saved songs without guessing missing fields", () => {
    expect(spotdlSongToSource({ name: "X", artist: "Solo", song_id: "bad id" })).toEqual({ id: null, uri: null, title: "X", artists: ["Solo"], album: "", durationMs: null, explicit: null, isrc: null, url: null });
  });

  it("prepares someone else's playlist for Spotify → Local", async () => {
    const q = "limit=50&market=from_token&additional_types=track,episode";
    const { c } = client({
      "/playlists/p2?fields=id,name,owner(id,display_name),snapshot_id,collaborative,external_urls": { status: 200, body: { id: "p2", name: "House", owner: { id: "someone", display_name: "Someone" }, snapshot_id: "s" } },
      [`/playlists/p2/items?${q}`]: { status: 200, body: { items: [{ item: track("t1", "One") }], next: null } },
    });
    const r = await c.resolveSource({ type: "playlist", id: "p2" });
    expect(r.source).toMatchObject({ name: "House", owner: "Someone" });
    expect(r.entries.map((e) => e.track.title)).toEqual(["One"]);
  });
});

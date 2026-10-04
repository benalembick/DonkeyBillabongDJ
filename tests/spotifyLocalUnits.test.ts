import { describe, expect, it } from "vitest";
import { CancelledError, Limiter, TransientError, withRetry } from "../src/acquire/jobs";
import { durationCheck, matchFileToEntries, sourceIdentity } from "../src/acquire/match";
import { previewRefresh } from "../src/acquire/refresh";
import { parseSpotifyRef } from "../src/acquire/spotifyRef";
import { DEFAULT_ACQUIRE_MATCH, type PlaylistEntry, type SourceTrack, type WatchedFile } from "../src/acquire/types";
import { mapPlaylistEntry, toSourceTrack } from "../src/providers/spotify/SpotifyClient";

const ID = "37i9dQZF1DXcBWIGoYBM5M";

describe("Spotify links", () => {
  it("accepts playlist / track links and URIs, with intl prefixes and query strings", () => {
    expect(parseSpotifyRef(`https://open.spotify.com/playlist/${ID}?si=abc123`)).toEqual({ ok: true, ref: { type: "playlist", id: ID } });
    expect(parseSpotifyRef(`https://open.spotify.com/intl-de/track/${ID}`)).toEqual({ ok: true, ref: { type: "track", id: ID } });
    expect(parseSpotifyRef(`spotify:playlist:${ID}`)).toEqual({ ok: true, ref: { type: "playlist", id: ID } });
    expect(parseSpotifyRef(`spotify:user:bob:playlist:${ID}`)).toEqual({ ok: true, ref: { type: "playlist", id: ID } });
    expect(parseSpotifyRef(`open.spotify.com/embed/playlist/${ID}`)).toEqual({ ok: true, ref: { type: "playlist", id: ID } });
    expect(parseSpotifyRef("https://open.spotify.com/collection/tracks")).toEqual({ ok: true, ref: { type: "liked", id: "__liked__" } });
  });
  it("rejects what it can't prepare with an actionable message", () => {
    const err = (s: string) => {
      const r = parseSpotifyRef(s);
      return r.ok ? "" : r.error;
    };
    expect(err(`https://open.spotify.com/album/${ID}`)).toMatch(/Albums aren't supported/);
    expect(err(`https://open.spotify.com/episode/${ID}`)).toMatch(/Podcast/);
    expect(err("https://spotify.link/abcd")).toMatch(/full open\.spotify\.com link/);
    expect(err("https://evil.example.com/playlist/" + ID)).toMatch(/Only open\.spotify\.com/);
    expect(err("https://open.spotify.com/playlist/../../etc")).toMatch(/isn't valid|doesn't point/);
    expect(err(ID)).toMatch(/ambiguous/);
    expect(err("")).toMatch(/Paste/);
  });
});

describe("Spotify playlist entries", () => {
  const track = (o: Record<string, unknown> = {}) => ({ type: "track", id: ID, uri: `spotify:track:${ID}`, name: "Song", artists: [{ name: "A" }, { name: "B" }], album: { name: "LP" }, duration_ms: 200000, explicit: false, external_urls: { spotify: "https://open.spotify.com/track/x" }, ...o });
  it("keeps metadata as Spotify gave it — a missing ISRC stays missing", () => {
    const t = toSourceTrack(track());
    expect(t).toMatchObject({ id: ID, title: "Song", artists: ["A", "B"], album: "LP", durationMs: 200000, isrc: null });
    expect(toSourceTrack(track({ external_ids: { isrc: "USRC17607839" } })).isrc).toBe("USRC17607839");
  });
  it("classifies removed tracks, podcast episodes, Spotify local files and unplayable tracks", () => {
    expect(mapPlaylistEntry({ item: track() }).kind).toBe("track");
    expect(mapPlaylistEntry({ track: track() }).kind).toBe("track"); // saved-tracks shape
    expect(mapPlaylistEntry({ item: null }).kind).toBe("unavailable");
    expect(mapPlaylistEntry({ item: { type: "episode", id: "e", name: "Ep", show: { name: "Pod", publisher: "P" } } }).kind).toBe("episode");
    const local = mapPlaylistEntry({ is_local: true, item: track({ id: null, uri: "spotify:local:A:LP:Song:200" }) });
    expect(local).toMatchObject({ kind: "spotify-local-file", track: { id: null, title: "Song" } });
    expect(mapPlaylistEntry({ item: track({ is_playable: false }) }).kind).toBe("unavailable");
  });
});

const src = (o: Partial<SourceTrack>): SourceTrack => ({ id: "sp1", uri: null, title: "Song", artists: ["Artist"], album: "", durationMs: 210_000, explicit: null, isrc: null, url: null, ...o });
const entry = (key: string, o: Partial<SourceTrack>): PlaylistEntry => ({ key, position: 0, kind: "track", source: src(o), state: "awaiting-file", detail: "", attempts: 0, local: null, review: [], queued: false, analysis: "pending", updatedAt: 0 });
const file = (name: string, tags: WatchedFile["tags"]): WatchedFile => ({ path: `/dl/${name}`, name, size: 1000, mtimeMs: 0, tags, quality: null });

describe("matching files to entries (versions kept distinct)", () => {
  it("accepts a confident tag match and resolves every repeat of that track", () => {
    const es = [entry("e1", { id: "x", title: "Levels (Radio Edit)", artists: ["Avicii"], durationMs: 199_000 }), entry("e2", { id: "x", title: "Levels (Radio Edit)", artists: ["Avicii"], durationMs: 199_000 }), entry("e3", { id: "y", title: "Wake Me Up", artists: ["Avicii"] })];
    const m = matchFileToEntries(file("a.mp3", { title: "Levels (Radio Edit)", artist: "Avicii", durationMs: 199_500 }), es, DEFAULT_ACQUIRE_MATCH);
    expect(m.kind).toBe("accept");
    if (m.kind === "accept") expect(m.keys.sort()).toEqual(["e1", "e2"]);
  });
  it("never lets a different version satisfy an entry silently", () => {
    const es = [entry("e1", { title: "Levels - Extended Mix", artists: ["Avicii"], durationMs: 360_000 })];
    const radio = matchFileToEntries(file("r.mp3", { title: "Levels (Radio Edit)", artist: "Avicii", durationMs: 199_000 }), es, DEFAULT_ACQUIRE_MATCH);
    expect(radio.kind).not.toBe("accept");
    const remix = matchFileToEntries(file("x.mp3", { title: "Levels (Skrillex Remix)", artist: "Avicii", durationMs: 360_000 }), es, DEFAULT_ACQUIRE_MATCH);
    expect(remix.kind).not.toBe("accept");
  });
  it("treats live vs studio and remix vs original as different recordings", () => {
    const es = [entry("e1", { title: "Song", artists: ["Band"], durationMs: 240_000 })];
    const live = matchFileToEntries(file("l.mp3", { title: "Song (Live)", artist: "Band", durationMs: 241_000 }), es, DEFAULT_ACQUIRE_MATCH);
    expect(live.kind).not.toBe("accept");
  });
  it("falls back to 'Artist - Title' in the file name when tags are missing", () => {
    const es = [entry("e1", { title: "Strobe", artists: ["deadmau5"], durationMs: 600_000 })];
    const m = matchFileToEntries({ ...file("deadmau5 - Strobe.flac", {}), quality: { durationMs: 600_500, codec: "FLAC", container: "FLAC", bitrateKbps: null, sampleRate: 44100, channels: 2, lossless: true, sizeBytes: 1 } }, es, DEFAULT_ACQUIRE_MATCH);
    expect(m.kind).toBe("accept");
  });
  it("sends a file that fits two different entries to review", () => {
    const es = [entry("e1", { id: "a", title: "Intro", artists: ["The XX"], durationMs: 128_000 }), entry("e2", { id: "b", title: "Intro", artists: ["The XX"], durationMs: 129_000 })];
    expect(matchFileToEntries(file("i.mp3", { title: "Intro", artist: "The XX", durationMs: 128_500 }), es, DEFAULT_ACQUIRE_MATCH).kind).toBe("review");
  });
  it("checks durations plausibly and never treats an unknown length as proof", () => {
    expect(durationCheck(200_000, 201_000, DEFAULT_ACQUIRE_MATCH).ok).toBe(true);
    expect(durationCheck(200_000, 260_000, DEFAULT_ACQUIRE_MATCH).message).toMatch(/differs from Spotify by 60 s/);
    expect(durationCheck(200_000, null, DEFAULT_ACQUIRE_MATCH).ok).toBe(false);
    expect(durationCheck(200_000, 1_000, DEFAULT_ACQUIRE_MATCH).ok).toBe(false);
    expect(sourceIdentity(entry("e", { title: "Song (Extended Mix)" })).version.kind).toBe("extended");
  });
});

describe("refresh from Spotify", () => {
  const cur = ["a", "b", "c", "d"].map((id, i) => ({ ...entry(`k${id}`, { id }), position: i }));
  const inc = (ids: string[]) => ids.map((id) => ({ kind: "track" as const, track: src({ id }) }));
  it("reports added, removed and genuinely moved entries (inserts don't count as moves)", () => {
    const p = previewRefresh(cur, inc(["a", "x", "b", "d", "c"]));
    expect(p.added.map((a) => a.track.id)).toEqual(["x"]);
    expect(p.removed).toEqual([]);
    expect(p.moved.map((m) => m.entry.source.id)).toEqual(["d"]); // c/d swapped; one of them moved
    const q = previewRefresh(cur, inc(["a", "c", "d"]));
    expect(q.removed.map((e) => e.source.id)).toEqual(["b"]);
    expect(q.moved).toEqual([]);
  });
  it("pairs intentional repeats one-to-one", () => {
    const rep = [...cur, { ...entry("ka2", { id: "a" }), position: 4 }];
    const p = previewRefresh(rep, inc(["a", "b", "c", "d", "a", "a"]));
    expect(p.added.length).toBe(1);
    expect(p.removed.length).toBe(0);
  });
});

describe("background job primitives", () => {
  it("retries transient failures with backoff and honours Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n === 1) throw new TransientError("rate limit", 5);
        if (n === 2) throw new Error("network down");
        return "ok";
      },
      { attempts: 4, baseMs: 3, maxMs: 50, onRetry: (_a, w) => waits.push(w) },
    );
    expect(out).toBe("ok");
    expect(waits).toEqual([5, 6]);
  });
  it("gives up after the cap and doesn't retry permanent errors", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new TransientError("busy"); }, { attempts: 3, baseMs: 1, maxMs: 2 })).rejects.toThrow("busy");
    expect(n).toBe(3);
    let m = 0;
    await expect(withRetry(async () => { m++; throw new Error("403 not permitted"); }, { attempts: 3, baseMs: 1, maxMs: 2 })).rejects.toThrow("403");
    expect(m).toBe(1);
  });
  it("cancels while waiting", async () => {
    const ctl = new AbortController();
    const p = withRetry(async () => { throw new TransientError("x", 10_000); }, { attempts: 3, baseMs: 1, maxMs: 20_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });
  it("bounds concurrency", async () => {
    const lim = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => lim.run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    expect(peak).toBe(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import { buildIdentity } from "../src/matching/identity";
import { SmartTrackResolver } from "../src/matching/SmartTrackResolver";
import { LocalLibrarySource } from "../src/matching/sources";
import { AudiusClient, mapTrack } from "../src/providers/audius/AudiusClient";
import { AudiusSource } from "../src/providers/audius/AudiusSource";
import { audiusIdentity, audiusToTrackInfo } from "../src/providers/audius/audiusTracks";

const raw = (over: Record<string, unknown> = {}) => ({
  id: "abc12",
  title: "Example Song",
  user: { id: "u1", name: "Example Artist", handle: "example" },
  duration: 222,
  genre: "House",
  bpm: 124,
  musical_key: "A minor",
  isrc: null,
  is_streamable: true,
  access: { stream: true },
  is_stream_gated: false,
  stream_conditions: null,
  artwork: { "150x150": "https://img/150.jpg" },
  permalink: "/example/example-song",
  license: "All rights reserved",
  play_count: 10,
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Audius mapping", () => {
  it("maps metadata without inventing fields", () => {
    const t = mapTrack(raw());
    expect(t).toMatchObject({ id: "abc12", artist: "Example Artist", durationMs: 222000, bpm: 124, key: "A minor", isrc: null, streamable: true });
    expect(t.permalink).toBe("https://audius.co/example/example-song");
    const info = audiusToTrackInfo(t);
    expect(info).toMatchObject({ ref: "audius:abc12", source: "audius", isrc: null });
    expect(info.unavailableReason).toBeUndefined();
  });

  it("gated / API-restricted tracks are not streamable and carry a reason", () => {
    expect(mapTrack(raw({ is_stream_gated: true, stream_conditions: { usdc_purchase: {} } })).streamable).toBe(false);
    expect(mapTrack(raw({ access: { stream: false } })).streamable).toBe(false);
    expect(audiusToTrackInfo(mapTrack(raw({ is_streamable: false }))).unavailableReason).toBeTruthy();
  });

  it("covers and remixes are never the original recording", () => {
    expect(audiusIdentity(mapTrack(raw({ cover_original_song_title: "Get Lucky", cover_original_artist: "Daft Punk" }))).version.kind).toBe("other");
    expect(audiusIdentity(mapTrack(raw({ remix_of: { tracks: [{ parent_track_id: "x" }] } }))).version.kind).toBe("remix");
  });
});

describe("AudiusClient request handling", () => {
  it("de-duplicates identical in-flight requests and caches results", async () => {
    const f = vi.fn(async () => json({ data: [raw()] }));
    const c = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    const [a, b] = await Promise.all([c.searchTracks("example"), c.searchTracks("example")]);
    await c.searchTracks("example");
    expect(a[0].id).toBe("abc12");
    expect(b[0].id).toBe("abc12");
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.stats.cacheHits).toBe(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("app_name=");
  });

  it("retries 429 with back-off, then succeeds", async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : json({ data: [] })));
    const c = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    await expect(c.trending()).resolves.toEqual([]);
    expect(c.stats.retries).toBe(1);
    expect(c.stats.apiStatus).toBe("ok");
  });

  it("throttles to 5 requests per second", async () => {
    const starts: number[] = [];
    const f = vi.fn(async () => {
      starts.push(Date.now());
      return json({ data: [] });
    });
    const c = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    await Promise.all(Array.from({ length: 7 }, (_, i) => c.searchTracks(`q${i}`)));
    expect(starts.length).toBe(7);
    expect(starts[6] - starts[0]).toBeGreaterThanOrEqual(900);
  });

  it("resumes an interrupted stream with a Range request", async () => {
    const full = new Uint8Array(1000).map((_, i) => i % 251);
    const ranges: (string | undefined)[] = [];
    let call = 0;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      ranges.push(range);
      if (call++ === 0) {
        // First response: 400 bytes then the connection drops.
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(ctrl) {
            if (!sent) {
              sent = true;
              ctrl.enqueue(full.slice(0, 400));
            } else ctrl.error(new Error("network connection lost"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": "1000" } });
      }
      const from = Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);
      return new Response(full.slice(from), { status: 206, headers: { "content-length": String(1000 - from) } });
    });
    const c = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    const messages: string[] = [];
    const buf = await c.downloadAudio("abc12", (p) => p.message && messages.push(p.message));
    expect(new Uint8Array(buf)).toEqual(full);
    expect(ranges).toEqual([undefined, "bytes=400-"]);
    expect(messages[0]).toMatch(/interrupted — retrying/);
  }, 10_000);
});

describe("Audius in Smart Matching (conservative)", () => {
  const spotify = (title: string, artists: string[], ms: number) => buildIdentity({ source: "spotify", sourceTrackId: title, title, artists, durationMs: ms });

  const sourceWith = (tracks: Record<string, unknown>[]) => {
    const f = vi.fn(async () => json({ data: tracks }));
    const client = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    client.stats.apiStatus = "ok";
    return new AudiusSource(client);
  };

  it("finds the same recording on Audius when there's no local file", async () => {
    const src = sourceWith([raw({ title: "Example Song", duration: 222 })]);
    const r = new SmartTrackResolver({ sources: [new LocalLibrarySource([]), src] });
    const res = await r.resolve(spotify("Example Song", ["Example Artist"], 221_300));
    expect(res.status).toBe("resolved");
    expect(res.best?.source).toBe("audius");
    expect(res.best?.track?.source).toBe("audius");
    expect(res.best?.capabilities.canRecord).toBe(false);
  });

  it("rejects a DJ remix of a different length for an Original Mix", async () => {
    const src = sourceWith([raw({ title: "Example Song (Some DJ Remix)", user: { id: "u2", name: "Some DJ" }, duration: 392 })]);
    const r = new SmartTrackResolver({ sources: [new LocalLibrarySource([]), src] });
    const res = await r.resolve(spotify("Example Song - Original Mix", ["Example Artist"], 221_000));
    expect(res.status).toBe("unavailable");
    expect(res.playable).toBe(false);
  });

  it("does not auto-load a cover by another uploader", async () => {
    const src = sourceWith([raw({ title: "Example Song", user: { id: "u3", name: "Cover Band" }, cover_original_song_title: "Example Song", duration: 222 })]);
    const r = new SmartTrackResolver({ sources: [src] });
    const res = await r.resolve(spotify("Example Song", ["Example Artist"], 222_000));
    expect(res.playable).toBe(false);
  });

  it("is reported unavailable until the API test has succeeded", () => {
    const client = new AudiusClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(new AudiusSource(client).availability().available).toBe(false);
  });
});

describe("playlist resolution summary", () => {
  it("counts playable tracks per audio source and keeps remote mappings visible", async () => {
    const { summarize, playableSourceOf } = await import("../src/app/matching");
    const f = vi.fn(async () => json({ data: [raw({ title: "Example Song", duration: 222 })] }));
    const client = new AudiusClient({ fetchImpl: f as unknown as typeof fetch });
    client.stats.apiStatus = "ok";
    const rows = new Map<string, import("../src/matching/SmartTrackResolver").ResolutionMapping>();
    const storage = { loadAll: async () => [...rows.values()], put: async (m: never) => void rows.set((m as { key: string }).key, m), remove: async (k: string) => void rows.delete(k) };
    const r = new SmartTrackResolver({ sources: [new LocalLibrarySource([]), new AudiusSource(client)], storage });
    const req = buildIdentity({ source: "spotify", sourceTrackId: "s1", title: "Example Song", artists: ["Example Artist"], durationMs: 222_000 });
    const full = await r.resolve(req);
    expect(full.best?.source).toBe("audius");
    expect(rows.size).toBe(1); // confident Audius match cached (ids only, never audio)

    const r2 = new SmartTrackResolver({ sources: [new LocalLibrarySource([]), new AudiusSource(client)], storage });
    await r2.loadMappings();
    const quick = r2.resolveLocal(req); // instant list view, no network
    expect(quick.status).toBe("resolved");
    expect(playableSourceOf(quick)).toBe("audius");
    const none = r2.resolveLocal(buildIdentity({ source: "spotify", sourceTrackId: "s2", title: "Nothing", artists: ["Nobody"] }));
    expect(summarize([quick, none, undefined])).toMatchObject({ playable: 1, unavailable: 2, bySource: { audius: 1 } });
  });
});

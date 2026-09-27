import { describe, expect, it } from "vitest";
import type { TrackInfo } from "../src/core/engine/types";
import { trackInfoFromFileName } from "../src/library/LibraryStore";
import { buildIdentity, compareVersions, normalizeIsrc, parseTitle, splitArtists } from "../src/matching/identity";
import { scoreMatch } from "../src/matching/scoring";
import { SmartTrackResolver, toResolvedTrack, type MappingStorage, type ResolutionMapping } from "../src/matching/SmartTrackResolver";
import { createPartnerOnlySources, LocalLibrarySource, identityFromLocal } from "../src/matching/sources";

const local = (file: string, extra: Partial<TrackInfo> = {}): TrackInfo => ({ ...trackInfoFromFileName(`/music/${file}`, file), ...extra });
const spotify = (title: string, artists: string[], ms: number | null, isrc?: string, album = "") =>
  buildIdentity({ source: "spotify", sourceTrackId: `sp-${title}`, title, artists, album, durationMs: ms, isrc });

describe("identity parsing", () => {
  it("separates version and featured artists from the title", () => {
    expect(parseTitle("Get Lucky (Radio Edit) [feat. Pharrell Williams]")).toMatchObject({ baseTitle: "get lucky", version: { kind: "radio" }, featured: ["Pharrell Williams"] });
    expect(parseTitle("Achy Breaky Heart - Club Version")).toMatchObject({ baseTitle: "achy breaky heart", version: { kind: "club" } });
    expect(parseTitle("Strobe (Original Mix)").version.kind).toBe("original");
    expect(parseTitle("Levels - Skrillex Remix").version).toMatchObject({ kind: "remix", remixer: "skrillex" });
    expect(parseTitle("One More Time - Remastered 2021").version.kind).toBe("remaster");
    expect(parseTitle("Don't Stop Me Now - Live at Wembley").version.kind).toBe("live");
    expect(parseTitle("Song Title").version).toMatchObject({ kind: "original", explicitlyStated: false });
    // Non-version brackets stay part of the title
    expect(parseTitle("Delilah (pull me out of this)").baseTitle).toBe("delilah pull me out of this");
  });

  it("splits artist credits and normalises punctuation", () => {
    expect(splitArtists("Y.O.G.A., Adam Harvey")).toEqual(["Y.O.G.A.", "Adam Harvey"]);
    expect(splitArtists("Calvin Harris feat. Rihanna & Friend")).toEqual(["Calvin Harris", "Rihanna", "Friend"]);
    expect(buildIdentity({ source: "t", sourceTrackId: "1", title: "x", artists: ["Y.O.G.A."] }).artistKeys).toEqual(["yoga"]);
  });

  it("validates ISRCs", () => {
    expect(normalizeIsrc("us-qx9-13-00809")).toBe("USQX91300809");
    expect(normalizeIsrc("not an isrc")).toBeNull();
  });

  it("never treats materially different versions as interchangeable", () => {
    const v = (t: string) => parseTitle(t).version;
    expect(compareVersions(v("A (Radio Edit)"), v("A (Extended Mix)"))).toBe("conflict");
    expect(compareVersions(v("A (Original Mix)"), v("A - Skrillex Remix"))).toBe("conflict");
    expect(compareVersions(v("A"), v("A (Radio Edit)"))).toBe("uncertain");
    expect(compareVersions(v("A (Original Mix)"), v("A - 2011 Remaster"))).toBe("compatible");
    expect(compareVersions(v("A - X Remix"), v("A (X Remix)"))).toBe("match");
    expect(compareVersions(v("A - X Remix"), v("A - Y Remix"))).toBe("conflict");
  });
});

describe("scoring", () => {
  it("ISRC exact + matching metadata → exact confidence", () => {
    const req = spotify("Get Lucky", ["Daft Punk", "Pharrell Williams"], 222_400, "USQX91300809");
    const cand = identityFromLocal(local("Daft Punk, Pharrell Williams - Get Lucky.mp3", { isrc: "USQX91300809", durationMs: 222_100 }));
    const s = scoreMatch(req, cand);
    expect(s.method).toBe("isrc");
    expect(s.score).toBeGreaterThanOrEqual(95);
    expect(s.band).toBe("exact");
    expect(s.reasons.map((r) => r.label)).toContain("ISRC exact (USQX91300809)");
  });

  it("no ISRC: filename metadata + close duration → high confidence, version flagged as unconfirmed", () => {
    const req = spotify("Achy Breaky Heart - Club Version", ["Y.O.G.A.", "Adam Harvey"], 201_000, "AUXX12300001");
    const cand = identityFromLocal(local("Y.O.G.A., Adam Harvey - Achy Breaky Heart.mp3", { durationMs: 200_300 }));
    const s = scoreMatch(req, cand);
    expect(s.method).toBe("metadata");
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(s.reasons.some((r) => r.label.startsWith("Version not confirmed"))).toBe(true);
  });

  it("radio edit vs extended mix with a big duration gap is not a match", () => {
    const req = spotify("Titanium - Radio Edit", ["David Guetta"], 222_000);
    const cand = identityFromLocal(local("David Guetta - Titanium (Extended Mix).mp3", { durationMs: 378_000 }));
    expect(scoreMatch(req, cand).score).toBeLessThan(70);
  });

  it("same title by a different artist is capped", () => {
    const req = spotify("Hello", ["Adele"], 295_000);
    const cand = identityFromLocal(local("Lionel Richie - Hello.mp3", { durationMs: 295_000 }));
    expect(scoreMatch(req, cand).score).toBeLessThan(70);
  });

  it("different ISRCs are penalised", () => {
    const req = spotify("Track", ["Artist"], 200_000, "GBAAA0000001");
    const cand = identityFromLocal(local("Artist - Track.mp3", { durationMs: 200_000, isrc: "GBAAA0000002" }));
    const s = scoreMatch(req, cand);
    expect(s.details.isrc).toBe("differ");
    expect(s.score).toBeLessThan(scoreMatch(req, { ...cand, isrc: null }).score);
  });
});

class MemMappings implements MappingStorage {
  rows = new Map<string, ResolutionMapping>();
  async loadAll() {
    return [...this.rows.values()];
  }
  async put(m: ResolutionMapping) {
    this.rows.set(m.key, m);
  }
  async remove(k: string) {
    this.rows.delete(k);
  }
}

describe("SmartTrackResolver", () => {
  const library = [
    local("Daft Punk - Get Lucky (Radio Edit).mp3", { durationMs: 248_000 }),
    local("Daft Punk - Get Lucky (Album Version).mp3", { durationMs: 369_000 }),
    local("Daft Punk - One More Time.flac", { durationMs: 320_000, isrc: "GBDUW0000059" }),
    local("Other - Unrelated.mp3", { durationMs: 200_000 }),
  ];
  const make = (storage: MappingStorage | null = null) =>
    new SmartTrackResolver({ sources: [new LocalLibrarySource(library), ...createPartnerOnlySources()], storage });

  it("resolves an ISRC match from the local library and keeps metadata/audio sources separate", async () => {
    const r = make();
    const res = await r.resolve(spotify("One More Time", ["Daft Punk"], 320_400, "GBDUW0000059"));
    expect(res.status).toBe("resolved");
    expect(res.playable).toBe(true);
    expect(res.best?.source).toBe("local");
    const t = toResolvedTrack(res, res.best!)!;
    expect(t.source).toBe("local");
    expect(t.resolvedFrom).toMatchObject({ metadataSource: "spotify", audioSource: "local", method: "isrc" });
  });

  it("uses duration to pick the right version", async () => {
    const res = await make().resolve(spotify("Get Lucky", ["Daft Punk"], 369_500));
    expect(res.best?.track?.title).toBe("Get Lucky (Album Version)");
  });

  it("asks the user when versions are ambiguous", async () => {
    const res = await make().resolve(spotify("Get Lucky", ["Daft Punk"], null));
    expect(res.status).toBe("ambiguous");
    expect(res.playable).toBe(false);
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("reports unavailable providers honestly and returns 'unavailable' when nothing matches", async () => {
    const res = await make().resolve(spotify("Nonexistent Song", ["Nobody"], 180_000));
    expect(res.status).toBe("unavailable");
    expect(res.sourceNotes.map((n) => n.source).sort()).toEqual(["beatport", "beatsource", "soundcloud"]);
  });

  it("user-confirmed mappings take precedence and persist", async () => {
    const storage = new MemMappings();
    const r = make(storage);
    const req = spotify("Get Lucky", ["Daft Punk"], null);
    const src = r.getSources()[0] as LocalLibrarySource;
    await r.confirm(req, src.candidateFor("/music/Daft Punk - Get Lucky (Radio Edit).mp3")!);
    expect(storage.rows.size).toBe(1);

    const r2 = make(storage);
    await r2.loadMappings();
    const res = await r2.resolve(req);
    expect(res).toMatchObject({ status: "resolved", userConfirmed: true, fromCache: true });
    expect(res.best?.track?.title).toBe("Get Lucky (Radio Edit)");
    expect(r2.resolveLocal(req).userConfirmed).toBe(true);
  });

  it("drops cached automatic mappings whose target disappeared", async () => {
    const storage = new MemMappings();
    const req = spotify("One More Time", ["Daft Punk"], 320_000, "GBDUW0000059");
    await make(storage).resolve(req); // caches automatic mapping
    expect(storage.rows.size).toBe(1);
    const r = new SmartTrackResolver({ sources: [new LocalLibrarySource([])], storage });
    await r.loadMappings();
    const res = await r.resolve(req);
    expect(res.status).toBe("unavailable");
    expect(storage.rows.size).toBe(0);
  });
});

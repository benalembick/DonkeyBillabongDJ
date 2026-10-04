/**
 * Spotify → Local acceptance scenarios against the real library, playlist store and resolver,
 * with fakes for Spotify, files, providers, analysis, Auto DJ and decks. No audio is downloaded.
 */
import { describe, expect, it } from "vitest";
import type { AutoDJState } from "../src/autodj/AutoDJ";
import type { TrackInfo } from "../src/core/engine/types";
import { Emitter } from "../src/core/events";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { buildIdentity } from "../src/matching/identity";
import { SmartTrackResolver, type MappingStorage, type ResolutionMapping } from "../src/matching/SmartTrackResolver";
import { LocalLibrarySource } from "../src/matching/sources";
import type { ImportJobPersistence } from "../src/platform";
import { SpotDLAcquisition, type AcquisitionProvider, type ProviderCandidate } from "../src/acquire/providers";
import { SpotifyLocalService, type FileCheck, type SpotifyLocalDeps } from "../src/acquire/SpotifyLocalService";
import type { AudioQuality, EntryKind, ImportJob, SourceTrack, SpotifySourceResult, WatchedFile } from "../src/acquire/types";

const Q = (durationMs: number): AudioQuality => ({ codec: "MPEG 1 Layer 3", container: "MPEG", bitrateKbps: 320, sampleRate: 44100, channels: 2, lossless: false, durationMs, sizeBytes: 9_000_000 });
const sp = (id: string | null, title: string, artist: string, durationMs: number, extra: Partial<SourceTrack> = {}): SourceTrack => ({ id, uri: id ? `spotify:track:${id}` : null, title, artists: [artist], album: "", durationMs, explicit: null, isrc: null, url: null, ...extra });
const local = (ref: string, title: string, artist: string, durationMs: number, extra: Partial<TrackInfo> = {}): TrackInfo => ({ ref, title, artist, album: "", source: "local", bpm: null, key: null, durationMs, tagsRead: true, ...extra });

interface Harness {
  svc: SpotifyLocalService;
  library: LibraryStore;
  playlists: PlaylistStore;
  persisted: Map<string, ImportJob>;
  added: string[];
  checks: string[];
  downloads: string[];
  autodj: { state: AutoDJState; added: string[][]; started: string[] };
  loads: { deck: number; ref: string }[];
  analysis: Emitter<{ change: { busy: boolean } }>;
  decks: { playing: boolean }[];
  /** Tags a file gets once it's "read" by the library. */
  fileTags: Map<string, { title: string; artist: string; durationMs: number }>;
  badFiles: Set<string>;
  mappings: Map<string, ResolutionMapping>;
}

function harness(o: {
  library?: TrackInfo[];
  source?: SpotifySourceResult;
  metadataError?: string;
  providers?: AcquisitionProvider[];
  persisted?: Map<string, ImportJob>;
  mappings?: Map<string, ResolutionMapping>;
  noMetadata?: boolean;
  destination?: string | null;
} = {}): Harness {
  const library = new LibraryStore();
  library.hydrate(o.library ?? []);
  const localSrc = new LocalLibrarySource(library.getState().tracks);
  library.on("change", (s) => localSrc.reindex(s.tracks));
  const mappings = o.mappings ?? new Map<string, ResolutionMapping>();
  const storage: MappingStorage = { loadAll: async () => [...mappings.values()], put: async (m) => void mappings.set(m.key, m), remove: async (k) => void mappings.delete(k) };
  const resolver = new SmartTrackResolver({ sources: [localSrc], storage });
  const playlists = new PlaylistStore(null);
  const persisted = o.persisted ?? new Map<string, ImportJob>();
  const persistence: ImportJobPersistence = { load: async () => [...persisted.values()].map((j) => structuredClone(j)), save: async (j) => void persisted.set(j.id, structuredClone(j)), remove: async (id) => void persisted.delete(id) };
  const h: Partial<Harness> = { library, playlists, persisted, added: [], checks: [], downloads: [], loads: [], fileTags: new Map(), badFiles: new Set(), mappings };
  const decks = [{ playing: false }, { playing: false }];
  h.decks = decks;
  const autodj = {
    state: { status: "OFF", playlistId: null, current: null, deck: 0, upcoming: [], played: [], preparing: false, queueLocked: false, plan: null, nextSeconds: null, message: "", settings: {} } as unknown as AutoDJState,
    added: [] as string[][],
    started: [] as string[],
  };
  h.autodj = autodj;
  const analysis = new Emitter<{ change: { busy: boolean } }>();
  h.analysis = analysis;
  let checking = 0;
  const deps: SpotifyLocalDeps = {
    metadata: o.noMetadata
      ? null
      : {
          resolve: async () => {
            if (o.metadataError) throw new Error(o.metadataError);
            return structuredClone(o.source!);
          },
        },
    library,
    playlists,
    resolver,
    addFiles: async (refs) => {
      h.added!.push(...refs.map((r) => r.ref));
      const n = library.addFiles(refs).length;
      // The app reads tags right after adding; simulate that.
      library.patchTracks(refs.map((r) => {
        const t = library.getByRef(r.ref)!;
        const tags = h.fileTags!.get(r.ref);
        return tags ? { ...t, ...tags, tagsRead: true } : t;
      }));
      return n;
    },
    checkFile: async (ref, { decode }): Promise<FileCheck> => {
      checking++;
      if (checking > 1) throw new Error("file checks overlapped (decode must be one at a time)");
      h.checks!.push(`${decode ? "decode" : "probe"}:${ref}`);
      await new Promise((r) => setTimeout(r, 1));
      checking--;
      if (h.badFiles!.has(ref)) return { ok: false, error: "Couldn't decode the audio: EncodingError" };
      const t = library.getByRef(ref);
      return { ok: true, quality: Q(h.fileTags!.get(ref)?.durationMs ?? t?.durationMs ?? 200_000) };
    },
    analysis,
    autoDJ: {
      getState: () => autodj.state,
      add: (refs: string[]) => {
        autodj.added.push(refs);
        autodj.state = { ...autodj.state, upcoming: [...autodj.state.upcoming, ...refs] };
      },
      start: async (playlistId: string) => {
        autodj.started.push(playlistId);
        const [current, ...upcoming] = playlists.get(playlistId)!.refs;
        autodj.state = { ...autodj.state, status: "ACTIVE", playlistId, current, upcoming };
      },
      playNext: (i: number) => {
        const u = autodj.state.upcoming.slice();
        const [x] = u.splice(i, 1);
        autodj.state = { ...autodj.state, upcoming: [x, ...u] };
      },
    } as unknown as SpotifyLocalDeps["autoDJ"],
    engine: { getState: () => ({ decks }), loadTrack: async (deck: number, t: TrackInfo) => void h.loads!.push({ deck, ref: t.ref }) } as unknown as SpotifyLocalDeps["engine"],
    providers: o.providers ?? [],
    downloader: {
      download: async (c) => {
        h.downloads!.push(`${c.provider}:${c.candidateId}`);
        const path = `/downloads/${c.name} [${c.provider} ${c.candidateId}].mp3`;
        return { path, name: path.slice(11), reused: false, quality: Q(c.expectedDurationMs ?? 200_000) };
      },
    },
    persistence,
    log: { info: () => undefined, warn: () => undefined },
    desktop: {
      config: async () => ({ config: { destination: o.destination === undefined ? "/downloads" : o.destination, watchFolder: "/watch", watching: true }, watch: { folder: "/watch", watching: true, seen: 0 } }),
      onFile: () => () => undefined,
      onWatchStatus: () => () => undefined,
      pickDestination: async () => ({ config: { destination: "/downloads", watchFolder: "/watch", watching: true }, watch: { folder: "/watch", watching: true, seen: 0 } }),
      pickWatchFolder: async () => ({ config: { destination: "/downloads", watchFolder: "/watch", watching: true }, watch: { folder: "/watch", watching: true, seen: 0 } }),
      setWatching: async () => ({ config: { destination: "/downloads", watchFolder: "/watch", watching: true }, watch: { folder: "/watch", watching: true, seen: 0 } }),
      rescan: async () => ({ folder: "/watch", watching: true, seen: 0 }),
    },
    storage: null,
  };
  h.svc = new SpotifyLocalService(deps);
  return h as Harness;
}

const playlistSource = (entries: { kind?: EntryKind; track: SourceTrack }[]): SpotifySourceResult => ({
  source: { kind: "playlist", spotifyId: "37i9dQZF1DXcBWIGoYBM5M", name: "Friday Set", owner: "me", url: null, snapshotId: "s1" },
  entries: entries.map((e) => ({ kind: e.kind ?? "track", track: e.track, addedAt: null })),
});

/** Wait until no entry is still being worked on. */
async function settle(svc: SpotifyLocalService, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const busy = svc.getState().jobs.some((j) => j.entries.some((e) => ["pending", "matching", "downloading", "importing"].includes(e.state)));
    if (!busy) {
      await new Promise((r) => setTimeout(r, 5));
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("pipeline did not settle");
}

async function startJob(h: Harness, opts: Partial<{ useProviders: boolean; autoAppend: boolean }> = {}): Promise<ImportJob> {
  await h.svc.load();
  await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
  const job = h.svc.start({ playlistName: "Friday Set", useProviders: opts.useProviders ?? false, autoAppend: opts.autoAppend ?? false })!;
  await settle(h.svc);
  return h.svc.job(job.id)!;
}

const states = (j: ImportJob) => [...j.entries].sort((a, b) => a.position - b.position).map((e) => e.state);

describe("Spotify → Local: playlist creation and local reuse (criteria 1, 2)", () => {
  it("creates a local playlist in Spotify order, keeps repeats, and reuses existing files", async () => {
    const h = harness({
      library: [local("/m/one.mp3", "One More Time", "Daft Punk", 320_000, { prepared: true }), local("/m/levels.mp3", "Levels (Radio Edit)", "Avicii", 199_000)],
      source: playlistSource([
        { track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Levels - Radio Edit", "Avicii", 199_500) },
        { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Unknown Song", "Nobody", 180_000) },
        { track: sp("cccccccccccccccccccccc", "One More Time", "Daft Punk", 320_500) },
        { track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Levels - Radio Edit", "Avicii", 199_500) }, // intentional repeat
      ]),
    });
    const job = await startJob(h);
    expect(states(job)).toEqual(["analysing", "awaiting-file", "ready", "analysing"]);
    expect(h.playlists.get(job.playlistId)!.refs).toEqual(["/m/levels.mp3", "/m/one.mp3", "/m/levels.mp3"]);
    expect(h.added).toEqual([]); // nothing re-imported
    expect(job.entries[0].local?.provenance).toMatchObject({ origin: "library", audioSource: "Local library" });
    // Already-prepared tracks are only probed; others are fully decoded once.
    expect(h.checks).toContain("probe:/m/one.mp3");
    expect(h.checks).toContain("decode:/m/levels.mp3");
    expect(h.persisted.get(job.id)?.entries.length).toBe(4);
    // The match is remembered for next time.
    expect(h.mappings.get("spotify:aaaaaaaaaaaaaaaaaaaaaa")?.audioTrackId).toBe("/m/levels.mp3");
  });

  it("skips unsupported entries with a visible reason and still matches 'unavailable on Spotify' tracks locally", async () => {
    const h = harness({
      library: [local("/m/gone.mp3", "Gone Track", "Artist", 200_000)],
      source: playlistSource([
        { kind: "episode", track: sp("eeeeeeeeeeeeeeeeeeeeee", "Podcast Ep", "Pod", 3_000_000) },
        { kind: "unavailable", track: sp(null, "", "", 0) },
        { kind: "unavailable", track: sp("dddddddddddddddddddddd", "Gone Track", "Artist", 200_000) },
      ]),
    });
    const job = await startJob(h);
    expect(states(job)).toEqual(["failed", "failed", "analysing"]);
    expect(job.entries[0].detail).toMatch(/Podcast episodes/);
    expect(job.entries[1].detail).toMatch(/Removed from Spotify/);
  });
});

describe("watched folder (criterion 3)", () => {
  it("resolves pending entries automatically when a matching file finishes writing", async () => {
    const h = harness({ source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Strobe", "deadmau5", 600_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Ghosts n Stuff", "deadmau5", 300_000) }]) });
    const job = await startJob(h);
    expect(states(job)).toEqual(["awaiting-file", "awaiting-file"]);
    const f: WatchedFile = { path: "/watch/deadmau5 - Strobe.mp3", name: "deadmau5 - Strobe.mp3", size: 9e6, mtimeMs: 1, tags: { title: "Strobe", artist: "deadmau5", durationMs: 600_400 }, quality: Q(600_400) };
    h.fileTags.set(f.path, { title: "Strobe", artist: "deadmau5", durationMs: 600_400 });
    await h.svc.onWatchedFile(f);
    const after = h.svc.job(job.id)!;
    expect(states(after)).toEqual(["analysing", "awaiting-file"]);
    expect(after.entries[0].local).toMatchObject({ ref: f.path, provenance: { origin: "watch-folder", audioSource: "Watched folder" } });
    expect(after.entries[0].local?.quality).toMatchObject({ bitrateKbps: 320, sampleRate: 44100 });
    expect(h.playlists.get(job.playlistId)!.refs).toEqual([f.path]);
    // The same file arriving again (rescan) is not imported twice.
    await h.svc.onWatchedFile(f);
    expect(h.added).toEqual([f.path]);
    // Analysis finishing marks it Ready.
    h.library.patchTracks([{ ...h.library.getByRef(f.path)!, prepared: true }]);
    expect(h.svc.job(job.id)!.entries[0].state).toBe("ready");
  });

  it("uses a file that arrived in the watched folder before the job existed", async () => {
    const h = harness({ source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Strobe", "deadmau5", 600_000) }]) });
    await h.svc.load();
    const f: WatchedFile = { path: "/watch/deadmau5 - Strobe.mp3", name: "deadmau5 - Strobe.mp3", size: 9e6, mtimeMs: 1, tags: { title: "Strobe", artist: "deadmau5", durationMs: 600_400 }, quality: Q(600_400) };
    h.fileTags.set(f.path, { title: "Strobe", artist: "deadmau5", durationMs: 600_400 });
    await h.svc.onWatchedFile(f); // no jobs yet: remembered, not imported
    expect(h.added).toEqual([]);
    const job = await startJob(h);
    expect(job.entries[0]).toMatchObject({ state: "analysing", local: { ref: f.path, provenance: { origin: "watch-folder" } } });
  });

  it("rejects a file that doesn't decode, without touching the library", async () => {
    const h = harness({ source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Strobe", "deadmau5", 600_000) }]) });
    const job = await startJob(h);
    const f: WatchedFile = { path: "/watch/broken.mp3", name: "deadmau5 - Strobe.mp3", size: 10, mtimeMs: 1, tags: { title: "Strobe", artist: "deadmau5", durationMs: 600_000 }, quality: Q(600_000) };
    h.badFiles.add(f.path);
    await h.svc.onWatchedFile(f);
    const e = h.svc.job(job.id)!.entries[0];
    expect(e.state).toBe("failed");
    expect(e.detail).toMatch(/File rejected: Couldn't decode/);
    expect(h.added).toEqual([]);
  });
});

describe("ambiguous versions (criterion 4)", () => {
  it("asks which version instead of guessing, and remembers the choice", async () => {
    const h = harness({
      library: [local("/m/radio.mp3", "Song (Radio Edit)", "Band", 210_000), local("/m/live.mp3", "Song (Live)", "Band", 211_000)],
      source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Song", "Band", 210_500) }]),
    });
    const job = await startJob(h);
    const e = job.entries[0];
    expect(e.state).toBe("needs-review");
    expect(e.review.map((c) => c.id).sort()).toEqual(["/m/live.mp3", "/m/radio.mp3"]);
    await h.svc.confirmReview(job.id, e.key, e.review.find((c) => c.id === "/m/radio.mp3")!);
    expect(h.svc.job(job.id)!.entries[0]).toMatchObject({ state: "analysing", local: { ref: "/m/radio.mp3", provenance: { method: "manual" } } });
    expect(h.mappings.get("spotify:aaaaaaaaaaaaaaaaaaaaaa")).toMatchObject({ audioTrackId: "/m/radio.mp3", userConfirmed: true });
  });

  it("an extended-mix entry never takes the radio edit automatically", async () => {
    const h = harness({ library: [local("/m/radio.mp3", "Levels (Radio Edit)", "Avicii", 199_000)], source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Levels - Extended Mix", "Avicii", 360_000) }]) });
    const job = await startJob(h);
    expect(job.entries[0].state).not.toBe("analysing");
    expect(job.entries[0].local).toBeNull();
  });
});

class FakeProvider implements AcquisitionProvider {
  readonly name = "Fake";
  readonly audioSource = "Fake store (authorised)";
  readonly canDownload = true;
  readonly note = "";
  searches: string[] = [];
  constructor(readonly id: string, private catalogue: Record<string, ProviderCandidate[]>, private failFor = new Set<string>(), private available = true) {}
  async state() {
    return this.available ? { available: true } : { available: false, reason: "Provider offline" };
  }
  async search(identity: ReturnType<typeof buildIdentity>) {
    this.searches.push(identity.title);
    if (this.failFor.has(identity.title)) throw new Error("403 not permitted");
    return this.catalogue[identity.title] ?? [];
  }
}
const cand = (provider: string, id: string, title: string, artist: string, durationMs: number): ProviderCandidate => ({
  provider,
  id,
  identity: buildIdentity({ source: provider, sourceTrackId: id, title, artists: [artist], durationMs }),
  downloadUrl: `https://api.example/${id}`,
  name: `${artist} - ${title}`,
});

describe("providers: failures are isolated (criteria 5, 8)", () => {
  it("one failed acquisition doesn't stop the playlist; downloads are validated and imported", async () => {
    const p = new FakeProvider("fake", { "Track A": [cand("fake", "11", "Track A", "Indie", 200_000)], "Track C": [cand("fake", "33", "Track C", "Indie", 180_000)] }, new Set(["Track B"]));
    const h = harness({
      providers: [p],
      source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Track B", "Indie", 190_000) }, { track: sp("cccccccccccccccccccccc", "Track C", "Indie", 180_000) }]),
    });
    await h.svc.load();
    await h.svc.refreshProviders();
    for (const path of ["/downloads/Indie - Track A [fake 11].mp3", "/downloads/Indie - Track C [fake 33].mp3"]) h.fileTags.set(path, { title: path.includes("A") ? "Track A" : "Track C", artist: "Indie", durationMs: path.includes("A") ? 200_000 : 180_000 });
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "Indie", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    const j = h.svc.job(job.id)!;
    expect(states(j)).toEqual(["analysing", "awaiting-file", "analysing"]);
    expect(j.entries[1].detail).toMatch(/Not in your library/);
    expect(h.downloads).toEqual(["fake:11", "fake:33"]);
    expect(j.entries[0].local?.provenance).toMatchObject({ origin: "provider", provider: "fake", audioSource: "Fake store (authorised)", candidateId: "11" });
    expect(h.playlists.get(job.playlistId)!.refs).toEqual(["/downloads/Indie - Track A [fake 11].mp3", "/downloads/Indie - Track C [fake 33].mp3"]);
  });

  it("downloads missing tracks through spotDL and labels the YouTube source", async () => {
    const spotdl = new SpotDLAcquisition(async () => ({ available: true, version: "4.2.11" }));
    const h = harness({ providers: [spotdl], library: [local("/m/a.mp3", "Track A", "Indie", 200_000)], source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }, { track: sp("4uLU6hMCjMI75M1A2tKUQC", "Track B", "Indie", 190_000) }]) });
    h.fileTags.set("/downloads/Indie - Track B [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3", { title: "Track B", artist: "Indie", durationMs: 190_000 });
    await h.svc.load();
    await h.svc.refreshProviders();
    expect(h.svc.canDownload).toBe(true);
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    const j = h.svc.job(job.id)!;
    expect(states(j)).toEqual(["analysing", "analysing"]);
    expect(h.downloads).toEqual(["spotdl:4uLU6hMCjMI75M1A2tKUQC"]); // the library track wasn't downloaded
    expect(j.entries[1].local?.provenance).toMatchObject({ origin: "provider", provider: "spotdl", audioSource: expect.stringMatching(/YouTube Music via spotDL/), note: expect.stringMatching(/chosen by spotDL/) });
  });

  it("explains per provider why a track is still awaiting a file, and retries once spotDL is installed", async () => {
    let installed = false;
    const spotdl = new SpotDLAcquisition(async () => (installed ? { available: true, version: "4.2.11" } : { available: false, reason: "spotDL isn't installed (or isn't on PATH).", setup: "pip install spotdl" }));
    const audius = new FakeProvider("audius", {});
    const h = harness({ providers: [audius, spotdl], source: playlistSource([{ track: sp("4uLU6hMCjMI75M1A2tKUQC", "It Must Have Been Love", "Roxette", 258_000) }]) });
    h.fileTags.set("/downloads/Roxette - It Must Have Been Love [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3", { title: "It Must Have Been Love", artist: "Roxette", durationMs: 258_000 });
    await h.svc.load();
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    const e = h.svc.job(job.id)!.entries[0];
    expect(e.state).toBe("awaiting-file");
    expect(e.detail).toMatch(/Fake: no downloadable match/);
    expect(e.detail).toMatch(/spotDL: spotDL isn't installed \(or isn't on PATH\) — see ⚙ Folders & providers/);
    installed = true;
    await h.svc.refreshProviders(); // "Check again" after installing
    await settle(h.svc);
    expect(h.svc.job(job.id)!.entries[0]).toMatchObject({ state: "analysing", local: { provenance: { provider: "spotdl" } } });
    expect(h.downloads).toEqual(["spotdl:4uLU6hMCjMI75M1A2tKUQC"]);
  });

  it("a failed download ends as Failed with the provider's reason, after trying the next provider", async () => {
    const spotdl = new SpotDLAcquisition(async () => ({ available: true }));
    const h = harness({ providers: [spotdl], source: playlistSource([{ track: sp("4uLU6hMCjMI75M1A2tKUQC", "Dangerous", "Roxette", 229_000) }]) });
    await h.svc.load();
    // The fake downloader returns a file; make it fail validation (not decodable).
    h.badFiles.add("/downloads/Roxette - Dangerous [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3");
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    const e = h.svc.job(job.id)!.entries[0];
    expect(e.state).toBe("failed");
    expect(e.detail).toMatch(/^spotDL: File rejected: Couldn't decode/);
  });

  it("says when downloads are off for the playlist, and downloads once they're switched on", async () => {
    const h = harness({ providers: [new SpotDLAcquisition(async () => ({ available: true }))], source: playlistSource([{ track: sp("4uLU6hMCjMI75M1A2tKUQC", "Dangerous", "Roxette", 229_000) }]) });
    h.fileTags.set("/downloads/Roxette - Dangerous [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3", { title: "Dangerous", artist: "Roxette", durationMs: 229_000 });
    const job = await startJob(h, { useProviders: false });
    expect(job.entries[0].detail).toMatch(/Downloads are off for this playlist/);
    h.svc.setUseProviders(job.id, true);
    await settle(h.svc);
    expect(h.svc.job(job.id)!.entries[0]).toMatchObject({ state: "analysing", local: { provenance: { provider: "spotdl" } } });
  });

  it("an unavailable provider leaves local matching working", async () => {
    const p = new FakeProvider("fake", {}, new Set(), false);
    const h = harness({ providers: [p], library: [local("/m/a.mp3", "Track A", "Indie", 200_000)], source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Track B", "Indie", 190_000) }]) });
    await h.svc.load();
    await h.svc.refreshProviders();
    expect(h.svc.canDownload).toBe(false);
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    expect(states(h.svc.job(job.id)!)).toEqual(["analysing", "awaiting-file"]);
    expect(p.searches).toEqual([]);
  });

  it("a repeated track is downloaded once", async () => {
    const p = new FakeProvider("fake", { "Track A": [cand("fake", "11", "Track A", "Indie", 200_000)] });
    const h = harness({ providers: [p], source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }, { track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }]) });
    h.fileTags.set("/downloads/Indie - Track A [fake 11].mp3", { title: "Track A", artist: "Indie", durationMs: 200_000 });
    await h.svc.load();
    await h.svc.refreshProviders();
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    expect(h.downloads).toEqual(["fake:11"]);
    expect(states(h.svc.job(job.id)!)).toEqual(["analysing", "analysing"]);
    expect(h.playlists.get(job.playlistId)!.refs.length).toBe(2);
  });
});

describe("per-track Download into the Downloads playlist", () => {
  const result = (id: string, title: string, durationMs: number) => ({ provider: "spotify" as const, id, title, artist: "Roxette", artists: ["Roxette"], album: "", durationMs });

  it("downloads a search result into “Downloads”, once, keeping tracks already in that playlist", async () => {
    const h = harness({ providers: [new SpotDLAcquisition(async () => ({ available: true }))], library: [local("/m/mine.mp3", "Mine", "Me", 200_000)] });
    const mine = h.playlists.create("Downloads", ["/m/mine.mp3"]);
    h.fileTags.set("/downloads/Roxette - Dangerous [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3", { title: "Dangerous", artist: "Roxette", durationMs: 229_000 });
    await h.svc.load();
    h.svc.downloadTrack(result("4uLU6hMCjMI75M1A2tKUQC", "Dangerous", 229_000));
    await settle(h.svc);
    const job = h.svc.downloadsJob()!;
    expect(job.playlistId).toBe(mine.id); // existing playlist reused, no "Downloads 2"
    expect(h.svc.downloadEntry("4uLU6hMCjMI75M1A2tKUQC")).toMatchObject({ state: "analysing", local: { provenance: { provider: "spotdl" } } });
    expect(h.playlists.get(mine.id)!.refs).toEqual(["/m/mine.mp3", "/downloads/Roxette - Dangerous [spotdl 4uLU6hMCjMI75M1A2tKUQC].mp3"]);
    h.svc.downloadTrack(result("4uLU6hMCjMI75M1A2tKUQC", "Dangerous", 229_000));
    await settle(h.svc);
    expect(h.downloads).toEqual(["spotdl:4uLU6hMCjMI75M1A2tKUQC"]);
    expect(h.svc.getState().message?.text).toMatch(/already in Downloads/);
    expect(h.svc.getState().jobs.filter((j) => j.source.spotifyId === "__downloads__").length).toBe(1);
  });

  it("creates “Downloads” when missing, and retries a failed track on the next click", async () => {
    const h = harness({ providers: [new SpotDLAcquisition(async () => ({ available: true }))] });
    const path = "/downloads/Roxette - Spending My Time [spotdl 5qMavxQ0uSiBqoJfL30Xrx].mp3";
    h.badFiles.add(path);
    await h.svc.load();
    h.svc.downloadTrack(result("5qMavxQ0uSiBqoJfL30Xrx", "Spending My Time", 276_000));
    await settle(h.svc);
    expect(h.playlists.get(h.svc.downloadsJob()!.playlistId)!.name).toBe("Downloads");
    expect(h.svc.downloadEntry("5qMavxQ0uSiBqoJfL30Xrx")!.state).toBe("failed");
    h.badFiles.delete(path);
    h.fileTags.set(path, { title: "Spending My Time", artist: "Roxette", durationMs: 276_000 });
    h.svc.downloadTrack(result("5qMavxQ0uSiBqoJfL30Xrx", "Spending My Time", 276_000));
    await settle(h.svc);
    expect(h.svc.downloadEntry("5qMavxQ0uSiBqoJfL30Xrx")!.state).toBe("analysing");
  });
});

describe("decks and Auto DJ (criteria 6, 7)", () => {
  const lib = () => [local("/m/a.mp3", "Track A", "X", 200_000), local("/m/b.mp3", "Track B", "X", 210_000)];
  const srcAB = () => playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "X", 200_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Track B", "X", 210_000) }, { track: sp("cccccccccccccccccccccc", "Track C", "X", 220_000) }]);

  it("starts Auto DJ with ready tracks only, then adds newly ready ones once", async () => {
    const h = harness({ library: lib(), source: srcAB() });
    const job = await startJob(h);
    h.svc.addReadyToAutoDJ(job.id);
    expect(h.autodj.started).toEqual([job.playlistId]);
    expect(h.autodj.state.current).toBe("/m/a.mp3");
    expect(h.autodj.state.upcoming).toEqual(["/m/b.mp3"]);
    expect(h.svc.getState().message?.text).toMatch(/1 not ready yet/);
    // Pressing again adds nothing.
    h.svc.addReadyToAutoDJ(job.id);
    expect(h.autodj.added).toEqual([]);
    // Track C arrives; adding again appends only it, keeping the user's queue edits.
    h.autodj.state = { ...h.autodj.state, upcoming: ["/m/manual.mp3", ...h.autodj.state.upcoming] };
    h.fileTags.set("/watch/X - Track C.mp3", { title: "Track C", artist: "X", durationMs: 220_000 });
    await h.svc.onWatchedFile({ path: "/watch/X - Track C.mp3", name: "X - Track C.mp3", size: 1, mtimeMs: 1, tags: { title: "Track C", artist: "X", durationMs: 220_000 }, quality: Q(220_000) });
    h.svc.addReadyToAutoDJ(job.id);
    h.svc.addReadyToAutoDJ(job.id);
    expect(h.autodj.added).toEqual([["/watch/X - Track C.mp3"]]);
    expect(h.autodj.state.upcoming).toEqual(["/m/manual.mp3", "/m/b.mp3", "/watch/X - Track C.mp3"]);
  });

  it("auto-append is opt-in and never queues an entry twice", async () => {
    const h = harness({ library: lib(), source: srcAB() });
    h.autodj.state = { ...h.autodj.state, status: "ACTIVE", playlistId: "other", current: "/m/x.mp3" };
    const job = await startJob(h, { autoAppend: false });
    expect(h.autodj.added).toEqual([]);
    h.svc.setAutoAppend(job.id, true);
    expect(h.autodj.added.flat()).toEqual(["/m/a.mp3", "/m/b.mp3"]);
    h.svc.setAutoAppend(job.id, true);
    h.svc.addReadyToAutoDJ(job.id);
    expect(h.autodj.added.flat()).toEqual(["/m/a.mp3", "/m/b.mp3"]);
  });

  it("loads ready tracks onto decks without replacing a playing one", async () => {
    const h = harness({ library: lib(), source: srcAB() });
    const job = await startJob(h);
    const [a, , c] = [...job.entries].sort((x, y) => x.position - y.position);
    h.decks[0].playing = true;
    h.svc.loadDeck(job.id, a.key, 0);
    expect(h.loads).toEqual([]);
    expect(h.svc.getState().message?.text).toMatch(/Deck A is playing/);
    h.svc.loadDeck(job.id, a.key, 1);
    expect(h.loads).toEqual([{ deck: 1, ref: "/m/a.mp3" }]);
    h.svc.playNext(job.id, c.key);
    expect(h.svc.getState().message?.text).toMatch(/isn't ready/);
    h.svc.addReadyToAutoDJ(job.id);
    expect(h.svc.getState().message?.text).toMatch(/Auto DJ is off and a deck is playing/);
  });
});

describe("cancel / restart / retry (criterion 7)", () => {
  it("cancels, recovers after a restart and retries without duplicate files or playlist entries", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AcquisitionProvider = {
      id: "slow",
      name: "Slow",
      audioSource: "Slow store",
      canDownload: true,
      note: "",
      state: async () => ({ available: true }),
      search: async (i) => {
        await gate;
        return [cand("slow", "77", i.title, "Y", 200_000)];
      },
    };
    const source = playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Y", 200_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Local B", "Y", 180_000) }]);
    const h = harness({ providers: [slow], library: [local("/m/b.mp3", "Local B", "Y", 180_000)], source });
    await h.svc.load();
    await h.svc.refreshProviders();
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await new Promise((r) => setTimeout(r, 30));
    h.svc.cancel(job.id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    let j = h.svc.job(job.id)!;
    expect(j.status).toBe("cancelled");
    expect(states(j)).toEqual(["cancelled", "analysing"]);
    expect(h.downloads).toEqual([]);

    // "Restart": a new service over the same persisted jobs and mappings.
    h.persisted.set(job.id, { ...h.persisted.get(job.id)!, status: "running", entries: h.persisted.get(job.id)!.entries.map((e) => (e.state === "cancelled" ? { ...e, state: "downloading" } : e)) });
    const h2 = harness({ providers: [slow], library: [local("/m/b.mp3", "Local B", "Y", 180_000)], source, persisted: h.persisted, mappings: h.mappings });
    h2.playlists.create("x"); // playlist store is per-instance in this test
    h2.fileTags.set("/downloads/Y - Track A [slow 77].mp3", { title: "Track A", artist: "Y", durationMs: 200_000 });
    await h2.svc.load();
    await h2.svc.refreshProviders();
    await settle(h2.svc);
    j = h2.svc.job(job.id)!;
    expect(states(j)).toEqual(["analysing", "analysing"]);
    expect(h2.downloads).toEqual(["slow:77"]);
    // Retrying again changes nothing and imports nothing twice.
    h2.svc.retryFailed(job.id);
    await settle(h2.svc);
    expect(h2.downloads).toEqual(["slow:77"]);
    expect(h2.added).toEqual(["/downloads/Y - Track A [slow 77].mp3"]);
    expect(h2.playlists.get(j.playlistId)!.refs).toEqual(["/downloads/Y - Track A [slow 77].mp3", "/m/b.mp3"]);
  });
});

describe("refresh from Spotify keeps local preparation", () => {
  it("previews, then applies adds / removals / reorders without losing matched files", async () => {
    const lib = [local("/m/a.mp3", "Track A", "X", 200_000), local("/m/b.mp3", "Track B", "X", 210_000)];
    const source = playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "X", 200_000) }, { track: sp("bbbbbbbbbbbbbbbbbbbbbb", "Track B", "X", 210_000) }]);
    const h = harness({ library: lib, source });
    const job = await startJob(h);
    // Spotify now: B first, A removed, D added.
    source.entries = [source.entries[1], { kind: "track", track: sp("dddddddddddddddddddddd", "Track D", "X", 190_000), addedAt: null }];
    await h.svc.previewRefresh(job.id);
    const r = h.svc.getState().refresh!;
    expect(r.preview.added.map((a) => a.track.title)).toEqual(["Track D"]);
    expect(r.preview.removed.map((e) => e.source.title)).toEqual(["Track A"]);
    const bKey = job.entries.find((e) => e.source.title === "Track B")!.key;
    h.svc.applyRefresh();
    await settle(h.svc);
    const j = h.svc.job(job.id)!;
    expect(j.entries.find((e) => e.key === bKey)).toMatchObject({ position: 0, state: "analysing", local: { ref: "/m/b.mp3" } });
    expect(states(j)).toEqual(["analysing", "awaiting-file"]);
    expect(h.playlists.get(job.playlistId)!.refs).toEqual(["/m/b.mp3"]);
    expect(h.library.getByRef("/m/a.mp3")).not.toBeNull(); // the removed track's file stays in the library
  });
});

describe("actionable errors (criterion 10)", () => {
  it("explains inaccessible playlists and a missing Spotify connection", async () => {
    const h = harness({ metadataError: "Spotify only returns the tracks of playlists you own or collaborate on (Development Mode rules since 2026)." });
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    expect(h.svc.getState().message).toMatchObject({ kind: "error", text: expect.stringMatching(/own or collaborate/) });
    expect(h.svc.getState().draft).toBeNull();
    const none = harness({ noMetadata: true });
    await none.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    expect(none.svc.getState().message?.text).toMatch(/desktop app|connect/);
  });

  it("skips providers with a visible reason when no destination folder is chosen", async () => {
    const p = new FakeProvider("fake", { "Track A": [cand("fake", "11", "Track A", "Indie", 200_000)] });
    const h = harness({ providers: [p], destination: null, source: playlistSource([{ track: sp("aaaaaaaaaaaaaaaaaaaaaa", "Track A", "Indie", 200_000) }]) });
    await h.svc.load();
    await h.svc.refreshProviders();
    await h.svc.refreshDesktop();
    expect(h.svc.canDownload).toBe(false);
    await h.svc.preview({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    const job = h.svc.start({ playlistName: "x", useProviders: true, autoAppend: false })!;
    await settle(h.svc);
    expect(h.downloads).toEqual([]);
    expect(h.svc.job(job.id)!.entries[0].state).toBe("awaiting-file");
  });
});

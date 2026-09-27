/**
 * Smart Metadata Matching service: glues the SmartTrackResolver to the
 * library, the decks and the UI.
 *
 *   Spotify / Apple Music track (metadata only) → TrackIdentity → resolver → playable local track → deck
 */
import type { DJEngine } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import { Emitter } from "../core/events";
import type { EventLog } from "../core/log";
import type { LibraryStore } from "../library/LibraryStore";
import { buildIdentity, splitArtists, type TrackIdentity } from "../matching/identity";
import type { MatchConfig } from "../matching/scoring";
import { SmartTrackResolver, toResolvedTrack, type MappingStorage, type ResolutionResult, type ScoredCandidate } from "../matching/SmartTrackResolver";
import { createPartnerOnlySources, LocalLibrarySource, type PlayableSource, type SourceCandidate, type SourceId } from "../matching/sources";
import { PROVIDER_CAPABILITIES } from "../providers/MusicProvider";
import type { StreamingTrack } from "../providers/streamingTypes";

export interface MatchPrompt {
  /** Deck the user was trying to load, or null when just inspecting. */
  deck: number | null;
  result: ResolutionResult;
}

interface StoredSettings {
  order?: SourceId[];
  config?: Partial<MatchConfig>;
  disabled?: SourceId[];
}

const DEFAULT_ORDER: SourceId[] = ["local", "audius", "beatport", "beatsource", "soundcloud"];

const SETTINGS_KEY = "dbdj.smartMatching.v1";
const SOURCE_NAMES: Record<string, string> = {
  local: "Local Library",
  audius: "Audius",
  beatport: "Beatport",
  beatsource: "Beatsource",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  "apple-music": "Apple Music",
};

export function identityFromStreaming(t: StreamingTrack): TrackIdentity {
  return buildIdentity({
    source: t.provider,
    sourceTrackId: t.id,
    title: t.title,
    artists: t.artists?.length ? t.artists : splitArtists(t.artist),
    album: t.album,
    durationMs: t.durationMs,
    isrc: t.isrc,
    releaseDate: t.releaseDate,
    explicit: t.explicit,
    artworkUrl: t.artworkUrl,
  });
}

/** Identity for a streaming TrackInfo (e.g. dragged onto a deck). Ref format: "<provider>:<id>". */
export function identityFromTrackInfo(t: TrackInfo): TrackIdentity {
  const id = t.ref.startsWith(`${t.source}:`) ? t.ref.slice(t.source.length + 1) : t.ref;
  return buildIdentity({
    source: t.source,
    sourceTrackId: id,
    title: t.title,
    artists: splitArtists(t.artist),
    album: t.album,
    durationMs: t.durationMs ?? null,
    isrc: t.isrc,
    artworkUrl: t.artworkUrl,
  });
}

export const streamingKey = (t: StreamingTrack) => `${t.provider}:${t.id}`;

export class MatchingService extends Emitter<{ change: void; prompt: MatchPrompt; progress: { done: number; total: number } | null }> {
  readonly resolver: SmartTrackResolver;
  readonly local: LocalLibrarySource;
  private results = new Map<string, ResolutionResult>();
  private currentList: StreamingTrack[] = [];
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private listToken = 0;

  private readonly engine: DJEngine;
  private readonly log: EventLog;
  private readonly library: LibraryStore;

  constructor(opts: { engine: DJEngine; log: EventLog; library: LibraryStore; storage: MappingStorage; remoteSources?: PlayableSource[] }) {
    super();
    this.engine = opts.engine;
    this.log = opts.log;
    this.library = opts.library;
    this.local = new LocalLibrarySource(this.library.getState().tracks);
    const stored = loadSettings();
    // Keep saved orders valid when new sources are added (e.g. Audius goes right after Local).
    let order = stored.order?.filter((id) => DEFAULT_ORDER.includes(id)) ?? DEFAULT_ORDER;
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order = id === "audius" ? [order[0], id, ...order.slice(1)] : [...order, id];
    this.resolver = new SmartTrackResolver({
      sources: [this.local, ...(opts.remoteSources ?? []), ...createPartnerOnlySources()],
      order,
      config: stored.config,
      storage: opts.storage,
    });
    for (const id of stored.disabled ?? []) this.resolver.setEnabled(id, false);
    void this.resolver.loadMappings().then(() => this.reresolveCurrent());
    this.resolver.on("mappings", () => this.emit("change", undefined));

    // Keep the local index in step with the library (debounced: tag reading patches in bursts).
    let lastTracks = this.library.getState().tracks;
    this.library.on("change", (s) => {
      if (s.tracks === lastTracks) return; // selection-only change
      lastTracks = s.tracks;
      if (this.reindexTimer) clearTimeout(this.reindexTimer);
      this.reindexTimer = setTimeout(() => {
        this.local.reindex(s.tracks);
        this.reresolveCurrent();
      }, 300);
    });
  }

  // ─────────────── settings ───────────────

  private persist(): void {
    saveSettings({
      order: this.resolver.getOrder(),
      config: this.resolver.getConfig(),
      disabled: this.resolver.getSources().filter((s) => !this.resolver.isEnabled(s.id)).map((s) => s.id),
    });
  }

  setOrder(order: SourceId[]): void {
    this.resolver.setOrder(order);
    this.persist();
    this.reresolveCurrent();
  }

  setConfig(c: Partial<MatchConfig>): void {
    this.resolver.setConfig(c);
    this.persist();
    this.reresolveCurrent();
  }

  setSourceEnabled(id: SourceId, enabled: boolean): void {
    this.resolver.setEnabled(id, enabled);
    this.persist();
    this.emit("change", undefined);
  }

  /** A source's availability changed (e.g. Audius connection test finished). */
  notifySourcesChanged(): void {
    this.emit("change", undefined);
  }

  sourceName(id: string): string {
    return SOURCE_NAMES[id] ?? id;
  }

  // ─────────────── playlists / lists ───────────────

  resultFor(t: StreamingTrack): ResolutionResult | undefined {
    return this.results.get(streamingKey(t));
  }

  /**
   * Resolve a streaming track list against the local library (instant, chunked
   * so the UI stays responsive). Called whenever a playlist/search is shown.
   */
  async resolveList(tracks: StreamingTrack[]): Promise<void> {
    this.currentList = tracks;
    const token = ++this.listToken;
    const chunk = 50;
    for (let i = 0; i < tracks.length; i += chunk) {
      if (token !== this.listToken) return; // superseded by another list
      for (const t of tracks.slice(i, i + chunk)) this.results.set(streamingKey(t), this.resolver.resolveLocal(identityFromStreaming(t)));
      this.emit("progress", { done: Math.min(tracks.length, i + chunk), total: tracks.length });
      this.emit("change", undefined);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (token === this.listToken) this.emit("progress", null);
  }

  /** "Resolve playlist": full resolution incl. connected providers; confident matches are cached. */
  async preResolve(tracks: StreamingTrack[]): Promise<{ playable: number; possible: number; unavailable: number }> {
    const token = ++this.listToken;
    let done = 0;
    for (const t of tracks) {
      if (token !== this.listToken) break;
      this.results.set(streamingKey(t), await this.resolver.resolve(identityFromStreaming(t)));
      done++;
      if (done % 10 === 0 || done === tracks.length) {
        this.emit("progress", { done, total: tracks.length });
        this.emit("change", undefined);
      }
    }
    this.emit("progress", null);
    const s = summarize(tracks.map((t) => this.results.get(streamingKey(t))));
    this.log.info("matching", `Resolved ${tracks.length} tracks: ${s.playable} playable, ${s.possible} to review, ${s.unavailable} unavailable`);
    return s;
  }

  private reresolveCurrent(): void {
    if (this.currentList.length) void this.resolveList(this.currentList);
  }

  // ─────────────── loading ───────────────

  /** Load any track into a deck. Streaming tracks are resolved to a playable source first. */
  async loadToDeck(deck: number, track: TrackInfo, streaming?: StreamingTrack): Promise<void> {
    // Sources whose audio may enter the engine load directly (local files, Audius).
    if (PROVIDER_CAPABILITIES[track.source]?.canLoadIntoDeck) {
      await this.engine.loadTrack(deck, track);
      return;
    }
    const identity = streaming ? identityFromStreaming(streaming) : identityFromTrackInfo(track);
    this.log.info("matching", `Resolving "${identity.title}"…`);
    const result = await this.resolver.resolve(identity);
    if (streaming) this.results.set(streamingKey(streaming), result);
    this.emit("change", undefined);
    if (result.playable && result.best) {
      await this.loadCandidate(deck, result, result.best);
      return;
    }
    // Possible / ambiguous / nothing found: never guess — ask the user.
    this.emit("prompt", { deck, result });
  }

  async loadCandidate(deck: number, result: ResolutionResult, c: ScoredCandidate): Promise<void> {
    const t = toResolvedTrack(result, c);
    if (!t) {
      this.log.warn("matching", `${this.sourceName(c.source)} can't provide playable audio for this track.`);
      return;
    }
    await this.engine.loadTrack(deck, t);
    const via = result.userConfirmed ? "your saved match" : c.method === "isrc" ? "ISRC" : "metadata";
    this.log.info("matching", `Matched from ${this.sourceName(c.source)} (${c.score}% via ${via}) → deck ${String.fromCharCode(65 + deck)}`);
  }

  /** Show match details for a track without loading. */
  inspect(t: StreamingTrack): void {
    const result = this.results.get(streamingKey(t)) ?? this.resolver.resolveLocal(identityFromStreaming(t));
    this.emit("prompt", { deck: null, result });
  }

  /** User-chosen match (optionally remembered), refreshed everywhere. */
  async choose(result: ResolutionResult, candidate: SourceCandidate, remember: boolean): Promise<ResolutionResult> {
    const updated = remember ? await this.resolver.confirm(result.requested, candidate) : result;
    this.results.set(`${result.requested.source}:${result.requested.sourceTrackId}`, updated);
    this.emit("change", undefined);
    return updated;
  }

  async forget(result: ResolutionResult): Promise<ResolutionResult> {
    await this.resolver.clearMapping(result.requested);
    const fresh = this.resolver.resolveLocal(result.requested);
    this.results.set(`${result.requested.source}:${result.requested.sourceTrackId}`, fresh);
    this.emit("change", undefined);
    return fresh;
  }

  /** Candidate for any local track (manual "Match to local track"). */
  localCandidate(ref: string): SourceCandidate | null {
    return this.local.candidateFor(ref);
  }
}

export function summarize(results: (ResolutionResult | undefined)[]): { playable: number; possible: number; unavailable: number } {
  let playable = 0;
  let possible = 0;
  let unavailable = 0;
  for (const r of results) {
    if (!r || r.status === "unavailable") unavailable++;
    else if (r.status === "resolved") playable++;
    else possible++;
  }
  return { playable, possible, unavailable };
}

function loadSettings(): StoredSettings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as StoredSettings;
  } catch {
    return {};
  }
}

function saveSettings(s: StoredSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* best effort */
  }
}

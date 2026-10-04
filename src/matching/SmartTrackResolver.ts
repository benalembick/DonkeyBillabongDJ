/**
 * SmartTrackResolver: finds a playable equivalent of a requested recording.
 *
 *   TrackIdentity (any metadata source)
 *     → user-confirmed mapping? → cached mapping? (validated: target still exists)
 *     → search sources in priority order (local first, remote providers async with timeout)
 *     → score every candidate (scoring.ts) → pick best / flag ambiguity
 *     → ResolutionResult
 *
 * Spotify/Apple Music are only ever metadata sources here; audio always comes
 * from a PlayableSource the engine may play.
 */
import { Emitter } from "../core/events";
import type { ResolvedFrom, TrackInfo } from "../core/engine/types";
import { compareVersions, type TrackIdentity } from "./identity";
import { bandFor, DEFAULT_MATCH_CONFIG, scoreMatch, type ConfidenceBand, type MatchConfig, type MatchScore } from "./scoring";
import type { PlayableSource, SourceCandidate, SourceId } from "./sources";

export interface ScoredCandidate extends SourceCandidate, MatchScore {}

export type ResolutionStatus = "resolved" | "possible" | "ambiguous" | "unavailable";

export interface ResolutionResult {
  requested: TrackIdentity;
  candidates: ScoredCandidate[];
  best: ScoredCandidate | null;
  confidence: number;
  band: ConfidenceBand;
  status: ResolutionStatus;
  /** Safe to load without asking the user. */
  playable: boolean;
  method: "isrc" | "metadata" | "manual" | null;
  fromCache: boolean;
  userConfirmed: boolean;
  resolvedAt: number;
  sourceNotes: { source: SourceId; name: string; message: string }[];
  /** Saved mapping to a remote source, shown instantly in lists; validated when actually loaded. */
  cachedMapping?: ResolutionMapping;
}

/** Persisted mapping metadata-source track → playable-source track. */
export interface ResolutionMapping {
  key: string; // `${metadataSource}:${metadataTrackId}`
  metadataSource: string;
  metadataTrackId: string;
  audioSource: SourceId;
  audioTrackId: string;
  isrc: string | null;
  confidence: number;
  method: "isrc" | "metadata" | "manual";
  userConfirmed: boolean;
  resolvedAt: number;
}

export interface MappingStorage {
  loadAll(): Promise<ResolutionMapping[]>;
  put(m: ResolutionMapping): Promise<void>;
  remove(key: string): Promise<void>;
}


export const identityKey = (i: TrackIdentity) => `${i.source}:${i.sourceTrackId}`;

const REMOTE_TIMEOUT_MS = 8000;

export class SmartTrackResolver extends Emitter<{ resolved: ResolutionResult; mappings: void }> {
  private sources: PlayableSource[];
  private order: SourceId[];
  private disabled = new Set<SourceId>();
  private config: MatchConfig;
  private mappings = new Map<string, ResolutionMapping>();
  private readonly storage: MappingStorage | null;
  /** Recent resolutions for the diagnostics panel. */
  readonly recent: ResolutionResult[] = [];

  constructor(opts: { sources: PlayableSource[]; order?: SourceId[]; config?: Partial<MatchConfig>; storage?: MappingStorage | null }) {
    super();
    this.sources = opts.sources;
    this.order = opts.order ?? opts.sources.map((s) => s.id);
    this.config = { ...DEFAULT_MATCH_CONFIG, ...opts.config };
    this.storage = opts.storage ?? null;
  }

  async loadMappings(): Promise<void> {
    if (!this.storage) return;
    try {
      for (const m of await this.storage.loadAll()) this.mappings.set(m.key, m);
      this.emit("mappings", undefined);
    } catch {
      /* mapping cache is an optimisation; resolution still works without it */
    }
  }

  getConfig(): MatchConfig {
    return this.config;
  }
  setConfig(c: Partial<MatchConfig>): void {
    this.config = { ...this.config, ...c };
  }
  getOrder(): SourceId[] {
    return this.order;
  }
  setOrder(order: SourceId[]): void {
    this.order = order;
  }
  setEnabled(id: SourceId, enabled: boolean): void {
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
  }
  isEnabled(id: SourceId): boolean {
    return !this.disabled.has(id);
  }
  getSources(): PlayableSource[] {
    return this.orderedSources();
  }
  getMapping(identity: TrackIdentity): ResolutionMapping | undefined {
    return this.mappings.get(identityKey(identity));
  }

  private orderedSources(): PlayableSource[] {
    const byId = new Map(this.sources.map((s) => [s.id, s]));
    const ordered = this.order.map((id) => byId.get(id)).filter(Boolean) as PlayableSource[];
    for (const s of this.sources) if (!ordered.includes(s)) ordered.push(s);
    return ordered;
  }

  private score(req: TrackIdentity, c: SourceCandidate): ScoredCandidate {
    return { ...c, ...scoreMatch(req, c.identity, this.config) };
  }

  /** Resolve using only sources that answer synchronously (local library). Used for bulk playlist views. */
  resolveLocal(req: TrackIdentity): ResolutionResult {
    const fromMapping = this.fromMappingSync(req);
    if (fromMapping) return this.record(fromMapping);
    const candidates: ScoredCandidate[] = [];
    for (const s of this.orderedSources()) {
      if (s.remote || this.disabled.has(s.id) || !s.availability().available) continue;
      const local = s as PlayableSource & { searchSync?: (i: TrackIdentity) => SourceCandidate[] };
      if (!local.searchSync) continue;
      candidates.push(...local.searchSync(req).map((c) => this.score(req, c)));
    }
    return this.record(this.finish(req, candidates, []));
  }

  /** Full resolution: mappings, local, then remote providers in priority order. */
  async resolve(req: TrackIdentity, opts: { includeRemote?: boolean } = {}): Promise<ResolutionResult> {
    const fromMapping = await this.fromMapping(req);
    if (fromMapping) return this.record(fromMapping);

    const candidates: ScoredCandidate[] = [];
    const notes: ResolutionResult["sourceNotes"] = [];
    for (const s of this.orderedSources()) {
      if (this.disabled.has(s.id)) {
        notes.push({ source: s.id, name: s.name, message: "turned off in Settings → Smart Matching" });
        continue;
      }
      const avail = s.availability();
      if (!avail.available) {
        notes.push({ source: s.id, name: s.name, message: avail.reason ?? "unavailable" });
        continue;
      }
      if (s.remote && opts.includeRemote === false) continue;
      try {
        const found = s.remote ? await withTimeout(s.search(req), REMOTE_TIMEOUT_MS) : await s.search(req);
        candidates.push(...found.map((c) => this.score(req, c)));
      } catch (err) {
        notes.push({ source: s.id, name: s.name, message: `search failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      // Stop at the first source (in priority order) that yields a confident, unambiguous match.
      if (this.finish(req, candidates, notes).status === "resolved") break;
    }
    const result = this.finish(req, candidates, notes);
    if (result.status === "resolved" && result.best && result.method) await this.remember(req, result.best, result.method, false);
    return this.record(result);
  }

  /** User picks a candidate (or any local track): saved and preferred from now on. */
  async confirm(req: TrackIdentity, candidate: SourceCandidate): Promise<ResolutionResult> {
    const scored = this.score(req, candidate);
    await this.remember(req, scored, "manual", true);
    return this.record({ ...this.finish(req, [scored], []), status: "resolved", playable: true, method: "manual", userConfirmed: true });
  }

  /** Record an automatic (not user-confirmed) match made outside resolve(), e.g. a watched-folder file. */
  async recordMatch(req: TrackIdentity, candidate: SourceCandidate, method: "isrc" | "metadata"): Promise<void> {
    await this.remember(req, this.score(req, candidate), method, false);
  }

  async clearMapping(req: TrackIdentity): Promise<void> {
    const key = identityKey(req);
    this.mappings.delete(key);
    this.emit("mappings", undefined);
    await this.storage?.remove(key).catch(() => undefined);
  }

  private async remember(req: TrackIdentity, c: ScoredCandidate, method: ResolutionMapping["method"], userConfirmed: boolean): Promise<void> {
    const m: ResolutionMapping = {
      key: identityKey(req),
      metadataSource: req.source,
      metadataTrackId: req.sourceTrackId,
      audioSource: c.source,
      audioTrackId: c.sourceTrackId,
      isrc: req.isrc,
      confidence: c.score,
      method,
      userConfirmed,
      resolvedAt: Date.now(),
    };
    this.mappings.set(m.key, m);
    this.emit("mappings", undefined);
    await this.storage?.put(m).catch(() => undefined);
  }

  private fromMappingSync(req: TrackIdentity): ResolutionResult | null {
    const m = this.mappings.get(identityKey(req));
    if (!m) return null;
    const src = this.sources.find((s) => s.id === m.audioSource);
    if (!src) return null;
    if (src.remote) {
      // Can't validate a remote target synchronously: report the saved mapping; resolve() re-checks it on load.
      if (this.disabled.has(src.id) || !src.availability().available) return null;
      const base = this.finish(req, [], []);
      return {
        ...base,
        status: "resolved",
        playable: true,
        confidence: m.confidence,
        band: bandFor(m.confidence),
        method: m.userConfirmed ? "manual" : m.method,
        fromCache: true,
        userConfirmed: m.userConfirmed,
        cachedMapping: m,
      };
    }
    const exists = src.exists(m.audioTrackId);
    const c = exists === true ? (src.candidateFor(m.audioTrackId) as SourceCandidate | null) : null;
    return c ? this.mappedResult(req, m, c) : null;
  }

  private async fromMapping(req: TrackIdentity): Promise<ResolutionResult | null> {
    const m = this.mappings.get(identityKey(req));
    if (!m) return null;
    const src = this.sources.find((s) => s.id === m.audioSource);
    if (!src || !src.availability().available || !(await src.exists(m.audioTrackId))) {
      // Target gone: fall back to fresh resolution (keep user mappings for when it returns).
      if (!m.userConfirmed) await this.clearMapping(req);
      return null;
    }
    const c = await src.candidateFor(m.audioTrackId);
    return c ? this.mappedResult(req, m, c) : null;
  }

  private mappedResult(req: TrackIdentity, m: ResolutionMapping, c: SourceCandidate): ResolutionResult {
    const scored = this.score(req, c);
    const base = this.finish(req, [scored], []);
    if (m.userConfirmed) {
      return { ...base, status: "resolved", playable: true, method: "manual", fromCache: true, userConfirmed: true };
    }
    // Cached automatic match: re-validated by re-scoring against current config.
    return { ...base, fromCache: true };
  }

  private finish(req: TrackIdentity, all: ScoredCandidate[], notes: ResolutionResult["sourceNotes"]): ResolutionResult {
    const candidates = dedupe(all)
      .filter((c) => c.score >= 40)
      .sort((a, b) => b.score - a.score || priority(this.order, a.source) - priority(this.order, b.source));
    const best = candidates[0] ?? null;
    const confidence = best?.score ?? 0;
    let status: ResolutionStatus;
    if (!best || confidence < 70) status = "unavailable";
    else if (this.isAmbiguous(candidates)) status = "ambiguous";
    else if (confidence >= this.config.autoLoadMin) status = "resolved";
    else status = "possible";
    return {
      requested: req,
      candidates,
      best,
      confidence,
      band: bandFor(confidence),
      status,
      playable: status === "resolved" && !!best?.track && best.capabilities.canPlay,
      method: best ? best.method : null,
      fromCache: false,
      userConfirmed: false,
      resolvedAt: Date.now(),
      sourceNotes: notes,
    };
  }

  /** Two strong candidates that are materially different (version or length) → let the user choose. */
  private isAmbiguous(c: ScoredCandidate[]): boolean {
    if (c.length < 2 || c[1].score < 70) return false;
    if (c[0].score - c[1].score >= this.config.ambiguityMargin) return false;
    const a = c[0].identity;
    const b = c[1].identity;
    const differentVersion = compareVersions(a.version, b.version) === "conflict";
    const differentLength = a.durationMs != null && b.durationMs != null && Math.abs(a.durationMs - b.durationMs) > 5000;
    return differentVersion || differentLength;
  }

  private record(r: ResolutionResult): ResolutionResult {
    this.recent.unshift(r);
    if (this.recent.length > 30) this.recent.length = 30;
    this.emit("resolved", r);
    return r;
  }
}

function dedupe(c: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Map<string, ScoredCandidate>();
  for (const x of c) {
    const k = `${x.source}:${x.sourceTrackId}`;
    const prev = seen.get(k);
    if (!prev || x.score > prev.score) seen.set(k, x);
  }
  return [...seen.values()];
}

function priority(order: SourceId[], id: SourceId): number {
  const i = order.indexOf(id);
  return i < 0 ? 99 : i;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** TrackInfo for the deck, carrying where its metadata vs audio came from. */
export function toResolvedTrack(r: ResolutionResult, c: ScoredCandidate): TrackInfo | null {
  if (!c.track) return null;
  const from: ResolvedFrom = {
    metadataSource: r.requested.source,
    metadataTrackId: r.requested.sourceTrackId,
    requestedTitle: r.requested.title,
    requestedArtist: r.requested.artists.join(", "),
    isrc: r.requested.isrc,
    audioSource: c.source,
    confidence: c.score,
    method: r.userConfirmed ? "manual" : c.method,
  };
  return { ...c.track, resolvedFrom: from };
}

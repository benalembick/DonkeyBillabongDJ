/**
 * Playable audio sources for the SmartTrackResolver.
 *
 *   Source Metadata Provider → TrackIdentity → SmartTrackResolver → PlayableSource → DJ engine
 *
 * A PlayableSource returns candidates the DJ engine may actually play, with
 * the capabilities that source permits. Metadata-only services (Spotify,
 * Apple Music) are never PlayableSources.
 */
import type { TrackInfo } from "../core/engine/types";
import { buildIdentity, type TrackIdentity } from "./identity";

export type SourceId = "local" | "beatport" | "beatsource" | "soundcloud";

export interface SourceCapabilities {
  canPlay: boolean;
  canSeek: boolean;
  canPitchShift: boolean;
  canScratch: boolean;
  canLoop: boolean;
  canAnalyseWaveform: boolean;
  canAnalyseBPM: boolean;
  canSetHotCues: boolean;
  canRecord: boolean;
}

export const FULL_CAPABILITIES: SourceCapabilities = {
  canPlay: true,
  canSeek: true,
  canPitchShift: true,
  canScratch: true,
  canLoop: true,
  canAnalyseWaveform: true,
  canAnalyseBPM: true,
  canSetHotCues: true,
  canRecord: true,
};

export const NO_CAPABILITIES: SourceCapabilities = {
  canPlay: false,
  canSeek: false,
  canPitchShift: false,
  canScratch: false,
  canLoop: false,
  canAnalyseWaveform: false,
  canAnalyseBPM: false,
  canSetHotCues: false,
  canRecord: false,
};

export interface SourceCandidate {
  source: SourceId;
  sourceTrackId: string;
  identity: TrackIdentity;
  /** Loadable track for the DJ engine (null for sources that can't be played). */
  track: TrackInfo | null;
  capabilities: SourceCapabilities;
}

export interface SourceAvailability {
  available: boolean;
  reason?: string;
  docsUrl?: string;
}

export interface PlayableSource {
  readonly id: SourceId;
  readonly name: string;
  /** Local sources answer instantly; remote ones are awaited with a timeout. */
  readonly remote: boolean;
  capabilities(): SourceCapabilities;
  availability(): SourceAvailability;
  search(identity: TrackIdentity, signal?: AbortSignal): Promise<SourceCandidate[]>;
  /** Does a previously resolved target still exist/is it accessible? */
  exists(sourceTrackId: string): boolean | Promise<boolean>;
  /** Build a candidate for a known id (cache hits and manual overrides). */
  candidateFor(sourceTrackId: string): SourceCandidate | null | Promise<SourceCandidate | null>;
}

export function identityFromLocal(t: TrackInfo): TrackIdentity {
  return buildIdentity({
    source: "local",
    sourceTrackId: t.ref,
    title: t.title,
    artists: t.artist ? [t.artist] : [],
    album: t.album,
    durationMs: t.durationMs ?? null,
    isrc: t.isrc,
    bpm: t.bpm,
    key: t.key,
  });
}

const STOP = new Set(["the", "a", "an", "and", "of", "in", "on", "to", "de", "la", "le", "el", "mix", "remix", "edit", "version"]);

/** Local library: an in-memory index (ISRC map + title-word inverted index) rebuilt when the library changes. */
export class LocalLibrarySource implements PlayableSource {
  readonly id = "local" as const;
  readonly name = "Local Library";
  readonly remote = false;
  private byRef = new Map<string, { track: TrackInfo; identity: TrackIdentity }>();
  private byIsrc = new Map<string, string[]>();
  private byWord = new Map<string, string[]>();

  constructor(tracks: TrackInfo[] = []) {
    this.reindex(tracks);
  }

  reindex(tracks: TrackInfo[]): void {
    this.byRef.clear();
    this.byIsrc.clear();
    this.byWord.clear();
    for (const t of tracks) {
      if (t.source !== "local") continue;
      const identity = identityFromLocal(t);
      this.byRef.set(t.ref, { track: t, identity });
      if (identity.isrc) push(this.byIsrc, identity.isrc, t.ref);
      for (const w of words(identity.baseTitle)) push(this.byWord, w, t.ref);
    }
  }

  get size(): number {
    return this.byRef.size;
  }

  capabilities(): SourceCapabilities {
    return FULL_CAPABILITIES;
  }

  availability(): SourceAvailability {
    return this.byRef.size > 0 ? { available: true } : { available: true, reason: "Your local library is empty — add a music folder." };
  }

  async search(identity: TrackIdentity): Promise<SourceCandidate[]> {
    return this.searchSync(identity);
  }

  /** Synchronous search (used for instant local resolution). */
  searchSync(identity: TrackIdentity, limit = 200): SourceCandidate[] {
    const refs = new Set<string>();
    if (identity.isrc) for (const r of this.byIsrc.get(identity.isrc) ?? []) refs.add(r);
    // Candidates share at least one significant title word; rarer words first.
    const ws = words(identity.baseTitle).sort((a, b) => (this.byWord.get(a)?.length ?? 0) - (this.byWord.get(b)?.length ?? 0));
    for (const w of ws) {
      for (const r of this.byWord.get(w) ?? []) {
        refs.add(r);
        if (refs.size >= limit) break;
      }
      if (refs.size >= limit) break;
    }
    return [...refs].map((r) => this.toCandidate(r)!).filter(Boolean);
  }

  /** Free-text search for "Find in my library" (manual matching). */
  query(text: string, limit = 50): TrackInfo[] {
    const q = words(buildIdentity({ source: "q", sourceTrackId: "", title: text, artists: [] }).baseTitle);
    if (q.length === 0) return [];
    const scored: { t: TrackInfo; n: number }[] = [];
    for (const { track, identity } of this.byRef.values()) {
      const hay = `${identity.baseTitle} ${identity.artistKeys.join(" ")} ${track.album.toLowerCase()}`;
      const n = q.filter((w) => hay.includes(w)).length;
      if (n > 0) scored.push({ t: track, n });
    }
    return scored.sort((a, b) => b.n - a.n).slice(0, limit).map((s) => s.t);
  }

  exists(ref: string): boolean {
    return this.byRef.has(ref);
  }

  candidateFor(ref: string): SourceCandidate | null {
    return this.toCandidate(ref);
  }

  private toCandidate(ref: string): SourceCandidate | null {
    const e = this.byRef.get(ref);
    if (!e) return null;
    return { source: "local", sourceTrackId: ref, identity: e.identity, track: e.track, capabilities: FULL_CAPABILITIES };
  }
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

function words(s: string): string[] {
  return [...new Set(s.split(" ").filter((w) => w.length > 1 && !STOP.has(w)))];
}

/**
 * DJ streaming providers researched in September 2026. Their APIs are only
 * available to approved partners, so these adapters report themselves as
 * unavailable and never return candidates. They exist so the resolver,
 * settings and UI are ready for a real integration once access is granted.
 */
class PartnerOnlySource implements PlayableSource {
  readonly remote = true;
  readonly id: SourceId;
  readonly name: string;
  private readonly reason: string;
  private readonly docsUrl: string;

  constructor(id: SourceId, name: string, reason: string, docsUrl: string) {
    this.id = id;
    this.name = name;
    this.reason = reason;
    this.docsUrl = docsUrl;
  }
  capabilities(): SourceCapabilities {
    return NO_CAPABILITIES;
  }
  availability(): SourceAvailability {
    return { available: false, reason: this.reason, docsUrl: this.docsUrl };
  }
  async search(): Promise<SourceCandidate[]> {
    return [];
  }
  exists(): boolean {
    return false;
  }
  candidateFor(): null {
    return null;
  }
}

export function createPartnerOnlySources(): PlayableSource[] {
  return [
    new PartnerOnlySource(
      "beatport",
      "Beatport",
      "Beatport's API (v4) is partner-gated: there is no public developer sign-up, and DJ streaming (Beatport Streaming) is only licensed to partner DJ apps. Needs a partner agreement with Beatport.",
      "https://support.beatport.com/hc/en-us/articles/9901613047572-Why-can-t-I-access-Beatport-in-my-DJ-software",
    ),
    new PartnerOnlySource(
      "beatsource",
      "Beatsource",
      "Beatsource LINK streams only inside partner DJ software (rekordbox, Serato, djay, VirtualDJ…). No public API for third-party DJ playback.",
      "https://link.beatsource.com/",
    ),
    new PartnerOnlySource(
      "soundcloud",
      "SoundCloud",
      "SoundCloud API keys require an approved application, and DJ use of SoundCloud audio (Go+ / DJ plans) is limited to partner DJ apps. Metadata search could be added if an API key is granted; DJ playback would still need a partnership.",
      "https://developers.soundcloud.com/docs/api/register-app",
    ),
  ];
}

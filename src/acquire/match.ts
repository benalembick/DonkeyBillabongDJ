/**
 * Matching rules for Spotify → Local, built on the existing Smart Matching scorer
 * (ISRC model when both sides carry one, otherwise title/artist/duration/version/album).
 *
 * Version text is never stripped for comparison: remix / radio / extended / live / remaster /
 * clean-explicit are classified by identity.ts and conflicting versions lose points, so a
 * "Radio Edit" file can't silently satisfy an "Extended Mix" entry. Anything short of a confident,
 * unambiguous match goes to review.
 */
import { trackInfoFromFileName } from "../library/LibraryStore";
import { buildIdentity, compareVersions, describeVersion, splitArtists, type TrackIdentity } from "../matching/identity";
import { scoreMatch, type MatchConfig, DEFAULT_MATCH_CONFIG } from "../matching/scoring";
import type { ResolutionResult, ScoredCandidate, SmartTrackResolver } from "../matching/SmartTrackResolver";
import type { AcquireMatchConfig, PlaylistEntry, ReviewCandidate, SourceTrack, WatchedFile } from "./types";

export function sourceIdentity(e: { key: string; source: SourceTrack }): TrackIdentity {
  const s = e.source;
  return buildIdentity({
    source: "spotify",
    // Spotify "local file" entries have no id; key them by entry so they never share a mapping.
    sourceTrackId: s.id ?? `entry:${e.key}`,
    title: s.title,
    artists: s.artists.length ? s.artists : [],
    album: s.album,
    durationMs: s.durationMs,
    isrc: s.isrc,
    explicit: s.explicit ?? undefined,
  });
}

/** Identity of a file from its embedded tags, falling back to "Artist - Title" in the file name. */
export function fileIdentity(f: WatchedFile): TrackIdentity {
  const fromName = trackInfoFromFileName(f.path, f.name);
  const title = f.tags.title?.trim() || fromName.title;
  const artist = f.tags.artist?.trim() || fromName.artist;
  return buildIdentity({
    source: "file",
    sourceTrackId: f.path,
    title,
    artists: artist ? splitArtists(artist) : [],
    album: f.tags.album ?? "",
    durationMs: f.tags.durationMs ?? f.quality?.durationMs ?? null,
    isrc: f.tags.isrc,
  });
}

/** Versions that are different recordings, not just a different label for the same audio. */
const DISTINCT_RECORDINGS = new Set(["live", "remix", "acoustic", "instrumental", "dub", "vip", "extended", "club", "other"]);

/**
 * Must a person confirm this pairing? Conflicting versions always; and when one side names a
 * distinct recording (live, remix, extended…) that the other doesn't state, the text can't tell
 * them apart, so it isn't accepted automatically. Radio/edit vs unlabelled stays automatic —
 * the duration check guards those.
 */
export function versionNeedsReview(a: TrackIdentity["version"], b: TrackIdentity["version"]): boolean {
  const c = compareVersions(a, b);
  if (c === "conflict") return true;
  return c === "uncertain" && (DISTINCT_RECORDINGS.has(a.kind) || DISTINCT_RECORDINGS.has(b.kind));
}

export type LibraryMatch =
  | { kind: "accept"; candidate: ScoredCandidate; method: "mapping" | "isrc" | "metadata" | "manual"; result: ResolutionResult }
  | { kind: "review"; candidates: ReviewCandidate[]; result: ResolutionResult }
  | { kind: "none"; result: ResolutionResult };

export function toReview(c: ScoredCandidate, kind: ReviewCandidate["kind"] = "library"): ReviewCandidate {
  return {
    kind,
    id: c.sourceTrackId,
    provider: c.source === "local" ? undefined : c.source,
    label: c.source === "local" ? "Local library" : c.source,
    title: c.identity.title,
    artist: c.identity.artists.join(", "),
    durationMs: c.identity.durationMs,
    version: describeVersion(c.identity.version),
    score: c.score,
    reasons: c.reasons.map((r) => `${r.points > 0 ? "+" : ""}${r.points} ${r.label}`),
  };
}

/** A. Existing local library: saved mapping → ISRC → artist/title/version/duration. */
export function matchLibrary(resolver: SmartTrackResolver, identity: TrackIdentity, cfg: AcquireMatchConfig): LibraryMatch {
  const result = resolver.resolveLocal(identity);
  const best = result.best;
  if (best && result.fromCache && (result.userConfirmed || result.status === "resolved")) {
    return { kind: "accept", candidate: best, method: result.userConfirmed ? "manual" : "mapping", result };
  }
  const reviewable = result.candidates.filter((c) => c.score >= cfg.reviewMin);
  if (best && best.score >= cfg.autoAccept && result.status !== "ambiguous" && !competing(result.candidates, cfg) && !versionNeedsReview(identity.version, best.identity.version)) {
    return { kind: "accept", candidate: best, method: best.method, result };
  }
  if (reviewable.length) return { kind: "review", candidates: reviewable.slice(0, 6).map((c) => toReview(c)), result };
  return { kind: "none", result };
}

/** A second candidate that also clears auto-accept but is a different version or length. */
function competing(c: ScoredCandidate[], cfg: AcquireMatchConfig): boolean {
  if (c.length < 2 || c[1].score < cfg.autoAccept) return false;
  const a = c[0].identity;
  const b = c[1].identity;
  return compareVersions(a.version, b.version) === "conflict" || (a.durationMs != null && b.durationMs != null && Math.abs(a.durationMs - b.durationMs) > 5000);
}

export type FileMatch =
  | { kind: "accept"; keys: string[]; score: number; reasons: string[]; version: string }
  | { kind: "review"; options: { key: string; candidate: ReviewCandidate }[] }
  | { kind: "none"; best: number };

/**
 * B. A file arrived in the watched folder: which unresolved entries does it satisfy?
 * Entries with the same Spotify id are the same recording, so one file resolves all of them.
 */
export function matchFileToEntries(file: WatchedFile, entries: PlaylistEntry[], cfg: AcquireMatchConfig, matchCfg: MatchConfig = DEFAULT_MATCH_CONFIG): FileMatch {
  const fid = fileIdentity(file);
  const scored = entries
    .map((e) => ({ e, s: scoreMatch(sourceIdentity(e), fid, matchCfg) }))
    .sort((a, b) => b.s.score - a.s.score);
  if (!scored.length || scored[0].s.score < cfg.reviewMin) return { kind: "none", best: scored[0]?.s.score ?? 0 };
  const top = scored[0];
  const sameRecording = (e: PlaylistEntry) => (top.e.source.id ? e.source.id === top.e.source.id : e.key === top.e.key);
  // Another entry (a different recording) scoring almost as well → the file is ambiguous.
  const rival = scored.find((x) => !sameRecording(x.e) && x.s.score >= cfg.reviewMin && top.s.score - x.s.score < matchCfg.ambiguityMargin);
  const durationOk = durationCheck(top.e.source.durationMs, fid.durationMs, cfg).ok;
  const reasons = top.s.reasons.map((r) => `${r.points > 0 ? "+" : ""}${r.points} ${r.label}`);
  if (top.s.score >= cfg.autoAccept && !rival && durationOk && !versionNeedsReview(sourceIdentity(top.e).version, fid.version)) {
    return { kind: "accept", keys: entries.filter(sameRecording).map((e) => e.key), score: top.s.score, reasons, version: describeVersion(fid.version) };
  }
  const options = scored
    .filter((x) => x.s.score >= cfg.reviewMin)
    .slice(0, 4)
    .map((x) => ({
      key: x.e.key,
      candidate: {
        kind: "file" as const,
        id: file.path,
        label: "Watched folder",
        title: fid.title,
        artist: fid.artists.join(", "),
        durationMs: fid.durationMs,
        version: describeVersion(fid.version),
        score: x.s.score,
        reasons: x.s.reasons.map((r) => `${r.points > 0 ? "+" : ""}${r.points} ${r.label}`),
      },
    }));
  return { kind: "review", options };
}

/** Is the file's length plausible for the Spotify entry? Unknown lengths are not treated as proof. */
export function durationCheck(expectedMs: number | null, actualMs: number | null, cfg: AcquireMatchConfig): { ok: boolean; message?: string } {
  if (actualMs == null || actualMs <= 0) return { ok: false, message: "File duration unknown" };
  if (actualMs < 5000) return { ok: false, message: `File is only ${(actualMs / 1000).toFixed(1)} s long` };
  if (expectedMs == null || expectedMs <= 0) return { ok: true };
  const delta = Math.abs(actualMs - expectedMs) / 1000;
  if (delta > cfg.durationToleranceS) return { ok: false, message: `Length differs from Spotify by ${Math.round(delta)} s (${fmt(actualMs)} vs ${fmt(expectedMs)})` };
  return { ok: true };
}

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

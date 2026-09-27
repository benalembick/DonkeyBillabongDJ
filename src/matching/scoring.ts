/**
 * Transparent match scoring. Every point awarded or removed is recorded as a
 * MatchReason so the UI can explain exactly why a candidate was (not) chosen.
 *
 * Two models:
 *  - ISRC model (both sides carry the same ISRC): ISRC 70 + artist 10 + title 10 + duration 10
 *  - Metadata model (no shared ISRC): title 35 + artist 25 + duration 20 + version 10 + album 10
 * Penalties apply in both for version conflicts and large duration gaps.
 */
import { compareVersions, describeVersion, type TrackIdentity, type VersionCompatibility } from "./identity";

export interface MatchConfig {
  /** Duration tolerances in seconds (heuristics, not absolute rules). */
  durationVeryStrongS: number;
  durationStrongS: number;
  durationPossibleS: number;
  /** Minimum confidence for loading without asking. */
  autoLoadMin: number;
  /** Two candidates within this many points (and materially different) → ask the user. */
  ambiguityMargin: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  durationVeryStrongS: 2,
  durationStrongS: 5,
  durationPossibleS: 15,
  autoLoadMin: 85,
  ambiguityMargin: 10,
};

export type ConfidenceBand = "exact" | "high" | "possible" | "none";

export function bandFor(score: number): ConfidenceBand {
  if (score >= 95) return "exact";
  if (score >= 85) return "high";
  if (score >= 70) return "possible";
  return "none";
}

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  exact: "Exact / very high confidence",
  high: "High confidence",
  possible: "Possible match",
  none: "Not a reliable match",
};

export interface MatchReason {
  label: string;
  points: number;
}

export interface MatchDetails {
  isrc: "match" | "differ" | "missing";
  titleSimilarity: number;
  artistSimilarity: number;
  durationDeltaS: number | null;
  version: VersionCompatibility;
}

export interface MatchScore {
  score: number;
  band: ConfidenceBand;
  method: "isrc" | "metadata";
  reasons: MatchReason[];
  details: MatchDetails;
}

/** Sørensen–Dice coefficient on character bigrams (0..1). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/** Fraction of the requested artists present in the candidate (fuzzy per name), primary artist weighted. */
export function artistSimilarity(req: string[], cand: string[]): { score: number; primaryMatch: boolean } {
  if (req.length === 0 || cand.length === 0) return { score: 0, primaryMatch: false };
  const has = (name: string) => cand.some((c) => c === name || similarity(c, name) >= 0.9);
  const primaryMatch = has(req[0]);
  const found = req.filter(has).length;
  // Also credit when the candidate's own primary artist is one of ours (credits ordered differently).
  const candPrimaryInReq = req.some((r) => r === cand[0] || similarity(r, cand[0]) >= 0.9);
  const score = Math.max(found / req.length, candPrimaryInReq ? 0.6 : 0);
  return { score, primaryMatch: primaryMatch || candPrimaryInReq };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function scoreMatch(req: TrackIdentity, cand: TrackIdentity, cfg: MatchConfig = DEFAULT_MATCH_CONFIG): MatchScore {
  const reasons: MatchReason[] = [];
  const add = (label: string, points: number) => reasons.push({ label, points });

  const isrc: MatchDetails["isrc"] = req.isrc && cand.isrc ? (req.isrc === cand.isrc ? "match" : "differ") : "missing";
  const titleSim = similarity(req.baseTitle, cand.baseTitle);
  const art = artistSimilarity(req.artistKeys, cand.artistKeys);
  const deltaS = req.durationMs != null && cand.durationMs != null ? Math.abs(req.durationMs - cand.durationMs) / 1000 : null;
  const version = compareVersions(req.version, cand.version);
  const details: MatchDetails = { isrc, titleSimilarity: titleSim, artistSimilarity: art.score, durationDeltaS: deltaS, version };

  const durationPoints = (veryStrong: number, strong: number, possible: number, unknown: number, beyond: number) => {
    if (deltaS == null) return add("Duration unknown", unknown);
    const d = `${deltaS < 10 ? deltaS.toFixed(1) : Math.round(deltaS)} s`;
    if (deltaS < cfg.durationVeryStrongS) add(`Duration within ${d}`, veryStrong);
    else if (deltaS < cfg.durationStrongS) add(`Duration differs by ${d}`, strong);
    else if (deltaS < cfg.durationPossibleS) add(`Duration differs by ${d}`, possible);
    else add(`Duration differs by ${d} — likely a different edit`, beyond);
  };
  const versionText = `${describeVersion(req.version)} vs ${describeVersion(cand.version)}`;

  let method: MatchScore["method"];
  if (isrc === "match") {
    method = "isrc";
    add(`ISRC exact (${req.isrc})`, 70);
    if (art.score >= 0.99) add("Artist exact", 10);
    else if (art.primaryMatch || art.score >= 0.5) add(`Artist ${pct(art.score)}`, 6);
    else add("Artist differs", -10);
    if (titleSim >= 0.99) add("Title exact", 10);
    else if (titleSim >= 0.85) add(`Title ${pct(titleSim)}`, 6);
    else add(`Title differs (${pct(titleSim)})`, -10);
    durationPoints(10, 7, 3, 5, -15);
    if (version === "conflict") add(`Version conflict: ${versionText}`, -25);
    else if (version === "uncertain") add(`Version not confirmed: ${versionText}`, 0);
    else add("Version compatible", 0);
  } else {
    method = "metadata";
    if (titleSim >= 0.99) add("Title exact", 35);
    else if (titleSim >= 0.9) add(`Title ${pct(titleSim)}`, 28);
    else if (titleSim >= 0.8) add(`Title ${pct(titleSim)}`, 18);
    else add(`Title differs (${pct(titleSim)})`, 0);

    if (art.score >= 0.99) add("Artist exact", 25);
    else if (art.primaryMatch) add(`Primary artist matches (${pct(art.score)} of credits)`, 18);
    else if (art.score > 0) add(`Artist partly matches (${pct(art.score)})`, 10);
    else add("Artist differs", 0);

    durationPoints(20, 15, 8, 6, -20);

    if (version === "match" || version === "compatible") add(`Version ${version === "match" ? "match" : "compatible"}: ${versionText}`, 10);
    else if (version === "uncertain") add(`Version not confirmed: ${versionText}`, 4);
    else add(`Version conflict: ${versionText}`, -30);

    const reqAlbum = req.album.trim().toLowerCase();
    const candAlbum = cand.album.trim().toLowerCase();
    if (!reqAlbum || !candAlbum) add("Album unknown on one side", 5);
    else if (similarity(reqAlbum, candAlbum) >= 0.9) add("Album match", 10);
    else add("Different release/album", 0);

    if (isrc === "differ") add(`Different ISRC (${req.isrc} vs ${cand.isrc}) — may be a different recording`, -15);
    else add("No shared ISRC", 0);
  }

  let score = reasons.reduce((s, r) => s + r.points, 0);
  // Hard caps: a weak title or artist can't be rescued by other signals.
  if (titleSim < 0.8) score = Math.min(score, 40);
  if (method === "metadata" && art.score === 0) score = Math.min(score, 50);
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: bandFor(score), method, reasons, details };
}

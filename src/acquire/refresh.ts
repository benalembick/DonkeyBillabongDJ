/**
 * "Refresh from Spotify": compare the linked job's entries with the playlist's current contents.
 * Entries are paired by Spotify id (and occurrence, so intentional repeats pair one-to-one);
 * paired entries keep their local file, review choices and Auto DJ flag. Removed entries leave
 * the playlist but their audio files and preparation (cues, beatgrids) are never touched.
 */
import type { EntryKind, PlaylistEntry, SourceTrack } from "./types";

export interface IncomingEntry {
  kind: EntryKind;
  track: SourceTrack;
}

export interface RefreshPreview {
  added: { position: number; track: SourceTrack }[];
  removed: PlaylistEntry[];
  /** Entries whose order changed relative to the others (not just shifted by inserts/removals). */
  moved: { entry: PlaylistEntry; from: number; to: number }[];
  unchanged: number;
}

export function entryMatchKey(kind: EntryKind, t: SourceTrack): string {
  if (t.id) return `id:${t.id}`;
  return `${kind}:${t.title.toLowerCase()}|${t.artists.join(",").toLowerCase()}|${t.durationMs ?? ""}`;
}

/** For each incoming position, the current entry it pairs with (or null when new). */
export function pairEntries(current: PlaylistEntry[], incoming: IncomingEntry[]): (PlaylistEntry | null)[] {
  const pool = new Map<string, PlaylistEntry[]>();
  for (const e of [...current].sort((a, b) => a.position - b.position)) {
    const k = entryMatchKey(e.kind, e.source);
    pool.set(k, [...(pool.get(k) ?? []), e]);
  }
  return incoming.map((x) => pool.get(entryMatchKey(x.kind, x.track))?.shift() ?? null);
}

export function previewRefresh(current: PlaylistEntry[], incoming: IncomingEntry[]): RefreshPreview {
  const pairs = pairEntries(current, incoming);
  const used = new Set(pairs.filter(Boolean).map((e) => e!.key));
  const matched = pairs.map((e, to) => (e ? { entry: e, from: e.position, to } : null)).filter(Boolean) as { entry: PlaylistEntry; from: number; to: number }[];
  const stay = longestIncreasing(matched.map((m) => m.from));
  return {
    added: pairs.map((e, i) => (e ? null : { position: i, track: incoming[i].track })).filter(Boolean) as RefreshPreview["added"],
    removed: current.filter((e) => !used.has(e.key)),
    moved: matched.filter((_, i) => !stay.has(i)),
    unchanged: stay.size,
  };
}

/** Indices (into `xs`) of one longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]] < xs[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}

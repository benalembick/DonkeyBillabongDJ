/**
 * Match streaming tracks to files in the local library by artist + title, so
 * a Spotify / Apple Music playlist can be used as a crate of your own files.
 */
import type { TrackInfo } from "../core/engine/types";

/** Lower-case, strip accents, "feat." credits, bracketed mix/remaster notes and punctuation. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*[([].*?(remaster|version|edit|mono|stereo|feat|ft\.|with ).*?[)\]]/g, "")
    .replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?.*$/g, "")
    .replace(/\b(feat|ft)\.?\s.*$/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function artistTokens(s: string): Set<string> {
  return new Set(
    normalizeTitle(s.replace(/\s*(,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?)\s*/gi, "|"))
      .split(" ")
      .filter((w) => w.length > 1),
  );
}

export interface LocalIndex {
  find(title: string, artist: string): TrackInfo | null;
}

export function buildLocalIndex(tracks: TrackInfo[]): LocalIndex {
  const byTitle = new Map<string, TrackInfo[]>();
  for (const t of tracks) {
    // Files named "Title" without artist still index; artist then only breaks ties.
    const k = normalizeTitle(t.title);
    if (!k) continue;
    const list = byTitle.get(k) ?? [];
    list.push(t);
    byTitle.set(k, list);
  }
  return {
    find(title, artist) {
      const candidates = byTitle.get(normalizeTitle(title));
      if (!candidates) return null;
      const want = artistTokens(artist);
      let best: TrackInfo | null = null;
      let bestScore = -1;
      for (const c of candidates) {
        const have = artistTokens(c.artist);
        let score = 0;
        for (const w of want) if (have.has(w)) score++;
        if (have.size > 0 && score === 0) continue; // different artist with the same title
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      return best;
    },
  };
}

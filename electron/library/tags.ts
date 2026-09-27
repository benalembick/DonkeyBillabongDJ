/**
 * Reads embedded tags (title, artist, album, ISRC, duration, BPM, key…) from
 * local audio files. Read-only: files are never modified.
 *
 * ISRC sources (via music-metadata's common mapping): ID3v2 TSRC (MP3, AIFF,
 * WAV id3 chunk), Vorbis comment ISRC (FLAC/OGG), MP4 ----:com.apple.iTunes:ISRC (M4A/AAC).
 */
import { parseFile, selectCover } from "music-metadata";
import { artUrl, storeArtwork } from "./artwork";
import type { TagResult } from "../../src/library/tags";

async function readOne(filePath: string): Promise<TagResult> {
  try {
    const m = await parseFile(filePath, { skipCovers: false, duration: false });
    const c = m.common;
    const cover = selectCover(c.picture);
    const art = cover?.data?.length ? await storeArtwork(cover.data) : null;
    return {
      artworkUrl: art ? artUrl(art) : undefined,
      ref: filePath,
      ok: true,
      title: c.title,
      artist: c.artists?.length ? c.artists.join(", ") : c.artist,
      album: c.album,
      isrc: c.isrc?.[0],
      durationMs: m.format.duration ? Math.round(m.format.duration * 1000) : undefined,
      bpm: c.bpm ? Math.round(c.bpm * 100) / 100 : undefined,
      key: c.key,
      genre: c.genre?.[0],
      year: c.year,
    };
  } catch (err) {
    return { ref: filePath, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read tags for many files with bounded concurrency. */
export async function readTags(paths: string[], concurrency = 4): Promise<TagResult[]> {
  const out: TagResult[] = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      out[i] = await readOne(paths[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

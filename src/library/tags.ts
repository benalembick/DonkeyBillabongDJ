/** Tag data read from a local audio file (shared by the main process and renderer). */
import type { TrackInfo } from "../core/engine/types";
import { normalizeIsrc } from "../matching/identity";

export interface TagResult {
  ref: string;
  ok: boolean;
  error?: string;
  title?: string;
  artist?: string;
  album?: string;
  isrc?: string;
  durationMs?: number;
  bpm?: number;
  key?: string;
  genre?: string;
  year?: number;
  /** Cached embedded cover (dbdj-art://img/<hash>) when the file has one. */
  artworkUrl?: string;
  lyrics?: string;
}

/**
 * Fields to write back into a local audio file's own tags. A field left out
 * (undefined) is untouched; an empty string / null clears it.
 */
export interface TagPatch {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number | null;
  /** New cover art from an image file path (desktop main process reads it), or `null` to remove embedded artwork. Left out: untouched. */
  artwork?: { path: string } | null;
}

/** Merge tags into a library track. Tags win over filename-derived values when present. */
export function applyTags(t: TrackInfo, tags: TagResult): TrackInfo {
  if (!tags.ok) return { ...t, tagsRead: true };
  return {
    ...t,
    title: tags.title?.trim() || t.title,
    artist: tags.artist?.trim() || t.artist,
    album: tags.album?.trim() || t.album,
    isrc: normalizeIsrc(tags.isrc) ?? t.isrc ?? null,
    durationMs: tags.durationMs ?? t.durationMs,
    bpm: tags.bpm ?? t.bpm,
    key: tags.key ?? t.key,
    genre: tags.genre ?? t.genre,
    year: tags.year ?? t.year,
    artworkUrl: tags.artworkUrl ?? t.artworkUrl,
    lyrics: tags.lyrics?.trim() || t.lyrics,
    tagsRead: true,
    artworkRead: true,
  };
}

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
    tagsRead: true,
  };
}

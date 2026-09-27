/** Audius → app models (TrackInfo for decks, TrackIdentity for Smart Match). */
import type { TrackInfo } from "../../core/engine/types";
import { buildIdentity, type TrackIdentity } from "../../matching/identity";
import type { AudiusTrack } from "./AudiusClient";

export const audiusRef = (id: string) => `audius:${id}`;
export const audiusIdFromRef = (ref: string) => (ref.startsWith("audius:") ? ref.slice(7) : ref);

export function audiusToTrackInfo(t: AudiusTrack): TrackInfo {
  return {
    ref: audiusRef(t.id),
    title: t.title,
    artist: t.artist,
    album: t.album,
    source: "audius",
    bpm: t.bpm,
    key: t.key,
    durationMs: t.durationMs,
    artworkUrl: t.artworkUrl,
    externalUrl: t.permalink,
    isrc: t.isrc,
    genre: t.genre || undefined,
    unavailableReason: t.streamable ? undefined : t.unavailableReason,
  };
}

/**
 * Identity for matching. Audius hosts many covers, remixes, flips and bootlegs
 * uploaded by other artists, so its own flags override the title text:
 * covers and remixes are never treated as the original recording.
 */
export function audiusIdentity(t: AudiusTrack): TrackIdentity {
  const id = buildIdentity({
    source: "audius",
    sourceTrackId: t.id,
    title: t.title,
    artists: [t.artist],
    album: t.album,
    durationMs: t.durationMs,
    isrc: t.isrc,
    releaseDate: t.releaseDate,
    artworkUrl: t.artworkUrl,
    bpm: t.bpm,
    key: t.key,
  });
  if (t.coverOf) {
    id.version = { kind: "other", raw: `Cover of ${t.coverOf.title}${t.coverOf.artist ? ` by ${t.coverOf.artist}` : ""}`, explicitlyStated: true };
  } else if (t.remixOf && id.version.kind !== "remix") {
    id.version = { kind: "remix", raw: "Remix (per Audius)", remixer: undefined, explicitlyStated: true };
  }
  return id;
}

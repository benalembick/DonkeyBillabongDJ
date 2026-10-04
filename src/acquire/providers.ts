/**
 * Acquisition providers: replaceable adapters that find and download a missing file.
 *
 * Responsibilities are split so each can be swapped independently:
 *   Spotify metadata retrieval ...... SpotifyMetadata (streaming bridge; never audio)
 *   Audio candidate search .......... AcquisitionProvider.search
 *   Match verification .............. scoreMatch (src/matching) in SpotifyLocalService
 *   File download ................... Downloader (desktop main process: temp file → validate → move)
 *   Local library ingestion ......... SpotifyLocalService → App.addFiles (tags, analysis)
 *
 * Every provider that can download is offered; the UI reminds the user to only download tracks
 * they have permission to. An unavailable provider never blocks local matching or watched-folder
 * ingestion.
 */
import type { AudiusClient, AudiusTrack } from "../providers/audius/AudiusClient";
import { audiusIdentity } from "../providers/audius/audiusTracks";
import type { TrackIdentity } from "../matching/identity";
import type { DownloadResult, SpotifySourceResult } from "./types";
import type { SpotifyRef } from "./spotifyRef";

/** Shown wherever downloading can be switched on or happens. */
export const PERMISSION_REMINDER =
  "Only download tracks you have permission to download — for example tracks you've bought, that are licensed to you, or that the rights holder makes available. You are responsible for what you download.";

export interface ProviderCandidate {
  provider: string;
  /** Provider-side id (e.g. Audius track id). */
  id: string;
  identity: TrackIdentity;
  /** Download URL the main process re-validates against the provider's rules before fetching. */
  downloadUrl: string;
  /** Suggested file name stem ("Artist - Title"). */
  name: string;
  /** Shown instead of a match score when the provider picks the recording itself (e.g. spotDL). */
  matchNote?: string;
}

export interface ProviderState {
  available: boolean;
  /** Why it can't be used, or what it needs. */
  reason?: string;
  setup?: string;
}

export interface AcquisitionProvider {
  readonly id: string;
  readonly name: string;
  /** Where the audio actually comes from — shown next to every file it provides. */
  readonly audioSource: string;
  /** False for adapters listed for information only (they never download). */
  readonly canDownload: boolean;
  readonly note: string;
  /** `force` re-checks instead of using a cached result (the user pressed "Check again"). */
  state(force?: boolean): Promise<ProviderState>;
  search(identity: TrackIdentity, signal?: AbortSignal): Promise<ProviderCandidate[]>;
}

export interface Downloader {
  /** Fetch to a temporary file, validate it, then move it into the destination folder. */
  download(c: { provider: string; candidateId: string; url: string; name: string; expectedDurationMs: number | null }, onProgress: (p: number) => void, signal: AbortSignal): Promise<DownloadResult>;
}

export interface SpotifyMetadata {
  /** Playlist / liked songs / single track as ordered entries. Throws with an actionable message. */
  resolve(ref: SpotifyRef): Promise<SpotifySourceResult>;
}

/**
 * Audius: tracks whose artist enabled downloads (and that aren't gated behind follow /
 * purchase / NFT conditions) via the official /v1/tracks/{id}/download endpoint. Audius
 * catalogue is mostly independent artists, so many commercial Spotify tracks won't be there.
 */
export class AudiusAcquisition implements AcquisitionProvider {
  readonly id = "audius";
  readonly name = "Audius";
  readonly audioSource = "Audius (artist-enabled download)";
  readonly canDownload = true;
  readonly note = "Official Audius API. Only tracks the artist made downloadable; gated tracks are skipped. Saves the artist's original upload.";

  constructor(private client: AudiusClient) {}

  async state(): Promise<ProviderState> {
    const s = this.client.stats.apiStatus;
    if (s === "ok") return { available: true };
    const r = await this.client.testConnection();
    return r.ok ? { available: true } : { available: false, reason: `Audius API unreachable: ${r.error ?? "network error"}` };
  }

  async search(identity: TrackIdentity): Promise<ProviderCandidate[]> {
    const artist = identity.artists[0] ?? "";
    // Keep version words in the query: "Song (Extended Mix)" must not find only the radio edit.
    const q = `${artist} ${identity.title}`.replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
    let tracks: AudiusTrack[] = await this.client.searchTracks(q, 10);
    if (!tracks.length && identity.title) tracks = await this.client.searchTracks(identity.title, 10);
    return tracks
      .filter((t) => t.downloadable)
      .map((t) => ({
        provider: this.id,
        id: t.id,
        identity: audiusIdentity(t),
        downloadUrl: this.client.downloadUrl(t.id),
        name: `${t.artist} - ${t.title}`,
      }));
  }
}

export interface ToolStatus {
  available: boolean;
  version?: string;
  reason?: string;
  setup?: string;
}

/**
 * spotDL (https://github.com/spotDL/spotify-downloader), the user's own installed command-line
 * tool, run by the desktop app. Given a Spotify track link it searches YouTube / YouTube Music for
 * a matching recording and downloads that audio — not the Spotify master. The file's length is
 * checked against Spotify's before it's accepted, and its tags come from Spotify.
 */
export class SpotDLAcquisition implements AcquisitionProvider {
  readonly id = "spotdl";
  readonly name = "spotDL";
  readonly audioSource = "YouTube Music via spotDL (metadata match, not the Spotify master)";
  readonly canDownload = true;
  readonly note =
    "Your installed spotDL picks a YouTube / YouTube Music recording for each Spotify track (about 128 kbps; 256 kbps with YouTube Music Premium). The audio is kept as YouTube serves it, without re-encoding where possible, and rejected if its length doesn't match Spotify's.";

  constructor(private tool: ((force?: boolean) => Promise<ToolStatus>) | null) {}

  async state(force = false): Promise<ProviderState> {
    if (!this.tool) return { available: false, reason: "spotDL runs only in the desktop app." };
    // Cached unless forced: starting Python to ask spotDL its version is slow while downloads run.
    const s = await this.tool(force);
    if (!s.available) return { available: false, reason: s.reason, setup: s.setup };
    return { available: true, reason: s.version ? `spotDL ${s.version}` : undefined };
  }

  async search(identity: TrackIdentity): Promise<ProviderCandidate[]> {
    // spotDL works from the Spotify track itself; Spotify "local file" entries have no link.
    if (identity.source !== "spotify" || !/^[A-Za-z0-9]{22}$/.test(identity.sourceTrackId)) return [];
    return [
      {
        provider: this.id,
        id: identity.sourceTrackId,
        identity,
        downloadUrl: `https://open.spotify.com/track/${identity.sourceTrackId}`,
        name: `${identity.artists.join(", ")} - ${identity.title}`,
        matchNote: "YouTube match chosen by spotDL; length checked against Spotify",
      },
    ];
  }
}

/**
 * spottydl (https://github.com/Thanatoslayer6/spottydl) is a Node library with the same approach
 * (Spotify metadata → YouTube Music audio). It isn't bundled with the app; spotDL covers the same
 * route as a separately installed tool.
 */
class SpottydlInfo implements AcquisitionProvider {
  readonly id = "spottydl";
  readonly name = "spottydl";
  readonly audioSource = "YouTube Music (metadata match, not the Spotify master)";
  readonly canDownload = false;
  readonly note = "Node library: scrapes Spotify metadata and downloads the matching YouTube Music audio (needs FFmpeg ≥ 4). Same audio source as spotDL.";
  async state(): Promise<ProviderState> {
    return { available: false, reason: "Not bundled with the app — use spotDL, which downloads from the same YouTube Music source." };
  }
  async search(): Promise<ProviderCandidate[]> {
    return [];
  }
}

export function informationalProviders(): AcquisitionProvider[] {
  return [new SpottydlInfo()];
}

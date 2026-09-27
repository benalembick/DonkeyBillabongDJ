/**
 * Streaming / music provider abstraction (Phase 5 fills in real providers).
 *
 * The DJ engine never assumes a provider's audio may enter the mixing
 * pipeline: that is declared per provider through PlaybackCapabilities and
 * enforced by the engine and recorder. See docs/STREAMING-INTEGRATIONS.md.
 */
import type { TrackInfo, TrackSource } from "../core/engine/types";

export interface PlaybackCapabilities {
  /** Audio may be decoded into our engine (waveforms, tempo, EQ, scratching, mixing). */
  canLoadIntoDeck: boolean;
  /** Provider-controlled playback only (e.g. an official SDK player), no mixing. */
  canPreviewExternally: boolean;
  /** Mix recordings may include this provider's audio. */
  canRecord: boolean;
  /** Human-readable reason shown in the UI when something is unavailable. */
  restriction?: string;
}

export interface ProviderPlaylist {
  id: string;
  name: string;
  trackCount: number;
  artworkUrl?: string;
}

export interface MusicProvider {
  readonly id: TrackSource;
  readonly displayName: string;
  isAuthenticated(): boolean;
  authenticate(): Promise<void>;
  signOut(): Promise<void>;
  search(query: string): Promise<TrackInfo[]>;
  getTrack(id: string): Promise<TrackInfo | null>;
  getPlaylist(id: string): Promise<TrackInfo[]>;
  getUserPlaylists(): Promise<ProviderPlaylist[]>;
  getArtwork(track: TrackInfo): Promise<string | null>;
  getPlaybackCapabilities(): PlaybackCapabilities;
}

/**
 * Capability declarations from the Phase 0 research (September 2026). Public
 * developer APIs for both services allow metadata/library access only; DJ
 * mixing is limited to privately licensed partner integrations.
 */
export const PROVIDER_CAPABILITIES: Record<TrackSource, PlaybackCapabilities> = {
  local: { canLoadIntoDeck: true, canPreviewExternally: false, canRecord: true },
  audius: {
    canLoadIntoDeck: true,
    canPreviewExternally: false,
    // The Open Music License grants streaming/performance "in connection with a Music Player's services";
    // making a fixed recording (a derivative mix) is not expressly granted, so recording is disabled.
    canRecord: false,
    restriction: "Audius tracks stream under the Audius Open Music License. Recording mixes that contain Audius audio is disabled.",
  },
  spotify: {
    canLoadIntoDeck: false,
    canPreviewExternally: false,
    canRecord: false,
    restriction:
      "Spotify's Developer Terms and policy prohibit using Spotify content to mix, segue, overlap or alter audio, and forbid stream capture. " +
      "DJ mixing of Spotify is only available in partner apps with a separate licence. Browsing and metadata only.",
  },
  "apple-music": {
    canLoadIntoDeck: false,
    canPreviewExternally: true,
    canRecord: false,
    restriction:
      "Apple Music catalogue audio is DRM-protected; MusicKit playback cannot be routed into third-party DSP. " +
      "DJ mixing is only available to Apple's licensed DJ partners. Browsing, metadata and MusicKit playback only.",
  },
};

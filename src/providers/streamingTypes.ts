/**
 * Types shared by the Electron main process (which talks to the streaming
 * services and holds the credentials) and the renderer (which shows them).
 * Pure types only — safe to import from both sides.
 */

export type StreamingProviderId = "spotify" | "apple-music";

export interface StreamingTrack {
  provider: StreamingProviderId;
  id: string;
  title: string;
  artist: string;
  /** Individual artist credits, in order. */
  artists?: string[];
  album: string;
  durationMs: number;
  releaseDate?: string;
  explicit?: boolean;
  artworkUrl?: string;
  isrc?: string;
  externalUrl?: string;
}

export interface StreamingPlaylist {
  id: string;
  name: string;
  trackCount: number;
  artworkUrl?: string;
  /** False when the service will not return the playlist's tracks to this app (e.g. Spotify playlists you don't own). */
  readable: boolean;
  note?: string;
}

export interface ProviderStatus {
  provider: StreamingProviderId;
  /** Credentials (client id / developer token) are present. */
  configured: boolean;
  /** A user account is authorised. */
  connected: boolean;
  account?: string;
  detail?: string;
  error?: string;
  /** Values the user must register with the service (shown in the setup form). */
  redirectUri?: string;
}

export interface SpotifyConfig {
  clientId: string;
}

export interface AppleMusicConfig {
  /** Either paste a ready-made MusicKit developer token (JWT)… */
  developerToken?: string;
  /** …or let the app sign one from a MusicKit key. */
  teamId?: string;
  keyId?: string;
  /** Contents of the AuthKey_XXXX.p8 file. */
  privateKey?: string;
}

export type StreamingConfig = SpotifyConfig | AppleMusicConfig;

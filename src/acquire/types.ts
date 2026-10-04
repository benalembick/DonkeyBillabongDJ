/**
 * Spotify → Local: types shared by the renderer service, the UI and the desktop main process.
 *
 * Spotify supplies only the playlist reference and metadata. The audio that plays is always a
 * local file: one already in the library, one dropped into the watched download folder (e.g. by
 * an external converter), or one fetched from an authorised download provider.
 *
 * Source metadata (what Spotify says) and local-file metadata (what the file is) are stored in
 * separate fields and never merged: a missing ISRC stays missing.
 */

/** Per-entry pipeline state. "analysing" entries are already playable (audio ready, analysis pending). */
export type EntryState =
  | "pending"
  | "matching"
  | "awaiting-file"
  | "needs-review"
  | "downloading"
  | "importing"
  | "analysing"
  | "ready"
  | "failed"
  | "cancelled";

export const STATE_LABEL: Record<EntryState, string> = {
  pending: "Pending",
  matching: "Matching",
  "awaiting-file": "Awaiting File",
  "needs-review": "Needs Review",
  downloading: "Downloading",
  importing: "Importing",
  analysing: "Analysing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Text icons so a state reads without relying on colour. */
export const STATE_ICON: Record<EntryState, string> = {
  pending: "○",
  matching: "⌕",
  "awaiting-file": "⏳",
  "needs-review": "?",
  downloading: "⇩",
  importing: "⇥",
  analysing: "◔",
  ready: "✓",
  failed: "✕",
  cancelled: "⊘",
};

/** States in which the entry's local file is validated, registered and loadable. */
export const PLAYABLE_STATES: ReadonlySet<EntryState> = new Set(["analysing", "ready"]);
/** States the pipeline is actively working on (reset to "pending" after a restart). */
export const TRANSIENT_STATES: ReadonlySet<EntryState> = new Set(["matching", "downloading", "importing"]);

/** What Spotify reported for one playlist position. Never enriched with guessed values. */
export interface SourceTrack {
  /** Spotify track id (base62), or null for Spotify "local file" entries. */
  id: string | null;
  uri: string | null;
  title: string;
  artists: string[];
  album: string;
  durationMs: number | null;
  explicit: boolean | null;
  /** Only when Spotify returned one (Development Mode apps no longer receive external_ids). */
  isrc: string | null;
  url: string | null;
}

export type EntryKind = "track" | "episode" | "spotify-local-file" | "unavailable";

/** Technical metadata read from the actual file (not from Spotify). */
export interface AudioQuality {
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
  lossless: boolean | null;
  durationMs: number | null;
  sizeBytes: number | null;
}

export type Origin = "library" | "watch-folder" | "provider" | "manual";

/** Where an entry's local file came from and why it was accepted. */
export interface Provenance {
  origin: Origin;
  /** Provider id for downloads ("audius"), else null. */
  provider: string | null;
  /** Human-readable audio source, e.g. "Local library", "Watched folder", "Audius (artist-enabled download)". */
  audioSource: string;
  /** Provider-side candidate id (e.g. Audius track id). */
  candidateId: string | null;
  confidence: number;
  method: "mapping" | "isrc" | "metadata" | "manual";
  /** Version accepted for this entry (e.g. "Extended Mix", "no version stated"). */
  version: string;
  matchedAt: number;
  /** Shown instead of the score when the provider chose the recording itself (e.g. spotDL). */
  note?: string;
}

export interface LocalFile {
  ref: string;
  title: string;
  artist: string;
  quality: AudioQuality | null;
  provenance: Provenance;
}

/** A candidate offered for review (library track, watched file or provider result). */
export interface ReviewCandidate {
  kind: "library" | "file" | "provider";
  /** Library ref / file path / provider candidate id. */
  id: string;
  provider?: string;
  label: string;
  title: string;
  artist: string;
  durationMs: number | null;
  version: string;
  score: number;
  reasons: string[];
}

export interface PlaylistEntry {
  /** Stable key for this playlist position (survives reorders and refreshes). */
  key: string;
  /** Position in the Spotify playlist (0-based). Repeated tracks keep separate entries. */
  position: number;
  kind: EntryKind;
  source: SourceTrack;
  state: EntryState;
  /** Latest progress or error message shown next to the state. */
  detail: string;
  attempts: number;
  local: LocalFile | null;
  review: ReviewCandidate[];
  /** Download progress 0..1 while downloading. */
  progress?: number;
  /** Queued to Auto DJ once (never twice). */
  queued: boolean;
  /** Analysis outcome once audio is ready. */
  analysis: "pending" | "done" | "skipped";
  updatedAt: number;
}

export type JobSourceKind = "playlist" | "liked" | "track" | "selection";

export interface JobSource {
  kind: JobSourceKind;
  /** Spotify playlist id (playlist), track id (track), "__liked__", or null for a selection. */
  spotifyId: string | null;
  name: string;
  owner: string | null;
  url: string | null;
  snapshotId: string | null;
}

export type JobStatus = "running" | "paused" | "done" | "cancelled";

/** One Spotify → Local link: a local playlist kept in the source's order. Persisted. */
export interface ImportJob {
  id: string;
  /** Local DonkeyBillabongDJ playlist created when the job starts. */
  playlistId: string;
  playlistName: string;
  source: JobSource;
  entries: PlaylistEntry[];
  status: JobStatus;
  /** Append newly playable tracks to Auto DJ automatically (explicit opt-in). */
  autoAppend: boolean;
  /** Use enabled download providers for entries with no local file. */
  useProviders: boolean;
  createdAt: number;
  updatedAt: number;
  lastRefreshAt: number | null;
}

/** Matching thresholds (configurable in the panel). */
export interface AcquireMatchConfig {
  /** Accept automatically at or above this score when unambiguous. */
  autoAccept: number;
  /** Offer for review at or above this score. */
  reviewMin: number;
  /** Max |file − Spotify| duration before a file needs review (seconds). */
  durationToleranceS: number;
}

/** reviewMin matches Smart Matching's "possible match" band; below it a candidate is noise. */
export const DEFAULT_ACQUIRE_MATCH: AcquireMatchConfig = { autoAccept: 85, reviewMin: 70, durationToleranceS: 15 };

/** A file detected in the watched folder (sent by the desktop main process). */
export interface WatchedFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  tags: {
    title?: string;
    artist?: string;
    album?: string;
    isrc?: string;
    durationMs?: number;
  };
  quality: AudioQuality | null;
  error?: string;
}

/** Desktop main-process settings for Spotify → Local (folder paths are chosen in native dialogs). */
export interface AcquireConfig {
  /** Where provider downloads are saved (inside this folder only). */
  destination: string | null;
  /** Folder watched for files produced by an external tool. */
  watchFolder: string | null;
  watching: boolean;
}

export interface WatchStatus {
  folder: string | null;
  watching: boolean;
  error?: string;
  /** Files seen since the watcher started. */
  seen: number;
}

/** Result of a validated provider download (file moved into the destination folder). */
export interface DownloadResult {
  path: string;
  name: string;
  /** True when an identical earlier download was reused instead of fetched again. */
  reused: boolean;
  quality: AudioQuality;
}

/** Spotify playlist / track / liked songs as entries in source order. */
export interface SpotifySourceResult {
  source: JobSource;
  entries: { kind: EntryKind; track: SourceTrack; addedAt: string | null }[];
}

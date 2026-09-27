import type { FilterParams } from "./mixerMath";

/** Source a track came from. Shown in the library and on the deck. */
export type TrackSource = "local" | "spotify" | "apple-music";

export interface TrackInfo {
  /** Stable reference understood by the track loader (file path in desktop mode). */
  ref: string;
  title: string;
  artist: string;
  album: string;
  source: TrackSource;
  bpm: number | null;
  key: string | null;
  durationMs?: number;
  artworkUrl?: string;
  externalUrl?: string;
  isrc?: string | null;
  genre?: string;
  year?: number;
  /** Embedded tags have been read (local files). */
  tagsRead?: boolean;
  /** Set when this playable track was resolved from another service's metadata (Smart Match). */
  resolvedFrom?: ResolvedFrom;
}

/** Where a deck's audio came from vs. where its metadata came from (kept separate for licensing/debugging). */
export interface ResolvedFrom {
  metadataSource: string;
  metadataTrackId: string;
  requestedTitle: string;
  requestedArtist: string;
  isrc: string | null;
  audioSource: string;
  confidence: number;
  method: "isrc" | "metadata" | "manual";
}

/** Decoded PCM held by the audio engine. Opaque to the DJ engine except for duration. */
export interface DecodedAudio {
  duration: number;
  sampleRate: number;
  channels: number;
  /** Backend-specific handle (e.g. an AudioBuffer for Web Audio). */
  handle: unknown;
}

/** Final DSP parameters for one mixer channel, already computed by the DJ engine. */
export interface ChannelDsp {
  trimGain: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  filter: FilterParams;
  /** Channel fader × crossfader × mute, linear. */
  outputGain: number;
  /** Pre-fader send to the headphone cue bus. */
  pfl: boolean;
}

export interface MasterDsp {
  masterGain: number;
  headCueGain: number;
  headMasterGain: number;
  headphoneGain: number;
}

export type AudioRouting = "stereo" | "quad";

export interface AudioConfig {
  /** Undefined = device default. */
  sampleRate?: number;
  /** "interactive" or a target latency in seconds (maps to the backend buffer size). */
  latencyHint: "interactive" | "balanced" | number;
  outputDeviceId: string;
  /**
   * stereo: master only on outputs 1/2 (headphone cue unavailable on a single stereo device).
   * quad:   master on 1/2 and headphone cue on 3/4 — for 4-output DJ controllers such as the DDJ-SB.
   */
  routing: AudioRouting;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  latencyHint: "interactive",
  outputDeviceId: "default",
  routing: "stereo",
};

export interface AudioStatus {
  backend: string;
  state: "idle" | "running" | "suspended" | "closed" | "error";
  sampleRate: number;
  baseLatency: number;
  outputLatency: number;
  maxOutputChannels: number;
  routing: AudioRouting;
  outputDeviceId: string;
  error?: string;
}

export interface OutputDevice {
  id: string;
  label: string;
}

export type AudioEngineEvent =
  | { type: "status"; status: AudioStatus }
  | { type: "ended"; deck: number }
  | { type: "error"; message: string };

/**
 * Backend-neutral audio engine contract. The Web Audio implementation lives in
 * src/audio; a native (CoreAudio/ASIO) backend can implement the same interface.
 */
export interface AudioEngine {
  readonly deckCount: number;
  start(): Promise<void>;
  reconfigure(config: AudioConfig): Promise<void>;
  getStatus(): AudioStatus;
  listOutputDevices(): Promise<OutputDevice[]>;
  decode(bytes: ArrayBuffer): Promise<DecodedAudio>;
  loadDeck(deck: number, audio: DecodedAudio): void;
  unloadDeck(deck: number): void;
  setPlaying(deck: number, playing: boolean): void;
  seek(deck: number, seconds: number): void;
  setRate(deck: number, rate: number): void;
  nudge(deck: number, rateOffset: number): void;
  setScratching(deck: number, active: boolean): void;
  scratchMove(deck: number, seconds: number): void;
  setChannel(deck: number, dsp: ChannelDsp): void;
  setMaster(dsp: MasterDsp): void;
  /** Current playhead in seconds (extrapolated between engine reports). */
  getPosition(deck: number): number;
  /** Peak levels 0..1: decks then master. */
  getLevels(): { channels: number[]; master: number };
  on(listener: (e: AudioEngineEvent) => void): () => void;
}

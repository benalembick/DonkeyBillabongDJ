/**
 * AI Set Studio entities. See docs/architecture/AI_SET_STUDIO.md §3.
 * Track-level intelligence lives on the existing TrackPreparation record (`intel`, `setOverrides`);
 * sets are one versioned JSON document each (`dj_sets`).
 */

/** Derived set-intelligence features for one track (content hash). Unknown values stay null. */
export interface SetIntel {
  algorithm: string;
  version: number;
  /** `analysedAt` of the worker analysis this was derived from (staleness check). */
  derivedFrom: number | null;
  computedAt: number;
  /** 1–10 multi-feature energy. */
  energy: number | null;
  energyConfidence: number;
  /** 0..1 feature scores. */
  danceability: number | null;
  brightness: number | null;
  bassIntensity: number | null;
  percussive: number | null;
  /** Onsets per second. */
  onsetDensity: number | null;
  /** Mean overview level in dBFS. */
  loudnessDb: number | null;
  /** 0..1 fraction of the track with audible vocals (STEMS only). */
  vocalPresence: number | null;
  vocalSource: "stems" | null;
  introSec: number | null;
  outroSec: number | null;
  dropSec: number | null;
  breakdownSec: number | null;
  /** Estimated from measured features by fixed rules — not a trained mood model. */
  moods: string[];
  moodSource: "rules-v1";
  genre: string | null;
  subgenre: string | null;
  /** 0..1 overall. */
  confidence: number;
  /** Field → reason it could not be produced. */
  unsupported: Record<string, string>;
}

/** User-entered values. Analysis never writes these; they win over derived values. */
export interface TrackOverrides {
  energy?: number;
  moods?: string[];
  genre?: string;
  subgenre?: string;
  updatedAt: number;
}

/** Everything the scorer needs about one library track (built from library + preparation). */
export interface SetTrack {
  ref: string;
  trackId: string | null;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec: number | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  energy: number | null;
  energySource: "override" | "intel" | "legacy" | null;
  genre: string | null;
  subgenre: string | null;
  moods: string[];
  brightness: number | null;
  bassIntensity: number | null;
  vocalPresence: number | null;
  danceability: number | null;
  introSec: number | null;
  outroSec: number | null;
  analysed: boolean;
  available: boolean;
  addedAt?: number;
  rating?: number;
}

/** A stable reference to a track: content hash first, path second, snapshot for display/relinking. */
export interface SetTrackRef {
  trackId: string | null;
  ref: string;
  title: string;
  artist: string;
  durationSec: number | null;
}

export type CurveTemplateId = "slow-burn" | "peak-valley" | "man-in-hole" | "opener" | "closer" | "freehand" | "anchors" | "imported";
export interface CurvePoint { x: number; y: number }

export type NextMove = "lift" | "keep" | "cool" | "tension" | "darker" | "brighter" | "more-vocals" | "less-vocals" | "peak" | "surprise";

export interface ScoreWeights { harmonic: number; bpm: number; energy: number; genreMood: number; structure: number }

export interface HardConstraints {
  bpmMin?: number | null;
  bpmMax?: number | null;
  /** Max tempo change from the previous track, percent (half/double-time relations allowed). */
  maxBpmJumpPct?: number | null;
  harmonicOnly?: boolean;
  energyMin?: number | null;
  energyMax?: number | null;
  /** Allowed Camelot keys (empty = any). */
  keys?: string[];
}

export interface RecommendationProfile {
  id: string;
  weights: ScoreWeights;
  hardConstraints: HardConstraints;
  energyDirection: NextMove;
  moodPreferences: string[];
  genrePreferences: string[];
  allowDuplicates: boolean;
}

export interface DJSetSlot {
  id: string;
  position: number;
  track: SetTrackRef | null;
  targetEnergy: number | null;
  /** Snapshot of the track's energy when last saved (the live value comes from the library). */
  actualEnergy: number | null;
  isAnchor: boolean;
  isLocked: boolean;
  /** Intentionally open: the DJ decides live; Auto Fill leaves it empty. */
  flexible: boolean;
  notes: string;
}

export type TransitionState = "green" | "amber" | "red";
export interface DJSetTransition {
  id: string;
  fromSlotId: string;
  toSlotId: string;
  compatibilityScore: number | null;
  state: TransitionState;
  warnings: string[];
  /** Phase 2 Transition Lab output; null in Phase 1. */
  transitionConfiguration: Record<string, unknown> | null;
}

export interface DJSetGroup {
  id: string;
  name: string;
  energyMin: number;
  energyMax: number;
  moodPreferences: string[];
  genrePreferences: string[];
  tracks: SetTrackRef[];
  /** Phase 2: linked to a reusable Blend Steering Group — its tracks come from that group. */
  blendGroupId?: string;
}

/** Phase 2: a reusable group assigned to a section of a curve set (fractions 0..1 of the planned time). */
export interface GroupSection { id: string; groupId: string; start: number; end: number }

/** Frozen snapshot of the playlist a set was imported from (Improve a Set). */
export interface ImproveOrigin {
  kind: "playlist" | "set";
  sourceId: string;
  sourceName: string;
  importedAt: number;
  refs: string[];
  energies: (number | null)[];
  transitionScores: (number | null)[];
  /** Transition states of the original order (absent in sets imported before this field existed). */
  transitionStates?: (TransitionState | null)[];
}

export type SetMode = "curve" | "anchors" | "groups" | "improve";

export const SET_SCHEMA = 1;

export interface DJSet {
  schemaVersion: number;
  id: string;
  name: string;
  mode: SetMode;
  createdAt: number;
  updatedAt: number;
  /** Lineage: 1 for a new set, +1 for each "Save as new version". */
  version: number;
  parentId: string | null;
  durationTargetSec: number;
  energyMin: number;
  energyMax: number;
  /** Seconds two tracks overlap in a transition (used for duration maths). */
  overlapSec: number;
  curveTemplate: CurveTemplateId;
  curveControlPoints: CurvePoint[];
  slots: DJSetSlot[];
  transitions: DJSetTransition[];
  groups: DJSetGroup[];
  profile: RecommendationProfile;
  origin?: ImproveOrigin;
  /** Phase 2: reusable groups assigned to parts of the energy curve. */
  groupSections?: GroupSection[];
  /** Playlists created from this set (so Auto DJ can find its prepared transitions). */
  playlistIds?: string[];
  /** Phase 2: let Auto DJ use this set's prepared transitions (default on). */
  preparedTransitions?: boolean;
}

export interface SetPersistence {
  list(): Promise<unknown[]>;
  save(set: DJSet): Promise<void>;
  remove(id: string): Promise<void>;
}

export const NEXT_MOVES: { id: NextMove; label: string; hint: string }[] = [
  { id: "lift", label: "Lift the Floor", hint: "Compatible tracks a controlled step higher in energy" },
  { id: "keep", label: "Keep the Groove", hint: "Hold the energy, genre and tempo" },
  { id: "cool", label: "Cool It Down", hint: "Lower energy while keeping the musical flow" },
  { id: "tension", label: "Build Tension", hint: "A small rise with darker, less vocal tracks" },
  { id: "darker", label: "Go Darker", hint: "Darker timbre and mood (not just a lower BPM)" },
  { id: "brighter", label: "Go Brighter", hint: "Brighter timbre, major-key and uplifting moods" },
  { id: "more-vocals", label: "More Vocals", hint: "Higher vocal presence (needs STEMS)" },
  { id: "less-vocals", label: "Less Vocals", hint: "Instrumental-leaning tracks (needs STEMS)" },
  { id: "peak", label: "Peak Time", hint: "Energy 8+ with strong danceability" },
  { id: "surprise", label: "Surprise Me", hint: "Controlled novelty within your hard constraints" },
];

export const DEFAULT_WEIGHTS: ScoreWeights = { harmonic: 20, bpm: 20, energy: 25, genreMood: 20, structure: 15 };

export const MOOD_TAGS = ["dark", "bright", "uplifting", "melancholic", "driving", "hypnotic", "chill", "euphoric", "groovy", "aggressive"] as const;

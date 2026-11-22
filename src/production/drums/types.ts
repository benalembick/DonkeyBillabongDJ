/**
 * Drum Transcriber — data model (see docs/DRUM-TRANSCRIBER.md).
 *
 * A transcription keeps the source audio's identity, the beat grid, and one `DrumHit` per detected (or hand-placed)
 * percussion event. Hits hold *source time in seconds* — never quantised — so quantisation, velocity mapping and the
 * MIDI note map are all derived at read time and can be changed or reversed without re-analysing.
 */

/** Lanes, top to bottom in the grid. `unknown` collects onsets the classifier could not label confidently. */
export const DRUM_LANES = ["kick", "snare", "clap", "closed-hat", "open-hat", "low-tom", "mid-tom", "high-tom", "crash", "ride", "perc", "unknown"] as const;
export type DrumLane = (typeof DRUM_LANES)[number];

export const LANE_LABEL: Record<DrumLane, string> = {
  kick: "Kick", snare: "Snare", clap: "Clap", "closed-hat": "Closed Hi-hat", "open-hat": "Open Hi-hat", "low-tom": "Low Tom", "mid-tom": "Mid Tom",
  "high-tom": "High Tom", crash: "Crash", ride: "Ride", perc: "Other Perc", unknown: "Unknown Perc",
};

/** General MIDI percussion defaults. Unknown hits are not exported until they are reclassified or given a note. */
export const GM_DRUM_MAP: Readonly<Record<DrumLane, number | null>> = {
  kick: 36, snare: 38, clap: 39, "closed-hat": 42, "open-hat": 46, "low-tom": 45, "mid-tom": 47, "high-tom": 50, crash: 49, ride: 51, perc: 54, unknown: null,
};
export type DrumMapping = Record<DrumLane, number | null>;

/** Lanes the Phase 1 baseline classifier can produce. Toms, ride and other percussion are manual-entry lanes for now. */
export const AUTO_LANES: readonly DrumLane[] = ["kick", "snare", "clap", "closed-hat", "open-hat", "crash", "unknown"];

export interface DrumCandidate { lane: DrumLane; score: number }

export interface DrumHit {
  id: string;
  /** Current lane (the user can reclassify). */
  lane: DrumLane;
  /** Unquantised position in the source audio, seconds. Manual moves change this; quantisation never does. */
  time: number;
  /** The detector's original onset time (seconds); null for hits added by hand. Never edited. */
  onset: number | null;
  /** What the classifier said (null for hand-placed hits). Kept after a reclassification for review and future training. */
  detected: DrumLane | null;
  /** Classifier confidence 0–1 (1 for hand-placed hits). */
  confidence: number;
  /** Hit strength 0–1, normalised per instrument; velocity is derived from it with the velocity settings. */
  strength: number;
  /** Manual velocity override (1–127), or null to derive from `strength`. */
  velocity: number | null;
  /** Ranked labels the classifier considered (for Unknown hits: what it would have guessed). */
  candidates?: DrumCandidate[];
  /** Why this hit needs a human look (low confidence, possible overlap…); cleared when the user accepts or edits it. */
  review?: string | null;
  /** Hits created from the same onset share a group id (simultaneous hits). */
  group?: string | null;
  /** True once the user has edited this hit (moved, reclassified, re-velocitied, accepted). */
  edited?: boolean;
}

export type DrumQuantize = "off" | "1/4" | "1/8" | "1/16" | "1/32" | "1/8T" | "1/16T";
export const DRUM_QUANTIZE_OPTIONS: { id: DrumQuantize; label: string }[] = [
  { id: "off", label: "Off" }, { id: "1/4", label: "1/4" }, { id: "1/8", label: "1/8" }, { id: "1/16", label: "1/16" }, { id: "1/32", label: "1/32" },
  { id: "1/8T", label: "1/8 triplet" }, { id: "1/16T", label: "1/16 triplet" },
];
export const QUANTIZE_GRID_BEATS: Record<DrumQuantize, number> = { off: 0, "1/4": 1, "1/8": .5, "1/16": .25, "1/32": .125, "1/8T": 1 / 3, "1/16T": 1 / 6 };

export interface VelocitySettings {
  /** 0 = every hit at max, 1 = velocity follows the measured strength fully. */
  sensitivity: number;
  min: number;
  max: number;
  /** 0 = linear, 1 = strong compression (quiet hits lifted towards max). */
  compression: number;
  /** When set, every hit without a manual override uses this velocity. */
  fixed: number | null;
}

export type TranscriptionMode = "loop" | "song";

export interface TranscriptionSettings {
  mode: TranscriptionMode;
  /** Onset detection sensitivity 0–1 (higher finds quieter hits, and more false positives). */
  sensitivity: number;
  /** Labels below this confidence go to the Unknown lane (with their suggestion kept). */
  minConfidence: number;
  quantize: { grid: DrumQuantize; strength: number };
  velocity: VelocitySettings;
}

export type GridSource = "library-manual" | "library" | "detected" | "loop" | "manual" | "default";
export interface DrumGrid {
  bpm: number;
  /** A downbeat (bar line) in source seconds, normalised into [0, bar). */
  firstBeat: number;
  beatsPerBar: number;
  source: GridSource;
  confidence: number;
}

export interface DrumSource {
  /** Platform ref (desktop path, browser session ref, or a Production Studio ref such as a stem). */
  ref: string;
  name: string;
  /** Content identity: SHA-256 of the file bytes (same id the library's preparation records use). */
  hash: string;
  duration: number;
  sampleRate: number;
  channels: number;
  origin: "file" | "arrangement";
}

export interface AnalysisInfo {
  engine: string;
  onsetDetector: string;
  classifier: string;
  version: number;
  analysedAt: number;
  elapsedMs: number;
  /** Every onset the detector accepted (seconds), including ones that became Unknown. */
  onsets: number[];
  analysisRate: number;
  settings: Pick<TranscriptionSettings, "sensitivity" | "minConfidence" | "mode">;
  /** What the audio analysis itself said about tempo (kept so a manual grid can be reset to it). */
  tempo: { bpm: number; firstBeat: number; confidence: number; source: "detected" | "loop" } | null;
}

export const DRUM_SCHEMA = 1;
export interface DrumTranscription {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: DrumSource;
  grid: DrumGrid;
  hits: DrumHit[];
  mapping: DrumMapping;
  mappingPresetId: string | null;
  settings: TranscriptionSettings;
  analysis: AnalysisInfo | null;
}

export interface DrumMapPreset { id: string; name: string; mapping: DrumMapping; updatedAt: number }

export const defaultSettings = (): TranscriptionSettings => ({
  mode: "loop", sensitivity: .5, minConfidence: .45,
  quantize: { grid: "off", strength: 1 },
  velocity: { sensitivity: .8, min: 30, max: 127, compression: 0, fixed: null },
});

export const makeDrumId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const clamp = (x: unknown, lo: number, hi: number, fallback: number): number => typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback;
const isLane = (x: unknown): x is DrumLane => typeof x === "string" && (DRUM_LANES as readonly string[]).includes(x);
const isNote = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 127;

export function normalizeMapping(raw: unknown): DrumMapping {
  const out = { ...GM_DRUM_MAP } as DrumMapping;
  if (raw && typeof raw === "object") for (const lane of DRUM_LANES) { const v = (raw as Record<string, unknown>)[lane]; if (v === null || isNote(v)) out[lane] = v; }
  return out;
}

function normalizeHit(raw: unknown): DrumHit | null {
  if (!raw || typeof raw !== "object") return null; const h = raw as Partial<DrumHit>;
  if (typeof h.id !== "string" || !isLane(h.lane) || typeof h.time !== "number" || !Number.isFinite(h.time)) return null;
  return {
    id: h.id, lane: h.lane, time: Math.max(0, h.time), onset: typeof h.onset === "number" ? h.onset : null, detected: isLane(h.detected) ? h.detected : null,
    confidence: clamp(h.confidence, 0, 1, 1), strength: clamp(h.strength, 0, 1, .8), velocity: isNote(h.velocity) && h.velocity > 0 ? h.velocity : null,
    candidates: Array.isArray(h.candidates) ? h.candidates.filter((c) => c && isLane(c.lane) && typeof c.score === "number") : undefined,
    review: typeof h.review === "string" ? h.review : null, group: typeof h.group === "string" ? h.group : null, edited: !!h.edited,
  };
}

/** Validates a stored transcription (throws on anything unusable — DocStore skips and reports it). */
export function migrateTranscription(raw: unknown): DrumTranscription {
  if (!raw || typeof raw !== "object") throw new Error("Invalid drum transcription");
  const p = raw as Partial<DrumTranscription>;
  if (typeof p.id !== "string" || !p.source || typeof p.source.ref !== "string" || !p.grid) throw new Error("Invalid drum transcription");
  if ((p.schemaVersion ?? 1) > DRUM_SCHEMA) throw new Error("This drum transcription was saved by a newer version of DonkeyBillabongDJ");
  const d = defaultSettings(); const s = (p.settings ?? {}) as Partial<TranscriptionSettings>; const v = (s.velocity ?? {}) as Partial<VelocitySettings>;
  const grid = DRUM_QUANTIZE_OPTIONS.some((o) => o.id === s.quantize?.grid) ? s.quantize!.grid : d.quantize.grid;
  return {
    schemaVersion: DRUM_SCHEMA, id: p.id, name: typeof p.name === "string" && p.name ? p.name : "Drum transcription",
    createdAt: clamp(p.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()), updatedAt: clamp(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    source: { ref: p.source.ref, name: String(p.source.name ?? "Audio"), hash: String(p.source.hash ?? ""), duration: clamp(p.source.duration, 0, 86400, 0),
      sampleRate: clamp(p.source.sampleRate, 0, 768000, 44100), channels: clamp(p.source.channels, 1, 64, 2), origin: p.source.origin === "arrangement" ? "arrangement" : "file" },
    grid: { bpm: clamp(p.grid.bpm, 40, 300, 120), firstBeat: clamp(p.grid.firstBeat, 0, 86400, 0), beatsPerBar: clamp(p.grid.beatsPerBar, 1, 16, 4),
      source: (["library-manual", "library", "detected", "loop", "manual", "default"] as GridSource[]).includes(p.grid.source as GridSource) ? p.grid.source as GridSource : "default", confidence: clamp(p.grid.confidence, 0, 100, 0) },
    hits: (Array.isArray(p.hits) ? p.hits : []).map(normalizeHit).filter((h): h is DrumHit => !!h).sort((a, b) => a.time - b.time),
    mapping: normalizeMapping(p.mapping), mappingPresetId: typeof p.mappingPresetId === "string" ? p.mappingPresetId : null,
    settings: {
      mode: s.mode === "song" ? "song" : "loop", sensitivity: clamp(s.sensitivity, 0, 1, d.sensitivity), minConfidence: clamp(s.minConfidence, 0, 1, d.minConfidence),
      quantize: { grid, strength: clamp(s.quantize?.strength, 0, 1, d.quantize.strength) },
      velocity: { sensitivity: clamp(v.sensitivity, 0, 1, d.velocity.sensitivity), min: Math.round(clamp(v.min, 1, 127, d.velocity.min)), max: Math.round(clamp(v.max, 1, 127, d.velocity.max)),
        compression: clamp(v.compression, 0, 1, d.velocity.compression), fixed: isNote(v.fixed) && v.fixed > 0 ? v.fixed : null },
    },
    analysis: p.analysis && typeof p.analysis === "object" ? p.analysis : null,
  };
}

export function migrateMapPreset(raw: unknown): DrumMapPreset {
  const p = raw as Partial<DrumMapPreset>;
  if (!p || typeof p.id !== "string" || typeof p.name !== "string") throw new Error("Invalid drum map preset");
  return { id: p.id, name: p.name, mapping: normalizeMapping(p.mapping), updatedAt: clamp(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()) };
}

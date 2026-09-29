import type { BeatGrid } from "../core/engine/DJEngine";
import type { TrackAnalysis } from "../analysis/analyzeTrack";

export const ANALYSIS_VERSION = 1;
export const PREPARATION_SCHEMA = 1;
export const CUE_COLOURS = ["#ff5f57", "#ffbd2e", "#28c840", "#32ade6", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a"];
export interface PreparedCue { slot: number; timestamp: number; name: string; colour: string; type: "hotcue" | "memory" }
export interface SavedLoop { id: string; slot: number; start: number; end: number; beats: number | null; name: string; colour: string }
export interface PreparedGrid extends BeatGrid { offset: number; beatPositions: number[]; manuallyAdjusted: boolean }
export interface GainAnalysis { gainDb: number; peak?: number; loudness?: number; method: string }
export interface TrackPreparation {
  schemaVersion: number;
  trackId: string;
  refs: string[];
  fileSize: number;
  title: string;
  artist: string;
  album: string;
  isrc: string | null;
  duration: number;
  bpm: number | null;
  key: string | null;
  keyConfidence: number;
  energy: number | null;
  energyConfidence: number;
  sections: TrackAnalysis["sections"];
  recommendedCues: TrackAnalysis["recommendedCues"];
  gain: GainAnalysis | null;
  analysisVersion: number | null;
  analysedAt: number | null;
  updatedAt: number;
  beatGrid: PreparedGrid | null;
  cuePoint: number;
  cues: PreparedCue[];
  savedLoops: SavedLoop[];
  lastLoop: { start: number; end: number; beats: number | null } | null;
}
export interface WaveformRecord {
  schemaVersion: number;
  trackId: string;
  analysisVersion: number;
  analysedAt: number;
  bpm: number | null;
  firstBeat: number | null;
  confidence: number;
  bpmSource: TrackAnalysis["bpmSource"];
  key: string | null;
  keyConfidence: number;
  energy: number | null;
  energyConfidence: number;
  gainDb: number | null;
  peak: number;
  sections: TrackAnalysis["sections"];
  recommendedCues: TrackAnalysis["recommendedCues"];
  fps: number;
  arrays: Record<"peaks" | "rms" | "low" | "mid" | "high", string>;
}
export interface PreparationPersistence {
  list(): Promise<TrackPreparation[]>;
  save(record: TrackPreparation): Promise<void>;
  loadWaveform(trackId: string): Promise<WaveformRecord | null>;
  saveWaveform(record: WaveformRecord): Promise<void>;
}

export function makeGrid(grid: BeatGrid, duration: number, manual = false, offset = 0): PreparedGrid {
  const beatPositions: number[] = [];
  if (grid.bpm > 0 && Number.isFinite(grid.bpm) && Number.isFinite(grid.firstBeat)) {
    const step = 60 / grid.bpm;
    for (let t = grid.firstBeat; t < duration && beatPositions.length < 100000; t += step) if (t >= 0) beatPositions.push(t);
  }
  return { ...grid, offset, beatPositions, manuallyAdjusted: manual };
}

export async function contentTrackId(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** SHA-256 of zero bytes. A decodable audio file can never legitimately use it. */
export const EMPTY_CONTENT_ID = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function encode(array: Float32Array): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function decode(text: string): Float32Array {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (bytes.byteLength % 4) throw new Error("Invalid waveform cache");
  return new Float32Array(bytes.buffer);
}
export function packWaveform(trackId: string, a: TrackAnalysis, analysedAt = Date.now()): WaveformRecord {
  return { schemaVersion: PREPARATION_SCHEMA, trackId, analysisVersion: ANALYSIS_VERSION, analysedAt, bpm: a.bpm, firstBeat: a.firstBeat, confidence: a.confidence, bpmSource: a.bpmSource,
    key: a.key, keyConfidence: a.keyConfidence, energy: a.energy, energyConfidence: a.energyConfidence, gainDb: a.gainDb, peak: a.peak, sections: a.sections, recommendedCues: a.recommendedCues, fps: a.fps,
    arrays: { peaks: encode(a.peaks), rms: encode(a.rms), low: encode(a.low), mid: encode(a.mid), high: encode(a.high) } };
}
export function unpackWaveform(r: WaveformRecord): TrackAnalysis {
  if (r.schemaVersion !== PREPARATION_SCHEMA) throw new Error("Unsupported waveform schema");
  return { bpm: r.bpm, firstBeat: r.firstBeat, confidence: r.confidence, bpmSource: r.bpmSource,
    key: r.key ?? null, keyConfidence: r.keyConfidence ?? 0, energy: r.energy ?? null, energyConfidence: r.energyConfidence ?? 0,
    gainDb: r.gainDb ?? null, peak: r.peak ?? 0, sections: r.sections ?? [], recommendedCues: r.recommendedCues ?? [], fps: r.fps,
    peaks: decode(r.arrays.peaks), rms: decode(r.arrays.rms), low: decode(r.arrays.low), mid: decode(r.arrays.mid), high: decode(r.arrays.high) };
}

/**
 * Drum Transcriber pipeline (pure; runs in transcribe.worker.ts, or inline as a fallback and in tests):
 *
 *   mono PCM → analysis rate (≈22–24 kHz) → band spectrogram → onsets → classifier → tempo → hits
 *
 * Cancellation: `signal` is checked at every checkpoint (spectrogram chunks, NMF iterations, classification).
 * Mode "song" (full mixes) is reserved for Phase 2 — it needs drum separation first and is refused here rather than
 * pretending a filter is a separation.
 */
import { BASELINE_CLASSIFIER, type ClassifiedHit, type DrumClassifier } from "./classifier";
import { bandSpectrogram, toAnalysisRate } from "./dsp";
import { detectOnsets } from "./onsets";
import { detectDrumTempo, type TempoResult } from "./tempo";
import type { TranscriptionMode } from "./types";

export const ENGINE_ID = "dbdj-drums";
export const ENGINE_VERSION = 1;
export const ONSET_DETECTOR = "superflux-bands-v1";
/** Longest input accepted (seconds). Analysis memory is roughly 0.1 MB per second of audio. */
export const MAX_DURATION = 20 * 60;

export interface TranscribeOptions { sensitivity: number; minConfidence: number; mode: TranscriptionMode }
export interface TranscribeResult {
  hits: ClassifiedHit[];
  onsets: number[];
  tempo: TempoResult | null;
  analysisRate: number;
  classifier: { id: string; version: number };
  onsetDetector: string;
  elapsedMs: number;
}
export type Stage = "preparing" | "spectrum" | "onsets" | "classifying" | "tempo";
export interface TranscribeHooks {
  onProgress?(stage: Stage, fraction: number): void;
  signal?: AbortSignal;
  /** Called at checkpoints; the inline runner yields to the event loop here so cancellation and UI stay live. */
  yieldControl?(): Promise<void>;
  classifier?: DrumClassifier;
}

export class AnalysisCancelled extends Error { constructor() { super("Analysis cancelled"); this.name = "AbortError"; } }
export const isCancelled = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

/** Throws a user-readable error for audio the transcriber cannot work with. */
export function validateAudio(mono: Float32Array, rate: number): void {
  if (!(rate >= 8000)) throw new Error("Unsupported sample rate");
  const duration = mono.length / rate;
  if (duration < .1) throw new Error("This audio is too short to transcribe (under 0.1 s)");
  if (duration > MAX_DURATION) throw new Error(`This audio is too long to transcribe in one go (over ${MAX_DURATION / 60} minutes)`);
  let peak = 0; for (let i = 0; i < mono.length; i += 7) { const v = Math.abs(mono[i]); if (!Number.isFinite(v)) throw new Error("The audio contains invalid samples"); if (v > peak) peak = v; }
  if (peak < 1e-4) throw new Error("No audio signal found — the file is silent");
}

export async function transcribeDrums(mono: Float32Array, rate: number, options: TranscribeOptions, hooks: TranscribeHooks = {}): Promise<TranscribeResult> {
  const started = Date.now();
  if (options.mode === "song") throw new Error("Full-song transcription needs AI drum separation (Phase 2). Use a drum loop or a Drums stem instead.");
  validateAudio(mono, rate);
  const progress = (stage: Stage, base: number, span: number) => async (fraction: number) => {
    if (hooks.signal?.aborted) throw new AnalysisCancelled(); hooks.onProgress?.(stage, base + span * Math.max(0, Math.min(1, fraction)));
    if (hooks.yieldControl) await hooks.yieldControl(); if (hooks.signal?.aborted) throw new AnalysisCancelled();
  };
  await progress("preparing", 0, .05)(0);
  const { data, rate: r } = toAnalysisRate(mono, rate);
  await progress("spectrum", .05, .4)(0);
  const spec = await bandSpectrogram(data, r, { checkpoint: progress("spectrum", .05, .4) });
  await progress("onsets", .45, .1)(0);
  const onsets = detectOnsets(spec, data, { sensitivity: options.sensitivity });
  await progress("classifying", .55, .35)(0);
  const classifier = hooks.classifier ?? BASELINE_CLASSIFIER;
  const hits = await classifier.classify({ spec, mono: data, onsets, minConfidence: options.minConfidence, sensitivity: options.sensitivity, checkpoint: progress("classifying", .55, .35) });
  await progress("tempo", .9, .1)(0);
  const tempo = detectDrumTempo(data, r, hits, onsets.map((o) => ({ time: o.time, strength: Math.min(1, o.strength) })));
  hooks.onProgress?.("tempo", 1);
  return { hits, onsets: onsets.map((o) => o.time), tempo, analysisRate: r, classifier: { id: classifier.id, version: classifier.version }, onsetDetector: ONSET_DETECTOR, elapsedMs: Date.now() - started };
}

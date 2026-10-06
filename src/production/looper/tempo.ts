/**
 * Live Looper Phase 2 — tempo detection for the first (master) loop. The performer plays freely with no tempo set;
 * LOOP runs this over the take's onsets to propose BPM, bar count and downbeat, which the performer can correct
 * before it becomes the project tempo. Pure and unit-tested; see LiveLooper.closeMaster for how it's used.
 */
import type { Transient } from "../slicing";

export interface TempoEstimate { bpm: number; beats: number; bars: number; beatsPerBar: number; downbeat: number; confidence: number }

/** The take is assumed to be this many whole beats long (2, 4, 8 or 16) — bar-length candidates from the spec. */
const CANDIDATE_BEATS = [2, 4, 8, 16];
const PHASE_STEPS = 24;

/** How well a beat grid (period, phase) explains the onsets: strength-weighted closeness to the nearest grid line. */
function gridScore(onsets: Transient[], period: number, phase: number): number {
  let score = 0;
  for (const o of onsets) { const d = ((o.time - phase) % period + period) % period; const dist = Math.min(d, period - d); score += o.strength * Math.max(0, 1 - dist / (period * .12)); }
  return score;
}

/**
 * Tries each candidate take length in beats, finds the best-matching downbeat phase for each, and returns the
 * highest-confidence candidate whose beat count divides evenly into whole bars (null when nothing scores at all).
 */
export function estimateTempo(onsets: Transient[], duration: number, beatsPerBar = 4, bpmRange: [number, number] = [60, 200]): TempoEstimate | null {
  if (!onsets.length || duration <= 0) return null;
  const totalStrength = Math.max(1e-6, onsets.reduce((n, o) => n + o.strength, 0));
  let best: TempoEstimate | null = null;
  for (const beats of CANDIDATE_BEATS) {
    if (beats % beatsPerBar !== 0) continue;
    const period = duration / beats; const bpm = 60 / period;
    if (bpm < bpmRange[0] || bpm > bpmRange[1]) continue;
    let bestScore = -1, bestPhase = 0;
    for (let s = 0; s < PHASE_STEPS; s++) { const phase = (s / PHASE_STEPS) * period; const score = gridScore(onsets, period, phase); if (score > bestScore) { bestScore = score; bestPhase = phase; } }
    const confidence = Math.min(1, bestScore / totalStrength);
    if (!best || confidence > best.confidence) best = { bpm: Math.round(bpm * 10) / 10, beats, bars: beats / beatsPerBar, beatsPerBar, downbeat: bestPhase, confidence };
  }
  return best;
}

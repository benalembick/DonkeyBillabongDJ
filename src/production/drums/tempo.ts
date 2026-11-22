/**
 * BPM and downbeat for a transcription, reusing the app's existing detectors:
 *  - ≥ 8 s of audio: `detectBeats` (the deck analyser's autocorrelation + comb search) on the same 150 fps
 *    low/mid energy envelope `analyzeTrack` builds;
 *  - shorter clips: the Live Looper's `estimateTempo`, which assumes the clip is a whole loop of 2/4/8/16 beats.
 * The downbeat is then chosen among the four beat phases as the one that puts the most kick energy on bar lines.
 * Library grids (especially hand-edited ones) take precedence — that decision is made by the DrumTranscriber service.
 */
import { detectBeats, WAVE_FPS } from "../../analysis/analyzeTrack";
import { normaliseGrid } from "../../preparation/beatGrid";
import { estimateTempo } from "../looper/tempo";

export interface TempoResult { bpm: number; firstBeat: number; confidence: number; source: "detected" | "loop" }
export interface TimedHit { time: number; strength: number; lane: string }

/** The 150 fps low (+0.35 × mid) energy envelope `analyzeTrack` feeds to `detectBeats`. */
export function beatEnvelope(mono: Float32Array, rate: number): Float32Array {
  const frames = Math.max(1, Math.ceil(mono.length / rate * WAVE_FPS)); const hop = rate / WAVE_FPS; const out = new Float32Array(frames);
  const aLow = Math.exp(-2 * Math.PI * 200 / rate), aHi = Math.exp(-2 * Math.PI * 2500 / rate); let yLow = 0, yHi = 0, e = 0, n = 0, f = 0, next = hop;
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i]; yLow += (1 - aLow) * (x - yLow); yHi += (1 - aHi) * (x - yHi); const md = yHi - yLow; e += yLow * yLow + .35 * md * md; n++;
    if (i + 1 >= next || i === mono.length - 1) { if (f < frames) out[f] = Math.sqrt(e / Math.max(1, n)); f++; next += hop; e = 0; n = 0; }
  }
  return out;
}

/** Among the 4 beat phases of a grid, the bar phase that puts the most kick (else any hit) strength on bar lines. */
export function chooseDownbeat(bpm: number, beatPhase: number, hits: TimedHit[], beatsPerBar = 4): number {
  const beat = 60 / bpm, bar = beat * beatsPerBar; const kicks = hits.filter((h) => h.lane === "kick"); const use = kicks.length >= 2 ? kicks : hits;
  // Ties (e.g. kicks on beats 1 and 3) go to the phase that puts the earliest kick on a bar line.
  const first = use.length ? Math.min(...use.map((h) => h.time)) : beatPhase; const offFirst = (phase: number) => { const d = (((first - phase) % bar) + bar) % bar; return Math.min(d, bar - d); };
  let best = beatPhase, bestScore = -1;
  for (let i = 0; i < beatsPerBar; i++) {
    const phase = beatPhase + i * beat; let score = 0;
    for (const h of use) { const d = (((h.time - phase) % bar) + bar) % bar; const dist = Math.min(d, bar - d); score += h.strength * Math.max(0, 1 - dist / (beat * .25)); }
    if (score > bestScore * 1.02 + 1e-9 || (score >= bestScore * .98 && offFirst(phase) < offFirst(best))) { if (score > bestScore) bestScore = score; best = phase; }
  }
  return normaliseGrid({ bpm, firstBeat: best }).firstBeat;
}

export function detectDrumTempo(mono: Float32Array, rate: number, hits: TimedHit[], onsets: { time: number; strength: number }[]): TempoResult | null {
  const duration = mono.length / rate;
  if (duration >= 8) {
    const beat = detectBeats(beatEnvelope(mono, rate), WAVE_FPS, null);
    if (beat.bpm && beat.firstBeat !== null) { const bpm = Math.round(beat.bpm * 100) / 100; return { bpm, firstBeat: chooseDownbeat(bpm, beat.firstBeat, hits), confidence: beat.confidence, source: "detected" }; }
  }
  // A trimmed loop: the Live Looper's whole-loop estimate is exact. Otherwise (untrimmed takes) search a beat comb.
  const est = estimateTempo(onsets, duration);
  if (est && est.confidence >= .85) return { bpm: est.bpm, firstBeat: chooseDownbeat(est.bpm, est.downbeat, hits), confidence: est.confidence, source: "loop" };
  const comb = combTempo(hits.length ? hits : onsets.map((o) => ({ ...o, lane: "unknown" })));
  if (comb) return { bpm: comb.bpm, firstBeat: chooseDownbeat(comb.bpm, comb.phase, hits), confidence: comb.confidence, source: "detected" };
  return est ? { bpm: est.bpm, firstBeat: chooseDownbeat(est.bpm, est.downbeat, hits), confidence: est.confidence, source: "loop" } : null;
}

/** Beat weight per lane for the comb: kicks and snares carry the beat; hats often run at 8ths/16ths. */
const BEAT_WEIGHT: Record<string, number> = { kick: 1, snare: .9, clap: .9, "closed-hat": .25, "open-hat": .35, unknown: .4 };

/**
 * Short-clip tempo: the 70–180 BPM beat grid (period, phase) whose lines best explain the hits (kick/snare weighted),
 * refined to 0.05 BPM. Ties go to the slower tempo so 8th-note hats do not double it. Needs at least 3 hits.
 */
export function combTempo(hits: TimedHit[]): { bpm: number; phase: number; confidence: number } | null {
  if (hits.length < 3) return null; const total = hits.reduce((s, h) => s + (BEAT_WEIGHT[h.lane] ?? .5) * Math.max(.2, h.strength), 0);
  const score = (bpm: number) => {
    const period = 60 / bpm; let best = { s: -1, phase: 0 };
    for (let i = 0; i < 48; i++) { const phase = i / 48 * period; let s = 0; for (const h of hits) { const d = (((h.time - phase) % period) + period) % period; const dist = Math.min(d, period - d); s += (BEAT_WEIGHT[h.lane] ?? .5) * Math.max(.2, h.strength) * Math.max(0, 1 - dist / .025); } if (s > best.s) best = { s, phase }; }
    return best;
  };
  let top = { bpm: 0, s: -1, phase: 0 };
  for (let bpm = 70; bpm <= 180; bpm += .5) { const r = score(bpm); if (r.s > top.s * 1.03) top = { bpm, ...r }; }
  if (top.s <= 0) return null;
  // Octave check: 8th-note hats always make double tempo score a little higher; keep the half unless double clearly wins.
  if (top.bpm / 2 >= 70) { const half = score(top.bpm / 2); if (half.s * 1.3 >= top.s) top = { bpm: top.bpm / 2, ...half }; }
  for (let bpm = top.bpm - .5; bpm <= top.bpm + .5; bpm += .05) { const r = score(bpm); if (r.s > top.s) top = { bpm, ...r }; }
  return { bpm: Math.round(top.bpm * 20) / 20, phase: top.phase, confidence: Math.min(1, top.s / total) };
}

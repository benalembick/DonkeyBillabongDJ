/**
 * What the training mode measures, from the engine's own state (the same state every input —
 * mouse, keyboard, DJ controller — drives): deck positions on the audio clock, tempo, mixer
 * and FX settings. No audio is analysed perceptually; scores only use these control and
 * playback values plus the tracks' beat grids.
 */
import { BEATS_PER_BAR, PHRASE_BARS, timeAtBar, type Grid } from "../transitions/planner";

export interface DeckSample {
  playing: boolean;
  /** Track position (s) from the audio clock. */
  pos: number;
  rate: number;
  /** Effective BPM (grid BPM × rate), null without a grid. */
  bpm: number | null;
  /** Audible gain 0..1: channel fader × crossfader side × playing. */
  volume: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  filter: number;
}

export interface FxSample {
  /** An ECHO slot is on. */
  echoOn: boolean;
  anyOn: boolean;
  mix: number;
  onA: boolean;
  onB: boolean;
}

export interface Sample {
  /** Seconds since the attempt started (wall clock). */
  t: number;
  a: DeckSample;
  b: DeckSample;
  /** Track B's beat phase against Track A in ms (+ = B ahead), null if not measurable. */
  phaseMs: number | null;
  fx: FxSample[];
}

export interface TrainingEvent {
  t: number;
  kind: "aStart" | "bStart" | "tap" | "syncBlocked" | "done";
  /** Track A position (s) at the event; for bStart: where A was when B's playhead left its cue (exact). */
  aPos: number;
}

/** The exercise's fixed facts (grids, cue, targets, latency). */
export interface Exercise {
  aGrid: Grid | null;
  bGrid: Grid | null;
  aPhraseOffset: number;
  bPhraseOffset: number;
  bCue: number;
  /** Output latency (ms) — reported; positions are already on the audio clock. */
  latencyMs: number;
  /** Quick cut: cut on the next bar or the next phrase. */
  cutOn: "bar" | "phrase";
}

export const beatLen = (g: Grid) => 60 / g.bpm;

/** Fractional beat index of a track time on a grid. */
export const beatIndex = (g: Grid, t: number) => (t - g.firstBeat) / beatLen(g);

/** Signed distance (beats) from t to the nearest boundary every `beats` beats from `offsetBeats`. */
export function nearestBoundary(g: Grid, t: number, beats: number, offsetBeats = 0): { index: number; errorBeats: number; time: number } {
  const b = beatIndex(g, t) - offsetBeats;
  const index = Math.round(b / beats);
  const time = g.firstBeat + (index * beats + offsetBeats) * beatLen(g);
  return { index, errorBeats: b - index * beats, time };
}

/** Phrase boundaries (8 bars) honour the phrase offset — every bar is NOT a phrase. */
export const nearestPhrase = (g: Grid, t: number, offsetBars: number) => nearestBoundary(g, t, PHRASE_BARS * BEATS_PER_BAR, offsetBars * BEATS_PER_BAR);
export const nearestBar = (g: Grid, t: number) => nearestBoundary(g, t, BEATS_PER_BAR);

/** The next phrase start after t (track time) and how many bars/beats away it is. */
export function nextPhrase(g: Grid, t: number, offsetBars: number): { time: number; barsAway: number; beatsAway: number; barInPhrase: number } {
  const beatsPerPhrase = PHRASE_BARS * BEATS_PER_BAR;
  const b = beatIndex(g, t) - offsetBars * BEATS_PER_BAR;
  const k = Math.floor(b / beatsPerPhrase + 1e-6) + 1;
  const time = g.firstBeat + (k * beatsPerPhrase + offsetBars * BEATS_PER_BAR) * beatLen(g);
  const beatsAway = Math.max(0, k * beatsPerPhrase - b);
  const into = ((b % beatsPerPhrase) + beatsPerPhrase) % beatsPerPhrase;
  return { time, barsAway: Math.floor(beatsAway / BEATS_PER_BAR), beatsAway, barInPhrase: Math.floor(into / BEATS_PER_BAR) + 1 };
}

/** Phase of B against A in ms (+ = B ahead), from both grids and positions. */
export function phaseMs(aGrid: Grid, bGrid: Grid, aPos: number, bPos: number, aBpm: number): number {
  const pa = beatIndex(aGrid, aPos);
  const pb = beatIndex(bGrid, bPos);
  const delta = ((((pb - pa + 0.5) % 1) + 1) % 1) - 0.5;
  return (delta * 60 * 1000) / aBpm;
}

/**
 * Where Track A was when Track B's playhead left its cue — exact, from a later sample:
 * B has played (bPos − cue) / rateB seconds since then, during which A moved that × rateA.
 */
export const aPositionAtBEntry = (s: Sample, bCue: number) => s.a.pos - ((s.b.pos - bCue) / Math.max(0.01, s.b.rate)) * s.a.rate;

/** Crossfader side gains (equal-power-ish, as the engine's default curve). */
export const xfGain = (x: number) => ({ a: Math.min(1, (1 - x) * 2), b: Math.min(1, x * 2) });

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((p, q) => p - q);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export { timeAtBar };

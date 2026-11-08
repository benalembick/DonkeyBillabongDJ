import { deckLetter } from "../core/actions";
import type { DeckState } from "../core/engine/DJEngine";
import type { TrackAnalysis } from "../analysis/analyzeTrack";
import { DEFAULT_AUTO_EQ, type AutoEqSettings } from "./autoEq";

export interface AutoDJSettings {
  style: "smart" | "beat-mix" | "crossfade" | "quick-fade";
  bars: "auto" | 4 | 8 | 16 | 32;
  /** Wall-clock crossfade duration. Auto derives it from the selected phrase length and BPM. */
  transitionSeconds: "auto" | number;
  shuffle: boolean;
  repeat: boolean;
  bpmSync: boolean;
  keyAware: boolean;
  intelligentMashups: boolean;
  /** Optional automatic EQ blend during transitions — see autodj/autoEq.ts. Off by default. */
  autoEq: AutoEqSettings;
  /**
   * Optional: while just counting down to a transition (not yet mixing), gradually nudge both
   * decks' tempo toward a shared middle point if the tempo gap alone is what's blocking Beat
   * Mix — see tempoGapOnly/tempoLeadInTarget below. Off by default.
   */
  tempoLeadIn: boolean;
}
export const DEFAULT_AUTO_DJ: AutoDJSettings = { style: "smart", bars: "auto", transitionSeconds: "auto", shuffle: false, repeat: false, bpmSync: true, keyAware: false, intelligentMashups: false, autoEq: DEFAULT_AUTO_EQ, tempoLeadIn: false };
export interface TransitionPlan { kind: "beat-mix" | "crossfade" | "quick-fade"; mixOut: number; mixIn: number; seconds: number; sync: boolean; reason: string }
export interface TransitionRegion { role: "out" | "in"; label: "MIX OUT" | "MIX IN"; start: number; end: number }

/** Timeline projection of the real playback plan; waveform UIs must use this rather than duplicating transition values. */
export function transitionRegion(plan: TransitionPlan, outgoingDeck: number, deck: number, rate: number, duration: number): TransitionRegion {
  const role = deck === outgoingDeck ? "out" : "in";
  const start = role === "out" ? plan.mixOut : plan.mixIn;
  return { role, label: role === "out" ? "MIX OUT" : "MIX IN", start, end: Math.min(duration, start + plan.seconds * rate) };
}

const KEYS: Record<string, string> = {
  "abm": "1A", "g#m": "1A", "ebm": "2A", "d#m": "2A", "bbm": "3A", "a#m": "3A", "fm": "4A", "cm": "5A", "gm": "6A", "dm": "7A", "am": "8A", "em": "9A", "bm": "10A", "f#m": "11A", "gbm": "11A", "c#m": "12A", "dbm": "12A",
  "b": "1B", "f#": "2B", "gb": "2B", "db": "3B", "c#": "3B", "ab": "4B", "g#": "4B", "eb": "5B", "d#": "5B", "bb": "6B", "a#": "6B", "f": "7B", "c": "8B", "g": "9B", "d": "10B", "a": "11B", "e": "12B",
};
function camelot(key: string | null | undefined): string | null {
  const k = key?.trim().replace(/♯/g, "#").replace(/♭/g, "b").toLowerCase().replace(/\s*minor$/, "m").replace(/\s*major$/, "").replace(/\s/g, "");
  return k ? (/^(?:[1-9]|1[0-2])[ab]$/.test(k) ? k.toUpperCase() : KEYS[k] ?? null) : null;
}
export function compatibleKeys(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = camelot(a), y = camelot(b);
  if (!x || !y) return null;
  const n = parseInt(x), m = parseInt(y);
  return n === m || (x.slice(-1) === y.slice(-1) && (Math.abs(n - m) === 1 || Math.abs(n - m) === 11));
}

/** Estimated audible bounds, not vocal/section detection. Uses the existing RMS overview. */
function bounds(d: DeckState, a?: TrackAnalysis | null): [number, number] {
  if (!a?.rms.length) return [0, d.duration];
  const max = a.rms.reduce((m, v) => Math.max(m, v), 0);
  if (!max) return [0, d.duration];
  const first = a.rms.findIndex((v) => v > max * 0.08);
  let last = a.rms.length - 1;
  while (last > first && a.rms[last] <= max * 0.08) last--;
  return [first / a.rms.length * d.duration, (last + 1) / a.rms.length * d.duration];
}

const MIN_GRID_CONFIDENCE = 1.4;

/**
 * Explains, specifically, why Beat Mix didn't happen — the badge alone ("Beat Mix unavailable")
 * doesn't say which of several possible reasons applies, or what to change about it. Checked in
 * the same priority Beat Mix itself is gated on, so this always names the actual blocker.
 */
function fallbackReason(out: DeckState, incoming: DeckState, settings: AutoDJSettings, a: number | null | undefined, b: number | null | undefined, ratio: number, grids: boolean, keys: boolean | null): string {
  if (!settings.bpmSync) return "Clean fade; BPM Sync is switched off in Auto DJ settings";
  const noBpm = [!a ? deckLetter(out.index) : null, !b ? deckLetter(incoming.index) : null].filter((x): x is string => x !== null);
  if (noBpm.length) return `Clean fade; BPM unknown for Deck ${noBpm.join(" and Deck ")}`;
  if (!grids) {
    const unreliable = [
      !out.beatGrid || out.beatGrid.confidence < MIN_GRID_CONFIDENCE ? deckLetter(out.index) : null,
      !incoming.beatGrid || incoming.beatGrid.confidence < MIN_GRID_CONFIDENCE ? deckLetter(incoming.index) : null,
    ].filter((x): x is string => x !== null);
    return `Clean fade; beat grid isn't reliable enough for Deck ${unreliable.join(" and Deck ")}`;
  }
  const gapPct = Math.round(Math.abs(ratio - 1) * 100);
  const rangePct = Math.round(incoming.tempoRange * 100);
  if (gapPct > rangePct) return `Tempo gap too large for Beat Mix (needs ±${gapPct}%, Deck ${deckLetter(incoming.index)}'s tempo range is ±${rangePct}%) — widen it to cover a bigger gap`;
  if (settings.keyAware && keys === false) return "Clean fade; keys aren't compatible enough for Smart + key-aware ordering";
  return "Clean fade; Beat Mix isn't selected for this transition"; // explicit Crossfade/Quick Fade choice
}

/** Pre-transition tempo lead-in never pushes a deck further than this from its native pitch. */
export const TEMPO_LEADIN_CAP = 0.16;

/** True exactly when the tempo gap is the *only* thing stopping Beat Mix — reliable grids, BPM Sync on, both BPMs known, just too far apart for the incoming deck's own range. */
export function tempoGapOnly(out: DeckState, incoming: DeckState, settings: AutoDJSettings): boolean {
  if (!settings.bpmSync) return false;
  const a = out.beatGrid?.bpm ?? out.track?.bpm;
  const b = incoming.beatGrid?.bpm ?? incoming.track?.bpm;
  if (!a || !b) return false;
  const grids = !!out.beatGrid && !!incoming.beatGrid && out.beatGrid.confidence >= MIN_GRID_CONFIDENCE && incoming.beatGrid.confidence >= MIN_GRID_CONFIDENCE;
  if (!grids) return false;
  const ratio = (a * out.rate) / b;
  return ratio < 1 - incoming.tempoRange || ratio > 1 + incoming.tempoRange;
}

/**
 * Meets the two decks' *current* effective tempos (whatever manual adjustment is already
 * dialed in) at their geometric mean, splitting the remaining gap evenly between them. Only
 * `feasible` when both resulting rates land within TEMPO_LEADIN_CAP of native pitch — if even
 * that can't close the gap, there's no point nudging either deck.
 */
export function tempoLeadInTarget(out: DeckState, incoming: DeckState): { feasible: boolean; outRate: number; inRate: number } {
  const a = out.beatGrid?.bpm ?? out.track?.bpm;
  const b = incoming.beatGrid?.bpm ?? incoming.track?.bpm;
  if (!a || !b) return { feasible: false, outRate: out.rate, inRate: incoming.rate };
  const midBpm = Math.sqrt(a * out.rate * b * incoming.rate);
  const outRate = midBpm / a;
  const inRate = midBpm / b;
  const feasible = Math.abs(outRate - 1) <= TEMPO_LEADIN_CAP && Math.abs(inRate - 1) <= TEMPO_LEADIN_CAP;
  return { feasible, outRate, inRate };
}

export function planTransition(out: DeckState, incoming: DeckState, settings: AutoDJSettings, outAnalysis?: TrackAnalysis | null, inAnalysis?: TrackAnalysis | null): TransitionPlan {
  const a = out.beatGrid?.bpm ?? out.track?.bpm;
  const b = incoming.beatGrid?.bpm ?? incoming.track?.bpm;
  const ratio = a && b ? a * out.rate / b : 0;
  const grids = !!out.beatGrid && !!incoming.beatGrid && out.beatGrid.confidence >= 1.4 && incoming.beatGrid.confidence >= 1.4;
  const keys = compatibleKeys(out.track?.key, incoming.track?.key);
  // The incoming deck is the one Sync actually re-paces to match the outgoing tempo, so its
  // own tempo-range setting (±6/10/16%, or Wide) is the honest limit on how far that's safe —
  // not a fixed ±10% regardless of what the deck is set to.
  const safeTempo = ratio >= 1 - incoming.tempoRange && ratio <= 1 + incoming.tempoRange;
  const beatMix = settings.bpmSync && safeTempo && grids && (settings.style === "beat-mix" || (settings.style === "smart" && (!settings.keyAware || keys !== false)));
  const kind = beatMix ? "beat-mix" : settings.style === "quick-fade" || (settings.style === "smart" && a && b && !safeTempo) ? "quick-fade" : "crossfade";
  const [inStart] = bounds(incoming, inAnalysis);
  const [, outEnd] = bounds(out, outAnalysis);
  const bars = settings.bars === "auto" ? (beatMix && keys !== false ? 16 : 8) : settings.bars;
  const automaticDuration = settings.bars !== "auto" && a ? bars * 4 * 60 / (a * out.rate) : beatMix && a ? bars * 4 * 60 / (a * out.rate) : kind === "quick-fade" ? 2 : 8;
  const desired = settings.transitionSeconds === "auto" ? automaticDuration : Math.max(1, settings.transitionSeconds);
  const seconds = Math.max(0.1, Math.min(desired, out.duration / out.rate / 3, incoming.duration / (beatMix ? ratio : 1) / 3));
  let mixIn = Math.max(inStart, incoming.cuePoint, incoming.hotcues.find((x) => x !== null && x >= inStart && x < incoming.duration / 3) ?? 0);
  let mixOut = Math.max(0, outEnd - seconds * out.rate);
  if (beatMix && a && b) {
    const phraseBeats = bars >= 32 ? 128 : bars >= 16 ? 64 : bars >= 8 ? 32 : 16;
    const phrase = phraseBeats * 60 / a;
    const origin = out.beatGrid!.firstBeat;
    mixOut = Math.max(origin, origin + Math.floor((mixOut - origin) / phrase) * phrase);
    const inPhrase = phraseBeats * 60 / b;
    const inOrigin = incoming.beatGrid!.firstBeat;
    mixIn = inOrigin + Math.ceil(Math.max(0, mixIn - inOrigin) / inPhrase) * inPhrase;
  }
  mixIn = Math.max(0, Math.min(mixIn, incoming.duration - seconds * (beatMix ? ratio : 1) - 0.1));
  const reason = beatMix ? "Compatible tempo; estimated phrase boundaries" : fallbackReason(out, incoming, settings, a, b, ratio, grids, keys);
  return { kind, mixOut, mixIn, seconds, sync: beatMix, reason };
}

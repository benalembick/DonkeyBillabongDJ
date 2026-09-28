import type { DeckState } from "../core/engine/DJEngine";
import type { TrackAnalysis } from "../analysis/analyzeTrack";

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
}
export const DEFAULT_AUTO_DJ: AutoDJSettings = { style: "smart", bars: "auto", transitionSeconds: "auto", shuffle: false, repeat: false, bpmSync: true, keyAware: false, intelligentMashups: false };
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

export function planTransition(out: DeckState, incoming: DeckState, settings: AutoDJSettings, outAnalysis?: TrackAnalysis | null, inAnalysis?: TrackAnalysis | null): TransitionPlan {
  const a = out.beatGrid?.bpm ?? out.track?.bpm;
  const b = incoming.beatGrid?.bpm ?? incoming.track?.bpm;
  const ratio = a && b ? a * out.rate / b : 0;
  const grids = !!out.beatGrid && !!incoming.beatGrid && out.beatGrid.confidence >= 1.4 && incoming.beatGrid.confidence >= 1.4;
  const keys = compatibleKeys(out.track?.key, incoming.track?.key);
  // The decks' normal tempo range is ±10%. Keeping Auto DJ to the same range
  // covers common 120→128 and 128→120 transitions without extreme warping.
  const safeTempo = ratio >= 0.9 && ratio <= 1.1;
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
  return { kind, mixOut, mixIn, seconds, sync: beatMix, reason: beatMix ? "Compatible tempo; estimated phrase boundaries" : !safeTempo && a && b ? "Tempo gap: keep original speed" : "Clean fade; no reliable compatible beat grids" };
}

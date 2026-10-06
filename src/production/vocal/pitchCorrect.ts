/**
 * Pitch-correction curve (Phase 2). For every 5 ms frame: how many cents to move the voice.
 *
 * Inside a note the sung pitch is split into  detected (median) + trend (linear drift) + expression (vibrato,
 * scoops — the residual). The corrected pitch is
 *     target + (1 − drift) · trend + preserve · expression
 * so PRESERVE EXPRESSION keeps vibrato, PITCH DRIFT CORRECTION straightens slow sagging, and with both at 0 the
 * note is pulled flat onto the target. CORRECTION STRENGTH scales the move, HUMANIZE leaves short notes alone,
 * RETUNE SPEED is the time constant the correction moves with (0 ms = hard tune), and NOTE TRANSITION keeps the
 * glide between connected notes.
 */
import type { PitchTrack, VocalNote } from "./pitchTrack";
import { nearestInScale } from "./scales";

export interface PitchParams { strength: number; retuneMs: number; humanize: number; transitionMs: number; drift: number; preserve: number }
export type PitchPresetId = "natural" | "studio" | "strong" | "hard";
export const PITCH_PRESETS: Record<PitchPresetId, { label: string; hint: string; params: PitchParams }> = {
  natural: { label: "Natural Correction", hint: "Gentle: keeps vibrato and scoops, nudges notes toward pitch", params: { strength: .7, retuneMs: 140, humanize: .6, transitionMs: 90, drift: .3, preserve: .95 } },
  studio: { label: "Studio Vocal", hint: "Polished but human", params: { strength: .9, retuneMs: 60, humanize: .35, transitionMs: 60, drift: .6, preserve: .7 } },
  strong: { label: "Strong Correction", hint: "Tight pitch, some expression kept", params: { strength: 1, retuneMs: 25, humanize: .15, transitionMs: 35, drift: .9, preserve: .35 } },
  hard: { label: "Hard Tune", hint: "The deliberate robotic effect: instant snapping, no vibrato", params: { strength: 1, retuneMs: 0, humanize: 0, transitionMs: 0, drift: 1, preserve: 0 } },
};

/** Target pitch of a note (null = bypassed). */
export const noteTarget = (note: VocalNote, mask: boolean[]): number | null => note.bypass ? null : note.target ?? nearestInScale(note.detected, mask);

/** Correction in cents per frame of `track`. */
export function correctionCurve(track: PitchTrack, notes: VocalNote[], mask: boolean[], p: PitchParams): Float32Array {
  const { f0, hop } = track; const n = f0.length; const desired = new Float32Array(n); const inNote = new Uint8Array(n);
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (const note of sorted) {
    const target = noteTarget(note, mask); const a = Math.max(0, Math.floor(note.start / hop)), b = Math.min(n, Math.ceil(note.end / hop)); if (b <= a) continue;
    // Bypassed notes actively return to no correction (at the retune speed) instead of inheriting the previous note's.
    if (target === null) { for (let i = a; i < b; i++) if (f0[i]) { inNote[i] = 1; desired[i] = 0; } continue; }
    // Humanize: notes shorter than humanize × 250 ms fade out of correction (fast passing notes stay natural).
    const short = p.humanize * .25; const dur = note.end - note.start; const weight = p.strength * (short > 0 ? Math.min(1, Math.max(0, (dur - short * .5) / (short * .5 || 1))) : 1);
    const xs: number[] = [], ys: number[] = []; for (let i = a; i < b; i++) if (f0[i]) { xs.push(i); ys.push(f0[i]); }
    let slope = 0, intercept = note.detected; if (xs.length > 2) { const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length; let num = 0, den = 0; for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; } slope = den ? num / den : 0; intercept = my - slope * mx; }
    for (let i = a; i < b; i++) {
      if (!f0[i]) continue; inNote[i] = 1; const fitted = slope * i + intercept; const trend = fitted - note.detected, expression = f0[i] - fitted;
      const corrected = target + (1 - p.drift) * trend + p.preserve * expression; desired[i] = (corrected - f0[i]) * 100 * weight;
    }
  }
  // Note transitions: between notes less than 120 ms apart, ramp the correction across the boundary.
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1], next = sorted[k]; const ms = next.transitionMs ?? p.transitionMs; if (ms <= 0 || next.start - prev.end > .12) continue;
    const half = Math.round(ms / 1000 / hop / 2); const at = Math.round(next.start / hop); const from = Math.max(0, at - half), to = Math.min(n - 1, at + half);
    const v0 = desired[from], v1 = desired[to]; for (let i = from; i <= to; i++) if (f0[i]) desired[i] = v0 + (v1 - v0) * (i - from) / Math.max(1, to - from);
  }
  // Retune speed: the correction follows the desired value with a one-pole time constant; unvoiced frames hold briefly then release.
  const out = new Float32Array(n); const a = p.retuneMs <= 0 ? 1 : 1 - Math.exp(-hop / (p.retuneMs / 1000)); let c = 0, silent = 0;
  for (let i = 0; i < n; i++) {
    if (inNote[i]) { c += (desired[i] - c) * a; silent = 0; }
    else { silent++; if (silent * hop > .08) c *= .9; }
    out[i] = c;
  }
  return out;
}

/** The pitch you will hear (MIDI, 0 = unvoiced) for display. */
export function correctedPitch(track: PitchTrack, cents: Float32Array): Float32Array {
  const out = new Float32Array(track.f0.length); for (let i = 0; i < out.length; i++) out[i] = track.f0[i] ? track.f0[i] + cents[i] / 100 : 0; return out;
}

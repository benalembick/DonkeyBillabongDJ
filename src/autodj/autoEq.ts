/**
 * Pure Auto EQ maths (no mixer/audio calls): given how far a transition has progressed,
 * returns how much each band should be temporarily cut on a deck. DJEngine adds these
 * dB values on top of the user's manual EQ (see DJEngine.applyMixer); it never changes
 * the stored knob position, and only ever cuts, never boosts.
 */
import type { DeckState } from "../core/engine/DJEngine";
import { clamp } from "../core/engine/mixerMath";
import type { TransitionPlan } from "./transition";

export type BassSwapTiming = "early" | "middle" | "late";

export interface AutoEqSettings {
  enabled: boolean;
  bands: { lows: boolean; mids: boolean; highs: boolean };
  /** 0..1 — how deeply the enabled bands are cut; 0 applies no automatic EQ at all. */
  strength: number;
  /** Where in the fade the bass swap is centred (only shown/used while Lows is enabled). */
  bassSwapTiming: BassSwapTiming;
}

export const DEFAULT_AUTO_EQ: AutoEqSettings = {
  enabled: false,
  bands: { lows: true, mids: true, highs: true },
  strength: 1,
  bassSwapTiming: "middle",
};

/** Deepest cut (magnitude, dB) at strength 1 — lows swap cleanly (near-kill); mids/highs stay a blend, not a mute. */
const MAX_CUT_LOW_DB = 30;
const MAX_CUT_MID_DB = 15;
const MAX_CUT_HIGH_DB = 10;

const BASS_SWAP_FRACTION: Record<BassSwapTiming, number> = { early: 0.25, middle: 0.5, late: 0.75 };
/** Beat grids this unreliable aren't "suitable" for centring the swap on a downbeat (matches planTransition's own bar). */
const MIN_GRID_CONFIDENCE = 1.4;
const BEATS_PER_BAR = 4;

export interface AutoEqCurve {
  lowDb: number;
  midDb: number;
  highDb: number;
}
const NEUTRAL: AutoEqCurve = { lowDb: 0, midDb: 0, highDb: 0 };

/** Smoothstep easing, 0..1 in, 0..1 out. */
function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Where (in seconds elapsed since the transition started, i.e. the same clock as
 * `AutoDJ`'s `fade.elapsed`/`fade.duration`) the bass swap should be centred. Snaps to the
 * nearest downbeat of the outgoing deck when Beat Sync is driving the transition and its
 * grid is reliable; otherwise just uses the configured fraction of the fade. Always leaves
 * room for the swap's own ramp width on both sides, so the ramp never spills outside the fade.
 */
export function bassSwapOffset(plan: TransitionPlan, out: DeckState, settings: AutoEqSettings): number {
  const duration = plan.seconds;
  const rampHalfWidth = clamp(duration * 0.15, 0.25, Math.min(3, duration / 2 - 0.01));
  const desired = duration * BASS_SWAP_FRACTION[settings.bassSwapTiming];
  const grid = out.beatGrid;
  if (plan.sync && grid && grid.confidence >= MIN_GRID_CONFIDENCE && grid.bpm > 0) {
    const barLen = (BEATS_PER_BAR * 60) / grid.bpm; // outgoing-track seconds per bar
    const desiredTrackPos = plan.mixOut + desired * out.rate;
    const bars = Math.round((desiredTrackPos - grid.firstBeat) / barLen);
    const snappedTrackPos = grid.firstBeat + bars * barLen;
    const snapped = (snappedTrackPos - plan.mixOut) / out.rate;
    return clamp(snapped, rampHalfWidth, duration - rampHalfWidth);
  }
  return clamp(desired, rampHalfWidth, duration - rampHalfWidth);
}

/**
 * Per-band attenuation (dB, <= 0) for one deck at `elapsed` seconds into a `duration`-second
 * transition. `role` is this deck's part in the handover; `swapAt` is `bassSwapOffset`'s result.
 */
export function autoEqCurve(role: "in" | "out", elapsed: number, duration: number, swapAt: number, settings: AutoEqSettings): AutoEqCurve {
  if (!settings.enabled || settings.strength <= 0 || duration <= 0) return NEUTRAL;
  const p = clamp(elapsed / duration, 0, 1);
  const s = clamp(settings.strength, 0, 1);
  const b = settings.bands;

  let lowDb = 0;
  if (b.lows) {
    const halfWidth = clamp(duration * 0.15, 0.25, Math.min(3, duration / 2 - 0.01));
    const swapT = clamp((elapsed - (swapAt - halfWidth)) / (2 * halfWidth), 0, 1); // 0 before the swap window, 1 after
    const eased = smooth01(swapT);
    // Incoming starts cut, restores through the swap; outgoing is the mirror image.
    lowDb = (role === "in" ? -(1 - eased) : -eased) * MAX_CUT_LOW_DB * s;
  }

  let midDb = 0;
  if (b.mids) {
    // Narrowed crossover (mid 40% of the fade): outside it, one deck is clearly cut and the
    // other untouched, so both decks are never "strong" in the mids for long.
    const blend = smooth01((p - 0.3) / 0.4);
    midDb = (role === "in" ? -(1 - blend) : -blend) * MAX_CUT_MID_DB * s;
  }

  let highDb = 0;
  if (b.highs) {
    // Incoming's highs arrive early (most of the way in by ~35% of the fade); outgoing's
    // pull back tracks that same curve, so it reads as "following" the incoming deck in.
    const inRestored = smooth01(p / 0.35);
    highDb = (role === "in" ? -(1 - inRestored) : -inRestored) * MAX_CUT_HIGH_DB * s;
  }

  return { lowDb, midDb, highDb };
}

/**
 * Jog-wheel behaviour, independent of any controller. Controllers deliver
 * signed tick deltas; this module converts them into playback intents.
 */

export interface JogSettings {
  /** Ticks the controller reports for one full platter revolution (calibrate in Diagnostics). */
  ticksPerRevolution: number;
  /** Virtual record speed: seconds of audio per platter revolution when scratching (33⅓ rpm ≈ 1.8 s). */
  secondsPerRevolution: number;
  /** Multiplier for paused-deck positioning. */
  jogSensitivity: number;
  /** Multiplier for scratch movement. */
  scratchSensitivity: number;
  /** Rate offset added per tick while playing (decays in the audio engine). */
  pitchBendStrength: number;
  /** Multiplier applied to the shifted "search" jog. */
  searchMultiplier: number;
}

export const DEFAULT_JOG_SETTINGS: JogSettings = {
  ticksPerRevolution: 720,
  secondsPerRevolution: 1.8,
  jogSensitivity: 1,
  scratchSensitivity: 1,
  pitchBendStrength: 0.004,
  searchMultiplier: 20,
};

export type JogIntent =
  | { kind: "scratch"; seconds: number }
  | { kind: "nudge"; rateOffset: number }
  | { kind: "seek"; seconds: number }
  | { kind: "none" };

export interface JogContext {
  playing: boolean;
  vinylMode: boolean;
  touched: boolean;
  loaded: boolean;
}

/**
 * - Platter (top) while touched in vinyl mode → scratch (audio follows the hand).
 * - Otherwise while playing → temporary pitch bend (nudge).
 * - Otherwise while paused → precise positioning (seek by the wheel's travel).
 * - "search" (shift + jog) → fast seek regardless of play state.
 */
export function jogIntent(
  surface: "platter" | "ring" | "search",
  ticks: number,
  ctx: JogContext,
  s: JogSettings,
): JogIntent {
  if (!ctx.loaded || ticks === 0) return { kind: "none" };
  const revolutions = ticks / s.ticksPerRevolution;
  if (surface === "search") {
    return { kind: "seek", seconds: revolutions * s.secondsPerRevolution * s.searchMultiplier };
  }
  if (surface === "platter" && ctx.vinylMode && ctx.touched) {
    return { kind: "scratch", seconds: revolutions * s.secondsPerRevolution * s.scratchSensitivity };
  }
  if (ctx.playing) return { kind: "nudge", rateOffset: ticks * s.pitchBendStrength };
  return { kind: "seek", seconds: revolutions * s.secondsPerRevolution * s.jogSensitivity };
}

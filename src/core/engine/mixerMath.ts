/**
 * Pure mixer maths (no Web Audio). The DJ engine converts control positions
 * into DSP parameters here, so curves are testable and backend-independent.
 */

export const EQ_KILL_DB = -40;
/** Channel EQ corner frequencies (low shelf, mid peak, high shelf) — shared by the audio EQ and the waveform bands. */
export const EQ_LOW_HZ = 220;
export const EQ_MID_HZ = 1000;
export const EQ_HIGH_HZ = 3500;
export const EQ_MAX_DB = 6;
const CENTER_DEADZONE = 0.02;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** EQ knob (0..1, centre 0.5 = flat) → dB. Lower half is linear in amplitude so the cut is progressive; far left ≈ kill. */
export function eqKnobToDb(v: number): number {
  v = clamp(v, 0, 1);
  if (Math.abs(v - 0.5) <= CENTER_DEADZONE) return 0;
  if (v > 0.5) return ((v - 0.5 - CENTER_DEADZONE) / (0.5 - CENTER_DEADZONE)) * EQ_MAX_DB;
  const amp = (v / (0.5 - CENTER_DEADZONE)) ** 2;
  if (amp <= 0) return EQ_KILL_DB;
  return Math.max(EQ_KILL_DB, 20 * Math.log10(amp));
}

/** Trim/gain knob (0..1, centre = 0 dB) → dB in ±12. */
export function gainKnobToDb(v: number): number {
  v = clamp(v, 0, 1);
  if (Math.abs(v - 0.5) <= CENTER_DEADZONE) return 0;
  return (v - 0.5) * 24;
}

export interface FilterParams {
  /** Low-pass cutoff in Hz (20000 = open). */
  lowpassHz: number;
  /** High-pass cutoff in Hz (10 = open). */
  highpassHz: number;
}
export const FILTER_OPEN: FilterParams = { lowpassHz: 20000, highpassHz: 10 };

/** Single "colour" filter knob: left = low-pass sweep, right = high-pass sweep, centre = bypass. */
export function filterKnobToParams(v: number): FilterParams {
  v = clamp(v, 0, 1);
  const dz = 0.03;
  if (Math.abs(v - 0.5) <= dz) return { ...FILTER_OPEN };
  if (v < 0.5) {
    const t = (0.5 - dz - v) / (0.5 - dz); // 0..1
    return { lowpassHz: 20000 * Math.pow(60 / 20000, t), highpassHz: 10 };
  }
  const t = (v - 0.5 - dz) / (0.5 - dz);
  return { lowpassHz: 20000, highpassHz: 20 * Math.pow(8000 / 20, t) };
}

/** Channel fader position → linear gain (roughly audio-taper). */
export function faderToGain(v: number): number {
  v = clamp(v, 0, 1);
  return v * v;
}

export type CrossfaderCurve = "smooth" | "additive" | "sharp";

/**
 * Crossfader position (0 = full left/A, 1 = full right/B) → [gainLeft, gainRight].
 *  - smooth:   constant power (-3 dB each side at centre)
 *  - additive: both sides full at centre, linear fade towards the far side
 *  - sharp:    scratch/cut curve, near-instant cut at the extremes
 */
export function crossfaderGains(x: number, curve: CrossfaderCurve = "additive"): [number, number] {
  x = clamp(x, 0, 1);
  switch (curve) {
    case "smooth":
      return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
    case "additive":
      return [clamp(2 * (1 - x), 0, 1), clamp(2 * x, 0, 1)];
    case "sharp": {
      const cut = 0.03;
      return [x >= 1 - cut ? 0 : 1, x <= cut ? 0 : 1];
    }
  }
}

/** Headphone mix (0 = cue only, 1 = master only) → [cueGain, masterGain], constant power. */
export function headMixGains(x: number): [number, number] {
  x = clamp(x, 0, 1);
  return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * How strongly a band should show in the waveform for an EQ knob (+ kill): the same
 * knob → dB curve as the audio EQ, so the picture follows what is heard. Kill / full
 * cut = 0, centre = 1; boosts are compressed (+6 dB → 1.5) so colours don't blow out.
 */
export function eqVisualGain(knob: number, kill: boolean): number {
  if (kill) return 0;
  const db = eqKnobToDb(knob);
  if (db <= EQ_KILL_DB) return 0;
  const g = dbToGain(db);
  return g <= 1 ? g : 1 + (Math.min(g, 2) - 1) * 0.5;
}

// ── Live, human-readable readouts for the mixer's knobs (learning/"what is this doing" display) ──

const fmtDb = (db: number): string => `${db >= 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dB`;
const fmtHz = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${Math.round(hz)} Hz`);

/** TRIM knob. */
export function describeGainKnob(v: number): string {
  const db = gainKnobToDb(v);
  return Math.abs(db) < 0.05 ? "0 dB (unity)" : fmtDb(db);
}

/** HI/MID/LOW EQ knob + its kill switch. */
export function describeEqKnob(v: number, killed: boolean): string {
  if (killed) return "KILLED (full cut)";
  const db = eqKnobToDb(v);
  if (db <= EQ_KILL_DB) return "Full cut";
  if (Math.abs(db) < 0.05) return "0 dB (flat)";
  return fmtDb(db);
}

/** Colour FILTER knob. */
export function describeFilterKnob(v: number): string {
  const { lowpassHz, highpassHz } = filterKnobToParams(v);
  if (lowpassHz < FILTER_OPEN.lowpassHz) return `Low-pass, cutoff ${fmtHz(lowpassHz)}`;
  if (highpassHz > FILTER_OPEN.highpassHz) return `High-pass, cutoff ${fmtHz(highpassHz)}`;
  return "Open (no filter)";
}

/** A plain 0..1 fader-curve knob (master/headphone level): shows both the position and the resulting gain. */
export function describeFaderKnob(v: number): string {
  const db = 20 * Math.log10(Math.max(1e-5, faderToGain(v)));
  return v < 0.01 ? `${Math.round(v * 100)}% (silent)` : `${Math.round(v * 100)}% (${fmtDb(db)})`;
}

/** Headphone cue/master mix knob (0 = cue only, 1 = master only). */
export function describeHeadMixKnob(v: number): string {
  if (v < 0.01) return "Cue only";
  if (v > 0.99) return "Master only";
  return `${Math.round((1 - v) * 100)}% cue / ${Math.round(v * 100)}% master`;
}

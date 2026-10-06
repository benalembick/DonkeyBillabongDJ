/**
 * Teach Me: Live Looping — pure scoring maths (timing error, loop-capture accuracy, consistency, feedback text).
 * No audio or engine access: everything here takes already-measured audio-clock numbers and is unit-tested.
 */

/** Centrally defined, forgiving beginner timing windows (ms). Every drill scores against these same numbers. */
export const TIMING_WINDOWS = {
  /** Within this many ms of the target: "Perfect". */
  perfectMs: 40,
  /** Within this many ms: full marks, "Good". Beyond it (up to missMs) scores taper to 0. */
  goodMs: 90,
  /** Beyond this many ms the tap still counts (and still earns completion milestones) but scores 0 for precision. */
  missMs: 180,
} as const;

export type TapJudgement = "perfect" | "good" | "ok" | "miss";

/** Signed timing error in ms of `t` against the nearest `beatSeconds` multiple from `origin` (negative = early). */
export function nearestBeatErrorMs(t: number, origin: number, beatSeconds: number): number {
  const x = t - origin; const nearest = Math.round(x / beatSeconds) * beatSeconds; return (x - nearest) * 1000;
}

export function judgeTap(errorMs: number): TapJudgement {
  const abs = Math.abs(errorMs);
  if (abs <= TIMING_WINDOWS.perfectMs) return "perfect";
  if (abs <= TIMING_WINDOWS.goodMs) return "good";
  if (abs <= TIMING_WINDOWS.missMs) return "ok";
  return "miss";
}

/** "Early by 42 ms.", "Late by 65 ms.", "Perfect — within the target window." `where` adds e.g. "at the start". */
export function describeTap(errorMs: number, where = ""): string {
  const suffix = where ? ` ${where}` : "";
  if (judgeTap(errorMs) === "perfect") return `Perfect${suffix} — within the target window.`;
  const ms = Math.round(Math.abs(errorMs));
  return errorMs < 0 ? `Early${suffix} by ${ms} ms.` : `Late${suffix} by ${ms} ms.`;
}

/** 0–100: full marks inside the "good" window, tapering linearly to 0 at the miss threshold. */
export function tapScore(errorMs: number): number {
  const abs = Math.abs(errorMs);
  if (abs <= TIMING_WINDOWS.goodMs) return 100;
  if (abs >= TIMING_WINDOWS.missMs) return 0;
  return Math.round(100 * (1 - (abs - TIMING_WINDOWS.goodMs) / (TIMING_WINDOWS.missMs - TIMING_WINDOWS.goodMs)));
}

/** Consistency across several attempts: 100 when every error is identical, tapering down as they spread out. */
export function consistencyScore(errorsMs: number[]): number {
  if (errorsMs.length < 2) return 100;
  const mean = errorsMs.reduce((a, b) => a + b, 0) / errorsMs.length;
  const variance = errorsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / errorsMs.length;
  return Math.max(0, Math.round(100 - Math.sqrt(variance) / 1.5));
}

export interface LoopCaptureInput {
  /** Raw REC-press timing vs. the nearest intended beat (ms, negative = early). */
  startErrorMs: number;
  /** Raw LOOP-press timing vs. the nearest intended beat (ms, negative = early). */
  endErrorMs: number;
  /** The recorded loop's actual length in bars (fractional, e.g. 4.08). */
  actualBars: number;
  /** The bar count the drill asked for. */
  targetBars: number;
}
export interface LoopCaptureResult { startScore: number; endScore: number; durationScore: number; total: number; feedback: string[] }

/** Scores a captured loop's start/end timing and resulting duration, with plain-language feedback for each. */
export function scoreLoopCapture(input: LoopCaptureInput): LoopCaptureResult {
  const startScore = tapScore(input.startErrorMs); const endScore = tapScore(input.endErrorMs);
  const barError = input.actualBars - input.targetBars;
  const durationScore = Math.max(0, Math.round(100 - Math.abs(barError) * 400));
  const total = Math.round(startScore * .35 + endScore * .35 + durationScore * .3);
  const feedback: string[] = [describeTap(input.startErrorMs, "at the start"), describeTap(input.endErrorMs, "at the end")];
  feedback.push(Math.abs(barError) > .02
    ? `Your loop was ${input.actualBars.toFixed(2)} bars instead of ${input.targetBars.toFixed(2)}. Try stopping ${barError > 0 ? "slightly earlier" : "slightly later"}.`
    : `Loop length: right on ${input.targetBars} bar${input.targetBars === 1 ? "" : "s"}.`);
  return { startScore, endScore, durationScore, total, feedback };
}

/**
 * Module 2 (Layering & Frequency Management) — a crude but real low-band (~<250 Hz) energy envelope of a layer:
 * one-pole low-pass, then RMS per window, normalised 0–1 against that layer's own loudest window. Not a
 * mastering-grade analyser, but it's the real signal, not a guess: good enough to compare two known layers'
 * low-end presence over time.
 */
export function lowBandEnvelope(data: Float32Array, rate: number, windows = 16): number[] {
  const cutoff = 250; const rc = 1 / (2 * Math.PI * cutoff); const dt = 1 / rate; const a = dt / (rc + dt);
  const filtered = new Float32Array(data.length); let prev = 0;
  for (let i = 0; i < data.length; i++) { prev = prev + a * (data[i] - prev); filtered[i] = prev; }
  const per = Math.max(1, Math.floor(filtered.length / windows)); const out: number[] = [];
  for (let w = 0; w < windows; w++) { let sum = 0, n = 0; for (let i = w * per; i < Math.min(filtered.length, (w + 1) * per); i++) { sum += filtered[i] * filtered[i]; n++; } out.push(n ? Math.sqrt(sum / n) : 0); }
  const max = Math.max(.0001, ...out); return out.map((v) => v / max);
}

/**
 * How much two layers' low ends compete: 0 (never both loud down low at the same time) to 1 (equally present down
 * low at every sampled instant). Only counts moments where at least one of them has real low-end energy, so two
 * quiet layers don't register as a clash just because they're similarly quiet.
 */
export function lowBandClash(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length); let sum = 0, weight = 0;
  for (let i = 0; i < n; i++) { const m = Math.max(a[i], b[i]); if (m < .15) continue; sum += Math.min(a[i], b[i]) / m; weight++; }
  return weight ? sum / weight : 0;
}

/** A plain-language label for a clash score, paired with the percentage so it's never colour-only. */
export function describeClash(clash: number): string {
  const pct = Math.round(clash * 100);
  if (clash >= .6) return `${pct}% low-end overlap — these are fighting for the same space`;
  if (clash >= .3) return `${pct}% low-end overlap — noticeable but not fighting`;
  return `${pct}% low-end overlap — plenty of room`;
}

import { describe, expect, it } from "vitest";
import { analyzeTrack } from "../src/analysis/analyzeTrack";

/**
 * Synthetic 4/4 kick+hat track (like analysis.test.ts's `synth`), but with a per-bar
 * amplitude envelope so a track's "structure" (quiet intro, a drop, a comedown, a
 * second drop, an outro return) can be programmed exactly and checked against it.
 */
function synthSections(bpm: number, sr: number, barAmps: number[]): Float32Array {
  const barLength = (4 * 60) / bpm;
  const duration = barAmps.length * barLength;
  const beat = 60 / bpm;
  const out = new Float32Array(Math.round(duration * sr));
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let t = 0; t < duration; t += beat) {
    const bar = Math.min(barAmps.length - 1, Math.floor(t / barLength));
    const amp = barAmps[bar];
    const s = Math.round(t * sr);
    for (let k = 0; k < sr * 0.12 && s + k < out.length; k++) {
      out[s + k] += Math.sin((2 * Math.PI * 55 * k) / sr) * Math.exp(-k / (sr * 0.04)) * 0.9 * amp;
    }
    const h = Math.round((t + beat / 2) * sr);
    for (let k = 0; k < sr * 0.03 && h + k < out.length; k++) out[h + k] += rnd() * 0.25 * Math.exp(-k / (sr * 0.006)) * amp;
  }
  return out;
}

/** Builds a 128-bar amplitude program: quiet intro, Drop 1, a dip, a ramp into Drop 2, then a comedown and an outro return. */
function barProgram(): number[] {
  const amps = new Array<number>(128);
  const fill = (from: number, to: number, amp: (bar: number) => number) => { for (let b = from; b < to; b++) amps[b] = amp(b); };
  fill(0, 24, () => 0.15); // intro
  fill(24, 48, () => 1.0); // Drop 1
  fill(48, 56, () => 0.08); // breakdown before Build 2
  fill(56, 88, (b) => 0.08 + ((b - 56) / 32) * 0.47); // Build 2 ramp, 0.08 → 0.55
  fill(88, 96, () => 1.0); // Drop 2
  fill(96, 110, () => 0.08); // comedown
  fill(110, 126, () => 0.55); // outro drums return
  fill(126, 128, () => 0.2); // brief fade
  return amps;
}

describe("suggested hot cues (8-pad structural layout)", () => {
  it("places Intro/Build/Drop/Outro pairs at the programmed bars", () => {
    const sr = 11025, bpm = 128, barLength = (4 * 60) / bpm;
    const a = analyzeTrack([synthSections(bpm, sr, barProgram())], sr, 400);
    expect(a.bpm).not.toBeNull();
    expect(Math.abs(a.bpm! - bpm)).toBeLessThan(0.5);

    const cues = a.hotCueSuggestions;
    expect(cues).toHaveLength(8);
    expect(cues.map((c) => c.label)).toEqual(["Intro 1", "Intro 2", "Build 1", "Drop 1", "Build 2", "Drop 2", "Outro 1", "Outro 2"]);
    expect(cues.map((c) => c.kind)).toEqual(["intro", "intro", "build", "drop", "build", "drop", "outro", "outro"]);
    for (const c of cues) expect(c.confidence).toBeGreaterThanOrEqual(0.6); // never filtered out of the hotcue slot mapping

    const atBar = (bar: number) => bar * barLength;
    const tolerance = 4 * barLength; // a few bars either way — this is a heuristic, not a transcription
    expect(cues[0].timestamp).toBe(0); // Intro 1: always exactly the start
    expect(cues[1].timestamp).toBeCloseTo(atBar(8), 1); // Intro 2: exactly 8 bars after Intro 1
    expect(cues[3].timestamp).toBeCloseTo(atBar(24), 0); // Drop 1
    expect(cues[5].timestamp).toBeCloseTo(atBar(88), 0); // Drop 2
    expect(cues[4].timestamp).toBeCloseTo(atBar(56), 0); // Build 2: the quiet bar right before its ramp
    expect(cues[6].timestamp).toBeGreaterThan(cues[5].timestamp); // Outro 1 after Drop 2
    expect(Math.abs(cues[6].timestamp - atBar(110))).toBeLessThan(tolerance); // Outro 1: near the drums' return
    expect(cues[7].timestamp).toBeCloseTo(cues[6].timestamp + atBar(8), 1); // Outro 2: exactly 8 bars after Outro 1

    // Strictly increasing and inside the track.
    for (let i = 1; i < cues.length; i++) expect(cues[i].timestamp).toBeGreaterThan(cues[i - 1].timestamp);
    for (const c of cues) expect(c.timestamp).toBeLessThanOrEqual(128 * barLength);
  });

  it("returns no suggestions for a track too short to have this structure", () => {
    const sr = 11025, bpm = 128;
    const a = analyzeTrack([synthSections(bpm, sr, new Array(20).fill(0.5))], sr, 100);
    expect(a.hotCueSuggestions).toEqual([]);
  });

  it("still suggests cues for a normal-length track at a slower tempo (regression: a bar-count floor used to reject these)", () => {
    // 88 BPM, 62 bars (~169 s) — an entirely ordinary song length that, at this tempo, used to
    // fall just under a since-removed flat 64-bar minimum and silently got zero suggestions.
    const sr = 11025, bpm = 88, barLength = (4 * 60) / bpm;
    const amps = new Array<number>(62);
    const fill = (from: number, to: number, amp: (bar: number) => number) => { for (let b = from; b < to; b++) amps[b] = amp(b); };
    fill(0, 24, () => 0.15); // intro
    fill(24, 34, () => 1.0); // Drop 1
    fill(34, 38, () => 0.08); // breakdown before Build 2
    fill(38, 48, (b) => 0.08 + ((b - 38) / 10) * 0.42); // Build 2 ramp
    fill(48, 52, () => 1.0); // Drop 2
    fill(52, 56, () => 0.08); // comedown
    fill(56, 60, () => 0.55); // outro drums return
    fill(60, 62, () => 0.2); // brief fade

    const a = analyzeTrack([synthSections(bpm, sr, amps)], sr, 400);
    expect(a.bpm).not.toBeNull();
    expect(Math.abs(a.bpm! - bpm)).toBeLessThan(0.5);
    expect(62 * barLength).toBeGreaterThan(90); // sanity: duration alone clears the real floor (62 bars is below the old, now-removed 64-bar one)

    const cues = a.hotCueSuggestions;
    expect(cues).toHaveLength(8);
    expect(cues[0].timestamp).toBe(0);
    for (let i = 1; i < cues.length; i++) expect(cues[i].timestamp).toBeGreaterThan(cues[i - 1].timestamp);
    for (const c of cues) expect(c.timestamp).toBeLessThanOrEqual(62 * barLength);
  });
});

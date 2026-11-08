import { describe, expect, it } from "vitest";
import { autoEqCurve, bassSwapOffset, DEFAULT_AUTO_EQ, type AutoEqSettings } from "../src/autodj/autoEq";
import type { TransitionPlan } from "../src/autodj/transition";
import { DJEngine } from "../src/core/engine/DJEngine";
import type { DeckState } from "../src/core/engine/DJEngine";
import { CommandBus } from "../src/core/commands";
import { EventLog } from "../src/core/log";
import { LibraryStore } from "../src/library/LibraryStore";
import { FakeAudioEngine } from "./fakes";

/** A real DeckState (loaded track + beat grid) rather than a hand-built fake, matching the rest of the suite. */
async function deckWithGrid(bpm: number, firstBeat: number, confidence: number, rate = 1): Promise<DeckState> {
  const bus = new CommandBus(), audio = new FakeAudioEngine(), library = new LibraryStore();
  library.addFiles([{ ref: "a", name: "a.wav" }]);
  const engine = new DJEngine({ bus, audio, log: new EventLog(), browser: library, loadBytes: async () => new ArrayBuffer(180) });
  await engine.loadTrack(0, library.getByRef("a")!);
  engine.setBeatGrid(0, { bpm, firstBeat, confidence, source: "analysis" });
  if (rate !== 1) engine.setRateDirect(0, rate);
  return engine.getState().decks[0];
}

const plan = (over: Partial<TransitionPlan> = {}): TransitionPlan => ({ kind: "beat-mix", mixOut: 100, mixIn: 8, seconds: 16, sync: true, reason: "test", ...over });

describe("Auto EQ: bass-swap timing", () => {
  it("falls back to the configured fraction of the fade when Beat Sync is off", async () => {
    const out = await deckWithGrid(120, 0, 3);
    const p = plan({ sync: false, seconds: 16 });
    expect(bassSwapOffset(p, out, { ...DEFAULT_AUTO_EQ, bassSwapTiming: "early" })).toBeCloseTo(4, 1);
    expect(bassSwapOffset(p, out, { ...DEFAULT_AUTO_EQ, bassSwapTiming: "middle" })).toBeCloseTo(8, 1);
    expect(bassSwapOffset(p, out, { ...DEFAULT_AUTO_EQ, bassSwapTiming: "late" })).toBeCloseTo(12, 1);
  });

  it("falls back to the fraction when synced but the grid is unreliable (low confidence)", async () => {
    const out = await deckWithGrid(120, 0, 1); // below planTransition's own 1.4 reliability bar
    const p = plan({ sync: true, seconds: 16 });
    expect(bassSwapOffset(p, out, DEFAULT_AUTO_EQ)).toBeCloseTo(8, 1);
  });

  it("snaps to the nearest downbeat of the outgoing deck when synced with a reliable grid", async () => {
    const out = await deckWithGrid(120, 0, 3); // beat 0 at t=0 → downbeats every 2s (4 beats @ 120bpm)
    // Middle timing wants mixOut(100) + 8s = 108s; nearest bar boundary at 120bpm/firstBeat=0 is 108s exactly.
    const p = plan({ sync: true, seconds: 16, mixOut: 100 });
    expect(bassSwapOffset(p, out, DEFAULT_AUTO_EQ)).toBeCloseTo(8, 1);
  });

  it("snaps to the beat grid's own offset bars, not bars starting at track time zero", async () => {
    const out = await deckWithGrid(120, 1, 3); // first beat at t=1s → downbeats at 1, 3, 5, 7, 9… (2s bars)
    const p = plan({ sync: true, seconds: 16, mixOut: 100.3 }); // desired track pos 108.3
    // Nearest bar from origin 1 is 109 (bars land on odd seconds here) → offset = 109 - 100.3.
    expect(bassSwapOffset(p, out, DEFAULT_AUTO_EQ)).toBeCloseTo(8.7, 1);
  });

  it("accounts for the outgoing deck's rate when converting track seconds to fade seconds", async () => {
    const out = await deckWithGrid(120, 0, 3, 1.1); // sped up 10%
    const p = plan({ sync: true, seconds: 16, mixOut: 100 });
    // desired track pos = mixOut + 8*1.1 = 108.8 → nearest 2s-bar from 0 is 108 → (108-100)/1.1
    expect(bassSwapOffset(p, out, DEFAULT_AUTO_EQ)).toBeCloseTo((108 - 100) / 1.1, 1);
  });

  it("always leaves room for the ramp's own width on both sides, even for a very short fade", async () => {
    const out = await deckWithGrid(120, 0, 3);
    const p = plan({ sync: false, seconds: 1 }); // "late" would otherwise want 0.75s, barely inside a 1s fade
    const offset = bassSwapOffset(p, out, { ...DEFAULT_AUTO_EQ, bassSwapTiming: "late" });
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(1);
  });
});

describe("Auto EQ: per-band curves", () => {
  const s = DEFAULT_AUTO_EQ;

  it("is neutral everywhere when disabled", () => {
    expect(autoEqCurve("in", 4, 16, 8, { ...s, enabled: false })).toEqual({ lowDb: 0, midDb: 0, highDb: 0 });
  });

  it("is neutral everywhere at zero strength", () => {
    expect(autoEqCurve("in", 4, 16, 8, { ...s, enabled: true, strength: 0 })).toEqual({ lowDb: 0, midDb: 0, highDb: 0 });
  });

  it("only returns attenuation (never a boost) at any point in the fade", () => {
    const eq = { ...s, enabled: true, strength: 1 };
    for (const role of ["in", "out"] as const) {
      for (let t = 0; t <= 16; t += 0.5) {
        const c = autoEqCurve(role, t, 16, 8, eq);
        expect(c.lowDb).toBeLessThanOrEqual(0);
        expect(c.midDb).toBeLessThanOrEqual(0);
        expect(c.highDb).toBeLessThanOrEqual(0);
      }
    }
  });

  it("leaves a band at 0 dB throughout when that band is switched off", () => {
    const eq: AutoEqSettings = { ...s, enabled: true, bands: { lows: false, mids: true, highs: true } };
    for (let t = 0; t <= 16; t += 2) {
      expect(autoEqCurve("in", t, 16, 8, eq).lowDb).toBe(0);
      expect(autoEqCurve("out", t, 16, 8, eq).lowDb).toBe(0);
    }
  });

  it("lows: incoming starts cut and is fully restored by the end of the swap window; outgoing mirrors it", () => {
    const eq = { ...s, enabled: true };
    const before = autoEqCurve("in", 0, 16, 8, eq);
    const after = autoEqCurve("in", 16, 16, 8, eq);
    expect(before.lowDb).toBeLessThan(-1); // cut at the very start
    expect(after.lowDb).toBeCloseTo(0, 5); // long restored by the end
    const outBefore = autoEqCurve("out", 0, 16, 8, eq);
    const outAfter = autoEqCurve("out", 16, 16, 8, eq);
    expect(outBefore.lowDb).toBeCloseTo(0, 5); // outgoing keeps its manual EQ until the swap approaches
    expect(outAfter.lowDb).toBeLessThan(-1);
  });

  it("lows restore and cut move in lockstep (a true swap: together they always total one full cut)", () => {
    const eq = { ...s, enabled: true };
    for (let t = 0; t <= 16; t += 1) {
      const inDb = autoEqCurve("in", t, 16, 8, eq).lowDb;
      const outDb = autoEqCurve("out", t, 16, 8, eq).lowDb;
      expect(inDb + outDb).toBeCloseTo(-30, 5); // -MAX_CUT_LOW_DB at strength 1
    }
  });

  it("highs: incoming is restored early, well before the fade ends", () => {
    const eq = { ...s, enabled: true };
    const early = autoEqCurve("in", 16 * 0.35, 16, 8, eq).highDb;
    expect(Math.abs(early)).toBeLessThan(0.5); // ~fully restored by 35% in
    const veryEarly = autoEqCurve("in", 0, 16, 8, eq).highDb;
    expect(veryEarly).toBeLessThan(-1); // still cut at the very start
  });

  it("mids: both decks are only close to full strength briefly, near the fade's midpoint", () => {
    const eq = { ...s, enabled: true };
    const start = autoEqCurve("out", 0, 16, 8, eq).midDb;
    const end = autoEqCurve("in", 0, 16, 8, eq).midDb;
    expect(start).toBeCloseTo(0, 5); // outgoing starts full
    expect(end).toBeLessThan(-1); // incoming starts attenuated
    // Well before the midpoint, outgoing is still essentially untouched.
    expect(autoEqCurve("out", 16 * 0.2, 16, 8, eq).midDb).toBeCloseTo(0, 1);
  });

  it("strength scales the depth of the cut without changing its shape", () => {
    const full = autoEqCurve("in", 0, 16, 8, { ...s, enabled: true, strength: 1 });
    const half = autoEqCurve("in", 0, 16, 8, { ...s, enabled: true, strength: 0.5 });
    expect(half.lowDb).toBeCloseTo(full.lowDb / 2, 5);
    expect(half.midDb).toBeCloseTo(full.midDb / 2, 5);
    expect(half.highDb).toBeCloseTo(full.highDb / 2, 5);
  });
});

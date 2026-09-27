import { describe, expect, it } from "vitest";
import { DEFAULT_JOG_SETTINGS, jogIntent } from "../src/core/engine/jog";
import { crossfaderGains, eqKnobToDb, filterKnobToParams, gainKnobToDb, headMixGains } from "../src/core/engine/mixerMath";

describe("mixer maths", () => {
  it("EQ centre is flat, extremes are kill / +6 dB, monotonic", () => {
    expect(eqKnobToDb(0.5)).toBe(0);
    expect(eqKnobToDb(0)).toBe(-40);
    expect(eqKnobToDb(1)).toBeCloseTo(6);
    let prev = -Infinity;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const db = eqKnobToDb(v);
      expect(db).toBeGreaterThanOrEqual(prev);
      prev = db;
    }
  });

  it("gain knob spans ±12 dB", () => {
    expect(gainKnobToDb(0)).toBe(-12);
    expect(gainKnobToDb(1)).toBe(12);
    expect(gainKnobToDb(0.51)).toBe(0);
  });

  it("filter: centre open, left low-pass, right high-pass", () => {
    expect(filterKnobToParams(0.5)).toEqual({ lowpassHz: 20000, highpassHz: 10 });
    expect(filterKnobToParams(0).lowpassHz).toBeCloseTo(60);
    expect(filterKnobToParams(1).highpassHz).toBeCloseTo(8000);
    expect(filterKnobToParams(0.25).lowpassHz).toBeLessThan(20000);
    expect(filterKnobToParams(0.75).highpassHz).toBeGreaterThan(10);
  });

  it("crossfader curves", () => {
    expect(crossfaderGains(0.5, "additive")).toEqual([1, 1]);
    expect(crossfaderGains(0, "additive")).toEqual([1, 0]);
    expect(crossfaderGains(1, "additive")).toEqual([0, 1]);
    const [l, r] = crossfaderGains(0.5, "smooth");
    expect(l * l + r * r).toBeCloseTo(1);
    expect(crossfaderGains(0.02, "sharp")).toEqual([1, 0]);
    expect(crossfaderGains(0.1, "sharp")).toEqual([1, 1]);
  });

  it("headphone mix is constant power", () => {
    const [c, m] = headMixGains(0.3);
    expect(c * c + m * m).toBeCloseTo(1);
    expect(headMixGains(0)[0]).toBe(1);
  });
});

describe("jog intent", () => {
  const s = DEFAULT_JOG_SETTINGS;
  const base = { playing: false, vinylMode: true, touched: false, loaded: true };
  it("scratch only on touched platter in vinyl mode", () => {
    expect(jogIntent("platter", 10, { ...base, touched: true }, s).kind).toBe("scratch");
    expect(jogIntent("ring", 10, { ...base, touched: true }, s).kind).toBe("seek");
  });
  it("nudge while playing, seek while paused", () => {
    expect(jogIntent("ring", 3, { ...base, playing: true }, s)).toEqual({ kind: "nudge", rateOffset: 3 * s.pitchBendStrength });
    expect(jogIntent("ring", s.ticksPerRevolution, base, s)).toEqual({ kind: "seek", seconds: s.secondsPerRevolution });
  });
  it("search is a fast seek regardless of state", () => {
    const r = jogIntent("search", s.ticksPerRevolution, { ...base, playing: true }, s);
    expect(r).toEqual({ kind: "seek", seconds: s.secondsPerRevolution * s.searchMultiplier });
  });
  it("nothing happens on an empty deck", () => {
    expect(jogIntent("ring", 5, { ...base, loaded: false }, s).kind).toBe("none");
  });
});

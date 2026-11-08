import { describe, expect, it } from "vitest";
import { DEFAULT_JOG_SETTINGS, jogIntent } from "../src/core/engine/jog";
import { crossfaderGains, dbToEqKnob, describeEqKnob, describeFaderKnob, describeFilterKnob, describeGainKnob, describeHeadMixKnob, eqKnobToDb, filterKnobToParams, gainKnobToDb, headMixGains } from "../src/core/engine/mixerMath";

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

  it("dbToEqKnob round-trips eqKnobToDb — the knob position that would draw this dB on its own", () => {
    expect(dbToEqKnob(0)).toBe(0.5);
    for (const v of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) expect(dbToEqKnob(eqKnobToDb(v))).toBeCloseTo(v, 5);
    expect(dbToEqKnob(-100)).toBe(0); // clamps at the kill floor rather than going negative
    expect(dbToEqKnob(100)).toBe(1); // clamps at the top rather than exceeding the dial
  });
});

describe("knob readouts (the mixer's live 'what is this doing' labels)", () => {
  it("TRIM: unity at centre, signed dB either side", () => {
    expect(describeGainKnob(0.5)).toBe("0 dB (unity)");
    expect(describeGainKnob(1)).toBe("+12.0 dB");
    expect(describeGainKnob(0)).toBe("−12.0 dB");
  });

  it("EQ: flat at centre, signed dB, full cut and kill read distinctly", () => {
    expect(describeEqKnob(0.5, false)).toBe("0 dB (flat)");
    expect(describeEqKnob(1, false)).toBe("+6.0 dB");
    expect(describeEqKnob(0, false)).toBe("Full cut");
    expect(describeEqKnob(0.8, true)).toBe("KILLED (full cut)"); // the kill switch overrides the knob's own position
  });

  it("FILTER: open at centre, low-pass left, high-pass right", () => {
    expect(describeFilterKnob(0.5)).toBe("Open (no filter)");
    expect(describeFilterKnob(0)).toMatch(/^Low-pass, cutoff/);
    expect(describeFilterKnob(1)).toMatch(/^High-pass, cutoff/);
  });

  it("fader knob at full is unity gain, and near zero reads as silent rather than a huge negative dB", () => {
    expect(describeFaderKnob(1)).toBe("100% (+0.0 dB)");
    expect(describeFaderKnob(0)).toBe("0% (silent)");
    expect(describeFaderKnob(0.71)).toMatch(/^71% \(−\d+\.\d dB\)$/);
  });

  it("headphone mix names the extremes and splits the blend in between", () => {
    expect(describeHeadMixKnob(0)).toBe("Cue only");
    expect(describeHeadMixKnob(1)).toBe("Master only");
    expect(describeHeadMixKnob(0.25)).toBe("75% cue / 25% master");
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

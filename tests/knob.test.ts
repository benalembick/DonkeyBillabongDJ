import { describe, expect, it } from "vitest";
import { clampRaw, DETENT, dragDelta, rawToValue, stepValue, valueToRaw, wheelDelta } from "../src/ui/knobMath";

describe("on-screen knob response", () => {
  it("needs ~200 px of drag for the full range, 5x more with Shift", () => {
    expect(dragDelta(0, -200, false)).toBeCloseTo(1);
    expect(dragDelta(200, 0, false)).toBeCloseTo(1);
    expect(dragDelta(0, 10, false)).toBeCloseTo(-0.05);
    expect(dragDelta(0, -10, true)).toBeCloseTo(0.01);
  });

  it("round-trips values through the detent", () => {
    for (const v of [0, 0.2, 0.49, 0.5, 0.51, 0.8, 1]) expect(rawToValue(valueToRaw(v, true), true)).toBeCloseTo(v);
    for (const v of [0, 0.5, 1]) expect(rawToValue(valueToRaw(v, false), false)).toBe(v);
  });

  it("holds bipolar knobs at the centre for a short stretch of drag", () => {
    let raw = valueToRaw(0.45, true);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      raw = clampRaw(raw + dragDelta(0, -1, false), true); // 1 px up at a time
      seen.push(rawToValue(raw, true));
    }
    const centred = seen.filter((v) => v === 0.5).length;
    expect(centred).toBeGreaterThanOrEqual(Math.floor(2 * DETENT * 200) - 1);
    expect(seen.at(-1)!).toBeGreaterThan(0.5);
    // Monotonic: never jumps backwards.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("clamps at both ends", () => {
    expect(rawToValue(clampRaw(5, true), true)).toBe(1);
    expect(rawToValue(clampRaw(-5, false), false)).toBe(0);
  });

  it("turns 2.5% per mouse-wheel notch, up = clockwise, and handles trackpads and Shift+wheel", () => {
    expect(wheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0 }, false)).toBeCloseTo(0.025);
    expect(wheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }, false)).toBeCloseTo(-0.025);
    expect(wheelDelta({ deltaX: 0, deltaY: -3, deltaMode: 1 }, false)).toBeCloseTo(0.02475);
    expect(wheelDelta({ deltaX: 0, deltaY: -4, deltaMode: 0 }, false)).toBeCloseTo(0.001); // trackpad
    expect(wheelDelta({ deltaX: -100, deltaY: 0, deltaMode: 0 }, true)).toBeCloseTo(0.005); // Shift+wheel → deltaX
  });

  it("wheel/key steps stop at the centre of bipolar knobs", () => {
    expect(stepValue(0.49, 0.025, true)).toBe(0.5);
    expect(stepValue(0.5, 0.025, true)).toBeCloseTo(0.525);
    expect(stepValue(0.51, -0.025, true)).toBe(0.5);
    expect(stepValue(0.49, 0.025, false)).toBeCloseTo(0.515);
    expect(stepValue(0.99, 0.025, false)).toBe(1);
  });
});

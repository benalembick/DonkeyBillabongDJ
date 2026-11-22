import { describe, expect, it } from "vitest";
import { CURVE_TEMPLATES, curveAt, curveFromAnchors, curveFromEnergies, estimateTrackCount, normalisePoints, slotTargets, templatePoints } from "../src/setstudio/curves";

describe("energy curves", () => {
  it("provides the six templates, each spanning the whole set", () => {
    expect(CURVE_TEMPLATES.map((t) => t.id)).toEqual(["slow-burn", "peak-valley", "man-in-hole", "opener", "closer", "freehand"]);
    for (const t of CURVE_TEMPLATES) { expect(t.points[0].x).toBe(0); expect(t.points[t.points.length - 1].x).toBe(1); }
  });
  it("interpolates through control points without overshoot", () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0.2 }];
    expect(curveAt(pts, 0)).toBeCloseTo(0);
    expect(curveAt(pts, 0.5)).toBeCloseTo(1);
    for (let x = 0; x <= 1; x += 0.01) { const y = curveAt(pts, x); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1); }
    // Monotone between 0 and 0.5 (rising) and 0.5 and 1 (falling).
    for (let k = 0; k < 10; k++) expect(curveAt(pts, (k + 1) / 20)).toBeGreaterThanOrEqual(curveAt(pts, k / 20) - 1e-9);
    for (let k = 10; k < 20; k++) expect(curveAt(pts, (k + 1) / 20)).toBeLessThanOrEqual(curveAt(pts, k / 20) + 1e-9);
  });
  it("shape semantics: the opener rises, man in hole dips in the middle", () => {
    const o = templatePoints("opener"), m = templatePoints("man-in-hole");
    expect(curveAt(o, 1)).toBeGreaterThan(curveAt(o, 0) + 0.8);
    expect(curveAt(m, 0.5)).toBeLessThan(curveAt(m, 0));
    expect(curveAt(m, 0.9)).toBeGreaterThan(curveAt(m, 0));
  });
  it("normalises unsorted points and fills the ends", () => {
    expect(normalisePoints([{ x: 0.6, y: 0.2 }, { x: 0.3, y: 2 }])).toEqual([{ x: 0, y: 1 }, { x: 0.3, y: 1 }, { x: 0.6, y: 0.2 }, { x: 1, y: 0.2 }]);
  });
  it("builds a curve through anchor energies and from actual energies", () => {
    const c = curveFromAnchors([{ x: 0, energy: 3 }, { x: 0.7, energy: 9 }, { x: 1, energy: 6 }], 1, 10);
    expect(curveAt(c, 0.7) * 9 + 1).toBeCloseTo(9, 1);
    const e = curveFromEnergies([4, null, 8], 1, 10);
    expect(e.length).toBeGreaterThanOrEqual(2);
  });
});

describe("durations", () => {
  it("estimates track count from real, differing track lengths minus overlap", () => {
    const short = estimateTrackCount(3600, [180, 200, 220], 30), long = estimateTrackCount(3600, [480, 540, 600], 30);
    expect(short.count).toBeGreaterThan(long.count);
    expect(short.basis).toBe(3);
    expect(estimateTrackCount(3600, [], 30).basis).toBe(0);
    expect(estimateTrackCount(3600, [360, 360], 60).count).toBe(12);
  });
  it("slot targets follow the curve over actual cumulative time and change when the order changes", () => {
    const set = { curveControlPoints: templatePoints("opener"), energyMin: 1, energyMax: 10, durationTargetSec: 1800, overlapSec: 0 };
    const a = slotTargets(set, [600, 300, 300, 600], 300), b = slotTargets(set, [300, 600, 600, 300], 300);
    expect(a[0]).toBeLessThan(a[3]);
    expect(a).not.toEqual(b);
    expect(a.every((x) => x >= 1 && x <= 10)).toBe(true);
  });
});

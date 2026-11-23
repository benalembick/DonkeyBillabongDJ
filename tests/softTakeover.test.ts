/** Soft takeover / pickup (docs/architecture/four-deck-performance-engine.md §10). */
import { describe, expect, it } from "vitest";
import { MAX_CROSSING_JUMP, relativeScale, SoftTakeover } from "../src/controllers/softTakeover";

function rig(initial: Record<string, number>) {
  const values = { ...initial };
  const t = new SoftTakeover((k) => (k in values ? values[k] : null));
  /** Simulates the controller moving a physical control: returns the value that reached the engine, or null. */
  const move = (target: string, hw: number, physical = "fader") => {
    const v = t.process(target, physical, hw);
    if (v !== null) {
      values[target] = v;
      t.commit(target);
    }
    return v;
  };
  return { t, values, move };
}

describe("soft takeover", () => {
  it("on first connection the hardware drives values straight away (primed)", () => {
    const { t, move } = rig({ vol1: 1 });
    t.prime(["vol1"]);
    expect(move("vol1", 0.3)).toBe(0.3);
  });

  it("the spec example: switching to deck C keeps its 20% until the fader reaches it", () => {
    const { t, values, move } = rig({ vol1: 0.8, vol3: 0.2 });
    t.prime(["vol1"]);
    expect(move("vol1", 0.8)).toBe(0.8);
    // Layer switch: the same physical fader now targets deck C's volume (not engaged).
    t.requirePickup((k) => k === "vol1" || k === "vol3");
    expect(move("vol3", 0.78)).toBeNull();
    expect(values.vol3).toBe(0.2);
    expect(t.getPickups()).toEqual([expect.objectContaining({ target: "vol3", hardware: 0.78, software: 0.2, direction: -1 })]);
    expect(move("vol3", 0.5)).toBeNull();
    expect(move("vol3", 0.26)).toBeNull(); // 6% away: outside the 3% tolerance
    expect(move("vol3", 0.215)).toBeCloseTo(0.215); // within tolerance: picked up
    expect(t.getPickups()).toEqual([]);
    expect(move("vol3", 0.4)).toBe(0.4); // engaged: follows the fader
  });

  it("crossing the software value picks up even without landing inside the tolerance", () => {
    const { t, move } = rig({ eq: 0.3 });
    t.requirePickup(() => true);
    expect(move("eq", 0.6)).toBeNull();
    expect(move("eq", 0.1)).toBe(0.1); // jumped past 0.3 in one message
  });

  it("a big jump between two messages isn't trusted as a crossing (MIDI glitch)", () => {
    const { move } = rig({ eq: 0.5 });
    expect(move("eq", 0.95)).toBeNull();
    expect(move("eq", 0.95 - MAX_CROSSING_JUMP - 0.05)).toBeNull();
  });

  it("jitter around a far-away position never engages", () => {
    const { move } = rig({ pitch: 0.5 });
    for (const v of [0.8, 0.8079, 0.7921, 0.8, 0.8079]) expect(move("pitch", v)).toBeNull();
  });

  it("automation or the mouse moving the value makes the control wait for pickup again", () => {
    const { t, values, move } = rig({ vol: 0.5 });
    t.prime(["vol"]);
    expect(move("vol", 0.5)).toBe(0.5);
    values.vol = 1; // e.g. Auto DJ resets the channel fader
    expect(move("vol", 0.52)).toBeNull();
    expect(values.vol).toBe(1);
    expect(t.getPickups()[0]).toMatchObject({ target: "vol", direction: 1 });
  });

  it("after a reconnect every control waits for pickup and stale positions are forgotten", () => {
    const { t, move } = rig({ vol: 0.5 });
    t.prime(["vol"]);
    move("vol", 0.6);
    t.reset();
    expect(t.isEngaged("vol")).toBe(false);
    // The pre-disconnect position (0.6) must not count as one side of a crossing.
    expect(move("vol", 0.2)).toBeNull();
    expect(move("vol", 0.61)).toBe(0.61); // crossed 0.6 from below → engaged
  });

  it("relative scaling meets the software value at the end stop", () => {
    expect(relativeScale(0.2, 0.8, 0.9)).toBeCloseTo(0.6);
    expect(relativeScale(0.2, 0.8, 1)).toBeCloseTo(1);
    expect(relativeScale(0.9, 0.3, 0)).toBeCloseTo(0);
    expect(relativeScale(0.5, 0.5, 0.5)).toBe(0.5);
    const { t, move } = rig({ vol: 0.2 });
    t.updateSettings({ mode: "relative" });
    t.requirePickup(() => true);
    expect(move("vol", 0.8)).toBeNull(); // no previous position yet: nothing to scale
    expect(move("vol", 0.9)).toBeCloseTo(0.6);
  });

  it("mode off passes hardware values straight through", () => {
    const { t, move } = rig({ vol: 0.2 });
    t.updateSettings({ mode: "off" });
    expect(move("vol", 0.9)).toBe(0.9);
  });

  it("controls the engine can't read (e.g. seek) are never held back", () => {
    const { move } = rig({});
    expect(move("deck1.seek", 0.7)).toBe(0.7);
  });
});

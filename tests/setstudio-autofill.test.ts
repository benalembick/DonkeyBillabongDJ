import { describe, expect, it } from "vitest";
import { autoFill, resequence, sequenceScore } from "../src/setstudio/autofill";
import { pairCompat } from "../src/setstudio/scoring";
import type { SetTrack } from "../src/setstudio/types";
import { track } from "./setstudio-helpers";

const keys = ["5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A", "1A", "2A", "3A", "4A"];
function library(): SetTrack[] {
  const out: SetTrack[] = [];
  for (let i = 0; i < 36; i++) out.push(track({ ref: `L${String(i).padStart(2, "0")}`, bpm: 118 + (i % 12), camelot: keys[i % 12], energy: 2 + (i % 9), durationSec: 240 + (i % 5) * 60 }));
  return out;
}

describe("Auto Fill", () => {
  it("fills empty slots, keeps anchors/filled slots fixed and never repeats a track", () => {
    const pool = library();
    const slots = [{ ref: "L00", targetEnergy: 2 }, { ref: null, targetEnergy: 4 }, { ref: null, targetEnergy: 6 }, { ref: "L08", targetEnergy: 10 }, { ref: null, targetEnergy: 8 }, { ref: null, targetEnergy: 5 }];
    const r = autoFill(slots, pool);
    expect(r.refs[0]).toBe("L00");
    expect(r.refs[3]).toBe("L08");
    expect(r.refs.every((x) => x)).toBe(true);
    expect(new Set(r.refs).size).toBe(r.refs.length);
    expect(r.filled).toBe(4);
    expect(r.unfilled).toBe(0);
  });

  it("never re-uses a track that is fixed later in the set", () => {
    const pool = library(), anchor = pool.find((t) => t.energy === 4)!;
    const r = autoFill([{ ref: null, targetEnergy: 4 }, { ref: null, targetEnergy: 4 }, { ref: anchor.ref, targetEnergy: 4 }], pool);
    expect(r.refs.filter((x) => x === anchor.ref)).toHaveLength(1);
  });

  it("treats the same audio saved under several paths as one track", () => {
    const copies = ["a.mp3", "a2.mp3", "a3.mp3"].map((ref) => track({ ref, trackId: "sha256:same", energy: 5 }));
    const others = [track({ ref: "b.mp3", energy: 4 }), track({ ref: "c.mp3", energy: 3 })];
    const r = autoFill([5, 5, 5].map((t) => ({ ref: null, targetEnergy: t })), [...copies, ...others]);
    expect(r.refs.filter((x) => x?.startsWith("a"))).toHaveLength(1);
    // A locked copy elsewhere also counts.
    const r2 = autoFill([{ ref: null, targetEnergy: 5 }, { ref: "a3.mp3", targetEnergy: 5 }], [...copies, ...others]);
    expect(r2.refs[0]?.startsWith("a")).toBe(false);
  });

  it("doesn't prefer tracks whose key is unknown over a known compatible key", () => {
    const prev = track({ ref: "p", camelot: "8A", bpm: 124, energy: 6 });
    const unknown = track({ ref: "u", camelot: null, key: null, bpm: 124, energy: 6 });
    const boost = track({ ref: "k", camelot: "10A", bpm: 124, energy: 6 }); // +2 "energy boost", workable
    const r = autoFill([{ ref: "p", targetEnergy: 6 }, { ref: null, targetEnergy: 6 }], [prev, unknown, boost]);
    expect(r.refs[1]).toBe("k");
  });

  it("is deterministic", () => {
    const slots = Array.from({ length: 8 }, (_, i) => ({ ref: null, targetEnergy: 2 + i }));
    expect(autoFill(slots, library()).refs).toEqual(autoFill(slots, library()).refs);
  });

  it("leaves flexible slots empty", () => {
    const r = autoFill([{ ref: null, targetEnergy: 4 }, { ref: null, targetEnergy: 5, flexible: true }, { ref: null, targetEnergy: 6 }], library());
    expect(r.refs[1]).toBeNull();
    expect(r.refs[0]).toBeTruthy();
    expect(r.refs[2]).toBeTruthy();
  });

  it("follows the energy targets", () => {
    const targets = [2, 4, 6, 8, 10];
    const r = autoFill(targets.map((t) => ({ ref: null, targetEnergy: t })), library());
    const energies = r.refs.map((ref) => library().find((t) => t.ref === ref)!.energy!);
    energies.forEach((e, i) => expect(Math.abs(e - targets[i])).toBeLessThanOrEqual(2));
  });

  it("optimises the whole sequence, at least as well as one-slot-at-a-time greedy", () => {
    const pool = library(), slots = Array.from({ length: 7 }, (_, i) => ({ ref: null, targetEnergy: 3 + i }));
    const best = autoFill(slots, pool);
    const ef = (t: SetTrack, x: number) => Math.max(0, 1 - Math.abs(t.energy! - x) / 4);
    const greedy: SetTrack[] = [];
    for (const s of slots) {
      const used = new Set(greedy.map((t) => t.ref)), prev = greedy[greedy.length - 1];
      const c = pool.filter((t) => !used.has(t.ref)).sort((a, b) => ((prev ? pairCompat(prev, b) : 0) + ef(b, s.targetEnergy)) - ((prev ? pairCompat(prev, a) : 0) + ef(a, s.targetEnergy)) || a.ref.localeCompare(b.ref))[0];
      greedy.push(c);
    }
    const total = (ts: SetTrack[]) => ts.reduce((acc, t, i) => acc + ef(t, slots[i].targetEnergy) + (i ? pairCompat(ts[i - 1], t) : 0), 0);
    const chosen = best.refs.map((r) => pool.find((t) => t.ref === r)!);
    expect(total(chosen)).toBeGreaterThanOrEqual(total(greedy) - 1e-9);
  });

  it("respects hard constraints", () => {
    const r = autoFill(Array.from({ length: 4 }, () => ({ ref: null, targetEnergy: 6 })), library(), { hard: { bpmMin: 120, bpmMax: 124, maxBpmJumpPct: 3 } });
    for (const ref of r.refs.filter(Boolean)) { const t = library().find((x) => x.ref === ref)!; expect(t.bpm).toBeGreaterThanOrEqual(120); expect(t.bpm).toBeLessThanOrEqual(124); }
  });

  it("reports slots it couldn't fill instead of forcing a track", () => {
    const r = autoFill([{ ref: null, targetEnergy: 5 }, { ref: null, targetEnergy: 5 }], [track({ ref: "only" })]);
    expect(r.refs.filter(Boolean)).toEqual(["only"]);
    expect(r.unfilled).toBe(1);
  });
});

describe("resequence", () => {
  it("keeps locked positions and uses every unlocked track exactly once", () => {
    const pool = library().slice(0, 8);
    const slots = pool.map((t, i) => ({ ref: t.ref, targetEnergy: 2 + i, locked: i === 0 || i === 7 }));
    const r = resequence(slots, pool);
    expect(r.refs[0]).toBe(pool[0].ref);
    expect(r.refs[7]).toBe(pool[7].ref);
    expect([...r.refs].sort()).toEqual(pool.map((t) => t.ref).sort());
    // Resequencing keeps every slot's entry, even two copies of the same audio.
    const dupes = [track({ ref: "x1", trackId: "sha256:x" }), track({ ref: "x2", trackId: "sha256:x" }), track({ ref: "y" })];
    expect(resequence(dupes.map((t) => ({ ref: t.ref, targetEnergy: 6, locked: false })), dupes).refs.filter(Boolean)).toHaveLength(3);
    const before = sequenceScore(pool, slots.map((s) => s.targetEnergy)), after = sequenceScore(r.refs.map((x) => pool.find((t) => t.ref === x)!), slots.map((s) => s.targetEnergy));
    expect(after.pairMean! + after.energyMean!).toBeGreaterThanOrEqual(before.pairMean! + before.energyMean! - 1e-9);
  });
});

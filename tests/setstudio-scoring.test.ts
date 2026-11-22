import { describe, expect, it } from "vitest";
import { bpmRelation, evaluateTransition, harmonic, isExcluded, rankCandidates, scoreCandidate, type CandidateScore } from "../src/setstudio/scoring";
import { track } from "./setstudio-helpers";

const score = (x: ReturnType<typeof scoreCandidate>) => { if (isExcluded(x)) throw new Error(`excluded: ${x.excluded}`); return x as CandidateScore; };

describe("harmonic compatibility (Camelot)", () => {
  it("ranks key relationships", () => {
    expect(harmonic("8A", "8A")!.score).toBe(1);
    expect(harmonic("Am", "C")!.label).toBe("Relative major/minor");
    expect(harmonic("8A", "9A")!.score).toBeGreaterThan(0.85);
    expect(harmonic("12A", "1A")!.label).toMatch(/Adjacent/);
    expect(harmonic("8A", "10A")!.label).toMatch(/Energy boost/);
    expect(harmonic("8A", "3B")!.clash).toBe(true);
    expect(harmonic(null, "8A")).toBeNull();
  });
});

describe("tempo compatibility", () => {
  it("accepts valid half/double-time relationships with a small penalty", () => {
    const r = bpmRelation(70, 140)!;
    expect(r.ratio).not.toBe(1);
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.score).toBeLessThan(1);
    expect(bpmRelation(70, 140, false)!.score).toBe(0);
  });
  it("scores close tempos high and big jumps low", () => {
    expect(bpmRelation(124, 125)!.score).toBe(1);
    expect(bpmRelation(124, 138)!.score).toBeLessThan(0.1);
    expect(bpmRelation(120, 140)!.score).toBe(0);
    expect(bpmRelation(null, 120)).toBeNull();
  });
});

describe("candidate scoring", () => {
  const prev = track({ ref: "prev", bpm: 124, camelot: "8A", energy: 6 });
  it("produces an explainable 0–100 score", () => {
    const s = score(scoreCandidate(track({ bpm: 125, camelot: "9A", energy: 7.4 }), { prev, targetEnergy: 7, move: "lift" }));
    expect(s.score).toBeGreaterThan(70);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.explanation).toMatch(/^\d+% match — /);
    expect(s.explanation).toMatch(/compatible key/);
    expect(s.explanation).toMatch(/close tempo/);
  });

  it("redistributes weight for unknown features and lowers confidence instead of inventing values", () => {
    const known = score(scoreCandidate(track({ camelot: "8A" }), { prev }));
    const unknownKey = score(scoreCandidate(track({ camelot: null, key: null }), { prev }));
    expect(unknownKey.parts.harmonic).toBeNull();
    expect(unknownKey.confidence).toBeLessThan(known.confidence);
    expect(unknownKey.score).toBeGreaterThan(0);
  });

  it("evaluates both neighbours", () => {
    const next = track({ ref: "next", camelot: "8A", bpm: 124 });
    const fitsBoth = score(scoreCandidate(track({ camelot: "8A" }), { prev, next }));
    const clashesNext = score(scoreCandidate(track({ camelot: "8A" }), { prev, next: track({ ref: "n2", camelot: "2B", bpm: 124 }) }));
    expect(fitsBoth.score).toBeGreaterThan(clashesNext.score);
  });

  it("does not rely on BPM alone", () => {
    const sameBpmBadEverythingElse = score(scoreCandidate(track({ bpm: 124, camelot: "3B", energy: 1, genre: "Ambient" }), { prev, targetEnergy: 6 }));
    const slightlyOffBpmGoodElse = score(scoreCandidate(track({ bpm: 127, camelot: "8A", energy: 6.2 }), { prev, targetEnergy: 6 }));
    expect(slightlyOffBpmGoodElse.score).toBeGreaterThan(sameBpmBadEverythingElse.score);
  });

  it("Next Move re-ranks: lift prefers a controlled rise, cool prefers a drop", () => {
    const up = track({ ref: "up", energy: 7.5 }), down = track({ ref: "down", energy: 4.5 });
    const lift = rankCandidates([down, up], { prev, targetEnergy: 6, move: "lift" }).ranked;
    const cool = rankCandidates([down, up], { prev, targetEnergy: 6, move: "cool" }).ranked;
    expect(lift[0].track.ref).toBe("up");
    expect(cool[0].track.ref).toBe("down");
  });

  it("Go Darker uses timbre and mood, not a lower BPM", () => {
    const dark = track({ ref: "dark", brightness: 0.15, moods: ["dark"], bpm: 126 });
    const slowBright = track({ ref: "slowBright", brightness: 0.85, moods: ["bright"], bpm: 118 });
    expect(rankCandidates([slowBright, dark], { prev, move: "darker" }).ranked[0].track.ref).toBe("dark");
  });

  it("More Vocals uses STEMS vocal presence and says when it is unknown", () => {
    const vocal = track({ ref: "vocal", vocalPresence: 0.7 }), inst = track({ ref: "inst", vocalPresence: 0.02 });
    expect(rankCandidates([inst, vocal], { prev, move: "more-vocals" }).ranked[0].track.ref).toBe("vocal");
    expect(rankCandidates([inst, vocal], { prev, move: "less-vocals" }).ranked[0].track.ref).toBe("inst");
    expect(score(scoreCandidate(track({ vocalPresence: null }), { prev, move: "more-vocals" })).reasons).toContain("vocal content unknown (no STEMS)");
  });

  it("applies hard constraints separately from soft preferences", () => {
    const pool = [track({ ref: "fast", bpm: 140 }), track({ ref: "ok", bpm: 125 }), track({ ref: "clash", camelot: "3B" }), track({ ref: "gone", available: false })];
    const r = rankCandidates(pool, { prev, hard: { maxBpmJumpPct: 6, harmonicOnly: true } });
    expect(r.ranked.map((x) => x.track.ref)).toEqual(["ok"]);
    expect(r.excluded).toBe(3);
    expect(isExcluded(scoreCandidate(track({ ref: "dupe" }), { exclude: new Set(["dupe"]) }))).toBe(true);
    expect(isExcluded(scoreCandidate(track({ ref: "dupe" }), { exclude: new Set(["dupe"]), allowDuplicates: true }))).toBe(false);
  });

  it("lists the same audio content once and excludes copies of tracks already in the set", () => {
    const pool = [track({ ref: "m1", trackId: "sha256:m" }), track({ ref: "m2", trackId: "sha256:m" }), track({ ref: "n" })];
    expect(rankCandidates(pool, { prev }).ranked.map((r) => r.track.ref).filter((r) => r.startsWith("m"))).toHaveLength(1);
    expect(rankCandidates(pool, { prev, exclude: new Set(["sha256:m"]) }).ranked.map((r) => r.track.ref)).toEqual(["n"]);
  });

  it("explains when the energy target is outside what the library has", () => {
    const s = score(scoreCandidate(track({ energy: 4 }), { targetEnergy: 2.5, energySpan: [4, 8.5] }));
    expect(s.explanation).toMatch(/nothing in your library is below energy 4\.0/);
  });

  it("Surprise Me is reproducible and still respects hard constraints", () => {
    const pool = Array.from({ length: 12 }, (_, i) => track({ ref: `s${i}`, bpm: 120 + i }));
    const a = rankCandidates(pool, { prev, move: "surprise", seed: "slot1", hard: { bpmMax: 126 } });
    const b = rankCandidates(pool, { prev, move: "surprise", seed: "slot1", hard: { bpmMax: 126 } });
    expect(a.ranked.map((x) => x.track.ref)).toEqual(b.ranked.map((x) => x.track.ref));
    expect(a.ranked.every((x) => x.track.bpm! <= 126)).toBe(true);
  });
});

describe("transition compatibility", () => {
  it("flags a large tempo jump as red with the delta", () => {
    const t = evaluateTransition(track({ bpm: 124, camelot: "8A", energy: 6 }), track({ bpm: 138, camelot: "8B", energy: 7 }));
    expect(t.state).toBe("red");
    expect(t.primary).toBe("+14 BPM — large tempo jump");
    expect(t.bpmDelta).toBe(14);
  });
  it("is green for a smooth blend and amber for an energy fall", () => {
    expect(evaluateTransition(track({ bpm: 124, camelot: "8A", energy: 6 }), track({ bpm: 125, camelot: "9A", energy: 6.5 })).state).toBe("green");
    const fall = evaluateTransition(track({ energy: 8 }), track({ energy: 4.8 }));
    expect(fall.state).toBe("amber");
    expect(fall.warnings).toContain("Energy falls 3.2 points");
  });
  it("reports harmonic clashes and unknown data", () => {
    expect(evaluateTransition(track({ camelot: "8A" }), track({ camelot: "2B" })).warnings).toContain("Potential harmonic clash");
    const unknown = evaluateTransition(track({ bpm: null, analysed: false }), track({ bpm: null }));
    expect(unknown.state).toBe("amber");
    expect(unknown.warnings.join()).toMatch(/Tempo unknown — analyse both tracks/);
    expect(evaluateTransition(track({ bpm: null }), track({ bpm: null })).warnings.join()).toMatch(/Tempo not detected/);
  });
  it("never shows a perfect score when part of the data is unknown", () => {
    const partial = evaluateTransition(track({ camelot: null, key: null, energy: 6 }), track({ energy: 6 }));
    expect(partial.confidence).toBeLessThan(1);
    expect(partial.score!).toBeLessThan(100);
    const full = evaluateTransition(track({ energy: 6 }), track({ energy: 6 }));
    expect(full.confidence).toBe(1);
    expect(full.score).toBe(100);
  });
  it("treats half/double-time as workable, not red", () => {
    expect(evaluateTransition(track({ bpm: 87 }), track({ bpm: 174 })).state).not.toBe("red");
  });
});

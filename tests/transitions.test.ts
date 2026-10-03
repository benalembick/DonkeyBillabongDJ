import { describe, expect, it } from "vitest";
import {
  barBeatAt, barEnergyFrom, barLength, buildPlan, DEFAULT_SETTINGS, fmtTime, matchTempo, missingAnalysis, rehearsalCue, techniqueOptions, timeAtBar,
  type PlanSettings, type TrackFacts, type TransitionPlan,
} from "../src/transitions/planner";
import { regionsFromEnvelope, vocalEnvelopeFromStems } from "../src/transitions/vocals";

const A_GRID = { bpm: 128, firstBeat: 0.25, confidence: 3, manual: false };
const B_GRID = { bpm: 126, firstBeat: 0.1, confidence: 3, manual: false };
const facts = (over: Partial<TrackFacts>): TrackFacts => ({
  trackId: "id", ref: "ref", title: "T", artist: "", duration: 300, grid: A_GRID, key: "8A", keyConfidence: 0.6, energy: 7,
  sections: [], cues: [], barEnergy: null, vocals: null, stemsCached: false, analysed: true, ...over,
});
const A = () => facts({ trackId: "a", title: "Out", sections: [{ kind: "intro", start: 0, end: 30, confidence: 0.65, energy: 4 }, { kind: "outro", start: 250, end: 300, confidence: 0.65, energy: 4 }], cues: [{ kind: "mix-out", timestamp: 250, confidence: 0.65, label: "Recommended Mix Out" }] });
const B = () => facts({ trackId: "b", title: "In", grid: B_GRID, key: "9A", sections: [{ kind: "intro", start: 0, end: 40, confidence: 0.65, energy: 4 }, { kind: "outro", start: 260, end: 300, confidence: 0.65, energy: 4 }] });
const plan = (a: TrackFacts, b: TrackFacts, s: Partial<PlanSettings> = {}) => {
  const p = buildPlan(a, b, { ...DEFAULT_SETTINGS, ...s });
  if ("error" in p) throw new Error(p.error);
  return p;
};

describe("transition bar/beat maths", () => {
  it("bar lengths, bar times, bar.beat labels and timestamps", () => {
    expect(barLength(120)).toBe(2);
    expect(barLength(128)).toBeCloseTo(1.875);
    expect(timeAtBar(A_GRID, 8)).toBeCloseTo(0.25 + 15);
    expect(barBeatAt(A_GRID, 0.25)).toEqual({ bar: 1, beat: 1 });
    expect(barBeatAt(A_GRID, 0.25 + 1.875 * 8 + 0.46875 * 2)).toEqual({ bar: 9, beat: 3 });
    expect(fmtTime(136.44)).toBe("02:16.4");
    expect(fmtTime(5)).toBe("00:05.0");
  });

  it("tempo matching, including half/double time", () => {
    const m = matchTempo(128, 126);
    expect(m.multiple).toBe(1);
    expect(m.rate).toBeCloseTo(128 / 126);
    expect(m.pct).toBeCloseTo(1.587, 2);
    expect(matchTempo(174, 87)).toMatchObject({ multiple: 2, rate: 1 });
    expect(matchTempo(87, 174)).toMatchObject({ multiple: 0.5, rate: 1 });
  });

  it("per-bar energy follows the grid", () => {
    const fps = 10;
    const rms = Float32Array.from({ length: 300 }, (_, i) => (i < 150 ? 0.2 : 1));
    const e = barEnergyFrom(rms, fps, { bpm: 120, firstBeat: 0, confidence: 3, manual: false }, 30);
    expect(e).toHaveLength(15);
    expect(e[0]).toBeCloseTo(0.2);
    expect(e[14]).toBe(1);
  });
});

describe("transition plans", () => {
  it("phrase-aligned blend: exact timestamps, bars, tempo and steps from the grids", () => {
    const p = plan(A(), B());
    expect(p.outStartBar % 8).toBe(0); // a phrase start
    expect(p.outStart).toBeCloseTo(0.25 + p.outStartBar * 1.875, 6);
    expect(Math.abs(p.outStart - 250)).toBeLessThan(8 * 1.875); // the phrase nearest A's outro / mix-out
    expect(p.inCueBar % 8).toBe(0);
    expect(p.inCue).toBeCloseTo(0.1 + p.inCueBar * (240 / 126), 6);
    expect(p.seconds).toBeCloseTo((16 * 4 * 60) / 128, 6); // 30 s
    expect(p.outEnd).toBeCloseTo(p.outStart + 30, 6);
    expect(p.inRate).toBeCloseTo(128 / 126);
    expect(p.inTempoPct).toBeCloseTo(1.587, 2);
    expect(p.inEnd).toBeCloseTo(p.inCue + 30 * (128 / 126), 6); // = 16 of B's bars
    expect(p.swapAtBar).toBe(9);
    const swap = p.steps.find((s) => /exchange the bass/.test(s.text))!;
    expect(swap.atBeat).toBe(32);
    expect(swap.aTime).toBeCloseTo(timeAtBar(A_GRID, p.outStartBar + 8), 6);
    expect(swap.text).toContain(fmtTime(swap.aTime!));
    expect(p.summary).toContain(`When Track A reaches ${fmtTime(p.outStart)}`);
    expect(p.summary).toContain(`start Track B from ${fmtTime(p.inCue)}`);
    expect(p.summary).toContain("Blend over 16 bars (30.0 s at 128.00 BPM), exchange the bass at bar 9");
    expect(p.steps.some((s) => /Set Track B's tempo to \+1\.6%/.test(s.text))).toBe(true);
    expect(p.steps.map((s) => s.n)).toEqual(p.steps.map((_, i) => i + 1));
  });

  it("starts the blend at the outro even when it ends exactly at the track's last bar", () => {
    const g = { bpm: 124, firstBeat: 0.25, confidence: 7, manual: false };
    const bar = 240 / 124;
    const a = facts({ grid: g, duration: 0.25 + 96 * bar + 0.5, sections: [{ kind: "outro", start: 0.25 + 80 * bar, end: 0.25 + 96 * bar, confidence: 0.65, energy: 3 }] });
    const p = plan(a, B());
    expect(p.outStartBar).toBe(80); // bar 81.1 = the outro
    expect(p.outEnd).toBeCloseTo(0.25 + 96 * bar, 6);
  });

  it("recalculates when the length, target tempo or phrase marker changes", () => {
    const p8 = plan(A(), B(), { bars: 8 });
    expect(p8.seconds).toBeCloseTo(15, 6);
    expect(p8.swapAtBar).toBe(5);
    const slower = plan(A(), B(), { targetBpm: 126 });
    expect(slower.outRate).toBeCloseTo(126 / 128);
    expect(slower.inRate).toBeCloseTo(1);
    expect(slower.seconds).toBeCloseTo((16 * 240) / 126, 6);
    expect(slower.steps.some((s) => /Set Track A's tempo to −1\.6%/.test(s.text))).toBe(true);
    const shifted = plan(A(), B(), { outPhraseOffset: 2, inPhraseOffset: 4 });
    expect(shifted.outStartBar % 8).toBe(2);
    expect(shifted.inCueBar % 8).toBe(4);
  });

  it("manual points override the recommendation", () => {
    const p = plan(A(), B(), { outStartBar: 100, inCueBar: 16 });
    expect(p.outStartBar).toBe(100);
    expect(p.outStart).toBeCloseTo(0.25 + 100 * 1.875, 6);
    expect(p.inCue).toBeCloseTo(0.1 + 16 * (240 / 126), 6);
    expect(p.reasons.join(" ")).toContain("set by you");
  });

  it("missing analysis gives clear states, not a plan", () => {
    expect(missingAnalysis(A(), null)).toEqual(["Track B: choose a track"]);
    expect(missingAnalysis(facts({ analysed: false }), B())).toEqual(["Track A: not analysed yet"]);
    const noGrid = buildPlan(facts({ grid: null }), B(), DEFAULT_SETTINGS);
    expect(noGrid).toEqual({ error: "Track A: no beat grid (analysis found no steady beat)" });
  });

  it("is honest about unknown vocals and unavailable techniques", () => {
    const p = plan(A(), B());
    expect(p.warnings.some((w) => /Vocal activity unknown/.test(w.text))).toBe(true);
    const opts = techniqueOptions(A(), B(), { targetBpm: null }, true);
    expect(opts.find((o) => o.info.id === "vocal-swap")!.available).toBe(false);
    expect(opts.find((o) => o.info.id === "stem-swap")!.why).toMatch(/Needs STEMS for both tracks/);
    expect(techniqueOptions(A(), B(), { targetBpm: null }, false).find((o) => o.info.id === "stem-swap")!.why).toMatch(/isn't available/);
    expect(buildPlan(A(), B(), { ...DEFAULT_SETTINGS, technique: "vocal-swap" })).toMatchObject({ error: expect.stringMatching(/vocal activity/) });
  });

  it("warns about overlapping vocals and steers the points away from them", () => {
    const a = { ...A(), vocals: [[200, 300]] as [number, number][] };
    const b = { ...B(), vocals: [[0, 20], [60, 200]] as [number, number][] };
    const p = plan(a, b);
    const clash = p.warnings.find((w) => /Vocals overlap/.test(w.text));
    const fromVocals = plan({ ...a, vocals: [[0, 1]] }, b);
    expect(fromVocals.warnings.some((w) => /Vocals overlap/.test(w.text))).toBe(false);
    if (clash) expect(clash.text).toMatch(/transition bars \d+–\d+/);
    expect(p.summary).not.toContain("next vocal"); // A sings to the end: no "before the next vocal"
    const later = plan({ ...A(), vocals: [[292, 298]] }, { ...B(), vocals: [] });
    expect(later.outEnd).toBeLessThan(292);
    expect(later.summary).toContain(`before Track A's next vocal at ${fmtTime(292)}`);
  });

  it("far tempos and key clashes: beatmatched techniques unavailable, cut/echo recommended", () => {
    const b = { ...B(), grid: { ...B_GRID, bpm: 100 }, key: "3B" };
    const opts = techniqueOptions(A(), b, { targetBpm: null }, true);
    expect(opts.find((o) => o.info.id === "blend")!.available).toBe(false);
    const rec = opts.find((o) => o.recommended)!;
    expect(["quick-cut", "echo-out"]).toContain(rec.info.id);
    const cut = plan(A(), b, { technique: "quick-cut", bars: 2 });
    expect(cut.inRate).toBe(1); // +28% isn't applied — no overlap, B keeps its own tempo
    expect(cut.steps.some((s) => /Leave Track B at its own tempo/.test(s.text))).toBe(true);
    expect(cut.warnings.some((w) => /Keys clash/.test(w.text))).toBe(true);
    expect(cut.bStartsAtBar).toBe(cut.outStartBar + 2); // B starts on the cut after the 2-bar filter build
  });

  it("echo-out switches the echo on one beat before the downbeat", () => {
    const p = plan(A(), B(), { technique: "echo-out", bars: 4 });
    const on = p.steps.find((s) => /ECHO on/.test(s.text))!;
    expect(on.atBeat).toBe(-1);
    expect(on.aTime).toBeCloseTo(p.outStart - 60 / 128, 6);
    expect(p.steps.find((s) => /switch FX1 off/.test(s.text))!.atBeat).toBe(16);
  });
});

describe("rehearsal clock", () => {
  const p: TransitionPlan = plan(A(), B());
  const beat = 60 / 128;
  it("counts down bars and beats to the start from Track A's position", () => {
    const c = rehearsalCue(p, A_GRID, p.outStart - 4 * 4 * beat);
    expect(c.transitionBar).toBeNull();
    expect(c.countdown).toEqual({ bars: 4, beats: 0, totalBeats: 16 });
    expect(c.next!.kind).toBe("start");
    const almost = rehearsalCue(p, A_GRID, p.outStart - 0.6 * beat);
    expect(almost.countdown).toEqual({ bars: 0, beats: 1, totalBeats: 1 });
  });
  it("switches instructions at their beats and numbers the transition bars", () => {
    const go = rehearsalCue(p, A_GRID, p.outStart + 0.01);
    expect(go.transitionBar).toBe(1);
    expect(go.current!.text).toMatch(/fader up|PLAY/);
    const swap = rehearsalCue(p, A_GRID, timeAtBar(A_GRID, p.outStartBar + 8) + 0.01);
    expect(swap.transitionBar).toBe(9);
    expect(swap.current!.text).toMatch(/MID and HIGH|exchange the bass/);
    expect(rehearsalCue(p, A_GRID, p.outEnd + 3 * barLength(128)).done).toBe(true);
  });
});


describe("vocal regions from STEMS", () => {
  it("finds sung phrases, bridges breaths, drops blips, and reports none for instrumentals", () => {
    const hop = 0.1;
    const env = new Float32Array(300); // 30 s
    for (let i = 50; i < 120; i++) env[i] = 0.3; // 5–12 s
    for (let i = 125; i < 160; i++) env[i] = 0.25; // breath gap 0.5 s → merged: 5–16 s
    for (let i = 200; i < 203; i++) env[i] = 0.4; // 0.3 s blip → dropped
    expect(regionsFromEnvelope(env, hop)).toEqual([[5, 16]]);
    expect(regionsFromEnvelope(new Float32Array(300), hop)).toEqual([]);
  });

  it("measures the vocal channels of cached STEMS PCM", () => {
    const rate = 1000;
    const frames = rate * 4;
    const pcm = new Int16Array(frames * 6);
    for (let f = rate; f < 3 * rate; f++) {
      pcm[f * 6] = 12000 * Math.sin(f / 3); // vocals L/R
      pcm[f * 6 + 1] = 12000 * Math.sin(f / 3);
      pcm[f * 6 + 2] = 20000; // drums: must be ignored
    }
    const env = vocalEnvelopeFromStems(pcm, rate);
    expect(env).toHaveLength(40);
    expect(regionsFromEnvelope(env, 0.1)).toEqual([[1, 3]]);
  });
});

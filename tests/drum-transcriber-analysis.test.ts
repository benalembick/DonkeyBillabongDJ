/**
 * Drum Transcriber — real analysis on synthetic and sample-pack audio with ground truth.
 * Onset timing, false positives, missed hits and classification accuracy are measured (and printed) separately.
 * "Successful transcription" here means the right hits at the right times — not that a MIDI file was produced.
 */
import { afterAll, describe, expect, it } from "vitest";
import { transcribeDrums, type TranscribeResult } from "../src/production/drums/transcribe";
import { decodePack, evaluate, fmt, pattern, RATE, render, type Metrics, type TruthHit } from "./drums-helpers";
import type { DrumLane } from "../src/production/drums/types";

const opts = { sensitivity: .5, minConfidence: .45, mode: "loop" as const };
const report: string[] = [];
afterAll(() => { console.log(`\nDrum Transcriber accuracy report (tolerance ±30 ms)\n${report.join("\n")}\n`); });

async function run(name: string, truth: TruthHit[], duration: number, voices?: Partial<Record<DrumLane, Float32Array>>): Promise<{ r: TranscribeResult; m: Metrics }> {
  const r = await transcribeDrums(render(truth, duration, RATE, voices), RATE, opts);
  const m = evaluate(r.hits, truth); report.push(fmt(name, m)); return { r, m };
}
/** Truth hats struck at the same instant as a snare (a known Phase 1 limitation: masked by the snare's noise). */
const masked = (truth: TruthHit[]) => truth.filter((t) => t.lane.endsWith("hat") && truth.some((s) => (s.lane === "snare" || s.lane === "clap") && Math.abs(s.time - t.time) < .005));
/** Per-lane recall of correctly labelled hits, excluding masked hats. */
function laneRecall(r: TranscribeResult, truth: TruthHit[], lane: DrumLane): number {
  const hidden = new Set(masked(truth)); const want = truth.filter((t) => t.lane === lane && !hidden.has(t));
  return want.filter((t) => r.hits.some((h) => h.lane === lane && Math.abs(h.time - t.time) <= .03)).length / Math.max(1, want.length);
}
/** Nothing is invented at masked-hat moments: the only labels there are ones that really sound. */
function noInventions(r: TranscribeResult, truth: TruthHit[]): void {
  for (const t of masked(truth)) { const sounding = new Set(truth.filter((x) => Math.abs(x.time - t.time) < .005).map((x) => x.lane)); for (const h of r.hits.filter((h) => Math.abs(h.time - t.time) <= .03)) expect(sounding.has(h.lane) || h.lane === "unknown").toBe(true); }
}

describe("single hits", () => {
  for (const lane of ["kick", "snare", "closed-hat"] as DrumLane[]) {
    it(`a single ${lane}`, async () => {
      const { r, m } = await run(`single ${lane}`, [{ time: .25, lane }], 1);
      expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0); expect(m.correctClass).toBe(1);
      expect(r.hits).toHaveLength(1);
      expect(m.maxTimingErrorMs).toBeLessThan(3);
    });
  }
  it("an open hi-hat is told from a closed one by its decay", async () => {
    const { r, m } = await run("single open-hat", [{ time: .25, lane: "open-hat" }], 1.2);
    expect(m.correctClass).toBe(1); expect(m.falsePositives).toBe(0); expect(r.hits).toHaveLength(1);
  });
  it("a clap (three bursts, no body) is labelled clap at its first burst", async () => {
    const { r, m } = await run("single clap", [{ time: .2, lane: "clap" }], 1);
    expect(m.correctClass).toBe(1); expect(r.hits).toHaveLength(1); expect(m.maxTimingErrorMs).toBeLessThan(3);
  });
  it("a hit at the very start of the file (trimmed loop) keeps time 0", async () => {
    const { r } = await run("kick at 0 s", [{ time: 0, lane: "kick" }], .8);
    expect(r.hits[0].lane).toBe("kick"); expect(r.hits[0].time).toBeLessThan(.003);
  });
});

describe("patterns", () => {
  it("repeated kicks (four on the floor, 2 bars @ 120)", async () => {
    const truth = pattern(120, { kick: "x...x...x...x..." }, .1, 2);
    const { r, m } = await run("4-on-the-floor kick", truth, 4.3);
    expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0); expect(m.classAccuracy).toBe(1); expect(r.hits).toHaveLength(8);
    expect(r.tempo?.bpm).toBeCloseTo(120, 0);
  });
  it("mixed kick and snare (backbeat)", async () => {
    const truth = pattern(100, { kick: "x.....x.x.......", snare: "....x.......x..." }, .05, 2);
    const { m } = await run("kick + snare backbeat @100", truth, 5);
    expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0); expect(m.classAccuracy).toBe(1); expect(m.detected).toBe(truth.length);
  });
  it("simultaneous kick and closed hi-hat stay two notes at one time", async () => {
    const truth: TruthHit[] = [{ time: .3, lane: "kick" }, { time: .3, lane: "closed-hat" }, { time: .8, lane: "kick" }, { time: .8, lane: "closed-hat" }];
    const { r, m } = await run("kick + hat simultaneous", truth, 1.4);
    expect(m.correctClass).toBe(4); expect(m.falsePositives).toBe(0); expect(r.hits).toHaveLength(4);
    expect(r.hits.filter((h) => Math.abs(h.time - .3) < .02).map((h) => h.lane).sort()).toEqual(["closed-hat", "kick"]);
  });
  it("simultaneous kick and snare stay two notes", async () => {
    const { r } = await run("kick + snare simultaneous", [{ time: .3, lane: "kick" }, { time: .3, lane: "snare" }], 1);
    expect(r.hits.map((h) => h.lane).sort()).toEqual(["kick", "snare"]);
  });
  it("a full groove: kick, snare and 8th hats (2 bars @ 124)", async () => {
    const truth = pattern(124, { kick: "x.....x...x.....", snare: "....x.......x...", "closed-hat": "x.x.x.x.x.x.x.x." }, .08, 2);
    const { r, m } = await run("kick/snare/8th hats @124", truth, 4.3);
    expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0);
    for (const lane of ["kick", "snare", "closed-hat"] as DrumLane[]) expect(laneRecall(r, truth, lane)).toBe(1);
    noInventions(r, truth);
    expect(r.tempo?.bpm).toBeCloseTo(124, 0);
  });
  it("different tempos: the same groove at 90 and 160 BPM", async () => {
    for (const bpm of [90, 160]) {
      const truth = pattern(bpm, { kick: "x.......x.......", snare: "....x.......x...", "closed-hat": "x.x.x.x.x.x.x.x." }, 0, 2);
      const { r, m } = await run(`groove @${bpm}`, truth, truth[truth.length - 1].time + 60 / bpm);
      expect(m.falsePositives).toBe(0); expect(m.missed).toBeLessThanOrEqual(1);
      expect(laneRecall(r, truth, "kick")).toBe(1); expect(laneRecall(r, truth, "snare")).toBe(1); expect(laneRecall(r, truth, "closed-hat")).toBeGreaterThanOrEqual(.9);
      noInventions(r, truth);
      expect(r.tempo?.bpm).toBeCloseTo(bpm, 0);
    }
  });
  it("off-grid (humanised) timing is preserved, not snapped", async () => {
    const offsets = [0, .013, -.011, .021, -.007, .017, -.019, .009];
    const truth = pattern(110, { kick: "x.......x.......", snare: "....x.......x...", "closed-hat": "..x...x...x...x." }, .1).map((h, i) => ({ ...h, time: h.time + offsets[i % offsets.length] }));
    const { r, m } = await run("humanised kick/snare/hat @110", truth, 2.6);
    expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0); expect(m.classAccuracy).toBe(1); expect(m.maxTimingErrorMs).toBeLessThan(7);
    for (const t of truth) expect(Math.min(...r.hits.map((h) => Math.abs(h.time - t.time)))).toBeLessThan(.007);
  });
  it("known limitation: a hat struck exactly with a snare is masked — the snare is found and nothing is invented", async () => {
    const truth: TruthHit[] = [{ time: .3, lane: "snare" }, { time: .3, lane: "closed-hat" }];
    const { r } = await run("snare + hat simultaneous (limitation)", truth, 1);
    expect(r.hits.some((h) => h.lane === "snare")).toBe(true); noInventions(r, truth);
  });
});

describe("example sample pack (real one-shots, MP3)", () => {
  const pack = { kick: decodePack("01_Kick_Deep_C.mp3"), snare: decodePack("02_Snare_Punch.mp3"), "closed-hat": decodePack("03_HiHat_Closed.mp3"), "open-hat": decodePack("04_HiHat_Open.mp3"), clap: decodePack("05_Clap_Wide.mp3") };
  const available = Object.values(pack).every(Boolean);
  it.skipIf(!available)("each one-shot alone is found once, with its own label", async () => {
    for (const lane of ["kick", "snare", "closed-hat", "open-hat", "clap"] as DrumLane[]) {
      const { r, m } = await run(`pack ${lane} alone`, [{ time: .2, lane }], 1.5, { [lane]: pack[lane as keyof typeof pack]! });
      expect(r.hits).toHaveLength(1); expect(m.correctClass).toBe(1);
    }
  });
  it.skipIf(!available)("pack combinations: kick+hat, kick+snare", async () => {
    const a = await run("pack kick + hat", [{ time: .2, lane: "kick" }, { time: .2, lane: "closed-hat" }], 1.5, pack as Record<DrumLane, Float32Array>);
    expect(a.r.hits.map((h) => h.lane).sort()).toEqual(["closed-hat", "kick"]);
    const b = await run("pack kick + snare", [{ time: .2, lane: "kick" }, { time: .2, lane: "snare" }], 1.5, pack as Record<DrumLane, Float32Array>);
    expect(b.r.hits.map((h) => h.lane).sort()).toEqual(["kick", "snare"]);
  });
  it.skipIf(!available)("a groove built from the pack's kick, snare and hats", async () => {
    const truth = pattern(120, { kick: "x.....x...x.....", snare: "....x.......x...", "closed-hat": "x.x.x.x.x.x.x.x." }, .05, 2);
    const { r, m } = await run("pack groove @120", truth, 4.4, pack as Record<DrumLane, Float32Array>);
    expect(m.missed).toBe(0); expect(m.falsePositives).toBe(0);
    for (const lane of ["kick", "snare", "closed-hat"] as DrumLane[]) expect(laneRecall(r, truth, lane)).toBe(1);
    noInventions(r, truth); expect(r.tempo?.bpm).toBeCloseTo(120, 0);
  });
  it.skipIf(!decodePack("11_DrumLoop_120BPM_1Bar.mp3"))("the pack's 120 BPM drum loop: tempo and on-grid onsets", async () => {
    const loop = decodePack("11_DrumLoop_120BPM_1Bar.mp3")!;
    const r = await transcribeDrums(loop, RATE, opts);
    const lanes = r.hits.reduce<Record<string, number>>((a, h) => ({ ...a, [h.lane]: (a[h.lane] ?? 0) + 1 }), {});
    const offGrid = r.onsets.filter((t) => { const d = (t - (r.tempo?.firstBeat ?? 0)) / .125; return Math.abs(d - Math.round(d)) * 125 > 12; });
    report.push(`${"pack 120 BPM loop (no ground truth)".padEnd(34)} onsets ${r.onsets.length} | off the 1/16 grid by >12 ms: ${offGrid.length} | hits ${JSON.stringify(lanes)} | tempo ${r.tempo?.bpm} (${r.tempo?.source})`);
    expect(r.tempo?.bpm).toBeCloseTo(120, 0);
    expect(r.hits.length).toBeGreaterThanOrEqual(4);
    expect(offGrid.length).toBe(0);
  });
});

describe("invalid input and cancellation", () => {
  it("rejects silence, too-short audio and invalid samples with readable errors", async () => {
    await expect(transcribeDrums(new Float32Array(RATE), RATE, opts)).rejects.toThrow(/silent/);
    await expect(transcribeDrums(new Float32Array(100), RATE, opts)).rejects.toThrow(/too short/);
    const bad = new Float32Array(RATE); bad[7 * 10] = NaN; await expect(transcribeDrums(bad, RATE, opts)).rejects.toThrow(/invalid/);
    await expect(transcribeDrums(render([{ time: .1, lane: "kick" }], 1), RATE, { ...opts, mode: "song" })).rejects.toThrow(/Phase 2/);
  });
  it("can be cancelled part-way through", async () => {
    const audio = render(pattern(120, { kick: "x...x...x...x...", "closed-hat": "x.x.x.x.x.x.x.x." }, 0, 8), 16.5);
    const controller = new AbortController(); const stages: string[] = [];
    const job = transcribeDrums(audio, RATE, opts, { signal: controller.signal, yieldControl: () => new Promise((r) => setTimeout(r, 0)), onProgress: (s) => { stages.push(s); if (s === "spectrum" && stages.length > 2) controller.abort(); } });
    await expect(job).rejects.toMatchObject({ name: "AbortError" });
    expect(stages).not.toContain("tempo");
  });
  it("a long recording (60 s) is analysed in chunks with progress", async () => {
    const audio = render(pattern(128, { kick: "x...x...x...x...", snare: "....x.......x...", "closed-hat": "..x...x...x...x." }, 0, 30), 60);
    const progress: number[] = []; const r = await transcribeDrums(audio, RATE, opts, { onProgress: (_s, p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(10); expect(progress[progress.length - 1]).toBe(1);
    expect(r.tempo?.bpm).toBeCloseTo(128, 0); expect(r.hits.filter((h) => h.lane === "kick").length).toBe(120);
  }, 30000);
});

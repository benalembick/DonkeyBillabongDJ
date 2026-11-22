import { describe, expect, it } from "vitest";
import { buildSuggestionSet, detectCues, quantise, requantise, type CueGrid } from "../src/setstudio/autocue";
import { AutoCueService } from "../src/setstudio/AutoCueService";
import { PreparationStore } from "../src/preparation/PreparationStore";
import { packWaveform, type PreparationPersistence, type TrackPreparation, type WaveformRecord } from "../src/preparation/types";
import type { TrackAnalysis } from "../src/analysis/analyzeTrack";

/**
 * A structured synthetic track at 120 BPM (bar = 2 s), first beat at 1 s:
 * intro bars 0–15 · build 16–31 · drop 32–63 · breakdown 64–71 · drop 72–95 · outro 96–111 · silence.
 */
const FPS = 150, GRID: CueGrid = { bpm: 120, firstBeat: 1, confidence: 3, manual: false };
const SECTIONS: [number, number, number, number][] = [[0, 16, 0.3, 0.1], [16, 32, 0.1, 0.3], [32, 64, 0.9, 0.5], [64, 72, 0.05, 0.2], [72, 96, 0.9, 0.5], [96, 112, 0.15, 0.35]];
function structured(): { low: Float32Array; mid: Float32Array; high: Float32Array; duration: number } {
  const duration = 1 + 112 * 2 + 4, n = Math.round(duration * FPS);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FPS, bar = Math.floor((t - 1) / 2), sec = SECTIONS.find(([a, b]) => bar >= a && bar < b);
    if (!sec || t < 1) { low[i] = mid[i] = high[i] = 0.001; continue; }
    const ph = (t - 1) % 0.5, kick = 0.6 + 0.4 * Math.exp(-ph / 0.05);
    let m = sec[3]; if (sec[0] === 16) m = 0.1 + 0.4 * ((bar - 16) / 16);
    low[i] = sec[2] * kick; mid[i] = m; high[i] = m * 0.4;
  }
  return { low, mid, high, duration };
}
const near = (a: number | undefined, b: number, tol: number) => expect(Math.abs((a ?? -999) - b)).toBeLessThanOrEqual(tol);

describe("Auto Cue detection", () => {
  const s = structured();
  const det = detectCues({ ...s, fps: FPS, grid: GRID, vocals: [[50, 50.5], [70, 90]] });
  const at = (t: string) => det.cues.find((c) => c.cueType === t)?.detectedPosition;

  it("finds the structural moments from the audio envelopes", () => {
    near(at("intro"), 1, 0.5);
    near(at("first-beat"), 1, 0.05);
    near(at("first-phrase"), 1, 0.05);
    near(at("build"), 1 + 16 * 2, 2);
    near(at("drop"), 1 + 32 * 2, 2);
    // Repeated sections are found too (the second drop after the breakdown), numbered.
    const drops = det.cues.filter((c) => c.cueType === "drop");
    expect(drops.map((d) => d.label)).toEqual(["Drop 1", "Drop 2"]);
    near(drops[1].detectedPosition, 1 + 72 * 2, 2);
    near(at("breakdown"), 1 + 64 * 2, 2);
    near(at("outro"), 1 + 96 * 2, 2);
    near(at("mix-out"), 1 + 112 * 2, 2);
    near(at("vocal-entry"), 70, 0.01); // the 0.5 s fragment is ignored
  });

  it("never puts the outro before the last drop", () => {
    for (const c of det.cues.filter((x) => x.cueType === "outro")) expect(c.detectedPosition).toBeGreaterThan(Math.max(...det.cues.filter((x) => x.cueType === "drop").map((x) => x.detectedPosition)));
    // A quieter stretch that contains the second drop is not an outro.
    const s2 = structured(), lowTail = Math.round((1 + 64 * 2) * FPS);
    for (let i = lowTail; i < s2.low.length; i++) s2.low[i] *= 0.45;
    const d2 = detectCues({ ...s2, fps: FPS, grid: GRID, vocals: null });
    const lastDrop = Math.max(...d2.cues.filter((x) => x.cueType === "drop").map((x) => x.detectedPosition));
    for (const c of d2.cues.filter((x) => x.cueType === "outro")) expect(c.detectedPosition).toBeGreaterThan(lastDrop);
  });

  it("records method and confidence, capping bar-based cues because 4/4 is assumed", () => {
    for (const c of det.cues) { expect(c.detectionMethod).toBeTruthy(); expect(c.confidence).toBeGreaterThan(0); expect(c.confidence).toBeLessThanOrEqual(0.95); }
    const drop = det.cues.find((c) => c.cueType === "drop")!;
    expect(drop.confidence).toBeLessThanOrEqual(0.75);
    expect(drop.note).toMatch(/4\/4 assumed/);
  });

  it("suggests mix-in and mix-out regions with rationale and available time", () => {
    expect(det.mixIn.map((m) => m.label)).toEqual(expect.arrayContaining(["Intro", "Instrumental intro", "Pre-drop"]));
    expect(det.mixOut.map((m) => m.label)).toEqual(expect.arrayContaining(["Outro", "Final phrase"]));
    const outro = det.mixOut.find((m) => m.label === "Outro")!;
    near(outro.end, 1 + 112 * 2, 2);
    expect(outro.end).toBeLessThan(s.duration); // not simply the last possible moment
    expect(outro.availableSeconds).toBeGreaterThan(20);
    for (const m of [...det.mixIn, ...det.mixOut]) expect(m.rationale).toBeTruthy();
  });

  it("never invents a vocal entry", () => {
    const none = detectCues({ ...s, fps: FPS, grid: GRID, vocals: null });
    expect(none.cues.some((c) => c.cueType === "vocal-entry")).toBe(false);
    expect(none.unavailable.find((u) => u.cueType === "vocal-entry")?.reason).toMatch(/STEMS/);
    expect(detectCues({ ...s, fps: FPS, grid: GRID, vocals: [] }).unavailable.find((u) => u.cueType === "vocal-entry")?.reason).toMatch(/instrumental/);
  });

  it("omits bar-based cues (with a reason) when the beat grid isn't reliable", () => {
    const d = detectCues({ ...s, fps: FPS, grid: { ...GRID, confidence: 1.1 }, vocals: null });
    for (const t of ["first-beat", "first-phrase", "build", "breakdown", "drop"]) {
      expect(d.cues.some((c) => c.cueType === t)).toBe(false);
      expect(d.unavailable.find((u) => u.cueType === t)?.reason).toMatch(/grid/i);
    }
    expect(d.cues.some((c) => c.cueType === "intro")).toBe(true);
    expect(d.mixOut[0].phraseAligned).toBe(false);
  });

  it("doesn't call the beat arriving after a quiet intro a drop", () => {
    // 4 quiet bars, then the full beat for the rest of the track (pop/hip-hop shape).
    const n = Math.round(200 * FPS), low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / FPS, on = t >= 9; low[i] = on ? 0.8 * (0.6 + 0.4 * Math.exp(-((t - 1) % 0.5) / 0.05)) : 0.02; mid[i] = on ? 0.4 : 0.05; high[i] = mid[i] * 0.4; }
    const d = detectCues({ duration: 200, fps: FPS, low, mid, high, grid: GRID, vocals: null });
    expect(d.cues.some((c) => c.cueType === "drop")).toBe(false);
    expect(d.unavailable.find((u) => u.cueType === "drop")).toBeTruthy();
  });

  it("finds nothing (rather than guessing) in a flat track", () => {
    const n = FPS * 120, flat = new Float32Array(n).fill(0.5);
    const d = detectCues({ duration: 120, fps: FPS, low: flat, mid: flat, high: flat, grid: GRID, vocals: null });
    for (const t of ["drop", "build", "breakdown"]) expect(d.cues.some((c) => c.cueType === t)).toBe(false);
  });
});

describe("quantisation", () => {
  it("uses the existing beat grid and keeps the detected position separately", () => {
    expect(quantise(65.3, GRID, "bar").t).toBe(65);
    expect(quantise(65.3, GRID, "beat").t).toBe(65.5);
    expect(quantise(64.9, GRID, "16bars").t).toBe(65);
    expect(quantise(65.3, GRID, "none").t).toBe(65.3);
  });
  it("won't move a cue to a distant boundary", () => {
    const q = quantise(80, GRID, "16bars");
    expect(q.t).toBe(81);
    expect(q.note).toMatch(/more than 2 bars/);
  });
  it("leaves cues unquantised without a reliable grid", () => {
    expect(quantise(65.3, { ...GRID, confidence: 1 }, "bar")).toMatchObject({ t: 65.3, note: expect.stringMatching(/grid/) });
  });
});

describe("suggestion sets", () => {
  const s = structured();
  const det = detectCues({ ...s, fps: FPS, grid: GRID, vocals: null });
  it("keeps accepted cues and rejected decisions across regeneration, and remembers the previous set", () => {
    const first = buildSuggestionSet(det, GRID, "bar", 1, undefined, 100);
    const drop = first.cues.find((c) => c.cueType === "drop")!, intro = first.cues.find((c) => c.cueType === "intro")!;
    const decided = { ...first, cues: first.cues.map((c) => (c.id === drop.id ? { ...c, reviewStatus: "accepted" as const, slot: 3, quantisedPosition: 66 } : c.id === intro.id ? { ...c, reviewStatus: "rejected" as const } : c)) };
    const again = buildSuggestionSet(det, GRID, "bar", 2, decided, 200);
    expect(again.cues.find((c) => c.cueType === "drop")).toMatchObject({ reviewStatus: "accepted", slot: 3, quantisedPosition: 66 });
    expect(again.cues.find((c) => c.cueType === "intro")?.reviewStatus).toBe("rejected");
    expect(again.previous?.generatedAt).toBe(100);
    expect((again.previous as { previous?: unknown } | undefined)?.previous).toBeUndefined();
  });
  it("requantises only undecided suggestions", () => {
    const set = buildSuggestionSet(det, GRID, "none", 1, undefined);
    const accepted = { ...set, cues: set.cues.map((c, i) => (i === 0 ? { ...c, reviewStatus: "accepted" as const, quantisedPosition: 1.23 } : c)) };
    const r = requantise(accepted, GRID, "bar");
    expect(r.cues[0].quantisedPosition).toBe(1.23);
    expect(r.quantise).toBe("bar");
  });
});

// ── Service: staging, protection, persistence ─────────────────────────────────
function analysisFrom(s: ReturnType<typeof structured>): TrackAnalysis {
  const peaks = new Float32Array(400), rms = new Float32Array(400);
  return { peaks, rms, low: s.low, mid: s.mid, high: s.high, fps: FPS, bpm: 120, firstBeat: 1, confidence: 3, bpmSource: "analysis", key: null, keyConfidence: 0, energy: 6, energyConfidence: 0.5, gainDb: 0, peak: 1, sections: [], recommendedCues: [], hotCueSuggestions: [] };
}
async function service(cues: TrackPreparation["cues"] = []) {
  const s = structured(), waves = new Map<string, WaveformRecord>(), saved: TrackPreparation[] = [];
  const rec: TrackPreparation = { schemaVersion: 1, trackId: "sha256:t", refs: ["/t.mp3"], fileSize: 1, title: "T", artist: "A", album: "", isrc: null, duration: s.duration, bpm: 120, key: null, keyConfidence: 0, energy: 6, energyConfidence: 0.5,
    sections: [], recommendedCues: [], gain: null, analysisVersion: 1, analysedAt: 1000, updatedAt: 1, beatGrid: { bpm: 120, firstBeat: 1, confidence: 3, offset: 0, beatPositions: [], manuallyAdjusted: false, source: "analysis" }, cuePoint: 0, cues, savedLoops: [], lastLoop: null };
  waves.set(rec.trackId, packWaveform(rec.trackId, analysisFrom(s), 1000));
  const persistence: PreparationPersistence = { list: async () => [structuredClone(rec)], save: async (r) => void saved.push(structuredClone(r)), loadWaveform: async (id) => waves.get(id) ?? null, saveWaveform: async () => undefined };
  const preparation = new PreparationStore(persistence); await preparation.ready;
  const changed: string[] = [];
  const resuggested: string[] = [];
  const svc = new AutoCueService({ preparation, vocals: async () => null, onCuesChanged: (id) => changed.push(id), resuggest: async (id) => { resuggested.push(id); } });
  return { svc, preparation, saved, changed, persistence, resuggested };
}
const hot = (p: PreparationStore) => p.get("sha256:t")!.cues.filter((c) => c.type === "hotcue").sort((a, b) => a.slot - b.slot);

describe("Auto Cue service", () => {
  it("generates from the cached analysis without touching existing hot cues", async () => {
    const { svc, preparation } = await service([{ slot: 0, type: "hotcue", timestamp: 12, name: "Mine", colour: "#fff", source: "manual" }]);
    const set = await svc.generate("/t.mp3");
    expect(set.cues.length).toBeGreaterThanOrEqual(7);
    expect(set.cues.every((c) => c.reviewStatus === "suggested" && c.slot === null)).toBe(true);
    expect(hot(preparation)).toEqual([expect.objectContaining({ slot: 0, name: "Mine", timestamp: 12 })]);
  });

  it("accepts into a free slot, refuses an occupied one unless confirmed, and stages when the bank is full", async () => {
    const full = Array.from({ length: 8 }, (_, slot) => ({ slot, type: "hotcue" as const, timestamp: slot * 10, name: `M${slot}`, colour: "#fff", source: "manual" as const }));
    const a = await service([{ slot: 0, type: "hotcue", timestamp: 12, name: "Mine", colour: "#fff", source: "manual" }]);
    const set = await a.svc.generate("/t.mp3"), drop = set.cues.find((c) => c.cueType === "drop")!;
    expect(a.svc.accept("sha256:t", drop.id)).toEqual({ ok: true, slot: 1 });
    expect(hot(a.preparation)[1]).toMatchObject({ slot: 1, name: "Drop 1", source: "manual", timestamp: drop.quantisedPosition });
    expect(a.changed).toEqual(["sha256:t"]);
    const intro = set.cues.find((c) => c.cueType === "intro")!;
    const r = a.svc.accept("sha256:t", intro.id, 0);
    expect(r).toMatchObject({ ok: false, reason: "occupied", occupied: { slot: 0, manual: true } });
    expect(hot(a.preparation)[0].name).toBe("Mine");
    expect(a.svc.accept("sha256:t", intro.id, 0, { replace: true })).toEqual({ ok: true, slot: 0 });

    const b = await service(full);
    await b.svc.generate("/t.mp3");
    expect(b.svc.acceptAllHigh("sha256:t").accepted).toBe(0);
    expect(hot(b.preparation).map((c) => c.name)).toEqual(full.map((c) => c.name)); // nothing replaced
  });

  it("accept-all can replace the older auto-suggested pads only when asked, never the user's", async () => {
    const pads = Array.from({ length: 8 }, (_, slot) => ({ slot, type: "hotcue" as const, timestamp: slot * 10, name: slot === 7 ? "Mine" : `Auto ${slot}`, colour: "#fff", source: (slot === 7 ? "manual" : "analysis") as "manual" | "analysis" }));
    const { svc, preparation } = await service(pads);
    await svc.generate("/t.mp3");
    expect(svc.acceptAllHigh("sha256:t").accepted).toBe(0);
    expect(svc.autoSuggestedPads("sha256:t")).toHaveLength(7);
    const r = svc.acceptAllHigh("sha256:t", { replaceAutoSuggested: true });
    expect(r.accepted).toBeGreaterThan(0);
    expect(hot(preparation)[7]).toMatchObject({ name: "Mine", timestamp: 70 });
  });

  it("recommends which suggestion goes on which pad, keeping the user's own cues, and applies it in one go (reversibly)", async () => {
    const { svc, preparation } = await service([{ slot: 0, type: "hotcue", timestamp: 12, name: "Mine", colour: "#fff", source: "manual" }]);
    const set = await svc.generate("/t.mp3");
    const by = (t: string) => set.cues.find((c) => c.cueType === t)!;
    // Pads an earlier Accept All left behind, out of order, after the suggestions were regenerated (so not linked).
    preparation.setHotcue("sha256:t", 1, { timestamp: by("drop").quantisedPosition, name: "Drop", colour: "#f00", source: "manual", comment: "Auto Cue: Drop (accepted)" });
    preparation.setHotcue("sha256:t", 2, { timestamp: by("intro").quantisedPosition, name: "Intro", colour: "#0f0", source: "manual", comment: "Auto Cue: Intro (accepted)" });
    // An Auto Cue pad the user has since moved somewhere else is theirs now.
    preparation.setHotcue("sha256:t", 3, { timestamp: 5.37, name: "Moved", colour: "#00f", source: "manual", comment: "Auto Cue: Build (accepted)" });
    const slots = svc.slots("sha256:t");
    expect(slots.map((s) => [s.manual, s.autoCue]).slice(0, 4)).toEqual([[true, false], [false, true], [false, true], [true, false]]);

    const plan = svc.planLayout("sha256:t")!;
    expect(plan.pads[0]).toMatchObject({ action: "keep-yours", name: "Mine" });
    expect(plan.pads[3]).toMatchObject({ action: "keep-yours", name: "Moved" });
    const auto = plan.pads.filter((p) => p.action !== "keep-yours" && p.time !== null && p.action !== "empty");
    expect(auto.map((p) => p.time)).toEqual(auto.map((p) => p.time).sort((a, b) => a! - b!)); // A → H follows the track
    expect(new Set(auto.map((p) => p.time)).size).toBe(auto.length); // one pad per moment
    // Every usable suggestion is accounted for: on a pad (alone or sharing) or listed with a reason.
    const usable = set.cues.filter((c) => c.confidence >= 0.45);
    const covered = new Set([...plan.pads.flatMap((p) => p.cueIds), ...plan.skipped.map((s) => s.id)]);
    expect(usable.every((c) => covered.has(c.id))).toBe(true);
    expect(plan.changes).toBeGreaterThan(0);

    expect(svc.applyLayout("sha256:t").changed).toBe(plan.changes);
    const pads = hot(preparation);
    expect(pads.find((p) => p.slot === 0)).toMatchObject({ name: "Mine", timestamp: 12 });
    expect(pads.find((p) => p.slot === 3)).toMatchObject({ name: "Moved", timestamp: 5.37 });
    const after = pads.filter((p) => p.slot !== 0 && p.slot !== 3).map((p) => p.timestamp);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    expect(svc.planLayout("sha256:t")!.changes).toBe(0); // applying again changes nothing
    expect(svc.applyLayout("sha256:t").changed).toBe(0);

    expect(await svc.restoreOriginalPads("sha256:t")).toBe("restored");
    expect(hot(preparation).map((p) => [p.slot, p.name])).toEqual([[0, "Mine"], [1, "Drop"], [2, "Intro"], [3, "Moved"]]);
  });

  it("treats older analysis pads a fraction of a beat off the grid as the same moment, and snaps kept ones onto the bar", async () => {
    const { svc, preparation } = await service();
    const set = await svc.generate("/t.mp3");
    // The deck's older suggestions count bars from 0:00, so with the first beat at 1 s they all sit early.
    const intro = set.cues.find((c) => c.cueType === "intro")!, drop = set.cues.find((c) => c.cueType === "drop")!;
    preparation.setHotcue("sha256:t", 0, { timestamp: Math.max(0, intro.quantisedPosition - 0.23), name: "Intro 1", colour: "#888", source: "analysis" });
    preparation.setHotcue("sha256:t", 1, { timestamp: drop.quantisedPosition - 0.23, name: "Drop 1", colour: "#888", source: "analysis" });
    // An older pad on a bar nothing else suggests (bar 40 of the 2 s grid, minus the same offset).
    const free = [...Array(60).keys()].map((b) => 1 + 2 * b).find((t) => t > 20 && set.cues.every((c) => Math.abs(c.quantisedPosition - t) > 6))!;
    preparation.setHotcue("sha256:t", 2, { timestamp: free - 0.23, name: "Build 2", colour: "#888", source: "analysis" });
    const plan = svc.planLayout("sha256:t")!;
    const times = plan.pads.filter((p) => p.time !== null && p.action !== "empty").map((p) => p.time!).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(0.5); // never two pads within a beat
    expect(plan.pads.find((p) => p.name === "Build 2")?.time).toBe(free); // kept, and put on the bar line
    expect(plan.pads.some((p) => !p.cueIds.length && (p.name === "Intro 1" || p.name === "Drop 1"))).toBe(false); // merged into Auto Cue's moments
    const before = hot(preparation).map((p) => [p.slot, p.timestamp, p.name]);
    svc.applyLayout("sha256:t");
    expect(hot(preparation).find((p) => p.name === "Build 2")?.timestamp).toBe(free);
    // Restore puts back the older pads Auto Cue moved or snapped too, exactly.
    expect(await svc.restoreOriginalPads("sha256:t")).toBe("restored");
    expect(hot(preparation).map((p) => [p.slot, p.timestamp, p.name])).toEqual(before);
  });

  it("the recommended layout keeps a useful older auto pad the new suggestions didn't find", async () => {
    const { svc, preparation } = await service();
    await svc.generate("/t.mp3");
    preparation.setHotcue("sha256:t", 0, { timestamp: 3.3, name: "Breakdown (analysis)", colour: "#888", source: "analysis" });
    const plan = svc.planLayout("sha256:t")!;
    const old = plan.pads.find((p) => p.cueIds.length === 0 && p.name === "Breakdown (analysis)");
    expect(old?.time).toBe(3); // kept (in time order, snapped onto the bar at 3 s), not silently dropped
  });

  it("accept-all lays pads out in time order, one pad per moment, high-confidence only", async () => {
    const { svc, preparation } = await service();
    await svc.generate("/t.mp3");
    const high = svc.get("sha256:t")!.cues.filter((c) => c.confidence >= 0.7);
    const r = svc.acceptAllHigh("sha256:t");
    expect(r.accepted + r.merged + r.staged).toBe(high.length);
    const pads = hot(preparation);
    const times = pads.map((p) => p.timestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b)); // A, B, C… follow the track
    expect(new Set(times).size).toBe(times.length); // never two pads on the same moment
    expect(svc.get("sha256:t")!.cues.filter((c) => c.slot !== null).every((c) => c.confidence >= 0.7)).toBe(true);
    // Intro, first beat and first phrase all sit on the first downbeat of this track → one pad named for them.
    expect(pads[0].name).toMatch(/\+/);
    expect(r.merged).toBeGreaterThan(0);
  });

  it("asks before putting a second pad on a moment that already has one", async () => {
    const { svc, preparation } = await service();
    const set = await svc.generate("/t.mp3");
    const intro = set.cues.find((c) => c.cueType === "intro")!, beat = set.cues.find((c) => c.cueType === "first-beat")!;
    expect(svc.accept("sha256:t", intro.id).ok).toBe(true);
    expect(svc.accept("sha256:t", beat.id)).toMatchObject({ ok: false, reason: "duplicate", occupied: { slot: 0 } });
    expect(hot(preparation)).toHaveLength(1);
    expect(svc.coveredBy("sha256:t", beat.id)?.slot).toBe(0);
    expect(svc.accept("sha256:t", beat.id, undefined, { allowDuplicate: true }).ok).toBe(true);
  });

  it("replacing analysis pads that sit on the same moments still gives every moment a pad", async () => {
    const probe = await service();
    const moments = [...new Set((await probe.svc.generate("/t.mp3")).cues.filter((c) => c.confidence >= 0.7).map((c) => c.quantisedPosition))].slice(0, 8);
    const pads = moments.map((ts, slot) => ({ slot, type: "hotcue" as const, timestamp: ts, name: `Old ${slot}`, colour: "#fff", source: "analysis" as const }));
    const { svc, preparation } = await service(pads);
    await svc.generate("/t.mp3");
    const r = svc.acceptAllHigh("sha256:t", { replaceAutoSuggested: true });
    expect(r.accepted).toBe(moments.length);
    expect(hot(preparation).map((p) => p.timestamp)).toEqual([...moments].sort((x, y) => x - y));
    expect(hot(preparation).every((p) => !p.name.startsWith("Old"))).toBe(true);
  });

  it("Restore original pads puts back exactly what was there before Auto Cue", async () => {
    const pads = Array.from({ length: 8 }, (_, slot) => ({ slot, type: "hotcue" as const, timestamp: 10 + slot * 20, name: `Auto ${slot}`, colour: "#fff", source: (slot === 7 ? "manual" : "analysis") as "manual" | "analysis" }));
    const { svc, preparation } = await service(pads);
    await svc.generate("/t.mp3");
    svc.acceptAllHigh("sha256:t", { replaceAutoSuggested: true });
    expect(hot(preparation).map((p) => p.name)).not.toEqual(pads.map((p) => p.name));
    expect(hot(preparation)[7].name).toBe("Auto 7"); // the user's own pad was never touched
    expect(svc.canRestorePads("sha256:t")).toBe(true);
    expect(await svc.restoreOriginalPads("sha256:t")).toBe("restored");
    expect(hot(preparation).map((p) => [p.slot, p.timestamp, p.name, p.source])).toEqual(pads.map((p) => [p.slot, p.timestamp, p.name, p.source]));
    expect(svc.get("sha256:t")!.cues.every((c) => c.slot === null)).toBe(true);
    expect(svc.get("sha256:t")!.padBackup).toBeUndefined();
  });

  it("without a backup, restore takes Auto Cue's pads off and re-runs the original suggestions", async () => {
    const { svc, preparation, resuggested } = await service();
    await svc.generate("/t.mp3");
    svc.acceptAllHigh("sha256:t");
    // Simulate pads accepted by an earlier version (no backup kept).
    const s = svc.get("sha256:t")!; const { padBackup: _b, ...noBackup } = s; preparation.updateSetData("sha256:t", { autoCues: noBackup });
    expect(await svc.restoreOriginalPads("sha256:t")).toBe("resuggested");
    expect(hot(preparation)).toEqual([]);
    expect(resuggested).toEqual(["sha256:t"]);
  });

  it("move/rename/type edits persist and follow the cue onto the pads; reject takes it off again", async () => {
    const { svc, preparation, saved } = await service();
    const set = await svc.generate("/t.mp3"), drop = set.cues.find((c) => c.cueType === "drop")!;
    svc.accept("sha256:t", drop.id);
    svc.move("sha256:t", drop.id, 70.123);
    svc.rename("sha256:t", drop.id, "Big drop");
    expect(svc.get("sha256:t")!.cues.find((c) => c.id === drop.id)).toMatchObject({ reviewStatus: "modified", quantisedPosition: 70.12, label: "Big drop" });
    expect(hot(preparation)[0]).toMatchObject({ timestamp: 70.12, name: "Big drop" });
    svc.reject("sha256:t", drop.id);
    expect(hot(preparation)).toEqual([]);
    expect(svc.get("sha256:t")!.cues.find((c) => c.id === drop.id)?.reviewStatus).toBe("rejected");
    await preparation.flush();
    expect(saved[saved.length - 1].autoCues?.cues.find((c) => c.id === drop.id)?.reviewStatus).toBe("rejected");
  });

  it("leaves a pad alone when the user re-placed that hot cue on the deck", async () => {
    const { svc, preparation } = await service();
    const set = await svc.generate("/t.mp3"), drop = set.cues.find((c) => c.cueType === "drop")!;
    svc.accept("sha256:t", drop.id);
    preparation.setHotcue("sha256:t", 0, { timestamp: 99, name: "Moved on deck", colour: "#fff", source: "manual" });
    svc.removeFromPads("sha256:t", drop.id);
    svc.rename("sha256:t", drop.id, "Renamed");
    expect(hot(preparation)[0]).toMatchObject({ timestamp: 99, name: "Moved on deck" });
  });

  it("regeneration keeps decisions; Restore Previous brings back the earlier suggestions", async () => {
    const { svc } = await service();
    const first = await svc.generate("/t.mp3");
    const intro = first.cues.find((c) => c.cueType === "intro")!;
    svc.reject("sha256:t", intro.id);
    svc.requantise("sha256:t", "none");
    await svc.generate("/t.mp3");
    expect(svc.get("sha256:t")!.cues.find((c) => c.cueType === "intro")?.reviewStatus).toBe("rejected");
    expect(svc.restorePrevious("sha256:t")).toBe(true);
    expect(svc.get("sha256:t")!.quantise).toBe("none");
  });

  it("refuses unanalysed tracks", async () => {
    const { svc } = await service();
    await expect(svc.generate("/nope.mp3")).rejects.toThrow(/analysed/);
  });
});

import { describe, expect, it } from "vitest";
import { consistencyScore, describeClash, describeTap, judgeTap, lowBandClash, lowBandEnvelope, nearestBeatErrorMs, scoreLoopCapture, tapScore, TIMING_WINDOWS } from "../src/teachloop/scoring";
import { ACTIVITIES, MILESTONES, type ActivityId } from "../src/teachloop/curriculum";
import { LAYERS, PADS, SOUND_MANIFEST, midiToFrequency } from "../src/teachloop/sounds";
import { WebAudioEngine } from "../src/audio/WebAudioEngine";
import type { Platform } from "../src/platform";
import type { StemService } from "../src/stems/StemService";
import { TeachLoopService, type TeachLoopState } from "../src/teachloop/TeachLoopService";

describe("Teach Me: Live Looping — timing calculations", () => {
  it("scores a tap signed, relative to the nearest beat", () => {
    expect(nearestBeatErrorMs(10.042, 10, 2)).toBeCloseTo(42, 0); // late
    expect(nearestBeatErrorMs(9.958, 10, 2)).toBeCloseTo(-42, 0); // early
    expect(nearestBeatErrorMs(10, 10, 2)).toBeCloseTo(0);
    expect(nearestBeatErrorMs(11.95, 10, 2)).toBeCloseTo(-50, 0); // nearest to the bar at 12, not 10
  });
  it("judges and describes taps using the centrally defined windows", () => {
    expect(judgeTap(10)).toBe("perfect"); expect(judgeTap(TIMING_WINDOWS.perfectMs)).toBe("perfect");
    expect(judgeTap(TIMING_WINDOWS.perfectMs + 1)).toBe("good"); expect(judgeTap(TIMING_WINDOWS.goodMs + 1)).toBe("ok");
    expect(judgeTap(TIMING_WINDOWS.missMs + 1)).toBe("miss");
    expect(describeTap(10)).toBe("Perfect — within the target window.");
    expect(describeTap(-42)).toBe("Early by 42 ms.");
    expect(describeTap(65)).toBe("Late by 65 ms.");
    expect(describeTap(-42, "at the start")).toBe("Early at the start by 42 ms.");
  });
  it("scores taps 0-100, full marks inside the good window and tapering to 0 at the miss threshold", () => {
    expect(tapScore(0)).toBe(100); expect(tapScore(TIMING_WINDOWS.goodMs)).toBe(100);
    expect(tapScore(TIMING_WINDOWS.missMs)).toBe(0); expect(tapScore(9999)).toBe(0);
    const mid = tapScore((TIMING_WINDOWS.goodMs + TIMING_WINDOWS.missMs) / 2); expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(100);
  });
  it("scores consistency across attempts, 100 for identical taps and lower as they spread out", () => {
    expect(consistencyScore([20, 20, 20])).toBe(100);
    expect(consistencyScore([20])).toBe(100);
    const spread = consistencyScore([-80, 80, -80, 80]); expect(spread).toBeLessThan(50);
  });
  it("scores a captured loop's start, end and duration, with plain-language feedback", () => {
    const perfect = scoreLoopCapture({ startErrorMs: 5, endErrorMs: -5, actualBars: 4, targetBars: 4 });
    expect(perfect.total).toBe(100); expect(perfect.feedback.some((f) => f.includes("right on"))).toBe(true);
    const long = scoreLoopCapture({ startErrorMs: 0, endErrorMs: 0, actualBars: 4.08, targetBars: 4 });
    expect(long.durationScore).toBeLessThan(100); expect(long.feedback.some((f) => f.includes("4.08 bars instead of 4.00"))).toBe(true);
    expect(long.feedback.some((f) => f.includes("slightly earlier"))).toBe(true);
  });
});

describe("Teach Me: Live Looping — curriculum and sound manifest", () => {
  it("every prerequisite points at a real activity, and Module 1 has none", () => {
    const ids = new Set(ACTIVITIES.map((a) => a.id));
    for (const a of ACTIVITIES) for (const p of a.prerequisites ?? []) expect(ids.has(p)).toBe(true);
    expect(ACTIVITIES.find((a) => a.id === "perfect-loop")?.prerequisites ?? []).toHaveLength(0);
  });
  it("modules 3-5 are planned, Modules 1-2 and their companion activities are not", () => {
    const built: ActivityId[] = ["perfect-loop", "fix-my-timing", "sandbox-1", "layering"];
    for (const id of built) expect(ACTIVITIES.find((a) => a.id === id)?.planned).toBeFalsy();
    for (const a of ACTIVITIES) if (!built.includes(a.id)) expect(a.planned).toBe(true);
  });
  it("Module 2 requires Module 1", () => { expect(ACTIVITIES.find((a) => a.id === "layering")?.prerequisites).toEqual(["perfect-loop"]); });
  it("every milestone id used by the service has a label", () => {
    expect(Object.keys(MILESTONES)).toEqual(["foundDownbeat", "firstLoop", "fixedBoundary", "firstLayer", "balancedLowEnd"]);
  });
  it("pads have unique keyboard shortcuts and positive durations", () => {
    const keys = PADS.map((p) => p.key); expect(new Set(keys).size).toBe(keys.length);
    for (const p of PADS) expect(p.durationS).toBeGreaterThan(0);
  });
  it("every sound is documented in the manifest with a generated, license-free source", () => {
    for (const s of SOUND_MANIFEST) { expect(s.source).toBe("generated"); expect(s.license.length).toBeGreaterThan(0); }
    expect(SOUND_MANIFEST.map((s) => s.id)).toEqual(expect.arrayContaining(PADS.map((p) => p.id)));
  });
  it("converts MIDI note numbers to frequency correctly (A4 = 440 Hz)", () => {
    expect(midiToFrequency(69)).toBeCloseTo(440); expect(midiToFrequency(81)).toBeCloseTo(880);
  });
  it("Module 2's four layers are distinct roles, drums first, bass deliberately tagged as the sub/low clash case", () => {
    expect(LAYERS.map((l) => l.role)).toEqual(["drums", "bass", "melody", "vocalPerc"]);
    expect(LAYERS.find((l) => l.role === "bass")?.frequencyProfile).toBe("sub");
    expect(new Set(LAYERS.map((l) => l.frequencyProfile)).size).toBeGreaterThan(1); // not every layer tagged the same, or "clash" would be meaningless
  });
});

describe("Module 2 — low-band energy maths (lowBandEnvelope / lowBandClash)", () => {
  it("lowBandEnvelope returns one value per window, tracking silence correctly regardless of frequency content", () => {
    const rate = 48_000; const n = rate; const data = new Float32Array(n);
    for (let i = 0; i < n / 2; i++) data[i] = Math.sin(2 * Math.PI * 80 * i / rate); // loud for the first half, silent for the second
    const env = lowBandEnvelope(data, rate, 8);
    expect(env).toHaveLength(8);
    expect(env.slice(0, 4).every((v) => v > .5)).toBe(true);
    expect(env.slice(4).every((v) => v < .05)).toBe(true);
  });
  it("a steady tone (any frequency) produces a roughly flat envelope, not spurious windowing artefacts", () => {
    const rate = 48_000; const n = rate; const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.sin(2 * Math.PI * 3000 * i / rate) * .8;
    const env = lowBandEnvelope(data, rate, 8);
    const spread = Math.max(...env) - Math.min(...env.slice(1)); // window 0 includes the filter's brief settling transient
    expect(spread).toBeLessThan(.3);
  });
  it("lowBandClash is 1 when two layers are loud at exactly the same instants, 0 when they never overlap", () => {
    expect(lowBandClash([1, 1, 1, 1], [1, 1, 1, 1])).toBeCloseTo(1);
    expect(lowBandClash([1, 1, 0, 0], [0, 0, 1, 1])).toBeCloseTo(0);
    expect(lowBandClash([], [1])).toBe(0);
  });
  it("two quiet layers don't register as clashing just because they're similarly quiet", () => {
    expect(lowBandClash([.05, .05, .05], [.06, .06, .06])).toBe(0);
  });
  it("describeClash always includes the percentage, never colour alone", () => {
    expect(describeClash(.8)).toMatch(/80%.*fighting/);
    expect(describeClash(.4)).toMatch(/40%.*noticeable/);
    expect(describeClash(.1)).toMatch(/10%.*room/);
  });
});

/** A fresh service with in-memory storage and no real audio — exercises every method that doesn't need a live AudioContext. */
function makeService() {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const audio = new WebAudioEngine();
  const svc = new TeachLoopService(audio, {} as Platform, {} as StemService, storage);
  return svc;
}

describe("Teach Me: Live Looping — lesson-state transitions", () => {
  it("starts at the overview and selecting an activity moves to its ready phase", async () => {
    const svc = makeService();
    expect(svc.getState().activity).toBeNull(); expect(svc.getState().phase).toBe("ready");
    await svc.selectActivity("perfect-loop");
    expect(svc.getState().activity).toBe("perfect-loop"); expect(svc.getState().phase).toBe("ready"); expect(svc.getState().drill).toBeNull();
  });
  it("refuses to open a planned (locked) activity", async () => {
    const svc = makeService(); await svc.selectActivity("dead-space-mic");
    expect(svc.getState().activity).toBeNull();
  });
  it("openOverview resets activity, drill and phase", async () => {
    const svc = makeService(); await svc.selectActivity("perfect-loop"); svc.openOverview();
    expect(svc.getState().activity).toBeNull(); expect(svc.getState().drill).toBeNull(); expect(svc.getState().phase).toBe("ready");
  });
  it("retry resets the attempt but keeps the current activity and drill selection", async () => {
    const svc = makeService(); await svc.selectActivity("perfect-loop");
    svc.retry();
    expect(svc.getState().activity).toBe("perfect-loop"); expect(svc.getState().phase).toBe("ready"); expect(svc.getState().taps).toEqual([]);
  });
});

describe("Teach Me: Live Looping — mode separation", () => {
  it("Strict enables Threshold Recording and turns quantize off; Sandbox is the reverse", async () => {
    const svc = makeService(); await svc.selectActivity("perfect-loop");
    svc.setMode("strict");
    expect(svc.looper.session().thresholdRecord).toBe(true); expect(svc.looper.session().quantize).toBe("off");
    svc.setMode("sandbox");
    expect(svc.looper.session().thresholdRecord).toBe(false); expect(svc.looper.session().quantize).toBe("1-bar");
  });
  it("defaults to sandbox mode", () => { expect(makeService().getState().mode).toBe("sandbox"); });
});

describe("Teach Me: Live Looping — Sandbox Level 1 milestone (regression: infinite render loop)", () => {
  it("maybeAwardFirstLayer is idempotent — repeated calls after the milestone is earned never touch state again", async () => {
    const svc = makeService(); await svc.selectActivity("sandbox-1");
    const learnerId = svc.getState().learnerTrackId!;
    // Simulate the learner having recorded a loop, without touching real audio.
    svc.production.updateLooper((s) => { const t = s.tracks.find((x) => x.id === learnerId); if (t) t.loop = { layers: [{ ref: "production-loop://fake", peaks: [], recordedAt: 1 }], active: 1, bars: 1, anchorBar: 0, bpm: 90, beatsPerBar: 4, sampleRate: 48_000, duration: 2, latencyMs: 0, recordedAt: 1, trimIn: 0 }; }, "test seed", false);
    svc.maybeAwardFirstLayer();
    expect(svc.getState().milestonesEarned).toContain("firstLayer");
    expect(svc.getState().progress["sandbox-1"]?.attempts).toBe(1);
    const stateAfterFirst = svc.getState();
    // Calling it again and again (as a React effect with no dependency array used to do, every render) must not re-fire.
    svc.maybeAwardFirstLayer(); svc.maybeAwardFirstLayer(); svc.maybeAwardFirstLayer();
    expect(svc.getState()).toBe(stateAfterFirst); // same object reference: no further set() calls happened
    expect(svc.getState().progress["sandbox-1"]?.attempts).toBe(1);
  });
  it("does nothing while the learner track has no loop yet", async () => {
    const svc = makeService(); await svc.selectActivity("sandbox-1");
    svc.maybeAwardFirstLayer();
    expect(svc.getState().milestonesEarned).not.toContain("firstLayer");
  });
});

describe("Teach Me: Live Looping — protected ghost tracks", () => {
  it("the backing track is marked protected once a lesson session is set up", async () => {
    const svc = makeService(); await svc.selectActivity("sandbox-1");
    const ghost = svc.looper.session().tracks.find((t) => t.id === svc.getState().ghostTrackId);
    expect(ghost?.protected).toBe(true);
  });
  it("REC, CLEAR and remove all refuse a protected track, but mute/volume still work", async () => {
    const svc = makeService(); await svc.selectActivity("sandbox-1");
    const ghostId = svc.getState().ghostTrackId!;
    await svc.looper.record(ghostId);
    expect(svc.looper.getState().recording).toBeNull(); // refused — never started
    expect(svc.looper.getState().message).toMatch(/protected/i);
    svc.looper.clear(ghostId); // a no-op on a protected track; should not throw
    svc.looper.setTrack(ghostId, { muted: true }, false);
    expect(svc.looper.session().tracks.find((t) => t.id === ghostId)?.muted).toBe(true);
  });
});

describe("Teach Me: Live Looping — progress persistence", () => {
  it("persists milestones and progress across service instances via the injected storage", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const audio = new WebAudioEngine();
    const svc1 = new TeachLoopService(audio, {} as Platform, {} as StemService, storage);
    await svc1.selectActivity("fix-my-timing");
    (svc1 as unknown as { recordResult: (id: ActivityId, score: number, milestones: ("fixedBoundary")[]) => void }).recordResult("fix-my-timing", 100, ["fixedBoundary"]);
    expect(svc1.getState().milestonesEarned).toContain("fixedBoundary");
    const svc2 = new TeachLoopService(new WebAudioEngine(), {} as Platform, {} as StemService, storage);
    expect(svc2.getState().milestonesEarned).toContain("fixedBoundary");
    expect(svc2.getState().progress["fix-my-timing"]?.completed).toBe(true);
  });
  it("resetProgress clears milestones and progress", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const svc = new TeachLoopService(new WebAudioEngine(), {} as Platform, {} as StemService, storage);
    (svc as unknown as { recordResult: (id: ActivityId, score: number, milestones: ("foundDownbeat")[]) => void }).recordResult("perfect-loop", 90, ["foundDownbeat"]);
    svc.resetProgress();
    expect(svc.getState().milestonesEarned).toEqual([]); expect(svc.getState().progress).toEqual({});
    expect(JSON.parse(store.get("dbdj.teachloop.v1")!)).toEqual({ progress: {}, milestones: [] });
  });
  it("tolerates corrupt stored progress and starts fresh", () => {
    const storage = { getItem: () => "{not json", setItem: () => undefined };
    const svc = new TeachLoopService(new WebAudioEngine(), {} as Platform, {} as StemService, storage);
    expect(svc.getState().progress).toEqual({}); expect(svc.getState().milestonesEarned).toEqual([]);
  });
});

describe("Teach Me: Live Looping — Module 2 lesson state (audio-free parts; beginLayering() itself needs a real AudioContext and is excluded, same as every other audio-touching method in this suite)", () => {
  it("selecting Module 2 sets up four tracks, drums protected, the rest not", async () => {
    const svc = makeService(); await svc.selectActivity("layering");
    expect(svc.getState().activity).toBe("layering");
    const ids = svc.getState().layerTrackIds;
    expect(Object.keys(ids).sort()).toEqual(["bass", "drums", "melody", "vocalPerc"].sort());
    const tracks = svc.looper.session().tracks;
    expect(tracks.find((t) => t.id === ids.drums)?.protected).toBe(true);
    expect(tracks.find((t) => t.id === ids.bass)?.protected).toBeFalsy();
  });
  /** Seeds fake loops + envelopes directly, bypassing beginLayering()'s real-audio synthesis, to exercise addNextLayer/clashReport/corrections/milestone purely on state. */
  async function seedLayers(svc: TeachLoopService, envelopes: Record<"drums" | "bass" | "melody" | "vocalPerc", number[]>) {
    await svc.selectActivity("layering"); const ids = svc.getState().layerTrackIds;
    svc.production.updateLooper((s) => { for (const role of ["drums", "bass", "melody", "vocalPerc"] as const) { const t = s.tracks.find((x) => x.id === ids[role]); if (t) { t.loop = { layers: [{ ref: `production-loop://${role}`, peaks: [], recordedAt: 1 }], active: 1, bars: 1, anchorBar: 0, bpm: 90, beatsPerBar: 4, sampleRate: 48_000, duration: 2, latencyMs: 0, recordedAt: 1, trimIn: 0 }; t.muted = role !== "drums"; } } }, "test seed", false);
    (svc as unknown as { set: (p: Partial<TeachLoopState>) => void }).set({ layerEnvelopes: envelopes });
    return ids;
  }
  it("addNextLayer unmutes in order (bass, melody, vocalPerc) and nothing more", async () => {
    const svc = makeService(); const ids = await seedLayers(svc, { drums: [1], bass: [1], melody: [1], vocalPerc: [1] });
    expect(svc.getState().layerStep).toBe(0);
    svc.addNextLayer();
    expect(svc.getState().layerStep).toBe(1); expect(svc.looper.session().tracks.find((t) => t.id === ids.bass)?.muted).toBe(false);
    expect(svc.looper.session().tracks.find((t) => t.id === ids.melody)?.muted).toBe(true); // not added yet
  });
  it("clashReport only compares layers that have actually been added, worst first", async () => {
    const svc = makeService(); await seedLayers(svc, { drums: [1, 1], bass: [1, 1], melody: [0, 0], vocalPerc: [0, 0] });
    svc.addNextLayer(); // bass only
    expect(svc.clashReport()).toHaveLength(1);
    expect(svc.clashReport()[0]).toMatchObject({ a: "drums", b: "bass" }); expect(svc.clashReport()[0].clash).toBeCloseTo(1);
    svc.addNextLayer(); svc.addNextLayer(); // melody, vocalPerc — now 6 pairs among 4 layers
    expect(svc.clashReport()).toHaveLength(6);
    expect(svc.clashReport()[0].clash).toBeGreaterThanOrEqual(svc.clashReport()[1].clash); // sorted worst-first
  });
  it("maybeAwardBalance only fires once all four layers are in AND a correction (low cut or mute) has been applied", async () => {
    const svc = makeService(); await seedLayers(svc, { drums: [1], bass: [1], melody: [1], vocalPerc: [1] });
    svc.addNextLayer(); svc.maybeAwardBalance();
    expect(svc.getState().milestonesEarned).not.toContain("balancedLowEnd"); // not all layers in yet
    svc.addNextLayer(); svc.addNextLayer(); svc.maybeAwardBalance();
    expect(svc.getState().milestonesEarned).not.toContain("balancedLowEnd"); // all in, but no correction applied
    const bassId = svc.getState().layerTrackIds.bass!; svc.layerLowCut("bass", 150);
    expect(svc.looper.session().tracks.find((t) => t.id === bassId)?.lowCutHz).toBe(150);
    svc.maybeAwardBalance();
    expect(svc.getState().milestonesEarned).toContain("balancedLowEnd");
  });
  it("maybeAwardBalance is idempotent, matching the Sandbox regression fix", async () => {
    const svc = makeService(); await seedLayers(svc, { drums: [1], bass: [1], melody: [1], vocalPerc: [1] });
    svc.addNextLayer(); svc.addNextLayer(); svc.addNextLayer(); svc.layerMute("bass"); svc.maybeAwardBalance();
    const after = svc.getState(); svc.maybeAwardBalance(); svc.maybeAwardBalance();
    expect(svc.getState()).toBe(after);
  });
});

import { describe, expect, it } from "vitest";
import { analyseTake, blockPeaks, measureClickLatency, placeTake } from "../src/production/vocal/analysis";
import { isRecordingRef } from "../src/production/recordings";
import { blankProject, migrateProject, type VocalTake } from "../src/production/types";
import { encodeWav } from "../src/production/wav";

const RATE = 48_000;

describe("take placement (latency compensation, pre-roll, punch)", () => {
  // Transport: arrangement position 4 s sounded at context time 10 s.
  const clock = { contextTime: 10, position: 4 };
  it("places sample 0 at clock position + capture lead − latency and keeps the pre-roll in the file", () => {
    // Capture began 2 s (one bar of count-in) before the transport reached the record point.
    const placed = placeTake({ captureStart: 8, clock, latency: .025, sampleRate: RATE, frames: RATE * 6, from: 4, to: null })!;
    expect(placed.start).toBeCloseTo(4); // recording starts at the record point
    expect(placed.offset).toBeCloseTo(2.025); // 2 s pre-roll + 25 ms latency stay in the file, skipped by the clip
    expect(placed.duration).toBeCloseTo(6 - 2.025);
    expect(placed.sourceDuration).toBe(6);
  });
  it("keeps only the punch range", () => {
    const placed = placeTake({ captureStart: 8, clock, latency: 0, sampleRate: RATE, frames: RATE * 10, from: 6, to: 7.5 })!;
    expect(placed.start).toBeCloseTo(6); expect(placed.duration).toBeCloseTo(1.5); expect(placed.offset).toBeCloseTo(4);
  });
  it("never places audio before the project start and rejects captures that end before the record point", () => {
    const early = placeTake({ captureStart: 0, clock: { contextTime: 3, position: 0 }, latency: 0, sampleRate: RATE, frames: RATE * 5, from: 0, to: null })!;
    expect(early.start).toBe(0); expect(early.offset).toBeCloseTo(3);
    expect(placeTake({ captureStart: 8, clock, latency: 0, sampleRate: RATE, frames: RATE, from: 4, to: null })).toBeNull();
  });
});

describe("take analysis", () => {
  it("reports peak, RMS, clipping, noise floor and how much of the take is voice", () => {
    const data = new Float32Array(RATE * 2); let x = 3;
    for (let i = 0; i < data.length; i++) { x = (x * 16_807) % 2_147_483_647; data[i] = (x / 2_147_483_647 - .5) * .002; } // ~-60 dB room noise
    for (let i = RATE / 2; i < RATE * 1.5; i++) data[i] += .5 * Math.sin(2 * Math.PI * 220 * i / RATE); // 1 s of "voice"
    data[RATE] = 1;
    const a = analyseTake(data, RATE);
    expect(a.peakDb).toBeCloseTo(0, 0); expect(a.clippedSamples).toBe(1);
    expect(a.noiseFloorDb).toBeLessThan(-55); expect(a.activeRatio).toBeGreaterThan(.45); expect(a.activeRatio).toBeLessThan(.55);
  });
  it("makes waveform peaks", () => { expect(blockPeaks(Float32Array.from([0, -.5, .25, .1]), 2)).toEqual([.5, .25]); });
});

describe("latency measurement from test clicks", () => {
  const capture = (delayMs: number, heard: number[]) => { const data = new Float32Array(RATE * 3); let x = 7; for (let i = 0; i < data.length; i++) { x = (x * 16_807) % 2_147_483_647; data[i] = (x / 2_147_483_647 - .5) * .004; } heard.forEach((t) => { const at = Math.round((t + delayMs / 1000) * RATE); for (let i = 0; i < 200; i++) data[at + i] += Math.sin(i / 3) * .6 * (1 - i / 200); }); return data; };
  const clicks = [.4, .8, 1.2, 1.6, 2.0, 2.4];
  it("finds the round-trip delay", () => {
    const r = measureClickLatency(capture(23.5, clicks), RATE, 0, clicks)!;
    expect(r.matched).toBe(6); expect(r.latencyMs).toBeGreaterThan(23); expect(r.latencyMs).toBeLessThan(24.5);
  });
  it("accounts for when the capture started", () => {
    const r = measureClickLatency(capture(40, clicks.map((c) => c - .1)), RATE, .1, clicks)!;
    expect(r.latencyMs).toBeCloseTo(40, 0);
  });
  it("returns null when the clicks are not heard (headphones, no loopback)", () => { expect(measureClickLatency(capture(0, []), RATE, 0, clicks)).toBeNull(); });
  it("rejects other sounds that happen to follow the clicks (singing during the test)", () => {
    const data = capture(0, []); [.05, .21, .33, .12, .44, .27].forEach((delay, i) => { const at = Math.round((clicks[i] + delay) * RATE); for (let k = 0; k < 400; k++) data[at + k] += Math.sin(k / 20) * .5; });
    expect(measureClickLatency(data, RATE, 0, clicks)).toBeNull();
  });
  it("ignores one stray sound among consistent clicks", () => {
    const data = capture(31, clicks.slice(1)); const at = Math.round((clicks[0] + .2) * RATE); for (let k = 0; k < 300; k++) data[at + k] += .5 * Math.sin(k / 4);
    const r = measureClickLatency(data, RATE, 0, clicks)!; expect(r.matched).toBe(5); expect(r.latencyMs).toBeCloseTo(31, 0);
  });
});

describe("vocal take storage", () => {
  it("writes mono WAV for takes", () => {
    const wav = encodeWav({ sampleRate: RATE, left: new Float32Array([0, .5, -.5]) }); const view = new DataView(wav);
    expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(28, true)).toBe(RATE * 2); expect(view.getUint32(40, true)).toBe(6);
  });
  it("treats vocal takes as recordings kept in IndexedDB", () => { expect(isRecordingRef("production-vocal://take_1")).toBe(true); expect(isRecordingRef("C:/music/a.wav")).toBe(false); });
  it("saves and reopens vocal tracks with every take and the active one", () => {
    const project = blankProject("Vocals"); const take = (n: number): VocalTake => ({ id: `t${n}`, ref: `production-vocal://t${n}`, name: `Take ${n}`, recordedAt: n, start: 4, duration: 8, offset: 2.03, sourceDuration: 10.1, sampleRate: RATE, latencyMs: 30, input: "Mic", punch: n === 2 ? { in: 5, out: 6 } : null, analysis: { peakDb: -6, rmsDb: -20, clippedSamples: 0, noiseFloorDb: -62, activeRatio: .7 } });
    project.tracks.push({ id: "v", name: "Vocal 1", kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "Microphone", output: "master", vocal: { takes: [take(1), take(2)], activeTakeId: "t2" }, clips: [{ type: "audio", id: "c", name: "Take 2", ref: "production-vocal://t2", takeId: "t2", start: 5, offset: 3.03, duration: 1, sourceDuration: 10.1, gain: 1, muted: false, peaks: [] }] });
    expect(migrateProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
  });
});

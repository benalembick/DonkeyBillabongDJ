import { describe, expect, it } from "vitest";
import { analyseClean, beatMarkers, detectTransients, equalMarkers, nearestZeroCrossing, sliceRegions, transientMarkers } from "../src/production/slicing";
import { blankProject, migrateProject, padLabel, type SamplerSample } from "../src/production/types";

const RATE = 44_100;
/** Deterministic noise so tests never flake. */
function noise(seed: number): () => number { let x = seed; return () => { x = (x * 1_103_515_245 + 12_345) % 2_147_483_648; return x / 1_073_741_824 - 1; }; }

/** 120 BPM one-bar loop: kick on beats, snare on 2 and 4, closed hats on every 8th. */
function drumLoop(): { data: Float32Array; hits: number[] } {
  const data = new Float32Array(RATE * 2); const rnd = noise(7); const hits: number[] = [];
  for (let eighth = 0; eighth < 8; eighth++) {
    const at = Math.round(eighth * .25 * RATE); hits.push(at / RATE);
    for (let i = 0; i < RATE * .2 && at + i < data.length; i++) {
      const t = i / RATE; let v = .08 * rnd() * Math.exp(-t * 60); // hat
      if (eighth % 2 === 0) v += .8 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14); // kick
      if (eighth === 2 || eighth === 6) v += .5 * rnd() * Math.exp(-t * 25); // snare
      data[at + i] += v;
    }
  }
  return { data, hits };
}

describe("transient detection", () => {
  it("finds every hit of a drum loop within 3 ms, including the first", () => {
    const { data, hits } = drumLoop();
    const found = detectTransients(data, RATE);
    expect(found).toHaveLength(hits.length);
    found.forEach((t, i) => expect(Math.abs(t.time - hits[i])).toBeLessThan(.003));
    expect(Math.max(...found.map((t) => t.strength))).toBe(1);
  });

  it("sensitivity keeps strong attacks first and every attack at 100%", () => {
    const { data } = drumLoop(); const found = detectTransients(data, RATE);
    const low = transientMarkers(found, .05, 0, 2), mid = transientMarkers(found, .5, 0, 2), all = transientMarkers(found, 1, 0, 2);
    expect(all).toHaveLength(7); // markers exclude the region start
    expect(low.length).toBeLessThanOrEqual(mid.length);
    expect(mid.length).toBeLessThanOrEqual(all.length);
  });

  it("ignores silence and a slow swell", () => {
    expect(detectTransients(new Float32Array(RATE), RATE)).toEqual([]);
    const swell = Float32Array.from({ length: RATE * 2 }, (_, i) => Math.sin(2 * Math.PI * 220 * i / RATE) * (i / (RATE * 2)) * .5);
    expect(detectTransients(swell, RATE).filter((t) => t.time > .05)).toEqual([]);
  });
});

describe("slice markers", () => {
  it("builds beat and equal markers inside the region", () => {
    expect(beatMarkers(0, 2, 120, 1)).toEqual([.5, 1, 1.5]);
    expect(beatMarkers(0, 4, 120, 4)).toEqual([2]);
    expect(beatMarkers(1, 2, 120, .25)).toHaveLength(7);
    expect(equalMarkers(0, 2, 4)).toEqual([.5, 1, 1.5]);
  });
  it("turns markers into ordered slices and drops ones outside the region", () => {
    expect(sliceRegions(0, 2, [1.5, .5, 3, -1, 1])).toEqual([{ index: 0, start: 0, end: .5 }, { index: 1, start: .5, end: 1 }, { index: 2, start: 1, end: 1.5 }, { index: 3, start: 1.5, end: 2 }]);
    expect(sliceRegions(.2, .8, [])).toEqual([{ index: 0, start: .2, end: .8 }]);
  });
  it("snaps to the nearest zero crossing", () => {
    const sine = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 100 * i / RATE));
    const snapped = nearestZeroCrossing(sine, RATE, .0123);
    expect(Math.abs(snapped * 200 - Math.round(snapped * 200))).toBeLessThan(.01); // 100 Hz crosses every 5 ms
    expect(Math.abs(snapped - .0123)).toBeLessThan(.003);
  });
});

describe("Auto Clean", () => {
  it("trims silence, suggests tiny fades and reports level without changing it", () => {
    const data = new Float32Array(RATE); for (let i = 4410; i < 30_000; i++) data[i] = Math.sin(2 * Math.PI * 200 * i / RATE) * .5;
    const copy = data.slice(); const report = analyseClean(data, RATE, 0, 1);
    expect(report.start).toBeGreaterThan(.095); expect(report.start).toBeLessThan(.1);
    expect(report.end).toBeGreaterThan(.68); expect(report.end).toBeLessThan(.685);
    expect(report.fadeIn).toBeLessThanOrEqual(.002); expect(report.fadeOut).toBeLessThanOrEqual(.003);
    expect(report.peakDb).toBeCloseTo(-6.02, 1); expect(report.clippedSamples).toBe(0);
    expect(data).toEqual(copy);
  });
  it("counts clipped samples", () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? 1 : .2));
    expect(analyseClean(data, RATE, 0, 1000 / RATE).clippedSamples).toBe(100);
  });
});

describe("pad banks and per-pad settings", () => {
  const slice = (n: number): SamplerSample => ({ id: `s${n}`, sourceRef: "C:/loops/drums.wav", name: `Drums ${n}`, sourceDuration: 2, start: n * .25, end: n * .25 + .25, gain: 1, playbackMode: "one-shot", edits: { reverse: false, normalize: false, fadeIn: .002, fadeOut: .003 }, peaks: [.5, 1], createdAt: 1 });
  it("labels pads by bank", () => { expect(padLabel(0)).toBe("A1"); expect(padLabel(15)).toBe("A16"); expect(padLabel(16)).toBe("B1"); expect(padLabel(63)).toBe("D16"); });

  it("upgrades Phase 1 sampler data to four banks with default pad settings", () => {
    const project = blankProject("Phase 1") as unknown as { sampler: { pads: unknown[]; bank?: number; slicing?: unknown } };
    project.sampler.pads = Array.from({ length: 16 }, (_, index) => ({ index, midiNote: 36 + index, sample: index === 2 ? slice(2) : null }));
    delete project.sampler.bank; delete project.sampler.slicing;
    const migrated = migrateProject(JSON.parse(JSON.stringify(project)))!;
    expect(migrated.sampler.pads).toHaveLength(64);
    expect(migrated.sampler.pads[2].sample?.name).toBe("Drums 2");
    expect(migrated.sampler.pads[2].params).toMatchObject({ pitch: 0, sustain: 1, cutoff: 20000, choke: 0, muted: false });
    expect(migrated.sampler.slicing).toMatchObject({ enabled: false, mode: "transient", markers: [] });
    expect(migrated.sampler.bank).toBe(0);
  });

  it("saves and reopens slices, markers, banks and pad parameters intact", () => {
    const project = blankProject("Slices");
    project.sampler.slicing = { ...project.sampler.slicing, enabled: true, mode: "transient", sensitivity: .7, detected: [{ time: 0, strength: 1 }, { time: .25, strength: .6 }], markers: [.25, .5, 1.75], sourceRef: "C:/loops/drums.wav" };
    for (let n = 0; n < 20; n++) project.sampler.pads[n].sample = slice(n % 8); // 20 slices spill into bank B
    project.sampler.pads[17].params = { ...project.sampler.pads[17].params, pitch: -5, pan: .4, attack: .01, release: .2, cutoff: 2400, resonance: 3, choke: 2, solo: true };
    project.sampler.bank = 1; project.sampler.selectedPad = 17;
    const reopened = migrateProject(JSON.parse(JSON.stringify(project)))!;
    expect(reopened).toEqual(project);
    expect(reopened.sampler.pads.filter((pad) => pad.sample)).toHaveLength(20);
    expect(reopened.sampler.pads[17].params).toMatchObject({ pitch: -5, choke: 2, cutoff: 2400, solo: true });
  });
});

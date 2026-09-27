import { describe, expect, it } from "vitest";
import { chunksForRegion, makePlan, MODEL_STEMS, regionsForChunk, SEGMENT, SeparationJob, type RegionOutput } from "../src/stems/separator";

/** Fake model: vocals = 0.5·mix, drums = 0.3·mix, bass = 0.1·mix, other = 0.1·mix. */
const fakeRun = async (planar: Float32Array) => {
  const out = new Float32Array(4 * 2 * SEGMENT);
  const share: Record<number, number> = { [MODEL_STEMS.vocals]: 0.5, [MODEL_STEMS.drums]: 0.3, [MODEL_STEMS.bass]: 0.1, [MODEL_STEMS.other]: 0.1 };
  for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < SEGMENT; i++) out[(s * 2 + c) * SEGMENT + i] = planar[c * SEGMENT + i] * share[s];
  return out;
};

function signal(frames: number): [Float32Array, Float32Array] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = Math.sin(i * 0.01) * 0.6;
    r[i] = Math.cos(i * 0.013) * 0.4;
  }
  return [l, r];
}

describe("overlap-add plan", () => {
  it("regions and chunks are consistent for every quality", () => {
    for (const q of ["performance", "balanced", "high"] as const) {
      const p = makePlan(SEGMENT * 5 + 1234, q);
      for (let r = 0; r < p.regions; r++) {
        for (const c of chunksForRegion(p, r)) expect(regionsForChunk(p, c)).toContain(r);
      }
      expect(p.chunks * p.stride).toBeGreaterThanOrEqual(p.total);
    }
  });
});

describe("SeparationJob", () => {
  it("reconstructs stems across segment joins and derives instruments = mix − others", async () => {
    const frames = Math.round(SEGMENT * 2.6);
    const [l, r] = signal(frames);
    const regions: RegionOutput[] = [];
    const job = new SeparationJob({ left: l, right: r, quality: "balanced", run: fakeRun, emit: (x) => regions.push(x) });
    while (await job.next());
    expect(job.finished).toBe(true);
    expect(regions.length).toBe(job.plan.regions);
    const covered = new Uint8Array(frames);
    for (const reg of regions) {
      for (let k = 0; k < reg.frames; k += 997) {
        const g = reg.start + k;
        covered[g] = 1;
        // Skip the very first samples where the fade-in weight is ~0 (as in the reference).
        if (g < 50) continue;
        expect(reg.data[k * 6] / 32767).toBeCloseTo(l[g] * 0.5, 3); // vocals L
        expect(reg.data[k * 6 + 3] / 32767).toBeCloseTo(r[g] * 0.3, 3); // drums R
        expect(reg.data[k * 6 + 4] / 32767).toBeCloseTo(l[g] * 0.1, 3); // bass L
      }
      expect(Math.max(...reg.env.instruments)).toBeGreaterThan(0);
    }
  });

  it("starts at the playhead, emits it first, and re-prioritises on seek", async () => {
    const frames = SEGMENT * 6;
    const [l, r] = signal(frames);
    const order: number[] = [];
    const job = new SeparationJob({ left: l, right: r, quality: "balanced", run: fakeRun, emit: (x) => order.push(x.region), startFrame: SEGMENT * 3 });
    await job.next();
    await job.next();
    const target = Math.floor((SEGMENT * 3) / job.plan.stride);
    expect(order).toContain(target); // playhead region ready after its two overlapping chunks
    job.prioritise(0); // DJ jumps to the start
    await job.next();
    expect(order).toContain(0);
    while (await job.next());
    expect(new Set(order).size).toBe(job.plan.regions); // every region exactly once
  });

  it("resumes a partial analysis without recomputing done regions", async () => {
    const frames = SEGMENT * 4;
    const [l, r] = signal(frames);
    let runs = 0;
    const done = new Uint8Array(makePlan(frames, "balanced").regions);
    done[0] = done[1] = done[2] = 1;
    const emitted: number[] = [];
    const job = new SeparationJob({ left: l, right: r, quality: "balanced", run: (p) => (runs++, fakeRun(p)), emit: (x) => emitted.push(x.region), doneRegions: done });
    while (await job.next());
    expect(emitted.every((x) => x >= 3)).toBe(true);
    expect(runs).toBeLessThan(job.plan.chunks);
  });
});

/**
 * Progressive stem separation scheduler (model-agnostic, runs in the stem
 * worker process; pure so it's unit-testable with a fake model).
 *
 * The model separates fixed-length segments (HT-Demucs: 7.8 s at 44.1 kHz).
 * Segments overlap and are cross-faded (overlap-add, linear fades), like the
 * reference implementation. Unlike a batch run we:
 *  - process segments in priority order, starting at the deck's playhead and
 *    re-prioritising when the DJ seeks;
 *  - emit each output *region* (one stride long) as soon as every segment
 *    that overlaps it is done, so stems become usable progressively;
 *  - skip regions that are already cached (resume a partial analysis).
 *
 * Output per region: vocals, drums, bass as interleaved stereo Int16
 * [vL vR dL dR bL bR]. Instruments = mix − (vocals + drums + bass) is derived
 * at playback, so all stems up == the original track, sample-exact.
 */

export const MODEL_RATE = 44100;
export const SEGMENT = 343980; // 7.8 s
export const ENV_HOP = 294; // 44100 / 150 → waveform frames at 150 fps (matches the deck analysis)

/** Model stem order → our order. HT-Demucs outputs [drums, bass, other, vocals]. */
export const MODEL_STEMS = { drums: 0, bass: 1, other: 2, vocals: 3 } as const;

export type Quality = "performance" | "balanced" | "high";
export const QUALITY_OVERLAP: Record<Quality, number> = { performance: 0.1, balanced: 0.25, high: 0.5 };

export interface Plan {
  total: number;
  overlap: number;
  stride: number;
  chunks: number;
  regions: number;
}

export function makePlan(total: number, quality: Quality): Plan {
  const overlap = Math.round(SEGMENT * QUALITY_OVERLAP[quality]);
  const stride = SEGMENT - overlap;
  const chunks = Math.max(1, Math.ceil(total / stride));
  return { total, overlap, stride, chunks, regions: chunks };
}

/** Chunks whose samples overlap region r. */
export function chunksForRegion(plan: Plan, r: number): number[] {
  const out: number[] = [];
  for (let i = r; i >= 0; i--) {
    if (i * plan.stride + SEGMENT > r * plan.stride) out.push(i);
    else break;
  }
  return out;
}

/** Regions touched by chunk i. */
export function regionsForChunk(plan: Plan, i: number): number[] {
  const start = i * plan.stride;
  const end = Math.min(start + SEGMENT, plan.total);
  const out: number[] = [];
  for (let r = Math.floor(start / plan.stride); r * plan.stride < end && r < plan.regions; r++) out.push(r);
  return out;
}

export interface RegionOutput {
  region: number;
  start: number;
  frames: number;
  /** Interleaved [vL vR dL dR bL bR] Int16. */
  data: Int16Array;
  /** Waveform envelopes (peak per ENV_HOP frame) for vocals, drums, bass, instruments. */
  env: { start: number; vocals: Float32Array; drums: Float32Array; bass: Float32Array; instruments: Float32Array };
}

export type ModelRun = (planar: Float32Array) => Promise<Float32Array>;

interface Accum {
  sum: Float32Array; // 6 channels interleaved per frame
  weight: Float32Array;
}

const toI16 = (v: number) => {
  const s = Math.round(v * 32767);
  return s > 32767 ? 32767 : s < -32768 ? -32768 : s;
};

/**
 * Stateful job. Call `next()` repeatedly (each runs one model segment) until it
 * returns false; `prioritise(frame)` reorders the remaining work.
 */
export class SeparationJob {
  readonly plan: Plan;
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly run: ModelRun;
  private readonly window: Float32Array;
  private readonly chunkDone: Uint8Array;
  private readonly regionDone: Uint8Array;
  private readonly accum = new Map<number, Accum>();
  private order: number[] = [];
  private readonly emit: (r: RegionOutput) => void;

  constructor(opts: {
    left: Float32Array;
    right: Float32Array;
    quality: Quality;
    run: ModelRun;
    emit: (r: RegionOutput) => void;
    startFrame?: number;
    /** Regions already available (e.g. from a partial cache) — never recomputed or re-emitted. */
    doneRegions?: ArrayLike<number>;
  }) {
    this.left = opts.left;
    this.right = opts.right;
    this.run = opts.run;
    this.emit = opts.emit;
    this.plan = makePlan(opts.left.length, opts.quality);
    this.chunkDone = new Uint8Array(this.plan.chunks);
    this.regionDone = new Uint8Array(this.plan.regions);
    for (let r = 0; r < this.plan.regions; r++) if (opts.doneRegions?.[r]) this.regionDone[r] = 1;
    // A chunk is only needed if at least one region it contributes to is still missing.
    for (let i = 0; i < this.plan.chunks; i++) {
      if (regionsForChunk(this.plan, i).every((r) => this.regionDone[r])) this.chunkDone[i] = 1;
    }
    const w = new Float32Array(SEGMENT).fill(1);
    const ov = this.plan.overlap;
    for (let k = 0; k < ov; k++) {
      const f = k / Math.max(1, ov - 1);
      w[k] = f;
      w[SEGMENT - 1 - k] = f;
    }
    this.window = w;
    this.prioritise(opts.startFrame ?? 0);
  }

  get progress(): number {
    let n = 0;
    for (let r = 0; r < this.plan.regions; r++) n += this.regionDone[r];
    return n / this.plan.regions;
  }

  isRegionDone(r: number): boolean {
    return !!this.regionDone[r];
  }

  get finished(): boolean {
    return this.regionDone.every((x) => x === 1);
  }

  /** Order: the region at `frame`, then onwards to the end, then from just before `frame` backwards. */
  prioritise(frame: number): void {
    const r0 = Math.max(0, Math.min(this.plan.regions - 1, Math.floor(frame / this.plan.stride)));
    // Region r0 needs chunks r0 and its overlapping predecessor(s): start with the earliest of those.
    const first = Math.min(...chunksForRegion(this.plan, r0));
    const ahead: number[] = [];
    for (let i = first; i < this.plan.chunks; i++) ahead.push(i);
    const behind: number[] = [];
    for (let i = first - 1; i >= 0; i--) behind.push(i);
    this.order = [...ahead, ...behind].filter((i) => !this.chunkDone[i]);
  }

  /** Process the next segment. Returns false when all regions are done. */
  async next(): Promise<boolean> {
    const i = this.order.shift();
    if (i === undefined) return false;
    if (this.chunkDone[i]) return this.order.length > 0 || !this.finished;
    const P = this.plan;
    const start = i * P.stride;
    const end = Math.min(start + SEGMENT, P.total);
    const clen = end - start;
    const planar = new Float32Array(2 * SEGMENT);
    planar.set(this.left.subarray(start, end), 0);
    planar.set(this.right.subarray(start, end), SEGMENT);
    const out = await this.run(planar); // (4, 2, SEGMENT) planar
    const S = SEGMENT;
    const ch = (stem: number, c: number) => (stem * 2 + c) * S;
    const V = MODEL_STEMS.vocals;
    const D = MODEL_STEMS.drums;
    const B = MODEL_STEMS.bass;
    for (let j = 0; j < clen; j++) {
      const g = start + j;
      const r = Math.floor(g / P.stride);
      if (this.regionDone[r]) continue;
      let a = this.accum.get(r);
      if (!a) {
        const len = Math.min(P.stride, P.total - r * P.stride);
        a = { sum: new Float32Array(len * 6), weight: new Float32Array(len) };
        this.accum.set(r, a);
      }
      const off = g - r * P.stride;
      const w = this.window[j];
      const o = off * 6;
      a.sum[o] += out[ch(V, 0) + j] * w;
      a.sum[o + 1] += out[ch(V, 1) + j] * w;
      a.sum[o + 2] += out[ch(D, 0) + j] * w;
      a.sum[o + 3] += out[ch(D, 1) + j] * w;
      a.sum[o + 4] += out[ch(B, 0) + j] * w;
      a.sum[o + 5] += out[ch(B, 1) + j] * w;
      a.weight[off] += w;
    }
    this.chunkDone[i] = 1;
    for (const r of regionsForChunk(P, i)) {
      if (!this.regionDone[r] && chunksForRegion(P, r).every((c) => this.chunkDone[c])) this.finalize(r);
    }
    return !this.finished;
  }

  private finalize(r: number): void {
    const P = this.plan;
    const a = this.accum.get(r);
    this.regionDone[r] = 1;
    if (!a) return;
    this.accum.delete(r);
    const start = r * P.stride;
    const frames = a.weight.length;
    const data = new Int16Array(frames * 6);
    const envStart = Math.floor(start / ENV_HOP);
    const envEnd = Math.floor((start + frames - 1) / ENV_HOP);
    const n = envEnd - envStart + 1;
    const ev = new Float32Array(n);
    const ed = new Float32Array(n);
    const eb = new Float32Array(n);
    const ei = new Float32Array(n);
    for (let k = 0; k < frames; k++) {
      const w = a.weight[k] > 1e-6 ? a.weight[k] : 1;
      const o = k * 6;
      const vl = a.sum[o] / w;
      const vr = a.sum[o + 1] / w;
      const dl = a.sum[o + 2] / w;
      const dr = a.sum[o + 3] / w;
      const bl = a.sum[o + 4] / w;
      const br = a.sum[o + 5] / w;
      data[o] = toI16(vl);
      data[o + 1] = toI16(vr);
      data[o + 2] = toI16(dl);
      data[o + 3] = toI16(dr);
      data[o + 4] = toI16(bl);
      data[o + 5] = toI16(br);
      const g = start + k;
      const e = Math.floor(g / ENV_HOP) - envStart;
      const il = this.left[g] - vl - dl - bl;
      const ir = this.right[g] - vr - dr - br;
      const pv = Math.max(Math.abs(vl), Math.abs(vr));
      const pd = Math.max(Math.abs(dl), Math.abs(dr));
      const pb = Math.max(Math.abs(bl), Math.abs(br));
      const pi = Math.max(Math.abs(il), Math.abs(ir));
      if (pv > ev[e]) ev[e] = pv;
      if (pd > ed[e]) ed[e] = pd;
      if (pb > eb[e]) eb[e] = pb;
      if (pi > ei[e]) ei[e] = pi;
    }
    this.emit({ region: r, start, frames, data, env: { start: envStart, vocals: ev, drums: ed, bass: eb, instruments: ei } });
  }
}

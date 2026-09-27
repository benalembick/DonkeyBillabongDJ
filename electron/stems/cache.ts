/**
 * On-disk stem cache (local files only — never streaming audio).
 *
 *   <cacheDir>/<key>/meta.json   plan + which regions are done + usage
 *   <cacheDir>/<key>/stems.pcm   Int16 interleaved [vL vR dL dR bL bR] at 44.1 kHz
 *   <cacheDir>/<key>/env.f32     4 × waveform envelopes (vocals, drums, bass, instruments)
 *   <cacheDir>/index.json        library ref → key (for the "stems analysed" indicator)
 *
 * Keys come from the audio content (see fileKey), so renaming files or editing
 * tags doesn't force a re-analysis. Partial caches resume where they stopped.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ENV_HOP, type Quality, type RegionOutput } from "../../src/stems/separator";

export interface CacheMeta {
  version: 1;
  key: string;
  total: number;
  stride: number;
  regions: number;
  quality: Quality;
  done: number[];
  complete: boolean;
  bytes: number;
  createdAt: number;
  lastUsed: number;
}

const BYTES_PER_FRAME = 12; // 6 × Int16
const envFrames = (total: number) => Math.floor((total - 1) / ENV_HOP) + 1;

export class StemCache {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private keyDir(key: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(key)) throw new Error("bad cache key");
    return path.join(this.dir, key);
  }

  async meta(key: string): Promise<CacheMeta | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.keyDir(key), "meta.json"), "utf8")) as CacheMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(m: CacheMeta): Promise<void> {
    const file = path.join(this.keyDir(m.key), "meta.json");
    await fs.writeFile(file + ".tmp", JSON.stringify(m));
    await fs.rename(file + ".tmp", file);
  }

  /** Create (or reuse a compatible) cache entry for a new analysis. */
  async open(key: string, total: number, stride: number, regions: number, quality: Quality): Promise<CacheMeta> {
    const existing = await this.meta(key);
    if (existing && existing.total === total && existing.stride === stride) return existing;
    const dir = this.keyDir(key);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const pcm = await fs.open(path.join(dir, "stems.pcm"), "w");
    await pcm.truncate(total * BYTES_PER_FRAME);
    await pcm.close();
    const env = await fs.open(path.join(dir, "env.f32"), "w");
    await env.truncate(envFrames(total) * 4 * 4);
    await env.close();
    const m: CacheMeta = {
      version: 1,
      key,
      total,
      stride,
      regions,
      quality,
      done: new Array(regions).fill(0),
      complete: false,
      bytes: total * BYTES_PER_FRAME + envFrames(total) * 16,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    await this.writeMeta(m);
    return m;
  }

  async writeRegion(m: CacheMeta, r: RegionOutput): Promise<void> {
    const dir = this.keyDir(m.key);
    const pcm = await fs.open(path.join(dir, "stems.pcm"), "r+");
    try {
      await pcm.write(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), 0, r.data.byteLength, r.start * BYTES_PER_FRAME);
    } finally {
      await pcm.close();
    }
    const env = await fs.open(path.join(dir, "env.f32"), "r+");
    try {
      const n = envFrames(m.total);
      const lanes = [r.env.vocals, r.env.drums, r.env.bass, r.env.instruments];
      for (let s = 0; s < 4; s++) {
        const a = lanes[s];
        await env.write(Buffer.from(a.buffer, a.byteOffset, a.byteLength), 0, a.byteLength, (s * n + r.env.start) * 4);
      }
    } finally {
      await env.close();
    }
    m.done[r.region] = 1;
    m.complete = m.done.every((x) => x === 1);
    m.lastUsed = Date.now();
    await this.writeMeta(m);
  }

  /** Stream every done region back (for loading into a deck). */
  async *readRegions(m: CacheMeta): AsyncGenerator<RegionOutput> {
    const dir = this.keyDir(m.key);
    const pcm = await fs.open(path.join(dir, "stems.pcm"), "r");
    const envAll = new Float32Array((await fs.readFile(path.join(dir, "env.f32"))).buffer.slice(0));
    const n = envFrames(m.total);
    try {
      for (let r = 0; r < m.regions; r++) {
        if (!m.done[r]) continue;
        const start = r * m.stride;
        const frames = Math.min(m.stride, m.total - start);
        const buf = Buffer.alloc(frames * BYTES_PER_FRAME);
        await pcm.read(buf, 0, buf.length, start * BYTES_PER_FRAME);
        const data = new Int16Array(buf.buffer, buf.byteOffset, frames * 6).slice();
        const e0 = Math.floor(start / ENV_HOP);
        const e1 = Math.floor((start + frames - 1) / ENV_HOP) + 1;
        const lane = (s: number) => envAll.slice(s * n + e0, s * n + e1);
        yield { region: r, start, frames, data, env: { start: e0, vocals: lane(0), drums: lane(1), bass: lane(2), instruments: lane(3) } };
      }
    } finally {
      await pcm.close();
    }
    m.lastUsed = Date.now();
    await this.writeMeta(m).catch(() => undefined);
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.keyDir(key), { recursive: true, force: true });
  }

  async list(): Promise<CacheMeta[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: CacheMeta[] = [];
    for (const n of names) {
      if (!/^[a-f0-9]{16,64}$/.test(n)) continue;
      const m = await this.meta(n);
      if (m) out.push(m);
    }
    return out;
  }

  /** Delete least-recently-used entries until the cache fits in `maxBytes`. Returns bytes freed. */
  async cleanup(maxBytes: number, keep: Set<string> = new Set()): Promise<number> {
    const all = (await this.list()).sort((a, b) => a.lastUsed - b.lastUsed);
    let total = all.reduce((s, m) => s + m.bytes, 0);
    let freed = 0;
    for (const m of all) {
      if (total <= maxBytes) break;
      if (keep.has(m.key)) continue;
      await this.remove(m.key);
      total -= m.bytes;
      freed += m.bytes;
    }
    return freed;
  }

  // ── ref → key index (library indicator) ──
  async readIndex(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, "index.json"), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async setIndex(ref: string, key: string | null): Promise<void> {
    const idx = await this.readIndex();
    if (key) idx[ref] = key;
    else delete idx[ref];
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, "index.json"), JSON.stringify(idx));
  }
}

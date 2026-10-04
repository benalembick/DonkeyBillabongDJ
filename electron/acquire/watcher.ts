/**
 * Watch Download Folder: detects audio files produced by an external tool (e.g. a converter
 * writing to its output folder), waits until each has finished writing, and reports it once.
 *
 * fs.watch (recursive on Windows and macOS) gives fast notification; a periodic rescan covers
 * missed events, network drives and tools that write via rename. Pure Node — unit-tested.
 */
import { promises as fs } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isAudioPath, isPartialName, PARTIAL_DIR, waitForStable } from "./fileOps";

export interface StableFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export interface WatcherOptions {
  folder: string;
  onFile: (f: StableFile) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Report files already in the folder when watching starts (default true). */
  initialScan?: boolean;
  intervalMs?: number;
  stableChecks?: number;
  rescanMs?: number;
  maxDepth?: number;
}

export class FolderWatcher {
  private fsWatcher: FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** path → "size:mtime" already reported (re-reported only when the file changes). */
  private reported = new Map<string, string>();
  private checking = new Set<string>();
  private stopped = false;
  private ctl = new AbortController();
  seen = 0;

  constructor(private o: WatcherOptions) {}

  async start(): Promise<void> {
    const st = await fs.stat(this.o.folder).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Watch folder not found: ${this.o.folder}`);
    try {
      this.fsWatcher = watch(this.o.folder, { recursive: true }, (_event, name) => {
        if (name) this.consider(path.join(this.o.folder, name.toString()));
      });
      this.fsWatcher.on("error", (err) => this.o.onError?.(`Folder watch error: ${String(err)} — falling back to periodic scans`));
    } catch (err) {
      this.o.onError?.(`Live folder watching unavailable (${String(err)}) — scanning every ${Math.round((this.o.rescanMs ?? 15000) / 1000)} s instead`);
    }
    if (this.o.initialScan !== false) await this.rescan();
    else for (const f of await this.list(this.o.folder, 0)) this.reported.set(f.path, `${f.size}:${f.mtimeMs}`);
    this.rescanTimer = setInterval(() => void this.rescan(), this.o.rescanMs ?? 15000);
  }

  stop(): void {
    this.stopped = true;
    this.ctl.abort();
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
  }

  async rescan(): Promise<void> {
    if (this.stopped) return;
    for (const f of await this.list(this.o.folder, 0)) {
      if (this.reported.get(f.path) !== `${f.size}:${f.mtimeMs}`) this.consider(f.path);
    }
  }

  private async list(dir: string, depth: number): Promise<StableFile[]> {
    if (depth > (this.o.maxDepth ?? 4)) return [];
    const out: StableFile[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name === PARTIAL_DIR) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.list(full, depth + 1)));
      else if (e.isFile() && isAudioPath(e.name) && !isPartialName(e.name)) {
        const st = await fs.stat(full).catch(() => null);
        if (st) out.push({ path: full, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  private consider(p: string): void {
    const name = path.basename(p);
    if (this.stopped || !isAudioPath(p) || isPartialName(name) || p.split(path.sep).includes(PARTIAL_DIR) || this.checking.has(p)) return;
    this.checking.add(p);
    void (async () => {
      try {
        const st = await waitForStable(p, { intervalMs: this.o.intervalMs ?? 1000, checks: this.o.stableChecks ?? 2, signal: this.ctl.signal });
        const sig = `${st.size}:${st.mtimeMs}`;
        if (this.stopped || this.reported.get(p) === sig) return;
        this.reported.set(p, sig);
        this.seen++;
        await this.o.onFile({ path: p, name, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (!this.stopped && m !== "File disappeared" && m !== "Cancelled") this.o.onError?.(`${name}: ${m}`);
      } finally {
        this.checking.delete(p);
      }
    })();
  }
}

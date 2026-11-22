/**
 * Library Intelligence: the "Analyse Library" background job.
 *
 *  Phase A — audio analysis for tracks with no cached analysis, through the existing AnalysisService
 *            (same worker, cache, cancel, crash guard and long-file guard — no second engine).
 *  Phase B — set-intelligence derivation from the cached waveform record (no decode), stored on the
 *            track's preparation record. Up-to-date tracks are skipped.
 *
 * Cues, beat grids and tags are never written. Pending work is persisted so a cancelled or
 * interrupted job can be resumed after a restart. Freshly analysed tracks are derived incrementally.
 */
import { Emitter } from "../core/events";
import type { TrackInfo } from "../core/engine/types";
import type { AnalysisProgress } from "../analysis/AnalysisService";
import type { PreparationStore } from "../preparation/PreparationStore";
import type { TrackPreparation } from "../preparation/types";
import { computeSetFeatures, intelStale } from "./features";
import type { TrackOverrides } from "./types";

export type IntelStatus = "queued" | "analysing" | "deriving" | "done" | "cached" | "skipped" | "failed" | "cancelled";
export interface IntelItem { ref: string; title: string; artist: string; status: IntelStatus; message?: string }
export interface IntelJobState {
  running: boolean;
  phase: "idle" | "audio" | "features";
  total: number;
  done: number;
  current: string;
  items: IntelItem[];
  /** Refs left over from a cancelled/interrupted job. */
  resumable: number;
  lastRun: { at: number; done: number; cached: number; failed: number; skipped: number; cancelled: boolean } | null;
}

interface AnalysisPort {
  analyseTracks(tracks: TrackInfo[], force?: boolean): Promise<void>;
  cancelBatch(): void;
  getState(): AnalysisProgress;
  on(event: "change", cb: (s: AnalysisProgress) => void): () => void;
}
interface LibraryPort { getState(): { tracks: TrackInfo[] }; getByRef(ref: string): TrackInfo | null }
export interface IntelOptions {
  library: LibraryPort;
  preparation: Pick<PreparationStore, "forRef" | "get" | "waveform" | "updateSetData" | "on">;
  analysis: AnalysisPort;
  /** Vocal fraction 0..1 from completed STEMS, or null when not separated. */
  vocalFraction?: (ref: string) => Promise<number | null>;
  /** STEMS separation complete for this ref (to refresh intel that lacks vocal data). */
  stemsComplete?: (ref: string) => boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  log?: (level: "info" | "warn", message: string) => void;
  /** Yield between tracks (tests pass a synchronous one). */
  yieldFn?: () => Promise<void>;
}

const JOB_KEY = "dbdj.setstudio.intelJob.v1";
const FRESH_MS = 120_000;
const name = (t: { artist: string; title: string }) => (t.artist ? `${t.artist} – ${t.title}` : t.title);

export class LibraryIntelligence extends Emitter<{ change: IntelJobState }> {
  private state: IntelJobState = { running: false, phase: "idle", total: 0, done: 0, current: "", items: [], resumable: 0, lastRun: null };
  private cancelled = false;
  private incremental = new Set<string>();
  private incrementalTimer: ReturnType<typeof setTimeout> | null = null;
  private storage: IntelOptions["storage"];
  constructor(private o: IntelOptions) {
    super();
    this.storage = o.storage !== undefined ? o.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    this.state.resumable = this.pending().length;
    o.preparation.on("record", (r) => this.onRecord(r));
  }
  getState() { return this.state; }
  private set(patch: Partial<IntelJobState>) { this.state = { ...this.state, ...patch }; this.emit("change", this.state); }
  private item(ref: string, patch: Partial<IntelItem>) { this.set({ items: this.state.items.map((i) => (i.ref === ref ? { ...i, ...patch } : i)) }); }

  private pending(): string[] { try { const v = JSON.parse(this.storage?.getItem(JOB_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } }
  private savePending(refs: string[]) { try { if (refs.length) this.storage?.setItem(JOB_KEY, JSON.stringify(refs)); else this.storage?.removeItem(JOB_KEY); } catch { /* best effort */ } }

  /** Library coverage for the dashboard. */
  coverage(): { local: number; analysed: number; intel: number; stale: number; overrides: number; unavailable: number } {
    let local = 0, analysed = 0, intel = 0, stale = 0, overrides = 0, unavailable = 0;
    for (const t of this.o.library.getState().tracks) {
      if (t.source !== "local") continue;
      local++;
      if (t.unavailableReason) unavailable++;
      const r = this.o.preparation.forRef(t.ref);
      if (!r || r.analysisVersion === null) continue;
      analysed++;
      if (r.setOverrides) overrides++;
      if (intelStale(r.intel, r.analysedAt)) stale++; else intel++;
    }
    return { local, analysed, intel, stale, overrides, unavailable };
  }

  cancel(): void { if (!this.state.running) return; this.cancelled = true; this.o.analysis.cancelBatch(); this.set({ current: "Cancelling after the current track…" }); }
  resume(): Promise<void> { return this.analyse(this.pending()); }
  retryFailed(): Promise<void> { return this.analyse(this.state.items.filter((i) => i.status === "failed").map((i) => i.ref), { force: true }); }

  /** Analyse the given refs (default: every local track). `force` re-analyses audio and re-derives. */
  async analyse(refs?: string[], opts: { force?: boolean } = {}): Promise<void> {
    if (this.state.running) return;
    const force = !!opts.force;
    const all = (refs ? refs.map((r) => this.o.library.getByRef(r)).filter((t): t is TrackInfo => !!t) : this.o.library.getState().tracks).filter((t) => t.source === "local");
    const tracks = [...new Map(all.map((t) => [t.ref, t])).values()];
    this.cancelled = false;
    this.savePending(tracks.map((t) => t.ref));
    this.set({ running: true, phase: "audio", total: tracks.length, done: 0, current: "", resumable: 0,
      items: tracks.map((t) => ({ ref: t.ref, title: t.title, artist: t.artist, status: t.unavailableReason ? "skipped" : "queued", message: t.unavailableReason })) });
    let done = 0;
    const finish = (_ref: string) => { done++; this.set({ done }); };
    try {
      // ── Phase A: audio analysis through the existing AnalysisService ──
      const usable = tracks.filter((t) => !t.unavailableReason);
      tracks.filter((t) => t.unavailableReason).forEach((t) => finish(t.ref));
      const need = usable.filter((t) => force || !(this.o.preparation.forRef(t.ref)?.analysisVersion != null));
      if (need.length) {
        await this.waitForAnalysisIdle();
        need.forEach((t) => this.item(t.ref, { status: "analysing" }));
        const off = this.o.analysis.on("change", (s) => { if (s.current) this.set({ current: `Analysing audio: ${s.current} (${s.done}/${s.total})` }); });
        try { await this.o.analysis.analyseTracks(need, force); } finally { off(); }
        const s = this.o.analysis.getState();
        for (const t of need) {
          if (this.o.preparation.forRef(t.ref)?.analysisVersion != null) continue;
          const err = s.errors.find((e) => e.startsWith(`${name(t)}:`)), skip = s.skipped.find((e) => e.startsWith(`${name(t)}:`));
          if (skip) this.item(t.ref, { status: "skipped", message: skip.slice(name(t).length + 2) });
          else if (err) this.item(t.ref, { status: "failed", message: err.slice(name(t).length + 2) });
          else this.item(t.ref, { status: this.cancelled ? "cancelled" : "failed", message: this.cancelled ? undefined : "Not analysed" });
          finish(t.ref);
        }
      }
      // ── Phase B: set intelligence from the cached analysis ──
      this.set({ phase: "features" });
      const remaining = new Set(usable.map((t) => t.ref));
      for (const t of usable) {
        const it = this.state.items.find((i) => i.ref === t.ref)!;
        if (it.status === "failed" || it.status === "skipped" || it.status === "cancelled") { remaining.delete(t.ref); continue; }
        if (this.cancelled) { this.item(t.ref, { status: "cancelled" }); continue; }
        this.set({ current: `Deriving set features: ${t.title}` });
        try {
          const status = await this.derive(t, force);
          this.item(t.ref, { status });
          remaining.delete(t.ref);
        } catch (e) {
          this.item(t.ref, { status: "failed", message: e instanceof Error ? e.message : String(e) });
          remaining.delete(t.ref);
        }
        finish(t.ref);
        this.savePending([...remaining]);
        await (this.o.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0))))();
      }
      this.savePending(this.cancelled ? [...remaining] : []);
    } finally {
      const items = this.state.items, count = (s: IntelStatus) => items.filter((i) => i.status === s).length;
      const lastRun = { at: Date.now(), done: count("done"), cached: count("cached"), failed: count("failed"), skipped: count("skipped"), cancelled: this.cancelled };
      this.set({ running: false, phase: "idle", current: this.cancelled ? "Cancelled — resume any time" : "", resumable: this.pending().length, lastRun });
      this.o.log?.(lastRun.failed ? "warn" : "info", `Library Intelligence: ${lastRun.done} derived, ${lastRun.cached} up to date, ${lastRun.failed} failed, ${lastRun.skipped} skipped${lastRun.cancelled ? " (cancelled)" : ""}`);
    }
  }

  private async waitForAnalysisIdle(): Promise<void> {
    if (!this.o.analysis.getState().busy) return;
    this.set({ current: "Waiting for the current background analysis to finish…" });
    await new Promise<void>((resolve) => { const off = this.o.analysis.on("change", (s) => { if (!s.busy) { off(); resolve(); } }); });
  }

  /** Derive and store intel for one analysed track. Idempotent: returns "cached" when up to date. */
  async derive(t: TrackInfo, force = false): Promise<IntelStatus> {
    const r = this.o.preparation.forRef(t.ref);
    if (!r || r.analysisVersion === null) throw new Error("No cached analysis — analyse the track first");
    const wantsVocals = !r.intel?.vocalSource && !!this.o.stemsComplete?.(t.ref);
    if (!force && !intelStale(r.intel, r.analysedAt) && !wantsVocals) return "cached";
    this.item(t.ref, { status: "deriving" });
    const wave = await this.o.preparation.waveform(r.trackId);
    if (!wave) throw new Error("Cached analysis data is missing — reanalyse this track");
    const vocal = this.o.vocalFraction ? await this.o.vocalFraction(t.ref).catch(() => null) : null;
    const intel = computeSetFeatures(wave, { duration: r.duration, genreTag: t.genre ?? null, key: r.key, bpm: r.beatGrid?.bpm ?? r.bpm, vocalPresence: vocal }, r.analysedAt);
    this.o.preparation.updateSetData(r.trackId, { intel });
    return "done";
  }

  /** User overrides (energy/moods/genre). `null` clears them. The derived values stay untouched. */
  setOverrides(trackId: string, patch: Omit<TrackOverrides, "updatedAt"> | null): TrackPreparation | null {
    if (patch === null) return this.o.preparation.updateSetData(trackId, { setOverrides: null });
    const current = this.o.preparation.get(trackId)?.setOverrides ?? {};
    const next: TrackOverrides = { ...current, ...patch, updatedAt: Date.now() };
    for (const k of Object.keys(next) as (keyof TrackOverrides)[]) if (next[k] === undefined) delete next[k];
    return this.o.preparation.updateSetData(trackId, { setOverrides: next });
  }

  /** Freshly analysed tracks (this session) are derived automatically, a few seconds later, one at a time. */
  private onRecord(r: TrackPreparation): void {
    if (this.state.running || r.analysisVersion === null || !r.analysedAt || Date.now() - r.analysedAt > FRESH_MS) return;
    if (!intelStale(r.intel, r.analysedAt)) return;
    const ref = r.refs.find((x) => this.o.library.getByRef(x));
    if (!ref) return;
    this.incremental.add(ref);
    if (this.incrementalTimer) clearTimeout(this.incrementalTimer);
    this.incrementalTimer = setTimeout(() => void this.drainIncremental(), 1500);
  }
  private async drainIncremental(): Promise<void> {
    this.incrementalTimer = null;
    const refs = [...this.incremental]; this.incremental.clear();
    for (const ref of refs) {
      if (this.state.running) return;
      const t = this.o.library.getByRef(ref);
      if (t) await this.derive(t).catch((e) => this.o.log?.("warn", `Set features for ${t.title}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

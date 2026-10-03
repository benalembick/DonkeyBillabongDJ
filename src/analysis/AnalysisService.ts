import { Emitter } from "../core/events";
import type { DJEngine } from "../core/engine/DJEngine";
import type { AudioEngine, TrackInfo } from "../core/engine/types";
import type { TrackAnalysis } from "./analyzeTrack";
import type { PreparationStore } from "../preparation/PreparationStore";

export type Overview = TrackAnalysis;
export interface AnalysisProgress { busy: boolean; done: number; total: number; current: string; errors: string[]; skipped: string[]; cacheHits: number; runs: number }
interface Options {
  preparation: PreparationStore; audio: AudioEngine; readAudio: (ref: string) => Promise<ArrayBuffer>;
  /** Problems the user should see (shown as a notification). */
  onError: (e: unknown) => void;
  /** Per-track details for Diagnostics (no notification). */
  onInfo?: (message: string) => void;
  /** Duration in seconds from the file header (tags), for tracks whose tags weren't read yet. */
  probeDuration?: (ref: string) => Promise<number | null>;
  /** Where the crash guard is kept (localStorage by default; absent in tests). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/**
 * Background analysis decodes a whole file into memory (≈ 23 MB per stereo minute at 48 kHz).
 * Longer files — DJ mixes, radio shows — are left for when they're loaded onto a deck.
 */
export const MAX_BATCH_SECONDS = 20 * 60;
export const MAX_BATCH_BYTES = 300 * 1024 * 1024;
const GUARD_KEY = "dbdj.analysis.current";
const SKIP_KEY = "dbdj.analysis.skip";

class SkipTrack extends Error {}

const minutes = (s: number) => `${Math.round(s / 60)} min`;

/** Shared worker and persistent cache for deck loads and sequential off-deck library preparation. */
export class AnalysisService extends Emitter<{ overview: { deck: number; overview: Overview | null }; change: AnalysisProgress }> {
  private worker: Worker | null = null;
  private overviews: (Overview | null)[] = [];
  private generations: number[] = [];
  private pending = new Map<number, { resolve: (a: Overview) => void; reject: (e: unknown) => void }>();
  private inflight = new Map<string, Promise<Overview>>();
  private nextId = 1;
  private cancelled = false;
  private queued = new Map<string, TrackInfo>();
  private state: AnalysisProgress = { busy: false, done: 0, total: 0, current: "", errors: [], skipped: [], cacheHits: 0, runs: 0 };
  /** Tracks that were being analysed when the app last closed unexpectedly. */
  private crashed = new Set<string>();
  private storage: Options["storage"];
  constructor(private engine: DJEngine, private options?: Options, private buckets = 1200) {
    super();
    this.storage = options?.storage !== undefined ? options.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    this.restoreCrashGuard();
    engine.on("event", (e) => {
      if (e.type !== "trackLoaded" && e.type !== "trackUnloaded") return;
      const generation = (this.generations[e.deck] ?? 0) + 1;
      this.generations[e.deck] = generation;
      this.show(e.deck, null);
      if (e.type === "trackUnloaded") return;
      const buf = e.audioHandle as AudioBuffer | null;
      if (!buf || typeof buf.getChannelData !== "function") return;
      void this.analyseBuffer(e.track, buf).then((a) => {
        if (generation !== this.generations[e.deck] || engine.getState().decks[e.deck].track?.ref !== e.track.ref) return;
        this.apply(e.deck, a);
      }).catch((err) => options?.onError(err));
    });
  }
  get(deck: number): Overview | null { return this.overviews[deck] ?? null; }
  getState() { return this.state; }
  private set(patch: Partial<AnalysisProgress>) { this.state = { ...this.state, ...patch }; this.emit("change", this.state); }
  private show(deck: number, overview: Overview | null) { this.overviews[deck] = overview; this.emit("overview", { deck, overview }); }
  private apply(deck: number, analysis: Overview) {
    const d = this.engine.getState().decks[deck];
    if (d.status !== "ready") return;
    const prepared = d.track?.trackId ? this.options?.preparation.get(d.track.trackId) : undefined;
    if (prepared) this.engine.refreshPreparation(prepared.trackId, this.options!.preparation.fields(prepared, d.duration));
    else if (analysis.bpm && analysis.firstBeat !== null) this.engine.setBeatGrid(deck, { bpm: analysis.bpm, firstBeat: analysis.firstBeat, confidence: analysis.confidence, source: analysis.bpmSource });
    this.show(deck, analysis);
  }
  /**
   * `transfer`: hand the decoded samples to the worker instead of copying them (library analysis,
   * where the buffer isn't used afterwards). Deck loads copy, since the deck plays that buffer.
   */
  private async analyseBuffer(track: TrackInfo, buffer: AudioBuffer, force = false, transfer = false): Promise<Overview> {
    const trackId = track.trackId;
    if (!force && trackId && this.options) {
      const cached = await this.options.preparation.waveform(trackId);
      if (cached) {
        this.set({ cacheHits: this.state.cacheHits + 1 });
        if (!cached.bands) this.upgradeDisplay(track, trackId, buffer, cached);
        return cached;
      }
    }
    const key = trackId ?? track.ref, current = this.inflight.get(key);
    if (current) return current;
    const work = (async () => {
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
      const id = this.nextId++;
      const duration = buffer.duration;
      const result = new Promise<Overview>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const message = { id, channels, sampleRate: buffer.sampleRate, buckets: this.buckets, metaBpm: force ? null : track.bpm ?? null };
        try {
          this.getWorker().postMessage(message, transfer ? [...new Set(channels.map((c) => c.buffer as ArrayBuffer))] : []);
        } catch (e) {
          this.pending.delete(id);
          reject(e);
        }
      });
      this.set({ runs: this.state.runs + 1 });
      const analysis = await result;
      if (trackId && this.options) await this.options.preparation.saveAnalysis(trackId, analysis, duration, track);
      return analysis;
    })();
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }
  /**
   * Caches from before waveform styles lack per-channel display bands. Add them once in the
   * background from the already-decoded deck buffer, keeping every cached result (grid, cues,
   * sections, key) exactly as it was — only the display data is new.
   */
  private upgrading = new Set<string>();
  private upgradeDisplay(track: TrackInfo, trackId: string, buffer: AudioBuffer, cached: Overview): void {
    if (this.upgrading.has(trackId) || !this.options) return;
    this.upgrading.add(trackId);
    void (async () => {
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
      const id = this.nextId++;
      const fresh = await new Promise<Overview>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.getWorker().postMessage({ id, channels, sampleRate: buffer.sampleRate, buckets: this.buckets, metaBpm: track.bpm ?? null });
      });
      if (!fresh.bands) return;
      const merged: Overview = { ...cached, bands: fresh.bands };
      await this.options!.preparation.saveAnalysis(trackId, merged, buffer.duration, track);
      this.engine.getState().decks.forEach((d, deck) => {
        if (d.status === "ready" && d.track?.trackId === trackId && this.overviews[deck] === cached) this.show(deck, merged);
      });
    })()
      .catch((err) => this.options?.onError(err))
      .finally(() => this.upgrading.delete(trackId));
  }

  cancelBatch(): void { this.cancelled = true; }

  /**
   * Analyse one track now, even while a library batch is running (e.g. the Transitions page
   * needs it). Reports its stage; resolves when the analysis is saved.
   */
  async analyseOne(track: TrackInfo, onStage: (stage: "reading" | "decoding" | "analysing" | "done") => void = () => undefined, force = false): Promise<void> {
    if (!this.options) throw new Error("Analysis isn't available");
    if (track.source !== "local") throw new Error("Only local files can be analysed");
    if (track.unavailableReason) throw new Error(track.unavailableReason);
    onStage("reading");
    const bytes = await this.options.readAudio(track.ref);
    const prep = await this.options.preparation.identify(track, bytes);
    if (!force && (await this.options.preparation.waveform(prep.trackId)) && prep.analysisVersion !== null) return onStage("done");
    onStage("decoding");
    const decoded = await this.options.audio.decode(bytes);
    const buffer = decoded.handle as AudioBuffer;
    if (!buffer || typeof buffer.getChannelData !== "function") throw new Error("Audio decoder did not provide analysis samples");
    onStage("analysing");
    const result = await this.analyseBuffer({ ...track, trackId: prep.trackId }, buffer, force, true);
    this.engine.getState().decks.forEach((d, deck) => { if (d.status === "ready" && d.track?.trackId === prep.trackId) this.apply(deck, result); });
    onStage("done");
  }
  /** Add import work without blocking the caller; one sequential batch protects playback responsiveness. */
  queueTracks(tracks: TrackInfo[]): void {
    for (const track of tracks) if (track.source === "local" && !track.unavailableReason) this.queued.set(track.ref, track);
    if (!this.state.busy) queueMicrotask(() => void this.drainQueue());
  }
  private async drainQueue(): Promise<void> {
    if (this.state.busy || !this.queued.size) return;
    const tracks = [...this.queued.values()]; this.queued.clear();
    await this.analyseTracks(tracks);
    if (this.queued.size) void this.drainQueue();
  }
  async analyseTracks(tracks: TrackInfo[], force = false): Promise<void> {
    if (!this.options || this.state.busy) return;
    const list = [...new Map(tracks.filter((t) => t.source === "local").map((t) => [t.ref, t])).values()];
    this.cancelled = false;
    this.set({ busy: true, done: 0, total: list.length, current: "", errors: [], skipped: [] });
    const name = (t: TrackInfo) => (t.artist ? `${t.artist} – ${t.title}` : t.title);
    try {
      for (const track of list) {
        if (this.cancelled) break;
        this.set({ current: track.title });
        // Explicit "Analyse"/"Reanalyse" (force) retries a track that crashed the app before.
        const guarded = !force && this.crashed.has(track.ref);
        try {
          if (track.unavailableReason) throw new Error(track.unavailableReason);
          if (guarded) throw new SkipTrack("the app closed unexpectedly while analysing it last time");
          if (!force && !track.prepared) {
            // Before reading or decoding anything: long files would need gigabytes once decoded.
            const seconds = track.durationMs ? track.durationMs / 1000 : await this.options.probeDuration?.(track.ref).catch(() => null);
            if (seconds && seconds > MAX_BATCH_SECONDS) throw new SkipTrack(`too long for background analysis (${minutes(seconds)})`);
          }
          const bytes = await this.options.readAudio(track.ref);
          if (!force && bytes.byteLength > MAX_BATCH_BYTES) throw new SkipTrack(`file too large for background analysis (${Math.round(bytes.byteLength / 1048576)} MB)`);
          const prep = await this.options.preparation.identify(track, bytes);
          const cached = !force && await this.options.preparation.waveform(prep.trackId);
          if (cached) this.set({ cacheHits: this.state.cacheHits + 1 });
          else {
            this.guard(track.ref);
            const decoded = await this.options.audio.decode(bytes), buffer = decoded.handle as AudioBuffer;
            if (!buffer || typeof buffer.getChannelData !== "function") throw new Error("Audio decoder did not provide analysis samples");
            if (!force && decoded.duration > MAX_BATCH_SECONDS) throw new SkipTrack(`too long for background analysis (${minutes(decoded.duration)})`);
            const result = await this.analyseBuffer({ ...track, trackId: prep.trackId }, buffer, force, true);
            this.engine.getState().decks.forEach((d, deck) => { if (d.status === "ready" && d.track?.trackId === prep.trackId) this.apply(deck, result); });
          }
          if (this.crashed.delete(track.ref)) this.saveSkipList();
        } catch (e) {
          if (e instanceof SkipTrack) {
            this.set({ skipped: [...this.state.skipped, `${name(track)}: ${e.message}`] });
            this.options.onInfo?.(`Skipped ${name(track)}: ${e.message}. It's analysed when loaded onto a deck.`);
          } else {
            const reason = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e);
            this.set({ errors: [...this.state.errors, `${name(track)}: ${reason}`] });
            this.options.onInfo?.(`Couldn't analyse ${name(track)} (${track.ref}): ${reason}`);
          }
        } finally {
          this.unguard();
        }
        this.set({ done: this.state.done + 1 });
        // Let the UI, audio callbacks and garbage collector run between tracks.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      const { errors, skipped } = this.state;
      if (errors.length || skipped.length) {
        const parts = [errors.length && `${errors.length} couldn't be analysed`, skipped.length && `${skipped.length} skipped`].filter(Boolean).join(", ");
        this.options.onError(new Error(`Library analysis: ${parts} — see Diagnostics for the list`));
      }
      this.set({ busy: false, current: this.cancelled ? "Cancelled after current track" : "" });
      if (this.queued.size) queueMicrotask(() => void this.drainQueue());
    }
  }

  // Crash guard: the track being decoded is recorded first, so if it takes the app down
  // (e.g. out of memory) it's skipped on the next start instead of crashing it again.
  private guard(ref: string): void {
    try { this.storage?.setItem(GUARD_KEY, ref); } catch { /* storage unavailable */ }
  }
  private unguard(): void {
    try { this.storage?.removeItem(GUARD_KEY); } catch { /* storage unavailable */ }
  }
  private restoreCrashGuard(): void {
    try {
      const saved = JSON.parse(this.storage?.getItem(SKIP_KEY) ?? "[]");
      if (Array.isArray(saved)) for (const r of saved) this.crashed.add(String(r));
      const last = this.storage?.getItem(GUARD_KEY);
      if (last) {
        this.crashed.add(last);
        this.saveSkipList();
        this.unguard();
        queueMicrotask(() => this.options?.onError(new Error(`The app closed while analysing ${last.split(/[\\/]/).pop()}. That file will be skipped by background analysis (Reanalyse it from the library to try again).`)));
      }
    } catch { /* storage unavailable or corrupt: start clean */ }
  }
  private saveSkipList(): void {
    try { this.storage?.setItem(SKIP_KEY, JSON.stringify([...this.crashed])); } catch { /* storage unavailable */ }
  }
  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./overview.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<Overview & { id: number; error?: string }>) => {
        const job = this.pending.get(e.data.id); this.pending.delete(e.data.id);
        if (!job) return;
        if (e.data.error) { job.reject(new Error(e.data.error)); return; }
        const { id: _id, error: _error, ...overview } = e.data;
        job.resolve(overview);
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message));
        this.pending.clear(); this.worker?.terminate(); this.worker = null;
      };
    }
    return this.worker;
  }
}

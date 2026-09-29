import { Emitter } from "../core/events";
import type { DJEngine } from "../core/engine/DJEngine";
import type { AudioEngine, TrackInfo } from "../core/engine/types";
import type { TrackAnalysis } from "./analyzeTrack";
import type { PreparationStore } from "../preparation/PreparationStore";

export type Overview = TrackAnalysis;
export interface AnalysisProgress { busy: boolean; done: number; total: number; current: string; errors: string[]; cacheHits: number; runs: number }
interface Options { preparation: PreparationStore; audio: AudioEngine; readAudio: (ref: string) => Promise<ArrayBuffer>; onError: (e: unknown) => void }

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
  private state: AnalysisProgress = { busy: false, done: 0, total: 0, current: "", errors: [], cacheHits: 0, runs: 0 };
  constructor(private engine: DJEngine, private options?: Options, private buckets = 1200) {
    super();
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
  private async analyseBuffer(track: TrackInfo, buffer: AudioBuffer, force = false): Promise<Overview> {
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
      const result = new Promise<Overview>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.getWorker().postMessage({ id, channels, sampleRate: buffer.sampleRate, buckets: this.buckets, metaBpm: force ? null : track.bpm ?? null });
      });
      this.set({ runs: this.state.runs + 1 });
      const analysis = await result;
      if (trackId && this.options) await this.options.preparation.saveAnalysis(trackId, analysis, buffer.duration, track);
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
    this.set({ busy: true, done: 0, total: list.length, current: "", errors: [] });
    try {
      for (const track of list) {
        if (this.cancelled) break;
        this.set({ current: track.title });
        try {
          if (track.unavailableReason) throw new Error(track.unavailableReason);
          const bytes = await this.options.readAudio(track.ref);
          const prep = await this.options.preparation.identify(track, bytes);
          const cached = !force && await this.options.preparation.waveform(prep.trackId);
          if (cached) this.set({ cacheHits: this.state.cacheHits + 1 });
          else {
            const decoded = await this.options.audio.decode(bytes), buffer = decoded.handle as AudioBuffer;
            if (!buffer || typeof buffer.getChannelData !== "function") throw new Error("Audio decoder did not provide analysis samples");
            const result = await this.analyseBuffer({ ...track, trackId: prep.trackId }, buffer, force);
            this.engine.getState().decks.forEach((d, deck) => { if (d.status === "ready" && d.track?.trackId === prep.trackId) this.apply(deck, result); });
          }
        } catch (e) { this.set({ errors: [...this.state.errors, `${track.title}: ${String(e)}`] }); this.options.onError(e); }
        this.set({ done: this.state.done + 1 });
      }
    } finally {
      this.set({ busy: false, current: this.cancelled ? "Cancelled after current track" : "" });
      if (this.queued.size) queueMicrotask(() => void this.drainQueue());
    }
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

import { Emitter } from "../core/events";
import type { DJEngine } from "../core/engine/DJEngine";
import type { TrackAnalysis } from "./analyzeTrack";

export type Overview = TrackAnalysis;

/**
 * Runs track analysis in a Web Worker whenever a deck loads a track and hands
 * the beat grid to the DJ engine. Results live here (not in React), so
 * switching UI layouts never re-analyses or loses them.
 */
export class AnalysisService extends Emitter<{ overview: { deck: number; overview: Overview | null } }> {
  private worker: Worker | null = null;
  private overviews: (Overview | null)[] = [];
  private pending = new Map<number, number>(); // request id → deck
  private nextId = 1;
  private readonly engine: DJEngine;

  constructor(engine: DJEngine, buckets = 1200) {
    super();
    this.engine = engine;
    engine.on("event", (e) => {
      if (e.type === "trackLoaded" || e.type === "trackUnloaded") {
        for (const [id, deck] of this.pending) if (deck === e.deck) this.pending.delete(id);
      }
      if (e.type === "trackUnloaded") {
        this.overviews[e.deck] = null;
        this.emit("overview", { deck: e.deck, overview: null });
        return;
      }
      if (e.type !== "trackLoaded") return;
      this.overviews[e.deck] = null;
      this.emit("overview", { deck: e.deck, overview: null });
      const buf = e.audioHandle as AudioBuffer | null;
      if (!buf || typeof buf.getChannelData !== "function") return;
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
      const id = this.nextId++;
      this.pending.set(id, e.deck);
      this.getWorker().postMessage({ id, channels, sampleRate: buf.sampleRate, buckets, metaBpm: e.track.bpm ?? null });
    });
  }

  get(deck: number): Overview | null {
    return this.overviews[deck] ?? null;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./overview.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<Overview & { id: number }>) => {
        const deck = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (deck === undefined) return;
        // Ignore results superseded by a newer load on the same deck.
        for (const d of this.pending.values()) if (d === deck) return;
        const { id: _id, ...overview } = e.data;
        void _id;
        this.overviews[deck] = overview;
        if (overview.bpm && overview.firstBeat != null) {
          this.engine.setBeatGrid(deck, { bpm: overview.bpm, firstBeat: overview.firstBeat, confidence: overview.confidence, source: overview.bpmSource });
        }
        this.emit("overview", { deck, overview });
      };
    }
    return this.worker;
  }
}

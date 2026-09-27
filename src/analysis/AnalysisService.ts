import { Emitter } from "../core/events";
import type { DJEngine } from "../core/engine/DJEngine";

export interface Overview {
  peaks: Float32Array;
  rms: Float32Array;
}

/** Runs track analysis in a Web Worker whenever a deck loads a track. */
export class AnalysisService extends Emitter<{ overview: { deck: number; overview: Overview | null } }> {
  private worker: Worker | null = null;
  private overviews: (Overview | null)[] = [];
  private pending = new Map<number, number>(); // request id → deck
  private nextId = 1;

  constructor(engine: DJEngine, buckets = 1200) {
    super();
    engine.on("event", (e) => {
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
      this.getWorker().postMessage({ id, channels, buckets });
    });
  }

  get(deck: number): Overview | null {
    return this.overviews[deck] ?? null;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./overview.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; peaks: Float32Array; rms: Float32Array }>) => {
        const deck = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        if (deck === undefined) return;
        // Ignore results superseded by a newer load on the same deck.
        for (const d of this.pending.values()) if (d === deck) return;
        const overview = { peaks: e.data.peaks, rms: e.data.rms };
        this.overviews[deck] = overview;
        this.emit("overview", { deck, overview });
      };
    }
    return this.worker;
  }
}

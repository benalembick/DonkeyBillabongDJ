import type { PreparationPersistence, TrackPreparation, WaveformRecord } from "./types";

/** Separate stores keep frequent cue edits small; waveform data never contains source audio. */
export class BrowserPreparation implements PreparationPersistence {
  private db?: Promise<IDBDatabase>;
  private open() {
    return this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("dbdj-preparation", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("tracks", { keyPath: "trackId" }); r.result.createObjectStore("waveforms", { keyPath: "trackId" }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async read<T>(store: string, key?: string): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const s = db.transaction(store).objectStore(store), r = key ? s.get(key) : s.getAll();
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  }
  private async write(store: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  list() { return this.read<TrackPreparation[]>("tracks"); }
  save(r: TrackPreparation) { return this.write("tracks", r); }
  loadWaveform(id: string) { return this.read<WaveformRecord | null>("waveforms", id); }
  saveWaveform(r: WaveformRecord) { return this.write("waveforms", r); }
}

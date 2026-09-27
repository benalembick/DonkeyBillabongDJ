import type { TrackInfo } from "../core/engine/types";
import type { LibraryPersistence } from "../platform";

export const RECONNECT_MESSAGE = "Choose the original files using Reconnect files to restore access.";

/** Metadata and small covers only. Audio remains in the user's original files. */
export class BrowserLibrary implements LibraryPersistence {
  private db: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    return this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open("dbdj-library", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("tracks", { keyPath: "ref" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async load(): Promise<TrackInfo[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = db.transaction("tracks").objectStore("tracks").getAll();
      r.onsuccess = () => resolve((r.result as TrackInfo[]).map((t) => ({ ...t, unavailableReason: RECONNECT_MESSAGE })));
      r.onerror = () => reject(r.error);
    });
  }
  private async write(fn: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readwrite");
      fn(tx.objectStore("tracks"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  save(tracks: TrackInfo[]): Promise<void> { return this.write((s) => tracks.forEach((t) => s.put(t))); }
  remove(refs: string[]): Promise<void> { return this.write((s) => refs.forEach((r) => s.delete(r))); }
}

export function browserFileRef(f: Pick<File, "name" | "size" | "lastModified">): string {
  return `browser-file:${encodeURIComponent(f.name)}:${f.size}:${f.lastModified}`;
}

export async function coverDataUrl(data: Uint8Array, format: string): Promise<string | undefined> {
  try {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: format }));
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch { return undefined; }
}

/**
 * Microphone takes recorded in Production Studio (arrangement and Sampler) are not files on disk,
 * so their bytes are kept in IndexedDB under their `production-*-recording://` ref and survive restarts.
 */
let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("dbdj-production-recordings", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("takes"); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { db = undefined; reject(r.error); };
  });
}

export const isRecordingRef = (ref: string): boolean => /^production-((sampler-)?recording|vocal|loop):\/\//.test(ref);

export async function saveRecording(ref: string, bytes: ArrayBuffer): Promise<void> {
  const store = await open();
  return new Promise((resolve, reject) => {
    const tx = store.transaction("takes", "readwrite"); tx.objectStore("takes").put(bytes.slice(0), ref);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

export async function loadRecording(ref: string): Promise<ArrayBuffer | null> {
  const store = await open();
  return new Promise((resolve, reject) => {
    const r = store.transaction("takes").objectStore("takes").get(ref);
    r.onsuccess = () => resolve((r.result as ArrayBuffer | undefined) ?? null);
    r.onerror = () => reject(r.error);
  });
}

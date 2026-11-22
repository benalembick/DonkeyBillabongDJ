/**
 * Versioned JSON-document store for Phase 2 preparation data (prepared transitions, user transition
 * presets, blend groups, group journeys). Desktop: one additive SQLite table `setstudio_docs`
 * (kind, id, data); browser / older preloads: localStorage. Writes are serialised (same pattern as SetStore).
 */
import { Emitter } from "../core/events";

/** Also used by Production Studio's Drum Transcriber ("drumtx" transcriptions, "drummap" note-map presets). */
export const DOC_KINDS = ["transition", "preset", "group", "journey", "drumtx", "drummap"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export interface Doc { id: string; updatedAt: number }
export interface DocPersistence {
  list(kind: DocKind): Promise<unknown[]>;
  save(kind: DocKind, doc: Doc): Promise<void>;
  remove(kind: DocKind, id: string): Promise<void>;
}

export class DocStore<T extends Doc> extends Emitter<{ change: T[] }> {
  private docs: T[] = [];
  private writing: Promise<void> = Promise.resolve();
  loaded = false;
  constructor(readonly kind: DocKind, private persist: DocPersistence | null, private validate: (raw: unknown) => T, private onError: (e: unknown) => void = () => undefined) { super(); }
  async load(): Promise<void> {
    try {
      const rows = this.persist ? await this.persist.list(this.kind) : [];
      const docs: T[] = [];
      for (const r of rows) { try { docs.push(this.validate(r)); } catch (e) { this.onError(e); } }
      this.docs = docs.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) { this.onError(e); }
    this.loaded = true;
    this.emit("change", this.docs);
  }
  all(): T[] { return this.docs; }
  get(id: string): T | undefined { return this.docs.find((d) => d.id === id); }
  save(doc: T): T {
    this.docs = [doc, ...this.docs.filter((d) => d.id !== doc.id)];
    const copy = structuredClone(doc);
    this.writing = this.writing.then(() => this.persist?.save(this.kind, copy)).catch(this.onError);
    this.emit("change", this.docs);
    return doc;
  }
  async remove(id: string): Promise<void> {
    this.docs = this.docs.filter((d) => d.id !== id);
    this.emit("change", this.docs);
    this.writing = this.writing.then(() => this.persist?.remove(this.kind, id)).catch(this.onError);
    await this.writing;
  }
  async flush(): Promise<void> { await this.writing; }
}

export class LocalStorageDocs implements DocPersistence {
  constructor(private prefix = "dbdj.setstudio.docs.", private storage: Pick<Storage, "getItem" | "setItem"> | null = (() => { try { return localStorage; } catch { return null; } })()) {}
  private read(kind: DocKind): Record<string, unknown> { try { return JSON.parse(this.storage?.getItem(this.prefix + kind) ?? "{}"); } catch { return {}; } }
  async list(kind: DocKind) { return Object.values(this.read(kind)); }
  async save(kind: DocKind, doc: Doc) { const all = this.read(kind); all[doc.id] = doc; this.storage?.setItem(this.prefix + kind, JSON.stringify(all)); }
  async remove(kind: DocKind, id: string) { const all = this.read(kind); delete all[id]; this.storage?.setItem(this.prefix + kind, JSON.stringify(all)); }
}

/**
 * Desktop store with a localStorage fallback for document kinds the running Electron main process doesn't know yet
 * (a main process started before an update that added the kind). Lists merge both, newest copy of each id wins;
 * removes go to both. Nothing is lost: once main is restarted, saves go to SQLite again.
 */
export function withLocalFallback(primary: DocPersistence, local: DocPersistence): DocPersistence {
  const refused = (e: unknown) => /Invalid document kind/i.test(String(e));
  return {
    async list(kind) {
      const [a, b] = await Promise.all([primary.list(kind).catch((e) => { if (refused(e)) return []; throw e; }), local.list(kind).catch(() => [])]);
      const byId = new Map<string, Doc>();
      for (const d of [...a, ...b] as Doc[]) { const old = byId.get(d.id); if (!old || (d.updatedAt ?? 0) > (old.updatedAt ?? 0)) byId.set(d.id, d); }
      return [...byId.values()];
    },
    async save(kind, doc) { try { await primary.save(kind, doc); } catch (e) { if (!refused(e)) throw e; await local.save(kind, doc); } },
    async remove(kind, id) { await Promise.all([primary.remove(kind, id).catch((e) => { if (!refused(e)) throw e; }), local.remove(kind, id)]); },
  };
}

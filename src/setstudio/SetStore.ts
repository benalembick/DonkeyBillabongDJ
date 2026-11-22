/**
 * Saved sets: one versioned JSON document per set (SQLite `dj_sets` on desktop, localStorage in the
 * browser). Writes are serialised so a delete can't be resurrected by an older pending save.
 */
import { Emitter } from "../core/events";
import { defaultProfile, newId } from "./editor";
import { SET_SCHEMA, type DJSet, type SetPersistence } from "./types";

export interface SetStoreState { sets: DJSet[]; loaded: boolean; /** Documents kept but not loadable (newer schema / corrupt). */ unreadable: number }

/** Upgrades an older/partial document to the current schema; throws for unknown future versions. */
export function migrateSet(raw: unknown): DJSet {
  const r = raw as Partial<DJSet> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string") throw new Error("Not a set document");
  const v = r.schemaVersion ?? 0;
  if (v > SET_SCHEMA) throw new Error(`Set "${r.name}" was saved by a newer version (schema ${v})`);
  const slots = Array.isArray(r.slots) ? r.slots : [];
  return {
    schemaVersion: SET_SCHEMA, id: r.id, name: String(r.name ?? "Untitled set"), mode: r.mode ?? "curve",
    createdAt: Number(r.createdAt) || Date.now(), updatedAt: Number(r.updatedAt) || Date.now(), version: Number(r.version) || 1, parentId: r.parentId ?? null,
    durationTargetSec: Number(r.durationTargetSec) || 3600, energyMin: Number(r.energyMin) || 1, energyMax: Number(r.energyMax) || 10, overlapSec: Number(r.overlapSec ?? 30),
    curveTemplate: r.curveTemplate ?? "freehand", curveControlPoints: Array.isArray(r.curveControlPoints) && r.curveControlPoints.length ? r.curveControlPoints : [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
    slots: slots.map((s, i) => ({ id: s.id ?? newId("slot"), position: i, track: s.track ?? null, targetEnergy: s.targetEnergy ?? null, actualEnergy: s.actualEnergy ?? null, isAnchor: !!s.isAnchor, isLocked: !!s.isLocked, flexible: !!s.flexible, notes: s.notes ?? "" })),
    transitions: Array.isArray(r.transitions) ? r.transitions : [],
    groups: Array.isArray(r.groups) ? r.groups : [],
    profile: { ...defaultProfile(), ...(r.profile ?? {}) },
    ...(r.origin ? { origin: r.origin } : {}),
    ...(Array.isArray(r.groupSections) ? { groupSections: r.groupSections } : {}),
    ...(Array.isArray(r.playlistIds) ? { playlistIds: r.playlistIds } : {}),
    ...(r.preparedTransitions === false ? { preparedTransitions: false } : {}),
  };
}

export class SetStore extends Emitter<{ change: SetStoreState }> {
  private state: SetStoreState = { sets: [], loaded: false, unreadable: 0 };
  private writing: Promise<void> = Promise.resolve();
  constructor(private persist: SetPersistence | null, private onError: (e: unknown) => void = () => undefined) { super(); }

  async load(): Promise<void> {
    if (!this.persist) { this.set({ loaded: true }); return; }
    try {
      const rows = await this.persist.list();
      const sets: DJSet[] = []; let unreadable = 0;
      for (const row of rows) { try { sets.push(migrateSet(row)); } catch (e) { unreadable++; this.onError(e); } }
      this.set({ sets: sets.sort((a, b) => b.updatedAt - a.updatedAt), loaded: true, unreadable });
    } catch (e) { this.onError(e); this.set({ loaded: true }); }
  }
  getState() { return this.state; }
  get(id: string) { return this.state.sets.find((s) => s.id === id); }

  /** Insert or replace. */
  save(set: DJSet): DJSet {
    const others = this.state.sets.filter((s) => s.id !== set.id);
    this.set({ sets: [set, ...others] });
    const copy = structuredClone(set);
    this.writing = this.writing.then(() => this.persist?.save(copy)).catch(this.onError);
    return set;
  }
  rename(id: string, name: string): void { const s = this.get(id); if (s && name.trim()) this.save({ ...s, name: name.trim(), updatedAt: Date.now() }); }
  /** A copy with fresh ids. `asVersion`: lineage (version + 1, parentId) instead of an unrelated copy. */
  duplicate(id: string, asVersion = false): DJSet | undefined {
    const s = this.get(id); if (!s) return undefined;
    const now = Date.now(), copy = structuredClone(s);
    const slotIds = new Map(copy.slots.map((sl) => [sl.id, newId("slot")]));
    const next: DJSet = { ...copy, id: newId("set"), name: asVersion ? `${s.name.replace(/ \(v\d+\)$/, "")} (v${s.version + 1})` : uniqueName(`${s.name} copy`, this.state.sets), createdAt: now, updatedAt: now,
      version: asVersion ? s.version + 1 : 1, parentId: asVersion ? s.id : null,
      slots: copy.slots.map((sl) => ({ ...sl, id: slotIds.get(sl.id)! })),
      transitions: copy.transitions.map((t) => ({ ...t, id: newId("tr"), fromSlotId: slotIds.get(t.fromSlotId) ?? t.fromSlotId, toSlotId: slotIds.get(t.toSlotId) ?? t.toSlotId })),
      groups: copy.groups.map((g) => ({ ...g, id: newId("grp") })), profile: { ...copy.profile, id: newId("rp") },
      groupSections: copy.groupSections?.map((x) => ({ ...x, id: newId("sec") })), playlistIds: [] };
    return this.save(next);
  }
  async remove(id: string): Promise<void> {
    this.set({ sets: this.state.sets.filter((s) => s.id !== id) });
    this.writing = this.writing.then(() => this.persist?.remove(id)).catch(this.onError);
    await this.writing;
  }
  async flush(): Promise<void> { await this.writing; }
  private set(patch: Partial<SetStoreState>) { this.state = { ...this.state, ...patch }; this.emit("change", this.state); }
}

function uniqueName(name: string, sets: DJSet[]): string {
  const names = new Set(sets.map((s) => s.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

/** Browser / old-preload fallback. */
export class LocalStorageSets implements SetPersistence {
  constructor(private key = "dbdj.djsets.v1", private storage: Pick<Storage, "getItem" | "setItem"> | null = (() => { try { return localStorage; } catch { return null; } })()) {}
  private read(): Record<string, unknown> { try { return JSON.parse(this.storage?.getItem(this.key) ?? "{}"); } catch { return {}; } }
  async list() { return Object.values(this.read()); }
  async save(set: DJSet) { const all = this.read(); all[set.id] = set; this.storage?.setItem(this.key, JSON.stringify(all)); }
  async remove(id: string) { const all = this.read(); delete all[id]; this.storage?.setItem(this.key, JSON.stringify(all)); }
}

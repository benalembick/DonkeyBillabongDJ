/**
 * Pure set edit operations and an undo/redo history. Every operation returns a new DJSet; nothing
 * mutates. Positions are renumbered after every structural change.
 */
import { DEFAULT_WEIGHTS, SET_SCHEMA, type CurvePoint, type CurveTemplateId, type DJSet, type DJSetGroup, type DJSetSlot, type RecommendationProfile, type SetMode, type SetTrackRef } from "./types";
import { normalisePoints, templatePoints } from "./curves";

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptySlot(position: number): DJSetSlot {
  return { id: newId("slot"), position, track: null, targetEnergy: null, actualEnergy: null, isAnchor: false, isLocked: false, flexible: false, notes: "" };
}

export function defaultProfile(): RecommendationProfile {
  return { id: newId("rp"), weights: { ...DEFAULT_WEIGHTS }, hardConstraints: {}, energyDirection: "keep", moodPreferences: [], genrePreferences: [], allowDuplicates: false };
}

export const DEFAULT_GROUPS: [string, number, number][] = [["Intro", 1, 4], ["Warm-Up", 3, 6], ["Build", 5, 8], ["Peak", 7.5, 10], ["Closing", 3, 7]];

export interface NewSetInput {
  name: string; mode: SetMode; durationTargetSec: number; energyMin: number; energyMax: number; overlapSec?: number;
  curveTemplate: CurveTemplateId; curveControlPoints?: CurvePoint[]; slotCount: number; groups?: string[];
  /** Anchor mode: tracks placed and locked at these slot indices. */
  anchors?: { index: number; track: SetTrackRef; energy: number | null }[];
}

export function createSet(input: NewSetInput, now = Date.now()): DJSet {
  const slots = Array.from({ length: Math.max(0, input.slotCount) }, (_, i) => emptySlot(i));
  for (const a of input.anchors ?? []) {
    // Two anchors that round to the same slot: the later one takes the nearest free slot.
    let i = Math.max(0, Math.min(slots.length - 1, a.index));
    if (slots[i]?.track) { const free = slots.map((s, k) => (s.track ? null : k)).filter((k): k is number => k !== null).sort((x, y) => Math.abs(x - i) - Math.abs(y - i)); if (free.length) i = free[0]; else { slots.push(emptySlot(slots.length)); i = slots.length - 1; } }
    const s = slots[i];
    if (s) Object.assign(s, { track: a.track, actualEnergy: a.energy, isAnchor: true, isLocked: true });
  }
  const groups: DJSetGroup[] = input.mode === "groups" ? (input.groups ?? DEFAULT_GROUPS.map((g) => g[0])).map((name) => {
    const preset = DEFAULT_GROUPS.find((g) => g[0] === name);
    return { id: newId("grp"), name, energyMin: preset?.[1] ?? input.energyMin, energyMax: preset?.[2] ?? input.energyMax, moodPreferences: [], genrePreferences: [], tracks: [] };
  }) : [];
  return {
    schemaVersion: SET_SCHEMA, id: newId("set"), name: input.name.trim() || "Untitled set", mode: input.mode, createdAt: now, updatedAt: now, version: 1, parentId: null,
    durationTargetSec: input.durationTargetSec, energyMin: input.energyMin, energyMax: input.energyMax, overlapSec: input.overlapSec ?? 30,
    curveTemplate: input.curveTemplate, curveControlPoints: normalisePoints(input.curveControlPoints ?? templatePoints(input.curveTemplate)),
    slots: input.mode === "groups" ? [] : slots, transitions: [], groups, profile: defaultProfile(),
  };
}

const renumber = (slots: DJSetSlot[]) => slots.map((s, i) => (s.position === i ? s : { ...s, position: i }));
const touch = (set: DJSet, patch: Partial<DJSet>): DJSet => ({ ...set, ...patch, updatedAt: Date.now() });
const mapSlot = (set: DJSet, id: string, fn: (s: DJSetSlot) => DJSetSlot) => touch(set, { slots: set.slots.map((s) => (s.id === id ? fn(s) : s)) });

export const ops = {
  addSlot: (set: DJSet, index = set.slots.length) => { const slots = [...set.slots]; slots.splice(Math.max(0, Math.min(slots.length, index)), 0, emptySlot(index)); return touch(set, { slots: renumber(slots) }); },
  removeSlot: (set: DJSet, id: string) => touch(set, { slots: renumber(set.slots.filter((s) => s.id !== id)) }),
  /** `to` is the target index in the list before removal (same convention as PlaylistStore.move). */
  moveSlot: (set: DJSet, from: number, to: number) => {
    if (from < 0 || from >= set.slots.length || from === to) return set;
    const slots = [...set.slots]; const [x] = slots.splice(from, 1); slots.splice(Math.max(0, Math.min(slots.length, to > from ? to - 1 : to)), 0, x);
    return touch(set, { slots: renumber(slots) });
  },
  assign: (set: DJSet, id: string, track: SetTrackRef | null, energy: number | null = null) => mapSlot(set, id, (s) => ({ ...s, track, actualEnergy: track ? energy : null, flexible: track ? false : s.flexible, isLocked: track ? s.isLocked : false, isAnchor: track ? s.isAnchor : false })),
  /** Place a track into the first empty slot after `fromIndex` (or append a slot). */
  place: (set: DJSet, track: SetTrackRef, energy: number | null, fromIndex = 0) => {
    const empty = set.slots.find((s, i) => i >= fromIndex && !s.track && !s.flexible) ?? set.slots.find((s) => !s.track && !s.flexible);
    if (empty) return ops.assign(set, empty.id, track, energy);
    const grown = ops.addSlot(set);
    return ops.assign(grown, grown.slots[grown.slots.length - 1].id, track, energy);
  },
  toggleLock: (set: DJSet, id: string) => mapSlot(set, id, (s) => (s.track ? { ...s, isLocked: !s.isLocked, isAnchor: !s.isLocked } : s)),
  toggleFlexible: (set: DJSet, id: string) => mapSlot(set, id, (s) => ({ ...s, flexible: !s.flexible, track: !s.flexible ? null : s.track, isLocked: false, isAnchor: false })),
  setNotes: (set: DJSet, id: string, notes: string) => mapSlot(set, id, (s) => ({ ...s, notes })),
  setCurve: (set: DJSet, points: CurvePoint[], template: CurveTemplateId = set.curveTemplate) => touch(set, { curveControlPoints: normalisePoints(points), curveTemplate: template }),
  setRange: (set: DJSet, min: number, max: number) => touch(set, { energyMin: Math.max(1, Math.min(min, max)), energyMax: Math.min(10, Math.max(min, max)) }),
  setDuration: (set: DJSet, sec: number) => touch(set, { durationTargetSec: Math.max(300, Math.round(sec)) }),
  rename: (set: DJSet, name: string) => (name.trim() ? touch(set, { name: name.trim() }) : set),
  setProfile: (set: DJSet, patch: Partial<RecommendationProfile>) => touch(set, { profile: { ...set.profile, ...patch } }),
  /** Apply an Auto Fill / resequence proposal: refs aligned with slots. */
  applyRefs: (set: DJSet, refs: (string | null)[], lookup: (ref: string) => { track: SetTrackRef; energy: number | null } | null, keepLocked = true) => touch(set, {
    slots: set.slots.map((s, i) => {
      const r = refs[i];
      if ((keepLocked && s.isLocked) || r === undefined || r === (s.track?.ref ?? null)) return s;
      if (r === null) return s.flexible ? s : { ...s, track: null, actualEnergy: null };
      const hit = lookup(r);
      return hit ? { ...s, track: hit.track, actualEnergy: hit.energy } : s;
    }),
  }),
  addGroup: (set: DJSet, name: string) => touch(set, { groups: [...set.groups, { id: newId("grp"), name: name.trim() || "Group", energyMin: set.energyMin, energyMax: set.energyMax, moodPreferences: [], genrePreferences: [], tracks: [] }] }),
  updateGroup: (set: DJSet, id: string, patch: Partial<DJSetGroup>) => touch(set, { groups: set.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }),
  removeGroup: (set: DJSet, id: string) => touch(set, { groups: set.groups.filter((g) => g.id !== id) }),
  addToGroup: (set: DJSet, id: string, track: SetTrackRef) => touch(set, { groups: set.groups.map((g) => (g.id === id && !g.tracks.some((t) => t.ref === track.ref) ? { ...g, tracks: [...g.tracks, track] } : g)) }),
  addSection: (set: DJSet, groupId: string, start: number, end: number) => touch(set, { groupSections: [...(set.groupSections ?? []), { id: newId("sec"), groupId, start: Math.max(0, Math.min(start, end)), end: Math.min(1, Math.max(start, end)) }] }),
  updateSection: (set: DJSet, id: string, patch: Partial<{ groupId: string; start: number; end: number }>) => touch(set, { groupSections: (set.groupSections ?? []).map((x) => (x.id === id ? { ...x, ...patch, start: Math.max(0, Math.min(1, patch.start ?? x.start)), end: Math.max(0, Math.min(1, patch.end ?? x.end)) } : x)) }),
  removeSection: (set: DJSet, id: string) => touch(set, { groupSections: (set.groupSections ?? []).filter((x) => x.id !== id) }),
  linkGroup: (set: DJSet, localId: string, blendGroupId: string | null) => touch(set, { groups: set.groups.map((g) => (g.id === localId ? (blendGroupId ? { ...g, blendGroupId } : (({ blendGroupId: _b, ...rest }) => rest)(g)) : g)) }),
  removeFromGroup: (set: DJSet, id: string, ref: string) => touch(set, { groups: set.groups.map((g) => (g.id === id ? { ...g, tracks: g.tracks.filter((t) => t.ref !== ref) } : g)) }),
};

/** Undo/redo over immutable snapshots (bounded). */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(public current: T, private limit = 100) {}
  push(next: T): T { if (next === this.current) return next; this.past.push(this.current); if (this.past.length > this.limit) this.past.shift(); this.future = []; this.current = next; return next; }
  /** Replace without an undo step (e.g. derived values like targets/transitions, or mid-gesture). */
  replace(next: T): T { this.current = next; return next; }
  /** End of a continuous gesture: one undo step back to `start`. */
  commitFrom(start: T): void { if (start === this.current) return; this.past.push(start); if (this.past.length > this.limit) this.past.shift(); this.future = []; }
  undo(): T | null { const p = this.past.pop(); if (p === undefined) return null; this.future.push(this.current); this.current = p; return p; }
  redo(): T | null { const f = this.future.pop(); if (f === undefined) return null; this.past.push(this.current); this.current = f; return f; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

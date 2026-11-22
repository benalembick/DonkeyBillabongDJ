/**
 * Whole-sequence optimisation (pure, deterministic): beam search over the slot list.
 *
 * Objective = Σ pair compatibility of adjacent tracks + Σ energy fit to each slot's target
 * − a penalty when the planned duration is overshot/undershot. Filled slots (locked anchors and any
 * other placed track) are fixed; flexible slots stay empty; tracks are used at most once unless
 * duplicates are allowed. Ties break on the track ref so results are reproducible.
 */
import { hardOk } from "./autofillHelpers";
import { pairCompat } from "./scoring";
import type { HardConstraints, SetTrack } from "./types";

export interface FillSlot { ref: string | null; targetEnergy: number | null; flexible?: boolean }
export interface FillOptions {
  beamWidth?: number;
  /** Candidates considered per empty slot after the energy pre-filter. */
  perSlot?: number;
  allowDuplicates?: boolean;
  targetDurationSec?: number;
  overlapSec?: number;
  hard?: HardConstraints;
  /** Treat each path as its own track (resequencing keeps every slot entry, even same-audio copies). */
  byPath?: boolean;
  /** Per-slot candidate pool (e.g. a group section). null = the whole library. */
  poolFor?: (slotIndex: number) => SetTrack[] | null;
  /** Weight of energy fit relative to pair compatibility (default 1). */
  energyWeight?: number;
}
export interface FillResult { refs: (string | null)[]; filled: number; score: number; durationSec: number; unfilled: number }

/** Same audio content = same track, even when the file exists under several paths. */
export const identity = (t: SetTrack | null | undefined, ref: string) => t?.trackId ?? ref;
/** One entry per audio content (first available copy wins). */
export function uniqueByContent(pool: SetTrack[]): SetTrack[] {
  const seen = new Set<string>(), out: SetTrack[] = [];
  for (const t of pool) { const k = identity(t, t.ref); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

const energyFit = (t: SetTrack, target: number | null) => (target === null || t.energy === null ? 0.5 : Math.max(0, 1 - Math.abs(t.energy - target) / 4));

interface Beam { refs: (string | null)[]; used: Set<string>; score: number; seconds: number; last: SetTrack | null }

function search(slots: FillSlot[], byRef: Map<string, SetTrack>, candidatesFor: (i: number) => SetTrack[], o: FillOptions): FillResult {
  const width = o.beamWidth ?? 16, ew = o.energyWeight ?? 1, overlap = o.overlapSec ?? 30;
  const key = o.byPath ? (_t: SetTrack | null | undefined, ref: string) => ref : identity;
  // Tracks already placed anywhere in the set (e.g. a locked anchor later on) are taken from the start.
  // Identity is the audio content, so the same file saved under several names counts once.
  const placed = new Set(o.allowDuplicates ? [] : slots.map((s) => (s.ref ? key(byRef.get(s.ref), s.ref) : null)).filter((r): r is string => !!r));
  let beams: Beam[] = [{ refs: [], used: placed, score: 0, seconds: 0, last: null }];
  const fixedNext = (i: number) => { const s = slots[i + 1]; return s?.ref ? byRef.get(s.ref) ?? null : null; };
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i], next: Beam[] = [];
    const fixed = slot.ref ? byRef.get(slot.ref) ?? null : null;
    if (slot.ref || slot.flexible) {
      for (const b of beams) {
        const s = b.last && fixed ? pairCompat(b.last, fixed) : 0;
        next.push({ refs: [...b.refs, slot.ref], used: slot.ref ? new Set(b.used).add(key(fixed, slot.ref)) : b.used, score: b.score + s + (fixed ? energyFit(fixed, slot.targetEnergy) * ew : 0), seconds: b.seconds + (fixed?.durationSec ? Math.max(30, fixed.durationSec - overlap) : 0), last: slot.flexible && !fixed ? null : fixed ?? b.last });
      }
    } else {
      const cands = candidatesFor(i), after = fixedNext(i);
      for (const b of beams) {
        let any = false;
        for (const c of cands) {
          if (!o.allowDuplicates && b.used.has(key(c, c.ref))) continue;
          if (b.last && !hardOk(b.last, c, o.hard)) continue;
          any = true;
          const s = (b.last ? pairCompat(b.last, c) : 0) + (after ? pairCompat(c, after) : 0) + energyFit(c, slot.targetEnergy) * ew;
          next.push({ refs: [...b.refs, c.ref], used: new Set(b.used).add(key(c, c.ref)), score: b.score + s, seconds: b.seconds + Math.max(30, (c.durationSec ?? 300) - overlap), last: c });
        }
        if (!any) next.push({ ...b, refs: [...b.refs, null], last: b.last });
      }
    }
    next.sort((x, y) => y.score - x.score || x.refs.join("|").localeCompare(y.refs.join("|")));
    beams = next.slice(0, width);
  }
  // Duration: prefer the plan closest to the target among the surviving beams.
  const penalty = (b: Beam) => (o.targetDurationSec ? Math.abs(b.seconds - o.targetDurationSec) / Math.max(600, o.targetDurationSec) * 2 : 0);
  const best = [...beams].sort((x, y) => (y.score - penalty(y)) - (x.score - penalty(x)) || x.refs.join("|").localeCompare(y.refs.join("|")))[0];
  const originallyEmpty = slots.filter((s) => !s.ref && !s.flexible).length;
  const filled = best.refs.filter((r, i) => r && !slots[i].ref).length;
  return { refs: best.refs, filled, score: Math.round(best.score * 100) / 100, durationSec: Math.round(best.seconds), unfilled: originallyEmpty - filled };
}

/** Fill every empty, non-flexible slot. Filled slots never move. */
export function autoFill(slots: FillSlot[], pool: SetTrack[], o: FillOptions = {}): FillResult {
  const byRef = new Map(pool.map((t) => [t.ref, t]));
  for (let i = 0; i < slots.length; i++) for (const t of o.poolFor?.(i) ?? []) if (!byRef.has(t.ref)) byRef.set(t.ref, t);
  const per = o.perSlot ?? 40;
  const usable = uniqueByContent(pool.filter((t) => t.available && hardOk(null, t, o.hard)));
  const cache = new Map<string, SetTrack[]>();
  const poolIds = new Map<SetTrack[], number>();
  const candidatesFor = (i: number) => {
    const own = o.poolFor?.(i) ?? null;
    if (own && !poolIds.has(own)) poolIds.set(own, poolIds.size + 1);
    const target = slots[i].targetEnergy, key = `${target}|${own ? poolIds.get(own) : 0}`;
    let c = cache.get(key);
    if (!c) { c = [...(own ? uniqueByContent(own.filter((t) => t.available && hardOk(null, t, o.hard))) : usable)].sort((a, b) => energyFit(b, target) - energyFit(a, target) || a.ref.localeCompare(b.ref)).slice(0, per); cache.set(key, c); }
    return c;
  };
  return search(slots, byRef, candidatesFor, o);
}

/**
 * Reorder the tracks in unlocked slots (Improve a Set). Locked slots keep their position; every
 * unlocked track is used exactly once.
 */
export function resequence(slots: (FillSlot & { locked: boolean })[], pool: SetTrack[], o: FillOptions = {}): FillResult {
  const byRef = new Map(pool.map((t) => [t.ref, t]));
  const movable = slots.filter((s) => !s.locked && s.ref).map((s) => byRef.get(s.ref!)).filter((t): t is SetTrack => !!t);
  const plan: FillSlot[] = slots.map((s) => (s.locked || !s.ref ? { ref: s.ref, targetEnergy: s.targetEnergy, flexible: !s.ref } : { ref: null, targetEnergy: s.targetEnergy }));
  const result = search(plan, byRef, () => movable, { ...o, allowDuplicates: false, byPath: true, hard: undefined, beamWidth: o.beamWidth ?? 24 });
  return result;
}

/** Objective value of an existing order (for before/after comparison). */
export function sequenceScore(tracks: (SetTrack | null)[], targets: (number | null)[]): { pairMean: number | null; energyMean: number | null } {
  const pairs: number[] = [], fits: number[] = [];
  tracks.forEach((t, i) => { if (t) fits.push(energyFit(t, targets[i] ?? null)); const n = tracks[i + 1]; if (t && n) pairs.push(pairCompat(t, n)); });
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
  return { pairMean: avg(pairs), energyMean: avg(fits) };
}

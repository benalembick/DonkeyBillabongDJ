/**
 * Blend Steering Groups — reusable, persistent pools of tracks (Phase 2). They extend Phase 1's set
 * groups rather than competing with them: a set's group can link to a reusable group (its tracks then
 * come from the group), and curve sets can assign groups to sections of the energy curve.
 *
 * Every suggestion goes through the Phase 1 scorer (scoreCandidate / rankCandidates); compatibility
 * stays pair-specific — group statistics never claim every member mixes into every other.
 */
import { Emitter } from "../core/events";
import { resequence } from "./autofill";
import type { DocStore } from "./DocStore";
import { newId } from "./editor";
import { evaluateTransition, isExcluded, rankCandidates, scoreCandidate, type CandidateScore } from "./scoring";
import type { NextMove, SetTrack, SetTrackRef } from "./types";

export type OrderingMode = "flexible" | "ordered" | "suggested";
export interface BlendGroupTrack { ref: SetTrackRef; position: number; isAnchor: boolean; notes: string }
export interface BlendGroup {
  schemaVersion: 1; id: string; name: string; description: string; colour: string;
  energyMin: number; energyMax: number; bpmMin: number | null; bpmMax: number | null;
  keys: string[]; genres: string[]; subgenres: string[]; moods: string[]; vocal: "any" | "vocal" | "instrumental";
  orderingMode: OrderingMode; locked: boolean; tracks: BlendGroupTrack[]; createdAt: number; updatedAt: number;
}
export interface GroupJourney { schemaVersion: 1; id: string; name: string; groupIds: string[]; createdAt: number; updatedAt: number }

export const GROUP_COLOURS = ["#38c8ff", "#8b6cff", "#ff4fb8", "#ff8a3d", "#ffd23f", "#30d158", "#14b8a6", "#ff3b30"];
export const GROUP_TEMPLATES: [string, number, number][] = [["Warm-Up", 2, 5], ["Vocal House", 5, 7], ["Disco Groove", 4.5, 7], ["Peak Time", 7.5, 10], ["Dark Underground", 6, 8.5], ["Closing Tracks", 3, 6.5], ["Melodic Build", 5, 8], ["High-Energy DnB", 8, 10], ["UK Garage Grooves", 5.5, 8]];

export function migrateGroup(raw: unknown): BlendGroup {
  const r = raw as Partial<BlendGroup> | null;
  if (!r || typeof r.id !== "string" || !Array.isArray(r.tracks)) throw new Error("Not a blend group");
  return { schemaVersion: 1, id: r.id, name: String(r.name ?? "Group"), description: r.description ?? "", colour: r.colour ?? GROUP_COLOURS[0], energyMin: Number(r.energyMin ?? 1), energyMax: Number(r.energyMax ?? 10),
    bpmMin: r.bpmMin ?? null, bpmMax: r.bpmMax ?? null, keys: r.keys ?? [], genres: r.genres ?? [], subgenres: r.subgenres ?? [], moods: r.moods ?? [], vocal: r.vocal ?? "any",
    orderingMode: r.orderingMode ?? "flexible", locked: !!r.locked, tracks: r.tracks.map((t, i) => ({ ref: t.ref, position: i, isAnchor: !!t.isAnchor, notes: t.notes ?? "" })), createdAt: Number(r.createdAt) || Date.now(), updatedAt: Number(r.updatedAt) || Date.now() };
}
export function migrateJourney(raw: unknown): GroupJourney {
  const r = raw as Partial<GroupJourney> | null;
  if (!r || typeof r.id !== "string" || !Array.isArray(r.groupIds)) throw new Error("Not a journey");
  return { schemaVersion: 1, id: r.id, name: String(r.name ?? "Journey"), groupIds: r.groupIds.map(String), createdAt: Number(r.createdAt) || Date.now(), updatedAt: Number(r.updatedAt) || Date.now() };
}

/** Why a track doesn't meet a group's constraints (empty = it does). Unknown values never pass a set constraint. */
export function constraintMisses(g: BlendGroup, t: SetTrack): string[] {
  const m: string[] = [];
  if (t.energy === null || t.energy < g.energyMin || t.energy > g.energyMax) m.push(t.energy === null ? "energy unknown" : `energy ${t.energy.toFixed(1)} outside ${g.energyMin}–${g.energyMax}`);
  if (g.bpmMin != null && (!t.bpm || t.bpm < g.bpmMin)) m.push(`BPM below ${g.bpmMin}`);
  if (g.bpmMax != null && (!t.bpm || t.bpm > g.bpmMax)) m.push(`BPM above ${g.bpmMax}`);
  if (g.keys.length && (!t.camelot || !g.keys.includes(t.camelot))) m.push("key not in the group's keys");
  const gl = (s: string | null) => (s ?? "").toLowerCase();
  if (g.genres.length && !g.genres.some((x) => gl(t.genre).includes(x.toLowerCase()) || gl(t.subgenre).includes(x.toLowerCase()))) m.push("genre not in the group's genres");
  if (g.subgenres.length && !g.subgenres.some((x) => gl(t.subgenre).includes(x.toLowerCase()))) m.push("sub-genre not in the group's sub-genres");
  if (g.moods.length && !g.moods.some((x) => t.moods.includes(x))) m.push("none of the group's moods");
  if (g.vocal !== "any" && (t.vocalPresence === null || (g.vocal === "vocal" ? t.vocalPresence < 0.2 : t.vocalPresence >= 0.2))) m.push(t.vocalPresence === null ? "vocal content unknown" : g.vocal === "vocal" ? "mostly instrumental" : "has vocals");
  return m;
}

export interface GroupStats {
  count: number; energy: [number, number] | null; bpmBuckets: { from: number; n: number }[]; keys: { key: string; n: number }[]; moods: { mood: string; n: number }[];
  /** Pair-specific: share of member pairs (both directions) by transition state. */
  pairs: { green: number; amber: number; red: number; total: number; sampled: boolean };
  outsideConstraints: number; missing: number;
}
export function groupStats(g: BlendGroup, members: (SetTrack | null)[]): GroupStats {
  const ts = members.filter((t): t is SetTrack => !!t);
  const e = ts.map((t) => t.energy).filter((x): x is number => x !== null);
  const bpm = new Map<number, number>(), keys = new Map<string, number>(), moods = new Map<string, number>();
  for (const t of ts) {
    if (t.bpm) { const b = Math.floor(t.bpm / 5) * 5; bpm.set(b, (bpm.get(b) ?? 0) + 1); }
    if (t.camelot) keys.set(t.camelot, (keys.get(t.camelot) ?? 0) + 1);
    for (const m of t.moods) moods.set(m, (moods.get(m) ?? 0) + 1);
  }
  const sample = ts.slice(0, 40), pairs = { green: 0, amber: 0, red: 0, total: 0, sampled: ts.length > 40 };
  for (const a of sample) for (const b of sample) { if (a === b) continue; const s = evaluateTransition(a, b).state; pairs[s]++; pairs.total++; }
  const sortN = <T extends { n: number }>(x: T[]) => x.sort((p, q) => q.n - p.n);
  return { count: ts.length, energy: e.length ? [Math.min(...e), Math.max(...e)] : null, bpmBuckets: [...bpm].map(([from, n]) => ({ from, n })).sort((a, b) => a.from - b.from),
    keys: sortN([...keys].map(([key, n]) => ({ key, n }))), moods: sortN([...moods].map(([mood, n]) => ({ mood, n }))), pairs, outsideConstraints: ts.filter((t) => constraintMisses(g, t).length).length, missing: members.length - ts.length };
}

export type SuggestAction = "similar" | "expand" | "lower" | "higher" | "bridges" | "forgotten";
export const SUGGEST_ACTIONS: { id: SuggestAction; label: string; hint: string }[] = [
  { id: "similar", label: "Find Similar Tracks", hint: "Close to the selected seed tracks (or the whole group)" },
  { id: "expand", label: "Expand Group", hint: "Tracks that meet the group's constraints and mood/genre preferences" },
  { id: "lower", label: "Lower-Energy Alternatives", hint: "Compatible tracks a step lower in energy" },
  { id: "higher", label: "Higher-Energy Alternatives", hint: "Compatible tracks a step higher in energy" },
  { id: "bridges", label: "Genre Bridges", hint: "Compatible tracks from a different genre, to move between styles" },
  { id: "forgotten", label: "Find Forgotten Tracks", hint: "Compatible tracks not used in any set or group and not recently played" },
];

interface Deps {
  groups: DocStore<BlendGroup>;
  journeys: DocStore<GroupJourney>;
  pool: () => SetTrack[];
  resolve: (r: SetTrackRef) => SetTrack | null;
  toRef: (t: SetTrack) => SetTrackRef;
  /** Refs used in any saved set (for "forgotten"). */
  usedInSets: () => Set<string>;
  recentlyPlayed: () => Set<string>;
  /** A group was deleted — sets drop their links/sections to it. */
  onDeleted?: (groupId: string) => void;
}

export class BlendGroupService extends Emitter<{ change: void }> {
  constructor(private d: Deps) { super(); d.groups.on("change", () => this.emit("change", undefined)); d.journeys.on("change", () => this.emit("change", undefined)); }
  all(): BlendGroup[] { return this.d.groups.all(); }
  get(id: string) { return this.d.groups.get(id); }
  journeys(): GroupJourney[] { return this.d.journeys.all(); }
  members(g: BlendGroup): (SetTrack | null)[] { return [...g.tracks].sort((a, b) => a.position - b.position).map((t) => this.d.resolve(t.ref)); }
  stats(id: string): GroupStats | null { const g = this.get(id); return g ? groupStats(g, this.members(g)) : null; }

  private save(g: BlendGroup): BlendGroup { return this.d.groups.save({ ...g, tracks: g.tracks.map((t, i) => ({ ...t, position: i })), updatedAt: Date.now() }); }
  create(name: string, patch: Partial<BlendGroup> = {}): BlendGroup {
    const now = Date.now(), tpl = GROUP_TEMPLATES.find((t) => t[0] === name.trim());
    return this.save({ schemaVersion: 1, id: newId("grp"), name: name.trim() || "New group", description: "", colour: GROUP_COLOURS[this.all().length % GROUP_COLOURS.length], energyMin: tpl?.[1] ?? 1, energyMax: tpl?.[2] ?? 10,
      bpmMin: null, bpmMax: null, keys: [], genres: [], subgenres: [], moods: [], vocal: "any", orderingMode: "flexible", locked: false, tracks: [], createdAt: now, updatedAt: now, ...patch });
  }
  update(id: string, patch: Partial<BlendGroup>): BlendGroup | null { const g = this.get(id); return g ? this.save({ ...g, ...patch, id: g.id }) : null; }
  duplicate(id: string): BlendGroup | null { const g = this.get(id); return g ? this.save({ ...structuredClone(g), id: newId("grp"), name: `${g.name} copy`, locked: false, createdAt: Date.now() }) : null; }
  /** Deletes the group only — never tracks, files or library records. */
  async remove(id: string): Promise<void> { await this.d.groups.remove(id); for (const j of this.journeys()) if (j.groupIds.includes(id)) this.d.journeys.save({ ...j, groupIds: j.groupIds.filter((x) => x !== id), updatedAt: Date.now() }); this.d.onDeleted?.(id); }

  /** Membership edits respect the lock. Returns how many were added (duplicates by path or audio content are skipped). */
  addTracks(id: string, tracks: SetTrack[]): number {
    const g = this.get(id); if (!g || g.locked) return 0;
    const have = new Set(g.tracks.flatMap((t) => [t.ref.ref, t.ref.trackId].filter(Boolean) as string[]));
    const fresh: SetTrack[] = [];
    for (const t of tracks) { if (have.has(t.ref) || (t.trackId && have.has(t.trackId))) continue; have.add(t.ref); if (t.trackId) have.add(t.trackId); fresh.push(t); }
    if (fresh.length) this.save({ ...g, tracks: [...g.tracks, ...fresh.map((t) => ({ ref: this.d.toRef(t), position: 0, isAnchor: false, notes: "" }))] });
    return fresh.length;
  }
  removeTrack(id: string, ref: string): boolean { const g = this.get(id); if (!g || g.locked) return false; this.save({ ...g, tracks: g.tracks.filter((t) => t.ref.ref !== ref) }); return true; }
  moveTrack(id: string, from: number, to: number): void {
    const g = this.get(id); if (!g) return;
    const ts = [...g.tracks].sort((a, b) => a.position - b.position); const [x] = ts.splice(from, 1); if (!x) return; ts.splice(Math.max(0, Math.min(ts.length, to)), 0, x);
    this.save({ ...g, tracks: ts });
  }
  setTrack(id: string, ref: string, patch: Partial<Pick<BlendGroupTrack, "isAnchor" | "notes">>): void { const g = this.get(id); if (g) this.save({ ...g, tracks: g.tracks.map((t) => (t.ref.ref === ref ? { ...t, ...patch } : t)) }); }
  /** A sequence the system recommends (energy rising through the group's range); applied only on request. */
  suggestedOrder(id: string): string[] {
    const g = this.get(id); if (!g) return [];
    const ms = this.members(g).filter((t): t is SetTrack => !!t);
    const n = ms.length; if (n < 2) return ms.map((t) => t.ref);
    const slots = ms.map((t, i) => ({ ref: t.ref, locked: false, targetEnergy: g.energyMin + ((g.energyMax - g.energyMin) * i) / (n - 1) }));
    return resequence(slots, ms).refs.filter((r): r is string => !!r);
  }
  applyOrder(id: string, refs: string[]): void { const g = this.get(id); if (!g) return; const by = new Map(g.tracks.map((t) => [t.ref.ref, t])); this.save({ ...g, orderingMode: "ordered", tracks: [...refs.map((r) => by.get(r)).filter((t): t is BlendGroupTrack => !!t), ...g.tracks.filter((t) => !refs.includes(t.ref.ref))] }); }

  private excludeSet(g: BlendGroup): Set<string> { return new Set(g.tracks.flatMap((t) => [t.ref.ref, t.ref.trackId].filter(Boolean) as string[])); }
  /** Library suggestions for a group via the Phase 1 scorer. Seeds default to the group's anchors, else all members. */
  suggest(id: string, action: SuggestAction, seedRefs: string[] = [], move?: NextMove, limit = 30): CandidateScore[] {
    const g = this.get(id); if (!g) return [];
    const members = this.members(g).filter((t): t is SetTrack => !!t);
    const anchors = members.filter((t) => g.tracks.find((x) => x.ref.ref === t.ref)?.isAnchor);
    const seeds = (seedRefs.length ? members.filter((t) => seedRefs.includes(t.ref)) : anchors.length ? anchors : members).slice(0, 12);
    const exclude = this.excludeSet(g), mid = (g.energyMin + g.energyMax) / 2;
    let pool = this.d.pool().filter((t) => t.available && !exclude.has(t.ref) && !(t.trackId && exclude.has(t.trackId)));
    if (action === "expand") return rankCandidates(pool.filter((t) => !constraintMisses(g, t).length), { targetEnergy: mid, move: move ?? "keep", moodPreferences: g.moods, genrePreferences: g.genres }, limit).ranked;
    if (action === "bridges") { const gs = new Set(seeds.map((s) => (s.genre ?? "").toLowerCase())); pool = pool.filter((t) => t.genre && !gs.has(t.genre.toLowerCase())); }
    if (action === "forgotten") { const used = this.d.usedInSets(), played = this.d.recentlyPlayed(), inGroups = new Set(this.all().flatMap((x) => x.tracks.map((t) => t.ref.ref))); pool = pool.filter((t) => !used.has(t.ref) && !played.has(t.ref) && !inGroups.has(t.ref)); }
    const m: NextMove = action === "lower" ? "cool" : action === "higher" ? "lift" : move ?? "keep";
    if (!seeds.length) return rankCandidates(pool, { targetEnergy: mid, move: m, moodPreferences: g.moods, genrePreferences: g.genres }, limit).ranked;
    // Average the same scorer over every seed (each seed as the previous track).
    const acc = new Map<string, { s: CandidateScore; sum: number; n: number }>();
    for (const seed of seeds) for (const t of pool) {
      const r = scoreCandidate(t, { prev: seed, targetEnergy: seed.energy, move: m, moodPreferences: g.moods, genrePreferences: g.genres });
      if (isExcluded(r)) continue;
      const a = acc.get(t.ref); if (a) { a.sum += r.score; a.n++; if (r.score > a.s.score) a.s = r; } else acc.set(t.ref, { s: r, sum: r.score, n: 1 });
    }
    const out = [...acc.values()].map(({ s, sum, n }) => { const score = Math.round(sum / n); return { ...s, score, explanation: seeds.length > 1 ? `${score}% average fit to ${seeds.length} seed tracks — ${s.explanation.replace(/^\d+% match — /, "best: ")}` : s.explanation }; });
    if (action === "forgotten") out.forEach((s) => (s.explanation += " Not used in any set or group yet."));
    const seen = new Set<string>();
    return out.sort((a, b) => b.score - a.score || a.track.ref.localeCompare(b.track.ref)).filter((s) => { const k = s.track.trackId ?? s.track.ref; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
  }

  /** Steering into a destination group from the current track: its members first, scored with the current track as the previous one. */
  steerInto(currentRef: string, destId: string, move: NextMove = "keep", limit = 20): CandidateScore[] {
    const g = this.get(destId), cur = this.d.pool().find((t) => t.ref === currentRef);
    if (!g || !cur) return [];
    const members = this.members(g).filter((t): t is SetTrack => !!t && t.ref !== currentRef);
    return rankCandidates(members, { prev: cur, targetEnergy: (g.energyMin + g.energyMax) / 2, move, moodPreferences: g.moods, genrePreferences: g.genres }, limit).ranked;
  }

  /** Bridge tracks between two groups: outside both, scored against the first group's exit and the second's entry. */
  bridges(fromId: string, toId: string, limit = 12): CandidateScore[] {
    const a = this.get(fromId), b = this.get(toId); if (!a || !b) return [];
    const ma = this.members(a).filter((t): t is SetTrack => !!t), mb = this.members(b).filter((t): t is SetTrack => !!t);
    if (!ma.length || !mb.length) return [];
    const up = (b.energyMin + b.energyMax) >= (a.energyMin + a.energyMax);
    const pick = (ms: SetTrack[], g: BlendGroup, high: boolean) => ms.find((t) => g.tracks.find((x) => x.ref.ref === t.ref)?.isAnchor) ?? [...ms].sort((x, y) => ((high ? -1 : 1) * ((x.energy ?? 0) - (y.energy ?? 0))))[0];
    const exit = pick(ma, a, up), entry = pick(mb, b, !up);
    const ex = new Set([...this.excludeSet(a), ...this.excludeSet(b)]);
    return rankCandidates(this.d.pool().filter((t) => t.available && !ex.has(t.ref) && !(t.trackId && ex.has(t.trackId))), { prev: exit, next: entry, targetEnergy: ((exit.energy ?? 5) + (entry.energy ?? 5)) / 2, move: up ? "lift" : "cool" }, limit).ranked;
  }

  // ── Journeys (ordered movement between groups) ──
  saveJourney(j: Omit<GroupJourney, "schemaVersion" | "createdAt" | "updatedAt"> & { createdAt?: number }): GroupJourney { const now = Date.now(); return this.d.journeys.save({ schemaVersion: 1, createdAt: j.createdAt ?? now, updatedAt: now, ...j }); }
  async removeJourney(id: string): Promise<void> { await this.d.journeys.remove(id); }
  energyJourney(j: GroupJourney): { group: BlendGroup; min: number; max: number; mid: number }[] { return j.groupIds.map((id) => this.get(id)).filter((g): g is BlendGroup => !!g).map((group) => ({ group, min: group.energyMin, max: group.energyMax, mid: (group.energyMin + group.energyMax) / 2 })); }
}

/**
 * AI Set Studio façade. Builds scorer profiles from the library + preparation records, owns the open
 * set's edit history and autosave, and connects sets to the existing playlists, decks, headphone
 * preview and Auto DJ. It contains no playback or analysis of its own.
 */
import { Emitter } from "../core/events";
import type { TrackInfo } from "../core/engine/types";
import { camelotKey } from "../analysis/discovery";
import { effectiveEnergy, type PreparationStore } from "../preparation/PreparationStore";
import type { PlaylistStore, Playlist } from "../library/PlaylistStore";
import { autoFill, resequence, type FillResult } from "./autofill";
import { curveFromEnergies, estimateTrackCount, slotTargets, slotTimeline } from "./curves";
import { createSet, History, ops, type NewSetInput } from "./editor";
import { fromNative, safeFileName, toM3U8, toNative } from "./exporters";
import { splitGenre } from "./features";
import type { LibraryIntelligence } from "./LibraryIntelligence";
import { evaluateTransition, rankCandidates, type CandidateScore, type ScoreContext, type TransitionEval } from "./scoring";
import type { SetStore } from "./SetStore";
import { newId } from "./editor";
import type { DJSet, DJSetGroup, DJSetSlot, DJSetTransition, GroupSection, NextMove, SetTrack, SetTrackRef } from "./types";
import { constraintMisses, type BlendGroupService } from "./BlendGroups";

export type ResolveStatus = "ok" | "moved" | "missing";
export interface SlotView { slot: DJSetSlot; index: number; track: SetTrack | null; status: ResolveStatus | "empty"; suggestion: SetTrack | null; target: number | null; start: number; end: number }
export interface SetView { set: DJSet; slots: SlotView[]; transitions: (TransitionEval | null)[]; totalSec: number; summary: SetSummary }
export interface SetSummary { tracks: number; empty: number; missing: number; unanalysed: number; red: number; amber: number; durationSec: number; label: string; ready: boolean }
export interface StudioState { openId: string | null; revision: number; canUndo: boolean; canRedo: boolean; message: string; /** What Set Studio is currently letting you hear (headphones, or a deck when there are no headphones). */ audition?: { ref: string; at: number; where: "headphones" | "deck"; deck?: number } | null }

interface Deps {
  library: { getState(): { tracks: TrackInfo[] }; getByRef(ref: string): TrackInfo | null; on(e: "change", cb: () => void): () => void };
  preparation: Pick<PreparationStore, "forRef" | "get" | "on">;
  playlists: Pick<PlaylistStore, "get" | "create" | "setOrderedRefs" | "getState">;
  store: SetStore;
  intel: LibraryIntelligence;
  engine?: { loadTrack(deck: number, t: TrackInfo, source?: "manual" | "auto-dj"): Promise<void>; seekTo?(deck: number, s: number): void; getState?(): { decks: { playing: boolean; track: TrackInfo | null; status: string; hotcues?: (number | null)[] }[]; mixer?: { crossfader: number; channels: { volume: number; mute: boolean }[] } } };
  /** Start/stop a deck (only used for auditions when there is no headphone output). */
  play?: (deck: number, on: boolean) => void;
  /** Send a command-bus action (deck hot cue press/release for hold-to-play). */
  send?: (action: string, value: number) => void;
  autoDJ?: { getState(): { status: string; played: string[] }; start(playlistId: string): Promise<void>; playNextRefs(refs: string[]): void; add(refs: string[]): void };
  preview?: { toggle(t: TrackInfo, offset?: number): Promise<void>; stop?(): void; state: { ref: string | null; status: string; available: boolean } };
  saveText?: (name: string, text: string, ext: string) => Promise<boolean>;
  pickText?: () => Promise<{ name: string; text: string } | null>;
  log?: { info(s: string, m: string): void; warn(s: string, m: string): void };
  appVersion?: string;
}

const FALLBACK_SEC = 330;

export class SetStudioService extends Emitter<{ change: StudioState }> {
  private profiles: Map<string, SetTrack> | null = null;
  private history: History<DJSet> | null = null;
  private state: StudioState = { openId: null, revision: 0, canUndo: false, canRedo: false, message: "" };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private viewCache: { set: DJSet; revision: number; view: SetView } | null = null;
  private rejected = new Map<string, Set<string>>();

  constructor(private d: Deps) {
    super();
    const bump = () => { this.profiles = null; this.set({ revision: this.state.revision + 1 }); };
    let pending = false;
    const soon = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; bump(); }); };
    d.library.on("change", soon);
    d.preparation.on("record", soon);
    d.store.on("change", () => this.set({ revision: this.state.revision + 1 }));
  }
  getState() { return this.state; }
  private set(patch: Partial<StudioState>) { this.state = { ...this.state, ...patch }; this.emit("change", this.state); }
  private say(message: string, level: "info" | "warn" = "info") { this.set({ message }); this.d.log?.[level]("setstudio", message); }

  // ── Profiles ───────────────────────────────────────────────────────────────
  private build(t: TrackInfo): SetTrack {
    const r = this.d.preparation.forRef(t.ref), intel = r?.intel, ov = r?.setOverrides, g = splitGenre(t.genre);
    const energy = r ? effectiveEnergy(r) : t.energy ?? null;
    const intro = r?.sections.find((s) => s.kind === "intro"), outro = r ? [...r.sections].reverse().find((s) => s.kind === "outro") : undefined;
    const key = r?.key ?? t.key;
    return {
      ref: t.ref, trackId: r?.trackId ?? t.trackId ?? null, title: t.title, artist: t.artist, artworkUrl: t.artworkUrl,
      durationSec: r?.duration || (t.durationMs ? t.durationMs / 1000 : null), bpm: r?.beatGrid?.bpm ?? r?.bpm ?? t.bpm, key, camelot: camelotKey(key),
      energy, energySource: ov?.energy !== undefined ? "override" : intel?.energy != null ? "intel" : energy !== null ? "legacy" : null,
      genre: ov?.genre ?? g.genre, subgenre: ov?.subgenre ?? g.subgenre, moods: ov?.moods ?? intel?.moods ?? [],
      brightness: intel?.brightness ?? null, bassIntensity: intel?.bassIntensity ?? null, vocalPresence: intel?.vocalPresence ?? null, danceability: intel?.danceability ?? null,
      introSec: intel?.introSec ?? (intro ? intro.end - intro.start : null), outroSec: intel?.outroSec ?? (outro ? outro.end - outro.start : null),
      analysed: r?.analysisVersion != null, available: !t.unavailableReason, addedAt: t.addedAt, rating: t.rating,
    };
  }
  private map(): Map<string, SetTrack> {
    if (!this.profiles) this.profiles = new Map(this.d.library.getState().tracks.filter((t) => t.source === "local").map((t) => [t.ref, this.build(t)]));
    return this.profiles;
  }
  pool(): SetTrack[] { return [...this.map().values()]; }
  profile(ref: string): SetTrack | null { return this.map().get(ref) ?? null; }
  toRef(t: SetTrack): SetTrackRef { return { trackId: t.trackId, ref: t.ref, title: t.title, artist: t.artist, durationSec: t.durationSec }; }

  /** Path first; then any library path with the same audio content (moved/renamed); else missing + a title match suggestion. */
  resolve(s: SetTrackRef): { track: SetTrack | null; status: ResolveStatus; suggestion: SetTrack | null } {
    const direct = this.profile(s.ref);
    if (direct) return { track: direct, status: "ok", suggestion: null };
    if (s.trackId) {
      for (const t of this.map().values()) if (t.trackId === s.trackId) return { track: t, status: "moved", suggestion: null };
      const rec = this.d.preparation.get(s.trackId);
      const alt = rec?.refs.map((r) => this.profile(r)).find(Boolean);
      if (alt) return { track: alt, status: "moved", suggestion: null };
    }
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const suggestion = this.pool().find((t) => norm(t.title) === norm(s.title) && norm(t.artist) === norm(s.artist)) ?? null;
    return { track: null, status: "missing", suggestion };
  }

  // ── Views ──────────────────────────────────────────────────────────────────
  view(set: DJSet): SetView {
    if (this.viewCache && this.viewCache.set === set && this.viewCache.revision === this.state.revision) return this.viewCache.view;
    const resolved = set.slots.map((s) => (s.track ? this.resolve(s.track) : null));
    const durations = set.slots.map((s, i) => resolved[i]?.track?.durationSec ?? s.track?.durationSec ?? null);
    const targets = slotTargets(set, durations, this.avgDuration());
    const tl = slotTimeline(durations, set.overlapSec, this.avgDuration());
    const slots: SlotView[] = set.slots.map((slot, i) => ({ slot, index: i, track: resolved[i]?.track ?? null, status: resolved[i]?.status ?? "empty", suggestion: resolved[i]?.suggestion ?? null, target: targets[i] ?? null, start: tl[i]?.start ?? 0, end: tl[i]?.end ?? 0 }));
    const transitions = slots.slice(0, -1).map((s, i) => (s.track && slots[i + 1].track ? evaluateTransition(s.track, slots[i + 1].track!) : null));
    const view: SetView = { set, slots, transitions, totalSec: tl.length ? tl[tl.length - 1].end : 0, summary: this.summarise(set, slots, transitions) };
    this.viewCache = { set, revision: this.state.revision, view };
    return view;
  }
  private summarise(set: DJSet, slots: SlotView[], tr: (TransitionEval | null)[]): SetSummary {
    const groupTracks = set.groups.flatMap((g) => this.groupTracks(g));
    const tracks = set.mode === "groups" ? groupTracks.length : slots.filter((s) => s.slot.track).length;
    const empty = slots.filter((s) => !s.slot.track && !s.slot.flexible).length;
    const missing = set.mode === "groups" ? groupTracks.filter((t) => this.resolve(t).status === "missing").length : slots.filter((s) => s.status === "missing").length;
    const unanalysed = slots.filter((s) => s.track && !s.track.analysed).length;
    const red = tr.filter((t) => t?.state === "red").length, amber = tr.filter((t) => t?.state === "amber").length;
    const durationSec = set.mode === "groups" ? groupTracks.reduce((a, t) => a + Math.max(30, (t.durationSec ?? FALLBACK_SEC) - set.overlapSec), 0) : slots.reduce((a, s) => a + (s.track || s.slot.track ? s.end - s.start : 0), 0);
    const issues = [missing && `${missing} missing`, empty && `${empty} empty`, unanalysed && `${unanalysed} unanalysed`, red && `${red} conflict${red > 1 ? "s" : ""}`].filter(Boolean) as string[];
    const ready = tracks > 0 && !issues.length;
    return { tracks, empty, missing, unanalysed, red, amber, durationSec, ready, label: tracks === 0 ? "Draft" : ready ? (amber ? `Ready · ${amber} to review` : "Ready") : issues.join(" · ") };
  }
  avgDuration(): number {
    const d = this.pool().map((t) => t.durationSec).filter((x): x is number => !!x && x > 60 && x < 1200);
    return d.length ? d.reduce((a, b) => a + b, 0) / d.length : FALLBACK_SEC;
  }
  estimate(durationSec: number, overlapSec: number, energyMin = 1, energyMax = 10) {
    const inRange = this.pool().filter((t) => t.energy === null || (t.energy >= energyMin && t.energy <= energyMax));
    return estimateTrackCount(durationSec, (inRange.length >= 5 ? inRange : this.pool()).map((t) => t.durationSec), overlapSec);
  }

  // ── Editing session ────────────────────────────────────────────────────────
  current(): DJSet | null { return this.history?.current ?? null; }
  open(id: string): boolean {
    const s = this.d.store.get(id);
    if (!s) return false;
    this.flushSave();
    this.history = new History(this.heal(s));
    this.rejected.clear();
    this.set({ openId: id, canUndo: false, canRedo: false, message: "" });
    return true;
  }
  close(): void { this.flushSave(); this.history = null; this.set({ openId: null, canUndo: false, canRedo: false }); }

  /** Moved files are re-pointed to their current path (same audio content); nothing else changes. */
  private heal(set: DJSet): DJSet {
    let changed = false;
    const fix = (r: SetTrackRef): SetTrackRef => { const x = this.resolve(r); if (x.status === "moved" && x.track) { changed = true; return { ...r, ref: x.track.ref }; } return r; };
    const slots = set.slots.map((s) => (s.track ? { ...s, track: fix(s.track) } : s));
    const groups = set.groups.map((g) => ({ ...g, tracks: g.tracks.map(fix) }));
    return changed ? { ...set, slots, groups } : set;
  }

  /** Apply an edit with an undo step; derived targets/energies/transitions are refreshed; autosaves. */
  edit(fn: (s: DJSet) => DJSet, undoable = true): DJSet | null {
    const h = this.history; if (!h) return null;
    const next = this.withDerived(fn(h.current));
    if (next === h.current) return next;
    if (undoable) h.push(next); else h.replace(next);
    this.afterEdit();
    return next;
  }
  private gestureStart: DJSet | null = null;
  /** Continuous edits (dragging a curve point): live updates, one undo step at the end. */
  beginGesture() { this.gestureStart = this.history?.current ?? null; }
  endGesture() { if (this.history && this.gestureStart) { this.history.commitFrom(this.gestureStart); this.afterEdit(); } this.gestureStart = null; }
  undo() { if (this.history?.undo()) this.afterEdit(); }
  redo() { if (this.history?.redo()) this.afterEdit(); }
  private afterEdit() {
    this.set({ canUndo: !!this.history?.canUndo, canRedo: !!this.history?.canRedo, revision: this.state.revision + 1 });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 400);
  }
  flushSave(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const s = this.history?.current;
    if (s && this.d.store.get(s.id) !== s) this.d.store.save(s);
  }
  /** Stores slot targets, actual-energy snapshots and transition records alongside the slots. */
  withDerived(set: DJSet): DJSet {
    const v = this.view(set);
    const slots = set.slots.map((s, i) => {
      const target = v.slots[i].target, actual = v.slots[i].track?.energy ?? (s.track ? s.actualEnergy : null);
      return s.targetEnergy === target && s.actualEnergy === actual ? s : { ...s, targetEnergy: target, actualEnergy: actual };
    });
    const transitions: DJSetTransition[] = v.transitions.map((t, i) => {
      const from = set.slots[i].id, to = set.slots[i + 1].id, old = set.transitions.find((x) => x.fromSlotId === from && x.toSlotId === to);
      return { id: old?.id ?? newId("tr"), fromSlotId: from, toSlotId: to, compatibilityScore: t?.score ?? null, state: t?.state ?? "amber", warnings: t?.warnings ?? (t ? [] : ["Empty slot"]), transitionConfiguration: old?.transitionConfiguration ?? null };
    });
    const same = slots.every((s, i) => s === set.slots[i]) && JSON.stringify(transitions) === JSON.stringify(set.transitions);
    return same ? set : { ...set, slots, transitions };
  }

  create(input: NewSetInput): DJSet {
    const set = this.withDerived(createSet(input));
    this.d.store.save(set);
    this.open(set.id);
    this.say(`Created "${set.name}"`);
    return set;
  }

  /** Improve a Set: a new set from a playlist (or saved set); the source is never modified here. */
  importPlaylist(playlistId: string): DJSet | null {
    const p = this.d.playlists.get(playlistId);
    if (!p) return null;
    const tracks = p.refs.map((r) => this.profile(r));
    const energies = tracks.map((t) => t?.energy ?? null);
    const known = energies.filter((e): e is number => e !== null);
    const min = known.length ? Math.max(1, Math.floor(Math.min(...known) - 0.5)) : 1, max = known.length ? Math.min(10, Math.ceil(Math.max(...known) + 0.5)) : 10;
    const durations = tracks.map((t) => t?.durationSec ?? null);
    const tl = slotTimeline(durations, 30, this.avgDuration());
    let set = createSet({ name: `${p.name} — improved`, mode: "improve", durationTargetSec: Math.max(600, Math.round(tl.length ? tl[tl.length - 1].end : 3600)), energyMin: min, energyMax: max, curveTemplate: "imported", curveControlPoints: curveFromEnergies(energies, min, max), slotCount: p.refs.length });
    set = { ...set, slots: set.slots.map((s, i) => {
      const t = tracks[i];
      return { ...s, track: t ? this.toRef(t) : { trackId: null, ref: p.refs[i], title: p.refs[i].split(/[\\/]/).pop() ?? p.refs[i], artist: "", durationSec: null } };
    }) };
    const evals = tracks.slice(0, -1).map((t, i) => (t && tracks[i + 1] ? evaluateTransition(t, tracks[i + 1]!) : null));
    set.origin = { kind: "playlist", sourceId: p.id, sourceName: p.name, importedAt: Date.now(), refs: [...p.refs], energies, transitionScores: evals.map((e) => e?.score ?? null), transitionStates: evals.map((e) => e?.state ?? null) };
    set = this.withDerived(set);
    this.d.store.save(set);
    this.open(set.id);
    this.say(`Imported "${p.name}" (${p.refs.length} tracks). The playlist itself is unchanged.`);
    return set;
  }
  /** Improve an existing saved set: a new version that remembers the original as its "before". */
  improveSet(id: string): DJSet | null {
    const src = this.d.store.get(id);
    if (!src) return null;
    const copy = this.d.store.duplicate(id, true);
    if (!copy) return null;
    const v = this.view(src);
    const withOrigin = { ...copy, mode: "improve" as const, origin: { kind: "set" as const, sourceId: src.id, sourceName: src.name, importedAt: Date.now(), refs: src.slots.map((s) => s.track?.ref ?? ""), energies: v.slots.map((s) => s.track?.energy ?? null), transitionScores: v.transitions.map((t) => t?.score ?? null), transitionStates: v.transitions.map((t) => t?.state ?? null) } };
    this.d.store.save(withOrigin);
    this.open(withOrigin.id);
    return withOrigin;
  }

  /** Writes the improved order back to the source playlist. The UI must confirm first. */
  writeBackToPlaylist(confirmed: boolean): boolean {
    const s = this.current();
    if (!confirmed || !s?.origin || s.origin.kind !== "playlist" || !this.d.playlists.get(s.origin.sourceId)) return false;
    this.d.playlists.setOrderedRefs(s.origin.sourceId, this.orderedRefs(s));
    this.say(`Updated playlist "${s.origin.sourceName}" with the improved order`);
    return true;
  }

  // ── Recommendations ────────────────────────────────────────────────────────
  /**
   * The one scoring context for a slot — used by both the Recommended and Library tabs so the same
   * track always shows the same score.
   */
  scoreContext(set: DJSet, slotIndex: number, move?: NextMove): ScoreContext | null {
    const v = this.view(set), sv = v.slots[slotIndex];
    if (!sv) return null;
    const prev = v.slots.slice(0, slotIndex).reverse().find((s) => s.track)?.track ?? null;
    const next = v.slots.slice(slotIndex + 1).find((s) => s.track)?.track ?? null;
    const p = set.profile, exclude = new Set<string>();
    v.slots.forEach((s, i) => { if (i === slotIndex || !s.slot.track) return; exclude.add(s.slot.track.ref); const id = s.track?.trackId ?? s.slot.track.trackId; if (id) exclude.add(id); });
    return {
      prev, next, targetEnergy: sv.target, move: move ?? p.energyDirection, weights: p.weights, hard: p.hardConstraints,
      moodPreferences: p.moodPreferences, genrePreferences: p.genrePreferences, slotSeconds: this.avgDuration(), exclude, allowDuplicates: p.allowDuplicates,
      recent: new Set(this.d.autoDJ?.getState().played ?? []), seed: sv.slot.id, energySpan: this.energySpan(),
    };
  }
  recommend(set: DJSet, slotIndex: number, opts: { move?: NextMove; query?: string; limit?: number; groupOnly?: boolean } = {}): { ranked: CandidateScore[]; excluded: number } {
    const ctx = this.scoreContext(set, slotIndex, opts.move), sv = this.view(set).slots[slotIndex];
    if (!ctx || !sv) return { ranked: [], excluded: 0 };
    const rejected = this.rejected.get(sv.slot.id) ?? new Set();
    const q = opts.query?.trim().toLowerCase();
    const section = opts.groupOnly ? this.sectionAt(set, slotIndex) : null;
    const pool = (section ? this.groupPool(section.groupId) : this.pool()).filter((t) => !rejected.has(t.ref) && (!q || `${t.title} ${t.artist} ${t.genre ?? ""}`.toLowerCase().includes(q)));
    return rankCandidates(pool, ctx, opts.limit ?? 40);
  }
  /** Lowest/highest energy among available tracks (null when nothing has an energy yet). */
  energySpan(): [number, number] | null {
    const e = this.pool().filter((t) => t.available && t.energy !== null).map((t) => t.energy!);
    return e.length ? [Math.min(...e), Math.max(...e)] : null;
  }
  /** Library tracks still on the pre-Set-Studio energy estimate (Library Intelligence not run for them). */
  legacyEnergyCount(): number { return this.pool().filter((t) => t.energySource === "legacy" || (!t.analysed && t.available)).length; }
  /** Ranked tracks for a group (no order: scored against the group's energy range and preferences). */
  recommendForGroup(set: DJSet, groupId: string, limit = 30): CandidateScore[] {
    const g = set.groups.find((x) => x.id === groupId); if (!g) return [];
    const inSet = new Set(set.groups.flatMap((x) => this.groupTracks(x).flatMap((t) => (t.trackId ? [t.ref, t.trackId] : [t.ref]))));
    return rankCandidates(this.pool(), { energySpan: this.energySpan(), targetEnergy: (g.energyMin + g.energyMax) / 2, move: "keep", hard: { ...set.profile.hardConstraints, energyMin: g.energyMin, energyMax: g.energyMax }, moodPreferences: g.moodPreferences, genrePreferences: g.genrePreferences, exclude: inSet, weights: set.profile.weights }, limit).ranked;
  }
  reject(slotId: string, ref: string) { const s = this.rejected.get(slotId) ?? new Set(); s.add(ref); this.rejected.set(slotId, s); this.set({ revision: this.state.revision + 1 }); }

  // ── Phase 2: reusable groups in sets ────────────────────────────────────────
  private groups: BlendGroupService | null = null;
  attachGroups(g: BlendGroupService): void { this.groups = g; g.on("change", () => { this.profiles = null; this.set({ revision: this.state.revision + 1 }); }); }
  /** Tracks of a set group — a linked reusable group's live membership, else the set's own list. */
  groupTracks(g: DJSetGroup): SetTrackRef[] {
    const bg = g.blendGroupId ? this.groups?.get(g.blendGroupId) : undefined;
    return bg ? [...bg.tracks].sort((a, b) => a.position - b.position).map((t) => t.ref) : g.tracks;
  }
  /** The group section (if any) a slot's mid-time falls in. */
  sectionAt(set: DJSet, slotIndex: number): GroupSection | null {
    const v = this.view(set), s = v.slots[slotIndex];
    if (!s || !set.groupSections?.length) return null;
    const span = Math.max(set.durationTargetSec, v.totalSec, 1), x = (s.start + s.end) / 2 / span;
    return set.groupSections.find((g) => x >= g.start && x < g.end) ?? null;
  }
  /** Available members of a reusable group, filtered by its constraints when `strict`. */
  groupPool(groupId: string, strict = false): SetTrack[] {
    const g = this.groups?.get(groupId); if (!g) return [];
    return g.tracks.map((t) => this.resolve(t.ref).track).filter((t): t is SetTrack => !!t && t.available && (!strict || !constraintMisses(g, t).length));
  }

  /**
   * Auto Fill (preview only). Slots inside a group section draw only from that group's members; with
   * `sectionId`, only that section's empty slots are filled and the group's anchor tracks go in first.
   */
  autoFillPreview(set: DJSet, opts: { sectionId?: string } = {}): FillResult {
    const v = this.view(set);
    const section = opts.sectionId ? set.groupSections?.find((s) => s.id === opts.sectionId) ?? null : null;
    const sectionOf = v.slots.map((_, i) => this.sectionAt(set, i));
    const refs = v.slots.map((s) => (s.track ? s.track.ref : s.slot.track ? s.slot.track.ref : null));
    if (section) {
      // Anchors first: each group anchor not yet in the set takes the empty in-section slot whose target fits it best.
      const g = this.groups?.get(section.groupId);
      const inSet = new Set(refs.filter(Boolean) as string[]);
      for (const a of g?.tracks.filter((t) => t.isAnchor) ?? []) {
        const t = this.resolve(a.ref).track; if (!t || inSet.has(t.ref)) continue;
        const free = v.slots.map((_, i) => i).filter((i) => !refs[i] && !v.slots[i].slot.flexible && sectionOf[i]?.id === section.id);
        if (!free.length) break;
        const best = free.sort((x, y) => Math.abs((t.energy ?? 5) - (v.slots[x].target ?? 5)) - Math.abs((t.energy ?? 5) - (v.slots[y].target ?? 5)))[0];
        refs[best] = t.ref; inSet.add(t.ref);
      }
    }
    const pools = new Map<string, SetTrack[]>();
    const poolFor = (i: number) => { const sec = sectionOf[i]; if (!sec) return null; if (!pools.has(sec.groupId)) pools.set(sec.groupId, this.groupPool(sec.groupId)); return pools.get(sec.groupId)!; };
    return autoFill(v.slots.map((s, i) => ({ ref: refs[i], targetEnergy: s.target, flexible: s.slot.flexible || (!!section && sectionOf[i]?.id !== section.id && !refs[i]) })), this.pool(),
      { allowDuplicates: set.profile.allowDuplicates, targetDurationSec: section ? undefined : set.durationTargetSec, overlapSec: set.overlapSec, hard: set.profile.hardConstraints, poolFor });
  }
  /** Removes sections and links to a deleted reusable group (set groups keep a copy of its tracks). */
  onGroupDeleted(groupId: string): void {
    const snapshot = this.groups?.get(groupId);
    // The open set may have unsaved (debounced) edits: use its live version.
    const open = this.history?.current;
    const sets = [...this.d.store.getState().sets.filter((s) => s.id !== open?.id), ...(open ? [open] : [])];
    for (const s of sets) {
      if (!s.groupSections?.some((x) => x.groupId === groupId) && !s.groups.some((g) => g.blendGroupId === groupId)) continue;
      const next = { ...s, updatedAt: Date.now(), groupSections: s.groupSections?.filter((x) => x.groupId !== groupId), groups: s.groups.map((g) => (g.blendGroupId === groupId ? { ...(({ blendGroupId: _b, ...rest }) => rest)(g), tracks: snapshot ? snapshot.tracks.map((t) => t.ref) : g.tracks } : g)) };
      if (this.history?.current.id === s.id) this.edit(() => next, false); else this.d.store.save(next);
    }
  }
  resequencePreview(set: DJSet): FillResult {
    const v = this.view(set);
    return resequence(v.slots.map((s) => ({ ref: s.track?.ref ?? null, targetEnergy: s.target, locked: s.slot.isLocked })), this.pool(), { overlapSec: set.overlapSec });
  }
  applyRefs(refs: (string | null)[], label: string): void {
    this.edit((s) => ops.applyRefs(s, refs, (r) => { const t = this.profile(r); return t ? { track: this.toRef(t), energy: t.energy } : null; }));
    this.say(label);
  }

  // ── Playback & export integration ─────────────────────────────────────────
  orderedRefs(set: DJSet): string[] {
    const refs = set.mode === "groups" ? set.groups.flatMap((g) => this.groupTracks(g)) : set.slots.map((s) => s.track).filter((t): t is SetTrackRef => !!t);
    return refs.map((r) => this.resolve(r).track?.ref ?? null).filter((r): r is string => !!r);
  }
  /** Creates a new playlist with the set's order (existing playlists are never overwritten here). */
  loadToPlaylist(set: DJSet): Playlist | null {
    const refs = this.orderedRefs(set);
    if (!refs.length) { this.say("Add tracks to the set first", "warn"); return null; }
    const p = this.d.playlists.create(set.name, refs);
    // Remember the link so Auto DJ playing this playlist uses this set's prepared transitions.
    const linked = { ...set, playlistIds: [...(set.playlistIds ?? []), p.id], updatedAt: Date.now() };
    if (this.history?.current.id === set.id) this.edit((s) => ({ ...s, playlistIds: linked.playlistIds }), false); else this.d.store.save(linked);
    this.say(`Saved "${set.name}" as playlist "${p.name}" (${refs.length} tracks)`);
    return p;
  }
  async openInAutoDJ(set: DJSet): Promise<boolean> {
    if (!this.d.autoDJ) return false;
    const p = this.loadToPlaylist(set);
    if (!p) return false;
    await this.d.autoDJ.start(p.id);
    const st = this.d.autoDJ.getState();
    if (st.status === "OFF") { this.say(`Playlist "${p.name}" created. Auto DJ didn't start — pause the decks first, then start it from the playlist.`, "warn"); return false; }
    this.say(`Auto DJ is playing "${set.name}"`);
    return true;
  }
  private trackInfo(ref: string): TrackInfo | null { return this.d.library.getByRef(ref); }
  async sendToDeck(ref: string, deck: number): Promise<void> {
    const t = this.trackInfo(ref);
    if (!t || !this.d.engine) { this.say("Track not in the library", "warn"); return; }
    await this.d.engine.loadTrack(deck, t, "manual");
  }
  queueNext(ref: string): void {
    const a = this.d.autoDJ;
    if (!a) return;
    if (a.getState().status === "OFF") { a.add([ref]); this.say("Added to the Auto DJ queue"); }
    else { a.playNextRefs([ref]); this.say("Queued to play next in Auto DJ"); }
  }
  /** Preview a track from the start (headphones, or Deck A when no headphones and nothing is playing). */
  async previewToggle(ref: string): Promise<void> { await this.audition(ref, 0, { toggle: true }); }
  /** Hear a track from a position (same rules as audition). True when it is playing somewhere. */
  async previewAt(ref: string, seconds: number): Promise<boolean> { const r = await this.audition(ref, seconds); return r === "headphones" || r === "deck"; }

  /**
   * Hear a track from a position, without ever disturbing a live mix:
   *  - 4-channel routing → the headphone preview (never reaches the master);
   *  - otherwise, when no deck is playing → load it on Deck A (or B if A can't be heard), seek and play
   *    through the speakers; the same ▶ again stops it;
   *  - otherwise (a deck is playing) → only cue it, paused, on a free deck.
   */
  async audition(ref: string, seconds: number, opts: { toggle?: boolean } = {}): Promise<"headphones" | "deck" | "cued" | "stopped" | "none"> {
    const t = this.trackInfo(ref), e = this.d.engine;
    if (!t) return "none";
    if (this.d.preview?.state.available) {
      try {
        if (opts.toggle && this.d.preview.state.ref === ref) { await this.d.preview.toggle(t); return "stopped"; }
        await this.d.preview.toggle(t, seconds);
        this.set({ audition: { ref, at: seconds, where: "headphones" } });
        return "headphones";
      } catch (err) { this.say(err instanceof Error ? err.message : String(err), "warn"); return "none"; }
    }
    const st = e?.getState?.();
    if (!e || !st) return "none";
    const a = this.state.audition;
    // Same ▶ again while our deck audition is playing: stop it.
    if (a?.where === "deck" && a.deck !== undefined && st.decks[a.deck]?.playing && st.decks[a.deck]?.track?.ref === ref && (opts.toggle || Math.abs(a.at - seconds) < 0.05)) {
      this.d.play?.(a.deck, false);
      this.set({ audition: null });
      return "stopped";
    }
    const live = st.decks.findIndex((d, i) => d.playing && !(a?.where === "deck" && a.deck === i));
    if (live >= 0) {
      const free = st.decks.findIndex((d) => !d.playing);
      if (free < 0) { this.say("Both decks are playing — not touching them. Use 4-channel routing for headphone preview.", "warn"); return "none"; }
      await this.cueOnDeck(ref, free, seconds);
      this.say(`Deck ${String.fromCharCode(65 + live)} is playing, so the preview was only cued on Deck ${String.fromCharCode(65 + free)} (paused) — your mix isn't disturbed`);
      return "cued";
    }
    const deck = this.audibleDeck(st);
    if (st.decks[deck]?.playing) this.d.play?.(deck, false);
    if (st.decks[deck]?.track?.ref !== ref) await e.loadTrack(deck, t, "manual");
    if (e.getState?.().decks[deck]?.track?.ref !== ref) { this.say(`Couldn't load ${t.title} on Deck ${String.fromCharCode(65 + deck)}`, "warn"); return "none"; }
    e.seekTo?.(deck, seconds);
    this.d.play?.(deck, true);
    this.set({ audition: { ref, at: seconds, where: "deck", deck } });
    this.say(`Playing on Deck ${String.fromCharCode(65 + deck)} from ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")} (no headphone output) — press ▶ again to stop`);
    return "deck";
  }
  // ── Hold-to-play hot cue pads (Auto Cue) ──
  private hold: { token: number; ref: string; t: number; mode: "headphones" | "hotcue" | "seek"; deck?: number; slot?: number; released: boolean } | null = null;
  private holdToken = 0;
  /**
   * Press-and-hold a hot cue pad: plays from the cue while held (CDJ-style), back to the cue on release.
   * Headphones when available. Otherwise on a deck — only when no other deck is playing — using that deck's
   * own hot cue action when its pad holds this cue (Suggested cue source), else a plain seek + play.
   */
  async holdStart(ref: string, slot: number, t: number): Promise<"headphones" | "deck" | "blocked" | "none"> {
    this.holdEnd();
    const token = ++this.holdToken, track = this.trackInfo(ref), e = this.d.engine;
    if (!track) return "none";
    if (this.d.preview?.state.available) {
      this.hold = { token, ref, t, mode: "headphones", released: false };
      try { await this.d.preview.toggle(track, t); } catch (err) { this.say(err instanceof Error ? err.message : String(err), "warn"); return "none"; }
      if (this.hold?.token !== token || this.hold.released) this.d.preview.stop?.(); // released while loading
      return "headphones";
    }
    const st = e?.getState?.();
    if (!e || !st) return "none";
    const a = this.state.audition;
    const ours = (i: number) => a?.where === "deck" && a.deck === i;
    if (st.decks.some((d, i) => d.playing && !ours(i))) { this.say("A deck is playing — hold-to-play would sound in the room, so it's off while you're mixing (headphone preview needs 4-channel routing).", "warn"); return "blocked"; }
    const deck = st.decks.findIndex((d) => d.track?.ref === ref && d.status === "ready") >= 0 ? st.decks.findIndex((d) => d.track?.ref === ref && d.status === "ready") : this.audibleDeck(st);
    if (st.decks[deck]?.playing) this.d.play?.(deck, false);
    this.hold = { token, ref, t, mode: "seek", deck, slot, released: false };
    if (st.decks[deck]?.track?.ref !== ref) await e.loadTrack(deck, track, "manual");
    if (this.hold?.token !== token) return "none";
    const now = e.getState?.().decks[deck];
    if (now?.track?.ref !== ref || now.status !== "ready") { this.say(`Couldn't load ${track.title} on Deck ${String.fromCharCode(65 + deck)}`, "warn"); this.hold = null; return "none"; }
    if (this.hold.released) { e.seekTo?.(deck, t); this.hold = null; return "deck"; } // tapped while loading: just cue it
    // The deck's real hot cue pad holds this cue → use the deck's own press-and-hold behaviour.
    if (this.d.send && now.hotcues && Math.abs((now.hotcues[slot] ?? -99) - t) < 0.02) { this.hold.mode = "hotcue"; this.d.send(`deck${deck + 1}.hotcue.${slot + 1}`, 1); }
    else { e.seekTo?.(deck, t); this.d.play?.(deck, true); }
    this.set({ audition: { ref, at: t, where: "deck", deck } });
    return "deck";
  }
  /** Release the held pad: stop and return to the cue. */
  holdEnd(): void {
    const h = this.hold;
    if (!h) return;
    h.released = true;
    if (h.mode === "headphones") { this.d.preview?.stop?.(); this.hold = null; return; }
    if (h.deck === undefined || !this.d.engine?.getState?.().decks[h.deck]?.track || this.d.engine.getState?.().decks[h.deck]?.track?.ref !== h.ref) return; // still loading: handled in holdStart
    if (h.mode === "hotcue" && h.slot !== undefined) this.d.send?.(`deck${h.deck + 1}.hotcue.${h.slot + 1}`, 0);
    else { this.d.play?.(h.deck, false); this.d.engine.seekTo?.(h.deck, h.t); }
    this.hold = null;
    this.set({ audition: null });
  }

  /** Stop a deck audition started from Set Studio (never a deck it didn't start). */
  stopAudition(): void {
    const a = this.state.audition, st = this.d.engine?.getState?.();
    if (a?.where === "deck" && a.deck !== undefined && st?.decks[a.deck]?.playing && st.decks[a.deck]?.track?.ref === a.ref) this.d.play?.(a.deck, false);
    if (a?.where === "headphones") this.d.preview?.stop?.();
    this.set({ audition: null });
  }
  /** Deck A, unless its channel can't be heard (fader down or crossfader hard right) and Deck B can. */
  private audibleDeck(st: NonNullable<ReturnType<NonNullable<NonNullable<Deps["engine"]>["getState"]>>>): number {
    const m = st.mixer;
    if (!m) return 0;
    const heard = (i: number) => (m.channels[i]?.volume ?? 1) > 0.05 && !m.channels[i]?.mute && (i === 0 ? m.crossfader < 0.95 : m.crossfader > 0.05);
    return heard(0) || !heard(1) ? 0 : 1;
  }
  /** Load a track on a deck, paused at a position (refused by the engine if that deck is playing). */
  async cueOnDeck(ref: string, deck: number, seconds: number): Promise<void> {
    const t = this.trackInfo(ref), e = this.d.engine;
    if (!t || !e) return;
    if (e.getState?.().decks[deck]?.playing) { this.say(`Deck ${String.fromCharCode(65 + deck)} is playing — not loading over it`, "warn"); return; }
    if (e.getState?.().decks[deck]?.track?.ref !== ref) await e.loadTrack(deck, t, "manual");
    e.seekTo?.(deck, seconds);
    this.say(`Cued on Deck ${String.fromCharCode(65 + deck)} at ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")} — press play to hear it`);
  }
  async exportSet(set: DJSet, format: "m3u8" | "native"): Promise<void> {
    if (!this.d.saveText) return;
    if (format === "m3u8") {
      const { text, skipped } = toM3U8({ ...set, groups: set.groups.map((g) => ({ ...g, tracks: this.groupTracks(g) })) }, (r) => this.resolve(r).track?.ref ?? null);
      if (await this.d.saveText(`${safeFileName(set.name)}.m3u8`, text, "m3u8")) this.say(`Exported M3U8 playlist${skipped ? ` (${skipped} missing track${skipped > 1 ? "s" : ""} left out)` : ""}. M3U8 carries order, duration, title and file location only.`);
    } else if (await this.d.saveText(`${safeFileName(set.name)}.dbdjset.json`, toNative(set, this.d.appVersion ?? ""), "json")) this.say("Exported the full set (curve, slots, notes, anchors, settings)");
  }
  async importSet(): Promise<DJSet | null> {
    const f = await this.d.pickText?.();
    if (!f) return null;
    try { const set = this.withDerived(fromNative(f.text)); this.d.store.save(set); this.say(`Imported "${set.name}"`); return set; }
    catch (e) { this.say(`Couldn't import ${f.name}: ${e instanceof Error ? e.message : String(e)}`, "warn"); return null; }
  }
}

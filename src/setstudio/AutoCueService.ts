/**
 * Auto Cue: generates hot cue suggestions from the cached analysis, keeps them in a staging list on the
 * track's preparation record, and puts only the ones the user accepts into hot cue slots of the existing
 * cue database (the deck's "Suggested" cue source). The Suggested/Embedded routing, ↻ regenerate and
 * → File work exactly as before; Auto Cue never writes into a file tag.
 *
 * Protection: an occupied slot is never replaced without `replace: true` (the UI asks first); accepted
 * cues are saved as user cues (`source: "manual"`) so the older ↻ regenerate never removes them.
 */
import { Emitter } from "../core/events";
import { gridReliable as gridTrusted } from "../preparation/beatGrid";
import type { PreparationStore } from "../preparation/PreparationStore";
import type { PreparedCue, TrackPreparation } from "../preparation/types";
import { buildSuggestionSet, cueInfo, detectCues, HIGH_CONFIDENCE, LOW_CONFIDENCE, requantise, type CueGrid, type CueSuggestionSet, type CueType, type GeneratedCue, type QuantiseMode } from "./autocue";

/** `manual`: a cue the user placed or changed (never replaced without asking). `autoCue`: placed by Auto Cue and unchanged since. */
export interface SlotInfo { slot: number; cue: PreparedCue | null; manual: boolean; autoCue: boolean; generatedId: string | null }
export type PadAction = "keep-yours" | "keep" | "move" | "new" | "replace" | "empty";
export interface PlannedPad { slot: number; time: number | null; name: string; colour: string; action: PadAction; replaces: string | null; cueIds: string[]; from: PreparedCue | null; why: string }
export interface PadPlan { pads: PlannedPad[]; skipped: { id: string; label: string; time: number; reason: string }[]; changes: number }
export type AcceptResult = { ok: true; slot: number } | { ok: false; reason: "no-free-slot" | "occupied" | "duplicate" | "missing"; occupied?: SlotInfo };
/** Which cue names a pad when several land on the same moment, and which win a pad when there are more cues than pads. */
const PAD_PRIORITY: CueType[] = ["drop", "build", "breakdown", "intro", "outro", "mix-out", "vocal-entry", "first-phrase", "first-beat"];
const prio = (c: GeneratedCue) => PAD_PRIORITY.indexOf(c.cueType) * 10 + ((c.occurrence ?? 1) - 1);

interface Deps {
  preparation: Pick<PreparationStore, "get" | "forRef" | "waveform" | "updateSetData" | "setHotcue" | "on">;
  /** Vocal regions from STEMS (cached or computed from completed STEMS); null when unavailable. */
  vocals?: (ref: string) => Promise<[number, number][] | null>;
  /** A track's hot cues changed — refresh decks that show the Suggested cue source. */
  onCuesChanged?: (trackId: string) => void;
  now?: () => number;
  /** Re-run the analysis hot cue suggestions for a track (the deck's ↻): refills empty pads with the original suggestions. */
  resuggest?: (trackId: string) => Promise<void>;
}

export class AutoCueService extends Emitter<{ change: { trackId: string } }> {
  private busy = new Set<string>();
  constructor(private d: Deps) { super(); }
  private now() { return this.d.now?.() ?? Date.now(); }
  get(trackId: string): CueSuggestionSet | undefined { return this.d.preparation.get(trackId)?.autoCues; }
  isBusy(trackId: string) { return this.busy.has(trackId); }
  static gridOf(r: TrackPreparation): CueGrid | null { return r.beatGrid && r.beatGrid.bpm > 0 ? { bpm: r.beatGrid.bpm, firstBeat: r.beatGrid.firstBeat, confidence: r.beatGrid.confidence, manual: !!r.beatGrid.manuallyAdjusted } : null; }

  /** Generate (or regenerate) suggestions. Previous decisions are kept; the replaced set is kept for Restore. */
  async generate(ref: string, mode?: QuantiseMode): Promise<CueSuggestionSet> {
    const r = this.d.preparation.forRef(ref);
    if (!r || r.analysisVersion === null) throw new Error("This track hasn't been analysed yet — analyse it first");
    this.busy.add(r.trackId); this.emit("change", { trackId: r.trackId });
    try {
      const wave = await this.d.preparation.waveform(r.trackId);
      if (!wave) throw new Error("Cached analysis data is missing — reanalyse this track");
      const vocals = this.d.vocals ? await this.d.vocals(ref).catch(() => null) : null;
      const grid = AutoCueService.gridOf(r);
      const det = detectCues({ duration: r.duration, fps: wave.fps, low: wave.low, mid: wave.mid, high: wave.high, grid, vocals });
      const prior = this.d.preparation.get(r.trackId)?.autoCues;
      const set = buildSuggestionSet(det, grid, mode ?? prior?.quantise ?? "bar", r.analysedAt, prior, this.now());
      this.save(r.trackId, set);
      return set;
    } finally { this.busy.delete(r.trackId); this.emit("change", { trackId: r.trackId }); }
  }

  private save(trackId: string, set: CueSuggestionSet) { this.d.preparation.updateSetData(trackId, { autoCues: set }); this.emit("change", { trackId }); }
  private patchCue(trackId: string, id: string, fn: (c: GeneratedCue) => GeneratedCue): GeneratedCue | null {
    const set = this.get(trackId); const c = set?.cues.find((x) => x.id === id);
    if (!set || !c) return null;
    const next = { ...fn(c), updatedAt: this.now() };
    this.save(trackId, { ...set, cues: set.cues.map((x) => (x.id === id ? next : x)) });
    return next;
  }

  requantise(trackId: string, mode: QuantiseMode): void {
    const r = this.d.preparation.get(trackId), set = r?.autoCues;
    if (r && set) this.save(trackId, requantise(set, AutoCueService.gridOf(r), mode));
  }
  restorePrevious(trackId: string): boolean {
    const set = this.get(trackId);
    if (!set?.previous) return false;
    // Keep today's decisions on the pads: accepted cues stay accepted in the restored list.
    const decided = set.cues.filter((c) => c.slot !== null);
    const restored = { ...set.previous, padBackup: set.padBackup, cues: [...decided, ...set.previous.cues.filter((c) => !decided.some((x) => x.cueType === c.cueType && (x.occurrence ?? 1) === (c.occurrence ?? 1)))] };
    this.save(trackId, restored);
    return true;
  }

  /** Who is in each of the 8 hot cue slots (database cue source). */
  slots(trackId: string): SlotInfo[] {
    const r = this.d.preparation.get(trackId), set = r?.autoCues;
    return Array.from({ length: 8 }, (_, slot) => {
      const cue = r?.cues.find((c) => c.type === "hotcue" && c.slot === slot) ?? null;
      const gen = set?.cues.find((g) => g.slot === slot && cue && Math.abs(cue.timestamp - g.quantisedPosition) < 0.01) ?? null;
      // Placed by Auto Cue (its comment) and still on a suggested moment → Auto Cue's own pad, not one the user made.
      const tol = this.tolerance(trackId);
      const autoCue = !!cue && !gen && cue.source === "manual" && !!cue.comment?.startsWith("Auto Cue:") && !!set?.cues.some((g) => Math.abs(g.quantisedPosition - cue.timestamp) <= tol || Math.abs(g.detectedPosition - cue.timestamp) <= tol);
      return { slot, cue, manual: !!cue && cue.source !== "analysis" && !gen && !autoCue, autoCue: autoCue || !!gen, generatedId: gen?.id ?? null };
    });
  }

  /** Put a suggestion on the pads. Without a slot: the first free one. An occupied slot needs `replace`. */
  accept(trackId: string, id: string, slot?: number, opts: { replace?: boolean; allowDuplicate?: boolean } = {}): AcceptResult {
    const set = this.get(trackId), c = set?.cues.find((x) => x.id === id);
    if (!set || !c) return { ok: false, reason: "missing" };
    // Another pad already sits on this moment: ask before doubling it up.
    const dup = this.coveredBy(trackId, id);
    if (dup && !opts.allowDuplicate && dup.slot !== slot) return { ok: false, reason: "duplicate", occupied: dup };
    this.backupPads(trackId);
    const slots = this.slots(trackId);
    const target = slot ?? slots.find((s) => !s.cue)?.slot;
    if (target === undefined) return { ok: false, reason: "no-free-slot" };
    const occ = slots[target];
    if (occ.cue && occ.generatedId !== id && !opts.replace) return { ok: false, reason: "occupied", occupied: occ };
    // Moving an already-placed suggestion: free its old slot.
    if (c.slot !== null && c.slot !== target) this.d.preparation.setHotcue(trackId, c.slot, null);
    // A generated cue that was in the replaced slot goes back to the staging list.
    const displaced = occ.generatedId && occ.generatedId !== id ? occ.generatedId : null;
    this.d.preparation.setHotcue(trackId, target, { timestamp: c.quantisedPosition, name: c.label, colour: c.colour, source: "manual", comment: `Auto Cue: ${cueInfo(c.cueType).label} (accepted)`, confidence: c.confidence });
    const cur = this.get(trackId)!;
    this.save(trackId, { ...cur, cues: cur.cues.map((x) => (x.id === id ? { ...x, slot: target, reviewStatus: x.reviewStatus === "modified" ? "modified" : "accepted", updatedAt: this.now() } : x.id === displaced ? { ...x, slot: null, reviewStatus: "suggested" } : x)) });
    this.d.onCuesChanged?.(trackId);
    return { ok: true, slot: target };
  }

  /**
   * "The same moment": less than a beat apart. Two pads closer than a beat play the same thing (e.g. the
   * deck's older analysis pads, which count bars from 0:00 rather than from the first beat, sit up to
   * a fraction of a bar before Auto Cue's grid-aligned ones).
   */
  private tolerance(trackId: string): number { const r = this.d.preparation.get(trackId), g = r ? AutoCueService.gridOf(r) : null; return g ? Math.max(0.1, 60 / g.bpm - 0.01) : 0.3; }
  /** Nearest bar line on a reliable grid (older auto pads that are off the grid), else unchanged. */
  private snapToBar(trackId: string, t: number): number {
    const r = this.d.preparation.get(trackId), g = r ? AutoCueService.gridOf(r) : null;
    if (!g || !gridTrusted(g)) return t;
    const bar = 240 / g.bpm, s = g.firstBeat + Math.round((t - g.firstBeat) / bar) * bar;
    return s >= 0 && Math.abs(s - t) < bar / 4 ? Math.round(s * 1000) / 1000 : t; // only nudges, never jumps a section
  }
  /** A pad (other than this suggestion's own) that already sits on this suggestion's moment. */
  coveredBy(trackId: string, id: string): SlotInfo | null {
    const c = this.get(trackId)?.cues.find((x) => x.id === id);
    if (!c) return null;
    const tol = this.tolerance(trackId);
    return this.slots(trackId).find((s) => s.cue && s.generatedId !== id && Math.abs(s.cue.timestamp - c.quantisedPosition) <= tol) ?? null;
  }
  /** Snapshot the pads before Auto Cue first changes them (kept until Restore original pads). */
  private backupPads(trackId: string): void {
    const set = this.get(trackId), r = this.d.preparation.get(trackId);
    if (!set || !r || set.padBackup) return;
    const padBackup = r.cues.filter((c) => c.type === "hotcue").map((c) => ({ slot: c.slot, timestamp: c.timestamp, name: c.name, colour: c.colour, source: c.source, comment: c.comment, confidence: c.confidence }));
    this.save(trackId, { ...set, padBackup });
  }

  /**
   * Accept every high-confidence suggestion: cues on the same moment share one pad ("Intro + First Beat");
   * a moment that already has a pad isn't doubled; when there are more moments than free pads the most useful
   * ones (drops, builds, breakdowns, intro, outro…) win; and the chosen pads are laid out in time order.
   * `replaceAutoSuggested` (confirmed by the user): the older analysis pads are cleared first — never the user's own.
   */
  acceptAllHigh(trackId: string, opts: { replaceAutoSuggested?: boolean } = {}): { accepted: number; staged: number; merged: number } {
    const candidates = () => (this.get(trackId)?.cues ?? []).filter((c) => c.reviewStatus === "suggested" && c.confidence >= HIGH_CONFIDENCE && c.slot === null);
    if (!candidates().length) return { accepted: 0, staged: 0, merged: 0 };
    this.backupPads(trackId);
    // Clear the replaceable pads first, so moments they covered get an Auto Cue pad instead of being skipped.
    if (opts.replaceAutoSuggested) for (const s of this.autoSuggestedPads(trackId)) this.d.preparation.setHotcue(trackId, s.slot, null);
    const high = candidates().filter((c) => !this.coveredBy(trackId, c.id));
    if (!high.length) { this.d.onCuesChanged?.(trackId); return { accepted: 0, staged: 0, merged: 0 }; }
    // Group cues on the same moment.
    const tol = this.tolerance(trackId), groups: GeneratedCue[][] = [];
    for (const c of [...high].sort((a, b) => a.quantisedPosition - b.quantisedPosition)) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g[0].quantisedPosition - c.quantisedPosition) <= tol) g.push(c); else groups.push([c]);
    }
    for (const g of groups) g.sort((a, b) => prio(a) - prio(b));
    const free = this.slots(trackId).filter((s) => !s.cue).map((s) => s.slot); // ascending
    const chosen = [...groups].sort((a, b) => prio(a[0]) - prio(b[0]) || b[0].confidence - a[0].confidence).slice(0, free.length).sort((a, b) => a[0].quantisedPosition - b[0].quantisedPosition);
    const placed = new Map<string, { slot: number; lead: GeneratedCue }>(), shared = new Map<string, { slot: number; lead: GeneratedCue }>();
    chosen.forEach((g, i) => {
      const slot = free[i], lead = g[0];
      this.d.preparation.setHotcue(trackId, slot, { timestamp: lead.quantisedPosition, name: g.slice(0, 2).map((c) => c.label).join(" + "), colour: lead.colour, source: "manual", comment: `Auto Cue: ${g.map((c) => c.label).join(", ")} (accepted)`, confidence: lead.confidence });
      placed.set(lead.id, { slot, lead });
      for (const other of g.slice(1)) shared.set(other.id, { slot, lead });
    });
    const cur = this.get(trackId)!;
    this.save(trackId, { ...cur, cues: cur.cues.map((x) => {
      const p = placed.get(x.id), s = shared.get(x.id);
      if (p) return { ...x, slot: p.slot, reviewStatus: "accepted", updatedAt: this.now() };
      if (s) return { ...x, note: `Same moment as pad ${String.fromCharCode(65 + s.slot)} (${s.lead.label})`, updatedAt: this.now() };
      return x;
    }) });
    this.d.onCuesChanged?.(trackId);
    const used = chosen.reduce((n, g) => n + g.length, 0);
    return { accepted: chosen.length, merged: used - chosen.length, staged: high.length - used };
  }

  /** Is there something to restore (a backup, or Auto Cue pads to take off)? */
  canRestorePads(trackId: string): boolean { return !!this.get(trackId)?.padBackup || this.slots(trackId).some((s) => s.generatedId); }
  /**
   * Put the pads back as they were before Auto Cue changed them. Slots the user has changed since (a
   * different cue of their own) are left alone. Without a backup (pads changed by an earlier version), Auto
   * Cue's pads are taken off and the original analysis suggestions are re-run into the empty pads.
   */
  async restoreOriginalPads(trackId: string): Promise<"restored" | "resuggested" | "nothing"> {
    const set = this.get(trackId);
    if (!set) return "nothing";
    const before = this.slots(trackId);
    const generated = before.filter((s) => s.generatedId);
    if (set.padBackup) {
      for (const s of before) {
        const b = set.padBackup.find((x) => x.slot === s.slot);
        // Anything that isn't the user's own (Auto Cue's pads, older auto pads it moved or snapped) goes back.
        const untouched = !s.cue || !s.manual || (b && Math.abs(b.timestamp - s.cue.timestamp) < 0.01 && b.name === s.cue.name);
        if (!untouched) continue; // the user's own later change
        this.d.preparation.setHotcue(trackId, s.slot, b ? { timestamp: b.timestamp, name: b.name, colour: b.colour, source: b.source, comment: b.comment, confidence: b.confidence } : null);
      }
    } else {
      if (!generated.length && !this.d.resuggest) return "nothing";
      for (const s of generated) this.d.preparation.setHotcue(trackId, s.slot, null);
    }
    const cur = this.get(trackId)!;
    const { padBackup: _drop, ...rest } = cur;
    this.save(trackId, { ...rest, cues: cur.cues.map((x) => (x.slot !== null ? { ...x, slot: null, reviewStatus: x.reviewStatus === "rejected" ? "rejected" : "suggested" } : x)) });
    if (!set.padBackup && this.d.resuggest) { await this.d.resuggest(trackId); this.d.onCuesChanged?.(trackId); return "resuggested"; }
    this.d.onCuesChanged?.(trackId);
    return "restored";
  }
  /** Pads holding older analysis suggestions (replaceable with confirmation). */
  autoSuggestedPads(trackId: string): SlotInfo[] { return this.slots(trackId).filter((s) => !!s.cue && !s.generatedId && (s.cue.source === "analysis" || s.autoCue)); }

  /**
   * The recommended 8-pad layout: the user's own pads stay where they are; suggestions on the same moment share
   * a pad; the most useful moments win the remaining pads (drops, builds, breakdowns, intro, outro…) — including
   * older auto pads whose moments Auto Cue didn't find; and the chosen pads are laid out in time order.
   */
  planLayout(trackId: string): PadPlan | null {
    const set = this.get(trackId);
    if (!set) return null;
    const tol = this.tolerance(trackId), slots = this.slots(trackId), L = (n: number) => String.fromCharCode(65 + n);
    const user = slots.filter((s) => s.cue && s.manual), open = slots.filter((s) => !s.manual);
    const typeOf = (name: string): CueType | null => (/drop/i.test(name) ? "drop" : /build/i.test(name) ? "build" : /break/i.test(name) ? "breakdown" : /intro/i.test(name) ? "intro" : /outro/i.test(name) ? "outro" : /vocal/i.test(name) ? "vocal-entry" : /phrase/i.test(name) ? "first-phrase" : /mix/i.test(name) ? "mix-out" : /beat/i.test(name) ? "first-beat" : null);
    interface Group { time: number; cues: GeneratedCue[]; existing: SlotInfo | null; rank: number; conf: number }
    const groups: Group[] = [], skipped: PadPlan["skipped"] = [];
    for (const c of set.cues.filter((x) => x.reviewStatus !== "rejected" && x.confidence >= LOW_CONFIDENCE).sort((a, b) => a.quantisedPosition - b.quantisedPosition)) {
      const mine = user.find((s) => Math.abs(s.cue!.timestamp - c.quantisedPosition) <= tol);
      if (mine) { skipped.push({ id: c.id, label: c.label, time: c.quantisedPosition, reason: `already on pad ${L(mine.slot)} (your ${mine.cue!.name})` }); continue; }
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.time - c.quantisedPosition) <= tol) g.cues.push(c); else groups.push({ time: c.quantisedPosition, cues: [c], existing: null, rank: 0, conf: 0 });
    }
    // Older auto pads (analysis or Auto Cue) join the moment they sit on, or compete as their own moment.
    for (const s of open.filter((x) => x.cue)) {
      const g = groups.find((x) => Math.abs(x.time - s.cue!.timestamp) <= tol);
      if (g) { if (!g.existing) g.existing = s; } else groups.push({ time: s.cue!.timestamp, cues: [], existing: s, rank: 0, conf: 0 });
    }
    for (const g of groups) {
      g.cues.sort((a, b) => prio(a) - prio(b));
      const ty = g.cues[0]?.cueType ?? typeOf(g.existing?.cue?.name ?? "");
      g.rank = g.cues[0] ? prio(g.cues[0]) : ty ? PAD_PRIORITY.indexOf(ty) * 10 + 5 : 999;
      g.conf = g.cues[0]?.confidence ?? 0.5;
    }
    const chosen = [...groups].sort((a, b) => a.rank - b.rank || b.conf - a.conf || a.time - b.time).slice(0, open.length).sort((a, b) => a.time - b.time);
    for (const g of groups) if (!chosen.includes(g)) for (const c of g.cues) skipped.push({ id: c.id, label: c.label, time: c.quantisedPosition, reason: "no pad left — the chosen moments are more useful for mixing" });
    const pads: PlannedPad[] = slots.map((s) => ({ slot: s.slot, time: s.cue && s.manual ? s.cue.timestamp : null, name: s.cue && s.manual ? s.cue.name : "", colour: s.cue?.colour ?? "#5b6475", action: s.cue && s.manual ? "keep-yours" : "empty", replaces: null, cueIds: [], from: s.cue, why: s.cue && s.manual ? "your own cue — never moved" : "" }));
    const freeSlots = open.map((s) => s.slot).sort((a, b) => a - b);
    let changes = 0;
    chosen.forEach((g, i) => {
      const slot = freeSlots[i], before = slots[slot].cue;
      const lead = g.cues[0];
      const name = lead ? g.cues.slice(0, 2).map((c) => c.label).join(" + ") : g.existing!.cue!.name;
      const oldAt = g.existing?.cue?.timestamp ?? 0, time = lead ? lead.quantisedPosition : this.snapToBar(trackId, oldAt);
      const same = !!before && Math.abs(before.timestamp - time) <= 0.01 && before.name === name;
      const action: PadAction = same ? "keep" : !lead && g.existing ? "move" : before ? "replace" : "new";
      if (action !== "keep") changes++;
      pads[slot] = { slot, time, name, colour: lead?.colour ?? g.existing!.cue!.colour, action, replaces: action === "replace" ? before!.name : null, cueIds: g.cues.map((c) => c.id), from: !lead ? g.existing!.cue : null,
        why: lead ? `${Math.round(lead.confidence * 100)}% · ${lead.detectionMethod}${g.cues.length > 1 ? ` · shares the moment with ${g.cues.slice(1).map((c) => c.label).join(", ")}` : ""}${g.existing && !g.cues.some((c) => c.id === g.existing!.generatedId) && Math.abs(oldAt - time) > 0.01 ? ` · replaces the older ${g.existing.cue!.name} ${Math.abs(oldAt - time).toFixed(2)} s away` : ""}`
          : [`older pad kept${g.existing!.slot !== slot ? ` (was ${L(g.existing!.slot)})` : ""}`, Math.abs(oldAt - time) > 0.01 ? `snapped ${time > oldAt ? "+" : "−"}${Math.abs(time - oldAt).toFixed(2)} s onto the bar line` : ""].filter(Boolean).join(" · ") };
    });
    for (const s of open) if (s.cue && !chosen.some((g) => g.existing === s) && pads[s.slot].action === "empty") changes++;
    return { pads, skipped: skipped.sort((a, b) => a.time - b.time), changes };
  }

  /** Apply the recommended layout (pads are backed up first; your own pads are never touched). */
  applyLayout(trackId: string): { changed: number } {
    const plan = this.planLayout(trackId);
    if (!plan || !plan.changes) return { changed: 0 };
    this.backupPads(trackId);
    const placed = new Map<string, number>(), shared = new Map<string, number>();
    for (const p of plan.pads) {
      if (p.action === "keep-yours" || p.action === "keep") { if (p.cueIds[0]) placed.set(p.cueIds[0], p.slot); continue; }
      if (p.action === "empty") { this.d.preparation.setHotcue(trackId, p.slot, null); continue; }
      const lead = p.cueIds[0];
      if (lead) {
        this.d.preparation.setHotcue(trackId, p.slot, { timestamp: p.time!, name: p.name, colour: p.colour, source: "manual", comment: `Auto Cue: ${p.name} (recommended layout)` });
        placed.set(lead, p.slot);
        for (const id of p.cueIds.slice(1)) shared.set(id, p.slot);
      } else if (p.from) this.d.preparation.setHotcue(trackId, p.slot, { timestamp: p.time ?? p.from.timestamp, name: p.from.name, colour: p.from.colour, source: p.from.source, comment: p.from.comment, confidence: p.from.confidence });
    }
    const cur = this.get(trackId)!;
    this.save(trackId, { ...cur, cues: cur.cues.map((x) => {
      if (placed.has(x.id)) return { ...x, slot: placed.get(x.id)!, reviewStatus: x.reviewStatus === "modified" ? "modified" : "accepted", note: undefined, updatedAt: this.now() };
      if (shared.has(x.id)) return { ...x, slot: null, note: `Same moment as pad ${String.fromCharCode(65 + shared.get(x.id)!)}`, updatedAt: this.now() };
      return x.slot !== null ? { ...x, slot: null, reviewStatus: x.reviewStatus === "rejected" ? "rejected" : "suggested" } : x;
    }) });
    this.d.onCuesChanged?.(trackId);
    return { changed: plan.changes };
  }

  reject(trackId: string, id: string): void {
    const c = this.get(trackId)?.cues.find((x) => x.id === id);
    if (!c) return;
    if (c.slot !== null) this.removeFromPads(trackId, id);
    this.patchCue(trackId, id, (x) => ({ ...x, reviewStatus: "rejected", slot: null }));
  }
  restore(trackId: string, id: string): void { this.patchCue(trackId, id, (x) => ({ ...x, reviewStatus: "suggested" })); }

  /** Take a placed suggestion off the pads (only if that slot still holds it — a cue the user moved by hand is left alone). */
  removeFromPads(trackId: string, id: string): void {
    const c = this.get(trackId)?.cues.find((x) => x.id === id);
    if (!c || c.slot === null) return;
    const info = this.slots(trackId)[c.slot];
    if (info.generatedId === id) { this.d.preparation.setHotcue(trackId, c.slot, null); this.d.onCuesChanged?.(trackId); }
    this.patchCue(trackId, id, (x) => ({ ...x, slot: null, reviewStatus: x.reviewStatus === "rejected" ? "rejected" : "suggested" }));
  }

  /** Move a cue (status → modified). If it's on the pads, the hot cue moves too. */
  move(trackId: string, id: string, t: number): void {
    if (!this.get(trackId)?.cues.some((x) => x.id === id)) return;
    const placed = this.placed(trackId, id);
    const c = this.patchCue(trackId, id, (x) => ({ ...x, quantisedPosition: Math.max(0, Math.round(t * 100) / 100), reviewStatus: x.reviewStatus === "rejected" ? "rejected" : "modified", note: "Moved by hand" }));
    if (c && placed) this.writePad(trackId, c);
  }
  /** True when the cue's slot still holds this suggestion (not a cue the user re-placed by hand). */
  private placed(trackId: string, id: string): boolean {
    const c = this.get(trackId)?.cues.find((x) => x.id === id);
    return !!c && c.slot !== null && this.slots(trackId)[c.slot].generatedId === id;
  }
  rename(trackId: string, id: string, label: string): void {
    const placed = this.placed(trackId, id);
    const c = this.patchCue(trackId, id, (x) => ({ ...x, label: label.trim() || x.label, reviewStatus: x.reviewStatus === "suggested" ? "modified" : x.reviewStatus }));
    if (c && placed) this.writePad(trackId, c);
  }
  changeType(trackId: string, id: string, type: CueType): void {
    const info = cueInfo(type), placed = this.placed(trackId, id);
    const c = this.patchCue(trackId, id, (x) => ({ ...x, cueType: type, label: info.label, colour: info.colour, reviewStatus: x.reviewStatus === "suggested" ? "modified" : x.reviewStatus }));
    if (c && placed) this.writePad(trackId, c);
  }
  private writePad(trackId: string, c: GeneratedCue) {
    if (c.slot === null || this.slots(trackId)[c.slot].cue === null) return;
    this.d.preparation.setHotcue(trackId, c.slot, { timestamp: c.quantisedPosition, name: c.label, colour: c.colour, source: "manual", comment: `Auto Cue: ${cueInfo(c.cueType).label} (edited)` });
    // Re-link: slots() matches by position, so refresh the record view.
    this.emit("change", { trackId });
    this.d.onCuesChanged?.(trackId);
  }
}

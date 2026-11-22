/**
 * Transition Lab: build, compare, audition and save how two tracks blend.
 *
 * Preview runs on the app's real decks and mixer (no second playback path): both tracks are loaded on
 * Deck A/B, the overlap is performed with `frameAt` — the exact function Auto DJ uses for saved
 * transitions — and the mixer, decks and FX are snapshotted first and restored afterwards
 * (DJEngine.captureManualMashupSetup/restoreManualMashupSetup). A deck that is already playing something
 * else, or a running Auto DJ, blocks the preview until the user explicitly agrees to take the decks over.
 */
import { Emitter } from "../core/events";
import type { TrackInfo } from "../core/engine/types";
import type { DeckState, FxUnitState } from "../core/engine/DJEngine";
import type { ManualMashupSetup as ManualMashupSetupLike } from "../mashup/types";
import { camelotKey } from "../analysis/discovery";
import type { PreparationStore } from "../preparation/PreparationStore";
import { effectiveEnergy } from "../preparation/PreparationStore";
import type { DocStore } from "./DocStore";
import { EchoFx } from "./echoFx";
import { AutoCueService } from "./AutoCueService";
import type { CueSuggestionSet } from "./autocue";
import { configFromPreset, frameAt, presetById, ratesFor, snap, SYSTEM_PRESETS, withBars, type PreparedTransition, type TrackTiming, type TransitionConfig, type TransitionPreset } from "./transitionModel";
import { newId } from "./editor";
import { gridReliable, phraseOffsetBars } from "../preparation/beatGrid";

export interface LabTrack {
  ref: string; trackId: string; title: string; artist: string; artworkUrl?: string;
  bpm: number | null; key: string | null; camelot: string | null; energy: number | null; duration: number;
  timing: TrackTiming; hotcues: { slot: number; t: number; name: string; colour: string }[]; autoCues: CueSuggestionSet | null; available: boolean;
}
export interface Candidate { id: string; label: string; config: TransitionConfig; unavailable: string | null }
export type PreviewStatus = "idle" | "blocked" | "loading" | "playing" | "paused" | "error";
export interface PreviewState { status: PreviewStatus; message: string; loop: boolean; headphonesOnly: boolean; outDeck: number; inDeck: number; /** Wall-clock seconds relative to the start of the overlap (negative = pre-roll). */ time: number; blockedBy: "deck" | "autodj" | null }
export interface LabState {
  out: LabTrack | null; in: LabTrack | null;
  setId: string | null; fromSlotId: string | null; toSlotId: string | null;
  candidates: Candidate[]; selected: number;
  savedId: string | null; dirty: boolean; message: string;
  preview: PreviewState; canUndo: boolean; canRedo: boolean;
}

export interface LabEngine {
  getState(): { decks: DeckState[]; mixer: { crossfader: number; channels: { pfl: boolean }[] }; fx: FxUnitState[] };
  loadTrack(deck: number, t: TrackInfo, source?: "manual" | "auto-dj"): Promise<void>;
  seekTo(deck: number, s: number): void;
  getPosition(deck: number): number;
  setRateDirect(deck: number, rate: number): void;
  setKeylock(deck: number, on: boolean): void;
  setMaster(deck: number): void;
  setAutoEq(deck: number, db: { low: number; mid: number; high: number }): void;
  resetAutoEq(deck: number): void;
  setFxUnit(u: number, patch: Partial<FxUnitState>): void;
  captureManualMashupSetup(): ManualMashupSetupLike;
  restoreManualMashupSetup(s: ManualMashupSetupLike): void;
}
interface Deps {
  engine: LabEngine;
  send: (action: string, value?: number) => void;
  audioRouting: () => string;
  autoDJ: { getState(): { status: string }; stop(): void };
  library: { getByRef(ref: string): TrackInfo | null };
  preparation: Pick<PreparationStore, "forRef" | "get">;
  transitions: DocStore<PreparedTransition>;
  presets: DocStore<TransitionPreset>;
  log?: (level: "info" | "warn", m: string) => void;
  /** Timer injection for tests. */
  every?: (fn: () => void, ms: number) => () => void;
}

const PRE_SECONDS = 6, POST_SECONDS = 4, HISTORY = 50;

export class TransitionLabService extends Emitter<{ change: LabState }> {
  private s: LabState = { out: null, in: null, setId: null, fromSlotId: null, toSlotId: null, candidates: [], selected: 0, savedId: null, dirty: false, message: "",
    preview: { status: "idle", message: "", loop: false, headphonesOnly: false, outDeck: 0, inDeck: 1, time: 0, blockedBy: null }, canUndo: false, canRedo: false };
  private past: Candidate[][] = []; private future: Candidate[][] = [];
  private snapshot: ManualMashupSetupLike | null = null;
  private stopTimer: (() => void) | null = null;
  private echo: EchoFx;
  private inStarted = false;
  private syncEngaged = false;
  constructor(private d: Deps) { super(); this.echo = new EchoFx(d.engine); }
  /** A track's preparation changed (e.g. its beat grid was edited): refresh its card if it's on either side. */
  refreshTrack(trackId: string): void {
    const { out, in: inc } = this.s;
    if (out?.trackId !== trackId && inc?.trackId !== trackId) return;
    this.set({ out: out?.trackId === trackId ? this.track(out.ref) ?? out : out, in: inc?.trackId === trackId ? this.track(inc.ref) ?? inc : inc });
  }
  getState() { return this.s; }
  private set(p: Partial<LabState>) { this.s = { ...this.s, ...p }; this.emit("change", this.s); }
  private pv(p: Partial<PreviewState>) { this.set({ preview: { ...this.s.preview, ...p } }); }
  userPresets(): TransitionPreset[] { return this.d.presets.all(); }
  allPresets(): TransitionPreset[] { return [...SYSTEM_PRESETS, ...this.d.presets.all()]; }

  // ── Tracks ──
  track(ref: string): LabTrack | null {
    const t = this.d.library.getByRef(ref), r = this.d.preparation.forRef(ref);
    if (!t || !r) return null;
    const g = AutoCueService.gridOf(r);
    const reliable = gridReliable(g);
    return { ref, trackId: r.trackId, title: t.title, artist: t.artist, artworkUrl: t.artworkUrl, bpm: g?.bpm ?? r.bpm ?? t.bpm, key: r.key ?? t.key, camelot: camelotKey(r.key ?? t.key), energy: effectiveEnergy(r), duration: r.duration || (t.durationMs ?? 0) / 1000,
      timing: { bpm: g?.bpm ?? r.bpm ?? null, firstBeat: g?.firstBeat ?? null, gridReliable: reliable, duration: r.duration || (t.durationMs ?? 0) / 1000, phraseOffset: this.phraseOffset(r.autoCues, g, r.beatGrid?.phraseAnchor) },
      hotcues: r.cues.filter((c) => c.type === "hotcue").map((c) => ({ slot: c.slot, t: c.timestamp, name: c.name, colour: c.colour })), autoCues: r.autoCues ?? null, available: !t.unavailableReason };
  }
  /** Phrase offset (bars): a hand-marked phrase start (Beat grid editor) wins, else the Auto Cue first-phrase cue. */
  private phraseOffset(a: CueSuggestionSet | undefined, g: { bpm: number; firstBeat: number } | null, anchor?: number | null): number {
    if (g && anchor !== null && anchor !== undefined) return phraseOffsetBars(g, anchor);
    const fp = a?.cues.find((c) => c.cueType === "first-phrase");
    if (!fp || !g) return 0;
    return ((Math.round((fp.quantisedPosition - g.firstBeat) / (240 / g.bpm)) % 8) + 8) % 8;
  }
  private inputs(out: LabTrack, inc: LabTrack) {
    const cue = (t: LabTrack, type: string) => t.autoCues?.cues.find((c) => c.cueType === type && c.reviewStatus !== "rejected")?.quantisedPosition ?? null;
    return {
      out: out.timing, in: inc.timing,
      outMixOut: out.autoCues?.mixOut.find((m) => m.label === "Outro")?.start ?? out.autoCues?.mixOut[0]?.start ?? null,
      inMixIn: inc.autoCues?.mixIn[0]?.start ?? cue(inc, "first-beat"),
      outBreakdown: cue(out, "breakdown"), inDrop: cue(inc, "drop"),
    };
  }

  /** Open a pair. Loads the saved transition for this set/slots (or track pair) when there is one. */
  open(p: { outRef: string; inRef: string; setId?: string | null; fromSlotId?: string | null; toSlotId?: string | null }): void {
    if (this.s.preview.status === "playing" || this.s.preview.status === "paused") this.stop();
    const out = this.track(p.outRef), inc = this.track(p.inRef);
    if (!out || !inc) { this.set({ out, in: inc, candidates: [], message: !out || !inc ? "Both tracks must be in the library and analysed (open Library Intelligence → Analyse Library)." : "" }); return; }
    const saved = this.findSaved(out.trackId, inc.trackId, p.setId ?? null, p.fromSlotId ?? null);
    const base = { out, in: inc, setId: p.setId ?? null, fromSlotId: p.fromSlotId ?? null, toSlotId: p.toSlotId ?? null, dirty: false, message: "" };
    this.past = []; this.future = [];
    if (saved) {
      const other = this.fromPreset(saved.presetId === "bass-swap" ? "smooth" : "bass-swap", out, inc, saved);
      this.set({ ...base, savedId: saved.id, candidates: [{ id: newId("cand"), label: `A · ${saved.name}`, config: this.pick(saved), unavailable: null }, { ...other, label: `B · ${other.label}` }], selected: 0, canUndo: false, canRedo: false, message: `Loaded saved transition “${saved.name}” (v${saved.version}).` });
    } else {
      const a = this.fromPreset("smooth", out, inc), b = this.fromPreset("bass-swap", out, inc);
      this.set({ ...base, savedId: null, candidates: [{ ...a, label: `A · ${a.label}` }, { ...b, label: `B · ${b.label}` }], selected: 0, canUndo: false, canRedo: false });
    }
  }
  private pick(t: PreparedTransition): TransitionConfig {
    const { presetId, mixOut, mixIn, bars, seconds, syncMode, targetBpm, keyLock, phraseAlign, maxTempoPct, eqMode, crossfader, eq, effects } = t;
    return structuredClone({ presetId, mixOut, mixIn, bars, seconds, syncMode, targetBpm, keyLock, phraseAlign, maxTempoPct, eqMode, crossfader, eq, effects });
  }
  private fromPreset(id: string, out: LabTrack, inc: LabTrack, prev?: Partial<TransitionConfig>): Candidate {
    const preset = presetById(id, this.d.presets.all()) ?? SYSTEM_PRESETS[0];
    const { config, unavailable } = configFromPreset(preset, this.inputs(out, inc), prev);
    return { id: newId("cand"), label: preset.name, config, unavailable };
  }
  /** Back to the pair picker (stops a running preview first). */
  close(): void { this.stop(); this.past = []; this.future = []; this.set({ out: null, in: null, candidates: [], selected: 0, savedId: null, setId: null, fromSlotId: null, toSlotId: null, dirty: false, message: "", canUndo: false, canRedo: false }); }
  swap(): void { if (this.s.out && this.s.in) this.open({ outRef: this.s.in.ref, inRef: this.s.out.ref }); }
  findSaved(outId: string, inId: string, setId: string | null, fromSlotId: string | null): PreparedTransition | null {
    const all = this.d.transitions.all().filter((t) => t.outgoingTrackId === outId && t.incomingTrackId === inId);
    return (setId ? all.find((t) => t.setId === setId && (!fromSlotId || t.fromSlotId === fromSlotId)) : null) ?? (setId ? null : all.find((t) => t.setId === null)) ?? null;
  }
  savedForPair(): PreparedTransition[] {
    const { out, in: inc } = this.s;
    return out && inc ? this.d.transitions.all().filter((t) => t.outgoingTrackId === out.trackId && t.incomingTrackId === inc.trackId) : [];
  }

  // ── Editing (undoable, per candidate list) ──
  get current(): Candidate | null { return this.s.candidates[this.s.selected] ?? null; }
  private commit(candidates: Candidate[], undoable = true): void {
    if (undoable) { this.past.push(this.s.candidates); if (this.past.length > HISTORY) this.past.shift(); this.future = []; }
    this.set({ candidates, dirty: true, canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
    if (!this.gesture && (this.s.preview.status === "playing" || this.s.preview.status === "paused")) this.seek(this.s.preview.time); // re-apply live
  }
  private gesture: Candidate[] | null = null;
  beginGesture() { this.gesture = this.s.candidates; }
  endGesture() {
    if (this.gesture && this.gesture !== this.s.candidates) { this.past.push(this.gesture); this.future = []; this.set({ canUndo: true, canRedo: false }); }
    this.gesture = null;
    if (this.s.preview.status === "playing" || this.s.preview.status === "paused") this.seek(this.s.preview.time);
  }
  undo() { const p = this.past.pop(); if (!p) return; this.future.push(this.s.candidates); this.set({ candidates: p, selected: Math.min(this.s.selected, p.length - 1), canUndo: this.past.length > 0, canRedo: true, dirty: true }); }
  redo() { const f = this.future.pop(); if (!f) return; this.past.push(this.s.candidates); this.set({ candidates: f, selected: Math.min(this.s.selected, f.length - 1), canUndo: true, canRedo: this.future.length > 0, dirty: true }); }
  update(patch: Partial<TransitionConfig>, undoable = true): void {
    const c = this.current; if (!c || !this.s.out || !this.s.in) return;
    let config = { ...c.config, ...patch };
    if (patch.syncMode !== undefined || patch.targetBpm !== undefined) config = withBars(config, config.bars ?? 16, this.s.out.timing, this.s.in.timing);
    this.commit(this.s.candidates.map((x, i) => (i === this.s.selected ? { ...x, config: { ...config, presetId: patch.presetId ?? (Object.keys(patch).some((k) => ["crossfader", "eq", "effects"].includes(k)) ? "custom" : config.presetId) } } : x)), !this.gesture && undoable);
  }
  setBars(bars: number): void { const c = this.current; if (c && this.s.out && this.s.in) this.update(withBars(c.config, bars, this.s.out.timing, this.s.in.timing)); }
  /** Move the mix-out/mix-in point; snaps to the grid per the sync/phrase settings (Shift-free fine moves: snap "none"). */
  movePoint(side: "out" | "in", t: number, snapTo: "none" | "beat" | "bar" | "phrase" = "beat"): void {
    const c = this.current, tr = side === "out" ? this.s.out : this.s.in; if (!c || !tr) return;
    const unit = snapTo === "none" ? null : c.config.phraseAlign && snapTo !== "beat" ? "phrase" : snapTo;
    const v = Math.max(0, Math.min(tr.duration - 1, unit ? snap(t, tr.timing, unit) : t));
    this.update(side === "out" ? { mixOut: v } : { mixIn: v });
  }
  applyPreset(id: string): void {
    const c = this.current, { out, in: inc } = this.s; if (!c || !out || !inc) return;
    const n = this.fromPreset(id, out, inc, c.config);
    this.commit(this.s.candidates.map((x, i) => (i === this.s.selected ? { ...x, config: n.config, unavailable: n.unavailable, label: `${x.label.split(" · ")[0]} · ${n.label}` } : x)));
  }
  select(i: number): void {
    if (i < 0 || i >= this.s.candidates.length) return;
    const t = this.s.preview.time, live = this.s.preview.status === "playing" || this.s.preview.status === "paused";
    this.set({ selected: i });
    if (live) this.seek(t); // compare: same position, other configuration
  }
  addCandidate(presetId = "smooth"): void {
    const { out, in: inc } = this.s; if (!out || !inc) return;
    const n = this.fromPreset(presetId, out, inc), letter = String.fromCharCode(65 + this.s.candidates.length);
    this.commit([...this.s.candidates, { ...n, label: `${letter} · ${n.label}` }]);
    this.set({ selected: this.s.candidates.length - 1 });
  }
  duplicateCandidate(): void {
    const c = this.current; if (!c) return;
    this.commit([...this.s.candidates, { ...structuredClone(c), id: newId("cand"), label: `${String.fromCharCode(65 + this.s.candidates.length)} · copy of ${c.label.split(" · ")[1] ?? c.label}` }]);
    this.set({ selected: this.s.candidates.length - 1 });
  }
  removeCandidate(i: number): void { if (this.s.candidates.length <= 1) return; this.commit(this.s.candidates.filter((_, k) => k !== i)); this.set({ selected: Math.min(this.s.selected, this.s.candidates.length - 1) }); }

  /** Save the selected candidate's automation as a reusable preset. */
  savePreset(name: string, description = ""): TransitionPreset | null {
    const c = this.current; if (!c || !name.trim()) return null;
    const now = Date.now();
    const { crossfader, eq, effects, eqMode, syncMode, bars, phraseAlign } = c.config;
    return this.d.presets.save({ id: newId("preset"), name: name.trim(), description, isSystemPreset: false, config: structuredClone({ crossfader, eq, effects, eqMode: eqMode === "automatic" ? "preset" : eqMode, syncMode, bars: bars ?? 16, phraseAlign }), createdAt: now, updatedAt: now });
  }

  /** Save the selected candidate as the prepared transition for this set/slots (or track pair). Re-saving bumps the version. */
  save(name: string, notes = ""): PreparedTransition | null {
    const c = this.current, { out, in: inc } = this.s; if (!c || !out || !inc) return null;
    const now = Date.now();
    const existing = this.s.savedId ? this.d.transitions.get(this.s.savedId) : this.findSaved(out.trackId, inc.trackId, this.s.setId, this.s.fromSlotId);
    const outRec = this.d.preparation.get(out.trackId), inRec = this.d.preparation.get(inc.trackId);
    const t: PreparedTransition = {
      ...structuredClone(c.config), schemaVersion: 1, id: existing?.id ?? newId("trans"), name: name.trim() || c.label.split(" · ")[1] || "Transition",
      setId: this.s.setId, fromSlotId: this.s.fromSlotId, toSlotId: this.s.toSlotId, outgoingTrackId: out.trackId, incomingTrackId: inc.trackId,
      outRef: out.ref, inRef: inc.ref, outTitle: out.title, inTitle: inc.title, notes,
      version: (existing?.version ?? 0) + 1,
      history: existing ? [{ version: existing.version, savedAt: existing.updatedAt, config: this.pick(existing) }, ...existing.history].slice(0, 10) : [],
      analysisVersion: { out: outRec?.analysedAt ?? null, in: inRec?.analysedAt ?? null }, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.d.transitions.save(t);
    this.set({ savedId: t.id, dirty: false, message: `Saved “${t.name}” (v${t.version})${t.setId ? " for this set" : ""}. Auto DJ will use it for this pair.` });
    return t;
  }
  /** Bring back an earlier saved version as a new candidate (nothing is overwritten until you save). */
  restoreVersion(version: number): void {
    const t = this.s.savedId ? this.d.transitions.get(this.s.savedId) : null, h = t?.history.find((x) => x.version === version);
    if (!h) return;
    this.commit([...this.s.candidates, { id: newId("cand"), label: `${String.fromCharCode(65 + this.s.candidates.length)} · v${version}`, config: structuredClone(h.config), unavailable: null }]);
    this.set({ selected: this.s.candidates.length - 1 });
  }
  async removeSaved(id: string): Promise<void> { await this.d.transitions.remove(id); if (this.s.savedId === id) this.set({ savedId: null }); }

  // ── Preview on the real decks ──
  private every(fn: () => void, ms: number) { if (this.d.every) return this.d.every(fn, ms); const h = setInterval(fn, ms); return () => clearInterval(h); }
  rates() { const c = this.current, { out, in: inc } = this.s; return c && out && inc ? ratesFor(c.config, out.timing, inc.timing) : null; }
  private foreign(): number {
    const ours = this.snapshot !== null;
    return this.d.engine.getState().decks.findIndex((d, i) => d.playing && !(ours && (i === this.s.preview.outDeck || i === this.s.preview.inDeck)));
  }
  setLoop(on: boolean) { this.pv({ loop: on }); }
  headphonesAvailable() { return this.d.audioRouting() === "quad"; }
  setHeadphonesOnly(on: boolean) {
    if (on && !this.headphonesAvailable()) { this.pv({ message: "Headphones-only preview needs 4-channel routing (Settings → Audio → Routing → 4 channels)." }); return; }
    this.pv({ headphonesOnly: on });
    if (this.snapshot) this.applyRouting();
  }
  private applyRouting() {
    if (!this.snapshot) return;
    const ch = this.d.engine.getState().mixer.channels;
    if (this.s.preview.headphonesOnly) {
      this.d.send("mixer.master.level", 0);
      this.d.send("mixer.headphone.mix", 0);
      for (const deck of [this.s.preview.outDeck, this.s.preview.inDeck]) if (!ch[deck]?.pfl) this.d.send(`mixer.channel${deck + 1}.cue`, 1);
    } else {
      const m = this.snapshot.mixer, chs = this.snapshot.channels;
      this.d.send("mixer.master.level", m.masterLevel);
      this.d.send("mixer.headphone.mix", m.headMix);
      for (const deck of [this.s.preview.outDeck, this.s.preview.inDeck]) if (!!ch[deck]?.pfl !== !!chs[deck]?.pfl) this.d.send(`mixer.channel${deck + 1}.cue`, 1);
    }
  }

  /**
   * Start (or resume) the preview. `takeOver`: the user agreed to stop whatever is playing on the decks.
   * `stopAutoDJ`: the user explicitly agreed to switch Auto DJ off (and so to stop the decks) — a deck
   * take-over alone never stops a running Auto DJ.
   */
  async play(opts: { takeOver?: boolean; stopAutoDJ?: boolean; from?: number } = {}): Promise<void> {
    const c = this.current, { out, in: inc } = this.s;
    if (!c || !out || !inc) return;
    if (this.d.autoDJ.getState().status !== "OFF") {
      if (!opts.stopAutoDJ) { this.pv({ status: "blocked", blockedBy: "autodj", message: "Auto DJ is running. The preview needs both decks, so Auto DJ has to stop first." }); return; }
      this.d.autoDJ.stop();
      this.d.log?.("info", "Auto DJ stopped to preview a transition");
      opts = { ...opts, takeOver: true };
    }
    if (this.s.preview.status === "paused" && this.snapshot) { this.resume(); return; }
    const live = this.foreign();
    if (live >= 0 && !opts.takeOver) { this.pv({ status: "blocked", blockedBy: "deck", message: `Deck ${String.fromCharCode(65 + live)} is playing. Preview uses both decks and the mixer — stopping it would interrupt the mix.` }); return; }
    if (!out.available || !inc.available) { this.pv({ status: "error", message: "A track's file is missing — reconnect it in the library." }); return; }
    const e = this.d.engine;
    for (const d of e.getState().decks) if (d.playing) this.d.send(`deck${d.index + 1}.play`, 1);
    const decks = e.getState().decks;
    // Keep the outgoing track where it already is (if it is on Deck B), otherwise Deck A.
    const outDeck = decks[1]?.track?.ref === out.ref && decks[0]?.track?.ref !== out.ref ? 1 : 0;
    const inDeck = outDeck === 0 ? 1 : 0;
    this.pv({ status: "loading", blockedBy: null, message: "Loading both tracks onto the decks…", outDeck, inDeck });
    if (!this.snapshot) this.snapshot = e.captureManualMashupSetup();
    try {
      for (const [deck, t] of [[outDeck, out], [inDeck, inc]] as const) {
        if (e.getState().decks[deck].track?.ref === t.ref && e.getState().decks[deck].status === "ready") continue;
        const info = this.d.library.getByRef(t.ref);
        if (!info) throw new Error(`${t.title} isn't in the library`);
        await e.loadTrack(deck, info);
        if (e.getState().decks[deck].status !== "ready") throw new Error(`Couldn't load ${t.title}: ${e.getState().decks[deck].error ?? "unknown error"}`);
      }
      // Clean mixer: both channels up and flat, crossfader on the outgoing side.
      for (const deck of [outDeck, inDeck]) {
        for (const k of ["eq.low", "eq.mid", "eq.high", "filter"]) this.d.send(`mixer.channel${deck + 1}.${k}`, 0.5);
        this.d.send(`mixer.channel${deck + 1}.volume`, 1);
        if (e.getState().decks[deck].sync) this.d.send(`deck${deck + 1}.sync`, 1);
        e.resetAutoEq(deck);
      }
      this.applyRouting();
      this.applyTempo();
      this.seek(opts.from ?? -Math.min(PRE_SECONDS, Math.max(2, c.config.seconds / 3)));
      this.startDecks();
      this.pv({ status: "playing", message: "" });
      this.stopTimer?.();
      this.stopTimer = this.every(() => this.tick(), 20);
    } catch (err) {
      this.stop();
      this.pv({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  private applyTempo() {
    const r = this.rates(), c = this.current, e = this.d.engine, { outDeck, inDeck } = this.s.preview;
    if (!r || !c) return;
    e.setRateDirect(outDeck, r.outRate);
    e.setRateDirect(inDeck, r.inRate);
    e.setKeylock(outDeck, c.config.keyLock);
    e.setKeylock(inDeck, c.config.keyLock);
  }
  private startDecks() {
    const { outDeck, inDeck, time } = this.s.preview, e = this.d.engine;
    if (!e.getState().decks[outDeck].playing && time < (this.current?.config.seconds ?? 0)) this.d.send(`deck${outDeck + 1}.play`, 1);
    if (time >= 0 && !e.getState().decks[inDeck].playing) { this.d.send(`deck${inDeck + 1}.play`, 1); this.inStarted = true; this.engageSync(); }
  }
  private engageSync() {
    const r = this.rates(), e = this.d.engine, { outDeck, inDeck } = this.s.preview;
    if (!r?.synced || this.syncEngaged) return;
    e.setMaster(outDeck);
    if (!e.getState().decks[inDeck].sync) this.d.send(`deck${inDeck + 1}.sync`, 1);
    this.syncEngaged = true;
  }
  pause(): void {
    if (this.s.preview.status !== "playing") return;
    for (const d of [this.s.preview.outDeck, this.s.preview.inDeck]) if (this.d.engine.getState().decks[d].playing) this.d.send(`deck${d + 1}.play`, 1);
    this.stopTimer?.(); this.stopTimer = null;
    this.pv({ status: "paused" });
  }
  private resume(): void { this.startDecks(); this.pv({ status: "playing" }); this.stopTimer?.(); this.stopTimer = this.every(() => this.tick(), 20); }
  preRoll(): number { return -Math.min(PRE_SECONDS, Math.max(2, (this.current?.config.seconds ?? 8) / 3)); }
  restart(): void {
    if (this.snapshot && (this.s.preview.status === "playing" || this.s.preview.status === "paused")) { this.seek(this.preRoll()); if (this.s.preview.status === "paused") this.resume(); }
    else void this.play({ from: this.preRoll() });
  }

  /** Jump to `time` (wall-clock seconds from the start of the overlap); both decks are positioned to match. */
  seek(time: number): void {
    const c = this.current, { outDeck, inDeck } = this.s.preview, e = this.d.engine, r = this.rates();
    if (!c || !r) return;
    const secs = c.config.seconds, t = Math.max(-PRE_SECONDS, Math.min(secs + POST_SECONDS, time));
    e.seekTo(outDeck, Math.max(0, c.config.mixOut + t * r.outRate));
    e.seekTo(inDeck, Math.max(0, c.config.mixIn + Math.max(0, t) * r.inRate));
    this.inStarted = t >= 0;
    this.pv({ time: t });
    this.applyFrame(Math.max(0, Math.min(1, t / secs)), t);
    if (this.s.preview.status === "playing") {
      const playing = (d: number) => e.getState().decks[d].playing;
      if (t < 0 && playing(inDeck)) this.d.send(`deck${inDeck + 1}.play`, 1);
      if (t >= 0 && t < secs + POST_SECONDS && !playing(inDeck)) { this.d.send(`deck${inDeck + 1}.play`, 1); this.engageSync(); }
      if (t < secs && !playing(outDeck)) this.d.send(`deck${outDeck + 1}.play`, 1);
      if (t >= secs && playing(outDeck)) this.d.send(`deck${outDeck + 1}.play`, 1);
    }
  }
  private applyFrame(p: number, time: number) {
    const c = this.current, { outDeck, inDeck } = this.s.preview, e = this.d.engine;
    if (!c) return;
    const f = frameAt(c.config, time < 0 ? 0 : p);
    this.d.send("mixer.crossfader", outDeck === 0 ? f.crossfader : 1 - f.crossfader);
    e.setAutoEq(outDeck, f.out);
    e.setAutoEq(inDeck, f.in);
    this.echo.set(outDeck, f.echo);
  }
  private tick(): void {
    const c = this.current, r = this.rates(), { outDeck, inDeck } = this.s.preview, e = this.d.engine;
    if (!c || !r || this.s.preview.status !== "playing") return;
    const secs = c.config.seconds;
    // Clock: the outgoing deck's audio position until the overlap ends, then the incoming deck's.
    const time = this.s.preview.time < secs ? (e.getPosition(outDeck) - c.config.mixOut) / r.outRate : secs + (e.getPosition(inDeck) - (c.config.mixIn + secs * r.inRate)) / r.inRate;
    if (time >= 0 && !this.inStarted) {
      e.seekTo(inDeck, c.config.mixIn + time * r.inRate);
      this.d.send(`deck${inDeck + 1}.play`, 1);
      this.inStarted = true;
      this.engageSync();
    }
    this.applyFrame(Math.max(0, Math.min(1, time / secs)), time);
    if (time >= secs && e.getState().decks[outDeck].playing) this.d.send(`deck${outDeck + 1}.play`, 1);
    this.pv({ time });
    if (time >= secs + POST_SECONDS) {
      if (this.s.preview.loop) this.seek(-Math.min(PRE_SECONDS, Math.max(2, secs / 3)));
      else { this.stop(); this.pv({ message: "Preview finished — the decks and mixer are back as they were." }); }
    }
  }
  /** Stop and put the decks, mixer and FX back exactly as they were before the preview. */
  stop(): void {
    this.stopTimer?.(); this.stopTimer = null;
    // Nothing was taken over: never touch decks the preview didn't start.
    if (!this.snapshot) { if (this.s.preview.status !== "idle") this.pv({ status: "idle", blockedBy: null, time: 0, message: "" }); return; }
    const e = this.d.engine, { outDeck, inDeck } = this.s.preview;
    for (const d of [outDeck, inDeck]) if (e.getState().decks[d]?.playing) this.d.send(`deck${d + 1}.play`, 1);
    this.echo.restore();
    for (const d of [outDeck, inDeck]) e.resetAutoEq(d);
    if (this.snapshot) { e.restoreManualMashupSetup(this.snapshot); this.snapshot = null; }
    this.inStarted = false; this.syncEngaged = false;
    this.pv({ status: "idle", blockedBy: null, time: 0, message: "" });
  }
  dismissBlock(): void { this.pv({ status: "idle", blockedBy: null, message: "" }); }
}

/**
 * Transition Intelligence service: pairing, analysis facts, plans, persistence and rehearsal.
 *
 *   library + preparation (grids, key, sections) + waveform (bar energy) + STEMS (vocals)
 *        → TrackFacts → planner.buildPlan → plan, techniques, steps, warnings
 *
 * Plans are saved against stable track IDs (content hashes) with the user's choices and
 * manual corrections, plus an analysis stamp: when a track's analysis or grid changes, the
 * plan is recalculated and the user is told. Rehearsal uses the two decks, but never takes
 * over a deck that's playing in a live mix without an explicit "stop decks" action.
 */
import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { DJEngine } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import type { AnalysisService } from "../analysis/AnalysisService";
import type { LibraryStore } from "../library/LibraryStore";
import type { PreparationStore } from "../preparation/PreparationStore";
import type { StemService } from "../stems/StemService";
import type { EventLog } from "../core/log";
import {
  barEnergyFrom, barLength, beatLength, buildPlan, DEFAULT_SETTINGS, missingAnalysis, rehearsalCue, technique, techniqueOptions, timeAtBar,
  type Grid, type PlanSettings, type RehearsalCue, type TechniqueOption, type TrackFacts, type TransitionPlan,
} from "./planner";
import { regionsFromEnvelope, vocalEnvelopeFromStems } from "./vocals";

export type Side = "out" | "in";
export type Job = { kind: "analyse" | "vocals" | "stems"; stage: string } | { kind: "error"; stage: string };

export interface SavedPlan {
  key: string;
  outTrackId: string;
  inTrackId: string;
  outRef: string;
  inRef: string;
  outTitle: string;
  inTitle: string;
  settings: PlanSettings;
  stamps: { out: string; in: string };
  savedAt: number;
  summary: string;
}

export type RehearsalStatus = "off" | "blocked" | "preparing" | "ready" | "running" | "error";
export interface RehearsalState {
  status: RehearsalStatus;
  message: string;
  outDeck: number;
  inDeck: number;
  leadBars: number;
  /** How early (−) or late (+) Track B was started, in ms and beats (measured from the audio clock). */
  startError: { ms: number; beats: number } | null;
}

export interface TransitionState {
  outRef: string | null;
  inRef: string | null;
  out: TrackFacts | null;
  in: TrackFacts | null;
  settings: PlanSettings;
  options: TechniqueOption[];
  plan: TransitionPlan | null;
  /** Why there's no plan (missing analysis, unavailable technique…). */
  problem: string | null;
  missing: string[];
  jobs: Record<string, Job>;
  saved: SavedPlan[];
  /** The open plan is saved (and auto-saves). */
  savedKey: string | null;
  notice: string | null;
  rehearsal: RehearsalState;
  /** STEMS separation works on this computer (vocal detection / stem techniques possible). */
  stemsAvailable: boolean;
}

const PLANS_KEY = "dbdj.transitions.v1";
const VOCALS_KEY = "dbdj.vocals.v1";

interface Deps {
  engine: DJEngine;
  bus: CommandBus;
  library: LibraryStore;
  preparation: PreparationStore;
  analysis: AnalysisService;
  stems: StemService;
  log: EventLog;
  readAudio: (ref: string) => Promise<ArrayBuffer>;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

const stampOf = (f: TrackFacts | null) => (f ? [f.analysed ? "a" : "-", f.grid?.bpm.toFixed(3), f.grid?.firstBeat.toFixed(4), f.grid?.manual ? "m" : "", f.vocals ? f.vocals.length : "v?"].join("|") : "");
const planKey = (outId: string, inId: string) => `${outId}>${inId}`;

export class TransitionService extends Emitter<{ change: TransitionState }> {
  private s: TransitionState;
  private vocals: Record<string, [number, number][]> = {};
  private storage: Deps["storage"];
  private refreshToken = 0;
  private watching = 0;

  constructor(private d: Deps) {
    super();
    this.storage = d.storage !== undefined ? d.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    this.vocals = this.read(VOCALS_KEY, {});
    this.s = {
      outRef: null, inRef: null, out: null, in: null, settings: { ...DEFAULT_SETTINGS }, options: [], plan: null, problem: null, missing: [],
      jobs: {}, saved: this.read<SavedPlan[]>(PLANS_KEY, []), savedKey: null, notice: null,
      rehearsal: { status: "off", message: "", outDeck: 0, inDeck: 1, leadBars: 8, startError: null },
      stemsAvailable: false,
    };
    // Analysis or grid changes for either track → recalculate (and say so).
    d.preparation.on("record", (r) => {
      if (r.refs.includes(this.s.outRef ?? "\0") || r.refs.includes(this.s.inRef ?? "\0")) void this.refresh(true);
    });
  }

  getState(): TransitionState {
    return this.s;
  }

  private set(patch: Partial<TransitionState>): void {
    this.s = { ...this.s, ...patch };
    this.emit("change", this.s);
  }

  private read<T>(key: string, fallback: T): T {
    try {
      const v = JSON.parse(this.storage?.getItem(key) ?? "null");
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }
  private write(key: string, value: unknown): void {
    try { this.storage?.setItem(key, JSON.stringify(value)); } catch { /* storage full/unavailable */ }
  }

  // ─────────────────────────── pairing ───────────────────────────

  setTrack(side: Side, ref: string | null): void {
    this.set(side === "out" ? { outRef: ref } : { inRef: ref });
    this.set({ settings: { ...this.s.settings, outStartBar: null, inCueBar: null }, savedKey: null, notice: null });
    void this.refresh(false);
  }

  swap(): void {
    this.set({ outRef: this.s.inRef, inRef: this.s.outRef, settings: { ...this.s.settings, outStartBar: null, inCueBar: null, outPhraseOffset: this.s.settings.inPhraseOffset, inPhraseOffset: this.s.settings.outPhraseOffset }, savedKey: null, notice: null });
    void this.refresh(false);
  }

  /** Pairing from the decks: the playing (or deck A) track out, the other deck's track in. */
  useDecks(): void {
    const decks = this.d.engine.getState().decks;
    const loaded = decks.filter((x) => x.status === "ready" && x.track?.source === "local");
    if (loaded.length < 2) return this.set({ notice: "Load a local track on both decks to use them here." });
    const out = loaded.find((x) => x.playing) ?? loaded[0];
    const inc = loaded.find((x) => x !== out)!;
    this.set({ outRef: out.track!.ref, inRef: inc.track!.ref, settings: { ...this.s.settings, outStartBar: null, inCueBar: null, targetBpm: null }, savedKey: null, notice: null });
    void this.refresh(false);
  }

  setSettings(patch: Partial<PlanSettings>): void {
    const settings = { ...this.s.settings, ...patch };
    if (patch.technique && !patch.bars) settings.bars = technique(patch.technique).lengths.includes(settings.bars) ? settings.bars : technique(patch.technique).defaultBars;
    this.set({ settings });
    this.recalc();
  }

  /** Move a transition point by whole bars (1 = one bar, 8 = one phrase). */
  movePoint(side: Side, bars: number): void {
    const p = this.s.plan;
    if (!p) return;
    if (side === "out") this.setSettings({ outStartBar: Math.max(0, p.outStartBar + bars) });
    else this.setSettings({ inCueBar: Math.max(0, p.inCueBar + bars) });
  }

  resetPoints(): void {
    this.setSettings({ outStartBar: null, inCueBar: null });
  }

  /** Phrase marker correction: phrases start this many bars after the grid's first bar. */
  movePhrase(side: Side, delta: number): void {
    const k = side === "out" ? "outPhraseOffset" : "inPhraseOffset";
    this.setSettings({ [k]: (((this.s.settings[k] + delta) % 8) + 8) % 8, ...(side === "out" ? { outStartBar: null } : { inCueBar: null }) });
  }

  /** Beat-grid correction: shift the downbeat by whole beats, or nudge by milliseconds. */
  nudgeGrid(side: Side, by: { beats?: number; ms?: number; bpm?: number }): void {
    const f = side === "out" ? this.s.out : this.s.in;
    if (!f?.grid) return;
    const g = f.grid;
    const bpm = Math.round((g.bpm + (by.bpm ?? 0)) * 1000) / 1000;
    let first = g.firstBeat + (by.beats ?? 0) * beatLength(g.bpm) + (by.ms ?? 0) / 1000;
    if (first < 0) first += barLength(g.bpm);
    const r = this.d.preparation.editGrid(f.trackId, bpm, first);
    if (r) this.d.engine.refreshPreparation(r.trackId, this.d.preparation.fields(r));
  }

  // ─────────────────────────── facts ───────────────────────────

  private async facts(ref: string | null): Promise<TrackFacts | null> {
    if (!ref) return null;
    const t = this.d.library.getByRef(ref);
    const r = this.d.preparation.forRef(ref);
    if (!t && !r) return null;
    const duration = r?.duration || (t?.durationMs ?? 0) / 1000;
    const grid: Grid | null = r?.beatGrid && r.beatGrid.bpm > 0 ? { bpm: r.beatGrid.bpm, firstBeat: r.beatGrid.firstBeat, confidence: r.beatGrid.confidence, manual: !!r.beatGrid.manuallyAdjusted } : null;
    let barEnergy: number[] | null = null;
    if (r && grid && r.analysisVersion !== null) {
      const w = await this.d.preparation.waveform(r.trackId).catch(() => null);
      if (w?.low.length) {
        const e = new Float32Array(w.low.length);
        for (let i = 0; i < e.length; i++) e[i] = w.low[i] + 0.6 * w.mid[i];
        barEnergy = barEnergyFrom(e, w.fps, grid, duration);
      }
    }
    return {
      trackId: r?.trackId ?? `ref:${ref}`,
      ref,
      title: t?.title ?? r?.title ?? ref,
      artist: t?.artist ?? r?.artist ?? "",
      duration,
      grid,
      key: r?.key ?? t?.key ?? null,
      keyConfidence: r?.keyConfidence ?? 0,
      energy: r?.energy ?? null,
      sections: r?.sections ?? [],
      cues: r?.recommendedCues ?? [],
      barEnergy,
      vocals: r ? this.vocals[r.trackId] ?? null : null,
      stemsCached: this.d.stems.index()[ref] === "complete",
      analysed: !!r && r.analysisVersion !== null,
    };
  }

  private async refresh(analysisChanged: boolean): Promise<void> {
    const token = ++this.refreshToken;
    const [out, inc] = await Promise.all([this.facts(this.s.outRef), this.facts(this.s.inRef)]);
    if (token !== this.refreshToken) return;
    const saved = this.s.savedKey ? this.s.saved.find((p) => p.key === this.s.savedKey) : null;
    let notice = this.s.notice;
    if (saved && (stampOf(out) !== saved.stamps.out || stampOf(inc) !== saved.stamps.in)) notice = "Track analysis changed since this plan was saved — the plan was recalculated (your technique, length and manual points are kept).";
    else if (analysisChanged && this.s.plan) notice = "Track analysis changed — the plan was recalculated.";
    this.set({ out, in: inc, notice, stemsAvailable: this.d.stems.status.available });
    this.recalc();
  }

  private recalc(): void {
    const { out, in: inc, settings } = this.s;
    const missing = missingAnalysis(out, inc);
    if (missing.length || !out || !inc) return this.set({ plan: null, options: [], missing, problem: missing.join(" · ") || null });
    const options = techniqueOptions(out, inc, settings, this.d.stems.status.available);
    const p = buildPlan(out, inc, settings, this.d.stems.status.available);
    this.set({ options, missing, plan: "error" in p ? null : p, problem: "error" in p ? p.error : null });
    if (this.s.savedKey && !("error" in p)) this.persist();
  }

  // ─────────────────────────── analysis & vocals ───────────────────────────

  private job(ref: string, j: Job | null): void {
    const jobs = { ...this.s.jobs };
    if (j) jobs[ref] = j;
    else delete jobs[ref];
    this.set({ jobs });
  }

  /** Run the missing analysis for a track (with stages shown). */
  async analyse(side: Side): Promise<void> {
    const ref = side === "out" ? this.s.outRef : this.s.inRef;
    const t = ref ? this.d.library.getByRef(ref) : null;
    if (!ref || !t) return;
    const label = { reading: "Reading the file…", decoding: "Decoding audio…", analysing: "Analysing beats, key and phrases…", done: "Done" };
    try {
      await this.d.analysis.analyseOne(t, (stage) => this.job(ref, { kind: "analyse", stage: label[stage] }));
      this.job(ref, null);
      await this.refresh(false);
    } catch (e) {
      this.job(ref, { kind: "error", stage: `Analysis failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** Vocal activity from STEMS: the deck's live envelope, the STEMS cache, or by separating first. */
  async detectVocals(side: Side): Promise<void> {
    const f = side === "out" ? this.s.out : this.s.in;
    if (!f || f.trackId.startsWith("ref:")) return;
    const ref = f.ref;
    try {
      const deck = this.d.engine.getState().decks.findIndex((x) => x.track?.trackId === f.trackId && x.stems.status === "ready");
      const env = deck >= 0 ? this.d.stems.envelopes(deck) : null;
      let regions: [number, number][] | null = null;
      if (env && env.vocals.length * env.hop >= f.duration * 0.95) regions = regionsFromEnvelope(env.vocals, env.hop);
      else if (this.d.stems.index()[ref] === "complete") {
        this.job(ref, { kind: "vocals", stage: "Reading cached STEMS…" });
        const data = await this.d.stems.renderData(ref);
        this.job(ref, { kind: "vocals", stage: "Finding vocal phrases…" });
        regions = regionsFromEnvelope(vocalEnvelopeFromStems(new Int16Array(data.pcm), data.rate), 0.1);
      } else if (this.d.stems.status.available) {
        const t = this.d.library.getByRef(ref);
        if (!t) return;
        this.job(ref, { kind: "stems", stage: "Separating STEMS (vocals) in the background…" });
        this.d.stems.analyse([t], this.d.readAudio);
        await this.waitForStems(ref);
        return this.detectVocals(side);
      } else throw new Error("STEMS separation isn't available, so vocals can't be detected");
      this.vocals = { ...this.vocals, [f.trackId]: regions };
      this.write(VOCALS_KEY, this.vocals);
      this.job(ref, null);
      await this.refresh(false);
    } catch (e) {
      this.job(ref, { kind: "error", stage: e instanceof Error ? e.message : String(e) });
    }
  }

  private async waitForStems(ref: string): Promise<void> {
    for (let i = 0; i < 1800; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await this.d.stems.refreshIndex().catch(() => undefined);
      if (this.d.stems.index()[ref] === "complete") return;
    }
    throw new Error("STEMS separation didn't finish");
  }

  // ─────────────────────────── saved plans ───────────────────────────

  save(): void {
    if (!this.s.out || !this.s.in || !this.s.plan) return;
    this.set({ savedKey: planKey(this.s.out.trackId, this.s.in.trackId), notice: null });
    this.persist();
  }

  private persist(): void {
    const { out, in: inc, plan, settings } = this.s;
    if (!out || !inc || !plan) return;
    const key = planKey(out.trackId, inc.trackId);
    const rec: SavedPlan = { key, outTrackId: out.trackId, inTrackId: inc.trackId, outRef: out.ref, inRef: inc.ref, outTitle: out.title, inTitle: inc.title, settings, stamps: { out: stampOf(out), in: stampOf(inc) }, savedAt: Date.now(), summary: plan.summary };
    const saved = [rec, ...this.s.saved.filter((p) => p.key !== key)];
    this.write(PLANS_KEY, saved);
    this.set({ saved });
  }

  open(key: string): void {
    const p = this.s.saved.find((x) => x.key === key);
    if (!p) return;
    // Refs can change (file moved); the track ID is what the plan belongs to.
    const refFor = (id: string, ref: string) => (this.d.preparation.get(id)?.refs.find((r) => this.d.library.getByRef(r)) ?? ref);
    this.set({ outRef: refFor(p.outTrackId, p.outRef), inRef: refFor(p.inTrackId, p.inRef), settings: { ...DEFAULT_SETTINGS, ...p.settings }, savedKey: key, notice: null });
    void this.refresh(false);
  }

  remove(key: string): void {
    const saved = this.s.saved.filter((p) => p.key !== key);
    this.write(PLANS_KEY, saved);
    this.set({ saved, savedKey: this.s.savedKey === key ? null : this.s.savedKey });
  }

  // ─────────────────────────── waveform markers ───────────────────────────

  /** Plan points for a track on the scrolling waveform. */
  markersFor(trackId: string | undefined): { t: number; label: string; colour: string }[] {
    const p = this.s.plan;
    const { out, in: inc } = this.s;
    if (!p || !trackId || !out?.grid || !inc?.grid) return [];
    const outGrid = out.grid;
    const m: { t: number; label: string; colour: string }[] = [];
    if (trackId === out.trackId) {
      m.push({ t: timeAtBar(outGrid, p.bStartsAtBar), label: "B ▶", colour: "#ff9f43" });
      if (p.outStart !== timeAtBar(outGrid, p.bStartsAtBar)) m.push({ t: p.outStart, label: "MIX", colour: "#ff9f43" });
      if (p.swapAtBar) m.push({ t: timeAtBar(outGrid, p.outStartBar + p.swapAtBar - 1), label: "BASS", colour: "#ffd166" });
      m.push({ t: p.outEnd, label: "A OUT", colour: "#ff6b6b" });
    }
    if (trackId === inc.trackId) {
      m.push({ t: p.inCue, label: "B IN", colour: "#2ee59d" });
      if (p.swapAtBar) m.push({ t: p.inCue + (p.swapAtBar - 1) * barLength(p.targetBpm) * p.inRate, label: "BASS", colour: "#ffd166" });
      if (p.inEnd > p.inCue) m.push({ t: p.inEnd, label: "B SOLO", colour: "#2ee59d" });
    }
    return m;
  }

  // ─────────────────────────── rehearsal ───────────────────────────

  private reh(patch: Partial<RehearsalState>): void {
    this.set({ rehearsal: { ...this.s.rehearsal, ...patch } });
  }

  setLeadBars(n: number): void {
    this.reh({ leadBars: Math.max(1, Math.min(32, Math.round(n))) });
  }

  private decksFor(): { outDeck: number; inDeck: number } {
    const decks = this.d.engine.getState().decks;
    const o = decks.findIndex((x) => x.track?.trackId === this.s.out?.trackId);
    const outDeck = o >= 0 ? o : 0;
    return { outDeck, inDeck: outDeck === 0 ? 1 : 0 };
  }

  /** A deck playing something that isn't this rehearsal = a live mix: don't touch it. */
  private liveDeck(): number {
    const r = this.s.rehearsal;
    const ours = r.status === "running" || r.status === "ready";
    return this.d.engine.getState().decks.findIndex((x) => x.playing && !(ours && (x.index === r.outDeck || x.index === r.inDeck)));
  }

  async rehearse(): Promise<void> {
    if (!this.s.plan || !this.s.out || !this.s.in) return;
    const live = this.liveDeck();
    if (live >= 0) return this.reh({ status: "blocked", message: `Deck ${String.fromCharCode(65 + live)} is playing. Rehearsal uses both decks — stop them first (this interrupts the live mix).` });
    await this.prepare(true);
  }

  /** The explicit switch: stop both decks, then rehearse. */
  async stopDecksAndRehearse(): Promise<void> {
    this.pauseAll();
    await this.prepare(true);
  }

  async replay(): Promise<void> {
    this.pauseAll();
    await this.prepare(true);
  }

  async reset(): Promise<void> {
    this.pauseAll();
    await this.prepare(false);
  }

  stopRehearsal(): void {
    if (this.s.rehearsal.status === "running" || this.s.rehearsal.status === "ready") this.pauseAll();
    this.reh({ status: "off", message: "", startError: null });
  }

  private pauseAll(): void {
    for (const x of this.d.engine.getState().decks) if (x.playing) this.d.bus.send(`deck${x.index + 1}.play`, 1);
  }

  private async prepare(play: boolean): Promise<void> {
    const p = this.s.plan;
    const out = this.s.out;
    const inc = this.s.in;
    if (!p || !out?.grid || !inc?.grid) return;
    const { outDeck, inDeck } = this.decksFor();
    this.reh({ status: "preparing", message: "Loading and cueing both tracks…", outDeck, inDeck, startError: null });
    try {
      const e = this.d.engine;
      for (const [deck, f] of [[outDeck, out], [inDeck, inc]] as const) {
        if (e.getState().decks[deck].track?.trackId === f.trackId && e.getState().decks[deck].status === "ready") continue;
        const t = this.d.library.getByRef(f.ref);
        if (!t) throw new Error(`${f.title} isn't in the library`);
        await e.loadTrack(deck, t);
        if (e.getState().decks[deck].status !== "ready") throw new Error(`Couldn't load ${f.title}: ${e.getState().decks[deck].error ?? "unknown error"}`);
      }
      // Tempo as the plan says; key lock where the plan recommends it.
      e.setRateDirect(outDeck, p.outRate);
      e.setRateDirect(inDeck, p.inRate);
      if (p.warnings.some((w) => /KEY LOCK/.test(w.text))) e.setKeylock(inDeck, true);
      // Track B waits at its cue (CUE returns there; the track's saved cue isn't changed).
      e.seekTo(inDeck, p.inCue);
      e.setSessionCue(inDeck, p.inCue);
      // Mixer start state for the technique.
      const ch = (deck: number, k: string, v: number) => this.d.bus.send(`mixer.channel${deck + 1}.${k}`, v);
      for (const deck of [outDeck, inDeck]) for (const k of ["eq.low", "eq.mid", "eq.high", "filter"]) ch(deck, k, 0.5);
      ch(outDeck, "volume", 1);
      ch(inDeck, "volume", 0);
      if (["blend", "bass-swap", "vocal-swap", "stem-swap"].includes(p.technique)) ch(inDeck, "eq.low", 0);
      this.d.bus.send("mixer.crossfader", 0.5);
      // Track A starts the chosen number of bars before the transition.
      const lead = this.s.rehearsal.leadBars;
      e.seekTo(outDeck, Math.max(0, timeAtBar(out.grid, p.outStartBar - lead)));
      this.inWasPlaying = false;
      if (play) {
        this.d.bus.send(`deck${outDeck + 1}.play`, 1);
        this.reh({ status: "running", message: "" });
        this.watch();
      } else this.reh({ status: "ready", message: `Ready: Track A starts ${lead} bars before the transition. Press Replay to play.` });
    } catch (err) {
      this.reh({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private inWasPlaying = false;

  /** While rehearsing: measure when Track B was started against the planned downbeat (audio clock). */
  private watch(): void {
    const id = ++this.watching;
    const tick = () => {
      if (id !== this.watching || this.s.rehearsal.status !== "running") return;
      const { outDeck, inDeck } = this.s.rehearsal;
      const decks = this.d.engine.getState().decks;
      const p = this.s.plan;
      const g = this.s.out?.grid;
      if (p && g && decks[inDeck].playing && !this.inWasPlaying) {
        const target = timeAtBar(g, p.bStartsAtBar);
        const pos = this.d.engine.getPosition(outDeck);
        const err = pos - target; // Track A seconds
        this.reh({ startError: { ms: Math.round((err / p.outRate) * 1000), beats: Math.round((err / beatLength(g.bpm)) * 100) / 100 } });
      }
      this.inWasPlaying = decks[inDeck].playing;
      setTimeout(tick, 15);
    };
    tick();
  }

  /** Where the rehearsal is right now (from Track A's audio position). */
  cue(): RehearsalCue | null {
    const p = this.s.plan;
    const g = this.s.out?.grid;
    if (!p || !g || this.s.rehearsal.status === "off") return null;
    return rehearsalCue(p, g, this.d.engine.getPosition(this.s.rehearsal.outDeck));
  }
}

export type { TrackInfo };

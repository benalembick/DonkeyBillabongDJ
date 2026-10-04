/**
 * DJ Training session: lesson setup, guided practice, assessed attempts, results and progress.
 *
 *   engine state (decks, mixer, FX — driven by mouse, keyboard or controller alike)
 *     → measure.Sample every 15 ms → coach (steps, hints, highlights) → scoring (assessed attempts)
 *
 * Safety: training never presses PLAY; it won't take over a deck that's playing (an explicit
 * "stop decks" is needed); it snapshots the decks, mixer, FX and assists when a session starts
 * and restores them on Exit. Timers and listeners are cleaned up on Exit.
 */
import { Emitter } from "../core/events";
import type { CommandBus } from "../core/commands";
import type { DJEngine, EngineState } from "../core/engine/DJEngine";
import type { AudioEngine, TrackInfo } from "../core/engine/types";
import type { AnalysisService } from "../analysis/AnalysisService";
import type { LibraryStore } from "../library/LibraryStore";
import type { PreparationStore } from "../preparation/PreparationStore";
import { matchTempo, timeAtBar, type Grid } from "../transitions/planner";
import { lesson, LESSONS, type AssistId, type LessonId } from "./curriculum";
import { hints, judgeTap, phraseCounter, stepControls, stepDone, type CoachCtx } from "./coach";
import { aPositionAtBEntry, phaseMs, xfGain, type DeckSample, type Exercise, type FxSample, type Sample, type TrainingEvent } from "./measure";
import { harmonicChoices, readiness, suggestPairs, type Candidate, type PairSuggestion } from "./pairs";
import { scoreAttempt, type LessonResult } from "./scoring";

export type Phase = "dashboard" | "setup" | "practice" | "assess" | "results";
export const PASS_MARK = 60;

export interface Attempt {
  date: number;
  total: number | null;
  metrics: { id: string; label: string; score: number | null }[];
  a: string;
  b: string;
}
export interface LessonProgress {
  completed: boolean;
  best: number | null;
  attempts: Attempt[];
  practised: boolean;
}
export type Progress = Partial<Record<LessonId, LessonProgress>>;

export interface TrainingState {
  phase: Phase;
  lessonId: LessonId | null;
  aRef: string | null;
  bRef: string | null;
  cutOn: "bar" | "phrase";
  /** Harmonic lesson: Track B candidates for the chosen Track A. */
  choices: { ref: string; title: string; key: string | null; uncertain: boolean; compatible: boolean }[];
  suggestions: PairSuggestion[];
  readiness: { a: ReturnType<typeof readiness>; b: ReturnType<typeof readiness> };
  analysing: Record<string, string>;
  /** Decks are playing (live session): the reason a lesson can't start. */
  blocked: string | null;
  paused: boolean;
  step: number;
  hints: string[];
  /** Feedback on the latest "Phrase!" tap (n counts taps, so the UI can re-flash on each). Verdicts only with hints on. */
  lastTap: { n: number; hit: boolean | null; text: string; hits: number } | null;
  counter: string | null;
  meter: { tempoDiff: number | null; phaseMs: number | null } | null;
  highlights: string[];
  assists: AssistId[];
  result: LessonResult | null;
  progress: Progress;
  message: string | null;
  latencyMs: number;
}

const STORE = "dbdj.training.v1";
/** Beatmatch exercise: how far off Track B starts, per attempt (cycled — the same sequence every time). */
const BEATMATCH_OFFSETS = [0.03, -0.025, 0.02, -0.035];

interface Deps {
  engine: DJEngine;
  bus: CommandBus;
  audio: AudioEngine;
  library: LibraryStore;
  preparation: PreparationStore;
  analysis: AnalysisService;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** True when no mapped DJ controller is connected (hints then name keys and on-screen controls). */
  keyboardOnly?: () => boolean;
  /** KeyboardEvent.code bound to `action` with a value of the same sign, or null. */
  keyFor?: (action: string, value: number) => string | null;
}

interface Snapshot {
  decks: { ref: string | null; track: TrackInfo | null; pos: number; rate: number; sync: boolean; keylock: boolean; vinyl: boolean }[];
  mixer: EngineState["mixer"];
  fx: { mix: number; decks: boolean[]; on: boolean[] }[];
  classes: Record<string, boolean>;
}

const HIDE_CLASSES = ["practice-hide-bpm", "practice-hide-key", "practice-hide-grid"];

export class TrainingService extends Emitter<{ change: TrainingState }> {
  private s: TrainingState;
  private storage: Deps["storage"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples: Sample[] = [];
  private events: TrainingEvent[] = [];
  private ex: Exercise | null = null;
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private resumeDecks: number[] = [];
  private snapshot: Snapshot | null = null;
  private prevPlaying = [false, false];
  private lastEmit = 0;
  private attemptCount: Partial<Record<LessonId, number>> = {};

  constructor(private d: Deps) {
    super();
    this.storage = d.storage !== undefined ? d.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
    this.s = {
      phase: "dashboard", lessonId: null, aRef: null, bRef: null, cutOn: "phrase", choices: [], suggestions: [], readiness: { a: [], b: [] }, analysing: {},
      blocked: null, paused: false, step: 0, hints: [], lastTap: null, counter: null, meter: null, highlights: [], assists: [], result: null,
      progress: this.load(), message: null, latencyMs: 0,
    };
    // Phrase taps from any input (panel button, MIDI mapping, keyboard binding).
    d.bus.handle("training.tap", (v) => { if (v > 0) this.tap(); });
  }

  getState(): TrainingState {
    return this.s;
  }

  private set(p: Partial<TrainingState>): void {
    this.s = { ...this.s, ...p };
    this.emit("change", this.s);
  }

  private load(): Progress {
    try { return JSON.parse(this.storage?.getItem(STORE) ?? "{}").progress ?? {}; } catch { return {}; }
  }
  private save(progress: Progress): void {
    try { this.storage?.setItem(STORE, JSON.stringify({ progress })); } catch { /* storage unavailable */ }
    this.set({ progress });
  }

  /** The suggested next lesson: the first not completed whose prerequisites are done (else the lowest best score). */
  suggestedNext(): LessonId {
    const p = this.s.progress;
    const open = LESSONS.find((l) => !p[l.id]?.completed && l.prerequisites.every((x) => p[x]?.completed));
    if (open) return open.id;
    const first = LESSONS.find((l) => !p[l.id]?.completed);
    if (first) return first.id;
    return [...LESSONS].sort((x, y) => (p[x.id]?.best ?? 0) - (p[y.id]?.best ?? 0))[0].id;
  }

  resetProgress(): void {
    this.save({});
  }

  // ─────────────────────────── setup ───────────────────────────

  private candidate(t: TrackInfo): Candidate {
    const r = this.d.preparation.forRef(t.ref);
    return {
      track: t, analysed: !!r && r.analysisVersion !== null, bpm: r?.beatGrid?.bpm ?? null, gridConfidence: r?.beatGrid?.confidence ?? null, gridManual: !!r?.beatGrid?.manuallyAdjusted,
      key: r?.key ?? t.key ?? null, keyConfidence: r?.keyConfidence ?? 0, duration: r?.duration || (t.durationMs ?? 0) / 1000, energy: r?.energy ?? null,
    };
  }
  private candidates(): Candidate[] {
    return this.d.library.getState().tracks.filter((t) => t.source === "local").map((t) => this.candidate(t));
  }

  openDashboard(): void {
    if (this.s.phase === "practice" || this.s.phase === "assess") return;
    this.set({ phase: "dashboard", lessonId: null, result: null, message: null });
  }

  selectLesson(id: LessonId): void {
    if (this.s.phase === "practice" || this.s.phase === "assess") return;
    const l = lesson(id);
    const suggestions = suggestPairs(l, this.candidates());
    const pick = suggestions[0];
    this.set({ phase: "setup", lessonId: id, result: null, message: suggestions.length ? null : this.notEnoughTracks(id), suggestions, aRef: pick?.a.ref ?? this.s.aRef, bRef: pick?.b.ref ?? this.s.bRef });
    this.refreshSetup();
  }

  private notEnoughTracks(id: LessonId): string {
    const l = lesson(id);
    const analysed = this.candidates().filter((c) => c.analysed).length;
    if (analysed < 2) return `This lesson needs at least two analysed local tracks (you have ${analysed}). Add tracks to the library and analyse them — the app doesn't include training audio.`;
    return `No pair in your library suits this lesson yet (${l.requirements.keys ? "both tracks need detected keys and " : ""}${l.requirements.maxBpmGapPct !== null ? `tempos within ${l.requirements.maxBpmGapPct}% and ` : ""}beat grids). Choose tracks yourself below, or analyse more tracks.`;
  }

  setTrack(side: "a" | "b", ref: string | null): void {
    this.set(side === "a" ? { aRef: ref } : { bRef: ref });
    this.refreshSetup();
  }

  usePair(p: PairSuggestion): void {
    this.set({ aRef: p.a.ref, bRef: p.b.ref });
    this.refreshSetup();
  }

  setCutOn(cutOn: "bar" | "phrase"): void {
    this.set({ cutOn });
  }

  private refreshSetup(): void {
    const id = this.s.lessonId;
    if (!id) return;
    const l = lesson(id);
    const get = (ref: string | null) => (ref ? this.d.library.getByRef(ref) : null);
    const a = get(this.s.aRef);
    const b = get(this.s.bRef);
    let choices: TrainingState["choices"] = [];
    if (id === "harmonic" && a) {
      choices = harmonicChoices(l, this.candidate(a), this.candidates()).map(({ c, compatible }) => ({ ref: c.track.ref, title: `${c.track.artist ? c.track.artist + " — " : ""}${c.track.title}`, key: c.key, uncertain: c.keyConfidence < 0.35, compatible }));
    }
    this.set({ readiness: { a: a ? readiness(this.candidate(a), l, "a") : [], b: b ? readiness(this.candidate(b), l, "b") : [] }, choices });
  }

  async analyse(side: "a" | "b"): Promise<void> {
    const ref = side === "a" ? this.s.aRef : this.s.bRef;
    const t = ref ? this.d.library.getByRef(ref) : null;
    if (!ref || !t) return;
    const label = { reading: "Reading the file…", decoding: "Decoding…", analysing: "Analysing beats and key…", done: "Done" };
    try {
      await this.d.analysis.analyseOne(t, (st) => this.set({ analysing: { ...this.s.analysing, [ref]: label[st] } }));
      const { [ref]: _done, ...rest } = this.s.analysing;
      this.set({ analysing: rest });
    } catch (e) {
      this.set({ analysing: { ...this.s.analysing, [ref]: `Analysis failed: ${e instanceof Error ? e.message : String(e)}` } });
    }
    if (this.s.lessonId) this.set({ suggestions: suggestPairs(lesson(this.s.lessonId), this.candidates()) });
    this.refreshSetup();
  }

  /** Why the chosen tracks can't be used yet (null = ready). */
  setupProblem(): string | null {
    if (!this.s.aRef || !this.s.bRef) return "Choose Track A and Track B.";
    if (this.s.aRef === this.s.bRef) return "Choose two different tracks.";
    const bad = [...this.s.readiness.a.map((r) => ({ ...r, side: "Track A" })), ...this.s.readiness.b.map((r) => ({ ...r, side: "Track B" }))].find((r) => r.level === "bad");
    return bad ? `${bad.side}: ${bad.text}` : null;
  }

  // ─────────────────────────── sessions ───────────────────────────

  private livePlaying(): number {
    return this.d.engine.getState().decks.findIndex((x) => x.playing);
  }

  /** Start guided practice or the assessed attempt (never starts playback). */
  async start(mode: "practice" | "assess", stopDecks = false): Promise<void> {
    const id = this.s.lessonId;
    if (!id || this.setupProblem()) return;
    if (stopDecks) for (const x of this.d.engine.getState().decks) if (x.playing) this.d.bus.send(`deck${x.index + 1}.play`, 1, "system");
    const ours = this.s.phase === "practice" || this.s.phase === "assess";
    const live = this.livePlaying();
    if (live >= 0 && !ours) return this.set({ blocked: `Deck ${String.fromCharCode(65 + live)} is playing. Training uses both decks — stop them first (this interrupts what's playing). Your decks and mixer are restored when you exit training.` });
    if (ours) for (const x of this.d.engine.getState().decks) if (x.playing) this.d.bus.send(`deck${x.index + 1}.play`, 1, "system");
    this.set({ blocked: null, message: "Loading the lesson tracks…" });
    if (!this.snapshot) this.snapshot = this.takeSnapshot();
    try {
      await this.prepare(id, mode);
    } catch (e) {
      this.set({ message: e instanceof Error ? e.message : String(e), phase: "setup" });
      this.stopLoop();
      return;
    }
    const assists = mode === "practice" ? lesson(id).assists.practice : lesson(id).assists.assess;
    this.applyAssists(assists);
    this.samples = [];
    this.events = [];
    this.startedAt = performance.now();
    this.pausedTotal = 0;
    this.doneAt = null;
    this.prevPlaying = [false, false];
    this.set({ phase: mode, step: 0, hints: [], lastTap: null, result: null, paused: false, assists, message: mode === "practice" ? "Guided practice — press PLAY on Track A when you're ready." : "Assessed attempt — assists are reduced. Press PLAY on Track A when you're ready." });
    this.startLoop();
    if (mode === "practice") this.markPractised(id);
  }

  private async prepare(id: LessonId, mode: "practice" | "assess"): Promise<void> {
    const e = this.d.engine;
    for (const [deck, ref] of [[0, this.s.aRef!], [1, this.s.bRef!]] as const) {
      const t = this.d.library.getByRef(ref);
      if (!t) throw new Error("A lesson track is no longer in the library.");
      const cur = e.getState().decks[deck];
      if (cur.track?.ref !== ref || cur.status !== "ready") {
        await e.loadTrack(deck, t);
        const st = e.getState().decks[deck];
        if (st.status !== "ready") throw new Error(`Couldn't load “${t.title}”: ${st.error ?? "the audio is unavailable"}. Choose another track.`);
      }
    }
    const da = e.getState().decks[0];
    const db = e.getState().decks[1];
    const grid = (g: typeof da.beatGrid): Grid | null => (g ? { bpm: g.bpm, firstBeat: g.firstBeat, confidence: g.confidence, manual: !!g.manuallyAdjusted } : null);
    const aGrid = grid(da.beatGrid);
    const bGrid = grid(db.beatGrid);
    const l = lesson(id);
    if (!aGrid || (l.requirements.grids === "both" && !bGrid)) throw new Error("A lesson track has no beat grid — analyse it first.");
    // Track A from a phrase start (4 bars before the next phrase, for the phrase lessons).
    const lead = id === "beatmatch" ? 0 : 4;
    const aStart = Math.max(0, timeAtBar(aGrid, 8 - lead));
    const bCue = bGrid ? Math.max(0, timeAtBar(bGrid, 0)) : 0;
    e.setRateDirect(0, 1);
    const assists = mode === "practice" ? l.assists.practice : l.assists.assess;
    if (bGrid) {
      const matched = matchTempo(aGrid.bpm, bGrid.bpm).rate;
      if (id === "beatmatch") {
        const n = this.attemptCount[id] ?? 0;
        this.attemptCount[id] = n + 1;
        e.setRateDirect(1, matched * (1 + BEATMATCH_OFFSETS[n % BEATMATCH_OFFSETS.length]));
      } else e.setRateDirect(1, assists.includes("tempoPrematched") ? matched : 1);
    } else e.setRateDirect(1, 1);
    e.seekTo(0, aStart);
    e.seekTo(1, bCue);
    e.setSessionCue(1, bCue);
    e.setSessionCue(0, aStart);
    // Mixer start state: EQs/filters centred, A up, B down (beatmatching: B audible too), crossfader centre.
    const ch = (deck: number, k: string, v: number) => this.d.bus.send(`mixer.channel${deck + 1}.${k}`, v, "system");
    for (const deck of [0, 1]) for (const k of ["eq.low", "eq.mid", "eq.high", "filter"]) ch(deck, k, 0.5);
    ch(0, "volume", 1);
    ch(1, "volume", id === "beatmatch" ? 0.8 : 0);
    this.d.bus.send("mixer.crossfader", 0.5, "system");
    const status = this.d.audio.getStatus();
    const latencyMs = Math.round(((status.outputLatency || 0) + (status.baseLatency || 0)) * 1000);
    this.ex = { aGrid, bGrid, aPhraseOffset: 0, bPhraseOffset: 0, bCue, latencyMs, cutOn: this.s.cutOn };
    this.set({ latencyMs, message: null });
  }

  private applyAssists(assists: AssistId[]): void {
    const has = new Set(assists);
    this.d.engine.lockSync(has.has("sync") ? null : "SYNC is locked during this training exercise — match the tracks by hand.");
    if (typeof document !== "undefined") document.documentElement.classList.toggle("practice-hide-bpm", !has.has("bpmDisplay"));
  }

  pause(): void {
    if ((this.s.phase !== "practice" && this.s.phase !== "assess") || this.s.paused) return;
    this.resumeDecks = this.d.engine.getState().decks.filter((x) => x.playing).map((x) => x.index);
    for (const i of this.resumeDecks) this.d.bus.send(`deck${i + 1}.play`, 1, "system");
    this.pausedAt = performance.now();
    this.stopLoop();
    this.set({ paused: true, message: "Paused — press Resume to carry on (the decks you were playing start again)." });
  }

  resume(): void {
    if (!this.s.paused) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    for (const i of this.resumeDecks) this.d.bus.send(`deck${i + 1}.play`, 1, "system");
    this.resumeDecks = [];
    this.set({ paused: false, message: null });
    this.startLoop();
  }

  async retry(): Promise<void> {
    const mode = this.s.phase === "results" || this.s.phase === "assess" ? "assess" : "practice";
    await this.start(mode);
  }

  /** Skip the guided steps and go straight to the assessed attempt. */
  async skipGuidance(): Promise<void> {
    await this.start("assess");
  }

  /** "Done": finish the attempt now (e.g. beatmatch: "I'm matched"). */
  finishNow(): void {
    if (this.s.phase === "assess") this.finish();
    else if (this.s.phase === "practice") this.set({ message: "Practice finished — start the assessed attempt when you're ready." });
  }

  tap(): void {
    if (this.s.phase !== "practice" && this.s.phase !== "assess") return;
    const n = (this.s.lastTap?.n ?? 0) + 1;
    if (!this.d.engine.getState().decks[0]?.playing || !this.ex) return this.set({ lastTap: { n, hit: null, text: "Track A isn't playing — press PLAY on Track A, then tap on the phrase starts.", hits: this.s.lastTap?.hits ?? 0 } });
    const aPos = this.d.engine.getPosition(0);
    this.events.push({ t: this.now(), kind: "tap", aPos });
    const verdict = judgeTap(this.ex, aPos);
    const hits = this.events.filter((e) => e.kind === "tap" && judgeTap(this.ex!, e.aPos)?.hit).length;
    const showVerdict = this.s.assists.includes("hints") && verdict;
    this.set({ lastTap: { n, hit: showVerdict ? verdict.hit : null, text: showVerdict ? verdict.text : "Tap recorded.", hits } });
  }

  async nextLesson(): Promise<void> {
    const order = LESSONS.map((l) => l.id);
    const i = this.s.lessonId ? order.indexOf(this.s.lessonId) : -1;
    const next = this.suggestedNext() !== this.s.lessonId ? this.suggestedNext() : order[(i + 1) % order.length];
    this.stopSession();
    this.selectLesson(next);
  }

  /** Leave training: stop timers, restore the decks, mixer, FX and assists as they were. */
  async exit(): Promise<void> {
    this.stopSession();
    const snap = this.snapshot;
    this.snapshot = null;
    if (snap) await this.restore(snap);
    this.set({ phase: "dashboard", lessonId: null, result: null, message: snap ? "Training closed — your decks, mixer and effects were restored." : null, blocked: null });
  }

  private stopSession(): void {
    this.stopLoop();
    this.d.engine.lockSync(null);
    if (typeof document !== "undefined") document.documentElement.removeAttribute("data-train-hl");
    this.set({ highlights: [], hints: [], lastTap: null, meter: null, counter: null, paused: false });
  }

  // ─────────────────────────── snapshot / restore ───────────────────────────

  private takeSnapshot(): Snapshot {
    const st = this.d.engine.getState();
    return {
      decks: st.decks.map((x) => ({ ref: x.track?.ref ?? null, track: x.track, pos: this.d.engine.getPosition(x.index), rate: x.rate, sync: x.sync, keylock: x.keylock, vinyl: x.vinyl })),
      mixer: structuredClone(st.mixer),
      fx: st.fx.map((u) => ({ mix: u.mix, decks: [...u.decks], on: u.slots.map((x) => x.on) })),
      classes: Object.fromEntries(HIDE_CLASSES.map((c) => [c, typeof document !== "undefined" && document.documentElement.classList.contains(c)])),
    };
  }

  private async restore(snap: Snapshot): Promise<void> {
    const e = this.d.engine;
    for (const x of e.getState().decks) if (x.playing) this.d.bus.send(`deck${x.index + 1}.play`, 1, "system");
    for (const [i, dk] of snap.decks.entries()) {
      const cur = e.getState().decks[i];
      if (!cur) continue;
      if (dk.ref && dk.track && cur.track?.ref !== dk.ref) await e.loadTrack(i, dk.track).catch(() => undefined);
      if (!dk.ref && cur.track) this.d.bus.send(`deck${i + 1}.eject`, 1, "system");
      if (dk.ref && e.getState().decks[i].status === "ready") {
        e.seekTo(i, dk.pos);
        e.setRateDirect(i, dk.rate);
        e.setKeylock(i, dk.keylock);
        if (e.getState().decks[i].vinyl !== dk.vinyl) this.d.bus.send(`deck${i + 1}.vinyl`, 1, "system");
        if (dk.sync && !e.getState().decks[i].sync) this.d.bus.send(`deck${i + 1}.sync`, 1, "system");
      }
    }
    const m = snap.mixer;
    m.channels.forEach((c, i) => {
      const n = `mixer.channel${i + 1}`;
      for (const [k, v] of [["gain", c.gain], ["eq.high", c.eqHigh], ["eq.mid", c.eqMid], ["eq.low", c.eqLow], ["filter", c.filter], ["volume", c.volume]] as const) this.d.bus.send(`${n}.${k}`, v, "system");
    });
    this.d.bus.send("mixer.crossfader", m.crossfader, "system");
    const fxNow = e.getState().fx;
    snap.fx.forEach((u, k) => {
      const now = fxNow[k];
      if (!now) return;
      this.d.bus.send(`fx.unit${k + 1}.mix`, u.mix, "system");
      u.decks.forEach((on, d) => { if (now.decks[d] !== on) this.d.bus.send(`fx.unit${k + 1}.assign.deck${d + 1}`, 1, "system"); });
      u.on.forEach((on, j) => { if (now.slots[j] && now.slots[j].on !== on) this.d.bus.send(`fx.unit${k + 1}.slot${j + 1}.toggle`, 1, "system"); });
    });
    if (typeof document !== "undefined") for (const [c, on] of Object.entries(snap.classes)) document.documentElement.classList.toggle(c, on);
  }

  // ─────────────────────────── the loop ───────────────────────────

  private now(): number {
    return (performance.now() - this.startedAt - this.pausedTotal) / 1000;
  }

  private startLoop(): void {
    this.stopLoop();
    this.timer = setInterval(() => this.tick(), 15);
  }
  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): Sample {
    const e = this.d.engine;
    const st = e.getState();
    const xg = xfGain(st.mixer.crossfader);
    const deck = (i: number): DeckSample => {
      const d = st.decks[i];
      const c = st.mixer.channels[i];
      return {
        playing: d.playing, pos: e.getPosition(i), rate: d.rate, bpm: d.beatGrid ? d.beatGrid.bpm * d.rate : null,
        volume: d.playing && !c.mute ? c.volume * (i === 0 ? xg.a : xg.b) : 0,
        eqLow: c.killLow ? 0 : c.eqLow, eqMid: c.killMid ? 0 : c.eqMid, eqHigh: c.killHigh ? 0 : c.eqHigh, filter: c.filter,
      };
    };
    const a = deck(0);
    const b = deck(1);
    const ga = this.ex?.aGrid;
    const gb = this.ex?.bGrid;
    const fx: FxSample[] = st.fx.map((u) => ({ echoOn: u.slots.some((x) => x.on && x.type === "echo"), anyOn: u.slots.some((x) => x.on), mix: u.mix, onA: !!u.decks[0], onB: !!u.decks[1] }));
    return { t: this.now(), a, b, phaseMs: ga && gb && a.playing && b.playing && a.bpm ? phaseMs(ga, gb, a.pos, b.pos, a.bpm) : null, fx };
  }

  private keyboardControls(): CoachCtx["keyboard"] {
    if (!this.d.keyboardOnly?.()) return null;
    const label = (code: string | null | undefined) => (code ? code.replace(/^(Key|Digit)/, "") : null);
    return { nudgeBack: label(this.d.keyFor?.("deck2.jog.ring", -1)), nudgeForward: label(this.d.keyFor?.("deck2.jog.ring", 1)) };
  }

  private tick(): void {
    const id = this.s.lessonId;
    if (!id || !this.ex) return;
    const s = this.sample();
    this.samples.push(s);
    // Practice keeps the last 40 s (more than any step looks back); assessments keep everything.
    if (this.s.phase === "practice" && this.samples.length > 3000) this.samples.splice(0, this.samples.length - 2700);
    // Events from state changes (any input source).
    if (s.a.playing && !this.prevPlaying[0]) {
      this.events.push({ t: s.t, kind: "aStart", aPos: s.a.pos });
      if (this.s.message?.includes("press PLAY on Track A")) this.set({ message: null });
    }
    if (s.b.playing && !this.prevPlaying[1] && !this.events.some((x) => x.kind === "bStart")) this.events.push({ t: s.t, kind: "bStart", aPos: aPositionAtBEntry(s, this.ex.bCue) });
    this.prevPlaying = [s.a.playing, s.b.playing];
    const st = this.d.engine.getState();
    const ctx: CoachCtx = {
      lesson: id, s, recent: this.samples.filter((x) => x.t > s.t - this.lookBack(s)), events: this.events, ex: this.ex, assists: new Set(this.s.assists),
      tempoDownIsFaster: this.d.engine.getSettings().tempoDownIsFaster, echoReadyOnA: st.fx.some((u) => u.decks[0] && u.slots.some((x) => x.type === "echo") && u.mix >= 0.45 && u.mix <= 0.75),
      keyboard: this.keyboardControls(),
    };
    let step = this.s.step;
    const total = lesson(id).steps.length;
    while (step < total && stepDone(step, ctx)) step++;
    if (step !== this.s.step) this.set({ step });
    if (performance.now() - this.lastEmit > 100 || step !== this.s.step) {
      this.lastEmit = performance.now();
      const has = new Set(this.s.assists);
      const highlights = has.has("highlights") && step < total ? stepControls(id, step) : [];
      if (typeof document !== "undefined") document.documentElement.setAttribute("data-train-hl", highlights.join(" "));
      this.set({
        hints: has.has("hints") ? hints(Math.min(step, total - 1), ctx) : [],
        counter: has.has("phraseCounter") ? phraseCounter(this.ex, s) : null,
        meter: has.has("phaseMeter") ? { tempoDiff: s.a.bpm !== null && s.b.bpm !== null ? s.b.bpm - s.a.bpm : null, phaseMs: s.phaseMs } : null,
        highlights,
      });
    }
    if (this.s.phase === "assess" && this.shouldFinish(id, step, total, s)) this.finish();
    else if (this.s.phase === "practice" && step >= total && this.s.message !== "Practice complete") this.set({ message: "Practice complete" });
  }

  /** Seconds of history the coach needs: at least 12 s, and always more than 8 bars of Track A. */
  private lookBack(s: Sample): number {
    const g = this.ex?.aGrid;
    return Math.max(12, g ? (8 * 4 * 60) / g.bpm / Math.max(0.5, s.a.rate) + 3 : 12);
  }

  private shouldFinish(id: LessonId, step: number, total: number, s: Sample): boolean {
    const bStart = this.events.find((x) => x.kind === "bStart");
    const g = this.ex!.aGrid!;
    const bar = (240 / g.bpm) / Math.max(0.5, s.a.rate);
    if (s.t > 240) return true;
    if (id === "beatmatch") return !!bStart && s.t - bStart.t > 75;
    if (step >= total) {
      const doneAt = (this.doneAt ??= s.t);
      return s.t - doneAt > (id === "quickcut" ? bar * 2 : 1.5);
    }
    if (bStart && s.t - bStart.t > bar * (id === "longblend" ? 80 : id === "quickcut" || id === "effects" ? 16 : 48)) return true;
    return false;
  }
  private doneAt: number | null = null;

  private finish(): void {
    const id = this.s.lessonId!;
    this.stopLoop();
    this.events.push({ t: this.now(), kind: "done", aPos: this.d.engine.getPosition(0) });
    this.doneAt = null;
    const a = this.d.library.getByRef(this.s.aRef!);
    const b = this.d.library.getByRef(this.s.bRef!);
    const pa = this.s.aRef ? this.d.preparation.forRef(this.s.aRef) : undefined;
    const pb = this.s.bRef ? this.d.preparation.forRef(this.s.bRef) : undefined;
    const result = scoreAttempt({ lesson: id, samples: this.samples, events: this.events, ex: this.ex!, keys: id === "harmonic" ? { a: pa?.key ?? a?.key ?? null, b: pb?.key ?? b?.key ?? null, uncertain: (pa?.keyConfidence ?? 0) < 0.35 || (pb?.keyConfidence ?? 0) < 0.35 } : undefined });
    const prev = this.s.progress[id] ?? { completed: false, best: null, attempts: [], practised: false };
    const attempt: Attempt = { date: result.date, total: result.total, metrics: result.metrics.map((m) => ({ id: m.id, label: m.label, score: m.score })), a: a?.title ?? "", b: b?.title ?? "" };
    const best = result.total === null ? prev.best : Math.max(prev.best ?? 0, result.total);
    this.save({ ...this.s.progress, [id]: { ...prev, completed: prev.completed || (result.total ?? 0) >= PASS_MARK, best, attempts: [...prev.attempts, attempt].slice(-20) } });
    this.d.engine.lockSync(null);
    if (typeof document !== "undefined") document.documentElement.removeAttribute("data-train-hl");
    this.set({ phase: "results", result, highlights: [], hints: [], meter: null, counter: null, message: null });
  }

  private markPractised(id: LessonId): void {
    const prev = this.s.progress[id] ?? { completed: false, best: null, attempts: [], practised: false };
    if (!prev.practised) this.save({ ...this.s.progress, [id]: { ...prev, practised: true } });
  }

  /** Harmonic lesson: pick Track B from the candidates. */
  chooseB(ref: string): void {
    this.setTrack("b", ref);
  }

  /** For tests: the recorded attempt data. */
  debugAttempt(): { samples: Sample[]; events: TrainingEvent[]; ex: Exercise | null } {
    return { samples: this.samples, events: this.events, ex: this.ex };
  }
}

/**
 * Teach Me: Live Looping — Phase 1 lesson runner. See docs/TEACH-ME-LIVE-LOOPING.md for the full architecture and
 * the later-phase roadmap.
 *
 * Isolation: owns its own `ProductionStudio` + `LiveLooper` instance (same classes Production Studio uses, a
 * separate autosave key so it can never read or write the user's real project — see ProductionStudio's
 * `storageKey` constructor param). Nothing here duplicates the transport/recording engine; every lesson action is
 * a real `LiveLooper.perform()` call, scored from the real audio clock (`looper.now()` / `looper.getState()`).
 *
 * Pads: no microphone. Four sounds are synthesised once (sounds.ts) and played through a pad bus that is both
 * audible (connected to the production output) and recordable (tapped by `PadCapture`, LiveLooper's input).
 *
 * Timing authority: every score comes from `looper.now()` (the AudioContext clock) compared against the
 * transport's `origin` with the pure helpers in `scoring.ts` — never from `setInterval`/`requestAnimationFrame`,
 * which only drive the view (`useTick` polling `live()`, same as the real Looper workspace).
 */
import type { WebAudioEngine } from "../audio/WebAudioEngine";
import type { Platform } from "../platform";
import type { StemService } from "../stems/StemService";
import { ProductionStudio } from "../production/ProductionStudio";
import { LiveLooper } from "../production/looper/LiveLooper";
import { barSeconds } from "../production/looper/timing";
import { PadCapture } from "./PadCapture";
import { LAYERS, PADS, synthesizeGhostDrums, synthesizeGhostSynth, synthesizeLayer, synthesizePad, type LayerRole, type PadId } from "./sounds";
import { consistencyScore, describeTap, judgeTap, lowBandClash, lowBandEnvelope, nearestBeatErrorMs, scoreLoopCapture, tapScore, type LoopCaptureResult, type TapJudgement } from "./scoring";
import { ACTIVITIES, BEAT_ONE_ATTEMPTS, CHALLENGE_BARS, DEFAULT_BEATS_PER_BAR, DEFAULT_BPM, MILESTONES, type ActivityId, type MilestoneId, type TeachLoopMode } from "./curriculum";
import { encodeWav } from "../production/wav";
import { makeId } from "../production/types";

export type Phase = "ready" | "demo" | "countin" | "practice" | "evaluation" | "results";
export interface TapResult { errorMs: number; judgement: TapJudgement }
export interface ActivityProgress { attempts: number; completed: boolean; bestScore: number | null; milestones: MilestoneId[] }
export type Progress = Partial<Record<ActivityId, ActivityProgress>>;

export interface TeachLoopState {
  activity: ActivityId | null;
  /** Module 1's two sub-drills; null for the standalone exercise/sandbox activities. */
  drill: "a" | "b" | null;
  phase: Phase;
  mode: TeachLoopMode;
  taps: TapResult[];
  lastLoopResult: LoopCaptureResult | null;
  lastScore: number | null;
  milestonesEarned: MilestoneId[];
  progress: Progress;
  interrupted: boolean;
  message: string;
  learnerTrackId: string | null;
  ghostTrackId: string | null;
  /** Module 2 (Layering & Frequency Management): drums/bass/melody/vocalPerc loop track ids, each layer's low-band energy envelope (for the clash report), and how many of bass/melody/vocalPerc have been added so far. */
  layerTrackIds: Partial<Record<LayerRole, string>>;
  layerEnvelopes: Partial<Record<LayerRole, number[]>>;
  layerStep: number;
}
/** The order layers are suggested to come in — drums are always on first. */
export const LAYER_ADD_ORDER: LayerRole[] = ["bass", "melody", "vocalPerc"];
export interface ClashPair { a: LayerRole; b: LayerRole; clash: number }

const PROGRESS_KEY = "dbdj.teachloop.v1";
const SCRATCH_KEY = "dbdj.teachloop.scratch.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export class TeachLoopService {
  readonly production: ProductionStudio;
  readonly looper: LiveLooper;
  private state: TeachLoopState;
  private listeners = new Set<(s: TeachLoopState) => void>();
  private padBus: GainNode | null = null;
  private padBuffers = new Map<PadId, AudioBuffer>();
  private attemptId = 0;
  private recStartErrorMs = 0;
  private recStartRaw = 0;

  constructor(private audio: WebAudioEngine, platform: Platform, stems: StemService, private storage: Storage | null = safeLocalStorage()) {
    this.production = new ProductionStudio(audio, platform, stems, SCRATCH_KEY);
    this.looper = new LiveLooper(audio, this.production, new PadCapture(() => this.ensurePadBus()));
    this.state = { activity: null, drill: null, phase: "ready", mode: "sandbox", taps: [], lastLoopResult: null, lastScore: null, milestonesEarned: this.loadProgress().milestones, progress: this.loadProgress().progress, interrupted: false, message: "Choose a lesson to begin.", learnerTrackId: null, ghostTrackId: null, layerTrackIds: {}, layerEnvelopes: {}, layerStep: 0 };
    // `document` is unavailable under plain Node (e.g. unit tests instantiating this service without a DOM) — guarded so construction stays safe there.
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.hidden) this.interrupt(); });
    audio.on((e) => { if (e.type === "status" && e.status.state === "suspended" && (this.state.phase === "countin" || this.state.phase === "practice")) this.interrupt(); });
  }

  subscribe = (l: (s: TeachLoopState) => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): TeachLoopState => this.state;
  private set(patch: Partial<TeachLoopState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); }
  /** The lesson's own bar length — read live from its project rather than assumed, in case a later phase changes tempo mid-lesson. */
  private bar(): number { const p = this.production.getState().project; return barSeconds(p.bpm, p.timeSignature[0]); }

  // ── setup ──
  private async ensurePadBus(): Promise<{ context: AudioContext; node: GainNode }> {
    const out = await this.audio.createProductionOutput();
    if (!this.padBus || this.padBus.context !== out.context) { this.padBus = out.context.createGain(); this.padBus.connect(out.input); }
    return { context: out.context, node: this.padBus };
  }
  private async ensurePads(): Promise<void> {
    const { context: ctx } = await this.ensurePadBus();
    if (this.padBuffers.size === PADS.length) return;
    for (const p of PADS) if (!this.padBuffers.has(p.id)) this.padBuffers.set(p.id, await synthesizePad(ctx.sampleRate, p.id));
  }
  /** Plays a pad through the (audible + recordable) pad bus. Ignored outside a running lesson context so stray keys are harmless. */
  async hitPad(id: PadId): Promise<void> {
    await this.ensurePads(); const { context: ctx, node: bus } = await this.ensurePadBus();
    const buffer = this.padBuffers.get(id); if (!buffer) return;
    const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(bus); src.start();
  }
  /** Ensures the lesson's looper session exists, set to the default lesson tempo, with the two tracks this module uses. */
  private async ensureSession(): Promise<{ learnerId: string; ghostId: string }> {
    this.looper.ensureSession(); this.production.updateProject({ bpm: DEFAULT_BPM });
    let session = this.looper.session();
    if (session.tracks.length < 2) { this.looper.addTrack("Backing"); session = this.looper.session(); }
    const learnerId = session.tracks[0].id, ghostId = session.tracks[1].id;
    this.looper.setTrack(learnerId, { name: "Your Loop" }, false);
    if (!session.tracks[1].protected) this.production.updateLooper((s) => { s.tracks[1].protected = true; s.tracks[1].name = "Backing (protected)"; }, "Ghost track protected", false);
    this.set({ learnerTrackId: learnerId, ghostTrackId: ghostId });
    return { learnerId, ghostId };
  }
  /** Ensures the lesson's looper session exists, set to the default lesson tempo, with the four tracks Module 2 uses (drums protected; bass/melody/vocalPerc the learner balances). */
  private async ensureLayeringSession(): Promise<Record<LayerRole, string>> {
    this.looper.ensureSession(); this.production.updateProject({ bpm: DEFAULT_BPM });
    let session = this.looper.session();
    while (session.tracks.length < 4) { this.looper.addTrack(); session = this.looper.session(); }
    const ids = { drums: session.tracks[0].id, bass: session.tracks[1].id, melody: session.tracks[2].id, vocalPerc: session.tracks[3].id } as Record<LayerRole, string>;
    const labels: Record<LayerRole, string> = { drums: "Drums (protected)", bass: "Bass", melody: "Melody", vocalPerc: "Vocal/Percussion" };
    for (const l of LAYERS) this.looper.setTrack(ids[l.role], { name: labels[l.role] }, false);
    if (!session.tracks[0].protected) this.production.updateLooper((s) => { s.tracks[0].protected = true; }, "Drums protected", false);
    this.set({ layerTrackIds: ids });
    return ids;
  }
  /** Seeds (or refreshes) the protected ghost backing loop. `kind` picks drums (Fix My Timing / Sandbox) or the synth phrase. */
  private async seedGhost(ghostId: string, kind: "drums" | "synth" | "misaligned"): Promise<void> {
    const ctx = await this.audio.createProductionOutput(); const bpm = DEFAULT_BPM; const beatsPerBar = DEFAULT_BEATS_PER_BAR; const bar = barSeconds(bpm, beatsPerBar);
    let buffer = kind === "synth" ? await synthesizeGhostSynth(ctx.context.sampleRate, bpm, beatsPerBar) : await synthesizeGhostDrums(ctx.context.sampleRate, bpm, beatsPerBar);
    let trimIn = 0;
    if (kind === "misaligned") {
      // "Fix My Timing": the same drum pattern, but its real downbeat sits 110 ms after sample 0 — a deliberately misaligned take.
      const offsetS = .11; const padded = ctx.context.createBuffer(1, buffer.length, buffer.sampleRate);
      const src = buffer.getChannelData(0), dst = padded.getChannelData(0); const shift = Math.round(offsetS * buffer.sampleRate);
      for (let i = 0; i < src.length; i++) dst[(i + shift) % src.length] = src[i];
      buffer = padded;
    }
    const data = buffer.getChannelData(0); const id = makeId("loop"); const ref = `production-loop://${id}`;
    await this.production.storeAudio(ref, encodeWav({ sampleRate: buffer.sampleRate, left: data }));
    this.production.updateLooper((s) => { const t = s.tracks.find((x) => x.id === ghostId); if (t) t.loop = { layers: [{ ref, peaks: [], recordedAt: Date.now() }], active: 1, bars: 1, anchorBar: 0, bpm, beatsPerBar, sampleRate: buffer.sampleRate, duration: bar, latencyMs: 0, recordedAt: Date.now(), trimIn }; }, "Ghost loop seeded", false);
  }

  // ── navigation ──
  openOverview(): void { this.looper.perform("panic").catch(() => undefined); this.set({ activity: null, drill: null, phase: "ready", taps: [], lastLoopResult: null, lastScore: null, interrupted: false, message: "Choose a lesson to begin.", layerStep: 0 }); }
  /** Strict disables record-boundary quantization (Threshold Recording arms and captures the raw, unquantized start) and assesses raw timing; Sandbox quantizes REC/LOOP to the bar so boundaries snap cleanly. Applies to this lesson's session only — the real Production Studio is never touched. */
  setMode(mode: TeachLoopMode): void {
    this.set({ mode });
    this.looper.setOptions({ thresholdRecord: mode === "strict", thresholdDb: -50, quantize: mode === "strict" ? "off" : "1-bar" });
  }

  async selectActivity(id: ActivityId): Promise<void> {
    const def = ACTIVITIES.find((a) => a.id === id); if (!def || def.planned) return;
    this.attemptId++; if (id === "layering") await this.ensureLayeringSession(); else await this.ensureSession(); this.setMode(this.state.mode);
    this.set({ activity: id, drill: null, phase: "ready", taps: [], lastLoopResult: null, lastScore: null, interrupted: false, layerStep: 0, message: def.summary });
  }

  /** Ready → Demonstration: plays the beat-one accent once, standing in for the thing the drill will judge the learner against. `drill` picks which of Module 1's two sub-drills "Start Practice" moves on to. */
  async playDemo(drill: "a" | "b"): Promise<void> {
    this.set({ phase: "demo", drill }); await this.ensurePads(); await this.hitPad("kick");
  }

  /** Starts the count-in (the real transport, real click, real beat-one accent) and auto-advances to practice once it completes. */
  private async beginCountIn(): Promise<void> {
    const attempt = this.attemptId; this.set({ phase: "countin", message: "Get ready…" });
    await this.looper.startClick(1);
    const check = () => {
      if (attempt !== this.attemptId) return;
      const live = this.looper.live();
      if (live.countIn === null) this.set({ phase: "practice", message: this.practiceMessage() });
      else setTimeout(check, 30);
    };
    check();
  }
  private practiceMessage(): string {
    if (this.state.drill === "a") return "Tap on beat one — the accented click.";
    return "Press ● REC on beat one, play a pad or two, then press ⟟ LOOP on the next beat one.";
  }

  // ── Drill A: beat-one taps ──
  async beginBeatDrill(): Promise<void> {
    this.attemptId++; this.set({ drill: "a", taps: [], lastScore: null, interrupted: false }); await this.beginCountIn();
  }
  /** Space, a pad, a pointer tap or a touch — all call this. Scored against the nearest bar line on the real audio clock. */
  tapBeatOne(): void {
    if (this.state.phase !== "practice" || this.state.activity !== "perfect-loop") return;
    const t = this.looper.now(); const origin = this.looper.getState().origin; if (t === null || origin === null) return;
    const bar = this.bar(); const errorMs = nearestBeatErrorMs(t, origin, bar);
    void this.hitPad("kick");
    const taps = [...this.state.taps, { errorMs, judgement: judgeTap(errorMs) }];
    this.set({ taps, message: describeTap(errorMs) });
    if (taps.length >= BEAT_ONE_ATTEMPTS) void this.finishBeatDrill();
  }
  private async finishBeatDrill(): Promise<void> {
    const attempt = this.attemptId; this.set({ phase: "evaluation" }); this.looper.perform("stop-all").catch(() => undefined);
    const errors = this.state.taps.map((t) => t.errorMs); const avgScore = Math.round(this.state.taps.reduce((n, t) => n + tapScore(t.errorMs), 0) / Math.max(1, errors.length));
    const consistency = consistencyScore(errors); const total = Math.round(avgScore * .7 + consistency * .3);
    if (attempt !== this.attemptId) return;
    const milestones: MilestoneId[] = []; if (this.state.taps.some((t) => t.judgement === "perfect")) milestones.push("foundDownbeat");
    this.recordResult("perfect-loop", total, milestones);
    this.set({ phase: "results", lastScore: total, message: `Average timing score ${avgScore}/100 · consistency ${consistency}/100.` });
  }

  // ── Drill B: capture a complete loop ──
  async beginLoopDrill(): Promise<void> { this.attemptId++; this.set({ drill: "b", lastLoopResult: null, lastScore: null, interrupted: false }); await this.beginCountIn(); }
  /** After Drill A's results, "Next" lands on Drill B's own ready screen (with its own demo) rather than skipping straight to practice. */
  goToDrillB(): void { this.attemptId++; this.set({ drill: "b", phase: "ready", taps: [], lastLoopResult: null, lastScore: null, interrupted: false, message: "Capture a complete loop." }); }
  /** Call exactly when the learner presses REC — captures the raw press time before the engine does anything with it. */
  beginLoopRecording(): void {
    if (this.state.phase !== "practice" || !this.state.learnerTrackId) return;
    const t = this.looper.now(); const origin = this.looper.getState().origin;
    this.recStartRaw = t ?? 0; this.recStartErrorMs = t !== null && origin !== null ? nearestBeatErrorMs(t, origin, this.bar()) : 0;
    void this.looper.perform("record", this.state.learnerTrackId);
  }
  /** Call exactly when the learner presses LOOP — captures the raw press time, then lets the engine close and build the real loop. */
  async endLoopRecording(): Promise<void> {
    if (!this.state.learnerTrackId) return;
    const attempt = this.attemptId; const t = this.looper.now(); const origin = this.looper.getState().origin;
    const endErrorMs = t !== null && origin !== null ? nearestBeatErrorMs(t, origin, this.bar()) : 0;
    const actualBars = t !== null ? (t - this.recStartRaw) / this.bar() : CHALLENGE_BARS;
    await this.looper.perform("loop");
    if (attempt !== this.attemptId) return;
    const result = scoreLoopCapture({ startErrorMs: this.recStartErrorMs, endErrorMs, actualBars, targetBars: CHALLENGE_BARS });
    const milestones: MilestoneId[] = ["firstLoop"]; // completing a playable loop always counts, regardless of mode
    if (this.state.mode === "strict" && result.total >= 70) milestones.push("foundDownbeat"); // precision milestone: strict (raw) timing only
    this.recordResult("perfect-loop", result.total, milestones);
    this.set({ phase: "results", lastLoopResult: result, lastScore: result.total, message: result.feedback.join(" ") });
  }

  // ── Fix My Timing ──
  async beginFixMyTiming(): Promise<void> {
    this.attemptId++; const { ghostId } = await this.ensureSession(); await this.seedGhost(ghostId, "misaligned");
    this.set({ activity: "fix-my-timing", phase: "practice", message: "Press ▶ on the backing loop — notice the kick doesn't land on the downbeat." });
    await this.looper.perform("play", ghostId);
  }
  /** Drags the correction in-point live (reuses Manual Trim exactly as the real Looper does). */
  setFixTrim(seconds: number): void { if (this.state.ghostTrackId) this.looper.setTrim(this.state.ghostTrackId, seconds); }
  async stripFixSilence(): Promise<void> {
    if (!this.state.ghostTrackId) return; await this.looper.stripSilence(this.state.ghostTrackId);
    this.recordResult("fix-my-timing", 100, ["fixedBoundary"]);
    this.set({ message: "Fixed — the kick now lands right on the downbeat. Compare: drag IN back to 0 to hear the original problem." });
  }

  // ── Progressive Sandbox Level 1 ──
  async beginSandbox(): Promise<void> {
    this.attemptId++; const { ghostId } = await this.ensureSession(); await this.seedGhost(ghostId, "drums");
    this.set({ activity: "sandbox-1", phase: "practice", message: "The backing loop is playing. Press ● REC on YOUR LOOP, play some pads, then ⟟ LOOP to close it." });
    await this.looper.perform("play", ghostId);
  }
  sandboxRecordToggle(): void { if (this.state.learnerTrackId) void this.looper.perform(this.looper.getState().recording ? "loop" : "record", this.state.learnerTrackId); }
  sandboxOverdub(): void { if (this.state.learnerTrackId) void this.looper.perform(this.looper.getState().recording?.kind === "overdub" ? "loop" : "overdub", this.state.learnerTrackId); }
  sandboxUndo(): void { if (this.state.learnerTrackId) this.looper.undoLayer(this.state.learnerTrackId); }
  sandboxMute(): void { if (this.state.learnerTrackId) this.looper.setTrack(this.state.learnerTrackId, { muted: !this.looper.session().tracks.find((t) => t.id === this.state.learnerTrackId)?.muted }, false); }
  sandboxClear(): void { if (this.state.learnerTrackId) this.looper.clear(this.state.learnerTrackId); }
  sandboxGhostMute(): void { if (this.state.ghostTrackId) this.looper.setTrack(this.state.ghostTrackId, { muted: !this.looper.session().tracks.find((t) => t.id === this.state.ghostTrackId)?.muted }, false); }
  sandboxGhostVolume(v: number): void { if (this.state.ghostTrackId) this.looper.setTrack(this.state.ghostTrackId, { volume: v }, false); }
  /** Called when the learner track first gets a playable loop (safe to call on every render — a no-op once the milestone is already earned, so it can never loop). */
  maybeAwardFirstLayer(): void {
    if (this.state.progress["sandbox-1"]?.milestones.includes("firstLayer")) return;
    const loop = this.state.learnerTrackId ? this.looper.session().tracks.find((t) => t.id === this.state.learnerTrackId)?.loop : null;
    if (loop) this.recordResult("sandbox-1", 100, ["firstLayer"]);
  }

  // ── Module 2: Layering & Frequency Management ──
  /**
   * Drums start alone; bass/melody/vocalPerc are pre-seeded too but muted, already looping in phase, so ADD LAYER
   * is an instant, perfectly-timed unmute rather than a fresh (and potentially late) play. Each layer's low-band
   * energy envelope is computed once at seed time (`lowBandEnvelope`, from the real rendered audio) so the clash
   * report is real analysis, not a guess — see `clashReport()`.
   */
  async beginLayering(): Promise<void> {
    this.attemptId++; const ids = await this.ensureLayeringSession();
    const out = await this.audio.createProductionOutput(); const bpm = DEFAULT_BPM; const beatsPerBar = DEFAULT_BEATS_PER_BAR; const bar = barSeconds(bpm, beatsPerBar);
    const envelopes: Partial<Record<LayerRole, number[]>> = {};
    for (const l of LAYERS) {
      const buffer = await synthesizeLayer(l.role, out.context.sampleRate, bpm, beatsPerBar);
      const data = buffer.getChannelData(0); envelopes[l.role] = lowBandEnvelope(data, buffer.sampleRate);
      const id = makeId("loop"); const ref = `production-loop://${id}`;
      await this.production.storeAudio(ref, encodeWav({ sampleRate: buffer.sampleRate, left: data }));
      this.production.updateLooper((s) => { const t = s.tracks.find((x) => x.id === ids[l.role]); if (t) { t.loop = { layers: [{ ref, peaks: [], recordedAt: Date.now() }], active: 1, bars: 1, anchorBar: 0, bpm, beatsPerBar, sampleRate: buffer.sampleRate, duration: bar, latencyMs: 0, recordedAt: Date.now(), trimIn: 0 }; t.muted = l.role !== "drums"; t.lowCutHz = undefined; } }, "Layer seeded", false);
    }
    this.set({ activity: "layering", phase: "practice", layerEnvelopes: envelopes, layerStep: 0, message: "Drums are playing. Press ADD LAYER to bring in the bass." });
    for (const l of LAYERS) await this.looper.perform("play", ids[l.role]); // all four start now, muted ones silent — so later unmutes are instant and stay in phase
  }
  /** Unmutes the next layer in the suggested order (bass → melody → vocalPerc). */
  addNextLayer(): void {
    const next = LAYER_ADD_ORDER[this.state.layerStep]; if (!next) return;
    const id = this.state.layerTrackIds[next]; if (!id) return;
    this.looper.setTrack(id, { muted: false }, false);
    const step = this.state.layerStep + 1; const def = LAYERS.find((l) => l.role === next)!;
    this.set({ layerStep: step, message: step < LAYER_ADD_ORDER.length ? `${def.label} is in — listen, then press ADD LAYER for the next one.` : "All four layers are in. Check the clash report below, then balance with MUTE, VOLUME or LOW CUT." });
  }
  /** Low-end clash between every pair of layers currently playing (drums plus however many have been added), worst first. */
  clashReport(): ClashPair[] {
    const active: LayerRole[] = ["drums", ...LAYER_ADD_ORDER.slice(0, this.state.layerStep)];
    const pairs: ClashPair[] = [];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const envA = this.state.layerEnvelopes[active[i]], envB = this.state.layerEnvelopes[active[j]];
      if (envA && envB) pairs.push({ a: active[i], b: active[j], clash: lowBandClash(envA, envB) });
    }
    return pairs.sort((x, y) => y.clash - x.clash);
  }
  layerMute(role: LayerRole): void { const id = this.state.layerTrackIds[role]; if (!id) return; const t = this.looper.session().tracks.find((x) => x.id === id); this.looper.setTrack(id, { muted: !t?.muted }, false); }
  layerVolume(role: LayerRole, v: number): void { const id = this.state.layerTrackIds[role]; if (id) this.looper.setTrack(id, { volume: v }, false); }
  layerLowCut(role: LayerRole, hz: number): void { const id = this.state.layerTrackIds[role]; if (id) this.looper.setLowCut(id, hz); }
  /** A/B: flips every correction (low cut + mute) on bass/melody/vocalPerc off, so the learner can hear "before" against their own "after". Press again to restore. */
  private layeringCompareState: Partial<Record<LayerRole, { lowCutHz?: number; muted: boolean }>> | null = null;
  toggleLayeringCompare(): void {
    const ids = this.state.layerTrackIds; const tracks = this.looper.session().tracks; const roles = LAYER_ADD_ORDER.slice(0, this.state.layerStep);
    if (this.layeringCompareState) {
      for (const r of roles) { const id = ids[r]; const saved = this.layeringCompareState[r]; if (id && saved) { this.looper.setLowCut(id, saved.lowCutHz ?? 20); this.looper.setTrack(id, { muted: saved.muted }, false); } }
      this.layeringCompareState = null; this.set({ message: "Back to your balanced mix." }); return;
    }
    const saved: Partial<Record<LayerRole, { lowCutHz?: number; muted: boolean }>> = {};
    for (const r of roles) { const id = ids[r]; const t = id && tracks.find((x) => x.id === id); if (id && t) { saved[r] = { lowCutHz: t.lowCutHz, muted: t.muted }; this.looper.setLowCut(id, 20); this.looper.setTrack(id, { muted: false }, false); } }
    this.layeringCompareState = saved; this.set({ message: "Before: every correction off. Press COMPARE again to hear your fix." });
  }
  /** All four layers in, plus some correction applied to at least one of the non-drum layers — idempotent, safe to call every render. */
  maybeAwardBalance(): void {
    if (this.state.progress["layering"]?.milestones.includes("balancedLowEnd")) return;
    if (this.state.layerStep < LAYER_ADD_ORDER.length) return;
    const ids = this.state.layerTrackIds; const tracks = this.looper.session().tracks;
    const corrected = LAYER_ADD_ORDER.some((r) => { const t = ids[r] && tracks.find((x) => x.id === ids[r]); return t && ((t.lowCutHz ?? 0) > 20 || t.muted); });
    if (corrected) this.recordResult("layering", 100, ["balancedLowEnd"]);
  }

  // ── retry / interruption ──
  retry(): void {
    this.attemptId++; this.looper.perform("panic").catch(() => undefined);
    this.set({ phase: "ready", taps: [], lastLoopResult: null, lastScore: null, interrupted: false, message: this.state.activity ? ACTIVITIES.find((a) => a.id === this.state.activity)?.summary ?? "" : "" });
  }
  private interrupt(): void {
    if (this.state.phase !== "countin" && this.state.phase !== "practice") return;
    this.attemptId++; this.looper.perform("panic").catch(() => undefined);
    this.set({ phase: "ready", interrupted: true, taps: [], message: "Attempt interrupted (the tab lost focus or audio paused) — not scored. Press Start to try again." });
  }

  // ── progress persistence ──
  private loadProgress(): { progress: Progress; milestones: MilestoneId[] } {
    try { const raw = this.storage?.getItem(PROGRESS_KEY); if (raw) return JSON.parse(raw); } catch { /* corrupt or unavailable: start fresh */ }
    return { progress: {}, milestones: [] };
  }
  private saveProgress(): void {
    try { this.storage?.setItem(PROGRESS_KEY, JSON.stringify({ progress: this.state.progress, milestones: this.state.milestonesEarned })); } catch { /* best-effort */ }
  }
  private recordResult(id: ActivityId, score: number, milestones: MilestoneId[]): void {
    const prior = this.state.progress[id]; const next: ActivityProgress = { attempts: (prior?.attempts ?? 0) + 1, completed: true, bestScore: Math.max(prior?.bestScore ?? 0, score), milestones: Array.from(new Set([...(prior?.milestones ?? []), ...milestones])) };
    const earned = Array.from(new Set([...this.state.milestonesEarned, ...milestones]));
    this.set({ progress: { ...this.state.progress, [id]: next }, milestonesEarned: earned });
    this.saveProgress();
  }
  /** "Reset training progress" with confirmation is the UI's job; this just clears the store. */
  resetProgress(): void { this.set({ progress: {}, milestonesEarned: [] }); this.saveProgress(); }
}

function safeLocalStorage(): Storage | null { try { return localStorage; } catch { return null; } }
export const MILESTONE_LABELS = MILESTONES;

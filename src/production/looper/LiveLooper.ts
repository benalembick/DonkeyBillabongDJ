/**
 * Live Looper — Phase 1 (core looping) + Phase 2 (overdub & timing). See docs/LIVE-LOOPER.md.
 *
 * Transport: an audio-clock origin (bar 0) at the project BPM / time signature. Recording starts on the bar grid
 * (after a one-bar count-in when the transport is stopped); LOOP closes on the nearest bar, so loops are whole bars
 * and stay in phase. The input is Vocal Studio's capture chain (same device, trim, monitoring, latency).
 *
 * Phase 2 adds: non-destructive OVERDUB layers (summed at playback, UNDO/REDO just moves how many are active);
 * LOOP QUANTIZE for PLAY/STOP/TOGGLE (and, clamped to whole bars, REC/LOOP); and the master loop — with no loops
 * yet and the transport stopped, REC is free-running and LOOP runs tempo detection on the take to propose the
 * project's BPM, bar count and downbeat.
 *
 * Also: Threshold Recording (Auto-Start) — REC arms and waits silently for input past a dB threshold before the
 * take actually starts, so a base-loop recording never has to carry leading silence. And Manual Trim — a non-
 * destructive playback in-point (`LoopAudio.trimIn`) a performer can drag after the fact, or set in one click with
 * STRIP SILENCE (reuses the Sampler's `analyseClean`).
 *
 * The input is pluggable (`LooperInputSource`): Vocal Studio's mic capture chain in Production Studio, or (Teach
 * Me: Live Looping) a `PadCapture` tapping the lesson's own pad bus instead, so a tutorial never needs a
 * microphone. `LoopTrack.protected` (Teach Me's ghost backing loops) refuses REC/DUB/CLEAR/remove but still allows
 * volume/mute, so a protected track behaves exactly like a normal one for listening.
 *
 * Graph: loop voice(s) → voice fade → track gain (volume · mute · solo) → looper bus → Production Studio output.
 * Click / count-in → monitor output (headphone mix when the engine has 4-channel routing, never forced to the PA).
 *
 * Every user action goes through `perform()` so later phases can map MIDI pedals / controllers to it.
 */
import type { WebAudioEngine } from "../../audio/WebAudioEngine";
import type { ProductionStudio } from "../ProductionStudio";
import { analyseClean, detectTransients } from "../slicing";
import { blankLooper, makeId, type LoopLayer, type LoopTrack, type LooperSession } from "../types";
import { encodeWav } from "../wav";
import { estimateTempo } from "./tempo";
import { barSeconds, closeLoop, dbToLinear, extract, firstPassPlan, foldCycles, loopPeaks, loopPhase, loopRegion, nextBar, sealLoop, thresholdCrossing, trimmedOffset } from "./timing";

/** What `record()`/`overdub()`/`panic()` need from an input (Vocal Studio's mic chain, or Teach Me's PadCapture). */
export interface LooperInputSource {
  beginCapture(onChunk?: (data: Float32Array, frame: number) => void): Promise<{ context: AudioContext; latency: number; stop(): Promise<{ data: Float32Array; start: number; rate: number }> }>;
  setSettings(patch: { monitor?: boolean }): void;
}

export type LoopStatus = "empty" | "armed" | "queued" | "recording" | "closing" | "playing" | "stopped";
export type LooperAction = "record" | "overdub" | "loop" | "play" | "stop" | "toggle" | "mute" | "solo" | "clear" | "undo" | "redo" | "strip-silence" | "select" | "next-track" | "play-all" | "stop-all" | "mute-all" | "panic";
type RecKind = "base" | "overdub" | "master";
export interface MasterProposal { trackId: string; bpm: number; bars: number; beatsPerBar: number; downbeat: number; confidence: number }
export interface LooperState { running: boolean; origin: number | null; recording: { trackId: string; start: number; closing: { bars: number; end: number } | null; kind: RecKind; armed: boolean } | null; playing: string[]; proposal: MasterProposal | null; message: string }
export interface LooperLive { status: Record<string, LoopStatus>; progress: Record<string, number>; bar: number; beat: number; countIn: number | null; recordingBars: number }

interface Voice { sources: AudioBufferSourceNode[]; fade: GainNode }
interface Capture { stop(): Promise<{ data: Float32Array; start: number; rate: number }>; chunks: { data: Float32Array; frame: number }[]; latency: number }
/** Raw audio awaiting confirmation as the master loop (Phase 2): already latency-compensated, musical time = rec.start + index/rate. */
interface MasterCapture { trackId: string; data: Float32Array; rate: number; start: number }

export class LiveLooper {
  private state: LooperState = { running: false, origin: null, recording: null, playing: [], proposal: null, message: "Press ● REC on a track to record your first loop" };
  private listeners = new Set<(s: LooperState) => void>();
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private clickOut: GainNode | null = null;
  private gains = new Map<string, GainNode>();
  private filters = new Map<string, BiquadFilterNode>();
  private voices = new Map<string, Voice>();
  /** The layer refs (joined) each playing voice currently sounds — lets `reconcile()` rebuild only when they change. */
  private voiceLayers = new Map<string, string>();
  private buffers = new Map<string, AudioBuffer>();
  private capture: Capture | null = null;
  private masterCapture: MasterCapture | null = null;
  private clickTimer: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private busy = false;
  private queuedPlay = new Set<string>();
  /** Resolves the pending Threshold Recording arm-wait with the trigger's capture-clock time, or null if cancelled. */
  private armResolve: ((t: number | null) => void) | null = null;

  constructor(private audio: WebAudioEngine, private studio: ProductionStudio, private vocal: LooperInputSource) {
    // Undo / reopen / overdub / undo-redo can change loops underneath playback: keep voices in sync.
    studio.subscribe(() => this.reconcile());
  }

  subscribe = (l: (s: LooperState) => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): LooperState => this.state;
  private set(patch: Partial<LooperState>): void { this.state = { ...this.state, ...patch, playing: [...this.voices.keys()] }; for (const l of this.listeners) l(this.state); }

  /** The project's looper session (created with the default tracks the first time). */
  session(): LooperSession { return this.studio.getState().project.looper ?? blankLooper(); }
  ensureSession(): void { if (!this.studio.getState().project.looper) this.studio.updateLooper(() => undefined, "Live Looper session created", false); }
  /** The audio-clock time driving the transport (null until the engine has started) — the timing authority for anything scored against this looper, e.g. Teach Me: Live Looping. */
  now(): number | null { return this.ctx?.currentTime ?? null; }
  /** Starts the transport (count-in then click) with no track recording — for lesson beat practice that isn't capturing a loop. Stop with `stopAll()`. */
  async startClick(countInBars = 1): Promise<void> {
    if (this.state.recording || this.state.running) return;
    const ctx = await this.ensureAudio(); const count = Math.max(0, countInBars);
    this.startTransport(ctx.currentTime + .12 + count * this.bar(), count);
  }
  private bar(): number { const p = this.studio.getState().project; return barSeconds(p.bpm, p.timeSignature[0]); }
  private track(id: string | null | undefined): LoopTrack | undefined { return this.session().tracks.find((t) => t.id === id); }
  /** LOOP QUANTIZE in seconds (0 = off). PLAY/STOP/TOGGLE use it directly; REC/LOOP clamp it up to a whole bar. */
  private gridSeconds(): number {
    const grid = this.session().quantize; if (grid === "off") return 0;
    const p = this.studio.getState().project; const beat = 60 / p.bpm; const bar = beat * p.timeSignature[0];
    if (grid === "1/4-beat") return beat / 4; if (grid === "1/2-beat") return beat / 2; if (grid === "1-beat") return beat;
    if (grid === "2-bar") return bar * 2; if (grid === "4-bar") return bar * 4; return bar;
  }

  /** Central command entry (buttons today; MIDI foot controllers / keys in Phase 8). */
  async perform(action: LooperAction, trackId?: string): Promise<void> {
    const id = trackId ?? this.session().selectedTrackId ?? undefined;
    switch (action) {
      case "record": return this.record(id);
      case "overdub": return this.overdub(id);
      case "loop": return this.closeRecording();
      case "play": return id ? this.play(id) : undefined;
      case "stop": if (id) await this.stopTrack(id); return;
      case "toggle": if (id) { if (this.voices.has(id)) await this.stopTrack(id); else await this.play(id); } return;
      case "mute": if (id) this.setTrack(id, { muted: !this.track(id)?.muted }, false); return;
      case "solo": if (id) this.setTrack(id, { solo: !this.track(id)?.solo }, false); return;
      case "clear": if (id) this.clear(id); return;
      case "undo": if (id) this.undoLayer(id); return;
      case "redo": if (id) this.redoLayer(id); return;
      case "strip-silence": if (id) await this.stripSilence(id); return;
      case "select": if (id) this.select(id); return;
      case "next-track": this.selectNextEmpty(); return;
      case "play-all": return this.playAll();
      case "stop-all": return this.stopAll();
      case "mute-all": this.muteAll(); return;
      case "panic": return this.panic();
    }
  }

  private async ensureAudio(): Promise<AudioContext> {
    if (this.ctx && this.ctx.state !== "closed" && this.bus) { await this.audio.start(); return this.ctx; }
    const out = await this.audio.createProductionOutput(); const monitor = await this.audio.createMonitorOutput();
    this.ctx = out.context; this.bus = out.input; this.clickOut = monitor.input; this.gains.clear(); this.filters.clear(); this.voices.clear(); this.voiceLayers.clear(); this.buffers.clear(); return this.ctx;
  }
  private gainFor(trackId: string): GainNode {
    let g = this.gains.get(trackId); if (!g) { g = this.ctx!.createGain(); g.connect(this.bus!); this.gains.set(trackId, g); this.applyGains(); } return g;
  }
  /** A voice connects here (not straight to the track gain) so LOW CUT can roll off its bass without a separate node per voice. 20 Hz is "off" — inaudible, avoids a separate enabled flag. */
  private filterFor(trackId: string): BiquadFilterNode {
    let f = this.filters.get(trackId);
    if (!f) { f = this.ctx!.createBiquadFilter(); f.type = "highpass"; f.Q.value = .7; f.frequency.value = 20; f.connect(this.gainFor(trackId)); this.filters.set(trackId, f); this.applyFilters(); }
    return f;
  }
  /** Volume × mute × solo for every track (smoothed, so changes never click). */
  private applyGains(): void {
    const tracks = this.session().tracks; const anySolo = tracks.some((t) => t.solo);
    for (const t of tracks) { const g = this.gains.get(t.id); if (!g) continue; const level = t.muted || (anySolo && !t.solo) ? 0 : t.volume; g.gain.setTargetAtTime(level, g.context.currentTime, .012); }
  }
  /** LOW CUT per track (Phase 2 teaching tool: frequency-clash correction, but a real mixing control for any loop). */
  private applyFilters(): void {
    const tracks = this.session().tracks;
    for (const t of tracks) { const f = this.filters.get(t.id); if (!f) continue; f.frequency.setTargetAtTime(Math.max(20, t.lowCutHz ?? 20), f.context.currentTime, .02); }
  }
  private async getBuffer(ref: string): Promise<AudioBuffer> {
    let b = this.buffers.get(ref); if (!b) { b = await this.studio.getBuffer(ref); this.buffers.set(ref, b); } return b;
  }
  /** Change-detection key for a track's current sound: its active layer refs plus the Manual Trim in-point. */
  private layerKey(loop: { layers: LoopLayer[]; active: number; trimIn: number }): string { return `${loop.layers.slice(0, loop.active).map((l) => l.ref).join("|")}#${loop.trimIn}`; }

  // ── transport ──
  private startTransport(origin: number, countInBars: number): void {
    this.set({ running: true, origin }); this.nextBeat = -countInBars * this.studio.getState().project.timeSignature[0];
    if (this.clickTimer) clearInterval(this.clickTimer); this.clickTimer = setInterval(() => this.scheduleClicks(), 25); this.scheduleClicks();
  }
  private stopTransport(): void { if (this.clickTimer) clearInterval(this.clickTimer); this.clickTimer = null; this.set({ running: false, origin: null }); }
  /** Click 150 ms ahead on the audio clock; the count-in always clicks, the rest only with CLICK on. */
  private scheduleClicks(): void {
    const ctx = this.ctx; const origin = this.state.origin; if (!ctx || origin === null || !this.clickOut) return;
    const p = this.studio.getState().project; const beat = 60 / p.bpm; const beats = p.timeSignature[0]; const click = this.session().click;
    while (origin + this.nextBeat * beat < ctx.currentTime + .15) {
      const t = origin + this.nextBeat * beat; const b = this.nextBeat++; if (t < ctx.currentTime - .01 || (b >= 0 && !click)) continue;
      const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.frequency.value = ((b % beats) + beats) % beats === 0 ? 1760 : 1100;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(b < 0 ? .4 : .25, t + .002); g.gain.exponentialRampToValueAtTime(.0001, t + .05); osc.connect(g).connect(this.clickOut); osc.start(t); osc.stop(t + .06);
    }
  }

  // ── recording ──
  /**
   * REC: starts recording on the bar grid (count-in when stopped). With no loops yet, recording is free-running —
   * LOOP detects the tempo. REC again on the recording track = LOOP. With Threshold Recording on, REC arms and
   * waits silently instead (see `armAndWait`); pressing REC/LOOP again while armed cancels it.
   */
  async record(trackId?: string): Promise<void> {
    if (this.busy) return; const rec = this.state.recording;
    if (rec) { if (!trackId || rec.trackId === trackId) return this.closeRecording(); this.set({ message: "Finish the current loop first (press LOOP)" }); return; }
    if (this.state.proposal) { this.set({ message: "Confirm or discard the detected tempo first" }); return; }
    const track = this.track(trackId); if (!track) { this.set({ message: "Choose a track" }); return; }
    if (track.protected) { this.set({ message: `${track.name} is a protected backing loop` }); return; }
    if (track.loop) { this.set({ message: `${track.name} already has a loop — ⧉ DUB to layer another pass, or CLEAR it first` }); return; }
    const session = this.session(); const armThreshold = session.thresholdRecord ? dbToLinear(session.thresholdDb) : null;
    this.busy = true; let armed = false;
    try {
      this.ensureSession(); const ctx = await this.ensureAudio(); const chunks: Capture["chunks"] = [];
      const handle = await this.vocal.beginCapture((data, frame) => { chunks.push({ data, frame }); if (armThreshold !== null) this.checkThreshold(data, frame, ctx.sampleRate, armThreshold); });
      this.capture = { stop: handle.stop, chunks, latency: handle.latency };
      const freeRunning = !this.session().tracks.some((t) => t.loop) && !this.state.running; const kind: RecKind = freeRunning ? "master" : "base";
      this.select(track.id);
      if (armThreshold !== null) {
        armed = true;
        this.set({ recording: { trackId: track.id, start: ctx.currentTime, closing: null, kind, armed: true }, message: `Armed on ${track.name} — waiting for sound past ${session.thresholdDb} dB…` });
      } else {
        let start: number;
        if (freeRunning) { start = ctx.currentTime + .12; }
        else if (!this.state.running || this.state.origin === null) { const count = session.countIn ? 1 : 0; start = ctx.currentTime + .12 + count * this.bar(); this.startTransport(start, count); }
        else { const unit = Math.max(this.bar(), this.gridSeconds()); start = nextBar(this.state.origin, unit, ctx.currentTime, .05).time; }
        this.set({ recording: { trackId: track.id, start, closing: null, kind, armed: false }, message: kind === "master" ? `Recording ${track.name} freely — play a few bars, then press LOOP to set the tempo` : `Recording ${track.name} — press LOOP to close it on the nearest bar` });
      }
    } catch (error) { this.capture = null; this.set({ message: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { this.busy = false; }
    if (armed) await this.armAndWait(trackId);
  }

  /** Waits (outside `busy`, so REC/LOOP can still cancel it) for the input to cross the threshold, then starts the take from that instant. */
  private async armAndWait(trackId: string | undefined): Promise<void> {
    const triggerTime = await new Promise<number | null>((resolve) => { this.armResolve = resolve; }); this.armResolve = null;
    const rec = this.state.recording; if (!rec || rec.trackId !== trackId || !rec.armed) return; // cancelled or superseded while waiting
    if (triggerTime === null) return; // cancelArm() already cleaned up and messaged
    const capture = this.capture; const start = Math.max(0, triggerTime - (capture?.latency ?? 0));
    if (rec.kind === "base" && (!this.state.running || this.state.origin === null)) this.startTransport(start, 0);
    this.set({ recording: { ...rec, start, armed: false }, message: rec.kind === "master" ? `Recording ${this.track(trackId)?.name ?? "loop"} freely — play a few bars, then press LOOP to set the tempo` : `Recording ${this.track(trackId)?.name ?? "loop"} — press LOOP to close it on the nearest bar` });
  }
  /** Scans an incoming capture chunk for the Threshold Recording trigger (first sample past the dB threshold). */
  private checkThreshold(data: Float32Array, frame: number, rate: number, linear: number): void {
    if (!this.armResolve) return; const i = thresholdCrossing(data, linear); if (i < 0) return;
    const resolve = this.armResolve; this.armResolve = null; resolve((frame + i) / rate);
  }

  /** OVERDUB: layers another pass over an existing loop, starting on that loop's own next cycle so it's always in phase. */
  async overdub(trackId?: string): Promise<void> {
    if (this.busy) return; const rec = this.state.recording;
    if (rec) { if (!trackId || rec.trackId === trackId) return this.closeRecording(); this.set({ message: "Finish the current loop first (press LOOP)" }); return; }
    const track = this.track(trackId); if (!track?.loop) { this.set({ message: "Record a loop on this track first" }); return; }
    if (track.protected) { this.set({ message: `${track.name} is a protected backing loop` }); return; }
    const p = this.studio.getState().project;
    if (Math.abs(track.loop.bpm - p.bpm) > 1e-6 || track.loop.beatsPerBar !== p.timeSignature[0]) { this.set({ message: `${track.name} was recorded at ${track.loop.bpm} BPM — set the project back to it to overdub` }); return; }
    this.busy = true;
    try {
      const ctx = await this.ensureAudio(); const chunks: Capture["chunks"] = [];
      const handle = await this.vocal.beginCapture((data, frame) => chunks.push({ data, frame })); this.capture = { stop: handle.stop, chunks, latency: handle.latency };
      if (!this.state.running || this.state.origin === null) this.startTransport(ctx.currentTime + .05, 0);
      if (!this.voices.has(track.id)) await this.play(track.id);
      const bar = this.bar(); const cycle = track.loop.bars * bar; const phaseOrigin = this.state.origin! + track.loop.anchorBar * bar;
      const start = nextBar(phaseOrigin, cycle, ctx.currentTime, .05).time;
      this.select(track.id);
      this.set({ recording: { trackId: track.id, start, closing: null, kind: "overdub", armed: false }, message: `Overdubbing ${track.name} — press ⧉ DUB again to close it (holding through more passes layers them together)` });
    } catch (error) { this.capture = null; this.set({ message: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { this.busy = false; }
  }

  /**
   * LOOP: closes the current recording. A base recording rounds to the nearest whole bar (quantize clamped up to
   * at least one bar) and starts repeating seamlessly from the audio captured so far. An overdub rounds to the
   * nearest whole loop cycle and is folded into one new non-destructive layer. A free-running (master) take runs
   * tempo detection instead — see `closeMaster`.
   */
  async closeRecording(): Promise<void> {
    const rec = this.state.recording; if (rec?.armed) { await this.discardRecording("Recording cancelled"); return; }
    const capture = this.capture; const ctx = this.ctx; if (!rec || !capture || !ctx || rec.closing || this.busy) return;
    const now = ctx.currentTime;
    if (now < rec.start) { await this.discardRecording("Recording cancelled before it started"); return; }
    this.busy = true;
    try {
      if (rec.kind === "master") { await this.closeMaster(rec, capture, ctx); return; }
      const bar = this.bar();
      if (rec.kind === "overdub") { await this.closeOverdub(rec, capture, ctx, bar); return; }
      const unit = Math.max(bar, this.gridSeconds()); const unitBars = Math.round(unit / bar);
      const { bars: units, end } = closeLoop(rec.start, unit, now); const bars = units * unitBars; const length = bars * bar; const latency = capture.latency; const rate = ctx.sampleRate;
      this.set({ recording: { ...rec, closing: { bars, end } }, message: `Closing loop · ${bars} bar${bars === 1 ? "" : "s"}` });
      const anchorBar = Math.round((rec.start - this.state.origin!) / bar) % bars; const phaseAt = (t: number) => loopPhase(t, this.state.origin!, bar, anchorBar, bars);
      const fade = ctx.createGain(); fade.connect(this.filterFor(rec.trackId)); const voice: Voice = { sources: [], fade };
      // Provisional first pass from what is already captured (the tail follows from the final audio).
      const so = this.snapshot(capture.chunks, rate); const haveSeconds = so ? (so.start + so.data.length / rate) - (rec.start + latency) : 0;
      const plan = firstPassPlan(end, length, haveSeconds, ctx.currentTime);
      if (plan.provisional && so) { const r = loopRegion(so.start, rate, rec.start, latency, plan.provisional.duration); this.startSource(voice, this.toBuffer(ctx, sealLoop(extract(so.data, r.from, r.frames), rate, 0)), plan.provisional.at, 0, plan.provisional.duration, false); this.stopVoice(rec.trackId); this.voices.set(rec.trackId, voice); }
      // Keep capturing until the loop end has fully arrived (plus latency), then build the loop.
      await this.until(ctx, end + latency + .06);
      const captured = await capture.stop(); this.capture = null;
      const region = loopRegion(captured.start, captured.rate, rec.start, latency, length); const data = sealLoop(extract(captured.data, region.from, region.frames), captured.rate);
      const buffer = this.toBuffer(ctx, data);
      if (plan.provisional) { const from = end + plan.restFrom; const when = Math.max(ctx.currentTime + .01, from); const offset = plan.restFrom + (when - from); if (offset < length - .005) this.startSource(voice, buffer, when, offset, length - offset, false); }
      const loopAt = plan.provisional ? plan.loopAt : Math.max(ctx.currentTime + .02, plan.loopAt);
      this.startSource(voice, buffer, loopAt, phaseAt(loopAt), undefined, true);
      if (!plan.provisional) { this.stopVoice(rec.trackId); } this.voices.set(rec.trackId, voice);
      const id = makeId("loop"); const ref = `production-loop://${id}`; this.buffers.set(ref, buffer); this.voiceLayers.set(rec.trackId, ref);
      await this.studio.storeAudio(ref, encodeWav({ sampleRate: captured.rate, left: data }));
      const p = this.studio.getState().project;
      this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === rec.trackId); if (t) t.loop = { layers: [{ ref, peaks: loopPeaks(data), recordedAt: Date.now() }], active: 1, bars, anchorBar, bpm: p.bpm, beatsPerBar: p.timeSignature[0], sampleRate: captured.rate, duration: length, latencyMs: latency * 1000, recordedAt: Date.now(), trimIn: 0 }; }, `Loop recorded · ${bars} bar${bars === 1 ? "" : "s"}`);
      this.set({ recording: null }); this.selectNextEmpty();
      this.set({ message: `${this.track(rec.trackId)?.name ?? "Loop"}: ${bars} bar${bars === 1 ? "" : "s"} looping · next: ${this.track(this.session().selectedTrackId)?.name ?? "add a track"}` });
    } catch (error) { await this.discardRecording(`Loop failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.busy = false; }
  }

  private async closeOverdub(rec: NonNullable<LooperState["recording"]>, capture: Capture, ctx: AudioContext, bar: number): Promise<void> {
    const track = this.track(rec.trackId); const loop = track?.loop;
    if (!loop) { await this.discardRecording("That loop is gone — overdub cancelled"); return; }
    const cycle = loop.bars * bar; const now = ctx.currentTime;
    const { bars: cycles, end } = closeLoop(rec.start, cycle, now, 16); const length = cycles * cycle; const latency = capture.latency;
    this.set({ recording: { ...rec, closing: { bars: cycles, end } }, message: `Closing overdub · ${cycles} pass${cycles === 1 ? "" : "es"}` });
    await this.until(ctx, end + latency + .06);
    const captured = await capture.stop(); this.capture = null;
    const region = loopRegion(captured.start, captured.rate, rec.start, latency, length);
    const raw = extract(captured.data, region.from, region.frames);
    const folded = sealLoop(foldCycles(raw, Math.round(cycle * captured.rate)), captured.rate);
    const id = makeId("loop"); const ref = `production-loop://${id}`;
    await this.studio.storeAudio(ref, encodeWav({ sampleRate: captured.rate, left: folded }));
    this.buffers.set(ref, this.toBuffer(ctx, folded));
    const layer: LoopLayer = { ref, peaks: loopPeaks(folded), recordedAt: Date.now() };
    this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === rec.trackId); if (!t?.loop) return; t.loop.layers = [...t.loop.layers.slice(0, t.loop.active), layer]; t.loop.active = t.loop.layers.length; }, "Overdub recorded");
    this.set({ recording: null, message: `${track?.name ?? "Loop"}: overdub layered · ${cycles} pass${cycles === 1 ? "" : "es"}` });
  }

  /**
   * The free-running take becomes the master loop: run tempo detection and hold the raw capture for confirmation
   * (`confirmMaster` / `discardMaster`) rather than committing immediately, since the estimate can be wrong.
   */
  private async closeMaster(rec: NonNullable<LooperState["recording"]>, capture: Capture, ctx: AudioContext): Promise<void> {
    const now = ctx.currentTime; const latency = capture.latency;
    this.set({ recording: { ...rec, closing: { bars: 0, end: now } }, message: "Analysing tempo…" });
    await this.until(ctx, now + latency + .06);
    const captured = await capture.stop(); this.capture = null;
    const from = Math.max(0, Math.round((rec.start + latency - captured.start) * captured.rate));
    const data = captured.data.subarray(from); const duration = data.length / captured.rate;
    const onsets = detectTransients(data, captured.rate); const beatsPerBar = this.studio.getState().project.timeSignature[0];
    const estimate = estimateTempo(onsets, duration, beatsPerBar);
    if (!estimate) { await this.discardRecording("Couldn't detect a tempo — try a clearer rhythm, or set the project BPM first and record normally"); return; }
    this.masterCapture = { trackId: rec.trackId, data: Float32Array.from(data), rate: captured.rate, start: rec.start };
    this.set({ recording: null, proposal: { trackId: rec.trackId, bpm: estimate.bpm, bars: estimate.bars, beatsPerBar: estimate.beatsPerBar, downbeat: estimate.downbeat, confidence: estimate.confidence }, message: `Tempo detected: ${estimate.bpm} BPM, ${estimate.bars} bar${estimate.bars === 1 ? "" : "s"} — check and confirm` });
  }

  /** Commits the detected (or corrected) tempo as the project's and starts the master loop. */
  async confirmMaster(overrides?: Partial<{ bpm: number; bars: number }>): Promise<void> {
    const cap = this.masterCapture; const proposal = this.state.proposal; const ctx = this.ctx; if (!cap || !proposal || !ctx) return;
    const bpm = Math.max(40, Math.min(240, overrides?.bpm ?? proposal.bpm)); const bars = Math.max(1, Math.round(overrides?.bars ?? proposal.bars));
    const beatsPerBar = proposal.beatsPerBar; const bar = 60 / bpm * beatsPerBar; const length = bars * bar;
    const from = Math.round(proposal.downbeat * cap.rate); const frames = Math.round(length * cap.rate);
    const sealed = sealLoop(extract(cap.data, from, frames), cap.rate); const buffer = this.toBuffer(ctx, sealed);
    this.studio.updateProject({ bpm });
    const origin = cap.start + proposal.downbeat;
    this.startTransport(origin, 0);
    const id = makeId("loop"); const ref = `production-loop://${id}`;
    await this.studio.storeAudio(ref, encodeWav({ sampleRate: cap.rate, left: sealed }));
    this.buffers.set(ref, buffer); this.voiceLayers.set(cap.trackId, ref);
    this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === cap.trackId); if (t) t.loop = { layers: [{ ref, peaks: loopPeaks(sealed), recordedAt: Date.now() }], active: 1, bars, anchorBar: 0, bpm, beatsPerBar, sampleRate: cap.rate, duration: length, latencyMs: 0, recordedAt: Date.now(), trimIn: 0 }; }, `Master loop set · ${bpm} BPM, ${bars} bar${bars === 1 ? "" : "s"}`);
    const fade = ctx.createGain(); fade.connect(this.filterFor(cap.trackId)); const voice: Voice = { sources: [], fade };
    const at = Math.max(ctx.currentTime + .02, origin);
    this.startSource(voice, buffer, at, loopPhase(at, origin, bar, 0, bars), undefined, true);
    this.voices.set(cap.trackId, voice);
    this.masterCapture = null; this.set({ proposal: null }); this.selectNextEmpty();
    this.set({ message: `Master loop set: ${bpm} BPM · ${bars} bar${bars === 1 ? "" : "s"} — next: ${this.track(this.session().selectedTrackId)?.name ?? "add a track"}` });
  }
  discardMaster(): void { this.masterCapture = null; this.set({ proposal: null, message: "Discarded — press ● REC to try again" }); }

  private async discardRecording(message: string): Promise<void> {
    if (this.armResolve) { const r = this.armResolve; this.armResolve = null; r(null); }
    const capture = this.capture; this.capture = null; const rec = this.state.recording; if (capture) await capture.stop().catch(() => undefined);
    if (rec && rec.kind !== "overdub" && !this.track(rec.trackId)?.loop) this.stopVoice(rec.trackId);
    this.set({ recording: null, message }); if (!this.voices.size) this.stopTransport();
  }
  private snapshot(chunks: Capture["chunks"], rate: number): { data: Float32Array; start: number } | null {
    if (!chunks.length) return null; const total = chunks.reduce((n, c) => n + c.data.length, 0); const data = new Float32Array(total); let at = 0; for (const c of chunks) { data.set(c.data, at); at += c.data.length; } return { data, start: chunks[0].frame / rate };
  }
  private toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer { const b = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate); b.getChannelData(0).set(data); return b; }
  private until(ctx: AudioContext, t: number): Promise<void> { return new Promise((resolve) => { const check = () => (ctx.currentTime >= t ? resolve() : setTimeout(check, Math.max(5, (t - ctx.currentTime) * 1000))); check(); }); }

  // ── playback ──
  private startSource(voice: Voice, buffer: AudioBuffer, when: number, offset: number, duration: number | undefined, loop: boolean): void {
    const ctx = voice.fade.context; const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = loop; if (loop) { src.loopStart = 0; src.loopEnd = buffer.duration; }
    src.connect(voice.fade); if (duration === undefined) src.start(when, offset); else src.start(when, offset, duration); voice.sources.push(src);
  }
  /** Starts every active layer of a loop in phase with the transport (starting the transport if needed). Quantised to LOOP QUANTIZE when already running. */
  async play(trackId: string): Promise<void> {
    const track = this.track(trackId); if (!track?.loop || this.voices.has(trackId)) return; const p = this.studio.getState().project;
    if (Math.abs(track.loop.bpm - p.bpm) > 1e-6 || track.loop.beatsPerBar !== p.timeSignature[0]) { this.set({ message: `${track.name} was recorded at ${track.loop.bpm} BPM ${track.loop.beatsPerBar}/4 — set the project back to it to play in sync (time-stretch arrives in a later phase)` }); return; }
    const ctx = await this.ensureAudio(); const layers = track.loop.layers.slice(0, track.loop.active); const buffers = await Promise.all(layers.map((l) => this.getBuffer(l.ref)));
    if (this.voices.has(trackId)) return;
    if (!this.state.running || this.state.origin === null) this.startTransport(ctx.currentTime + .05, 0);
    else { const grid = this.gridSeconds(); if (grid > 0) { this.queuedPlay.add(trackId); await this.until(ctx, nextBar(this.state.origin, grid, ctx.currentTime, .02).time); this.queuedPlay.delete(trackId); if (this.voices.has(trackId) || !this.track(trackId)?.loop) return; } }
    const fade = ctx.createGain(); fade.connect(this.filterFor(trackId)); const voice: Voice = { sources: [], fade }; const at = Math.max(ctx.currentTime + .03, this.state.origin!);
    fade.gain.setValueAtTime(0, at); fade.gain.linearRampToValueAtTime(1, at + .008);
    const phase = loopPhase(at, this.state.origin!, this.bar(), track.loop.anchorBar, track.loop.bars);
    const offset = trimmedOffset(phase, track.loop.trimIn, track.loop.duration);
    for (const buffer of buffers) this.startSource(voice, buffer, at, offset, undefined, true);
    this.voices.set(trackId, voice); this.voiceLayers.set(trackId, this.layerKey(track.loop)); this.set({ message: `${track.name} playing` });
  }
  private stopVoice(trackId: string): void {
    const voice = this.voices.get(trackId); if (!voice) return; this.voices.delete(trackId); this.voiceLayers.delete(trackId); const t = voice.fade.context.currentTime;
    try { voice.fade.gain.cancelScheduledValues(t); voice.fade.gain.setValueAtTime(voice.fade.gain.value, t); voice.fade.gain.linearRampToValueAtTime(0, t + .015); } catch { /* closed */ }
    for (const s of voice.sources) try { s.stop(t + .02); } catch { /* already stopped */ }
  }
  /** Quantised to LOOP QUANTIZE when the transport is running. */
  async stopTrack(trackId: string): Promise<void> {
    if (!this.voices.has(trackId)) return; const ctx = this.ctx; const origin = this.state.origin; const grid = this.gridSeconds();
    if (ctx && origin !== null && grid > 0) { await this.until(ctx, nextBar(origin, grid, ctx.currentTime, .02).time); if (!this.voices.has(trackId)) return; }
    this.stopVoice(trackId); this.set({ message: `${this.track(trackId)?.name ?? "Loop"} stopped` }); if (!this.voices.size && !this.state.recording) this.stopTransport();
  }
  async playAll(): Promise<void> { for (const t of this.session().tracks) if (t.loop && !this.voices.has(t.id)) await this.play(t.id); }
  async stopAll(): Promise<void> { if (this.state.recording) await this.discardRecording("Recording discarded"); for (const id of [...this.voices.keys()]) this.stopVoice(id); this.stopTransport(); this.set({ message: "All loops stopped" }); }
  muteAll(): void { this.studio.updateLooper((s) => { const all = s.tracks.every((t) => t.muted || !t.loop); for (const t of s.tracks) t.muted = !all; }, "Mute all", false); this.applyGains(); }
  /** PANIC: stops every loop, recording, pad and note, and turns live monitoring off. Loops are kept. */
  async panic(): Promise<void> { await this.stopAll(); this.studio.stopAllPads(); this.studio.stopAllNotes(); this.vocal.setSettings({ monitor: false }); this.set({ message: "PANIC — all audio stopped and monitoring off. Your loops are safe." }); }

  // ── tracks ──
  setTrack(trackId: string, patch: Partial<Pick<LoopTrack, "name" | "volume" | "muted" | "solo">>, undoable = true): void {
    this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === trackId); if (t) Object.assign(t, patch); }, patch.name !== undefined ? "Loop track renamed" : "Loop track updated", undoable); this.applyGains();
  }
  /** LOW CUT: rolls bass off a track (a real-time highpass on whatever's currently playing), e.g. to resolve two layers competing for the same low end. `hz` null/≤20 turns it off. */
  setLowCut(trackId: string, hz: number | null): void {
    this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === trackId); if (t) t.lowCutHz = hz && hz > 20 ? hz : undefined; }, "Low cut changed", false); this.applyFilters();
  }
  /** Removes the loop (and every overdub layer) from the track; undoable with Production Studio undo. The audio stays stored. */
  clear(trackId: string): void { if (this.state.recording?.trackId === trackId || this.track(trackId)?.protected) return; this.stopVoice(trackId); this.studio.updateLooper((s) => { const t = s.tracks.find((x) => x.id === trackId); if (t) { t.loop = null; t.solo = false; } }, "Loop cleared"); if (!this.voices.size && !this.state.recording) this.stopTransport(); }
  /** UNDO: hides the most recent overdub layer (never below the base layer). The layer is kept — REDO brings it back. */
  undoLayer(trackId: string): void { const t = this.track(trackId); if (!t?.loop || t.loop.active <= 1) return; this.studio.updateLooper((s) => { const x = s.tracks.find((y) => y.id === trackId); if (x?.loop) x.loop.active = Math.max(1, x.loop.active - 1); }, "Overdub undone", false); }
  redoLayer(trackId: string): void { const t = this.track(trackId); if (!t?.loop || t.loop.active >= t.loop.layers.length) return; this.studio.updateLooper((s) => { const x = s.tracks.find((y) => y.id === trackId); if (x?.loop) x.loop.active = Math.min(x.loop.layers.length, x.loop.active + 1); }, "Overdub redone", false); }
  /** Manual Trim: a non-destructive playback in-point, shared by every layer. Dragged live, so it's never on Production Studio's undo stack. */
  setTrim(trackId: string, trimIn: number): void {
    const t = this.track(trackId); if (!t?.loop) return; const clamped = Math.max(0, Math.min(t.loop.duration - .02, trimIn));
    if (clamped === t.loop.trimIn) return;
    this.studio.updateLooper((s) => { const x = s.tracks.find((y) => y.id === trackId); if (x?.loop) x.loop.trimIn = clamped; }, "Loop start trimmed", false);
  }
  /** STRIP SILENCE: finds the base layer's leading silence (reusing the Sampler's Auto Clean analysis) and sets it as the in-point in one click. */
  async stripSilence(trackId: string): Promise<void> {
    const t = this.track(trackId); if (!t?.loop) return;
    const buffer = await this.getBuffer(t.loop.layers[0].ref);
    const report = analyseClean(buffer.getChannelData(0), buffer.sampleRate, 0, buffer.duration);
    this.setTrim(trackId, report.leadingSilence);
    this.set({ message: report.leadingSilence > .005 ? `${t.name}: stripped ${(report.leadingSilence * 1000).toFixed(0)} ms of leading silence` : `${t.name}: no leading silence found` });
  }
  addTrack(name?: string): string { const id = makeId("loop"); this.studio.updateLooper((s) => { s.tracks.push({ id, name: name ?? `Loop ${s.tracks.length + 1}`, volume: 1, muted: false, solo: false, loop: null }); s.selectedTrackId = id; }, "Loop track added"); return id; }
  removeTrack(trackId: string): void { if (this.state.recording?.trackId === trackId || this.track(trackId)?.protected) return; this.stopVoice(trackId); this.studio.updateLooper((s) => { s.tracks = s.tracks.filter((t) => t.id !== trackId); if (s.selectedTrackId === trackId) s.selectedTrackId = s.tracks[0]?.id ?? null; }, "Loop track removed"); }
  select(trackId: string): void { if (this.session().selectedTrackId !== trackId) this.studio.updateLooper((s) => { s.selectedTrackId = trackId; }, "Track selected", false); }
  private selectNextEmpty(): void { const tracks = this.session().tracks; const at = tracks.findIndex((t) => t.id === this.session().selectedTrackId); const next = [...tracks.slice(at + 1), ...tracks.slice(0, Math.max(0, at))].find((t) => !t.loop); if (next) this.select(next.id); }
  setOptions(patch: Partial<Pick<LooperSession, "countIn" | "click" | "quantize" | "thresholdRecord" | "thresholdDb">>): void { this.studio.updateLooper((s) => Object.assign(s, patch), "Looper options", false); }

  /** Keeps a playing voice's layer set in sync with the track (undo, reopen, clear, overdub, UNDO/REDO elsewhere). */
  private reconcile(): void {
    for (const [id] of [...this.voices]) {
      const t = this.track(id);
      if (!t?.loop) { if (this.state.recording?.trackId !== id) this.stopVoice(id); continue; }
      const want = this.layerKey(t.loop); if (this.voiceLayers.get(id) !== want) void this.restartVoiceLayers(id, t);
    }
    if (this.gains.size) this.applyGains();
    if (this.filters.size) this.applyFilters();
  }
  /** Stops and restarts a track's voice so it sounds exactly its current active layers, in phase with the transport. */
  private async restartVoiceLayers(trackId: string, track: LoopTrack): Promise<void> {
    if (!track.loop || !this.ctx || this.state.origin === null) return;
    const ctx = this.ctx; const bar = this.bar(); const loop = track.loop; const want = this.layerKey(loop);
    const buffers = await Promise.all(loop.layers.slice(0, loop.active).map((l) => this.getBuffer(l.ref)));
    const current = this.track(trackId); if (!current?.loop || this.layerKey(current.loop) !== want) return; // superseded while buffers loaded
    this.stopVoice(trackId);
    const fade = ctx.createGain(); fade.connect(this.filterFor(trackId)); const voice: Voice = { sources: [], fade };
    const at = Math.max(ctx.currentTime + .02, this.state.origin);
    fade.gain.setValueAtTime(0, at); fade.gain.linearRampToValueAtTime(1, at + .008);
    const phase = loopPhase(at, this.state.origin, bar, loop.anchorBar, loop.bars);
    const offset = trimmedOffset(phase, loop.trimIn, loop.duration);
    for (const buffer of buffers) this.startSource(voice, buffer, at, offset, undefined, true);
    this.voices.set(trackId, voice); this.voiceLayers.set(trackId, want);
  }

  /** Per-frame view state: statuses, loop progress (0–1), transport bar.beat, count-in beats left. */
  live(): LooperLive {
    const ctx = this.ctx; const now = ctx?.currentTime ?? 0; const s = this.session(); const bar = this.bar(); const beats = this.studio.getState().project.timeSignature[0]; const origin = this.state.origin; const rec = this.state.recording;
    const status: Record<string, LoopStatus> = {}; const progress: Record<string, number> = {};
    for (const t of s.tracks) {
      if (rec?.trackId === t.id) { status[t.id] = rec.armed ? "armed" : rec.closing ? "closing" : now < rec.start ? "queued" : "recording"; progress[t.id] = rec.armed || rec.closing ? Math.min(1, Math.max(0, rec.closing ? (now - rec.start) / (rec.closing.end - rec.start) : 0)) : origin === null ? 0 : ((now - rec.start) / bar) % 1; continue; }
      status[t.id] = this.voices.has(t.id) ? "playing" : this.queuedPlay.has(t.id) ? "queued" : t.loop ? "stopped" : "empty";
      progress[t.id] = this.voices.has(t.id) && t.loop && origin !== null ? loopPhase(now, origin, bar, t.loop.anchorBar, t.loop.bars) / (t.loop.bars * bar) : 0;
    }
    const pos = origin === null ? 0 : (now - origin) / bar; const barIndex = Math.floor(pos); const beat = Math.floor((pos - barIndex) * beats);
    return { status, progress, bar: origin === null ? 0 : barIndex + 1, beat: beat + 1, countIn: origin !== null && pos < 0 ? Math.ceil(-pos * beats) : null, recordingBars: rec && !rec.closing && !rec.armed ? Math.max(0, (now - rec.start) / bar) : rec?.closing?.bars ?? 0 };
  }
}

/**
 * Vocal Studio — Phase 1 (recording). See docs/VOCAL-STUDIO.md.
 *
 * Input graph (engine AudioContext):
 *   mic → source ─┬→ rawMeter                         (true input clipping)
 *                 └→ trim ─┬→ meter                   (post-trim level)
 *                          ├→ capture worklet → mute → monitor out   (dry PCM + audio-clock frame)
 *                          └→ monitorGain → monitor out (headphone mix when the engine has 4-ch routing)
 *
 * Takes are captured as raw PCM by an AudioWorklet (sample-accurate, no codec), stored untouched as mono WAV,
 * and placed on the arrangement from the audio clock minus round-trip latency (see analysis.placeTake).
 * Phase 2 inserts the pitch-correction worklet between trim and monitorGain for tuned monitoring.
 */
import captureUrl from "../../audio/capture-processor.ts?worker&url";
import tuneUrl from "../../audio/tune-processor.ts?worker&url";
import type { WebAudioEngine } from "../../audio/WebAudioEngine";
import type { ProductionStudio } from "../ProductionStudio";
import { makeId, type VocalTake } from "../types";
import { encodeWav } from "../wav";
import { analyseTake, blockPeaks, measureClickLatency, placeTake } from "./analysis";

export interface VocalInputDevice { id: string; label: string }
export interface VocalSettings {
  deviceId: string; channel: 0 | 1 | -1; trim: number;
  monitor: boolean; monitorLevel: number; headphonesConfirmed: boolean;
  countIn: boolean; metronome: boolean;
  /** What plays while recording: "off", "all" (the whole arrangement except the vocal track) or one track id. */
  backing: string;
  punch: boolean; punchIn: number; punchOut: number;
  latencyMode: "auto" | "manual"; manualLatencyMs: number; measuredLatencyMs: number | null;
}
export interface VocalRecording { phase: "count-in" | "recording"; trackId: string; startPos: number; stopAt: number | null; position: number; peaks: { pos: number; peak: number }[] }
export interface VocalState {
  settings: VocalSettings; devices: VocalInputDevice[];
  input: { open: boolean; label: string; channels: number; error: string | null; headphones: boolean | null };
  level: { peak: number; rms: number; clip: boolean; inputClip: boolean };
  latency: { estimatedMs: number; inputMs: number; outputMs: number; measuredMs: number | null; appliedMs: number };
  recording: VocalRecording | null; measuring: boolean; targetTrackId: string | null; message: string;
  /** Live tuned monitoring on (Phase 2). */
  tunedMonitor: boolean;
}

const SETTINGS_KEY = "dbdj.vocal.settings.v1";
const DEFAULTS: VocalSettings = { deviceId: "default", channel: 0, trim: 1, monitor: false, monitorLevel: .8, headphonesConfirmed: false, countIn: true, metronome: true, backing: "off", punch: false, punchIn: 0, punchOut: 8, latencyMode: "auto", manualLatencyMs: 0, measuredLatencyMs: null };
const PEAK_STEP = .02; // live waveform resolution (s)

interface Chunk { frame: number; data: Float32Array }
interface Session { trackId: string; startPos: number; stopAt: number | null; latency: number; chunks: Chunk[]; clock: { contextTime: number; position: number } | null; timer: ReturnType<typeof setInterval>; done: Promise<void>; resolveDone: () => void; cancelled: boolean }

export class VocalStudio {
  private state: VocalState;
  private listeners = new Set<(s: VocalState) => void>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: { source: MediaStreamAudioSourceNode; trim: GainNode; raw: AnalyserNode; meter: AnalyserNode; capture: AudioWorkletNode; mute: GainNode; monitor: GainNode; out: GainNode; tune: AudioWorkletNode } | null = null;
  /** Live tuned monitoring config (Phase 2): the monitor path runs through the tune worklet when enabled. */
  private tuneConfig = { enabled: false, mask: new Array<boolean>(12).fill(true), retuneMs: 20, strength: 1 };
  private tuneLatencyMs = 0;
  private loaded = new WeakSet<BaseAudioContext>();
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private buf = new Float32Array(2048);
  private session: Session | null = null;
  private onChunk: ((c: Chunk) => void) | null = null;
  private onStopped: (() => void) | null = null;

  constructor(private audio: WebAudioEngine, private studio: ProductionStudio) {
    let settings = { ...DEFAULTS }; try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") }; } catch { /* defaults */ }
    settings.monitor = false; // never start with a live mic open
    if (typeof settings.backing !== "string") settings.backing = "off"; // older settings stored a boolean
    this.state = { settings, devices: [], input: { open: false, label: "", channels: 0, error: null, headphones: null }, level: { peak: 0, rms: 0, clip: false, inputClip: false }, latency: { estimatedMs: 0, inputMs: 0, outputMs: 0, measuredMs: settings.measuredLatencyMs, appliedMs: 0 }, recording: null, measuring: false, targetTrackId: null, message: "Connect a microphone to start", tunedMonitor: false };
  }

  subscribe = (l: (s: VocalState) => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): VocalState => this.state;
  private set(patch: Partial<VocalState>): void { this.state = { ...this.state, ...patch }; this.state.latency = this.latencyInfo(); for (const l of this.listeners) l(this.state); }

  setSettings(patch: Partial<VocalSettings>): void {
    const settings = { ...this.state.settings, ...patch };
    if (patch.monitor && !settings.headphonesConfirmed && this.state.input.headphones === false) { this.set({ message: "Confirm you are using headphones before monitoring through the main output" }); return; }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, monitor: false })); } catch { /* storage unavailable */ }
    this.set({ settings }); const n = this.nodes;
    if (n && "trim" in patch) n.trim.gain.setTargetAtTime(settings.trim, n.trim.context.currentTime, .02);
    if (n && ("monitor" in patch || "monitorLevel" in patch)) n.monitor.gain.setTargetAtTime(settings.monitor ? settings.monitorLevel : 0, n.monitor.context.currentTime, .01);
    if (n && "channel" in patch) n.capture.port.postMessage({ type: "channel", channel: settings.channel });
    if ("deviceId" in patch && this.state.input.open) void this.openInput().catch(() => undefined);
  }
  setTarget(trackId: string | null): void { this.set({ targetTrackId: trackId }); }

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    this.set({ devices: all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId || "default", label: d.label || `Input ${i + 1}` })) });
  }

  /** Opens (or re-opens) the selected input. Needs a user gesture the first time (permission prompt). */
  async openInput(): Promise<void> {
    this.closeInput(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Audio input is not available here");
      const access = await window.dbdjDesktop?.requestMicrophone?.();
      if (access && !access.granted) throw new Error(access.status === "denied" || access.status === "restricted" ? "Microphone access is off for Donkey Billabong DJ — allow it in your system privacy settings" : "Microphone access was not allowed");
      const id = this.state.settings.deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id && id !== "default" ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const out = await this.audio.createMonitorOutput(); const ctx = out.context;
      if (!this.loaded.has(ctx)) { await ctx.audioWorklet.addModule(captureUrl); await ctx.audioWorklet.addModule(tuneUrl); this.loaded.add(ctx); }
      const source = ctx.createMediaStreamSource(stream); const trim = ctx.createGain(); trim.gain.value = this.state.settings.trim;
      const raw = ctx.createAnalyser(); raw.fftSize = 2048; const meter = ctx.createAnalyser(); meter.fftSize = 2048;
      const capture = new AudioWorkletNode(ctx, "dbdj-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = ctx.createGain(); mute.gain.value = 0; const monitor = ctx.createGain(); monitor.gain.value = 0;
      // Monitor path: trim → monitorGain (dry), or trim → tune worklet → monitorGain when TUNED MONITOR is on.
      const tune = new AudioWorkletNode(ctx, "dbdj-tune", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { ...this.tuneConfig } });
      tune.port.onmessage = (e: MessageEvent<{ type: string; ms?: number }>) => { if (e.data.type === "latency") this.tuneLatencyMs = e.data.ms ?? 0; };
      tune.port.postMessage({ type: "config", ...this.tuneConfig });
      source.connect(raw); source.connect(trim); trim.connect(meter); trim.connect(capture).connect(mute).connect(out.input);
      if (this.tuneConfig.enabled) trim.connect(tune).connect(monitor); else trim.connect(monitor); monitor.connect(out.input);
      capture.port.postMessage({ type: "channel", channel: this.state.settings.channel });
      capture.port.onmessage = (e: MessageEvent<{ type: string; frame?: number; data?: Float32Array }>) => { if (e.data.type === "chunk" && e.data.data) this.onChunk?.({ frame: e.data.frame!, data: e.data.data }); else if (e.data.type === "stopped") this.onStopped?.(); };
      this.ctx = ctx; this.stream = stream; this.nodes = { source, trim, raw, meter, capture, mute, monitor, out: out.input, tune };
      const track = stream.getAudioTracks()[0]; const settings = track?.getSettings() as MediaTrackSettings & { latency?: number; channelCount?: number };
      this.set({ input: { open: true, label: track?.label || "Microphone", channels: settings?.channelCount ?? 1, error: null, headphones: out.headphones }, message: out.headphones ? "Input ready · monitoring goes to the headphone output" : "Input ready · monitoring would use the main output — use headphones" });
      this.inputLatency = settings?.latency ?? 0;
      this.startMeter(); await this.refreshDevices();
    } catch (error) {
      this.closeInput(false); const message = error instanceof Error ? error.message : String(error);
      this.set({ input: { ...this.state.input, open: false, error: message }, message }); throw error;
    }
  }
  private inputLatency = 0;
  closeInput(notify = true): void {
    if (this.meterTimer) clearInterval(this.meterTimer); this.meterTimer = null;
    if (this.nodes) { try { this.nodes.source.disconnect(); this.nodes.trim.disconnect(); this.nodes.capture.disconnect(); this.nodes.monitor.disconnect(); this.nodes.out.disconnect(); } catch { /* already disconnected */ } }
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.nodes = null; this.ctx = null;
    if (notify) this.set({ input: { ...this.state.input, open: false }, settings: { ...this.state.settings, monitor: false }, message: "Input closed" });
  }

  /**
   * TUNED MONITOR: the singer hears their voice pitch-corrected to the key (retune speed / strength from the
   * pitch settings) while the recording stays dry. Adds the worklet's delay (~21 ms) to monitoring latency.
   */
  setTunedMonitor(config: { enabled: boolean; mask: boolean[]; retuneMs: number; strength: number }): void {
    const was = this.tuneConfig.enabled; this.tuneConfig = { ...config, mask: config.mask.slice() }; const n = this.nodes;
    if (n) {
      n.tune.port.postMessage({ type: "config", ...this.tuneConfig });
      if (was !== config.enabled) { try { n.trim.disconnect(n.monitor); } catch { /* not connected */ } try { n.trim.disconnect(n.tune); n.tune.disconnect(); } catch { /* not connected */ } if (config.enabled) n.trim.connect(n.tune).connect(n.monitor); else n.trim.connect(n.monitor); }
    }
    this.set({ tunedMonitor: config.enabled, message: config.enabled ? `Tuned monitoring on (+${this.tuneLatencyMs.toFixed(0)} ms) — the recording stays dry` : "Tuned monitoring off" });
  }
  get tunedMonitorLatencyMs(): number { return this.tuneLatencyMs; }

  /** Sticky clip indicators are cleared here (or by clicking them). */
  resetClip(): void { this.set({ level: { ...this.state.level, clip: false, inputClip: false } }); }
  private startMeter(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      const n = this.nodes; if (!n) return; if (n.trim.context.state === "closed") { this.closeInput(); this.set({ message: "Audio device changed — reconnect the input" }); return; }
      const read = (a: AnalyserNode) => { a.getFloatTimeDomainData(this.buf); let peak = 0, e = 0; for (const v of this.buf) { const x = v < 0 ? -v : v; if (x > peak) peak = x; e += v * v; } return { peak, rms: Math.sqrt(e / this.buf.length) }; };
      const post = read(n.meter), raw = read(n.raw); const l = this.state.level;
      this.set({ level: { peak: post.peak, rms: post.rms, clip: l.clip || post.peak >= .999, inputClip: l.inputClip || raw.peak >= .999 }, recording: this.liveRecording() });
    }, 50);
  }

  private latencyInfo(): VocalState["latency"] {
    const ctx = this.ctx; const outputMs = ctx ? (ctx.baseLatency + ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0)) * 1000 : 0; const inputMs = this.inputLatency * 1000;
    const estimatedMs = outputMs + inputMs; const s = this.state?.settings ?? DEFAULTS; const measuredMs = s.measuredLatencyMs;
    return { estimatedMs, inputMs, outputMs, measuredMs, appliedMs: s.latencyMode === "manual" ? s.manualLatencyMs : measuredMs ?? estimatedMs };
  }

  /**
   * Round-trip measurement: six clicks through the main output, captured by the input. Needs the speakers audible
   * to the mic (or a loopback cable / headphones held to the mic). Saves the result for latency compensation.
   */
  async measureLatency(): Promise<void> {
    if (this.inputBusy) { this.set({ message: "The input is in use by the Live Looper" }); return; } if (!this.nodes) await this.openInput();
    const n = this.nodes!; const ctx = n.trim.context as AudioContext; const out = await this.audio.createProductionOutput();
    this.set({ measuring: true, message: "Measuring latency — keep quiet…" });
    try {
      const chunks: Chunk[] = []; this.onChunk = (c) => chunks.push(c); const stopped = new Promise<void>((r) => { this.onStopped = r; });
      n.capture.port.postMessage({ type: "start" }); const t0 = ctx.currentTime + .4; const clicks = Array.from({ length: 6 }, (_, i) => t0 + i * .4);
      for (const t of clicks) { const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.frequency.value = 2000; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.8, t + .0005); g.gain.exponentialRampToValueAtTime(.001, t + .015); osc.connect(g).connect(out.input); osc.start(t); osc.stop(t + .02); }
      await new Promise((r) => setTimeout(r, (clicks[clicks.length - 1] - ctx.currentTime + .6) * 1000));
      n.capture.port.postMessage({ type: "stop" }); await stopped; this.onChunk = null; out.input.disconnect();
      const { data, start } = this.assemble(chunks, ctx.sampleRate); const result = measureClickLatency(data, ctx.sampleRate, start, clicks);
      if (!result) { this.set({ measuring: false, message: "No consistent test clicks were heard. Keep quiet during the test and let the mic hear the speakers (or hold the headphones to it / use a loopback cable), then try again." }); return; }
      this.setSettings({ measuredLatencyMs: Math.round(result.latencyMs * 10) / 10, latencyMode: "auto" });
      this.set({ measuring: false, message: `Measured round-trip latency ${result.latencyMs.toFixed(1)} ms (${result.matched}/6 clicks, spread ${result.spreadMs.toFixed(1)} ms) — recordings are shifted by this` });
    } catch (error) { this.onChunk = null; this.set({ measuring: false, message: `Latency measurement failed: ${error instanceof Error ? error.message : String(error)}` }); }
  }

  private assemble(chunks: Chunk[], rate: number): { data: Float32Array; start: number } {
    const total = chunks.reduce((n, c) => n + c.data.length, 0); const data = new Float32Array(total); let at = 0; for (const c of chunks) { data.set(c.data, at); at += c.data.length; }
    return { data, start: (chunks[0]?.frame ?? 0) / rate };
  }

  /**
   * Records a take on `trackId` (or the target / a new vocal track). Count-in = one bar of pre-roll (arrangement
   * plays from a bar earlier, or clicks alone before bar 1). Punch records only between punch in/out. The
   * arrangement plays as backing (the recorded track muted); the loop region is ignored while recording.
   */
  async startRecording(trackId?: string): Promise<void> {
    if (this.inputBusy) { this.set({ message: "The input is in use by the Live Looper" }); return; } if (!this.nodes) await this.openInput();
    const n = this.nodes!; const ctx = n.trim.context as AudioContext; const studio = this.studio; const p = studio.getState().project; const s = this.state.settings;
    let target = trackId ?? this.state.targetTrackId; if (!target || !p.tracks.some((t) => t.id === target && t.vocal)) target = studio.addVocalTrack(); this.set({ targetTrackId: target });
    const beat = 60 / p.bpm, bar = beat * p.timeSignature[0];
    const startPos = s.punch ? s.punchIn : studio.getState().position; const stopAt = s.punch ? s.punchOut : null;
    if (stopAt !== null && stopAt - startPos < .1) throw new Error("Set punch out after punch in");
    const preRoll = s.countIn || s.punch ? bar : 0; const playFrom = Math.max(0, startPos - preRoll); const leadIn = Math.max(0, preRoll - startPos);
    if (studio.getState().playing) studio.pause(); studio.seek(playFrom);
    let resolveDone!: () => void; const done = new Promise<void>((r) => { resolveDone = r; });
    const session: Session = { trackId: target, startPos, stopAt, latency: this.state.latency.appliedMs / 1000, chunks: [], clock: null, timer: 0 as unknown as ReturnType<typeof setInterval>, done, resolveDone, cancelled: false };
    this.session = session; this.onChunk = (c) => session.chunks.push(c); this.onStopped = () => session.resolveDone();
    n.capture.port.postMessage({ type: "start" });
    this.set({ recording: { phase: "count-in", trackId: target, startPos, stopAt, position: playFrom, peaks: [] }, message: s.punch ? `Punch-in ${startPos.toFixed(2)}–${stopAt!.toFixed(2)} s` : "Recording…" });
    const out = s.countIn && (!s.metronome || leadIn > 0) ? await this.audio.createProductionOutput() : null;
    const clickAt = (t: number, accent: boolean) => { if (!out) return; const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.frequency.value = accent ? 1760 : 1100; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.3, t + .002); g.gain.exponentialRampToValueAtTime(.0001, t + .05); osc.connect(g).connect(out.input); osc.start(t); osc.stop(t + .06); };
    const play = async () => {
      if (this.session !== session) return;
      await studio.play({ ...this.backingOptions(target), metronome: s.metronome, noLoop: true });
      const clock = studio.getPlayClock(); session.clock = clock ? { contextTime: clock.contextTime, position: clock.position } : null;
      // Count-in clicks during transport pre-roll when the metronome itself is off.
      if (clock && out && !s.metronome) for (let b = Math.ceil((playFrom + 1e-6) / beat); b * beat < startPos - 1e-3; b++) clickAt(clock.contextTime + b * beat - playFrom, b % p.timeSignature[0] === 0);
    };
    if (leadIn > 0) { const t0 = ctx.currentTime + .1; const beats = Math.round(leadIn / beat); for (let b = 0; b < beats; b++) clickAt(t0 + b * beat, b % p.timeSignature[0] === 0); setTimeout(() => void play().catch((e) => this.fail(e)), (t0 - ctx.currentTime + leadIn) * 1000); }
    else await play();
    session.timer = setInterval(() => { const pos = this.studio.getState().position; if (session.stopAt !== null && session.clock && pos >= session.stopAt + .2) void this.stopRecording(); }, 40);
  }

  /** Tracks that play as backing for `vocalTrackId` (never the vocal track itself). */
  backingTracks(vocalTrackId: string | null): string[] {
    const b = this.state.settings.backing; const tracks = this.studio.getState().project.tracks.filter((t) => t.id !== vocalTrackId);
    if (b === "off") return []; if (b === "all") return tracks.map((t) => t.id); return tracks.some((t) => t.id === b) ? [b] : [];
  }
  private backingOptions(vocalTrackId: string): { backing?: boolean; only?: string[]; exclude?: string } {
    const ids = this.backingTracks(vocalTrackId); return ids.length ? { only: ids, exclude: vocalTrackId } : { backing: false };
  }
  /** Plays a take from its start with the chosen backing (not the rest of the arrangement). */
  async playTake(trackId: string, takeStart: number): Promise<void> {
    if (this.session) throw new Error("Still recording — stop the recording (RECORD tab) before playing a take");
    const studio = this.studio; if (studio.getState().playing) studio.pause();
    studio.seek(takeStart); await studio.play({ only: [...this.backingTracks(trackId), trackId], noLoop: true });
  }
  private fail(error: unknown): void { void this.stopRecording(true); this.set({ message: `Recording failed: ${error instanceof Error ? error.message : String(error)}` }); }

  /** Live take waveform (arrangement positions) and phase for the UI, from captured chunks so far. */
  private liveRecording(): VocalRecording | null {
    const session = this.session; const rec = this.state.recording; if (!session || !rec || !this.ctx) return rec;
    const position = this.studio.getState().position; const rate = this.ctx.sampleRate; const peaks = rec.peaks.slice(); const clock = session.clock;
    if (clock) {
      const known = peaks.length ? peaks[peaks.length - 1].pos : -Infinity;
      for (const c of session.chunks.slice(-12)) { const pos0 = clock.position + (c.frame / rate - clock.contextTime) - session.latency; if (pos0 + c.data.length / rate <= known) continue; blockPeaks(c.data, Math.round(rate * PEAK_STEP)).forEach((peak, i) => { const pos = pos0 + i * PEAK_STEP; if (pos > known && pos >= session.startPos && (session.stopAt === null || pos <= session.stopAt)) peaks.push({ pos, peak }); }); }
    }
    return { ...rec, position, phase: clock && position >= session.startPos ? "recording" : "count-in", peaks };
  }

  /** Stops recording and stores the take (unless `discard`). The dry capture is kept whole; the take clip shows the recorded range. */
  async stopRecording(discard = false): Promise<void> {
    const session = this.session; const n = this.nodes; if (!session || session.cancelled) return; session.cancelled = true; clearInterval(session.timer);
    n?.capture.port.postMessage({ type: "stop" }); await Promise.race([session.done, new Promise((r) => setTimeout(r, 500))]);
    this.onChunk = null; this.session = null; if (this.studio.getState().playing) this.studio.pause();
    const rate = this.ctx?.sampleRate ?? 48_000; this.set({ recording: null });
    if (discard) { this.set({ message: "Recording discarded" }); return; }
    if (!session.clock || !session.chunks.length) { this.set({ message: "Stopped before the take began — nothing recorded" }); return; }
    const { data, start } = this.assemble(session.chunks, rate);
    const placed = placeTake({ captureStart: start, clock: session.clock, latency: session.latency, sampleRate: rate, frames: data.length, from: session.startPos, to: session.stopAt });
    if (!placed) { this.set({ message: "Stopped before the take began — nothing recorded" }); return; }
    const track = this.studio.getState().project.tracks.find((t) => t.id === session.trackId); const number = (track?.vocal?.takes.length ?? 0) + 1;
    const from = Math.round(placed.offset * rate); const region = data.subarray(from, from + Math.round(placed.duration * rate)); const analysis = analyseTake(region, rate);
    const id = makeId("take"); const take: VocalTake = { id, ref: `production-vocal://${id}`, name: `Take ${number}`, recordedAt: Date.now(), start: placed.start, duration: placed.duration, offset: placed.offset, sourceDuration: placed.sourceDuration, sampleRate: rate, latencyMs: session.latency * 1000, input: this.state.input.label, punch: session.stopAt !== null ? { in: session.startPos, out: session.stopAt } : null, analysis };
    await this.studio.addVocalTake(session.trackId, take, encodeWav({ sampleRate: rate, left: data }));
    this.onTakeRecorded?.(session.trackId, take.id);
    const warn = analysis.clippedSamples ? ` · ⚠ ${analysis.clippedSamples} clipped samples — lower the input gain` : analysis.peakDb < -30 ? " · very quiet — raise the input gain" : "";
    this.set({ message: `${take.name} saved (${placed.duration.toFixed(1)} s, peak ${analysis.peakDb.toFixed(1)} dBFS)${warn}` });
  }
  get isRecording(): boolean { return !!this.session; }
  /** Called after each new take is stored (Phase 2 runs pitch analysis here). */
  onTakeRecorded: ((trackId: string, takeId: string) => void) | null = null;
  /** True while another module (Live Looper) holds the capture. */
  get inputBusy(): boolean { return !!this.session || !!this.external || this.state.measuring; }

  /**
   * Shared input capture for other modules (Live Looper): the same device, trim, monitoring and latency settings as
   * vocal recording. `onChunk` sees blocks as they arrive; `stop()` returns the whole capture and its audio-clock
   * start. One owner at a time.
   */
  async beginCapture(onChunk?: (data: Float32Array, frame: number) => void): Promise<{ context: AudioContext; latency: number; stop(): Promise<{ data: Float32Array; start: number; rate: number }> }> {
    if (this.inputBusy) throw new Error("The input is busy (vocal recording or latency test)");
    if (!this.nodes) await this.openInput();
    const n = this.nodes!; const ctx = n.trim.context as AudioContext; const chunks: Chunk[] = []; let resolve!: () => void; const stopped = new Promise<void>((r) => { resolve = r; });
    this.external = true; this.onChunk = (c) => { chunks.push(c); onChunk?.(c.data, c.frame); }; this.onStopped = resolve; n.capture.port.postMessage({ type: "start" });
    let done = false;
    return { context: ctx, latency: this.state.latency.appliedMs / 1000, stop: async () => {
      if (!done) { done = true; n.capture.port.postMessage({ type: "stop" }); await Promise.race([stopped, new Promise((r) => setTimeout(r, 500))]); this.onChunk = null; this.onStopped = null; this.external = false; }
      return { ...this.assemble(chunks, ctx.sampleRate), rate: ctx.sampleRate };
    } };
  }
  private external = false;
}

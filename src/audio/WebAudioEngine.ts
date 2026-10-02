/**
 * Web Audio implementation of the AudioEngine contract.
 *
 * Graph per deck:
 *   DeckWorklet → trim → EQ low/mid/high → HPF → LPF ─┬─→ fader/xfader gain → meter → master bus
 *                                                     └─→ PFL send → cue bus
 * Master bus → master gain → [stereo: destination 1/2]
 *                            [quad:   destination 1/2, headphone mix → destination 3/4]
 */
import deckProcessorUrl from "./deck-processor.ts?worker&url";
import type {
  AudioConfig,
  AudioEngine,
  AudioEngineEvent,
  AudioStatus,
  ChannelDsp,
  DecodedAudio,
  FxDsp,
  MasterDsp,
  OutputDevice,
} from "../core/engine/types";
import { DEFAULT_AUDIO_CONFIG } from "../core/engine/types";
import { FxSlot, INSERT_TYPES } from "./fx";
import { aiffToWav, isAiff } from "./aiff";
import { EQ_HIGH_HZ, EQ_LOW_HZ, EQ_MID_HZ } from "../core/engine/mixerMath";

const PARAM_SMOOTH_S = 0.008;

interface DeckGraph {
  node: AudioWorkletNode;
  trim: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  hpf: BiquadFilterNode;
  lpf: BiquadFilterNode;
  /** Dry path around the FX slots. */
  dry: GainNode;
  /** Sum of dry + FX returns, feeding the fader and PFL. */
  post: GainNode;
  /** [unit][slot] */
  fx: FxSlot[][];
  out: GainNode;
  pfl: GainNode;
  meter: AnalyserNode;
}

/** Deck state mirrored on the main thread so the graph can be rebuilt and positions extrapolated. */
interface DeckModel {
  buffer: AudioBuffer | null;
  playing: boolean;
  scratching: boolean;
  rate: number;
  seq: number;
  // last known playhead
  pos: number;
  speed: number;
  /** Context time at which `pos` was valid. */
  time: number;
  dsp: ChannelDsp | null;
  stemsLoaded: boolean;
  stemsReady: boolean;
  loop: { start: number; end: number } | null;
  stemsMix: { enabled: boolean; gains: number[] };
}

type WorkletReport =
  | { type: "pos"; seconds: number; speed: number; time: number; seq: number; stemsReady?: boolean }
  | { type: "ended"; seq: number };

export class WebAudioEngine implements AudioEngine {
  readonly deckCount: number;
  private ctx: AudioContext | null = null;
  private config: AudioConfig;
  private decks: DeckGraph[] = [];
  private models: DeckModel[];
  private fxDsp: (FxDsp | null)[] = [null, null];
  private masterDsp: MasterDsp = { masterGain: 0.64, headCueGain: 1, headMasterGain: 0, headphoneGain: 0.64 };
  private masterGain: GainNode | null = null;
  private masterMeter: AnalyserNode | null = null;
  private headCue: GainNode | null = null;
  private headMaster: GainNode | null = null;
  private headLevel: GainNode | null = null;
  private listeners = new Set<(e: AudioEngineEvent) => void>();
  private meterBuf = new Float32Array(1024);
  private lastError: string | undefined;
  private starting: Promise<void> | null = null;

  constructor(deckCount = 2, config: AudioConfig = DEFAULT_AUDIO_CONFIG) {
    this.deckCount = deckCount;
    this.config = { ...config };
    this.models = Array.from({ length: deckCount }, () => ({
      buffer: null,
      playing: false,
      scratching: false,
      rate: 1,
      seq: 0,
      pos: 0,
      speed: 0,
      time: 0,
      dsp: null,
      stemsLoaded: false,
      stemsReady: false,
      stemsMix: { enabled: false, gains: [1, 1, 1, 1] },
      loop: null,
    }));
  }
  /** Copies decoded source PCM for deterministic offline mashup rendering. */
  exportPcm(deck: number): { sampleRate: number; channels: Float32Array[] } | null {
    const b = this.models[deck]?.buffer;
    if (!b) return null;
    return { sampleRate: b.sampleRate, channels: Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i).slice()) };
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  start(): Promise<void> {
    if (this.ctx && this.ctx.state === "running") return Promise.resolve();
    if (this.ctx && this.ctx.state === "suspended") {
      return this.ctx.resume().then(() => this.emitStatus());
    }
    if (!this.starting) {
      this.starting = this.build().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async reconfigure(config: AudioConfig): Promise<void> {
    // A device-only change can just redirect a stereo graph. With 4-channel routing the graph
    // depends on the device's channel count, so it is rebuilt (a graph that fell back to stereo
    // on a 2-channel device would otherwise stay stereo on the DDJ-SB and the cue would be silent).
    const deviceOnly =
      this.ctx &&
      config.routing === "stereo" &&
      config.sampleRate === this.config.sampleRate &&
      config.latencyHint === this.config.latencyHint &&
      config.routing === this.config.routing;
    this.config = { ...config };
    if (deviceOnly && this.ctx) {
      await this.applySink(this.ctx);
      this.emitStatus();
      return;
    }
    await this.teardown();
    await this.start();
  }

  private async build(): Promise<void> {
    const opts: AudioContextOptions = { latencyHint: this.config.latencyHint };
    if (this.config.sampleRate) opts.sampleRate = this.config.sampleRate;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext(opts);
    } catch (err) {
      this.fail(`Could not create audio context: ${String(err)}`);
      throw err;
    }
    this.ctx = ctx;
    ctx.onstatechange = () => this.emitStatus();
    try {
      await this.applySink(ctx);
      await ctx.audioWorklet.addModule(deckProcessorUrl);
      this.buildGraph(ctx);
      await ctx.resume().catch(() => undefined); // may stay suspended in a browser until a user gesture
      this.lastError = undefined;
    } catch (err) {
      this.fail(`Audio engine start failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.emitStatus();
  }

  private async applySink(ctx: AudioContext): Promise<void> {
    const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (!sinkCtx.setSinkId) return;
    const id = this.config.outputDeviceId === "default" ? "" : this.config.outputDeviceId;
    try {
      await sinkCtx.setSinkId(id);
    } catch (err) {
      this.emit({ type: "error", message: `Could not select output device (${String(err)}); using default.` });
    }
  }

  private async teardown(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    // Capture positions so tracks resume where they were after the rebuild.
    for (let i = 0; i < this.deckCount; i++) {
      const m = this.models[i];
      m.pos = this.getPosition(i);
      m.speed = 0;
    }
    this.decks = [];
    this.ctx = null;
    await ctx.close().catch(() => undefined);
  }

  private buildGraph(ctx: AudioContext): void {
    const quad = this.config.routing === "quad" && ctx.destination.maxChannelCount >= 4;
    if (this.config.routing === "quad" && !quad) {
      this.emit({
        type: "error",
        message: `Output device exposes ${ctx.destination.maxChannelCount} channels; 4 are needed for headphone cueing. Falling back to stereo.`,
      });
    }

    const masterBus = ctx.createGain();
    const cueBus = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.masterMeter = ctx.createAnalyser();
    this.masterMeter.fftSize = 1024;
    masterBus.connect(this.masterGain);
    this.masterGain.connect(this.masterMeter);

    if (quad) {
      const dest = ctx.destination;
      dest.channelCount = 4;
      dest.channelCountMode = "explicit";
      dest.channelInterpretation = "discrete";
      const merger = ctx.createChannelMerger(4);
      const mSplit = ctx.createChannelSplitter(2);
      this.masterGain.connect(mSplit);
      mSplit.connect(merger, 0, 0);
      mSplit.connect(merger, 1, 1);

      this.headCue = ctx.createGain();
      this.headMaster = ctx.createGain();
      this.headLevel = ctx.createGain();
      cueBus.connect(this.headCue);
      this.masterGain.connect(this.headMaster);
      this.headCue.connect(this.headLevel);
      this.headMaster.connect(this.headLevel);
      const hSplit = ctx.createChannelSplitter(2);
      this.headLevel.connect(hSplit);
      hSplit.connect(merger, 0, 2);
      hSplit.connect(merger, 1, 3);
      merger.connect(dest);
    } else {
      this.headCue = this.headMaster = this.headLevel = null;
      this.masterGain.connect(ctx.destination);
    }

    this.decks = [];
    for (let i = 0; i < this.deckCount; i++) {
      // Output 0 = deck audio; outputs 1/2 = per-stem sends for FX units 1/2.
      const node = new AudioWorkletNode(ctx, "dbdj-deck", {
        numberOfInputs: 0,
        numberOfOutputs: 3,
        outputChannelCount: [2, 2, 2],
      });
      const trim = ctx.createGain();
      const eqLow = ctx.createBiquadFilter();
      eqLow.type = "lowshelf";
      eqLow.frequency.value = EQ_LOW_HZ;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = "peaking";
      eqMid.frequency.value = EQ_MID_HZ;
      eqMid.Q.value = 0.7;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = "highshelf";
      eqHigh.frequency.value = EQ_HIGH_HZ;
      const hpf = ctx.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = 10;
      hpf.Q.value = 1;
      const lpf = ctx.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = Math.min(20000, ctx.sampleRate / 2 - 100);
      lpf.Q.value = 1;
      const out = ctx.createGain();
      const pfl = ctx.createGain();
      pfl.gain.value = 0;
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;

      node.connect(trim).connect(eqLow).connect(eqMid).connect(eqHigh).connect(hpf).connect(lpf);
      const dry = ctx.createGain();
      const post = ctx.createGain();
      lpf.connect(dry).connect(post);
      // Two units × three slots; effects are only built once a slot is used.
      const fx = [0, 1].map((u) => [0, 1, 2].map(() => new FxSlot(ctx, lpf, post, { node, output: u + 1 })));
      post.connect(out).connect(meter);
      out.connect(masterBus);
      post.connect(pfl).connect(cueBus);

      const g: DeckGraph = { node, trim, eqLow, eqMid, eqHigh, hpf, lpf, dry, post, fx, out, pfl, meter };
      node.port.onmessage = (e: MessageEvent<WorkletReport>) => this.onWorkletMessage(i, e.data);
      this.decks.push(g);
      this.restoreDeck(i);
    }
    this.applyMaster();
    this.applyFx();
  }

  /** Re-send deck state to a freshly built worklet (after start or reconfigure). */
  private restoreDeck(i: number): void {
    const m = this.models[i];
    if (m.dsp) this.applyChannel(i, m.dsp);
    this.post(i, { type: "rate", rate: m.rate });
    if (m.buffer) {
      this.sendBuffer(i, m.buffer);
      this.post(i, { type: "seek", seconds: m.pos, seq: ++m.seq });
      if (m.loop) this.post(i, { type: "loop", start: m.loop.start, end: m.loop.end });
      if (m.playing) this.post(i, { type: "play", playing: true, seq: ++m.seq });
    }
  }

  // ─────────────────────────── status ───────────────────────────

  getStatus(): AudioStatus {
    const ctx = this.ctx;
    if (!ctx) {
      return {
        backend: "Web Audio",
        state: this.lastError ? "error" : "idle",
        sampleRate: 0,
        baseLatency: 0,
        outputLatency: 0,
        maxOutputChannels: 0,
        routing: this.config.routing,
        outputDeviceId: this.config.outputDeviceId,
        error: this.lastError,
      };
    }
    return {
      backend: "Web Audio (AudioWorklet)",
      state: ctx.state === "running" ? "running" : ctx.state === "suspended" ? "suspended" : "closed",
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency ?? 0,
      outputLatency: ctx.outputLatency ?? 0,
      maxOutputChannels: ctx.destination.maxChannelCount,
      routing: this.config.routing === "quad" && ctx.destination.maxChannelCount >= 4 ? "quad" : "stereo",
      outputDeviceId: this.config.outputDeviceId,
      error: this.lastError,
    };
  }

  getConfig(): AudioConfig {
    return { ...this.config };
  }

  async listOutputDevices(): Promise<OutputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [{ id: "default", label: "System default" }];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices
      .filter((d) => d.kind === "audiooutput")
      .map((d, i) => ({ id: d.deviceId || "default", label: d.label || `Output ${i + 1}` }));
    if (!outs.some((d) => d.id === "default")) outs.unshift({ id: "default", label: "System default" });
    return outs;
  }

  on(listener: (e: AudioEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(e: AudioEngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error("[audio] listener threw", err);
      }
    }
  }

  private emitStatus(): void {
    this.emit({ type: "status", status: this.getStatus() });
  }

  private fail(message: string): void {
    this.lastError = message;
    this.emit({ type: "error", message });
    this.emitStatus();
  }

  // ─────────────────────────── decks ───────────────────────────

  async decode(bytes: ArrayBuffer): Promise<DecodedAudio> {
    if (!this.ctx) await this.start();
    const ctx = this.ctx;
    if (!ctx) throw new Error("Audio engine is not running");
    // Chromium can't decode AIFF; rewrite it as WAV first.
    const input = (isAiff(bytes) && aiffToWav(bytes)) || bytes;
    // decodeAudioData detaches its input, so keep the bytes for the fallback decoder.
    const spare = this.decodeFallback && input === bytes ? bytes.slice(0) : null;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(input);
    } catch (err) {
      const wav = spare && (await this.decodeFallback!(spare).catch(() => null));
      if (!wav) throw err;
      buffer = await ctx.decodeAudioData(wav);
    }
    return { duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, handle: buffer };
  }

  /**
   * Converter for formats Chromium can't decode (e.g. Apple Lossless on macOS): given the file's
   * bytes, returns them as WAV, or null. Only tried after decodeAudioData has failed.
   */
  private decodeFallback: ((bytes: ArrayBuffer) => Promise<ArrayBuffer | null>) | null = null;
  setDecodeFallback(fn: ((bytes: ArrayBuffer) => Promise<ArrayBuffer | null>) | null): void {
    this.decodeFallback = fn;
  }

  loadDeck(deck: number, audio: DecodedAudio): void {
    const m = this.models[deck];
    const buffer = audio.handle as AudioBuffer;
    m.buffer = buffer;
    m.playing = false;
    m.scratching = false;
    m.loop = null;
    m.stemsLoaded = false;
    m.stemsReady = false;
    m.pos = 0;
    m.speed = 0;
    m.time = this.now();
    this.sendBuffer(deck, buffer);
  }

  private sendBuffer(deck: number, buffer: AudioBuffer): void {
    const m = this.models[deck];
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
    const g = this.decks[deck];
    if (!g) return;
    g.node.port.postMessage(
      { type: "load", channels, srcRate: buffer.sampleRate, seq: ++m.seq },
      channels.map((c) => c.buffer),
    );
  }

  unloadDeck(deck: number): void {
    const m = this.models[deck];
    m.buffer = null;
    m.loop = null;
    m.playing = false;
    m.pos = 0;
    m.speed = 0;
    this.post(deck, { type: "unload", seq: ++m.seq });
  }

  setPlaying(deck: number, playing: boolean): void {
    const m = this.models[deck];
    this.freeze(deck);
    m.playing = playing;
    if (playing) {
      // A user gesture is the safest opportunity to recover a browser/Electron
      // AudioContext suspended by the OS or an output-device change.
      void this.start().catch((error) => this.fail(`Could not resume audio output: ${String(error)}`));
      if (!m.scratching) m.speed = m.rate;
    } else if (!m.scratching) {
      // Stop UI/playhead extrapolation immediately. The worklet performs its
      // short click-free fade independently before reporting its final frame.
      m.speed = 0;
    }
    this.post(deck, { type: "play", playing, seq: ++m.seq });
  }

  seek(deck: number, seconds: number): void {
    const m = this.models[deck];
    this.freeze(deck);
    m.pos = Math.max(0, seconds);
    this.post(deck, { type: "seek", seconds: m.pos, seq: ++m.seq });
  }

  setRate(deck: number, rate: number): void {
    this.models[deck].rate = rate;
    this.post(deck, { type: "rate", rate });
  }

  setLoop(deck: number, loop: { start: number; end: number } | null): void {
    const m = this.models[deck];
    this.freeze(deck);
    m.loop = loop;
    this.post(deck, { type: "loop", start: loop ? loop.start : null, end: loop ? loop.end : 0 });
  }

  nudge(deck: number, rateOffset: number): void {
    this.post(deck, { type: "nudge", offset: rateOffset });
  }

  setScratching(deck: number, active: boolean): void {
    const m = this.models[deck];
    this.freeze(deck);
    m.scratching = active;
    m.speed = active ? 0 : m.playing ? m.rate : 0;
    this.post(deck, { type: "scratch", active, seq: ++m.seq });
  }

  scratchMove(deck: number, seconds: number): void {
    this.post(deck, { type: "scratchMove", seconds });
  }

  getPosition(deck: number): number {
    const m = this.models[deck];
    if (!m.buffer) return 0;
    let p = m.pos + m.speed * (this.now() - m.time);
    // Between worklet reports, extrapolate around an active loop instead of running past its end.
    const lp = m.loop;
    if (lp && m.speed > 0 && m.pos < lp.end && p >= lp.end && lp.end > lp.start) p = lp.start + ((p - lp.start) % (lp.end - lp.start));
    return Math.max(0, Math.min(m.buffer.duration, p));
  }

  /** Snapshot the extrapolated position so a local state change starts from the right place. */
  private freeze(deck: number): void {
    const m = this.models[deck];
    m.pos = this.getPosition(deck);
    m.time = this.now();
  }

  /** Audible context time (what is coming out of the speakers now). */
  private now(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.contextTime > 0) return ts.contextTime;
    return Math.max(0, ctx.currentTime - (ctx.outputLatency ?? 0) - ctx.baseLatency);
  }

  private onWorkletMessage(deck: number, msg: WorkletReport): void {
    const m = this.models[deck];
    if (msg.seq !== m.seq) return; // stale: a newer local command has not been processed yet
    if (msg.type === "pos") {
      m.stemsReady = !!msg.stemsReady;
      m.pos = msg.seconds;
      m.speed = msg.speed;
      m.time = msg.time;
    } else if (msg.type === "ended") {
      m.playing = false;
      m.speed = 0;
      this.emit({ type: "ended", deck });
    }
  }

  private post(deck: number, msg: Record<string, unknown>): void {
    this.decks[deck]?.node.port.postMessage(msg);
  }

  // ─────────────────────────── mixer ───────────────────────────

  setChannel(deck: number, dsp: ChannelDsp): void {
    this.models[deck].dsp = dsp;
    this.applyChannel(deck, dsp);
  }

  private applyChannel(deck: number, dsp: ChannelDsp): void {
    const g = this.decks[deck];
    const ctx = this.ctx;
    if (!g || !ctx) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, PARAM_SMOOTH_S);
    set(g.trim.gain, dsp.trimGain);
    set(g.eqLow.gain, dsp.eqLowDb);
    set(g.eqMid.gain, dsp.eqMidDb);
    set(g.eqHigh.gain, dsp.eqHighDb);
    set(g.hpf.frequency, dsp.filter.highpassHz);
    set(g.lpf.frequency, Math.min(dsp.filter.lowpassHz, ctx.sampleRate / 2 - 100));
    set(g.out.gain, dsp.outputGain);
    set(g.pfl.gain, dsp.pfl ? 1 : 0);
  }

  // ─────────────────────────── STEMS ───────────────────────────

  stemsInit(deck: number, info: { stride: number; regions: number; rate: number }): void {
    const m = this.models[deck];
    m.stemsLoaded = true;
    m.stemsReady = false;
    this.post(deck, { type: "stemsInit", ...info });
    this.post(deck, { type: "stemsMix", ...m.stemsMix });
    this.applyFx();
  }

  stemsRegion(deck: number, region: number, data: Int16Array): void {
    // Transferred (zero-copy): the audio thread never allocates or copies large buffers.
    this.decks[deck]?.node.port.postMessage({ type: "stemsRegion", region, data }, [data.buffer]);
  }

  stemsMix(deck: number, enabled: boolean, gains: number[]): void {
    this.models[deck].stemsMix = { enabled, gains: gains.slice(0, 4) };
    this.post(deck, { type: "stemsMix", enabled, gains });
  }

  stemsClear(deck: number): void {
    const m = this.models[deck];
    m.stemsLoaded = false;
    m.stemsReady = false;
    this.post(deck, { type: "stemsClear" });
    this.applyFx();
  }

  stemsReadyAtPlayhead(deck: number): boolean {
    return this.models[deck]?.stemsReady ?? false;
  }

  setFx(unit: number, fx: FxDsp): void {
    this.fxDsp[unit] = fx;
    this.applyFx();
  }

  private applyFx(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.decks.forEach((g, deck) => {
      let dryCut = 0;
      this.fxDsp.forEach((fx, unit) => {
        const slots = g.fx[unit];
        if (!fx || !slots) return;
        let stemSend = false;
        fx.slots.forEach((s, k) => {
          const slot = slots[k];
          if (!slot) return;
          const active = s.enabled && !!fx.decks[deck];
          const useStems = !!fx.stemMask && !INSERT_TYPES.has(s.type) && this.models[deck].stemsLoaded;
          const params = { type: s.type, mix: fx.mix, param: s.param, timeSec: fx.timeSec };
          slot.update(params, active, useStems);
          if (active && useStems) stemSend = true;
          dryCut += slot.dryReduction(params, active);
        });
        g.node.port.postMessage({ type: "stemsFx", unit, mask: stemSend ? fx.stemMask : [0, 0, 0, 0] });
      });
      g.dry.gain.setTargetAtTime(Math.max(0, 1 - dryCut), ctx.currentTime, 0.02);
    });
  }

  setMaster(dsp: MasterDsp): void {
    this.masterDsp = dsp;
    this.applyMaster();
  }

  private applyMaster(): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    const t = ctx.currentTime;
    const d = this.masterDsp;
    this.masterGain.gain.setTargetAtTime(d.masterGain, t, PARAM_SMOOTH_S);
    this.headCue?.gain.setTargetAtTime(d.headCueGain, t, PARAM_SMOOTH_S);
    this.headMaster?.gain.setTargetAtTime(d.headMasterGain, t, PARAM_SMOOTH_S);
    this.headLevel?.gain.setTargetAtTime(d.headphoneGain, t, PARAM_SMOOTH_S);
  }

  private taps = new Map<string, AnalyserNode>();

  /**
   * Analyser on the master mix or a deck (after EQ/filter/FX, before the channel fader) for
   * sound-to-light and similar consumers. Created on first use; recreated after an audio
   * rebuild. Costs nothing on the audio thread beyond a buffer copy.
   */
  getAnalysisTap(source: "master" | number): AnalyserNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const key = String(source);
    const existing = this.taps.get(key);
    if (existing && existing.context === ctx) return existing;
    const node = source === "master" ? this.masterGain : this.decks[source]?.post;
    if (!node) return null;
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0;
    node.connect(a);
    this.taps.set(key, a);
    return a;
  }

  getLevels(): { channels: number[]; master: number } {
    const peak = (a: AnalyserNode | null | undefined): number => {
      if (!a) return 0;
      const buf = this.meterBuf.length === a.fftSize ? this.meterBuf : (this.meterBuf = new Float32Array(a.fftSize));
      a.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > p) p = v;
      }
      return p;
    };
    return { channels: this.decks.map((g) => peak(g.meter)), master: peak(this.masterMeter) };
  }
}

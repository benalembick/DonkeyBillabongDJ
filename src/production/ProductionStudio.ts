import type { WebAudioEngine } from "../audio/WebAudioEngine";
import type { Platform } from "../platform";
import type { TrackInfo } from "../core/engine/types";
import type { MidiMessage } from "../controllers/midi/message";
import type { StemService } from "../stems/StemService";
import { beatsToSeconds, humanizeNotes, midiFrequency, midiName, quantizeNotes, quantizeToGrid, secondsToBeats } from "./midi";
import { detectRootNote } from "./pitch";
import { blankProject, defaultPadParams, instrumentTrack, makeId, migrateProject, padLabel, PAD_BANKS, PADS_PER_BANK, sampleToClip, type AudioClip, type InstrumentSettings, type MidiClip, type MidiNote, type PadParams, type SynthSettings, type VocalTake, type LooperSession, blankLooper, type ProductionClip, type QuantizeGrid, type SamplerMode, QUANTIZE_BEATS, type ProductionProject, type ProductionState, type ProductionTrack, type SamplerSample, type SliceState } from "./types";
import { analyseClean, beatMarkers, detectTransients, equalMarkers, mixToMono, nearestZeroCrossing, sliceRegions, transientMarkers } from "./slicing";
import { encodeWav } from "./wav";
import { isRecordingRef, loadRecording, saveRecording } from "./recordings";

type Listener = (state: ProductionState) => void;
/** `only` limits playback to these tracks (Vocal Studio backing selection); `exclude` silences one track. */
export interface PlayOptions { metronome?: boolean; backing?: boolean; exclude?: string; only?: string[]; noLoop?: boolean }
interface Scheduled { source: AudioScheduledSourceNode; gain?: GainNode; pan?: StereoPannerNode }
/** A sounding pad: `out` is the last node, used for click-free stops and releases. */
interface PadVoice { source: AudioBufferSourceNode; out: GainNode; release: number }
const clampSample = (sample: SamplerSample): void => {
  sample.start = Math.max(0, Math.min(sample.sourceDuration - .001, sample.start)); sample.end = Math.max(sample.start + .001, Math.min(sample.sourceDuration, sample.end)); sample.gain = Math.max(0, Math.min(4, sample.gain));
  sample.edits.fadeIn = Math.max(0, Math.min(sample.edits.fadeIn, sample.end - sample.start)); sample.edits.fadeOut = Math.max(0, Math.min(sample.edits.fadeOut, sample.end - sample.start));
};
const clampPad = (p: PadParams): void => {
  p.pan = Math.max(-1, Math.min(1, p.pan)); p.pitch = Math.max(-24, Math.min(24, p.pitch)); p.attack = Math.max(0, Math.min(5, p.attack)); p.decay = Math.max(0, Math.min(5, p.decay)); p.sustain = Math.max(0, Math.min(1, p.sustain)); p.release = Math.max(0, Math.min(5, p.release));
  p.cutoff = Math.max(40, Math.min(20000, p.cutoff)); p.resonance = Math.max(.1, Math.min(20, p.resonance)); p.choke = (Math.max(0, Math.min(4, Math.round(p.choke))) as PadParams["choke"]);
};
/** Max-pooled copy of a waveform overview (pads keep a lighter overview than the editor). */
const pool = (peaks: number[], count: number): number[] => peaks.length <= count ? peaks.slice() : Array.from({ length: count }, (_, i) => { let m = 0; for (let j = Math.floor(i * peaks.length / count); j < Math.floor((i + 1) * peaks.length / count); j++) m = Math.max(m, peaks[j]); return m; });
const SLICE_KEYS = ["mode", "sensitivity", "beats", "equal", "bpm"] as const;
const STORAGE = "dbdj.production.autosave.v1";
const PAD_VOLUME = "dbdj.sampler.padVolume";
/** Display waveform resolution: bins per second (2 per pixel at the closest arrangement zoom). */
export const WAVEFORM_RATE = 200;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class ProductionStudio {
  private state: ProductionState;
  private listeners = new Set<Listener>();
  private undoStack: ProductionProject[] = [];
  private redoStack: ProductionProject[] = [];
  private decoded = new Map<string, AudioBuffer>();
  private reversedDecoded = new Map<string, AudioBuffer>();
  private memoryFiles = new Map<string, ArrayBuffer>();
  private scheduled: Scheduled[] = [];
  private startedAt = 0;
  private startedPosition = 0;
  private raf = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private recordingStart = 0;
  private midiNotesOn = new Map<string, { pitch: number; velocity: number; channel: number; startedBeat: number; trackId: string; clipId: string }>();
  private samplerSource: AudioBufferSourceNode | null = null;
  private samplerStartedAt = 0;
  private samplerStartPosition = 0;
  private samplerRaf = 0;
  private samplerRecorder: MediaRecorder | null = null;
  private samplerRecordingChunks: Blob[] = [];
  private samplerRecordingStream: MediaStream | null = null;
  private padVoices = new Map<number, PadVoice>();
  /** CHROMATIC voices by MIDI note, and notes currently held down. */
  private noteVoices = new Map<number, PadVoice>();
  private notesHeld = new Set<number>();
  /** Pattern recording: beat 0 is `startAt` (performance.now ms); `held` are notes still down. */
  private rec: { startAt: number; beatMs: number; mode: SamplerMode; notes: MidiNote[]; held: Map<number, { start: number; velocity: number }>; timer: ReturnType<typeof setInterval>; nextClick: number; click: boolean } | null = null;
  private patternVoices: PadVoice[] = [];
  private patternTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private previewNode: AudioBufferSourceNode | null = null;
  private playOptions: PlayOptions = {};
  private playClock: { contextTime: number; position: number; context: BaseAudioContext } | null = null;
  private masterBus: GainNode | null = null;
  private masterMeter: AnalyserNode | null = null;
  private trackMeters = new Map<string, AnalyserNode>();
  private mono = new Map<string, { data: Float32Array; rate: number }>();
  private gestureBase: ProductionProject | null = null;
  private padsHeld = new Set<number>();
  private padBus: GainNode | null = null;
  private waveforms = new Map<string, Float32Array>();
  private waveformQueue: Promise<void> = Promise.resolve();
  private waveformPending = new Set<string>();

  /** `storageKey` defaults to the real project's autosave slot; a separate instance (Teach Me: Live Looping's lesson sandbox) passes its own so it can never read or overwrite the user's project. */
  constructor(private audio: WebAudioEngine, private platform: Platform, private stems: StemService, private storageKey: string = STORAGE) {
    let project = blankProject();
    try {
      const saved = migrateProject(JSON.parse(localStorage.getItem(this.storageKey) ?? "null"));
      if (saved) project = saved;
    } catch { /* malformed recovery data is ignored */ }
    this.state = { project, playing: false, recording: false, midiRecording: false, position: 0, selectedClipId: null, undoAvailable: false, redoAvailable: false, message: "Autosave ready", stemJob: null, samplerPlayback: null, samplerRecording: false, padsPlaying: [], padVolume: 1, cleanReport: null, patternRecording: null, patternPlaying: false, notesPlaying: [], previewRef: null };
    try { const saved = localStorage.getItem(PAD_VOLUME); if (saved !== null && Number.isFinite(Number(saved))) this.state.padVolume = Math.max(0, Math.min(1.5, Number(saved))); } catch { /* storage unavailable */ }
  }

  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getState = (): ProductionState => this.state;
  private emit(message?: string): void {
    this.state = { ...this.state, undoAvailable: this.undoStack.length > 0, redoAvailable: this.redoStack.length > 0, message: message ?? this.state.message };
    for (const listener of this.listeners) listener(this.state);
  }
  private commit(next: ProductionProject, message: string): void {
    this.undoStack.push(clone(this.state.project)); if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = []; next.updatedAt = Date.now(); this.state = { ...this.state, project: next }; this.emit(message); this.queueAutosave();
  }
  /** Live update during a drag: not in the undo history until endGesture(). */
  private preview(next: ProductionProject): void { if (!this.gestureBase) this.gestureBase = clone(this.state.project); next.updatedAt = Date.now(); this.state = { ...this.state, project: next }; this.emit(); }
  private endGesture(message: string): void {
    const base = this.gestureBase; this.gestureBase = null; if (!base) return;
    this.undoStack.push(base); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; this.emit(message); this.queueAutosave();
  }
  private queueAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => { try { localStorage.setItem(this.storageKey, JSON.stringify(this.state.project)); this.emit("Autosaved"); } catch { this.emit("Autosave unavailable"); } }, 400);
  }
  updateProject(patch: Partial<Pick<ProductionProject, "name" | "bpm" | "metronome" | "loop" | "key">>): void {
    this.commit({ ...clone(this.state.project), ...patch }, "Project updated");
    if (this.state.playing) void this.restart();
  }
  updateTrack(id: string, patch: Partial<ProductionTrack>): void {
    const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === id); if (!track) return;
    Object.assign(track, patch); this.commit(p, "Mixer updated"); if (this.state.playing) void this.restart();
  }
  addTrack(name?: string): string {
    const p = clone(this.state.project); const id = makeId("track"); p.tracks.push({ id, name: name ?? `Audio ${p.tracks.length + 1}`, kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "None", output: "master", clips: [] }); this.commit(p, "Audio track added"); return id;
  }
  /** Adds an instrument track (synth with an optional preset, drum kit, or a Sampler track in SLICES / CHROMATIC). Returns its id. */
  addInstrumentTrack(type: "synth" | "drums" | "sampler", options: { synth?: SynthSettings; name?: string; samplerMode?: SamplerMode } = {}): string {
    const p = clone(this.state.project); const count = p.tracks.filter((t) => t.instrument?.type === type).length + 1;
    const label = type === "synth" ? "Synth" : type === "drums" ? "Drums" : options.samplerMode === "chromatic" ? "Sampler Chromatic" : "Sampler Slices";
    const track = instrumentTrack(options.name ?? `${label} ${count}`, type); if (options.synth) track.instrument!.synth = { ...options.synth }; if (type === "sampler") track.instrument!.samplerMode = options.samplerMode ?? "slices";
    p.tracks.push(track); this.commit(p, `${options.name ?? label} track added`); return track.id;
  }
  // ───────────── Live Looper hooks (session data lives in the project; audio in IndexedDB) ─────────────
  /** Applies `change` to the Live Looper session (created on first use) as one undoable, autosaved edit. */
  updateLooper(change: (session: LooperSession) => void, message: string, undoable = true): void {
    const p = clone(this.state.project); p.looper ??= blankLooper(); change(p.looper);
    if (undoable) this.commit(p, message); else { p.updatedAt = Date.now(); this.state = { ...this.state, project: p }; this.emit(message); this.queueAutosave(); }
  }
  /** Keeps recorded audio for this session (memory) and across restarts (IndexedDB). */
  async storeAudio(ref: string, wav: ArrayBuffer): Promise<void> { this.memoryFiles.set(ref, wav); await this.keepRecording(ref, wav); }
  /** Decoded audio for a source or recording ref (cached). */
  getBuffer(ref: string): Promise<AudioBuffer> { return this.buffer(ref); }

  /** Changes a vocal track's data (pitch settings, take notes) and its take clips' sources in one edit. */
  updateVocal(trackId: string, change: (track: ProductionTrack) => void, message: string, undoable = true): void {
    const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId); if (!track?.vocal) return; change(track);
    if (undoable) this.commit(p, message); else { p.updatedAt = Date.now(); this.state = { ...this.state, project: p }; this.emit(message); this.queueAutosave(); }
    this.refreshArrangement();
  }

  /** A new Vocal Studio track (an audio track that keeps its takes). Returns its id. */
  addVocalTrack(name?: string): string {
    const p = clone(this.state.project); const id = makeId("track"); const count = p.tracks.filter((t) => t.vocal).length + 1;
    p.tracks.push({ id, name: name ?? `Vocal ${count}`, kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "Microphone", output: "master", vocal: { takes: [], activeTakeId: null }, clips: [] });
    this.commit(p, "Vocal track added"); return id;
  }
  /** Stores a recorded take (dry WAV kept in IndexedDB) on a vocal track and makes it the track's active take. */
  async addVocalTake(trackId: string, take: VocalTake, wav: ArrayBuffer): Promise<void> {
    this.memoryFiles.set(take.ref, wav); await this.keepRecording(take.ref, wav);
    const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId); if (!track) throw new Error("The vocal track no longer exists");
    track.vocal ??= { takes: [], activeTakeId: null }; track.vocal.takes.push(take);
    this.placeTake(track, take, await this.buffer(take.ref)); this.commit(p, `${take.name} recorded on ${track.name}`); this.selectClip(track.clips.find((c) => c.type === "audio" && c.takeId === take.id)?.id ?? null);
  }
  /** The track plays this take (its clip replaces the previous take's clip; nothing is deleted). */
  async setActiveTake(trackId: string, takeId: string): Promise<void> {
    const take = this.state.project.tracks.find((t) => t.id === trackId)?.vocal?.takes.find((x) => x.id === takeId); if (!take) return;
    const buffer = await this.buffer(take.ref); const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId)!;
    this.placeTake(track, take, buffer); this.commit(p, `${take.name} is the active take`); this.refreshArrangement();
  }
  renameTake(trackId: string, takeId: string, name: string): void { const p = clone(this.state.project); const take = p.tracks.find((t) => t.id === trackId)?.vocal?.takes.find((x) => x.id === takeId); if (!take) return; take.name = name; for (const t of p.tracks) for (const c of t.clips) if (c.type === "audio" && c.takeId === takeId) c.name = name; this.commit(p, "Take renamed"); }
  private placeTake(track: ProductionTrack, take: VocalTake, buffer: AudioBuffer): void {
    // A take replaces only the range it covers: earlier take clips keep their parts before / after it (punch-in),
    // joined with 10 ms crossfades. Other clips on the track are untouched.
    const end = take.start + Math.min(take.duration, buffer.duration - take.offset); const xf = .01; const kept: ProductionClip[] = [];
    for (const c of track.clips) {
      if (!(c.type === "audio" && c.takeId && c.start < end && c.start + c.duration > take.start)) { kept.push(c); continue; }
      if (c.start < take.start - .02) kept.push({ ...c, duration: take.start - c.start + xf, fadeOut: xf });
      if (c.start + c.duration > end + .02) kept.push({ ...c, id: makeId("clip"), start: end - xf, offset: c.offset + (end - xf - c.start), duration: c.start + c.duration - end + xf, fadeIn: xf });
    }
    const partial = kept.length < track.clips.length || kept.some((c) => c.type === "audio" && !!c.takeId);
    track.clips = kept;
    track.clips.push({ type: "audio", id: makeId("clip"), takeId: take.id, name: take.name, ref: take.ref, start: take.start, offset: take.offset, duration: end - take.start, sourceDuration: buffer.duration, gain: 1, muted: false, peaks: this.peaks(buffer), ...(partial ? { fadeIn: xf, fadeOut: xf } : {}) });
    track.vocal!.activeTakeId = take.id;
  }
  /** Applies a synth preset to an existing synth track. */
  applySynthPreset(trackId: string, synth: SynthSettings, name: string): void {
    const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId && t.instrument?.type === "synth"); if (!track) throw new Error("Select a synth track to apply a preset");
    track.instrument!.synth = { ...synth }; this.commit(p, `${name} preset on ${track.name}`); this.refreshArrangement();
  }
  /**
   * Adds audio at the playhead: on `trackId`, else the selected clip's audio track, else the first audio track,
   * else (or with `newTrack`) a new audio track named after the item.
   */
  async addAudioAtPlayhead(item: Pick<TrackInfo, "ref" | "title">, options: { trackId?: string; newTrack?: boolean; start?: number } = {}): Promise<void> {
    const p = this.state.project; const selectedTrack = p.tracks.find((t) => t.kind === "audio" && t.clips.some((c) => c.id === this.state.selectedClipId));
    let trackId = options.newTrack ? undefined : options.trackId ?? selectedTrack?.id ?? p.tracks.find((t) => t.kind === "audio" && !t.stem)?.id;
    trackId ??= this.addTrack(item.title); const beat = 60 / p.bpm;
    await this.addAudio(trackId, item, options.start ?? Math.round(this.state.position / beat) * beat);
  }
  /** Browser preview: plays up to 30 s of a source (another preview, or the same one again, stops it). */
  async previewSource(ref: string): Promise<void> {
    const same = this.state.previewRef === ref; this.stopPreview(); if (same) return;
    const buffer = await this.buffer(ref); const { context, input } = await this.audio.createProductionOutput(); const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain(); const length = Math.min(buffer.duration, 30); gain.gain.setValueAtTime(1, context.currentTime + Math.max(0, length - .05)); gain.gain.linearRampToValueAtTime(0, context.currentTime + length);
    source.connect(gain).connect(input); source.start(context.currentTime, 0, length); this.previewNode = source;
    source.onended = () => { if (this.previewNode !== source) return; this.previewNode = null; this.state = { ...this.state, previewRef: null }; this.emit(); };
    this.state = { ...this.state, previewRef: ref }; this.emit();
  }
  stopPreview(): void { const node = this.previewNode; this.previewNode = null; if (node) try { node.stop(); } catch { /* already stopped */ } if (this.state.previewRef) { this.state = { ...this.state, previewRef: null }; this.emit(); } }
  removeTrack(id: string): void { const p = clone(this.state.project); if (p.tracks.length <= 1) return; p.tracks = p.tracks.filter((t) => t.id !== id); this.commit(p, "Track removed"); }

  private async bytes(ref: string): Promise<ArrayBuffer> { const inMemory = this.memoryFiles.get(ref); if (inMemory) return inMemory.slice(0); if (isRecordingRef(ref)) { const saved = await loadRecording(ref).catch(() => null); if (!saved) throw new Error("This microphone recording is no longer available — record it again"); this.memoryFiles.set(ref, saved); return saved.slice(0); } if (ref.startsWith("production-stem://")) { const wav = await this.rebuildStem(ref); this.memoryFiles.set(ref, wav); return wav.slice(0); } return this.platform.readAudio(ref); }
  private async rebuildStem(ref: string): Promise<ArrayBuffer> {
    const split = ref.lastIndexOf("#"), sourceRef = ref.slice("production-stem://".length, split), part = ref.slice(split + 1) as "vocals" | "drums" | "bass" | "instruments";
    if (split < 0 || !sourceRef || !["vocals", "drums", "bass", "instruments"].includes(part)) throw new Error("Invalid Production STEM reference");
    const rendered = await this.stems.renderData(sourceRef); const raw = new Int16Array(rendered.pcm); const frames = Math.min(rendered.total, Math.floor(raw.length / 6)); const left = new Float32Array(frames), right = new Float32Array(frames); const channels = part === "vocals" ? [0, 1] : part === "drums" ? [2, 3] : [4, 5];
    if (part === "instruments") { const decoded = await this.audio.decode(await this.platform.readAudio(sourceRef)); const offline = new OfflineAudioContext(2, frames, rendered.rate); const node = offline.createBufferSource(); node.buffer = decoded.handle as AudioBuffer; node.connect(offline.destination); node.start(); const original = await offline.startRendering(); const l = original.getChannelData(0), r = original.getChannelData(Math.min(1, original.numberOfChannels - 1)); for (let i = 0; i < frames; i++) { left[i] = l[i] - (raw[i * 6] + raw[i * 6 + 2] + raw[i * 6 + 4]) / 32768; right[i] = r[i] - (raw[i * 6 + 1] + raw[i * 6 + 3] + raw[i * 6 + 5]) / 32768; } }
    else for (let i = 0; i < frames; i++) { left[i] = raw[i * 6 + channels[0]] / 32768; right[i] = raw[i * 6 + channels[1]] / 32768; }
    return encodeWav({ sampleRate: rendered.rate, left, right });
  }
  private providers: { prefix: string; load: (ref: string) => Promise<AudioBuffer> }[] = [];
  /** Computed sources (e.g. tuned vocal renders): the provider owns caching; nothing is decoded or stored here. */
  registerBufferProvider(prefix: string, load: (ref: string) => Promise<AudioBuffer>): void { this.providers.push({ prefix, load }); }
  private async buffer(ref: string): Promise<AudioBuffer> {
    const provider = this.providers.find((p) => ref.startsWith(p.prefix)); if (provider) return provider.load(ref);
    const cached = this.decoded.get(ref); if (cached) return cached;
    const decoded = await this.audio.decode(await this.bytes(ref)); const buffer = decoded.handle as AudioBuffer; this.decoded.set(ref, buffer); return buffer;
  }
  private peaks(buffer: AudioBuffer, count = 800): number[] {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)); const stride = Math.max(1, Math.floor(buffer.length / count)); const out: number[] = [];
    for (let i = 0; i < buffer.length; i += stride) { let peak = 0; let energy = 0; let samples = 0; for (let j = i; j < Math.min(buffer.length, i + stride); j++) for (const data of channels) { const value = Math.abs(data[j]); peak = Math.max(peak, value); energy += value * value; samples++; } out.push(peak * .7 + Math.sqrt(energy / Math.max(1, samples)) * .3); }
    return out.slice(0, count);
  }
  /**
   * Detailed display waveform (peak per 1/WAVEFORM_RATE s, normalised 0–1) of a source, computed from the
   * decoded audio and kept for the session only (projects store just a small overview). Returns null and
   * notifies subscribers once it is ready; sources are decoded one at a time.
   */
  waveform(ref: string): Float32Array | null {
    const ready = this.waveforms.get(ref); if (ready || this.waveformPending.has(ref)) return ready ?? null;
    this.waveformPending.add(ref);
    this.waveformQueue = this.waveformQueue.then(async () => {
      try { this.waveforms.set(ref, this.waveformOf(await this.buffer(ref))); this.emit(); } catch { /* the stored overview stays */ }
    });
    return null;
  }
  private waveformOf(buffer: AudioBuffer): Float32Array {
    const per = Math.max(1, Math.round(buffer.sampleRate / WAVEFORM_RATE)); const bins = Math.ceil(buffer.length / per); const out = new Float32Array(bins);
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c)); let max = 0;
    for (const data of channels) for (let b = 0; b < bins; b++) { let peak = out[b]; for (let i = b * per, end = Math.min(data.length, i + per); i < end; i++) { const v = data[i] < 0 ? -data[i] : data[i]; if (v > peak) peak = v; } out[b] = peak; if (peak > max) max = peak; }
    if (max > 0) for (let b = 0; b < bins; b++) out[b] /= max;
    return out;
  }
  async addAudio(trackId: string, item: Pick<TrackInfo, "ref" | "title">, start: number): Promise<void> {
    const target = this.state.project.tracks.find((t) => t.id === trackId); if (target && target.kind !== "audio") throw new Error(`${target.name} is an instrument track — drop audio on an audio track`);
    const buffer = await this.buffer(item.ref); const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId); if (!track) return;
    const clip: AudioClip = { type: "audio", id: makeId("clip"), name: item.title, ref: item.ref, start: Math.max(0, start), offset: 0, duration: buffer.duration, sourceDuration: buffer.duration, gain: 1, muted: false, peaks: this.peaks(buffer) }; track.clips.push(clip);
    this.commit(p, `Added ${item.title}`); this.selectClip(clip.id);
  }

  /** Places a sampler sample on an audio track (default: a "Samples" track, created when missing) at `start` or the playhead. */
  addSampleToArrangement(sample: SamplerSample, trackId?: string, start = this.state.position): string {
    const p = clone(this.state.project); let track = trackId ? p.tracks.find((t) => t.id === trackId) : p.tracks.find((t) => t.kind === "audio" && !t.stem && t.name === "Samples");
    if (trackId && track?.kind !== "audio") throw new Error(`${track?.name ?? "That track"} can't hold audio — drop samples on an audio track or a Sampler track`);
    if (!track) { track = { id: makeId("track"), name: "Samples", kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "Sampler", output: "master", clips: [] }; p.tracks.push(track); }
    const grid = 15 / p.bpm; const clip = sampleToClip(sample, Math.round(start / grid) * grid); track.clips.push(clip);
    this.commit(p, `${sample.name} added to ${track.name}`); this.selectClip(clip.id); return clip.id;
  }

  async loadSamplerSource(item: Pick<TrackInfo, "ref" | "title">): Promise<void> {
    const buffer = await this.buffer(item.ref); const project = clone(this.state.project);
    project.sampler.editor = { id: makeId("sample"), sourceRef: item.ref, name: item.title || "Untitled Sample", sourceDuration: buffer.duration, start: 0, end: buffer.duration, gain: 1, playbackMode: "one-shot", edits: { reverse: false, normalize: false, fadeIn: 0, fadeOut: 0 }, peaks: this.peaks(buffer, 1600), createdAt: Date.now() };
    project.sampler.slicing = { ...project.sampler.slicing, detected: [], markers: [], sourceRef: null }; this.state = { ...this.state, cleanReport: null };
    this.stopSampler(); this.commit(project, `Loaded ${item.title} into Sampler`);
    if (project.sampler.slicing.enabled) await this.refreshSlices();
  }
  async toggleSamplerRecording(): Promise<void> {
    if (this.samplerRecorder) { this.samplerRecorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording is not supported on this device");
    this.stopSampler();
    const stream = await this.openMicrophone();
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined); this.samplerRecorder = recorder; this.samplerRecordingStream = stream; this.samplerRecordingChunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) this.samplerRecordingChunks.push(event.data); };
    recorder.onerror = () => { void this.finishSamplerRecording(false); };
    recorder.onstop = () => { void this.finishSamplerRecording(true); };
    recorder.start(200); this.state = { ...this.state, samplerRecording: true }; this.emit("Recording microphone sample…");
  }
  private async finishSamplerRecording(load: boolean): Promise<void> {
    const recorder = this.samplerRecorder; const stream = this.samplerRecordingStream; this.samplerRecorder = null; this.samplerRecordingStream = null; stream?.getTracks().forEach((track) => track.stop()); this.state = { ...this.state, samplerRecording: false };
    if (!load || !this.samplerRecordingChunks.length) { this.samplerRecordingChunks = []; this.emit(load ? "No microphone audio was captured" : "Microphone recording failed"); return; }
    try {
      const blob = new Blob(this.samplerRecordingChunks, { type: recorder?.mimeType || "audio/webm" }); this.samplerRecordingChunks = []; const bytes = await blob.arrayBuffer(); const ref = `production-sampler-recording://${makeId("take")}`; this.memoryFiles.set(ref, bytes); await this.keepRecording(ref, bytes);
      await this.loadSamplerSource({ ref, title: `Microphone Sample ${new Date().toLocaleTimeString()}` }); this.emit("Microphone sample ready to edit");
    } catch (error) { this.emit(`Could not decode microphone sample: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private cancelSamplerRecording(): void { const recorder = this.samplerRecorder; this.samplerRecorder = null; if (recorder) { recorder.onstop = null; recorder.stop(); } this.samplerRecordingStream?.getTracks().forEach((track) => track.stop()); this.samplerRecordingStream = null; this.samplerRecordingChunks = []; this.state = { ...this.state, samplerRecording: false }; }
  updateSamplerEditor(patch: Partial<SamplerSample>): void {
    const project = clone(this.state.project); const editor = project.sampler.editor; if (!editor) return;
    Object.assign(editor, patch); clampSample(editor);
    const slicing = project.sampler.slicing; if (slicing.markers.length && ("start" in patch || "end" in patch)) slicing.markers = slicing.mode === "manual" ? slicing.markers.filter((m) => m > editor.start && m < editor.end) : this.markersFor(project);
    this.commit(project, "Sampler edit updated");
  }
  setSamplerEdit(patch: Partial<SamplerSample["edits"]>): void { const editor = this.state.project.sampler.editor; if (editor) this.updateSamplerEditor({ edits: { ...editor.edits, ...patch } }); }
  cropSamplerToSelection(): void { if (this.state.project.sampler.editor) this.emit("Crop applied non-destructively to the selected region"); }
  /** Selection is saved with the project but is not an undoable edit. */
  selectSamplerPad(index: number): void { const project = clone(this.state.project); project.sampler.selectedPad = Math.max(0, Math.min(project.sampler.pads.length - 1, index)); project.sampler.bank = Math.floor(project.sampler.selectedPad / PADS_PER_BANK); this.state = { ...this.state, project }; this.emit(`Pad ${padLabel(project.sampler.selectedPad)} selected`); this.queueAutosave(); }
  /** Switches pad bank A–D (not undoable); the selected pad keeps its position in the bank. */
  setSamplerBank(bank: number): void {
    const project = clone(this.state.project); const sampler = project.sampler; sampler.bank = ((Math.round(bank) % PAD_BANKS.length) + PAD_BANKS.length) % PAD_BANKS.length; sampler.selectedPad = sampler.bank * PADS_PER_BANK + sampler.selectedPad % PADS_PER_BANK;
    this.state = { ...this.state, project }; this.emit(`Pad bank ${PAD_BANKS[sampler.bank]}`); this.queueAutosave();
  }
  updatePadParams(index: number, patch: Partial<PadParams>): void {
    const project = clone(this.state.project); const pad = project.sampler.pads[index]; if (!pad) return;
    Object.assign(pad.params, patch); clampPad(pad.params); this.commit(project, `Pad ${padLabel(index)} updated`); this.refreshArrangement();
    if ("muted" in patch || "solo" in patch) for (const playing of [...this.padVoices.keys()]) if (!this.padAudible(playing)) this.stopPad(playing);
  }
  updatePadSample(index: number, patch: Partial<SamplerSample>): void {
    const project = clone(this.state.project); const sample = project.sampler.pads[index]?.sample; if (!sample) return;
    Object.assign(sample, patch); clampSample(sample); this.commit(project, `Pad ${padLabel(index)} sample updated`); this.refreshArrangement();
  }
  saveSamplerSample(): SamplerSample | null {
    const project = clone(this.state.project); const editor = project.sampler.editor; if (!editor) return null;
    const saved = { ...editor, id: makeId("sample"), createdAt: Date.now() }; project.sampler.savedSamples.push(saved); project.sampler.editor = { ...saved }; this.commit(project, `Saved sample ${saved.name}`); return saved;
  }
  assignSamplerToPad(index = this.state.project.sampler.selectedPad): void {
    const project = clone(this.state.project); const editor = project.sampler.editor; const pad = project.sampler.pads[index]; if (!editor || !pad) return;
    pad.sample = { ...editor, id: makeId("sample"), createdAt: Date.now() }; project.sampler.selectedPad = index; this.commit(project, `${editor.name} assigned to Pad ${padLabel(index)}`);
  }
  clearSamplerPad(index: number): void { const project = clone(this.state.project); const pad = project.sampler.pads[index]; if (!pad) return; pad.sample = null; pad.params = defaultPadParams(); this.commit(project, `Pad ${padLabel(index)} cleared`); }
  private reversed(ref: string, buffer: AudioBuffer): AudioBuffer {
    const cached = this.reversedDecoded.get(ref); if (cached) return cached;
    const copy = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) copy.copyToChannel(buffer.getChannelData(channel).slice().reverse(), channel);
    this.reversedDecoded.set(ref, copy);
    return copy;
  }
  async playSampler(selection = true, loop = false): Promise<void> { const sample = this.state.project.sampler.editor; if (sample) await this.playSamplerSample(sample, selection ? 0 : -sample.start, loop); }
  pauseSampler(): void {
    const playback = this.state.samplerPlayback; if (!playback?.playing) return; const sample = this.samplerForPlayback(playback); const elapsed = (performance.now() - this.samplerStartedAt) / 1000; this.stopSamplerNode();
    this.state = { ...this.state, samplerPlayback: { ...playback, playing: false, paused: true, position: Math.min(sample ? sample.end - sample.start : Infinity, this.samplerStartPosition + elapsed) } }; this.emit("Sampler paused");
  }
  stopSampler(): void { this.stopSamplerNode(); this.state = { ...this.state, samplerPlayback: null }; this.emit("Sampler stopped"); }
  private stopSamplerNode(): void { if (this.samplerSource) try { this.samplerSource.stop(); } catch { /* already stopped */ } this.samplerSource = null; cancelAnimationFrame(this.samplerRaf); }
  private samplerForPlayback(playback = this.state.samplerPlayback): SamplerSample | null { const editor = this.state.project.sampler.editor; return playback && editor?.id === playback.sampleId ? editor : null; }
  /**
   * source → [low-pass] → level/fades → [ADSR] → [pan] → out → output. Pad params (pitch, filter, envelope, pan)
   * are optional so the editor preview plays the plain sample. Pitch changes speed, so times below are real time.
   */
  /**
   * `when` schedules the voice (default: now), `velocity` scales its level (127 = full) and `hold` ends a
   * gate / loop / chromatic note after that many seconds with the pad's release.
   */
  private async startSampleVoice(sample: SamplerSample, context: BaseAudioContext, output: AudioNode, resumeAt: number, looping: boolean, params?: PadParams, opts: { when?: number; velocity?: number; hold?: number } = {}): Promise<{ source: AudioBufferSourceNode; out: GainNode; position: number; regionDuration: number }> {
    const decoded = await this.buffer(sample.sourceRef); const buffer = sample.edits.reverse ? this.reversed(sample.sourceRef, decoded) : decoded; const source = context.createBufferSource(); source.buffer = buffer;
    const rate = params ? 2 ** (params.pitch / 12) : 1; source.playbackRate.value = rate;
    const gain = context.createGain(); const out = context.createGain(); let node: AudioNode = source;
    if (params && (params.cutoff < 20000 || params.resonance > 1)) { const filter = context.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = Math.min(params.cutoff, context.sampleRate / 2 - 100); filter.Q.value = params.resonance; node = node.connect(filter); }
    node = node.connect(gain);
    const regionDuration = sample.end - sample.start; const position = Math.max(0, Math.min(regionDuration - .001, resumeAt)); const offset = sample.edits.reverse ? sample.sourceDuration - sample.end + position : sample.start + position; const remaining = regionDuration - position; const real = remaining / rate; const normalization = sample.edits.normalize ? 1 / Math.max(.001, ...sample.peaks) : 1; const level = sample.gain * normalization * (opts.velocity ?? 127) / 127; const now = Math.max(context.currentTime, opts.when ?? context.currentTime);
    const fadeIn = sample.edits.fadeIn / rate, fadeOut = sample.edits.fadeOut / rate, at = position / rate;
    gain.gain.setValueAtTime(fadeIn > at ? .0001 : level, now); if (fadeIn > at) gain.gain.linearRampToValueAtTime(level, now + Math.min(real, fadeIn - at)); if (!looping && fadeOut > 0 && real > fadeOut) { gain.gain.setValueAtTime(level, now + real - fadeOut); gain.gain.linearRampToValueAtTime(.0001, now + real); }
    if (params && (params.attack > 0 || params.decay > 0 || params.sustain < 1 || params.release > 0)) {
      const env = context.createGain(); const { attack, decay, sustain, release } = params; const e = env.gain;
      const envAt = (t: number) => t < attack ? t / attack : t < attack + decay ? 1 - (1 - sustain) * (t - attack) / decay : sustain;
      const releaseAt = !looping && release > 0 ? Math.max(0, real - release) : Infinity;
      e.setValueAtTime(attack > 0 ? 0 : decay > 0 ? 1 : sustain, now);
      for (const t of [attack, attack + decay]) if (t > 0 && t < releaseAt) e.linearRampToValueAtTime(envAt(t), now + t);
      if (Number.isFinite(releaseAt)) { e.linearRampToValueAtTime(envAt(releaseAt), now + releaseAt); e.linearRampToValueAtTime(0, now + real); }
      node = node.connect(env);
    }
    if (params?.pan) { const pan = context.createStereoPanner(); pan.pan.value = params.pan; node = node.connect(pan); }
    node.connect(out).connect(output);
    source.loop = looping; if (looping) { source.loopStart = sample.edits.reverse ? sample.sourceDuration - sample.end : sample.start; source.loopEnd = sample.edits.reverse ? sample.sourceDuration - sample.start : sample.end; source.start(now, offset); } else source.start(now, offset, remaining);
    if (opts.hold !== undefined && (looping || opts.hold < real)) { const off = now + Math.max(.01, opts.hold), release = Math.max(.004, params?.release ?? 0); out.gain.setValueAtTime(1, off); out.gain.linearRampToValueAtTime(0, off + release); source.stop(off + release); }
    return { source, out, position, regionDuration };
  }
  private async playSamplerSample(sample: SamplerSample, resumeAt = 0, forceLoop?: boolean): Promise<void> {
    this.stopSamplerNode(); const { context, input } = await this.audio.createProductionOutput(); const looping = forceLoop ?? sample.playbackMode === "loop";
    const { source, position, regionDuration } = await this.startSampleVoice(sample, context, input, resumeAt, looping);
    this.samplerSource = source; this.samplerStartedAt = performance.now(); this.samplerStartPosition = position; this.state = { ...this.state, samplerPlayback: { sampleId: sample.id, regionStart: sample.start, playing: true, paused: false, position } }; this.emit("Sampler playing");
    source.onended = () => { if (this.samplerSource !== source || looping) return; this.samplerSource = null; this.state = { ...this.state, samplerPlayback: null }; this.emit("Sampler playback finished"); };
    const tick = () => { if (this.samplerSource !== source || !this.state.samplerPlayback?.playing) return; const elapsed = (performance.now() - this.samplerStartedAt) / 1000; const next = looping ? (this.samplerStartPosition + elapsed) % regionDuration : Math.min(regionDuration, this.samplerStartPosition + elapsed); this.state = { ...this.state, samplerPlayback: { ...this.state.samplerPlayback, position: next } }; this.emit(); this.samplerRaf = requestAnimationFrame(tick); }; this.samplerRaf = requestAnimationFrame(tick);
  }
  async resumeSampler(): Promise<void> { const playback = this.state.samplerPlayback; const sample = this.samplerForPlayback(playback); if (playback?.paused && sample) await this.playSamplerSample(sample, playback.position); }

  /**
   * Pads are polyphonic (one voice per pad) so they can be layered over a live mix.
   * One-shot retriggers; toggle and loop stop on the next press; gate plays while held.
   */
  /** Muted pads are silent; when any loaded pad is soloed only soloed pads sound. */
  private padAudible(index: number): boolean {
    const pads = this.state.project.sampler.pads; const pad = pads[index]; if (!pad?.sample || pad.params.muted) return false;
    return pad.params.solo || !pads.some((p) => p.sample && p.params.solo);
  }
  /**
   * One-shot retriggers; toggle and loop stop on the next press; gate plays while held (then releases).
   * `preview` plays the pad even when muted or outside the solo set.
   */
  async triggerSamplerPad(index: number, action: "down" | "up" = "down", preview = false, velocity = 127): Promise<void> {
    const pad = this.state.project.sampler.pads[index]; const sample = pad?.sample;
    if (action === "up") { this.padsHeld.delete(index); if (sample?.playbackMode === "gate") this.stopPad(index); return; }
    if (!pad || !sample || (!preview && !this.padAudible(index))) return;
    this.padsHeld.add(index);
    if ((sample.playbackMode === "toggle" || sample.playbackMode === "loop") && this.padVoices.has(index)) { this.stopPad(index); return; }
    const params = pad.params;
    const output = await this.padOutput(); const voice = await this.startSampleVoice(sample, output.context, output.input, 0, sample.playbackMode === "loop", params, { velocity });
    // A gate pad released while its audio was still loading must not keep playing.
    if (sample.playbackMode === "gate" && !this.padsHeld.has(index)) { try { voice.source.stop(); } catch { /* not started */ } return; }
    this.stopPad(index, false, .004);
    if (params.choke) for (const other of [...this.padVoices.keys()]) if (other !== index && this.state.project.sampler.pads[other]?.params.choke === params.choke) this.stopPad(other, false, .004);
    const entry: PadVoice = { source: voice.source, out: voice.out, release: params.release }; this.padVoices.set(index, entry);
    voice.source.onended = () => { if (this.padVoices.get(index) !== entry) return; this.padVoices.delete(index); this.emitPads(); };
    this.emitPads(`Pad ${padLabel(index)} playing`);
  }
  /** Stops a pad with its release (at least a 4 ms fade so stops never click). */
  stopPad(index: number, notify = true, fade?: number): void {
    const voice = this.padVoices.get(index); if (!voice) return; this.padVoices.delete(index);
    this.fadeVoice(voice, Math.max(.004, fade ?? voice.release));
    if (notify) this.emitPads();
  }
  private fadeVoice(voice: PadVoice, time: number, at?: number): void {
    const now = Math.max(voice.out.context.currentTime, at ?? 0); const g = voice.out.gain;
    try { g.cancelScheduledValues(now); g.setValueAtTime(at === undefined ? g.value : 1, now); g.linearRampToValueAtTime(0, now + time); } catch { /* context closed */ }
    try { voice.source.stop(now + time); } catch { /* already stopped */ }
  }
  stopAllPads(): void { if (!this.padVoices.size) return; for (const index of [...this.padVoices.keys()]) this.stopPad(index, false); this.emitPads("All pads stopped"); }
  setPadVolume(value: number): void {
    const padVolume = Math.max(0, Math.min(1.5, value)); this.state = { ...this.state, padVolume }; if (this.padBus) this.padBus.gain.value = padVolume; this.emit();
    try { localStorage.setItem(PAD_VOLUME, String(padVolume)); } catch { /* storage unavailable */ }
  }
  private emitPads(message?: string): void { this.state = { ...this.state, padsPlaying: [...this.padVoices.keys()].sort((a, b) => a - b) }; this.emit(message); }
  /** One shared bus for every pad (carries the pad volume); rebuilt when the audio device restarts. */
  private async padOutput(): Promise<{ context: BaseAudioContext; input: GainNode }> {
    if (this.padBus && this.padBus.context.state !== "closed") await this.audio.start(); else this.padBus = (await this.audio.createProductionOutput()).input;
    this.padBus.gain.value = this.state.padVolume; return { context: this.padBus.context, input: this.padBus };
  }
  // ───────────── Phase 3: MIDI notes, chromatic mode, pattern recording ─────────────

  /** Note a pad sends: its mapped note (SLICES) or root + pad position in the bank (CHROMATIC). */
  padNote(index: number): number {
    const sampler = this.state.project.sampler;
    return sampler.mode === "chromatic" ? Math.min(127, sampler.chromatic.rootNote + index % PADS_PER_BANK) : sampler.pads[index]?.midiNote ?? -1;
  }
  padDown(index: number, velocity = 127): void { this.samplerNoteOn(this.padNote(index), velocity); }
  padUp(index: number): void { this.samplerNoteOff(this.padNote(index)); }
  /** Every input (pads, keyboard, MIDI devices, live bar) plays the Sampler through here, so recording sees it all. */
  samplerNoteOn(note: number, velocity = 127): void {
    if (note < 0 || note > 127) return; const sampler = this.state.project.sampler; this.recordNoteOn(note, velocity);
    const fail = (error: unknown) => this.emit(`Sampler: ${error instanceof Error ? error.message : String(error)}`);
    if (sampler.mode === "chromatic") { this.notesHeld.add(note); void this.playChromatic(note, velocity).catch(fail); return; }
    const pad = sampler.pads.find((p) => p.midiNote === note); if (pad) void this.triggerSamplerPad(pad.index, "down", false, velocity).catch(fail);
  }
  samplerNoteOff(note: number): void {
    if (note < 0 || note > 127) return; const sampler = this.state.project.sampler; this.recordNoteOff(note);
    if (sampler.mode === "chromatic") { this.notesHeld.delete(note); this.releaseNote(note); return; }
    const pad = sampler.pads.find((p) => p.midiNote === note); if (pad) void this.triggerSamplerPad(pad.index, "up");
  }
  /** MIDI keyboards and drum controllers without a DJ mapping play the Sampler. */
  handleSamplerMidi(message: Pick<MidiMessage, "type" | "data1" | "data2">): void {
    if (message.type === "noteon" && message.data2 > 0) this.samplerNoteOn(message.data1, message.data2);
    else if (message.type === "noteoff" || message.type === "noteon") this.samplerNoteOff(message.data1);
  }
  private async playChromatic(note: number, velocity: number): Promise<void> {
    const chromatic = this.state.project.sampler.chromatic; const sample = chromatic.sample; if (!sample) throw new Error("Choose a sample for CHROMATIC mode");
    const params = { ...chromatic.params, pitch: chromatic.params.pitch + note - chromatic.rootNote };
    const output = await this.padOutput(); const voice = await this.startSampleVoice(sample, output.context, output.input, 0, sample.playbackMode === "loop", params, { velocity });
    const entry: PadVoice = { source: voice.source, out: voice.out, release: params.release };
    this.releaseNote(note, false, .004); this.noteVoices.set(note, entry);
    voice.source.onended = () => { if (this.noteVoices.get(note) !== entry) return; this.noteVoices.delete(note); this.emitNotes(); };
    if (!this.notesHeld.has(note)) this.releaseNote(note, false); // released while loading: still sound, then release
    this.emitNotes();
  }
  releaseNote(note: number, notify = true, fade?: number): void { const voice = this.noteVoices.get(note); if (!voice) return; this.noteVoices.delete(note); this.fadeVoice(voice, Math.max(.004, fade ?? voice.release)); if (notify) this.emitNotes(); }
  private emitNotes(): void { this.state = { ...this.state, notesPlaying: [...this.noteVoices.keys()].sort((a, b) => a - b) }; this.emit(); }
  stopAllNotes(): void { for (const note of [...this.noteVoices.keys()]) this.releaseNote(note, false, .004); this.notesHeld.clear(); this.emitNotes(); }

  /** Pads follow `note` chromatically from A1 (manual remaps are replaced). */
  setBaseNote(note: number): void {
    const project = clone(this.state.project); const sampler = project.sampler; sampler.baseNote = Math.max(0, Math.min(127 - sampler.pads.length + 1, Math.round(note)));
    sampler.pads.forEach((pad, i) => { pad.midiNote = sampler.baseNote + i; }); this.commit(project, `Pads mapped from ${midiName(sampler.baseNote)} (pad A1)`);
  }
  /** Remaps one pad; a pad already on that note swaps to this pad's old note so notes stay unique. */
  setPadNote(index: number, note: number): void {
    const project = clone(this.state.project); const pads = project.sampler.pads; const pad = pads[index]; if (!pad) return; const target = Math.max(0, Math.min(127, Math.round(note)));
    const other = pads.find((p) => p.midiNote === target && p.index !== index); if (other) other.midiNote = pad.midiNote; pad.midiNote = target;
    this.commit(project, `Pad ${padLabel(index)} → ${midiName(target)}${other ? ` (swapped with ${padLabel(other.index)})` : ""}`);
  }
  setSamplerMode(mode: SamplerMode): void {
    if (this.state.project.sampler.mode === mode) return; this.stopAllPads(); this.stopAllNotes();
    const project = clone(this.state.project); project.sampler.mode = mode; this.commit(project, mode === "chromatic" ? "CHROMATIC: one sample across the keyboard" : "SLICES: pads play their own notes");
  }
  /** Uses the editor sample or a pad's sample in CHROMATIC mode and detects its root note. */
  async setChromaticSample(from: "editor" | number): Promise<void> {
    const sampler = this.state.project.sampler; const source = from === "editor" ? sampler.editor : sampler.pads[from]?.sample;
    if (!source) throw new Error(from === "editor" ? "Load a sample into the editor first" : `Pad ${padLabel(from)} is empty`);
    await this.setChromaticFromSample(source);
  }
  /** Makes `source` the CHROMATIC instrument and detects its root note. */
  async setChromaticFromSample(source: SamplerSample): Promise<void> {
    const { data, rate } = await this.monoOf(source.sourceRef); const detected = detectRootNote(data, rate, source.start, source.end);
    const project = clone(this.state.project); const chromatic = project.sampler.chromatic;
    chromatic.sample = { ...source, id: makeId("sample"), edits: { ...source.edits }, peaks: pool(source.peaks, 400) }; chromatic.detectedRoot = detected?.note ?? null; chromatic.rootNote = detected?.note ?? 60; project.sampler.mode = "chromatic";
    this.stopAllPads(); this.stopAllNotes();
    this.commit(project, `${source.name} is now CHROMATIC · ${detected ? `Detected Root: ${midiName(detected.note)} (${detected.frequency.toFixed(1)} Hz)` : "no clear pitch — root set to C4, adjust it manually"}`);
  }
  setChromaticRoot(note: number): void { const project = clone(this.state.project); project.sampler.chromatic.rootNote = Math.max(0, Math.min(127, Math.round(note))); this.commit(project, `Root note ${midiName(project.sampler.chromatic.rootNote)}`); this.refreshArrangement(); }
  updateChromaticParams(patch: Partial<PadParams>): void { const project = clone(this.state.project); Object.assign(project.sampler.chromatic.params, patch); clampPad(project.sampler.chromatic.params); this.commit(project, "Chromatic instrument updated"); this.refreshArrangement(); }

  // Pattern recording: a 1-bar count-in (optional), then pad / key / MIDI performance is captured as notes in beats.
  get isRecordingPattern(): boolean { return !!this.rec; }
  async startPatternRecording(options: { countIn?: boolean; click?: boolean } = {}): Promise<void> {
    if (this.rec) return; const { countIn = true, click = true } = options; const p = this.state.project; const beatMs = 60_000 / p.bpm; const countBeats = countIn ? p.timeSignature[0] : 0;
    const output = click ? await this.padOutput() : null;
    const rec = { startAt: performance.now() + countBeats * beatMs, beatMs, mode: p.sampler.mode, notes: [] as MidiNote[], held: new Map<number, { start: number; velocity: number }>(), nextClick: -countBeats, click, timer: 0 as unknown as ReturnType<typeof setInterval> };
    // Metronome: clicks are scheduled ~120 ms ahead on the audio clock; the UI beat counter follows.
    const tick = () => {
      const beat = (performance.now() - rec.startAt) / beatMs;
      if (output && rec.click) while (rec.nextClick < beat + .12 * 1000 / beatMs) { const at = output.context.currentTime + Math.max(0, (rec.startAt + rec.nextClick * beatMs - performance.now()) / 1000); this.click(output.context, output.input, at, rec.nextClick % p.timeSignature[0] === 0); rec.nextClick++; }
      const phase = beat < 0 ? "count-in" as const : "recording" as const; const shown = Math.floor(beat);
      if (this.state.patternRecording?.beat !== shown || this.state.patternRecording.phase !== phase) { this.state = { ...this.state, patternRecording: { phase, beat: shown } }; this.emit(phase === "count-in" ? `Count-in ${shown + countBeats + 1}/${countBeats}` : undefined); }
      if (beat >= 8 * p.timeSignature[0]) this.stopPatternRecording(); // 8-bar maximum
    };
    rec.timer = setInterval(tick, 25); this.rec = rec; this.state = { ...this.state, patternRecording: { phase: countBeats ? "count-in" : "recording", beat: -countBeats } }; this.emit(countBeats ? "Count-in…" : "Recording pattern…"); tick();
  }
  private click(context: BaseAudioContext, output: AudioNode, when: number, accent: boolean): void {
    const osc = context.createOscillator(); const gain = context.createGain(); osc.frequency.value = accent ? 1760 : 1100;
    gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(.25, when + .002); gain.gain.exponentialRampToValueAtTime(.0001, when + .05); osc.connect(gain).connect(output); osc.start(when); osc.stop(when + .06);
  }
  private recordNoteOn(note: number, velocity: number): void {
    const rec = this.rec; if (!rec) return; let beat = (performance.now() - rec.startAt) / rec.beatMs;
    if (beat < 0) { if (beat < -.25) return; beat = 0; } // a hit just before the downbeat counts as on it
    if (rec.held.has(note)) this.recordNoteOff(note);
    rec.held.set(note, { start: beat, velocity: Math.max(1, Math.min(127, Math.round(velocity))) });
  }
  private recordNoteOff(note: number): void {
    const rec = this.rec; const held = rec?.held.get(note); if (!rec || !held) return; rec.held.delete(note);
    const end = (performance.now() - rec.startAt) / rec.beatMs; rec.notes.push({ id: makeId("note"), pitch: note, start: Math.round(held.start * 1e4) / 1e4, duration: Math.max(1 / 32, Math.round((end - held.start) * 1e4) / 1e4), velocity: held.velocity, channel: 1 });
  }
  stopPatternRecording(): void {
    const rec = this.rec; if (!rec) return; for (const note of [...rec.held.keys()]) this.recordNoteOff(note);
    clearInterval(rec.timer); this.rec = null; this.state = { ...this.state, patternRecording: null };
    const p = this.state.project; const barBeats = p.timeSignature[0]; const notes = rec.notes.filter((n) => n.start < 8 * barBeats).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    if (!notes.length) { this.emit("Pattern recording stopped · no notes played"); return; }
    const bars = Math.max(1, Math.min(8, Math.ceil(Math.max(...notes.map((n) => n.start + Math.min(n.duration, .25))) / barBeats - 1e-6)));
    const project = clone(p); project.sampler.pattern = { notes, bars, mode: rec.mode, recordedAt: Date.now() };
    this.commit(project, `Recorded ${notes.length} note${notes.length === 1 ? "" : "s"} · ${bars} bar${bars === 1 ? "" : "s"}`);
  }
  togglePatternRecording(options?: { countIn?: boolean; click?: boolean }): Promise<void> { if (this.rec) { this.stopPatternRecording(); return Promise.resolve(); } return this.startPatternRecording(options); }
  clearPattern(): void { this.stopPattern(); const project = clone(this.state.project); project.sampler.pattern = null; this.commit(project, "Pattern cleared"); }
  setQuantize(patch: Partial<{ grid: QuantizeGrid; strength: number }>): void {
    const project = clone(this.state.project); const q = project.sampler.quantize; Object.assign(q, patch); q.strength = Math.max(0, Math.min(1, q.strength));
    this.commit(project, q.grid === "off" ? "Quantize off" : `Quantize ${q.grid === "triplet" ? "1/8 triplet" : q.grid} at ${Math.round(q.strength * 100)}%`);
  }
  /** The recorded pattern with the current quantize setting applied (the recording itself is kept as played). */
  quantizedPattern(): MidiNote[] { const sampler = this.state.project.sampler; return sampler.pattern ? quantizeToGrid(sampler.pattern.notes, QUANTIZE_BEATS[sampler.quantize.grid], sampler.quantize.strength) : []; }

  /** Plays the quantized pattern once through the Sampler. */
  async playPattern(): Promise<void> {
    const pattern = this.state.project.sampler.pattern; if (!pattern?.notes.length) throw new Error("Record a pattern first"); this.stopPattern();
    const output = await this.padOutput(); const bpm = this.state.project.bpm; await this.preloadSampler(pattern.mode);
    const start = output.context.currentTime + .05; const chokes = new Map<string, PadVoice>();
    for (const note of this.quantizedPattern()) { const voice = await this.scheduleSamplerNote(output.context, output.input, pattern.mode, note.pitch, note.velocity, start + beatsToSeconds(note.start, bpm), beatsToSeconds(note.duration, bpm), chokes); if (voice) this.patternVoices.push(voice); }
    this.state = { ...this.state, patternPlaying: true }; this.emit("Playing pattern");
    this.patternTimer = setTimeout(() => { this.patternVoices = []; this.state = { ...this.state, patternPlaying: false }; this.emit(); }, beatsToSeconds(pattern.bars * this.state.project.timeSignature[0], bpm) * 1000 + 300);
  }
  stopPattern(): void { if (this.patternTimer) clearTimeout(this.patternTimer); this.patternTimer = null; for (const voice of this.patternVoices) this.fadeVoice(voice, .004); this.patternVoices = []; if (this.state.patternPlaying) { this.state = { ...this.state, patternPlaying: false }; this.emit(); } }

  /**
   * The quantized pattern as a normal MIDI clip on a Sampler track of the pattern's mode (created when missing,
   * or `trackId` when it is such a track), at `start` or the playhead snapped to the beat. Returns the clip id.
   */
  patternToArrangement(options: { trackId?: string; start?: number } = {}): string {
    const pattern = this.state.project.sampler.pattern; if (!pattern?.notes.length) throw new Error("Record a pattern first");
    const p = clone(this.state.project); const fits = (t: ProductionTrack) => t.instrument?.type === "sampler" && (t.instrument.samplerMode ?? "slices") === pattern.mode;
    let track = options.trackId ? p.tracks.find((t) => t.id === options.trackId && fits(t)) : undefined; track ??= p.tracks.find(fits);
    if (!track) { track = instrumentTrack(pattern.mode === "chromatic" ? "Sampler Chromatic" : "Sampler Slices", "sampler"); track.instrument!.samplerMode = pattern.mode; p.tracks.push(track); }
    const beat = 60 / p.bpm; const start = Math.max(0, Math.round((options.start ?? this.state.position) / beat) * beat);
    const clip: MidiClip = { type: "midi", id: makeId("midi"), name: pattern.mode === "chromatic" ? "Chromatic Pattern" : "Sampler Pattern", start, duration: beatsToSeconds(pattern.bars * p.timeSignature[0], p.bpm), gain: 1, muted: false, notes: this.quantizedPattern().map((n) => ({ ...n, id: makeId("note") })), patternBars: pattern.bars, swing: 0 };
    track.clips.push(clip); this.commit(p, `Pattern added to ${track.name}`); this.selectClip(clip.id); return clip.id;
  }

  /** Decodes every sample the Sampler may need for `mode` so scheduled notes start on time. */
  private async preloadSampler(mode: SamplerMode): Promise<void> {
    const sampler = this.state.project.sampler; const samples = mode === "chromatic" ? [sampler.chromatic.sample] : sampler.pads.map((pad) => pad.sample);
    await Promise.all([...new Set(samples.filter((x): x is SamplerSample => !!x).map((x) => x.sourceRef))].map((ref) => this.buffer(ref).catch(() => null)));
  }
  /**
   * Schedules `note` on the Sampler at `when` (context time) for `duration` s: a pad's sample (one-shots play out,
   * gate / toggle / loop pads hold for the note) or the chromatic sample transposed from its root. Pads cut their own
   * previous hit and their choke group, as when played live.
   */
  private async scheduleSamplerNote(context: BaseAudioContext, output: AudioNode, mode: SamplerMode, note: number, velocity: number, when: number, duration: number, chokes: Map<string, PadVoice>): Promise<PadVoice | null> {
    const sampler = this.state.project.sampler; let sample: SamplerSample, params: PadParams, key: string | null = null, hold: number | undefined = duration;
    if (mode === "chromatic") { if (!sampler.chromatic.sample) return null; sample = sampler.chromatic.sample; params = { ...sampler.chromatic.params, pitch: sampler.chromatic.params.pitch + note - sampler.chromatic.rootNote }; }
    else {
      const pad = sampler.pads.find((x) => x.midiNote === note && x.sample); if (!pad?.sample || !this.padAudible(pad.index)) return null;
      sample = pad.sample; params = pad.params; key = params.choke ? `choke${params.choke}` : `pad${pad.index}`; if (sample.playbackMode === "one-shot") hold = undefined;
    }
    const voice = await this.startSampleVoice(sample, context, output, 0, sample.playbackMode === "loop", params, { when, velocity, hold });
    const entry: PadVoice = { source: voice.source, out: voice.out, release: params.release };
    if (key) { const previous = chokes.get(key); if (previous) this.fadeVoice(previous, .004, when); chokes.set(key, entry); }
    return entry;
  }
  /** Sampler-track MIDI clips → scheduled Sampler voices (live playback from `position`, or offline export when position is null). */
  private async scheduleSamplerTracks(context: BaseAudioContext, output: AudioNode | ((track: ProductionTrack) => AudioNode), tracks: ProductionTrack[], position: number | null): Promise<PadVoice[]> {
    const p = this.state.project; const voices: PadVoice[] = [];
    for (const mode of new Set(tracks.map((t) => t.instrument?.samplerMode ?? "slices"))) await this.preloadSampler(mode);
    const base = context.currentTime; // after decoding, so the first notes are not late
    for (const track of tracks) {
      const mode = track.instrument?.samplerMode ?? "slices"; const chokes = new Map<string, PadVoice>(); const events: { at: number; end: number; pitch: number; velocity: number; clipGain: number }[] = [];
      for (const clip of track.clips) {
        if (clip.type !== "midi" || clip.muted) continue; const clipEnd = clip.start + clip.duration;
        for (const note of clip.notes) { const at = clip.start + beatsToSeconds(note.start, p.bpm); const end = Math.min(clipEnd, at + beatsToSeconds(note.duration, p.bpm)); if (at >= clipEnd || (position !== null && at < position - .001)) continue; events.push({ at, end, pitch: note.pitch, velocity: note.velocity, clipGain: clip.gain }); }
      }
      events.sort((a, b) => a.at - b.at);
      const pan = context.createStereoPanner(); pan.pan.value = track.pan; pan.connect(typeof output === "function" ? output(track) : output); const gains = new Map<number, GainNode>();
      for (const e of events) {
        let gain = gains.get(e.clipGain); if (!gain) { gain = context.createGain(); gain.gain.value = track.gain * e.clipGain; gain.connect(pan); gains.set(e.clipGain, gain); }
        const when = position === null ? e.at : base + e.at - position;
        const voice = await this.scheduleSamplerNote(context, gain, mode, e.pitch, e.velocity, when, Math.max(.02, e.end - e.at), chokes); if (voice) voices.push(voice);
      }
    }
    return voices;
  }
  /** MIDI or Sampler edits reach the playing arrangement (debounced re-schedule). */
  private refreshArrangement(): void {
    if (!this.state.playing) return; if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.state.playing) { this.updatePosition(); void this.restart(); } }, 150);
  }

  // ───────────── Phase 2: transients, slicing, Auto Clean ─────────────

  private async monoOf(ref: string): Promise<{ data: Float32Array; rate: number }> {
    const cached = this.mono.get(ref); if (cached) return cached;
    const buffer = await this.buffer(ref); const mono = { data: mixToMono(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))), rate: buffer.sampleRate };
    this.mono.set(ref, mono); return mono;
  }
  private snap(ref: string, time: number): number { const mono = this.mono.get(ref); return mono ? nearestZeroCrossing(mono.data, mono.rate, time) : time; }
  /** Markers for the current slice mode over the editor region (manual keeps the user's markers). */
  private markersFor(project: ProductionProject): number[] {
    const editor = project.sampler.editor; const s = project.sampler.slicing; if (!editor) return [];
    const { start, end, sourceRef } = editor; const inside = (m: number) => m > start + .001 && m < end - .001;
    switch (s.mode) {
      case "transient": return s.sourceRef === sourceRef ? transientMarkers(s.detected, s.sensitivity, start, end) : [];
      case "beat": return beatMarkers(start, end, s.bpm ?? project.bpm, s.beats).map((m) => this.snap(sourceRef, m)).filter(inside);
      case "equal": return equalMarkers(start, end, s.equal).map((m) => this.snap(sourceRef, m)).filter(inside);
      case "manual": return s.markers.filter(inside);
    }
  }
  /** Analyses the editor source for transients (once per source) and regenerates the markers. */
  async analyseSlices(): Promise<void> {
    const editor = this.state.project.sampler.editor; if (!editor) throw new Error("Load a sample before detecting transients");
    const { data, rate } = await this.monoOf(editor.sourceRef);
    const detected = detectTransients(data, rate).map((t) => ({ time: Math.round(t.time * 1e5) / 1e5, strength: Math.round(t.strength * 1e3) / 1e3 }));
    const project = clone(this.state.project); if (project.sampler.editor?.sourceRef !== editor.sourceRef) return;
    project.sampler.slicing = { ...project.sampler.slicing, enabled: true, detected, sourceRef: editor.sourceRef };
    if (project.sampler.slicing.mode !== "manual") project.sampler.slicing.markers = this.markersFor(project);
    this.commit(project, `Detected ${detected.length} transient${detected.length === 1 ? "" : "s"} · ${project.sampler.slicing.markers.length + 1} slices`);
  }
  /** Makes sure analysis data exists for SLICE mode (transients for the current source, zero-crossing data). */
  private async refreshSlices(): Promise<void> {
    const project = this.state.project; const editor = project.sampler.editor; if (!editor) return;
    if (project.sampler.slicing.sourceRef !== editor.sourceRef) await this.analyseSlices();
    else if (!this.mono.has(editor.sourceRef)) await this.monoOf(editor.sourceRef);
  }
  setSliceSettings(patch: Partial<Pick<SliceState, "enabled" | "mode" | "sensitivity" | "beats" | "equal" | "bpm" | "autoClean">>): void {
    const project = clone(this.state.project); const slicing = project.sampler.slicing; Object.assign(slicing, patch);
    slicing.sensitivity = Math.max(0, Math.min(1, slicing.sensitivity)); slicing.equal = Math.max(2, Math.min(64, Math.round(slicing.equal))); if (slicing.bpm !== null) slicing.bpm = Math.max(20, Math.min(300, slicing.bpm));
    if (SLICE_KEYS.some((key) => key in patch) && slicing.mode !== "manual") slicing.markers = this.markersFor(project);
    this.commit(project, patch.enabled === false ? "Slice mode off" : patch.mode ? `Slice mode: ${patch.mode}` : "Slice settings updated");
    if (slicing.enabled && project.sampler.editor) void this.refreshSlices().then(() => { const latest = this.state.project.sampler.slicing; if (latest.mode !== "manual" && !latest.markers.length && (patch.mode || patch.enabled)) { const next = clone(this.state.project); next.sampler.slicing.markers = this.markersFor(next); if (next.sampler.slicing.markers.length) this.commit(next, "Slice markers generated"); } }).catch((error) => this.emit(`Transient detection failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  addSliceMarker(time: number): void {
    const project = clone(this.state.project); const editor = project.sampler.editor; if (!editor) return; const at = this.snap(editor.sourceRef, time);
    if (at <= editor.start + .001 || at >= editor.end - .001) return;
    const slicing = project.sampler.slicing; if (slicing.markers.some((m) => Math.abs(m - at) < .005)) return;
    slicing.markers = [...slicing.markers, at].sort((a, b) => a - b); this.commit(project, `Slice marker added · ${slicing.markers.length + 1} slices`);
  }
  /** Drag a marker (kept between its neighbours); `final` snaps it to a zero crossing and records one undo step. */
  moveSliceMarker(index: number, time: number, final = false): void {
    const project = clone(this.state.project); const editor = project.sampler.editor; const markers = project.sampler.slicing.markers; if (!editor || index < 0 || index >= markers.length) return;
    const low = (index > 0 ? markers[index - 1] : editor.start) + .002, high = (index < markers.length - 1 ? markers[index + 1] : editor.end) - .002;
    markers[index] = Math.max(low, Math.min(high, final ? this.snap(editor.sourceRef, time) : time));
    this.preview(project); if (final) this.endGesture("Slice marker moved");
  }
  deleteSliceMarker(index: number): void { const project = clone(this.state.project); const markers = project.sampler.slicing.markers; if (index < 0 || index >= markers.length) return; markers.splice(index, 1); this.commit(project, `Slice marker deleted · ${markers.length + 1} slices`); }
  /** Back to the generated markers for the mode (manual: none). */
  resetSliceMarkers(): void { const project = clone(this.state.project); const slicing = project.sampler.slicing; slicing.markers = slicing.mode === "manual" ? [] : this.markersFor({ ...project, sampler: { ...project.sampler, slicing: { ...slicing, mode: slicing.mode } } }); this.commit(project, "Slice markers reset"); }
  clearSliceMarkers(): void { const project = clone(this.state.project); project.sampler.slicing.markers = []; this.commit(project, "Slice markers cleared"); }
  async previewSlice(index: number): Promise<void> {
    const editor = this.state.project.sampler.editor; if (!editor) return; const region = sliceRegions(editor.start, editor.end, this.state.project.sampler.slicing.markers)[index]; if (!region) return;
    await this.playSamplerSample({ ...editor, start: region.start, end: region.end, edits: { ...editor.edits, fadeIn: 0, fadeOut: 0 } }, 0, false);
  }
  /**
   * Slice 1 → pad 1 of the current bank, continuing through the following banks (up to D16).
   * With Auto Clean each slice gets zero-crossing edges, trimmed silence and 2–3 ms anti-click fades.
   */
  async mapSlicesToPads(): Promise<number> {
    const before = this.state.project; const editor = before.sampler.editor; if (!editor) throw new Error("Load a sample before mapping slices");
    const regions = sliceRegions(editor.start, editor.end, before.sampler.slicing.markers); const first = before.sampler.bank * PADS_PER_BANK; const count = Math.min(regions.length, before.sampler.pads.length - first);
    const mono = before.sampler.slicing.autoClean ? await this.monoOf(editor.sourceRef) : null;
    const project = clone(this.state.project); const peaks = pool(editor.peaks, 400);
    for (let k = 0; k < count; k++) {
      let { start, end } = regions[k]; let fadeIn = 0, fadeOut = 0;
      if (mono) { const clean = analyseClean(mono.data, mono.rate, start, end); if (clean.end - clean.start > .005) ({ start, end, fadeIn, fadeOut } = clean); }
      const pad = project.sampler.pads[first + k];
      pad.sample = { ...editor, id: makeId("sample"), name: `${editor.name} ${k + 1}`, start, end, playbackMode: "one-shot", edits: { ...editor.edits, fadeIn, fadeOut }, peaks, createdAt: Date.now() };
      pad.params = defaultPadParams();
    }
    project.sampler.selectedPad = first;
    const skipped = regions.length - count;
    this.commit(project, `Mapped ${count} slice${count === 1 ? "" : "s"} to pads ${padLabel(first)}–${padLabel(first + count - 1)}${skipped > 0 ? ` (${skipped} did not fit)` : ""}`);
    return count;
  }
  /** Conservative clean-up of the editor region; level is analysed, never changed. */
  async autoCleanEditor(): Promise<void> {
    const editor = this.state.project.sampler.editor; if (!editor) throw new Error("Load a sample before Auto Clean");
    const { data, rate } = await this.monoOf(editor.sourceRef); const report = analyseClean(data, rate, editor.start, editor.end);
    const project = clone(this.state.project); const target = project.sampler.editor; if (!target || target.id !== editor.id) return;
    target.start = report.start; target.end = report.end; target.edits.fadeIn = Math.max(target.edits.fadeIn, report.fadeIn); target.edits.fadeOut = Math.max(target.edits.fadeOut, report.fadeOut); clampSample(target);
    if (project.sampler.slicing.markers.length) project.sampler.slicing.markers = project.sampler.slicing.mode === "manual" ? project.sampler.slicing.markers.filter((m) => m > target.start && m < target.end) : this.markersFor(project);
    this.state = { ...this.state, cleanReport: report };
    this.commit(project, `Auto Clean: trimmed ${(report.leadingSilence * 1000).toFixed(0)} ms / ${(report.trailingSilence * 1000).toFixed(0)} ms silence${report.clippedSamples ? ` · ${report.clippedSamples} clipped samples` : ""}`);
  }

  async separateClipToStems(clipId: string): Promise<void> {
    let sourceTrack: ProductionTrack | undefined; let sourceClip: AudioClip | undefined;
    for (const track of this.state.project.tracks) { const clip = track.clips.find((c): c is AudioClip => c.id === clipId && c.type === "audio"); if (clip) { sourceTrack = track; sourceClip = clip; break; } }
    if (!sourceTrack || !sourceClip) throw new Error("Select an audio clip before separating STEMS");
    if (sourceTrack.stem) throw new Error("This clip is already an individual STEM");
    const libraryTrack = this.platform.kind === "desktop" ? ({ ref: sourceClip.ref, title: sourceClip.name, artist: "", album: "", source: "local", bpm: null, key: null } satisfies TrackInfo) : null;
    if (!libraryTrack) throw new Error("Production STEM separation requires the desktop app");
    this.state = { ...this.state, stemJob: { ref: sourceClip.ref, stage: "separating", message: "Separating vocals, drums, bass and instruments locally…" } }; this.emit("STEM separation started");
    try {
      const rendered = await this.stems.prepareForRender(libraryTrack, (ref) => this.platform.readAudio(ref));
      this.state = { ...this.state, stemJob: { ref: sourceClip.ref, stage: "importing", message: "Creating four synchronized production tracks…" } }; this.emit();
      const raw = new Int16Array(rendered.pcm); const frames = Math.min(rendered.total, Math.floor(raw.length / 6));
      const original = await this.buffer(sourceClip.ref); const offline = new OfflineAudioContext(2, frames, rendered.rate); const node = offline.createBufferSource(); node.buffer = original; node.connect(offline.destination); node.start(); const resampled = await offline.startRendering();
      const originalL = resampled.getChannelData(0), originalR = resampled.getChannelData(Math.min(1, resampled.numberOfChannels - 1));
      const parts = [{ part: "vocals" as const, name: "Vocals", channels: [0, 1] }, { part: "drums" as const, name: "Drums", channels: [2, 3] }, { part: "bass" as const, name: "Bass", channels: [4, 5] }, { part: "instruments" as const, name: "Instruments", channels: [-1, -1] }];
      const created: ProductionTrack[] = [];
      for (const spec of parts) {
        const left = new Float32Array(frames), right = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          if (spec.part === "instruments") { left[i] = originalL[i] - (raw[i * 6] + raw[i * 6 + 2] + raw[i * 6 + 4]) / 32768; right[i] = originalR[i] - (raw[i * 6 + 1] + raw[i * 6 + 3] + raw[i * 6 + 5]) / 32768; }
          else { left[i] = raw[i * 6 + spec.channels[0]] / 32768; right[i] = raw[i * 6 + spec.channels[1]] / 32768; }
        }
        const ref = `production-stem://${sourceClip.ref}#${spec.part}`; const wav = encodeWav({ sampleRate: rendered.rate, left, right }); this.memoryFiles.set(ref, wav); const buffer = await this.buffer(ref);
        const stemName = `${spec.name} - ${sourceClip.name}`;
        created.push({ id: makeId("track"), name: stemName, kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "STEM cache", output: "master", stem: { sourceRef: sourceClip.ref, part: spec.part }, clips: [{ type: "audio", id: makeId("clip"), name: stemName, ref, start: sourceClip.start, offset: sourceClip.offset, duration: Math.min(sourceClip.duration, Math.max(.01, buffer.duration - sourceClip.offset)), sourceDuration: buffer.duration, gain: sourceClip.gain, muted: false, peaks: this.peaks(buffer) }] });
      }
      const project = clone(this.state.project); const at = project.tracks.findIndex((t) => t.id === sourceTrack!.id); const originalClip = project.tracks[at]?.clips.find((c) => c.id === sourceClip!.id); if (originalClip) originalClip.muted = true; project.tracks.splice(at + 1, 0, ...created); this.commit(project, "Created four synchronized STEM tracks");
      this.state = { ...this.state, stemJob: null }; this.emit("STEMS ready: independent Vocals, Drums, Bass and Instruments tracks created");
    } catch (error) { this.state = { ...this.state, stemJob: null }; this.emit(`STEM separation failed: ${error instanceof Error ? error.message : String(error)}`); throw error; }
  }
  selectClip(id: string | null): void { this.state = { ...this.state, selectedClipId: id }; this.emit(); }
  editClip(id: string, patch: Partial<ProductionClip>, message = "Clip edited"): void {
    const p = clone(this.state.project); for (const track of p.tracks) { const clip = track.clips.find((c) => c.id === id); if (!clip) continue; Object.assign(clip, patch); clip.start = Math.max(0, clip.start); clip.duration = Math.max(0.01, clip.duration); if (clip.type === "audio") { clip.offset = Math.max(0, Math.min(clip.sourceDuration - 0.01, clip.offset)); clip.duration = Math.min(clip.duration, clip.sourceDuration - clip.offset); } this.commit(p, message); return; }
  }
  /** Live clip drag (one undo step): `final` records it. */
  dragClip(id: string, start: number, final = false): void {
    const p = clone(this.state.project); const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id); if (!clip) return;
    clip.start = Math.max(0, start); this.preview(p); if (final) this.endGesture("Clip moved");
  }
  /** Abandons a live clip drag without an undo step (the drop is then recorded by another edit). */
  cancelClipDrag(): void { const base = this.gestureBase; this.gestureBase = null; if (base) { this.state = { ...this.state, project: base }; this.emit(); } }
  /** Moves a track to `toIndex` (position after removal) in the track list. */
  moveTrack(trackId: string, toIndex: number): void {
    const p = clone(this.state.project); const from = p.tracks.findIndex((t) => t.id === trackId); if (from < 0) return;
    const index = Math.max(0, Math.min(p.tracks.length - 1, Math.round(toIndex))); if (index === from) return;
    const [track] = p.tracks.splice(from, 1); p.tracks.splice(index, 0, track); this.commit(p, `${track.name} moved to position ${index + 1}`);
  }
  /**
   * Live trim of either clip edge to `edge` (seconds), one undo step when `final`. Audio clips keep their audio in
   * place (the offset moves with a left trim); MIDI clips only trim on the right.
   */
  trimClip(id: string, side: "left" | "right", edge: number, final = false): void {
    const original = (this.gestureBase ?? this.state.project).tracks.flatMap((t) => t.clips).find((c) => c.id === id); const p = clone(this.state.project); const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    if (!original || !clip) return;
    if (side === "right") { let duration = Math.max(.01, edge - original.start); if (original.type === "audio") duration = Math.min(duration, original.sourceDuration - original.offset); clip.duration = duration; }
    else if (original.type === "audio" && clip.type === "audio") {
      const start = Math.max(Math.max(0, original.start - original.offset), Math.min(original.start + original.duration - .01, edge)); const shift = start - original.start;
      clip.start = start; clip.duration = original.duration - shift; clip.offset = original.offset + shift; if (shift > 0 && clip.fadeIn) clip.fadeIn = Math.max(0, clip.fadeIn - shift);
    } else return;
    this.preview(p); if (final) this.endGesture("Clip trimmed");
  }
  /** A whole file as a Sampler sample. */
  private async sampleFromFile(ref: string, title: string): Promise<SamplerSample> {
    const buffer = await this.buffer(ref); return { id: makeId("sample"), sourceRef: ref, name: title, sourceDuration: buffer.duration, start: 0, end: buffer.duration, gain: 1, playbackMode: "one-shot", edits: { reverse: false, normalize: false, fadeIn: 0, fadeOut: 0 }, peaks: this.peaks(buffer, 1600), createdAt: Date.now() };
  }
  /**
   * Drop on a Sampler track: SLICES puts the sample on a pad (re-using a pad that already holds it, else the next
   * empty pad) and writes that pad's note at `start`; CHROMATIC makes it the chromatic instrument and writes its
   * root note. The note goes into the MIDI clip under `start`, or a new clip.
   */
  async addToSamplerTrack(trackId: string, item: { sample?: SamplerSample; ref?: string; title?: string }, start: number): Promise<void> {
    const track = this.state.project.tracks.find((t) => t.id === trackId); if (!track || track.instrument?.type !== "sampler") throw new Error("Not a Sampler track");
    const sample = item.sample ? { ...item.sample, id: makeId("sample") } : await this.sampleFromFile(item.ref!, item.title ?? "Sample"); const mode = track.instrument.samplerMode ?? "slices";
    let note: number; let where: string;
    if (mode === "chromatic") { await this.setChromaticFromSample(sample); note = this.state.project.sampler.chromatic.rootNote; where = `the chromatic instrument (root ${midiName(note)})`; }
    else {
      const pads = this.state.project.sampler.pads; let pad = pads.findIndex((x) => x.sample && x.sample.sourceRef === sample.sourceRef && Math.abs(x.sample.start - sample.start) < 1e-3 && Math.abs(x.sample.end - sample.end) < 1e-3);
      if (pad < 0) { const free = this.nextEmptyPad(); if (free === null) throw new Error("All 64 pads are in use — clear a pad first"); const project = clone(this.state.project); project.sampler.pads[free].sample = sample; project.sampler.pads[free].params = defaultPadParams(); this.commit(project, `${sample.name} assigned to pad ${padLabel(free)}`); pad = free; }
      note = this.state.project.sampler.pads[pad].midiNote; where = `pad ${padLabel(pad)}`;
    }
    const p = clone(this.state.project); const target = p.tracks.find((t) => t.id === trackId)!; const bpm = p.bpm; const at = Math.max(0, start);
    const beats = Math.max(.25, Math.round(secondsToBeats(sample.end - sample.start, bpm) * 4) / 4);
    let clip = target.clips.find((c): c is MidiClip => c.type === "midi" && at >= c.start - 1e-6 && at < c.start + c.duration);
    if (clip) clip.notes.push({ id: makeId("note"), pitch: note, start: Math.round(secondsToBeats(at - clip.start, bpm) * 1e4) / 1e4, duration: beats, velocity: 110, channel: 1 });
    else { const bars = Math.max(1, Math.min(8, Math.ceil(beats / p.timeSignature[0]))); clip = { type: "midi", id: makeId("midi"), name: sample.name, start: at, duration: beatsToSeconds(bars * p.timeSignature[0], bpm), gain: 1, muted: false, notes: [{ id: makeId("note"), pitch: note, start: 0, duration: beats, velocity: 110, channel: 1 }], patternBars: bars, swing: 0 }; target.clips.push(clip); }
    this.commit(p, `${sample.name} on ${where} · note ${midiName(note)} on ${target.name}`); this.selectClip(clip.id); this.refreshArrangement();
  }
  /** Audio clips go on audio tracks, MIDI clips on instrument tracks. */
  canHoldClip(track: ProductionTrack, clip: ProductionClip): boolean { return clip.type === "audio" ? track.kind === "audio" : track.kind === "instrument"; }
  /**
   * Moves (or copies) a clip to another track, optionally at a new start. A Sampler pattern dropped on a track of
   * the other kind is refused rather than silently changing what it plays.
   */
  moveClipToTrack(clipId: string, trackId: string, options: { start?: number; copy?: boolean } = {}): string | null {
    const p = clone(this.state.project); const from = p.tracks.find((t) => t.clips.some((c) => c.id === clipId)); const target = p.tracks.find((t) => t.id === trackId); const clip = from?.clips.find((c) => c.id === clipId);
    if (!from || !target || !clip) return null;
    if (!this.canHoldClip(target, clip)) throw new Error(clip.type === "audio" ? `${target.name} is an instrument track — drop audio clips on an audio track` : `${target.name} is an audio track — drop MIDI clips on an instrument track`);
    const placed = { ...clone(clip), id: options.copy ? makeId(clip.type === "audio" ? "clip" : "midi") : clip.id, start: Math.max(0, options.start ?? clip.start) } as ProductionClip;
    if (!options.copy) from.clips = from.clips.filter((c) => c.id !== clipId);
    target.clips.push(placed); this.commit(p, `${clip.name} ${options.copy ? "copied" : "moved"} to ${target.name}`); this.selectClip(placed.id); return placed.id;
  }
  /** Moves (or copies) a clip to a new track of the same kind, right under its current track. */
  clipToNewTrack(clipId: string, options: { start?: number; copy?: boolean } = {}): string | null {
    const p = clone(this.state.project); const index = p.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId)); const from = p.tracks[index]; const clip = from?.clips.find((c) => c.id === clipId); if (!from || !clip) return null;
    const track: ProductionTrack = clip.type === "audio"
      ? { id: makeId("track"), name: clip.name, kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "None", output: "master", clips: [] }
      : { ...clone(from), id: makeId("track"), name: `${from.name} ${p.tracks.filter((t) => t.instrument?.type === from.instrument?.type).length + 1}`, muted: false, solo: false, armed: false, stem: undefined, clips: [] };
    const placed = { ...clone(clip), id: options.copy ? makeId(clip.type === "audio" ? "clip" : "midi") : clip.id, start: Math.max(0, options.start ?? clip.start) } as ProductionClip;
    if (!options.copy) from.clips = from.clips.filter((c) => c.id !== clipId);
    track.clips.push(placed); p.tracks.splice(index + 1, 0, track); this.commit(p, `${clip.name} ${options.copy ? "copied" : "moved"} to new track`); this.selectClip(placed.id); return placed.id;
  }

  /** The audio clip's region as a Sampler sample (whole-source overview for the waveform; reversed clips stay reversed). */
  private async clipAsSample(clipId: string): Promise<SamplerSample> {
    const clip = this.state.project.tracks.flatMap((t) => t.clips).find((c): c is AudioClip => c.id === clipId && c.type === "audio"); if (!clip) throw new Error("Choose an audio clip");
    const buffer = await this.buffer(clip.ref); const end = clip.reverse ? clip.sourceDuration - clip.offset : clip.offset + clip.duration; const start = clip.reverse ? end - clip.duration : clip.offset;
    return { id: makeId("sample"), sourceRef: clip.ref, name: clip.name, sourceDuration: buffer.duration, start: Math.max(0, start), end: Math.min(buffer.duration, end), gain: Math.min(4, clip.gain), playbackMode: "one-shot", edits: { reverse: !!clip.reverse, normalize: false, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 }, peaks: this.peaks(buffer, 1600), createdAt: Date.now() };
  }
  /** First empty pad from the current bank onwards (then from A1), or null when all 64 are used. */
  nextEmptyPad(): number | null {
    const sampler = this.state.project.sampler; const n = sampler.pads.length; const first = sampler.bank * PADS_PER_BANK;
    for (let k = 0; k < n; k++) { const index = (first + k) % n; if (!sampler.pads[index].sample) return index; } return null;
  }
  /**
   * Saves an audio clip as a Sampler sample: always to the project's saved samples; `pad` also assigns it
   * ("next" = next empty pad, or a pad index); `open` loads it into the Sampler editor.
   */
  async saveClipAsSample(clipId: string, options: { pad?: number | "next"; open?: boolean } = {}): Promise<{ sample: SamplerSample; pad: number | null }> {
    const sample = await this.clipAsSample(clipId); const project = clone(this.state.project); const sampler = project.sampler;
    let pad: number | null = null;
    if (options.pad !== undefined) { pad = options.pad === "next" ? this.nextEmptyPad() : options.pad; if (pad === null) throw new Error("All 64 pads are in use — clear a pad first"); sampler.pads[pad].sample = { ...sample, id: makeId("sample") }; sampler.pads[pad].params = defaultPadParams(); sampler.selectedPad = pad; sampler.bank = Math.floor(pad / PADS_PER_BANK); }
    sampler.savedSamples.push(sample);
    if (options.open) { sampler.editor = { ...sample, id: makeId("sample") }; sampler.slicing = { ...sampler.slicing, detected: [], markers: [], sourceRef: null }; this.stopSampler(); }
    this.commit(project, `${sample.name} saved as a sample${pad !== null ? ` on pad ${padLabel(pad)}` : ""}${options.open ? " and opened in the Sampler" : ""}`);
    return { sample, pad };
  }

  deleteClip(id: string): void { const p = clone(this.state.project); for (const t of p.tracks) t.clips = t.clips.filter((c) => c.id !== id); this.state = { ...this.state, selectedClipId: null }; this.commit(p, "Clip deleted"); }
  duplicateClip(id: string): void { const p = clone(this.state.project); for (const t of p.tracks) { const c = t.clips.find((x) => x.id === id); if (c) { t.clips.push({ ...c, id: makeId("clip"), start: c.start + c.duration, name: `${c.name} copy` }); this.commit(p, "Clip duplicated"); return; } } }
  splitClip(id: string, at: number): void { const p = clone(this.state.project); for (const t of p.tracks) { const i = t.clips.findIndex((x) => x.id === id); const c = t.clips[i]; if (!c || c.type !== "audio") continue; const local = at - c.start; if (local <= .05 || local >= c.duration - .05) return; t.clips.splice(i, 1, { ...c, duration: local, fadeOut: undefined }, { ...c, id: makeId("clip"), start: at, offset: c.offset + local, duration: c.duration - local, fadeIn: undefined }); this.commit(p, "Clip split"); return; } }

  createMidiClip(trackId: string, start: number, bars = 1): string | null { const p = clone(this.state.project); const track = p.tracks.find((t) => t.id === trackId && t.kind === "instrument"); if (!track) return null; const clip: MidiClip = { type: "midi", id: makeId("midi"), name: track.instrument?.type === "drums" ? "Drum Pattern" : "MIDI Clip", start: Math.max(0, start), duration: beatsToSeconds(bars * p.timeSignature[0], p.bpm), gain: 1, muted: false, notes: [], patternBars: bars, swing: 0 }; track.clips.push(clip); this.commit(p, "MIDI clip created"); this.selectClip(clip.id); return clip.id; }
  addMidiNote(clipId: string, note: Omit<MidiNote, "id">): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.notes.push({ ...note, id: makeId("note"), pitch: Math.max(0, Math.min(127, note.pitch)), velocity: Math.max(1, Math.min(127, note.velocity)), start: Math.max(0, note.start), duration: Math.max(.03, note.duration) }); this.commit(p, "MIDI note added"); this.refreshArrangement(); }
  editMidiNote(clipId: string, noteId: string, patch: Partial<MidiNote>): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); const note = clip?.notes.find((n) => n.id === noteId); if (!note) return; Object.assign(note, patch); note.pitch = Math.max(0, Math.min(127, note.pitch)); note.start = Math.max(0, note.start); note.duration = Math.max(.03, note.duration); note.velocity = Math.max(1, Math.min(127, note.velocity)); this.commit(p, "MIDI note edited"); this.refreshArrangement(); }
  deleteMidiNote(clipId: string, noteId: string): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.notes = clip.notes.filter((n) => n.id !== noteId); this.commit(p, "MIDI note deleted"); this.refreshArrangement(); }
  duplicateMidiNote(clipId: string, noteId: string): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); const note = clip?.notes.find((n) => n.id === noteId); if (!clip || !note) return; clip.notes.push({ ...note, id: makeId("note"), start: note.start + note.duration }); this.commit(p, "MIDI note duplicated"); this.refreshArrangement(); }
  quantizeMidi(clipId: string, division: number): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.notes = quantizeNotes(clip.notes, division); this.commit(p, `Quantized to 1/${division}`); this.refreshArrangement(); }
  humanizeMidi(clipId: string): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.notes = humanizeNotes(clip.notes); this.commit(p, "MIDI humanized"); this.refreshArrangement(); }
  transposeMidi(clipId: string, semitones: number): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.notes.forEach((n) => n.pitch = Math.max(0, Math.min(127, n.pitch + semitones))); this.commit(p, `Transposed ${semitones > 0 ? "+" : ""}${semitones}`); this.refreshArrangement(); }
  setMidiPattern(clipId: string, bars: number, swing: number): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; clip.patternBars = Math.max(1, Math.min(8, bars)); clip.swing = Math.max(0, Math.min(.75, swing)); clip.duration = beatsToSeconds(clip.patternBars * p.timeSignature[0], p.bpm); clip.notes = clip.notes.filter((n) => n.start < clip.patternBars * p.timeSignature[0]); this.commit(p, "Pattern settings updated"); this.refreshArrangement(); }
  toggleStep(clipId: string, pitch: number, step: number, velocity = 100): void { const p = clone(this.state.project); const clip = this.findMidiClip(p, clipId); if (!clip) return; const start = step * .25; const existing = clip.notes.find((n) => n.pitch === pitch && Math.abs(n.start - start) < .01); if (existing) clip.notes = clip.notes.filter((n) => n.id !== existing.id); else clip.notes.push({ id: makeId("note"), pitch, start, duration: .2, velocity, channel: 10 }); this.commit(p, existing ? "Step removed" : "Step added"); this.refreshArrangement(); }
  private findMidiClip(project: ProductionProject, id: string): MidiClip | null { for (const track of project.tracks) { const clip = track.clips.find((c) => c.id === id); if (clip?.type === "midi") return clip; } return null; }

  seek(seconds: number): void { const end = this.duration(); this.state = { ...this.state, position: Math.max(0, Math.min(end, seconds)) }; this.emit(); if (this.state.playing) void this.restart(); }
  duration(): number { return Math.max(16, ...this.state.project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)), this.state.project.loop.end); }
  /**
   * Starts the arrangement. Vocal recording passes options: `metronome` forces the click, `backing: false` plays
   * only the click, `exclude` silences the track being recorded, `noLoop` ignores the loop region. They last until
   * the next pause/stop (re-schedules after edits keep them).
   */
  async play(options: PlayOptions = {}): Promise<void> { if (this.state.playing) return; this.playOptions = options; await this.schedule(this.state.position); }
  pause(): void { if (!this.state.playing) return; this.updatePosition(); this.stopNodes(); this.playOptions = {}; this.state = { ...this.state, playing: false }; cancelAnimationFrame(this.raf); this.emit("Paused"); }
  stop(): void { this.stopNodes(); this.playOptions = {}; cancelAnimationFrame(this.raf); this.state = { ...this.state, playing: false, position: 0 }; this.emit("Stopped"); }
  /** Audio-clock origin of the current playback: arrangement `position` sounds at context time `contextTime`. */
  getPlayClock(): { contextTime: number; position: number; context: BaseAudioContext } | null { return this.state.playing ? this.playClock : null; }
  private async restart(): Promise<void> { const position = this.state.position; this.stopNodes(); this.state = { ...this.state, playing: false }; await this.schedule(position); }
  private analyser(context: BaseAudioContext, node: AudioNode): AnalyserNode { const a = context.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0; node.connect(a); return a; }
  private disconnectMeters(): void { try { this.masterBus?.disconnect(); } catch { /* already disconnected */ } this.masterBus = null; this.masterMeter = null; this.trackMeters.clear(); }
  private meterBuffer = new Float32Array(1024);
  private peak(analyser: AnalyserNode | null | undefined): number { if (!analyser || !this.state.playing) return 0; analyser.getFloatTimeDomainData(this.meterBuffer); let peak = 0; for (const v of this.meterBuffer) { const a = v < 0 ? -v : v; if (a > peak) peak = a; } return peak; }
  /** Live arrangement peak levels (0–1+), per track and for the production master; 0 when stopped or not playing (muted / outside solo). */
  levels(): { master: number; tracks: Record<string, number> } { const tracks: Record<string, number> = {}; for (const [id, analyser] of this.trackMeters) tracks[id] = this.peak(analyser); return { master: this.peak(this.masterMeter), tracks }; }
  private stopNodes(): void { for (const item of this.scheduled) try { item.source.stop(); } catch { /* already stopped */ } this.scheduled = []; }
  private updatePosition(): void { if (!this.state.playing) return; this.state = { ...this.state, position: this.startedPosition + (performance.now() - this.startedAt) / 1000 }; }
  private tick = (): void => {
    if (!this.state.playing) return; this.updatePosition(); const p = this.state.project;
    if (p.loop.enabled && !this.playOptions.noLoop && this.state.position >= p.loop.end) { this.state = { ...this.state, position: p.loop.start }; void this.restart(); return; }
    if (this.state.position >= this.duration()) { this.stop(); return; }
    this.emit(); this.raf = requestAnimationFrame(this.tick);
  };
  private async schedule(position: number): Promise<void> {
    const { context, input: output } = await this.audio.createProductionOutput(); const p = this.state.project; const anySolo = p.tracks.some((t) => t.solo);
    // Arrangement metering: every track sums into its own bus (post fader/pan), all buses into a production master.
    this.disconnectMeters(); const input = context.createGain(); input.connect(output); this.masterBus = input; this.masterMeter = this.analyser(context, input);
    const options = this.playOptions; const backing = options.backing !== false; this.playClock = { contextTime: context.currentTime, position, context };
    const buses = new Map<string, GainNode>(); const busFor = (track: ProductionTrack): GainNode => { let bus = buses.get(track.id); if (!bus) { bus = context.createGain(); bus.connect(input); this.trackMeters.set(track.id, this.analyser(context, bus)); buses.set(track.id, bus); } return bus; };
    const included = (track: ProductionTrack) => backing && track.id !== options.exclude && (!options.only || options.only.includes(track.id));
    const playable = (track: ProductionTrack, clip: ProductionClip) => included(track) && !clip.muted && !track.muted && (!anySolo || track.solo) && clip.start + clip.duration > position;
    const jobs = p.tracks.flatMap((track) => track.clips.filter((clip): clip is AudioClip => clip.type === "audio" && playable(track, clip)).map(async (clip) => {
      const source = context.createBufferSource(); source.buffer = await this.clipBuffer(clip);
      if (clip.ref.startsWith("production-vocal-render://")) { const d = source.buffer.getChannelData(0); let peak = 0, sum = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); peak = Math.max(peak, v); sum += v * v; } console.info("[vocal-schedule]", clip.ref, { length: d.length, peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(4) }); }
      const gain = context.createGain(); const pan = context.createStereoPanner(); pan.pan.value = track.pan;
      source.connect(gain).connect(pan).connect(busFor(track)); const relative = Math.max(0, position - clip.start); const when = context.currentTime + Math.max(0, clip.start - position);
      this.applyClipFades(gain.gain, track.gain * clip.gain, when, relative, clip);
      source.start(when, clip.offset + relative, Math.max(.001, clip.duration - relative)); this.scheduled.push({ source, gain, pan });
    }));
    await Promise.all(jobs);
    for (const track of p.tracks) for (const clip of track.clips) {
      if (clip.type !== "midi" || !track.instrument || track.instrument.type === "sampler" || !playable(track, clip)) continue;
      const clipEnd = clip.start + clip.duration;
      for (const note of clip.notes) {
        const swingBeat = track.instrument.type === "drums" && Math.round(note.start * 4) % 2 === 1 ? clip.swing * .125 : 0; const noteStart = clip.start + beatsToSeconds(note.start + swingBeat, p.bpm); const noteEnd = Math.min(clipEnd, noteStart + beatsToSeconds(note.duration, p.bpm));
        if (noteEnd <= position) continue;
        const when = context.currentTime + Math.max(0, noteStart - position); const duration = Math.max(.02, noteEnd - Math.max(position, noteStart));
        this.scheduleInstrument(context, busFor(track), track.instrument, note.pitch, note.velocity, when, duration, track.gain * clip.gain, track.pan, true);
      }
    }
    const samplerTracks = p.tracks.filter((t) => t.instrument?.type === "sampler" && included(t) && !t.muted && (!anySolo || t.solo));
    for (const voice of await this.scheduleSamplerTracks(context, busFor, samplerTracks, position)) this.scheduled.push({ source: voice.source, gain: voice.out });
    if (p.metronome || options.metronome) {
      const beatSeconds = 60 / p.bpm; const firstBeat = Math.ceil(position / beatSeconds);
      for (let beat = firstBeat; beat * beatSeconds <= this.duration(); beat++) {
        const osc = context.createOscillator(); const gain = context.createGain(); const when = context.currentTime + beat * beatSeconds - position;
        osc.frequency.value = beat % p.timeSignature[0] === 0 ? 1320 : 880; gain.gain.setValueAtTime(0.0001, when); gain.gain.exponentialRampToValueAtTime(0.18, when + .002); gain.gain.exponentialRampToValueAtTime(0.0001, when + .04);
        osc.connect(gain).connect(input); osc.start(when); osc.stop(when + .045); this.scheduled.push({ source: osc, gain });
      }
    }
    this.startedAt = performance.now(); this.startedPosition = position; this.state = { ...this.state, playing: true }; this.emit("Playing"); this.raf = requestAnimationFrame(this.tick);
  }

  private async clipBuffer(clip: AudioClip): Promise<AudioBuffer> { const buffer = await this.buffer(clip.ref); return clip.reverse ? this.reversed(clip.ref, buffer) : buffer; }
  /** Clip gain with its fades, for a clip that starts sounding at `when`, `relative` seconds into the clip. */
  private applyClipFades(param: AudioParam, level: number, when: number, relative: number, clip: AudioClip): void {
    const fadeIn = Math.min(clip.fadeIn ?? 0, clip.duration), fadeOut = Math.min(clip.fadeOut ?? 0, clip.duration), end = when + clip.duration - relative;
    const scale = Math.min(1, fadeIn > relative ? relative / fadeIn : 1, fadeOut > 0 ? (clip.duration - relative) / fadeOut : 1);
    param.setValueAtTime(level * scale, when);
    if (fadeIn > relative) param.linearRampToValueAtTime(level, when + fadeIn - relative);
    if (fadeOut > 0) { if (clip.duration - fadeOut > Math.max(relative, fadeIn)) param.setValueAtTime(level, end - fadeOut); param.linearRampToValueAtTime(0, end); }
  }

  private scheduleInstrument(context: BaseAudioContext, output: AudioNode, instrument: InstrumentSettings, pitch: number, velocity: number, when: number, duration: number, level: number, panValue: number, remember: boolean): void {
    const gain = context.createGain(); const pan = context.createStereoPanner(); gain.connect(pan).connect(output); pan.pan.value = panValue;
    if (instrument.type === "drums") {
      if (pitch === 36) {
        const osc = context.createOscillator(); osc.frequency.setValueAtTime(150, when); osc.frequency.exponentialRampToValueAtTime(42, when + Math.min(.16, duration)); gain.gain.setValueAtTime(Math.max(.001, velocity / 127 * level), when); gain.gain.exponentialRampToValueAtTime(.001, when + Math.min(.3, duration)); osc.connect(gain); osc.start(when); osc.stop(when + Math.min(.32, duration)); if (remember) this.scheduled.push({ source: osc, gain, pan });
      } else {
        const length = Math.max(.04, Math.min(pitch === 46 ? .45 : .18, duration)); const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * length), context.sampleRate); const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 12.9898 + pitch) * (1 - i / data.length);
        const source = context.createBufferSource(); source.buffer = buffer; const filter = context.createBiquadFilter(); filter.type = pitch === 38 || pitch === 39 ? "bandpass" : "highpass"; filter.frequency.value = pitch === 38 ? 1800 : 6500; source.connect(filter).connect(gain); gain.gain.setValueAtTime(Math.max(.001, velocity / 127 * level * .55), when); gain.gain.exponentialRampToValueAtTime(.001, when + length); source.start(when); source.stop(when + length); if (remember) this.scheduled.push({ source, gain, pan });
      }
      return;
    }
    const s = instrument.synth; const osc = context.createOscillator(); const filter = context.createBiquadFilter(); osc.type = s.oscillator; const targetFrequency = midiFrequency(pitch); if (s.glide > 0) { osc.frequency.setValueAtTime(midiFrequency(pitch - 2), when); osc.frequency.exponentialRampToValueAtTime(targetFrequency, when + Math.min(s.glide, duration)); } else osc.frequency.setValueAtTime(targetFrequency, when); osc.detune.value = s.detune; filter.type = "lowpass"; filter.frequency.value = Math.min(context.sampleRate / 2 - 100, s.cutoff); filter.Q.value = s.resonance;
    const peak = Math.max(.001, velocity / 127 * s.volume * level); const attackEnd = when + Math.min(s.attack, duration); const decayEnd = Math.min(when + duration, attackEnd + s.decay); const releaseAt = Math.max(decayEnd, when + duration - s.release);
    gain.gain.setValueAtTime(.0001, when); gain.gain.linearRampToValueAtTime(peak, attackEnd); gain.gain.linearRampToValueAtTime(Math.max(.0001, peak * s.sustain), decayEnd); gain.gain.setValueAtTime(Math.max(.0001, peak * s.sustain), releaseAt); gain.gain.exponentialRampToValueAtTime(.0001, when + duration);
    osc.connect(filter).connect(gain); osc.start(when); osc.stop(when + duration + .01); if (remember) this.scheduled.push({ source: osc, gain, pan });
  }

  async auditionNote(trackId: string, pitch: number, velocity = 100, duration = .35): Promise<void> {
    const track = this.state.project.tracks.find((t) => t.id === trackId); if (!track?.instrument) return; const { context, input } = await this.audio.createProductionOutput();
    if (track.instrument.type === "sampler") { const mode = track.instrument.samplerMode ?? "slices"; await this.preloadSampler(mode); const gain = context.createGain(); gain.gain.value = track.gain; gain.connect(input); await this.scheduleSamplerNote(context, gain, mode, pitch, velocity, context.currentTime, duration, new Map()); return; }
    this.scheduleInstrument(context, input, track.instrument, pitch, velocity, context.currentTime, duration, track.gain, track.pan, true); }

  toggleMidiRecording(): void { const next = !this.state.midiRecording; if (next && !this.state.project.tracks.some((t) => t.kind === "instrument" && t.armed)) throw new Error("Arm an instrument track before MIDI recording"); this.state = { ...this.state, midiRecording: next }; this.emit(next ? "MIDI recording armed" : "MIDI recording stopped"); if (next && !this.state.playing) void this.play(); }
  handleMidi(message: Pick<MidiMessage, "type" | "data1" | "data2" | "channel" | "deviceId">): void {
    if (message.type !== "noteon" && message.type !== "noteoff") return; const track = this.state.project.tracks.find((t) => t.kind === "instrument" && t.armed); if (!track) return;
    // MIDI devices already play the Sampler directly (handleSamplerMidi); only the computer keyboard auditions a Sampler track.
    if (message.type === "noteon" && (track.instrument?.type !== "sampler" || message.deviceId === "computer-keyboard")) void this.auditionNote(track.id, message.data1, message.data2);
    if (!this.state.midiRecording) return;
    let clip = track.clips.find((c): c is MidiClip => c.type === "midi" && this.state.position >= c.start && this.state.position < c.start + c.duration);
    if (!clip) { const id = this.createMidiClip(track.id, this.state.position, 4); const latest = this.state.project.tracks.find((t) => t.id === track.id); clip = latest?.clips.find((c): c is MidiClip => c.id === id && c.type === "midi"); }
    if (!clip) return; const key = `${message.deviceId}:${message.channel}:${message.data1}`;
    if (message.type === "noteon") { this.midiNotesOn.set(key, { pitch: message.data1, velocity: message.data2, channel: message.channel, startedBeat: secondsToBeats(this.state.position - clip.start, this.state.project.bpm), trackId: track.id, clipId: clip.id }); }
    else { const held = this.midiNotesOn.get(key); if (!held) return; this.midiNotesOn.delete(key); const end = secondsToBeats(this.state.position - clip.start, this.state.project.bpm); this.addMidiNote(held.clipId, { pitch: held.pitch, velocity: held.velocity, channel: held.channel, start: held.startedBeat, duration: Math.max(.05, end - held.startedBeat) }); }
  }

  undo(): void { const p = this.undoStack.pop(); if (!p) return; this.redoStack.push(clone(this.state.project)); this.state = { ...this.state, project: p }; this.emit("Undo"); this.queueAutosave(); }
  redo(): void { const p = this.redoStack.pop(); if (!p) return; this.undoStack.push(clone(this.state.project)); this.state = { ...this.state, project: p }; this.emit("Redo"); this.queueAutosave(); }
  newProject(): void { this.stop(); this.stopSampler(); this.stopAllPads(); this.stopAllNotes(); this.stopPattern(); this.stopPatternRecording(); this.cancelSamplerRecording(); this.commit(blankProject(), "New project"); }
  exportProject(): void { this.download(`${this.safeName()}.dbdjproject`, new TextEncoder().encode(JSON.stringify(this.state.project, null, 2)).buffer, "application/json"); this.emit("Project file saved"); }
  async importProject(): Promise<void> { const f = await this.platform.pickTextFile(".dbdjproject,application/json"); if (!f) return; const p = migrateProject(JSON.parse(f.text)); if (!p) throw new Error("This is not a supported .dbdjproject file"); this.stop(); this.stopSampler(); this.stopAllPads(); this.stopAllNotes(); this.stopPattern(); this.stopPatternRecording(); this.cancelSamplerRecording(); this.commit(p, `Loaded ${f.name}`); }
  private safeName(): string { return (this.state.project.name.trim() || "production").replace(/[<>:"/\\|?*]+/g, "_"); }
  private download(name: string, bytes: ArrayBuffer, type: string): void { const url = URL.createObjectURL(new Blob([bytes], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  async exportWav(): Promise<void> {
    this.emit("Rendering WAV…"); const sampleRate = 44100; const seconds = this.duration(); const frames = Math.ceil(seconds * sampleRate); const ctx = new OfflineAudioContext(2, frames, sampleRate); const anySolo = this.state.project.tracks.some((t) => t.solo);
    for (const track of this.state.project.tracks) for (const clip of track.clips) {
      if (clip.muted || track.muted || (anySolo && !track.solo)) continue;
      if (clip.type === "audio") { const source = ctx.createBufferSource(); source.buffer = await this.clipBuffer(clip); const gain = ctx.createGain(); this.applyClipFades(gain.gain, track.gain * clip.gain, clip.start, 0, clip); const pan = ctx.createStereoPanner(); pan.pan.value = track.pan; source.connect(gain).connect(pan).connect(ctx.destination); source.start(clip.start, clip.offset, clip.duration); }
      else if (track.instrument && track.instrument.type !== "sampler") for (const note of clip.notes) { const swingBeat = track.instrument.type === "drums" && Math.round(note.start * 4) % 2 === 1 ? clip.swing * .125 : 0; const at = clip.start + beatsToSeconds(note.start + swingBeat, this.state.project.bpm); const duration = Math.min(beatsToSeconds(note.duration, this.state.project.bpm), clip.start + clip.duration - at); if (duration > 0) this.scheduleInstrument(ctx, ctx.destination, track.instrument, note.pitch, note.velocity, at, duration, track.gain * clip.gain, track.pan, false); }
    }
    await this.scheduleSamplerTracks(ctx, ctx.destination, this.state.project.tracks.filter((t) => t.instrument?.type === "sampler" && !t.muted && (!anySolo || t.solo)), null);
    const rendered = await ctx.startRendering(); const wav = encodeWav({ sampleRate, left: rendered.getChannelData(0), right: rendered.getChannelData(1) }); this.download(`${this.safeName()}.wav`, wav, "audio/wav"); this.emit("WAV export complete");
  }

  async toggleRecording(): Promise<void> {
    if (this.recorder) { this.recorder.stop(); return; }
    const armed = this.state.project.tracks.find((t) => t.armed); if (!armed) throw new Error("Arm an audio track before recording");
    const stream = await this.openMicrophone();
    this.recordingChunks = []; const recorder = new MediaRecorder(stream); this.recorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size) this.recordingChunks.push(e.data); };
    recorder.onstop = () => void this.finishRecording(armed.id, stream);
    this.recordingStart = this.state.position; recorder.start(250); this.state = { ...this.state, recording: true }; this.emit("Recording input…"); if (!this.state.playing) await this.play();
  }
  /** Desktop only grants the mic after it's been asked for through the bridge (one system prompt on macOS). */
  private async openMicrophone(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is not supported on this device");
    const access = await window.dbdjDesktop?.requestMicrophone?.();
    if (access && !access.granted) throw new Error(access.status === "denied" || access.status === "restricted"
      ? "Microphone access is off for Donkey Billabong DJ — allow it in System Settings → Privacy & Security → Microphone"
      : "Microphone access was not allowed");
    try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (err) { throw new Error(err instanceof DOMException && err.name === "NotAllowedError" ? "Microphone access was denied" : `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`); }
  }
  private async keepRecording(ref: string, bytes: ArrayBuffer): Promise<void> {
    try { await saveRecording(ref, bytes); } catch { this.emit("Recording kept for this session only (storage unavailable)"); }
  }
  private async finishRecording(trackId: string, stream: MediaStream): Promise<void> {
    stream.getTracks().forEach((t) => t.stop()); const blob = new Blob(this.recordingChunks, { type: this.recorder?.mimeType || "audio/webm" }); this.recorder = null;
    const bytes = await blob.arrayBuffer(); const ref = `production-recording://${makeId("take")}`; this.memoryFiles.set(ref, bytes); await this.keepRecording(ref, bytes); this.state = { ...this.state, recording: false };
    await this.addAudio(trackId, { ref, title: `Recording ${new Date().toLocaleTimeString()}` }, this.recordingStart); this.emit("Recording added to arrangement");
  }
}

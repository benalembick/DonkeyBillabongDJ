import type { VocalNote } from "./vocal/pitchTrack";
import { PITCH_PRESETS, type PitchPresetId } from "./vocal/pitchCorrect";
import type { ScaleName } from "./vocal/scales";
import type { CleanupChain } from "./vocal/cleanup";
import type { EnhancePresetId } from "./vocal/enhance";
export type ProductionTrackKind = "audio" | "instrument" | "bus";
export type OscillatorShape = "sine" | "square" | "sawtooth" | "triangle";
export type InstrumentType = "synth" | "drums" | "sampler";
export interface SynthSettings { oscillator: OscillatorShape; attack: number; decay: number; sustain: number; release: number; cutoff: number; resonance: number; detune: number; glide: number; volume: number }
/** `samplerMode` (sampler tracks): how notes reach the Sampler — pad notes (SLICES) or one sample across the keys (CHROMATIC). */
export interface InstrumentSettings { type: InstrumentType; synth: SynthSettings; samplerMode?: SamplerMode }
interface BaseClip { id: string; name: string; start: number; duration: number; gain: number; muted: boolean }
/** `reverse` plays the source backwards (offset is then measured from the source's end); fades are seconds. */
export interface AudioClip extends BaseClip { type: "audio"; ref: string; offset: number; sourceDuration: number; peaks: number[]; reverse?: boolean; fadeIn?: number; fadeOut?: number; /** Vocal Studio: the take this clip plays. */ takeId?: string }
export interface MidiNote { id: string; pitch: number; start: number; duration: number; velocity: number; channel: number }
export interface MidiClip extends BaseClip { type: "midi"; notes: MidiNote[]; patternBars: number; swing: number }
export type ProductionClip = AudioClip | MidiClip;

export type SamplePlaybackMode = "one-shot" | "gate" | "toggle" | "loop";
export interface SamplerEdits { reverse: boolean; normalize: boolean; fadeIn: number; fadeOut: number }
export interface SamplerSample {
  id: string;
  sourceRef: string;
  name: string;
  sourceDuration: number;
  start: number;
  end: number;
  gain: number;
  playbackMode: SamplePlaybackMode;
  edits: SamplerEdits;
  peaks: number[];
  createdAt: number;
}
export type ChokeGroup = 0 | 1 | 2 | 3 | 4;
/** Per-pad voice settings. Gain, start/end and reverse live on the pad's sample. */
export interface PadParams {
  pan: number; pitch: number;
  attack: number; decay: number; sustain: number; release: number;
  cutoff: number; resonance: number;
  muted: boolean; solo: boolean;
  /** 0 = none. Triggering a pad stops the other pads in the same group. */
  choke: ChokeGroup;
}
export interface SamplerPad { index: number; midiNote: number; sample: SamplerSample | null; params: PadParams }

export type SliceMode = "transient" | "beat" | "equal" | "manual";
export interface SliceState {
  /** SLICE mode shown in the Sampler. */
  enabled: boolean;
  mode: SliceMode;
  /** 0–1; higher keeps weaker attacks. */
  sensitivity: number;
  /** Beat mode slice length in beats (0.25, 0.5, 1, 4 = 1 bar, 8 = 2 bars). */
  beats: number;
  /** Equal mode slice count. */
  equal: number;
  /** Beat mode tempo; null uses the project BPM. */
  bpm: number | null;
  /** Detected attacks of `sourceRef` (source seconds, strength 0–1). */
  detected: { time: number; strength: number }[];
  /** Editable slice markers (source seconds) inside the editor sample's start/end. */
  markers: number[];
  sourceRef: string | null;
  /** Map Slices to Pads also applies Auto Clean (zero crossings + anti-click fades) to each slice. */
  autoClean: boolean;
}
export type SamplerMode = "slices" | "chromatic";
/** CHROMATIC mode: one sample played across the keyboard; `rootNote` plays at its original pitch. */
export interface ChromaticState { sample: SamplerSample | null; rootNote: number; /** Detected fundamental of `sample`, null when not pitched / not analysed. */ detectedRoot: number | null; params: PadParams }
export type QuantizeGrid = "off" | "1/4" | "1/8" | "1/16" | "1/32" | "triplet";
/** Grid size in beats (triplet = 1/8-note triplets). */
export const QUANTIZE_BEATS: Record<QuantizeGrid, number> = { off: 0, "1/4": 1, "1/8": .5, "1/16": .25, "1/32": .125, triplet: 1 / 3 };
/** A recorded pad / key performance: raw timing in beats, quantised when it is used. */
export interface SamplerPattern { notes: MidiNote[]; bars: number; mode: SamplerMode; recordedAt: number }
export interface SamplerProjectState {
  editor: SamplerSample | null;
  /** Absolute pad index (bank × 16 + pad). */
  selectedPad: number;
  /** Current pad bank, 0–3 = A–D. */
  bank: number;
  savedSamples: SamplerSample[];
  /** 64 pads: banks A–D × 16. */
  pads: SamplerPad[];
  slicing: SliceState;
  /** SLICES: pads answer to their MIDI notes. CHROMATIC: notes play `chromatic.sample` transposed. */
  mode: SamplerMode;
  /** MIDI note of pad A1; pads follow chromatically unless remapped. */
  baseNote: number;
  chromatic: ChromaticState;
  pattern: SamplerPattern | null;
  quantize: { grid: QuantizeGrid; strength: number };
}

/** Level analysis of a recorded take (Phase 1; pitch/timing/sibilance analysis arrive with later phases). */
export interface VocalTakeAnalysis { peakDb: number; rmsDb: number; clippedSamples: number; noiseFloorDb: number; activeRatio: number }
/**
 * One recorded vocal take. `ref` is the untouched dry recording (mono WAV in IndexedDB). It starts `offset`
 * seconds before the take's arrangement `start` (pre-roll / count-in plus latency compensation), so the
 * original stays complete and alignment is just clip offset.
 */
export interface VocalTake {
  id: string; ref: string; name: string; recordedAt: number;
  start: number; duration: number; offset: number; sourceDuration: number; sampleRate: number;
  /** Round-trip latency removed when placing the take (ms). */
  latencyMs: number;
  input: string;
  punch: { in: number; out: number } | null;
  analysis: VocalTakeAnalysis | null;
  /** Phase 2 pitch analysis: detected (and edited) notes, in seconds of the take file. */
  pitch?: { notes: VocalNote[]; analysedAt: number; key: { root: number; scale: "major" | "minor"; confidence: number } | null };
}
/**
 * Pitch correction for a vocal track (Phase 2). Non-destructive: with `enabled` the track's take clips play a
 * render (`production-vocal-render://take@hash`) computed from the untouched take, these settings and the notes.
 */
export interface PitchSettings {
  enabled: boolean; key: number; scale: ScaleName; custom: boolean[];
  strength: number; retuneMs: number; humanize: number; transitionMs: number; drift: number; preserve: number; formant: boolean;
  preset: PitchPresetId | "custom";
}
export const defaultPitchSettings = (key = 0, scale: ScaleName = "major"): PitchSettings => ({ enabled: false, key, scale, custom: Array.from({ length: 12 }, (_, i) => [0, 2, 4, 5, 7, 9, 11].includes(i)), ...PITCH_PRESETS.natural.params, formant: true, preset: "natural" });
/** Phase 3 cleanup chain of a vocal track (Auto Enhance writes it; every processor has its own bypass). */
export interface VocalChainSettings { amount: number; preset: EnhancePresetId | "custom" | null; processors: CleanupChain; report: string[] | null }
export interface VocalTrackData {
  takes: VocalTake[]; activeTakeId: string | null; pitch?: PitchSettings; chain?: VocalChainSettings;
  /** A/B: "original" plays the untouched take; "processed" (default) plays pitch + cleanup when any is on. */
  listen?: "original" | "processed";
}

export interface ProductionTrack {
  id: string;
  name: string;
  kind: ProductionTrackKind;
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  armed: boolean;
  input: string;
  output: "master";
  instrument?: InstrumentSettings;
  stem?: { sourceRef: string; part: "vocals" | "drums" | "bass" | "instruments" };
  /** Vocal Studio track: every recorded take (never deleted) and the one the track plays. */
  vocal?: VocalTrackData;
  clips: ProductionClip[];
}

export interface ProductionMarker {
  id: string;
  time: number;
  label: string;
}

/**
 * Live Looper. A loop is a whole number of bars at the BPM it was recorded at, anchored to the bar it started on,
 * so every loop stays in phase with the looper transport. Audio is the untouched latency-compensated capture (mono
 * WAV in IndexedDB, `production-loop://…`).
 *
 * Phase 2: a loop is one or more non-destructive overdub `layers`, summed at playback up to `active` (UNDO / REDO
 * just moves `active` — layers past it are kept, never deleted). Recording a new overdub after an UNDO drops them.
 *
 * `trimIn` (Manual Trim) is a non-destructive playback rotation, not a cut: every layer keeps its full captured
 * audio and `duration`/`bars` never change, but playback starts `trimIn` seconds into the cycle instead of at 0, so
 * a leading silence never has to be heard (and STRIP SILENCE can set it automatically). All layers share one
 * `trimIn` so overdubs stay aligned with the base layer.
 */
export interface LoopLayer { ref: string; peaks: number[]; recordedAt: number }
export interface LoopAudio { layers: LoopLayer[]; active: number; bars: number; anchorBar: number; bpm: number; beatsPerBar: number; sampleRate: number; duration: number; latencyMs: number; recordedAt: number; trimIn: number }
/**
 * `protected` (Teach Me: Live Looping's ghost backing loops): REC/DUB/CLEAR/remove refuse; volume/mute/solo still
 * work normally. `lowCutHz` (Phase 2, "Layering & Frequency Management"): a real-time highpass on the track's
 * output, undefined/≤20 = off — a genuine mixing control, not lesson-only.
 */
export interface LoopTrack { id: string; name: string; volume: number; muted: boolean; solo: boolean; loop: LoopAudio | null; protected?: boolean; lowCutHz?: number }
/** LOOP QUANTIZE: how precisely REC/LOOP close on the bar grid (clamped up to whole bars) and PLAY/STOP/TOGGLE land on the beat. */
export type LoopQuantize = "off" | "1/4-beat" | "1/2-beat" | "1-beat" | "1-bar" | "2-bar" | "4-bar";
export const LOOP_QUANTIZE_OPTIONS: { id: LoopQuantize; label: string }[] = [
  { id: "off", label: "OFF" }, { id: "1/4-beat", label: "1/4 beat" }, { id: "1/2-beat", label: "1/2 beat" }, { id: "1-beat", label: "1 beat" },
  { id: "1-bar", label: "1 bar" }, { id: "2-bar", label: "2 bars" }, { id: "4-bar", label: "4 bars" },
];
/**
 * Threshold Recording (Auto-Start): REC arms and waits silently; the first sample past `thresholdDb` becomes the
 * recording's start, eliminating leading silence. Only applies to a fresh base-loop take (not overdub, which must
 * start exactly on the loop's own cycle boundary to stay in phase).
 */
export interface LooperSession { tracks: LoopTrack[]; countIn: boolean; click: boolean; quantize: LoopQuantize; thresholdRecord: boolean; thresholdDb: number; selectedTrackId: string | null }
export const LOOPER_DEFAULT_TRACKS = ["Percussion", "Bass", "Chords", "Melody", "Vocal", "Samples"];
export const blankLooper = (): LooperSession => { const tracks = LOOPER_DEFAULT_TRACKS.map((name) => ({ id: makeId("loop"), name, volume: 1, muted: false, solo: false, loop: null })); return { tracks, countIn: true, click: true, quantize: "off", thresholdRecord: false, thresholdDb: -36, selectedTrackId: tracks[0].id }; };

export interface ProductionProject {
  format: "DonkeyBillabongDJ Production Project";
  version: 3;
  id: string;
  name: string;
  bpm: number;
  timeSignature: [number, number];
  loop: { enabled: boolean; start: number; end: number };
  metronome: boolean;
  tracks: ProductionTrack[];
  markers: ProductionMarker[];
  sampler: SamplerProjectState;
  /** Live Looper session (optional: older projects have none until the Looper is opened). */
  looper?: LooperSession;
  /** Song key (Vocal Studio "Use Project Key"); optional. */
  key?: { root: number; scale: ScaleName };
  createdAt: number;
  updatedAt: number;
}

export interface ProductionState {
  project: ProductionProject;
  playing: boolean;
  recording: boolean;
  midiRecording: boolean;
  position: number;
  selectedClipId: string | null;
  undoAvailable: boolean;
  redoAvailable: boolean;
  message: string;
  stemJob: { ref: string; stage: "queued" | "separating" | "importing"; message: string } | null;
  /** Sampler editor preview (pads play separately, see padsPlaying). */
  samplerPlayback: { sampleId: string; /** Source time where the previewed region starts (a slice or the selection). */ regionStart: number; playing: boolean; paused: boolean; position: number } | null;
  samplerRecording: boolean;
  /** Source currently auditioned from the Production Browser (session only). */
  previewRef: string | null;
  /** Pads currently sounding; pads are polyphonic so they can be layered live. */
  padsPlaying: number[];
  /** Level of the pad bank (0–1.5), shared by Production Studio and the live DJ sampler. */
  padVolume: number;
  /** Pattern recording: count-in, then recording (session only). */
  patternRecording: { phase: "count-in" | "recording"; beat: number } | null;
  patternPlaying: boolean;
  /** CHROMATIC notes currently sounding. */
  notesPlaying: number[];
  /** Last Auto Clean analysis of the editor sample (session only). */
  cleanReport: import("./slicing").CleanReport | null;
}

export const makeId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const defaultSynth = (): SynthSettings => ({ oscillator: "sawtooth", attack: .01, decay: .16, sustain: .7, release: .2, cutoff: 8000, resonance: .5, detune: 0, glide: 0, volume: .7 });
export const instrumentTrack = (name: string, type: InstrumentType): ProductionTrack => ({ id: makeId("track"), name, kind: "instrument", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "MIDI All", output: "master", instrument: { type, synth: defaultSynth() }, clips: [] });
export const PADS_PER_BANK = 16;
export const PAD_BANKS = ["A", "B", "C", "D"] as const;
export const padLabel = (index: number): string => `${PAD_BANKS[Math.floor(index / PADS_PER_BANK)] ?? "?"}${index % PADS_PER_BANK + 1}`;
export const defaultPadParams = (): PadParams => ({ pan: 0, pitch: 0, attack: 0, decay: 0, sustain: 1, release: 0, cutoff: 20000, resonance: .7, muted: false, solo: false, choke: 0 });
export const defaultSlicing = (): SliceState => ({ enabled: false, mode: "transient", sensitivity: .5, beats: 1, equal: 8, bpm: null, detected: [], markers: [], sourceRef: null, autoClean: true });
export const DEFAULT_BASE_NOTE = 36;
export const blankSampler = (): SamplerProjectState => ({ editor: null, selectedPad: 0, bank: 0, savedSamples: [], pads: Array.from({ length: PAD_BANKS.length * PADS_PER_BANK }, (_, index) => ({ index, midiNote: DEFAULT_BASE_NOTE + index, sample: null, params: defaultPadParams() })), slicing: defaultSlicing(), mode: "slices", baseNote: DEFAULT_BASE_NOTE, chromatic: { sample: null, rootNote: 60, detectedRoot: null, params: defaultPadParams() }, pattern: null, quantize: { grid: "1/16", strength: 1 } });

/** A sampler sample as an arrangement clip that keeps its region, gain, normalize, reverse and fades. */
export function sampleToClip(sample: SamplerSample, start: number): AudioClip {
  const duration = Math.max(.01, sample.end - sample.start);
  const normalization = sample.edits.normalize ? 1 / Math.max(.001, ...sample.peaks) : 1;
  const from = Math.floor(sample.start / sample.sourceDuration * sample.peaks.length), to = Math.ceil(sample.end / sample.sourceDuration * sample.peaks.length);
  const region = sample.peaks.slice(from, Math.max(from + 1, to));
  return {
    type: "audio", id: makeId("clip"), name: sample.name, ref: sample.sourceRef, start: Math.max(0, start),
    offset: sample.edits.reverse ? sample.sourceDuration - sample.end : sample.start, duration, sourceDuration: sample.sourceDuration,
    gain: sample.gain * normalization, muted: false, peaks: sample.edits.reverse ? region.reverse() : region,
    reverse: sample.edits.reverse || undefined, fadeIn: sample.edits.fadeIn || undefined, fadeOut: sample.edits.fadeOut || undefined,
  };
}

export function blankProject(name = "Untitled Production"): ProductionProject {
  const now = Date.now();
  return {
    format: "DonkeyBillabongDJ Production Project", version: 3, id: makeId("project"), name,
    bpm: 120, timeSignature: [4, 4], loop: { enabled: false, start: 0, end: 8 }, metronome: false,
    tracks: [instrumentTrack("Drums", "drums"), instrumentTrack("Synth", "synth"), ...["Audio", "Vocals"].map((trackName): ProductionTrack => ({ id: makeId("track"), name: trackName, kind: "audio", gain: 1, pan: 0, muted: false, solo: false, armed: false, input: "None", output: "master", clips: [] }))],
    markers: [{ id: makeId("marker"), time: 0, label: "INTRO" }], sampler: blankSampler(), createdAt: now, updatedAt: now,
  };
}

/** Loads Phase 1 projects without losing audio clips. */
export function migrateProject(value: unknown): ProductionProject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== "DonkeyBillabongDJ Production Project" || !Array.isArray(raw.tracks)) return null;
  if (raw.version === 3) { const project = raw as unknown as ProductionProject; return { ...project, sampler: normalizeSampler(project.sampler), looper: normalizeLooper(project.looper), tracks: project.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.type === "midi" ? { ...clip, swing: clip.swing ?? 0 } : clip) })) }; }
  if (raw.version === 2) { const project = raw as unknown as Omit<ProductionProject, "sampler" | "version"> & { version: 2 }; return { ...project, version: 3, sampler: blankSampler(), tracks: project.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.type === "midi" ? { ...clip, swing: clip.swing ?? 0 } : clip) })) }; }
  if (raw.version !== 1) return null;
  const old = raw as unknown as { tracks: Array<Omit<ProductionTrack, "clips"> & { clips: Array<Omit<AudioClip, "type">> }> };
  return { ...(raw as unknown as ProductionProject), version: 3, sampler: blankSampler(), tracks: old.tracks.map((track): ProductionTrack => ({ ...track, clips: track.clips.map((clip): AudioClip => ({ ...clip, type: "audio" })) })) };
}

/** Loads Phase 1 looper sessions (single-ref loops, no quantize setting) into the Phase 2 layers shape. */
function normalizeLooper(value: LooperSession | undefined): LooperSession | undefined {
  if (!value) return value;
  return { ...value, quantize: value.quantize ?? "off", thresholdRecord: value.thresholdRecord ?? false, thresholdDb: value.thresholdDb ?? -36, tracks: value.tracks.map((t) => ({ ...t, loop: normalizeLoop(t.loop) })) };
}
function normalizeLoop(loop: LoopAudio | (Omit<LoopAudio, "layers" | "active" | "trimIn"> & { ref: string; peaks: number[] }) | null): LoopAudio | null {
  if (!loop) return null;
  if (Array.isArray((loop as LoopAudio).layers)) { const existing = loop as LoopAudio; return { ...existing, trimIn: existing.trimIn ?? 0 }; }
  const { ref, peaks, ...rest } = loop as Omit<LoopAudio, "layers" | "active" | "trimIn"> & { ref: string; peaks: number[] };
  return { ...rest, layers: [{ ref, peaks, recordedAt: rest.recordedAt }], active: 1, trimIn: 0 };
}

function normalizeSampler(value: SamplerProjectState | undefined): SamplerProjectState {
  const fallback = blankSampler();
  if (!value) return fallback;
  // Phase 1 projects have 16 pads (bank A) and no pad params or slicing.
  const pads = fallback.pads.map((pad, index) => { const saved = value.pads?.[index]; return { ...pad, ...(saved ?? {}), index, params: { ...pad.params, ...(saved?.params ?? {}) } }; });
  const last = pads.length - 1;
  const chromatic = { ...fallback.chromatic, ...(value.chromatic ?? {}) }; chromatic.params = { ...fallback.chromatic.params, ...(value.chromatic?.params ?? {}) };
  return { editor: value.editor ?? null, selectedPad: Math.max(0, Math.min(last, value.selectedPad ?? 0)), bank: Math.max(0, Math.min(PAD_BANKS.length - 1, value.bank ?? 0)), savedSamples: value.savedSamples ?? [], pads, slicing: { ...fallback.slicing, ...(value.slicing ?? {}) },
    mode: value.mode === "chromatic" ? "chromatic" : "slices", baseNote: value.baseNote ?? fallback.baseNote, chromatic, pattern: value.pattern ?? null, quantize: { ...fallback.quantize, ...(value.quantize ?? {}) } };
}

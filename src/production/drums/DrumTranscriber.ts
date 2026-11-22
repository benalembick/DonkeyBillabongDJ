/**
 * Drum Transcriber service (Production Studio → Drum Transcriber). See docs/DRUM-TRANSCRIBER.md.
 *
 * Owns the open transcription, its edit history, analysis jobs (worker; cancellable), the A/B preview transport and
 * persistence. Reuses the app's pieces rather than duplicating them: audio decoding and Production Studio source
 * refs (files, recordings, stems), the Production Studio output bus, the library's beat grids (hand-edited grids win),
 * `contentTrackId` for source identity, Production Studio's quantiser, and the shared versioned `DocStore`.
 */
import type { DocStore } from "../../setstudio/DocStore";
import { mixToMono } from "../slicing";
import { DrumKit } from "./kit";
import { transcriptionToJson, transcriptionToMidi, type MidiExportReport } from "./midiFile";
import { deriveNotes, snapTime } from "./timing";
import { AnalysisCancelled, ENGINE_ID, ENGINE_VERSION, isCancelled, transcribeDrums, type Stage, type TranscribeOptions, type TranscribeResult } from "./transcribe";
import { normaliseGrid, validBpm } from "../../preparation/beatGrid";
import { DRUM_LANES, DRUM_SCHEMA, GM_DRUM_MAP, QUANTIZE_GRID_BEATS, defaultSettings, makeDrumId, type DrumGrid, type DrumHit, type DrumLane, type DrumMapPreset, type DrumMapping, type DrumSource, type DrumTranscription, type TranscriptionSettings } from "./types";

export interface DecodedSource { channels: Float32Array[]; sampleRate: number; duration: number; buffer: AudioBuffer | null }
export interface LibraryGrid { bpm: number; firstBeat: number; confidence: number; manual: boolean }
export type AnalyseFn = (mono: Float32Array, rate: number, options: TranscribeOptions, onProgress: (stage: Stage, progress: number) => void, signal: AbortSignal) => Promise<TranscribeResult>;

export interface DrumTranscriberDeps {
  readBytes(ref: string): Promise<ArrayBuffer>;
  decode(bytes: ArrayBuffer): Promise<DecodedSource>;
  hash(bytes: ArrayBuffer): Promise<string>;
  store: DocStore<DrumTranscription>;
  presets: DocStore<DrumMapPreset>;
  pickFile?(): Promise<{ ref: string; name: string } | null>;
  output?(): Promise<{ context: AudioContext; input: AudioNode }>;
  libraryGrid?(hash: string, ref: string): LibraryGrid | null;
  analyse?: AnalyseFn;
  download?(name: string, bytes: Uint8Array, mime: string): void;
  saveText?(name: string, text: string, ext: string): Promise<boolean>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

export type Monitor = "original" | "midi" | "both";
export interface DrumTranscriberState {
  project: DrumTranscription | null;
  source: "none" | "loading" | "ready" | "missing";
  sourceError: string | null;
  analysis: { stage: Stage; progress: number } | null;
  playing: boolean;
  loop: boolean;
  monitor: Monitor;
  originalVolume: number;
  midiVolume: number;
  undoAvailable: boolean;
  redoAvailable: boolean;
  /** True once the transcription is in the store (analysed or saved); later edits autosave. */
  saved: boolean;
  clipboard: number;
  message: string;
  error: string | null;
}

const LAST_KEY = "dbdj.drumtx.last";
const WAVE_RATE = 400;
const clone = <T>(x: T): T => structuredClone(x);
const clampTime = (t: number, max: number) => Math.max(0, Math.min(max, t));

/** Default worker runner, with an inline (main-thread, yielding) fallback when workers are unavailable. */
export function workerAnalyse(): AnalyseFn {
  return (mono, rate, options, onProgress, signal) => {
    let worker: Worker | null = null;
    try { worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" }); } catch { worker = null; }
    if (!worker) return transcribeDrums(mono, rate, options, { onProgress, signal, yieldControl: () => new Promise((r) => setTimeout(r, 0)) });
    const w = worker;
    return new Promise<TranscribeResult>((resolve, reject) => {
      const abort = () => { w.terminate(); reject(new AnalysisCancelled()); };
      signal.addEventListener("abort", abort, { once: true });
      w.onmessage = (e: MessageEvent<{ stage?: Stage; progress?: number; result?: TranscribeResult; error?: string }>) => {
        if (e.data.stage !== undefined) onProgress(e.data.stage, e.data.progress ?? 0);
        if (e.data.result || e.data.error) { signal.removeEventListener("abort", abort); w.terminate(); if (e.data.result) resolve(e.data.result); else reject(new Error(e.data.error)); }
      };
      w.onerror = (e) => { signal.removeEventListener("abort", abort); w.terminate(); reject(new Error(e.message || "The analysis worker failed")); };
      w.postMessage({ id: 1, data: mono, rate, options }, [mono.buffer]);
    });
  };
}

interface Playback { context: AudioContext; T0: number; pos0: number; original: GainNode; midi: GainNode; source: AudioBufferSourceNode | null; nodes: AudioScheduledSourceNode[]; scheduledTo: number; timer: ReturnType<typeof setInterval>; duration: number }

export class DrumTranscriber {
  private state: DrumTranscriberState = { project: null, source: "none", sourceError: null, analysis: null, playing: false, loop: true, monitor: "both", originalVolume: .9, midiVolume: .9, undoAvailable: false, redoAvailable: false, saved: false, clipboard: 0, message: "Import a drum loop or a Drums stem to begin", error: null };
  private listeners = new Set<(s: DrumTranscriberState) => void>();
  private undoStack: DrumTranscription[] = []; private redoStack: DrumTranscription[] = [];
  private gestureBase: DrumTranscription | null = null;
  private decoded: DecodedSource | null = null; private peaks: Float32Array | null = null;
  private job: AbortController | null = null;
  private clip: { lane: DrumLane; dt: number; strength: number; velocity: number | null }[] = [];
  private play_: Playback | null = null; private stoppedAt = 0;
  private kit = new DrumKit();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  private notesFor: DrumTranscription | null = null; private notesCache: ReturnType<typeof deriveNotes>["notes"] = [];
  readonly analyseFn: AnalyseFn;

  constructor(private deps: DrumTranscriberDeps) { this.analyseFn = deps.analyse ?? workerAnalyse(); }

  subscribe = (l: (s: DrumTranscriberState) => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): DrumTranscriberState => this.state;
  private set(patch: Partial<DrumTranscriberState>): void { this.state = { ...this.state, ...patch, undoAvailable: this.undoStack.length > 0, redoAvailable: this.redoStack.length > 0 }; for (const l of this.listeners) l(this.state); }
  private fail(error: unknown): void { this.set({ error: error instanceof Error ? error.message : String(error) }); }
  clearError(): void { this.set({ error: null }); }
  /** Shows an error from the UI layer (file pickers, drops) in the module's error banner. */
  reportError(error: unknown): void { this.fail(error); }

  /** Loads saved transcriptions and presets, then reopens the last transcription (no re-analysis). */
  async init(): Promise<void> {
    await Promise.all([this.deps.store.load(), this.deps.presets.load()]);
    let last: string | null = null; try { last = this.deps.storage?.getItem(LAST_KEY) ?? null; } catch { /* storage unavailable */ }
    if (last && this.deps.store.get(last) && !this.state.project) await this.open(last);
  }
  savedProjects(): DrumTranscription[] { return this.deps.store.all(); }
  presets(): DrumMapPreset[] { return this.deps.presets.all(); }
  /** Decoded source waveform: peak per 1/400 s (null while loading or when the source is missing). */
  waveform(): { peaks: Float32Array; rate: number } | null { return this.peaks ? { peaks: this.peaks, rate: WAVE_RATE } : null; }
  duration(): number { return this.decoded?.duration ?? this.state.project?.source.duration ?? 0; }

  // ─────────────────────────── history ───────────────────────────
  private commit(next: DrumTranscription, message: string): void {
    if (this.state.project) { this.undoStack.push(this.gestureBase ?? clone(this.state.project)); if (this.undoStack.length > 100) this.undoStack.shift(); }
    this.gestureBase = null; this.redoStack = []; next.updatedAt = Date.now(); this.set({ project: next, message }); this.queueSave();
  }
  /** Live change during a drag (not in history until endGesture). */
  private preview(next: DrumTranscription): void { if (!this.gestureBase && this.state.project) this.gestureBase = clone(this.state.project); this.set({ project: next }); }
  endGesture(message = "Edited"): void { const base = this.gestureBase; if (!base || !this.state.project) return; this.gestureBase = null; this.undoStack.push(base); this.redoStack = []; this.state.project.updatedAt = Date.now(); this.set({ message }); this.queueSave(); }
  undo(): void { const prev = this.undoStack.pop(); if (!prev || !this.state.project) return; this.redoStack.push(clone(this.state.project)); this.set({ project: prev, message: "Undo" }); this.queueSave(); }
  redo(): void { const next = this.redoStack.pop(); if (!next || !this.state.project) return; this.undoStack.push(clone(this.state.project)); this.set({ project: next, message: "Redo" }); this.queueSave(); }
  private edit(change: (p: DrumTranscription) => void, message: string, gesture = false): void {
    const base = gesture ? (this.gestureBase ?? this.state.project) : this.state.project; if (!base) return;
    const next = clone(base); change(next); next.hits.sort((a, b) => a.time - b.time);
    if (gesture) this.preview(next); else this.commit(next, message);
  }

  // ─────────────────────────── persistence ───────────────────────────
  private queueSave(): void {
    if (!this.state.saved) return; if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persist(); }, 500);
  }
  private persist(): void { const p = this.state.project; if (!p) return; this.deps.store.save(clone(p)); this.remember(p.id); }
  private remember(id: string | null): void { try { if (id) this.deps.storage?.setItem(LAST_KEY, id); else this.deps.storage?.removeItem(LAST_KEY); } catch { /* storage unavailable */ } }
  /** Saves now (and from then on autosaves every edit). */
  save(): void { if (!this.state.project) return; if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this.persist(); this.set({ saved: true, message: "Transcription saved" }); }
  async flush(): Promise<void> { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.persist(); } await this.deps.store.flush(); }
  rename(name: string): void { const p = this.state.project; if (!p || !name.trim()) return; this.edit((n) => { n.name = name.slice(0, 120); }, "Renamed"); }
  async deleteSaved(id: string): Promise<void> { if (this.state.project?.id === id) this.close(); await this.deps.store.remove(id); this.set({ message: "Transcription deleted" }); }
  close(): void { this.stop(); this.cancelAnalysis(); this.loadToken++; this.decoded = null; this.peaks = null; this.undoStack = []; this.redoStack = []; this.gestureBase = null; this.remember(null); this.set({ project: null, source: "none", sourceError: null, saved: false, analysis: null, message: "Import a drum loop or a Drums stem to begin" }); }

  /** Reopens a saved transcription exactly as saved (hits, grid, edits); the source audio is loaded for playback only. */
  async open(id: string): Promise<void> {
    const saved = this.deps.store.get(id); if (!saved) { this.fail("That transcription no longer exists"); return; }
    this.close(); const project = clone(saved); this.set({ project, saved: true, message: `Opened “${project.name}”` }); this.remember(id);
    await this.loadSource(project.source);
  }

  private async loadSource(source: DrumSource): Promise<void> {
    const token = ++this.loadToken; this.set({ source: "loading", sourceError: null });
    try {
      const bytes = await this.deps.readBytes(source.ref); const hash = await this.deps.hash(bytes); const decoded = await this.deps.decode(bytes);
      if (token !== this.loadToken) return;
      this.decoded = decoded; this.peaks = peaksOf(decoded);
      const mismatch = source.hash && hash !== source.hash;
      this.set({ source: "ready", sourceError: mismatch ? "The file at this location has changed since it was transcribed — timings may not match. Re-analyse or relink." : null });
    } catch (e) {
      if (token !== this.loadToken) return; this.decoded = null; this.peaks = null;
      this.set({ source: "missing", sourceError: `Source audio unavailable (${source.name}): ${e instanceof Error ? e.message : String(e)}. Your notes are safe — relink the file to hear it.` });
    }
  }

  // ─────────────────────────── import ───────────────────────────
  async importFile(): Promise<void> { const picked = await this.deps.pickFile?.(); if (picked) await this.importRef(picked.ref, picked.name, "file"); }

  /** Starts a new transcription for a source (file, library track or Production Studio clip). Nothing is analysed yet. */
  async importRef(ref: string, name: string, origin: DrumSource["origin"] = "file"): Promise<void> {
    this.close(); const token = ++this.loadToken; this.set({ source: "loading", message: `Loading ${name}…`, error: null });
    try {
      const bytes = await this.deps.readBytes(ref); if (!bytes.byteLength) throw new Error("The file is empty");
      const hash = await this.deps.hash(bytes);
      let decoded: DecodedSource; try { decoded = await this.deps.decode(bytes); } catch { throw new Error(`“${name}” could not be decoded — use WAV, MP3, FLAC, AIFF, OGG or M4A audio`); }
      if (token !== this.loadToken) return;
      if (!decoded.channels.length || decoded.duration < .1) throw new Error("This audio is too short to transcribe");
      this.decoded = decoded; this.peaks = peaksOf(decoded);
      const now = Date.now(); const title = name.replace(/\.[^.]+$/, "");
      const project: DrumTranscription = {
        schemaVersion: DRUM_SCHEMA, id: makeDrumId("drumtx"), name: title, createdAt: now, updatedAt: now,
        source: { ref, name, hash, duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.channels.length, origin },
        grid: this.libraryGridFor(hash, ref) ?? { bpm: 120, firstBeat: 0, beatsPerBar: 4, source: "default", confidence: 0 },
        hits: [], mapping: { ...GM_DRUM_MAP }, mappingPresetId: null, settings: defaultSettings(), analysis: null,
      };
      this.set({ project, source: "ready", saved: false, message: `Loaded ${name} — choose a mode and press ANALYSE` });
    } catch (e) { if (token === this.loadToken) { this.set({ source: "none", message: "Import a drum loop or a Drums stem to begin" }); this.fail(e); } }
  }

  /** Points a transcription at a moved/renamed file. Returns "mismatch" (and changes nothing) when the audio differs, unless forced. */
  async relink(force = false, picked?: { ref: string; name: string } | null): Promise<"ok" | "mismatch" | "cancelled"> {
    const p = this.state.project; if (!p) return "cancelled"; const file = picked ?? await this.deps.pickFile?.(); if (!file) return "cancelled";
    const bytes = await this.deps.readBytes(file.ref); const hash = await this.deps.hash(bytes);
    if (hash !== p.source.hash && !force) return "mismatch";
    this.edit((n) => { n.source = { ...n.source, ref: file.ref, name: file.name, hash }; }, "Source relinked");
    await this.loadSource(this.state.project!.source); return "ok";
  }

  private libraryGridFor(hash: string, ref: string): DrumGrid | null {
    const g = this.deps.libraryGrid?.(hash, ref); if (!g || !validBpm(g.bpm)) return null;
    const n = normaliseGrid({ bpm: g.bpm, firstBeat: g.firstBeat });
    return { bpm: n.bpm, firstBeat: n.firstBeat, beatsPerBar: 4, source: g.manual ? "library-manual" : "library", confidence: g.confidence };
  }

  // ─────────────────────────── analysis ───────────────────────────
  get analysing(): boolean { return !!this.job; }

  /** Runs (or re-runs) transcription. Replaces all hits — one undo step brings the previous ones back. */
  async analyse(): Promise<void> {
    const p = this.state.project; if (!p || this.job) return;
    if (!this.decoded) { this.fail(this.state.source === "loading" ? "The audio is still loading" : "Relink the source audio before analysing"); return; }
    if (p.settings.mode === "song") { this.fail("Full-song transcription (AI drum separation) arrives in Phase 2. Separate the song in the Arrangement (✦ SEPARATE INTO TRACKS) and transcribe its Drums stem instead."); return; }
    const job = new AbortController(); this.job = job; this.set({ analysis: { stage: "preparing", progress: 0 }, error: null, message: "Analysing…" });
    try {
      const mono = Float32Array.from(mixToMono(this.decoded.channels));
      const result = await this.analyseFn(mono, this.decoded.sampleRate, { sensitivity: p.settings.sensitivity, minConfidence: p.settings.minConfidence, mode: p.settings.mode }, (stage, progress) => { if (this.job === job) this.set({ analysis: { stage, progress } }); }, job.signal);
      if (this.job !== job || this.state.project?.id !== p.id) return;
      this.applyResult(result);
    } catch (e) {
      if (isCancelled(e)) this.set({ message: "Analysis cancelled — nothing was changed" }); else this.fail(e);
    } finally { if (this.job === job) { this.job = null; this.set({ analysis: null }); } }
  }
  cancelAnalysis(): void { const job = this.job; if (!job) return; this.job = null; job.abort(); this.set({ analysis: null, message: "Analysis cancelled — nothing was changed" }); }

  private applyResult(r: TranscribeResult): void {
    const p = this.state.project!; let group = 0; const groups = new Map<number, string>();
    const counts = new Map<number, number>(); for (const h of r.hits) counts.set(h.onsetIndex, (counts.get(h.onsetIndex) ?? 0) + 1);
    const hits: DrumHit[] = r.hits.map((h) => {
      let g: string | null = null; if ((counts.get(h.onsetIndex) ?? 0) > 1) { g = groups.get(h.onsetIndex) ?? `g${++group}`; groups.set(h.onsetIndex, g); }
      return { id: makeDrumId("hit"), lane: h.lane, time: h.time, onset: h.time, detected: h.lane, confidence: Math.round(h.confidence * 1000) / 1000, strength: Math.round(h.strength * 1000) / 1000, velocity: null, candidates: h.candidates.map((c) => ({ lane: c.lane, score: Math.round(c.score * 1000) / 1000 })), review: h.review, group: g, edited: false };
    });
    const keepGrid = p.grid.source === "manual" || p.grid.source === "library-manual";
    const grid: DrumGrid = keepGrid ? p.grid : this.libraryGridFor(p.source.hash, p.source.ref) ?? (r.tempo ? { bpm: r.tempo.bpm, firstBeat: r.tempo.firstBeat, beatsPerBar: 4, source: r.tempo.source, confidence: r.tempo.confidence } : p.grid);
    const next: DrumTranscription = { ...clone(p), hits, grid, analysis: {
      engine: ENGINE_ID, onsetDetector: r.onsetDetector, classifier: `${r.classifier.id}@${r.classifier.version}`, version: ENGINE_VERSION, analysedAt: Date.now(), elapsedMs: r.elapsedMs,
      onsets: r.onsets.map((t) => Math.round(t * 1e5) / 1e5), analysisRate: r.analysisRate, settings: { sensitivity: p.settings.sensitivity, minConfidence: p.settings.minConfidence, mode: p.settings.mode }, tempo: r.tempo,
    } };
    const unknown = hits.filter((h) => h.lane === "unknown").length, review = hits.filter((h) => h.review).length;
    this.state = { ...this.state, saved: true };
    this.commit(next, `Found ${hits.length} hits from ${r.onsets.length} onsets${unknown ? ` · ${unknown} unknown` : ""}${review ? ` · ${review} to review` : ""}`);
  }

  // ─────────────────────────── grid & settings ───────────────────────────
  setGrid(patch: { bpm?: number; firstBeat?: number }): void {
    const p = this.state.project; if (!p) return; const bpm = patch.bpm ?? p.grid.bpm; if (!validBpm(bpm) || !Number.isFinite(patch.firstBeat ?? p.grid.firstBeat)) return;
    const n = normaliseGrid({ bpm, firstBeat: patch.firstBeat ?? p.grid.firstBeat });
    this.edit((x) => { x.grid = { ...x.grid, bpm: n.bpm, firstBeat: n.firstBeat, source: "manual", confidence: 1 }; }, "Beat grid set by hand");
  }
  /** Makes `time` a downbeat (bar 1) without changing the tempo. */
  setDownbeat(time: number): void { this.setGrid({ firstBeat: time }); }
  /** Back to the library grid, else what the analysis detected. */
  resetGrid(): void {
    const p = this.state.project; if (!p) return; const lib = this.libraryGridFor(p.source.hash, p.source.ref); const t = p.analysis?.tempo;
    const grid: DrumGrid = lib ?? (t ? { bpm: t.bpm, firstBeat: t.firstBeat, beatsPerBar: 4, source: t.source, confidence: t.confidence } : { bpm: 120, firstBeat: 0, beatsPerBar: 4, source: "default", confidence: 0 });
    this.edit((x) => { x.grid = grid; }, "Beat grid reset");
  }
  setSettings(patch: Partial<Omit<TranscriptionSettings, "quantize" | "velocity">> & { quantize?: Partial<TranscriptionSettings["quantize"]>; velocity?: Partial<TranscriptionSettings["velocity"]> }, gesture = false): void {
    this.edit((x) => { x.settings = { ...x.settings, ...patch, quantize: { ...x.settings.quantize, ...patch.quantize }, velocity: { ...x.settings.velocity, ...patch.velocity } }; }, "Settings changed", gesture);
  }

  // ─────────────────────────── mapping ───────────────────────────
  setMapping(lane: DrumLane, note: number | null): void { if (note !== null && !(Number.isInteger(note) && note >= 0 && note <= 127)) return; this.edit((x) => { x.mapping[lane] = note; x.mappingPresetId = null; }, `${lane} → ${note ?? "not exported"}`); }
  resetMapping(): void { this.edit((x) => { x.mapping = { ...GM_DRUM_MAP }; x.mappingPresetId = null; }, "General MIDI drum map"); }
  applyPreset(id: string): void { const preset = this.deps.presets.get(id); if (!preset) return; this.edit((x) => { x.mapping = { ...preset.mapping }; x.mappingPresetId = id; }, `Drum map “${preset.name}”`); }
  savePreset(name: string): DrumMapPreset | null {
    const p = this.state.project; if (!p || !name.trim()) return null;
    const existing = this.deps.presets.all().find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    const preset: DrumMapPreset = { id: existing?.id ?? makeDrumId("drummap"), name: name.trim().slice(0, 60), mapping: { ...p.mapping } as DrumMapping, updatedAt: Date.now() };
    this.deps.presets.save(preset); this.edit((x) => { x.mappingPresetId = preset.id; }, `Saved drum map “${preset.name}”`); return preset;
  }
  async deletePreset(id: string): Promise<void> { await this.deps.presets.remove(id); if (this.state.project?.mappingPresetId === id) this.edit((x) => { x.mappingPresetId = null; }, "Drum map preset deleted"); }

  // ─────────────────────────── note editing ───────────────────────────
  addHit(lane: DrumLane, time: number, velocity: number | null = null): string | null {
    const p = this.state.project; if (!p) return null; const id = makeDrumId("hit");
    this.edit((x) => { x.hits.push({ id, lane, time: clampTime(time, this.duration()), onset: null, detected: null, confidence: 1, strength: .8, velocity, review: null, group: null, edited: true }); }, `Added ${lane}`);
    return id;
  }
  deleteHits(ids: string[]): void { if (!ids.length) return; const set = new Set(ids); this.edit((x) => { x.hits = x.hits.filter((h) => !set.has(h.id)); }, `Deleted ${ids.length} hit${ids.length === 1 ? "" : "s"}`); }
  /** Moves hits by `dt` seconds and `laneShift` rows (relative to the gesture start when `gesture`). Refused if any hit would leave the lanes. */
  moveHits(ids: string[], dt: number, laneShift = 0, gesture = false): void {
    const set = new Set(ids); const base = gesture ? (this.gestureBase ?? this.state.project) : this.state.project; if (!base) return;
    if (base.hits.some((h) => set.has(h.id) && (DRUM_LANES.indexOf(h.lane) + laneShift < 0 || DRUM_LANES.indexOf(h.lane) + laneShift >= DRUM_LANES.length))) return;
    this.edit((x) => { for (const h of x.hits) if (set.has(h.id)) { h.time = clampTime(h.time + dt, this.duration()); if (laneShift) h.lane = DRUM_LANES[DRUM_LANES.indexOf(h.lane) + laneShift]; h.edited = true; h.review = null; } }, `Moved ${ids.length} hit${ids.length === 1 ? "" : "s"}`, gesture);
  }
  /** Sets (or with null, clears back to derived) the velocity of hits. */
  setVelocity(ids: string[], velocity: number | null, gesture = false): void {
    const set = new Set(ids); const v = velocity === null ? null : Math.max(1, Math.min(127, Math.round(velocity)));
    this.edit((x) => { for (const h of x.hits) if (set.has(h.id)) { h.velocity = v; h.edited = true; } }, v === null ? "Velocity follows the audio" : `Velocity ${v}`, gesture);
  }
  reclassify(ids: string[], lane: DrumLane): void { const set = new Set(ids); this.edit((x) => { for (const h of x.hits) if (set.has(h.id)) { h.lane = lane; h.review = null; h.edited = true; } }, `Reclassified ${ids.length} → ${lane}`); }
  /** Marks hits as checked (clears their review flag). */
  acceptHits(ids: string[]): void { const set = new Set(ids); this.edit((x) => { for (const h of x.hits) if (set.has(h.id)) { h.review = null; h.edited = true; } }, `Accepted ${ids.length} hit${ids.length === 1 ? "" : "s"}`); }
  copy(ids: string[]): void {
    const p = this.state.project; if (!p) return; const hits = p.hits.filter((h) => ids.includes(h.id)); if (!hits.length) return; const t0 = Math.min(...hits.map((h) => h.time));
    this.clip = hits.map((h) => ({ lane: h.lane, dt: h.time - t0, strength: h.strength, velocity: h.velocity })); this.set({ clipboard: this.clip.length, message: `Copied ${hits.length} hit${hits.length === 1 ? "" : "s"}` });
  }
  /** Pastes the clipboard with its first hit at `at` (seconds). Returns the new hit ids. */
  paste(at: number): string[] {
    if (!this.clip.length || !this.state.project) return []; const ids = this.clip.map(() => makeDrumId("hit"));
    this.edit((x) => { this.clip.forEach((c, i) => x.hits.push({ id: ids[i], lane: c.lane, time: clampTime(at + c.dt, this.duration()), onset: null, detected: null, confidence: 1, strength: c.strength, velocity: c.velocity, review: null, group: null, edited: true })); }, `Pasted ${ids.length} hit${ids.length === 1 ? "" : "s"}`);
    return ids;
  }
  /** Snaps a time to the current quantise grid (1/16 when quantise is off) — used for placing new notes. */
  snap(time: number, free = false): number { const p = this.state.project; if (!p || free) return time; return snapTime(time, p.grid, QUANTIZE_GRID_BEATS[p.settings.quantize.grid] || .25); }

  // ─────────────────────────── export ───────────────────────────
  exportMidi(split = false): MidiExportReport | null {
    const p = this.state.project; if (!p) return null; const report = transcriptionToMidi(p, { split });
    if (!report.notes) { this.fail(report.skipped ? "Every hit is on an unmapped lane (Unknown) — reclassify them or give the lane a MIDI note first" : "There are no notes to export yet"); return report; }
    this.deps.download?.(`${safeName(p.name)}.mid`, report.bytes, "audio/midi");
    this.set({ message: `Exported ${report.notes} notes to MIDI${report.skipped ? ` · ${report.skipped} unmapped hit${report.skipped === 1 ? "" : "s"} left out` : ""}` }); return report;
  }
  async exportJson(): Promise<void> { const p = this.state.project; if (!p) return; const ok = await this.deps.saveText?.(`${safeName(p.name)}.drums.json`, transcriptionToJson(p), "json"); if (ok) this.set({ message: "Transcription event list exported" }); }

  // ─────────────────────────── playback ───────────────────────────
  position(): number {
    const pb = this.play_; if (!pb) return this.stoppedAt; const linear = pb.pos0 + (pb.context.currentTime - pb.T0);
    return this.state.loop && pb.duration > 0 ? linear % pb.duration : Math.min(pb.duration, linear);
  }
  seek(t: number): void { const playing = !!this.play_; const at = clampTime(t, this.duration()); this.stop(); this.stoppedAt = at; if (playing) void this.play(at); else this.set({}); }
  toggle(): void { if (this.play_) this.pause(); else void this.play(); }
  pause(): void { const at = this.position(); this.stop(); this.stoppedAt = at; this.set({}); }
  stop(): void {
    const pb = this.play_; if (!pb) return; this.play_ = null; clearInterval(pb.timer);
    for (const n of pb.nodes) { try { n.stop(); } catch { /* already stopped */ } } try { pb.source?.stop(); } catch { /* not started */ }
    const t = pb.context.currentTime; for (const g of [pb.original, pb.midi]) { g.gain.setTargetAtTime(0, t, .01); setTimeout(() => g.disconnect(), 120); }
    this.stoppedAt = 0; this.set({ playing: false });
  }
  setLoop(loop: boolean): void { const at = this.position(); const playing = !!this.play_; this.stop(); this.stoppedAt = at; this.set({ loop }); if (playing) void this.play(at); }
  setMonitor(monitor: Monitor): void { this.set({ monitor }); this.applyGains(); }
  setVolume(kind: "original" | "midi", value: number): void { this.set(kind === "original" ? { originalVolume: Math.max(0, Math.min(1.5, value)) } : { midiVolume: Math.max(0, Math.min(1.5, value)) }); this.applyGains(); }
  private applyGains(): void {
    const pb = this.play_; if (!pb) return; const s = this.state; const t = pb.context.currentTime;
    pb.original.gain.setTargetAtTime(s.monitor === "midi" ? 0 : s.originalVolume, t, .008); pb.midi.gain.setTargetAtTime(s.monitor === "original" ? 0 : s.midiVolume, t, .008);
  }

  async play(from = this.stoppedAt): Promise<void> {
    if (!this.state.project || !this.deps.output) return; this.stop();
    try {
      const { context, input } = await this.deps.output(); await this.kit.load(context);
      const duration = this.duration(); if (duration <= 0) return; const pos0 = clampTime(from >= duration - .01 ? 0 : from, duration);
      const original = context.createGain(), midi = context.createGain(); original.gain.value = 0; midi.gain.value = 0; original.connect(input); midi.connect(input);
      const T0 = context.currentTime + .06; let source: AudioBufferSourceNode | null = null;
      if (this.decoded?.buffer) { source = context.createBufferSource(); source.buffer = this.decoded.buffer; if (this.state.loop) { source.loop = true; source.loopStart = 0; source.loopEnd = duration; } source.connect(original); source.start(T0, pos0); }
      const pb: Playback = { context, T0, pos0, original, midi, source, nodes: [], scheduledTo: pos0, duration, timer: setInterval(() => this.pump(), 25) };
      this.play_ = pb; this.set({ playing: true }); this.applyGains(); this.pump();
    } catch (e) { this.fail(e); }
  }
  /** Lookahead scheduler: MIDI preview notes up to 200 ms ahead on the same audio clock as the original. */
  private pump(): void {
    const pb = this.play_; const p = this.state.project; if (!pb || !p) return;
    const linear = pb.pos0 + (pb.context.currentTime - pb.T0); const until = linear + .2;
    if (!this.state.loop && linear >= pb.duration) { this.stop(); return; }
    if (this.notesFor !== p) { this.notesFor = p; this.notesCache = deriveNotes(p).notes; } const notes = this.notesCache; const D = pb.duration;
    const scheduleRange = (a: number, b: number, offset: number) => { for (const n of notes) if (n.quantisedTime >= a && n.quantisedTime < b) { const when = pb.T0 + offset + n.quantisedTime - pb.pos0; if (when >= pb.context.currentTime - .005) pb.nodes.push(...this.kit.trigger(pb.context, pb.midi, n.lane, n.velocity, Math.max(pb.context.currentTime, when))); } };
    if (this.state.loop) { for (let k = Math.floor(pb.scheduledTo / D); k * D < until; k++) { const a = Math.max(pb.scheduledTo, k * D), b = Math.min(until, (k + 1) * D); if (b > a) scheduleRange(a - k * D, b - k * D, k * D); } }
    else scheduleRange(pb.scheduledTo, Math.min(until, D), 0);
    pb.scheduledTo = until; if (pb.nodes.length > 512) pb.nodes.splice(0, pb.nodes.length - 512);
  }
  async audition(lane: DrumLane, velocity = 110): Promise<void> {
    if (!this.deps.output) return; try { const { context, input } = await this.deps.output(); await this.kit.load(context); const g = context.createGain(); g.gain.value = this.state.midiVolume; g.connect(input); this.kit.trigger(context, g, lane, velocity, context.currentTime + .005); setTimeout(() => g.disconnect(), 2500); } catch (e) { this.fail(e); }
  }

  dispose(): void { this.stop(); this.cancelAnalysis(); void this.flush(); }
}

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "drums";

function peaksOf(d: DecodedSource): Float32Array {
  const step = Math.max(1, Math.round(d.sampleRate / WAVE_RATE)); const n = Math.ceil((d.channels[0]?.length ?? 0) / step); const out = new Float32Array(n); let max = 1e-6;
  for (let i = 0; i < n; i++) { let m = 0; for (const ch of d.channels) { const end = Math.min(ch.length, (i + 1) * step); for (let j = i * step; j < end; j++) { const v = Math.abs(ch[j]); if (v > m) m = v; } } out[i] = m; if (m > max) max = m; }
  for (let i = 0; i < n; i++) out[i] /= max; return out;
}

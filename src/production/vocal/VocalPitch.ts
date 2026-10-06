/**
 * Vocal Studio Phase 2 — pitch correction service.
 *
 * - Analysis: YIN pitch track (Worker when available) + note segmentation, run after each recording or on demand.
 *   The f0 track is cached in memory and IndexedDB (`<take ref>#pitch`); the notes live in the project (undoable).
 * - Correction: per-track PitchSettings + per-note targets / bypass → correction curve → TD-PSOLA render,
 *   loudness-matched to the original. The take clip plays `production-vocal-render://<takeId>@<hash>` (computed on
 *   demand through ProductionStudio's buffer-provider hook); ORIGINAL plays the untouched take.
 * - Key: Detect Song Key (vocal notes + MIDI notes + audio backing chroma, Krumhansl–Kessler), project key.
 */
import type { ProductionStudio } from "../ProductionStudio";
import { loadRecording, saveRecording } from "../recordings";
import { defaultPitchSettings, type PitchSettings, type ProductionProject, type ProductionTrack, type VocalTake } from "../types";
import { correctionCurve, PITCH_PRESETS, type PitchPresetId } from "./pitchCorrect";
import { segmentNotes, trackPitch, type PitchTrack, type VocalNote } from "./pitchTrack";
import { activeRms, psolaShift } from "./psola";
import { analyseVocal, defaultChain, limit, PROCESSOR_ORDER, runChain, scaleChain, type ChainResult, type CleanupChain } from "./cleanup";
import { buildEnhance, ENHANCE_PRESETS, type EnhancePresetId } from "./enhance";
import { midiToHz } from "./pitchTrack";
import type { VocalChainSettings } from "../types";
import { chromaFromAudio, chromaFromNotes, detectKey, keyFit, scaleMask, type ScaleName } from "./scales";

export const RENDER_PREFIX = "production-vocal-render://";
const hash = (text: string): string => { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export interface PitchState { analysing: Record<string, number>; renderingRef: string | null; detectedKey: { root: number; scale: "major" | "minor"; confidence: number } | null; message: string }

export class VocalPitch {
  private state: PitchState = { analysing: {}, renderingRef: null, detectedKey: null, message: "" };
  private listeners = new Set<(s: PitchState) => void>();
  private tracks = new Map<string, PitchTrack>();
  private renders = new Map<string, Promise<AudioBuffer>>();
  /** Exactly what each render ref stands for, captured when the ref is made (renders never read later edits). */
  private snapshots = new Map<string, { pitch: { dsp: Omit<PitchSettings, "enabled" | "preset">; notes: VocalNote[] } | null; chain: { amount: number; processors: CleanupChain } | null }>();
  /** Gain-reduction traces, breaths and level spread of each rendered ref (for the ENHANCE tab readouts). */
  private results = new Map<string, Omit<ChainResult, "out">>();
  private worker: Worker | null | undefined;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private studio: ProductionStudio) {
    studio.registerBufferProvider(RENDER_PREFIX, (ref) => this.render(ref));
  }
  subscribe = (l: (s: PitchState) => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getState = (): PitchState => this.state;
  private set(patch: Partial<PitchState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); }

  private find(takeId: string, project: ProductionProject = this.studio.getState().project): { track: ProductionTrack; take: VocalTake } | null {
    for (const track of project.tracks) { const take = track.vocal?.takes.find((t) => t.id === takeId); if (take) return { track, take }; } return null;
  }
  settings(track: ProductionTrack): PitchSettings { const key = this.studio.getState().project.key; return track.vocal?.pitch ?? defaultPitchSettings(key?.root ?? 0, key?.scale ?? "major"); }
  mask(s: PitchSettings): boolean[] { return scaleMask(s.key, s.scale, s.custom); }

  // ── analysis ──
  private async runTracker(data: Float32Array, rate: number, onProgress: (p: number) => void): Promise<PitchTrack> {
    if (this.worker === undefined) { try { this.worker = new Worker(new URL("./pitch.worker.ts", import.meta.url), { type: "module" }); } catch { this.worker = null; } }
    const worker = this.worker; if (!worker) return trackPitch(data, rate, { onProgress });
    const id = Math.random();
    return new Promise((resolve, reject) => {
      const listen = (e: MessageEvent<{ id: number; progress?: number; track?: PitchTrack }>) => { if (e.data.id !== id) return; if (e.data.progress !== undefined) onProgress(e.data.progress); if (e.data.track) { worker.removeEventListener("message", listen); resolve(e.data.track); } };
      worker.addEventListener("message", listen); worker.addEventListener("error", (err) => { this.worker = null; worker.removeEventListener("message", listen); trackPitch(data, rate, { onProgress }).then(resolve, reject); void err; }, { once: true });
      worker.postMessage({ id, data: data.slice(), rate });
    });
  }
  /** f0 track of a take (memory → IndexedDB → computed). */
  async pitchTrackOf(take: VocalTake): Promise<PitchTrack> {
    const cached = this.tracks.get(take.ref); if (cached) return cached;
    const stored = await loadRecording(`${take.ref}#pitch`).catch(() => null);
    if (stored) { const header = new Float32Array(stored, 0, 2); const n = header[1]; const track = { hop: Math.round(header[0] * 1e7) / 1e7 /* stored as float32: restore the exact hop, or frame indexing drifts */, f0: new Float32Array(stored, 8, n), clarity: new Float32Array(stored, 8 + n * 4, n), levelDb: new Float32Array(stored, 8 + n * 8, n) }; this.tracks.set(take.ref, track); return track; }
    const buffer = await this.studio.getBuffer(take.ref);
    const track = await this.runTracker(buffer.getChannelData(0), buffer.sampleRate, (p) => this.set({ analysing: { ...this.state.analysing, [take.id]: p } }));
    this.tracks.set(take.ref, track);
    const n = track.f0.length; const blob = new Float32Array(2 + n * 3); blob[0] = track.hop; blob[1] = n; blob.set(track.f0, 2); blob.set(track.clarity, 2 + n); blob.set(track.levelDb, 2 + n * 2);
    await saveRecording(`${take.ref}#pitch`, blob.buffer).catch(() => undefined);
    return track;
  }
  /** Detects notes (and the take's own key) for a take; re-analysing replaces edited notes only with `force`. */
  async analyseTake(takeId: string, force = false): Promise<void> {
    const found = this.find(takeId); if (!found || this.state.analysing[takeId] !== undefined || (found.take.pitch && !force)) return;
    this.set({ analysing: { ...this.state.analysing, [takeId]: 0 }, message: `Analysing ${found.take.name}…` });
    try {
      const track = await this.pitchTrackOf(found.take);
      const notes = segmentNotes(track).filter((n) => n.end > found.take.offset && n.start < found.take.offset + found.take.duration);
      const key = detectKey(chromaFromNotes(notes.map((n) => ({ pitch: n.detected, duration: n.end - n.start }))));
      this.studio.updateVocal(found.track.id, (t) => { const take = t.vocal!.takes.find((x) => x.id === takeId); if (take) take.pitch = { notes, analysedAt: Date.now(), key }; this.syncClips(t); }, `${found.take.name}: ${notes.length} notes detected`, false);
      this.set({ message: `${found.take.name}: ${notes.length} notes detected` });
    } catch (error) { this.set({ message: `Pitch analysis failed: ${error instanceof Error ? error.message : String(error)}` }); }
    finally { const analysing = { ...this.state.analysing }; delete analysing[takeId]; this.set({ analysing }); }
  }

  // ── edits ──
  /** Every take clip on the track plays the tuned render when correction is on, otherwise the original take. */
  private syncClips(track: ProductionTrack): void {
    const s = this.settings(track); const chain = this.chainActive(track) ? track.vocal!.chain! : null; const listen = track.vocal?.listen !== "original";
    for (const clip of track.clips) { if (clip.type !== "audio" || !clip.takeId) continue; const take = track.vocal?.takes.find((t) => t.id === clip.takeId); if (!take) continue; const pitchOn = s.enabled && !!take.pitch?.notes.length; const next = listen && (pitchOn || chain) ? this.renderRef(take, pitchOn ? s : null, chain) : take.ref; if (next !== clip.ref) console.info("[vocal-syncClips] clip.ref", clip.ref, "→", next, { enabled: s.enabled, pitchOn, listen }); clip.ref = next; }
  }
  private renderRef(take: VocalTake, s: PitchSettings | null, chain: VocalChainSettings | null): string {
    let pitch: { dsp: Omit<PitchSettings, "enabled" | "preset">; notes: VocalNote[] } | null = null;
    if (s) { const { enabled: _enabled, preset: _preset, ...dsp } = s; void _enabled; void _preset; pitch = { dsp, notes: take.pitch?.notes ?? [] }; }
    const content = { pitch, chain: chain ? { amount: chain.amount, processors: chain.processors } : null };
    const ref = `${RENDER_PREFIX}${take.id}@${hash(JSON.stringify(content))}`;
    if (!this.snapshots.has(ref)) { this.snapshots.set(ref, JSON.parse(JSON.stringify(content))); if (this.snapshots.size > 64) this.snapshots.delete(this.snapshots.keys().next().value!); }
    return ref;
  }
  chainActive(track: ProductionTrack): boolean { const c = track.vocal?.chain; return !!c && c.amount > 0 && PROCESSOR_ORDER.some((id) => c.processors[id].on); }
  chain(track: ProductionTrack): VocalChainSettings { return track.vocal?.chain ?? { amount: 1, preset: null, processors: defaultChain(), report: null }; }
  /** Changes the cleanup chain (one undoable edit unless `undoable` is false, e.g. slider drags). */
  updateChain(trackId: string, change: (c: VocalChainSettings) => void, message = "Vocal chain updated", undoable = true): void {
    this.studio.updateVocal(trackId, (t) => { const c = JSON.parse(JSON.stringify(this.chain(t))) as VocalChainSettings; change(c); t.vocal!.chain = c; this.syncClips(t); }, message, undoable);
    this.warm(trackId);
  }
  /** ORIGINAL | ENHANCED A/B (not an undo step). */
  setListen(trackId: string, listen: "original" | "processed"): void { this.studio.updateVocal(trackId, (t) => { t.vocal!.listen = listen; this.syncClips(t); }, listen === "original" ? "Listening to the ORIGINAL take" : "Listening to the ENHANCED vocal", false); this.warm(trackId); }
  /** Readouts of the most recent render of a ref (gain reduction per processor, breaths, level swing). */
  resultOf(ref: string): Omit<ChainResult, "out"> | null { return this.results.get(ref) ?? null; }

  /**
   * AUTO ENHANCE VOCAL: analyses the take (noise floor, sibilance, level swing, spectrum, resonances, breaths) and
   * sets the whole chain + pitch correction for the preset, with a report of every decision. One undoable step.
   */
  async autoEnhance(trackId: string, takeId: string, preset: EnhancePresetId, amount = 1): Promise<string[]> {
    const found = this.find(takeId); if (!found) throw new Error("Choose a take");
    if (!found.take.pitch) await this.analyseTake(takeId); const take = this.find(takeId)!.take; const track = await this.pitchTrackOf(take);
    const buffer = await this.studio.getBuffer(take.ref); const voiced = (t: number) => track.f0[Math.min(track.f0.length - 1, Math.floor(t / track.hop))] > 0;
    const lowest = Math.min(...(take.pitch?.notes ?? []).map((n) => midiToHz(n.detected)), 400);
    const analysis = analyseVocal(buffer.getChannelData(0), buffer.sampleRate, voiced, Number.isFinite(lowest) ? lowest : 150);
    const built = buildEnhance(analysis, preset); const hasNotes = !!take.pitch?.notes.length;
    const report = [`Analysis: singing ${analysis.singDb.toFixed(0)} dB, background ${analysis.noiseFloorDb.toFixed(0)} dB, level swing ${analysis.spreadDb.toFixed(0)} dB, peak ${analysis.peakDb.toFixed(1)} dBFS`, ...built.report.filter((line) => hasNotes || !line.startsWith("Pitch correction"))];
    this.studio.updateVocal(trackId, (t) => {
      t.vocal!.chain = { amount, preset, processors: built.chain, report }; t.vocal!.listen = "processed";
      if (hasNotes) t.vocal!.pitch = { ...this.settings(t), ...PITCH_PRESETS[built.pitch].params, preset: built.pitch, enabled: true };
      this.syncClips(t);
    }, `Auto Enhance (${ENHANCE_PRESETS[preset].label})`);
    this.warm(trackId); return report;
  }
  updateSettings(trackId: string, patch: Partial<PitchSettings>, message = "Pitch correction updated", undoable = true): void {
    this.studio.updateVocal(trackId, (t) => { t.vocal!.pitch = { ...this.settings(t), ...patch }; if (["strength", "retuneMs", "humanize", "transitionMs", "drift", "preserve"].some((k) => k in patch) && !("preset" in patch)) t.vocal!.pitch.preset = "custom"; this.syncClips(t); }, message, undoable);
    this.warm(trackId);
  }
  applyPreset(trackId: string, preset: PitchPresetId): void { this.updateSettings(trackId, { ...PITCH_PRESETS[preset].params, preset, enabled: true }, `${PITCH_PRESETS[preset].label}`); }
  updateNotes(trackId: string, takeId: string, change: (notes: VocalNote[]) => VocalNote[] | void, message: string): void {
    this.studio.updateVocal(trackId, (t) => { const take = t.vocal!.takes.find((x) => x.id === takeId); if (!take?.pitch) return; const next = change(take.pitch.notes); if (next) take.pitch.notes = next; take.pitch.notes.sort((a, b) => a.start - b.start); this.syncClips(t); }, message);
    this.warm(trackId);
  }
  /** AUTO CORRECT ALL: every note of the take snaps to the nearest note of the key, correction on. */
  autoCorrectAll(trackId: string, takeId: string): void {
    this.studio.updateVocal(trackId, (t) => { t.vocal!.pitch = { ...this.settings(t), enabled: true }; const take = t.vocal!.takes.find((x) => x.id === takeId); for (const n of take?.pitch?.notes ?? []) { n.target = null; n.bypass = false; } this.syncClips(t); }, "Auto Correct All");
    this.warm(trackId);
  }
  /** Splits a note at `time` (seconds in the take file) into two notes. */
  splitNote(trackId: string, takeId: string, noteId: string, time: number): void {
    this.updateNotes(trackId, takeId, (notes) => { const i = notes.findIndex((n) => n.id === noteId); const n = notes[i]; if (!n || time <= n.start + .03 || time >= n.end - .03) return; notes.splice(i, 1, { ...n, end: time }, { ...n, id: `${n.id}s${Math.round(time * 1000)}`, start: time }); }, "Note split");
  }
  /** Joins the given notes into one (duration-weighted detected pitch; the first note's target). */
  joinNotes(trackId: string, takeId: string, ids: string[]): void {
    this.updateNotes(trackId, takeId, (notes) => { const sel = notes.filter((n) => ids.includes(n.id)); if (sel.length < 2) return; const dur = sel.reduce((s, n) => s + n.end - n.start, 0); const joined: VocalNote = { ...sel[0], start: Math.min(...sel.map((n) => n.start)), end: Math.max(...sel.map((n) => n.end)), detected: sel.reduce((s, n) => s + n.detected * (n.end - n.start), 0) / dur, vibrato: null }; return [...notes.filter((n) => !ids.includes(n.id)), joined]; }, "Notes joined");
  }

  // ── key ──
  /** Song key from analysed vocal notes, MIDI notes (not drums) and the audio backing (first 60 s of each source). */
  async detectSongKey(): Promise<PitchState["detectedKey"]> {
    const project = this.studio.getState().project; const chroma = new Array<number>(12).fill(0); const add = (c: number[], w: number) => { const total = c.reduce((s, x) => s + x, 0) || 1; c.forEach((x, i) => { chroma[i] += x / total * w; }); };
    const vocalNotes = project.tracks.flatMap((t) => t.vocal?.takes.flatMap((k) => k.pitch?.notes ?? []) ?? []); if (vocalNotes.length) add(chromaFromNotes(vocalNotes.map((n) => ({ pitch: n.target ?? n.detected, duration: n.end - n.start }))), 1);
    const midi = project.tracks.filter((t) => t.instrument && t.instrument.type !== "drums").flatMap((t) => t.clips.flatMap((c) => (c.type === "midi" ? c.notes : []))); if (midi.length) add(chromaFromNotes(midi.map((n) => ({ pitch: n.pitch, duration: n.duration }))), 1.5);
    const refs = [...new Set(project.tracks.filter((t) => t.kind === "audio" && !t.vocal).flatMap((t) => t.clips.flatMap((c) => (c.type === "audio" && !c.muted ? [c.ref] : []))))].slice(0, 6);
    for (const ref of refs) { try { const b = await this.studio.getBuffer(ref); add(chromaFromAudio(b.getChannelData(0), b.sampleRate, 60), 2); } catch { /* skip unreadable */ } }
    const key = detectKey(chroma); this.set({ detectedKey: key, message: key ? `Detected key ${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][key.root]} ${key.scale}` : "Not enough musical material to detect a key" }); return key;
  }
  setProjectKey(root: number, scale: ScaleName): void { this.studio.updateProject({ key: { root, scale } }); }
  /** Share of the take's note time that sits in the track's key/scale. */
  fit(track: ProductionTrack, take: VocalTake): number { return keyFit((take.pitch?.notes ?? []).map((n) => ({ pitch: n.detected, duration: n.end - n.start })), this.mask(this.settings(track))); }

  // ── render ──
  /** Tuned render for a render ref (cached; the ref's hash identifies settings + notes). */
  render(ref: string): Promise<AudioBuffer> {
    const cached = this.renders.get(ref); if (cached) return cached;
    const job = (async () => {
      const takeId = ref.slice(RENDER_PREFIX.length).split("@")[0]; const found = this.find(takeId); if (!found) throw new Error("This tuned take no longer exists");
      this.set({ renderingRef: ref });
      try {
        // The ref's own snapshot; after a reopen there is none yet, so rebuild it from the project (its hash then matches).
        if (!this.snapshots.has(ref)) { const s = this.settings(found.track); this.renderRef(found.take, s.enabled && found.take.pitch?.notes.length ? s : null, this.chainActive(found.track) ? found.track.vocal!.chain! : null); }
        const snap = this.snapshots.get(ref); if (!snap) throw new Error("Unknown tuned render");
        const original = await this.studio.getBuffer(found.take.ref); const data = original.getChannelData(0); const rate = original.sampleRate; const track = await this.pitchTrackOf(found.take);
        let out: Float32Array = data;
        if (snap.pitch) {
          const s = snap.pitch.dsp; const cents = correctionCurve(track, snap.pitch.notes, scaleMask(s.key, s.scale, s.custom), s); out = psolaShift(out, rate, track, cents, { formant: s.formant });
          let sum = 0, n = 0, maxC = 0; for (let i = 0; i < cents.length; i++) if (cents[i]) { sum += Math.abs(cents[i]); maxC = Math.max(maxC, Math.abs(cents[i])); n++; }
          let diffSum = 0; for (let i = 0; i < out.length; i++) diffSum += (out[i] - data[i]) ** 2; const diffRms = Math.sqrt(diffSum / out.length);
          console.info(`[vocal-render] ${ref} strength=${s.strength} retuneMs=${s.retuneMs} humanize=${s.humanize} drift=${s.drift} preserve=${s.preserve} notes=${snap.pitch.notes.length} avgAbsCents=${(n ? sum / n : 0).toFixed(1)} maxAbsCents=${maxC.toFixed(1)} voicedFrames=${n} diffVsOriginalRms=${diffRms.toFixed(5)}`);
        } else console.info(`[vocal-render] no pitch correction applied for ${ref}`);
        if (snap.chain) { const voiced = (t: number) => track.f0[Math.min(track.f0.length - 1, Math.floor(t / track.hop))] > 0; const r = runChain(out, rate, scaleChain(snap.chain.processors, snap.chain.amount), voiced); out = r.out; const { out: _o, ...readouts } = r; void _o; this.results.set(ref, readouts); }
        if (out === data) out = data.slice();
        // Loudness match so ORIGINAL / ENHANCED compare fairly, then keep the peaks under the ceiling.
        const gain = activeRms(out) > 0 ? Math.min(4, activeRms(data) / activeRms(out)) : 1; if (Math.abs(gain - 1) > .005) for (let i = 0; i < out.length; i++) out[i] *= gain;
        let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i])); if (peak > .989) out = limit(out, rate, { ceiling: snap.chain?.processors.limiter.on ? snap.chain.processors.limiter.ceiling : -.1, releaseMs: 60 }).out;
        const buffer = new AudioBuffer({ length: out.length, numberOfChannels: 1, sampleRate: original.sampleRate }); buffer.getChannelData(0).set(out); return buffer;
      } finally { if (this.state.renderingRef === ref) this.set({ renderingRef: null }); else this.set({}); }
    })();
    this.renders.set(ref, job); job.catch(() => this.renders.delete(ref));
    // Keep a handful of recent renders.
    if (this.renders.size > 8) this.renders.delete(this.renders.keys().next().value!);
    return job;
  }
  /** Pre-render after edits so the next play starts instantly. */
  private warm(trackId: string): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => { const t = this.studio.getState().project.tracks.find((x) => x.id === trackId); for (const c of t?.clips ?? []) if (c.type === "audio" && c.ref.startsWith(RENDER_PREFIX)) void this.render(c.ref).catch(() => undefined); }, 250);
  }
}

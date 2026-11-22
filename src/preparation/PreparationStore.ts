import { Emitter } from "../core/events";
import type { DeckState, PreparationPort } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import type { TrackAnalysis } from "../analysis/analyzeTrack";
import { ANALYSIS_VERSION, PREPARATION_SCHEMA, CUE_COLOURS, contentTrackId, EMPTY_CONTENT_ID, makeGrid, packWaveform, unpackWaveform, type PreparationPersistence, type TrackPreparation, type PreparedCue, type WaveformRecord } from "./types";
import { camelotKey } from "../analysis/discovery";

export interface PreparationStatus { revision: number; pending: number; error: string | null }

/** The energy shown everywhere: the user's override, else the multi-feature set energy, else the legacy estimate. */
export function effectiveEnergy(r: Pick<TrackPreparation, "energy" | "intel" | "setOverrides">): number | null {
  return r.setOverrides?.energy ?? r.intel?.energy ?? r.energy;
}

/** One content-addressed record per file, shared by both decks, imports and background analysis. */
export class PreparationStore extends Emitter<{ change: PreparationStatus; record: TrackPreparation }> implements PreparationPort {
  readonly ready: Promise<void>;
  private records = new Map<string, TrackPreparation>();
  private refs = new Map<string, string>();
  private dirty = new Map<string, TrackPreparation>();
  private waveformMemory = new Map<string, WaveformRecord>();
  private writing = Promise.resolve();
  private state: PreparationStatus = { revision: 0, pending: 0, error: null };
  constructor(readonly persistence: PreparationPersistence, private onError: (error: unknown) => void = () => undefined) {
    super();
    this.ready = persistence.list().then((rows) => {
      for (const r of rows.sort((a, b) => a.updatedAt - b.updatedAt)) {
        if (r.schemaVersion !== PREPARATION_SCHEMA) throw new Error("Preparation database uses an unsupported schema; existing data was left intact.");
        this.records.set(r.trackId, r);
        // Older builds hashed AudioBuffers after decodeAudioData detached them,
        // producing the empty-file hash and attaching many songs to one waveform.
        // Keep the row for non-destructive compatibility but never restore it.
        if (r.trackId !== EMPTY_CONTENT_ID) r.refs.forEach((ref) => this.refs.set(ref, r.trackId));
      }
      this.notify();
    });
    void this.ready.catch((e) => this.fail(e));
  }
  getState() { return this.state; }
  get(id: string) { return this.records.get(id); }
  forRef(ref: string) { const id = this.refs.get(ref); return id ? this.records.get(id) : undefined; }
  private notify(error = this.state.error) {
    this.state = { revision: this.state.revision + 1, pending: this.dirty.size, error };
    this.emit("change", this.state);
  }
  private fail(error: unknown) { this.notify(String(error)); this.onError(error); }
  private commit(record: TrackPreparation): TrackPreparation {
    const r = { ...record, updatedAt: Date.now() };
    this.records.set(r.trackId, r); r.refs.forEach((ref) => this.refs.set(ref, r.trackId));
    this.dirty.set(r.trackId, r);
    this.writing = this.writing.then(async () => {
      try {
        await this.persistence.save(r);
        if (this.dirty.get(r.trackId) === r) this.dirty.delete(r.trackId);
        this.notify(this.dirty.size ? this.state.error : null);
      } catch (e) { this.fail(e); }
    });
    this.emit("record", r); this.notify();
    return r;
  }
  async flush(): Promise<void> {
    await this.ready; await this.writing;
    for (const r of [...this.dirty.values()]) {
      await this.persistence.save(r);
      if (this.dirty.get(r.trackId) === r) this.dirty.delete(r.trackId);
    }
    this.notify(null);
  }
  async identify(track: TrackInfo, bytes: ArrayBuffer, duration = (track.durationMs ?? 0) / 1000): Promise<TrackPreparation> {
    await this.ready;
    // Always hash the bytes actually loaded; a reused path cannot attach cues to changed audio.
    const trackId = await contentTrackId(bytes);
    if (trackId === EMPTY_CONTENT_ID) throw new Error(`Cannot prepare empty audio data for ${track.title}`);
    let reassigned = false;
    for (const [id, record] of this.records) {
      if (id === trackId || !record.refs.includes(track.ref)) continue;
      this.commit({ ...record, refs: record.refs.filter((ref) => ref !== track.ref) });
      reassigned = true;
    }
    const old = this.records.get(trackId);
    if (old) {
      this.refs.set(track.ref, trackId);
      if (reassigned || !old.refs.includes(track.ref) || (duration > 0 && old.duration !== duration)) {
        return this.commit({ ...old, refs: [...new Set([...old.refs, track.ref])], duration: duration || old.duration });
      }
      return old;
    }
    return this.commit({ schemaVersion: PREPARATION_SCHEMA, trackId, refs: [track.ref], fileSize: bytes.byteLength,
      title: track.title, artist: track.artist, album: track.album, isrc: track.isrc ?? null, duration,
      bpm: track.bpm, key: track.key, keyConfidence: track.key ? 0.4 : 0, energy: null, energyConfidence: 0, sections: [], recommendedCues: [], gain: null,
      analysisVersion: null, analysedAt: null, updatedAt: Date.now(), beatGrid: null, cuePoint: 0, cues: [], savedLoops: [], lastLoop: null });
  }
  decorate(track: TrackInfo): TrackInfo {
    const r = this.forRef(track.ref);
    const confidences = r ? [r.beatGrid ? Math.min(1, r.beatGrid.confidence / 2) : null, r.key ? r.keyConfidence : null, r.energy !== null ? r.energyConfidence : null].filter((x): x is number => x !== null) : [];
    return r ? { ...track, trackId: r.trackId, bpm: r.beatGrid?.bpm ?? r.bpm ?? track.bpm, key: r.key ?? track.key,
      camelot: camelotKey(r.key ?? track.key), energy: effectiveEnergy(r), analysisConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
      hotCueCount: r.cues.filter((c) => c.type === "hotcue").length, savedLoopCount: r.savedLoops.length,
      prepared: r.analysisVersion !== null, durationMs: r.duration ? r.duration * 1000 : track.durationMs } : track;
  }
  async restore(track: TrackInfo, bytes: ArrayBuffer, duration: number, _deck: number): Promise<Partial<DeckState>> {
    if (track.source !== "local") return {};
    const r = await this.identify(track, bytes, duration);
    return { ...this.fields(r, duration), track: this.decorate(track) };
  }
  fields(r: TrackPreparation, duration = r.duration): Partial<DeckState> {
    const hotcues = Array<number | null>(8).fill(null);
    const cueDetails = Array<PreparedCue | null>(8).fill(null);
    for (const c of r.cues) if (c.type === "hotcue" && c.slot >= 0 && c.slot < 8 && c.timestamp >= 0 && c.timestamp <= duration) { hotcues[c.slot] = c.timestamp; cueDetails[c.slot] = c; }
    const loop = r.lastLoop && r.lastLoop.end <= duration ? { ...r.lastLoop, active: false } : null;
    return { cuePoint: Math.min(duration, Math.max(0, r.cuePoint)), hotcues, cueDetails, savedLoops: r.savedLoops.filter((l) => l.start >= 0 && l.end <= duration), beatGrid: r.beatGrid, loop };
  }
  changed(previous: DeckState, next: DeckState, patch: Partial<DeckState>): void {
    const id = next.track?.trackId, r = id ? this.get(id) : undefined;
    if (!r) return;
    let changed = false;
    const update = { ...r };
    if (patch.cuePoint !== undefined && previous.cuePoint !== next.cuePoint) { update.cuePoint = next.cuePoint; changed = true; }
    if (patch.hotcues || patch.cueDetails) {
      let cues = [...r.cues];
      for (let slot = 0; slot < next.hotcues.length; slot++) {
        if (previous.hotcues[slot] === next.hotcues[slot] && previous.cueDetails[slot] === next.cueDetails[slot]) continue;
        const old = cues.find((c) => c.type === "hotcue" && c.slot === slot);
        cues = cues.filter((c) => c.type !== "hotcue" || c.slot !== slot);
        const timestamp = next.hotcues[slot];
        if (timestamp !== null) cues.push({ slot, type: "hotcue", name: old?.name ?? String.fromCharCode(65 + slot), colour: old?.colour ?? CUE_COLOURS[slot], ...next.cueDetails[slot], timestamp });
        changed = true;
      }
      update.cues = cues;
    }
    if (patch.savedLoops) { update.savedLoops = next.savedLoops; changed = true; }
    if ("loop" in patch) {
      const loop = next.loop ? { start: next.loop.start, end: next.loop.end, beats: next.loop.beats } : null;
      if (JSON.stringify(loop) !== JSON.stringify(r.lastLoop)) {
        update.lastLoop = loop;
        const old = update.savedLoops.find((l) => l.slot === 0);
        update.savedLoops = update.savedLoops.filter((l) => l.slot !== 0);
        if (loop) update.savedLoops = [{ id: "loop-0", slot: 0, name: old?.name ?? "Last loop", colour: old?.colour ?? "#32ade6", ...loop }, ...update.savedLoops];
        changed = true;
      }
    }
    if ("beatGrid" in patch && next.beatGrid !== previous.beatGrid) {
      update.beatGrid = next.beatGrid ? makeGrid(next.beatGrid, next.duration, next.beatGrid.manuallyAdjusted ?? false, next.beatGrid.offset ?? 0) : null;
      update.bpm = next.beatGrid?.bpm ?? r.bpm; changed = true;
    }
    if (changed) this.commit(update);
  }
  /**
   * AI Set Studio: store derived intelligence and/or user overrides on a record. Never touches cues,
   * grids or analysis. No-op when nothing changed (callers react to `record` events, so this must be idempotent).
   */
  updateSetData(id: string, patch: { intel?: TrackPreparation["intel"]; setOverrides?: TrackPreparation["setOverrides"] | null; autoCues?: TrackPreparation["autoCues"] | null }): TrackPreparation | null {
    const r = this.get(id);
    if (!r) return null;
    const next: TrackPreparation = { ...r };
    if (patch.intel !== undefined) next.intel = patch.intel;
    if (patch.setOverrides === null) delete next.setOverrides;
    else if (patch.setOverrides !== undefined) next.setOverrides = patch.setOverrides;
    if (patch.autoCues === null) delete next.autoCues;
    else if (patch.autoCues !== undefined) next.autoCues = patch.autoCues;
    if (JSON.stringify(next.intel) === JSON.stringify(r.intel) && JSON.stringify(next.setOverrides) === JSON.stringify(r.setOverrides) && JSON.stringify(next.autoCues) === JSON.stringify(r.autoCues)) return r;
    return this.commit(next);
  }
  /**
   * AI Set Studio Auto Cue: put one hot cue into a slot of this app's cue database (the "Suggested" cue
   * source), or clear it. Callers decide (with the user's confirmation) whether replacing is allowed;
   * this never touches other slots, memory cues, loops or the grid.
   */
  setHotcue(id: string, slot: number, cue: Omit<PreparedCue, "slot" | "type"> | null): TrackPreparation | null {
    const r = this.get(id);
    if (!r || slot < 0 || slot >= 8) return null;
    const others = r.cues.filter((c) => c.type !== "hotcue" || c.slot !== slot);
    return this.commit({ ...r, cues: cue ? [...others, { ...cue, slot, type: "hotcue" }] : others });
  }
  /** Correct a track's beat grid by hand (saved as manually adjusted; analysis won't overwrite it). */
  editGrid(id: string, bpm: number, firstBeat: number): TrackPreparation | null {
    const r = this.get(id);
    return r ? this.setGrid(id, { bpm, firstBeat, confidence: r.beatGrid?.confidence ?? 1, source: r.beatGrid?.source ?? "metadata", phraseAnchor: r.beatGrid?.phraseAnchor ?? null }, true) : null;
  }
  /**
   * Replace a track's beat grid (BeatGridService makes every user edit through here). `manual` = set by
   * hand: re-analysis keeps a hand-set grid. Nothing else about the record changes.
   */
  setGrid(id: string, g: { bpm: number; firstBeat: number; confidence: number; source: "analysis" | "metadata" | "none"; phraseAnchor?: number | null }, manual: boolean): TrackPreparation | null {
    const r = this.get(id);
    if (!r || !(g.bpm >= 20 && g.bpm <= 400) || !Number.isFinite(g.firstBeat)) return null;
    const firstBeat = Math.max(0, g.firstBeat), before = r.beatGrid;
    const { phraseAnchor, ...rest } = g;
    const grid = makeGrid({ ...rest, firstBeat, ...(phraseAnchor !== null && phraseAnchor !== undefined ? { phraseAnchor } : {}) }, r.duration, manual, (before?.offset ?? 0) + firstBeat - (before?.firstBeat ?? firstBeat));
    return this.commit({ ...r, beatGrid: grid, bpm: g.bpm });
  }

  async waveform(id: string): Promise<TrackAnalysis | null> {
    const record = this.waveformMemory.get(id) ?? await this.persistence.loadWaveform(id);
    if (!record) return null;
    // A small LRU avoids keeping the entire library's dense waveforms in RAM.
    this.cache(record);
    try { return unpackWaveform(record); } catch (e) { this.fail(e); return null; }
  }
  private cache(record: WaveformRecord) {
    this.waveformMemory.delete(record.trackId); this.waveformMemory.set(record.trackId, record);
    while (this.waveformMemory.size > 4) this.waveformMemory.delete(this.waveformMemory.keys().next().value!);
  }
  /** `resuggest`: replace the auto-suggested hot cues with fresh ones even if some already exist — but never a cue the user placed or edited. */
  async saveAnalysis(id: string, a: TrackAnalysis, duration: number, track: TrackInfo, resuggest = false): Promise<void> {
    const cache = packWaveform(id, a);
    await this.persistence.saveWaveform(cache); this.cache(cache);
    const r = this.get(id);
    if (!r) return;
    const grid = r.beatGrid?.manuallyAdjusted ? r.beatGrid : a.bpm && a.firstBeat !== null ? makeGrid({ bpm: a.bpm, firstBeat: a.firstBeat, confidence: a.confidence, source: a.bpmSource }, duration) : null;
    let cues = r.cues;
    const hasHotcues = cues.some((c) => c.type === "hotcue");
    if (!hasHotcues || resuggest) {
      const suggested = a.hotCueSuggestions.slice(0, 8).map((c, slot) => ({
        slot, type: "hotcue" as const, timestamp: c.timestamp, name: c.label, colour: CUE_COLOURS[slot],
        comment: `Automatically detected ${c.kind}`, confidence: c.confidence, source: "analysis" as const,
      }));
      if (!hasHotcues) cues = suggested;
      else {
        const keep = cues.filter((c) => c.type !== "hotcue" || c.source !== "analysis");
        const keptSlots = new Set(keep.filter((c) => c.type === "hotcue").map((c) => c.slot));
        cues = [...keep, ...suggested.filter((c) => !keptSlots.has(c.slot))];
      }
    }
    this.commit({ ...r, title: track.title, artist: track.artist, album: track.album, isrc: track.isrc ?? r.isrc,
      duration, bpm: grid?.bpm ?? a.bpm, key: track.key ?? a.key ?? r.key, keyConfidence: track.key ? 0.4 : a.keyConfidence,
      energy: a.energy, energyConfidence: a.energyConfidence, sections: a.sections, recommendedCues: a.recommendedCues,
      gain: a.gainDb === null ? r.gain : { gainDb: a.gainDb, peak: a.peak, method: "rms-v1" },
      cues, beatGrid: grid, analysisVersion: ANALYSIS_VERSION, analysedAt: cache.analysedAt, gridFitVersion: a.gridFitVersion ?? 0 });
    await this.flush();
  }
  /** Analysed tracks whose grid predates the current whole-track grid fit (see AnalysisService.refitLibrary). */
  needingGridFit(version: number): string[] {
    return [...this.records.values()].filter((r) => r.analysisVersion !== null && (r.gridFitVersion ?? 0) < version).map((r) => r.trackId);
  }
  /**
   * Store a re-fitted grid for an already analysed track (bpm, first beat, confidence and source only — the
   * waveform, cues, key and everything else stay as they are, as does the analysis date). A grid set by hand
   * is kept; only the cached analysis and the version change for it. Returns the updated record.
   */
  async saveGridFit(id: string, a: Pick<TrackAnalysis, "bpm" | "firstBeat" | "confidence" | "bpmSource" | "gridFitVersion">): Promise<TrackPreparation | null> {
    const cached = this.waveformMemory.get(id) ?? await this.persistence.loadWaveform(id);
    if (cached) {
      const next: WaveformRecord = { ...cached, bpm: a.bpm, firstBeat: a.firstBeat, confidence: a.confidence, bpmSource: a.bpmSource, gridFitVersion: a.gridFitVersion ?? 0 };
      await this.persistence.saveWaveform(next); this.cache(next);
    }
    const r = this.get(id);
    if (!r) return null;
    const manual = !!r.beatGrid?.manuallyAdjusted;
    const grid = manual ? r.beatGrid : a.bpm && a.firstBeat !== null ? makeGrid({ bpm: a.bpm, firstBeat: a.firstBeat, confidence: a.confidence, source: a.bpmSource }, r.duration) : r.beatGrid;
    const next = this.commit({ ...r, beatGrid: grid, bpm: grid?.bpm ?? r.bpm, gridFitVersion: a.gridFitVersion ?? 0 });
    await this.flush();
    return next;
  }
  /** Portable, schema-versioned structure for a future backup/import UI. */
  async exportData(includeWaveforms = false) {
    await this.flush();
    const tracks = structuredClone([...this.records.values()]);
    const waveforms: WaveformRecord[] = [];
    if (includeWaveforms) for (const r of tracks) { const w = await this.persistence.loadWaveform(r.trackId); if (w) waveforms.push(w); }
    return { schemaVersion: PREPARATION_SCHEMA, exportedAt: Date.now(), tracks, waveforms };
  }
}

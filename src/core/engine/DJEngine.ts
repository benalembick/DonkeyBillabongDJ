/**
 * DJ Engine: owns deck/mixer state and DJ behaviour (cue logic, jog modes,
 * tempo, hot cues, mixer curves). It receives Commands from the CommandBus and
 * drives an AudioEngine. It knows nothing about React, MIDI or files.
 */
import { actionCatalog, BEATLOOP_SIZES, HOTCUE_COUNT, deckLetter, STEM_NAMES, STEM_LABELS, type StemName } from "../actions";
import type { CommandBus } from "../commands";
import { Emitter } from "../events";
import type { EventLog } from "../log";
import { DEFAULT_JOG_SETTINGS, jogIntent, type JogSettings } from "./jog";
import {
  clamp,
  crossfaderGains,
  dbToGain,
  EQ_KILL_DB,
  eqKnobToDb,
  faderToGain,
  filterKnobToParams,
  gainKnobToDb,
  headMixGains,
  type CrossfaderCurve,
} from "./mixerMath";
import type { AudioEngine, FxType, TrackInfo } from "./types";
import type { PreparedCue, SavedLoop } from "../../preparation/types";
import type { ManualMashupSetup } from "../../mashup/types";

export const TEMPO_RANGES = [0.06, 0.1, 0.16, 1.0] as const;
export const FX_TYPES: FxType[] = ["echo", "delay", "reverb", "flanger", "phaser", "filter", "bitcrusher", "distortion", "gate", "roll"];
export const FX_BEATS = [0.125, 0.25, 0.5, 0.75, 1, 2, 4] as const;
export const FX_SLOTS = 3;
/** Default FX1 / FX2 / FX3 assignment for each unit. */
export const DEFAULT_FX_ASSIGN: FxType[] = ["echo", "reverb", "flanger"];

export interface BeatGrid {
  offset?: number;
  manuallyAdjusted?: boolean;
  beatPositions?: number[];
  bpm: number;
  firstBeat: number;
  confidence: number;
  source: "analysis" | "metadata" | "none";
}

export type StemStatus = "off" | "waiting" | "loading" | "analysing" | "ready" | "error" | "unavailable";

export interface DeckStems {
  /** STEMS mode switched on for this deck (persists across track loads). */
  enabled: boolean;
  /** Per-stem volume 0..1 [vocals, drums, bass, instruments]. */
  volume: number[];
  muted: boolean[];
  status: StemStatus;
  /** Fraction of the track separated so far. */
  progress: number;
  message?: string;
}

export type FxTarget = "deck" | StemName;
export const FX_TARGETS: FxTarget[] = ["deck", ...STEM_NAMES];

export interface FxSlotState {
  type: FxType;
  on: boolean;
  param: number;
}

/** One FX unit (DDJ-SB: left unit = deck A, right unit = deck B) with three effect slots. */
export interface FxUnitState {
  target: FxTarget;
  slots: FxSlotState[];
  /** Unit dry/wet level (FX knob). */
  mix: number;
  beats: number;
  decks: boolean[];
}
const AT_CUE_TOLERANCE_S = 0.02;

export interface LoopState {
  start: number;
  end: number;
  /** Length in beats when created from the beat grid (null = free-length manual loop). */
  beats: number | null;
  active: boolean;
}

/** Auto-loop sizes offered in the UI (beats). */
export const LOOP_SIZES = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
/** Sync corrects phase with at most this much extra speed (inaudible), and ignores tiny errors. */
const PHASE_MAX_CORRECTION = 0.03;
const PHASE_DEADBAND_BEATS = 0.004;
const NUDGE_HOLDOFF_MS = 1500;

export interface DeckState {
  index: number;
  track: TrackInfo | null;
  status: "empty" | "loading" | "ready" | "error";
  error?: string;
  /** While loading/buffering a streamed track: 0..1 (null = unknown size). */
  loadProgress?: number | null;
  /** Network status for the deck (e.g. retrying after a dropped connection). */
  loadMessage?: string;
  duration: number;
  playing: boolean;
  cuePoint: number;
  /** True while CUE or a hot cue is held for preview on a paused deck. */
  previewing: boolean;
  /** Tempo slider, bipolar -1..1 (positive = faster). */
  tempo: number;
  tempoRange: number;
  rate: number;
  keylock: boolean;
  vinyl: boolean;
  sync: boolean;
  jogTouched: boolean;
  scratching: boolean;
  hotcues: (number | null)[];
  cueDetails: (PreparedCue | null)[];
  savedLoops: SavedLoop[];
  /** Estimated beat grid from analysis (null until analysed). */
  beatGrid: BeatGrid | null;
  stems: DeckStems;
  loop: LoopState | null;
  /** Pending LOOP IN point (manual loop), until LOOP OUT. */
  loopIn: number | null;
}

export interface ChannelState {
  gain: number;
  eqHigh: number;
  eqMid: number;
  eqLow: number;
  killHigh: boolean;
  killMid: boolean;
  killLow: boolean;
  filter: number;
  volume: number;
  pfl: boolean;
  mute: boolean;
}

export interface MixerState {
  channels: ChannelState[];
  crossfader: number;
  masterLevel: number;
  headMix: number;
  headLevel: number;
}

export interface EngineState {
  decks: DeckState[];
  mixer: MixerState;
  fx: FxUnitState[];
  /** Deck whose tempo/phase synced decks follow (null = none yet). */
  masterDeck: number | null;
}

export interface EngineSettings {
  jog: JogSettings;
  /** Pioneer/Technics convention: pulling the tempo slider towards you speeds up. */
  tempoDownIsFaster: boolean;
  crossfaderCurve: CrossfaderCurve;
  /** Refuse to load a new track into a deck that is currently playing. */
  lockPlayingDecks: boolean;
  /** Which decks sit on the left/right side of the crossfader. */
  crossfaderAssign: ("left" | "right" | "thru")[];
  /** Effect assigned to FX1/FX2/FX3 of each unit (persisted). */
  fxAssign: FxType[][];
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  jog: DEFAULT_JOG_SETTINGS,
  tempoDownIsFaster: true,
  crossfaderCurve: "additive",
  lockPlayingDecks: true,
  crossfaderAssign: ["left", "right", "left", "right"],
  fxAssign: [DEFAULT_FX_ASSIGN, DEFAULT_FX_ASSIGN],
};

/** Browser/library port used by browser.* actions. Implemented by the library layer. */
export interface BrowserPort {
  moveSelection(delta: number): void;
  getSelected(): TrackInfo | null;
}

export interface LoadProgress {
  /** 0..1 when the total size is known. */
  fraction: number | null;
  /** Network status, e.g. "Audius connection interrupted — retrying (2/5)…". */
  message?: string;
}
export type TrackBytesLoader = (track: TrackInfo, opts: { onProgress: (p: LoadProgress) => void; signal: AbortSignal }) => Promise<ArrayBuffer>;
export type SourcePolicy = (track: TrackInfo) => { ok: boolean; reason?: string };
export interface PreparationPort {
  restore(track: TrackInfo, bytes: ArrayBuffer, duration: number): Promise<Partial<DeckState>>;
  changed(previous: DeckState, next: DeckState, patch: Partial<DeckState>): void;
}

export type EngineEvent =
  | { type: "loadRequested"; deck: number; source: "manual" | "auto-dj" }
  | { type: "trackLoaded"; deck: number; track: TrackInfo; audioHandle: unknown }
  | { type: "trackUnloaded"; deck: number };

function initialDeck(index: number): DeckState {
  return {
    index,
    track: null,
    status: "empty",
    duration: 0,
    playing: false,
    cuePoint: 0,
    previewing: false,
    tempo: 0,
    tempoRange: 0.1,
    rate: 1,
    keylock: false,
    vinyl: true,
    sync: false,
    jogTouched: false,
    scratching: false,
    hotcues: new Array(HOTCUE_COUNT).fill(null),
    cueDetails: new Array(HOTCUE_COUNT).fill(null),
    savedLoops: [],
    beatGrid: null,
    stems: { enabled: false, volume: [1, 1, 1, 1], muted: [false, false, false, false], status: "off", progress: 0 },
    loop: null,
    loopIn: null,
  };
}

function initialChannel(): ChannelState {
  return {
    gain: 0.5,
    eqHigh: 0.5,
    eqMid: 0.5,
    eqLow: 0.5,
    killHigh: false,
    killMid: false,
    killLow: false,
    filter: 0.5,
    volume: 1,
    pfl: false,
    mute: false,
  };
}

export class DJEngine extends Emitter<{ state: EngineState; event: EngineEvent }> {
  readonly deckCount: number;
  private state: EngineState;
  private settings: EngineSettings;
  private loadTokens: number[];
  /** Per-deck: preview started from this point; play pressed during preview keeps playing. */
  private preview: { origin: number; latchPlay: boolean }[];
  private jogTicks: number[];
  private loadAborts: (AbortController | null)[] = [];
  private warnedUnimplemented = new Set<string>();

  private readonly bus: CommandBus;
  private readonly audio: AudioEngine;
  private readonly loadBytes: TrackBytesLoader;
  private readonly browser: BrowserPort;
  private readonly log: EventLog;
  private readonly canLoad: SourcePolicy;
  private readonly onBrowserLoad: ((deck: number, track: TrackInfo) => void) | null;
  private preparation: PreparationPort | null = null;
  private restoringPreparation = false;
  setPreparationPort(port: PreparationPort): void { this.preparation = port; }

  /** Update both copies of a prepared track, without changing live playback or activating loops. */
  refreshPreparation(trackId: string, fields: Partial<DeckState>): void {
    this.restoringPreparation = true;
    try {
      for (const d of this.state.decks) {
        if (d.status !== "ready" || d.track?.trackId !== trackId) continue;
        const { loop: _loop, ...metadata } = fields;
        this.patchDeck(d.index, metadata);
        if (fields.beatGrid) this.setBeatGrid(d.index, fields.beatGrid);
      }
    } finally { this.restoringPreparation = false; }
  }

  /** A cue point for this session only (rehearsals): CUE returns to it, but it isn't saved to the track. */
  setSessionCue(deck: number, seconds: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    this.restoringPreparation = true;
    try {
      this.patchDeck(deck, { cuePoint: clamp(seconds, 0, d.duration) });
    } finally { this.restoringPreparation = false; }
  }

  editBeatGrid(deck: number, bpm: number, firstBeat: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready" || !Number.isFinite(bpm) || bpm < 20 || bpm > 400 || !Number.isFinite(firstBeat) || firstBeat < 0 || firstBeat >= d.duration) return;
    this.setBeatGrid(deck, { bpm, firstBeat, confidence: d.beatGrid?.confidence ?? 1, source: d.beatGrid?.source ?? "metadata",
      manuallyAdjusted: true, offset: (d.beatGrid?.offset ?? 0) + firstBeat - (d.beatGrid?.firstBeat ?? firstBeat) });
  }

  editHotcue(deck: number, slot: number, patch: Partial<Pick<PreparedCue, "timestamp" | "name" | "colour">>): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready" || slot < 0 || slot >= HOTCUE_COUNT || d.hotcues[slot] === null) return;
    const timestamp = patch.timestamp ?? d.hotcues[slot]!;
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > d.duration) return;
    const hotcues = d.hotcues.slice(), cueDetails = d.cueDetails.slice();
    hotcues[slot] = timestamp;
    cueDetails[slot] = { slot, type: "hotcue", name: String.fromCharCode(65 + slot), colour: "#ff5f57", ...cueDetails[slot], ...patch, timestamp };
    this.patchDeck(deck, { hotcues, cueDetails });
  }

  keepLoop(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready" || !d.loop || d.savedLoops.length >= 32) return;
    let slot = 1; while (d.savedLoops.some((l) => l.slot === slot)) slot++;
    const loop: SavedLoop = { id: `loop-${slot}`, slot, name: `Loop ${slot}`, colour: "#32ade6", start: d.loop.start, end: d.loop.end, beats: d.loop.beats };
    this.patchDeck(deck, { savedLoops: [...d.savedLoops, loop] });
  }
  editSavedLoop(deck: number, id: string, patch: Partial<Pick<SavedLoop, "name" | "colour" | "start" | "end">>): void {
    const d = this.state.decks[deck], old = d.savedLoops.find((l) => l.id === id);
    if (!old || d.status !== "ready") return;
    const loop = { ...old, ...patch };
    if (![loop.start, loop.end].every(Number.isFinite) || loop.start < 0 || loop.end > d.duration || loop.end - loop.start < 0.01) return;
    if (patch.start !== undefined || patch.end !== undefined) loop.beats = this.beatLength(deck) ? (loop.end - loop.start) / this.beatLength(deck)! : null;
    this.patchDeck(deck, { savedLoops: d.savedLoops.map((l) => l.id === id ? loop : l) });
    if (loop.slot === 0) this.setLoop(deck, { start: loop.start, end: loop.end, beats: loop.beats, active: d.loop?.active ?? false });
  }
  recallSavedLoop(deck: number, id: string): void {
    const d = this.state.decks[deck], loop = d.savedLoops.find((l) => l.id === id);
    if (!loop || d.status !== "ready") return;
    this.setLoop(deck, { start: loop.start, end: loop.end, beats: loop.beats, active: true });
    this.seekTo(deck, loop.start);
  }
  deleteSavedLoop(deck: number, id: string): void {
    const d = this.state.decks[deck], loop = d.savedLoops.find((l) => l.id === id);
    if (!loop || d.status !== "ready") return;
    if (loop.slot === 0) this.setLoop(deck, null);
    this.patchDeck(deck, { savedLoops: this.state.decks[deck].savedLoops.filter((l) => l.id !== id) });
  }

  constructor(opts: {
    bus: CommandBus;
    audio: AudioEngine;
    loadBytes: TrackBytesLoader;
    browser: BrowserPort;
    log: EventLog;
    deckCount?: number;
    settings?: Partial<EngineSettings>;
    /** Decides whether a track's source permits loading it into the mixer (default: local files only). */
    canLoad?: SourcePolicy;
    /** Handles controller/keyboard "load selected" (e.g. routes streaming tracks through Smart Match). */
    onBrowserLoad?: (deck: number, track: TrackInfo) => void;
  }) {
    super();
    this.onBrowserLoad = opts.onBrowserLoad ?? null;
    this.canLoad = opts.canLoad ?? ((t) => (t.source === "local" ? { ok: true } : { ok: false, reason: `${t.source} audio cannot be mixed` }));
    this.bus = opts.bus;
    this.audio = opts.audio;
    this.loadBytes = opts.loadBytes;
    this.browser = opts.browser;
    this.log = opts.log;
    this.deckCount = opts.deckCount ?? 2;
    this.settings = { ...DEFAULT_ENGINE_SETTINGS, ...opts.settings };
    this.state = {
      decks: Array.from({ length: this.deckCount }, (_, i) => initialDeck(i)),
      mixer: {
        channels: Array.from({ length: this.deckCount }, initialChannel),
        crossfader: 0.5,
        masterLevel: 0.8,
        headMix: 0.3,
        headLevel: 0.8,
      },
      fx: [0, 1].map((u) => ({
        target: "deck" as FxTarget,
        slots: Array.from({ length: FX_SLOTS }, (_, k) => ({
          type: (this.settings.fxAssign[u]?.[k] && FX_TYPES.includes(this.settings.fxAssign[u][k]) ? this.settings.fxAssign[u][k] : DEFAULT_FX_ASSIGN[k]) as FxType,
          on: false,
          param: 0.5,
        })),
        mix: 0.5,
        beats: 0.75,
        decks: Array.from({ length: this.deckCount }, (_, i) => i === u),
      })),
      masterDeck: null,
    };
    this.loadTokens = new Array(this.deckCount).fill(0);
    this.preview = Array.from({ length: this.deckCount }, () => ({ origin: 0, latchPlay: false }));
    this.jogTicks = new Array(this.deckCount).fill(0);

    this.audio.on((e) => {
      if (e.type === "ended") this.patchDeck(e.deck, { playing: false, previewing: false });
    });

    this.registerHandlers();
    this.applyMixer();
    this.applyAllFx();
  }

  // ───────────────────────────── public API ─────────────────────────────

  getState(): EngineState {
    return this.state;
  }

  /** Serializable snapshot of all controls which shape a two-deck performance. */
  captureManualMashupSetup(): ManualMashupSetup {
    const s = this.state;
    return {
      decks: s.decks.slice(0, 2).map((d) => ({ rate: d.rate, tempoRange: d.tempoRange, keylock: d.keylock, vinyl: d.vinyl, sync: d.sync, stems: { enabled: d.stems.enabled, muted: d.stems.muted.slice(), volume: d.stems.volume.slice() } })),
      channels: s.mixer.channels.slice(0, 2).map((c) => ({ ...c })),
      mixer: { crossfader: s.mixer.crossfader, masterLevel: s.mixer.masterLevel, headMix: s.mixer.headMix, headLevel: s.mixer.headLevel },
      fx: s.fx.map((f) => ({ ...f, slots: f.slots.map((slot) => ({ ...slot })), decks: f.decks.slice() })),
      masterDeck: s.masterDeck,
    };
  }

  /** Restore a manual mashup after its source tracks have been loaded. */
  restoreManualMashupSetup(setup: ManualMashupSetup): void {
    setup.decks.slice(0, this.deckCount).forEach((saved, deck) => {
      this.setRateDirect(deck, saved.rate);
      this.patchDeck(deck, { tempoRange: saved.tempoRange, vinyl: saved.vinyl, sync: saved.sync });
      this.setKeylock(deck, saved.keylock);
      this.patchStems(deck, { enabled: saved.stems.enabled, muted: saved.stems.muted.slice(), volume: saved.stems.volume.slice() });
    });
    setup.channels.slice(0, this.deckCount).forEach((channel, i) => this.patchChannel(i, { ...channel }));
    this.patchMixer({ ...setup.mixer });
    setup.fx.slice(0, this.state.fx.length).forEach((fx, i) => this.patchFx(i, { ...fx, slots: fx.slots.map((slot) => ({ ...slot })), decks: fx.decks.slice() }));
    this.patchState({ masterDeck: setup.masterDeck });
  }

  refreshTrackMetadata(tracks: TrackInfo[]): void {
    for (const d of this.state.decks) {
      const track = d.track && tracks.find((t) => t.ref === d.track!.ref);
      if (track && track !== d.track) this.patchDeck(d.index, { track: d.track?.resolvedFrom ? { ...track, resolvedFrom: d.track.resolvedFrom } : track });
    }
  }

  getSettings(): EngineSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<EngineSettings>): void {
    this.settings = { ...this.settings, ...patch, jog: { ...this.settings.jog, ...patch.jog } };
    this.applyMixer();
    for (let d = 0; d < this.deckCount; d++) this.applyTempo(d, this.state.decks[d].tempo);
  }

  // ───────────────────────────── STEMS ─────────────────────────────

  private stemsSupport: { ok: boolean; reason?: string } = { ok: false, reason: "STEM separation is starting up…" };

  /** Set by the stem service: whether separation is possible here (desktop app, model installed, mode not Off). */
  setStemsSupport(ok: boolean, reason?: string): void {
    this.stemsSupport = { ok, reason };
    for (let d = 0; d < this.deckCount; d++) {
      const st = this.state.decks[d].stems;
      if (!ok && st.status !== "unavailable") this.patchStems(d, { enabled: false, status: "unavailable", progress: 0, message: reason });
      if (ok && st.status === "unavailable") this.patchStems(d, { status: this.state.decks[d].status === "ready" ? "waiting" : "off", message: undefined });
    }
  }

  getStemsSupport(): { ok: boolean; reason?: string } {
    return this.stemsSupport;
  }

  /** Progress/status updates from the stem service. */
  setStemStatus(deck: number, patch: Partial<Pick<DeckStems, "status" | "progress" | "message">>): void {
    if (!this.state.decks[deck]) return;
    this.patchStems(deck, patch);
  }

  setStemsEnabled(deck: number, enabled: boolean): void {
    if (enabled && !this.stemsSupport.ok) {
      this.log.warn("engine", `STEMS unavailable: ${this.stemsSupport.reason ?? "not supported here"}`);
      return;
    }
    this.patchStems(deck, { enabled });
  }

  /** Atomic STEM routing for Live Mashup and automation. */
  setStemMix(deck: number, selected: boolean[], levels: number[]): void {
    if (!this.state.decks[deck] || selected.length !== 4 || levels.length !== 4) return;
    if (!this.stemsSupport.ok) {
      this.log.warn("engine", `STEMS unavailable: ${this.stemsSupport.reason ?? "not supported here"}`); return;
    }
    this.patchStems(deck, { enabled: true, muted: selected.map((v) => !v), volume: levels.map((v) => clamp(v, 0, 1)) });
  }

  private toggleStem(deck: number, k: number): void {
    const st = this.state.decks[deck].stems;
    if (!st.enabled) this.setStemsEnabled(deck, true);
    const muted = st.muted.slice();
    muted[k] = !muted[k];
    this.patchStems(deck, { muted });
  }

  /** Solo a stem; pressing solo on an already-solo'd stem brings every stem back. */
  private isolateStem(deck: number, k: number): void {
    const st = this.state.decks[deck].stems;
    if (!st.enabled) this.setStemsEnabled(deck, true);
    const soloed = st.muted.every((m, j) => (j === k ? !m : m));
    this.patchStems(deck, { muted: soloed ? [false, false, false, false] : st.muted.map((_, j) => j !== k) });
  }

  private setStemVolume(deck: number, k: number, v: number): void {
    const volume = this.state.decks[deck].stems.volume.slice();
    volume[k] = clamp(v, 0, 1);
    this.patchStems(deck, { volume });
  }

  private patchStems(deck: number, patch: Partial<DeckStems>): void {
    const d = this.state.decks[deck];
    this.patchDeck(deck, { stems: { ...d.stems, ...patch } });
    if ("enabled" in patch || "muted" in patch || "volume" in patch) this.applyStems(deck);
  }

  private applyStems(deck: number): void {
    const st = this.state.decks[deck].stems;
    this.audio.stemsMix(deck, st.enabled, st.volume.map((v, k) => (st.muted[k] ? 0 : v)));
  }

  /** Human label for a stem index (for logs/UI). */
  static stemLabel(k: number): string {
    return STEM_LABELS[STEM_NAMES[k]];
  }

  /** Called by the analysis service when a deck's beat grid is known. */
  setBeatGrid(deck: number, grid: BeatGrid): void {
    if (!this.state.decks[deck] || this.state.decks[deck].status !== "ready") return;
    this.patchDeck(deck, { beatGrid: grid });
    this.applyAllFx();
    if (this.state.decks[deck].sync || this.state.masterDeck === deck) this.syncFollowers();
  }

  // ───────────────────────────── SYNC ─────────────────────────────

  private lastNudge: number[] = [];

  /** Track BPM before pitch (analysed grid, else tag/service BPM). */
  baseBpm(deck: number): number | null {
    const d = this.state.decks[deck];
    return d ? (d.beatGrid?.bpm ?? d.track?.bpm ?? null) : null;
  }

  /** Beat length in track seconds, or null without a BPM. */
  beatLength(deck: number): number | null {
    const b = this.baseBpm(deck);
    return b ? 60 / b : null;
  }

  /**
   * Called ~25×/s by the app: keeps synced decks phase-locked to the master
   * with tiny, inaudible speed corrections (never jumps).
   */
  tick(): void {
    const m = this.state.masterDeck;
    if (m === null) return;
    for (let f = 0; f < this.deckCount; f++) {
      const fd = this.state.decks[f];
      if (f === m || !fd.sync || fd.status !== "ready") continue;
      const base = this.followRate(f, m);
      if (!base) continue;
      const err = this.phaseError(f, m);
      let rate = base.rate;
      const recentlyNudged = Date.now() - (this.lastNudge[f] ?? 0) < NUDGE_HOLDOFF_MS;
      if (err !== null && !recentlyNudged && Math.abs(err) > PHASE_DEADBAND_BEATS) {
        // Remove the error over about one second: Δrate = error (track seconds) per second.
        const bl = this.beatLength(f)!;
        rate += clamp(-err * bl, -PHASE_MAX_CORRECTION * base.rate, PHASE_MAX_CORRECTION * base.rate);
      }
      this.audio.setRate(f, rate);
    }
  }

  /** Follower rate that matches the master's BPM (half/double tempo allowed), or null. */
  private followRate(f: number, m: number): { rate: number; multiple: number } | null {
    const bf = this.baseBpm(f);
    const bm = this.baseBpm(m);
    if (!bf || !bm) return null;
    const target = bm * this.state.decks[m].rate;
    let best = { rate: target / bf, multiple: 1 };
    for (const k of [0.5, 2]) {
      const r = (target * k) / bf;
      if (Math.abs(r - 1) < Math.abs(best.rate - 1)) best = { rate: r, multiple: k };
    }
    return best;
  }

  /** Beat-phase difference follower − master in beats, in [-0.5, 0.5); null when phase can't be compared. */
  phaseError(f: number, m: number): number | null {
    const fd = this.state.decks[f];
    const md = this.state.decks[m];
    const fr = this.followRate(f, m);
    if (!fd.beatGrid || !md.beatGrid || !fr || fr.multiple !== 1) return null;
    if (!fd.playing || !md.playing || fd.scratching || md.scratching || fd.jogTouched || md.jogTouched) return null;
    const bf = (this.audio.getPosition(f) - fd.beatGrid.firstBeat) / (60 / fd.beatGrid.bpm);
    const bm = (this.audio.getPosition(m) - md.beatGrid.firstBeat) / (60 / md.beatGrid.bpm);
    const e = bf - bm;
    return e - Math.round(e);
  }

  /** Training: while locked, SYNC can't be switched on (from any input) and is switched off now. */
  private syncLock: string | null = null;
  lockSync(reason: string | null): void {
    this.syncLock = reason;
    if (reason) for (const d of this.state.decks) if (d.sync) this.patchDeck(d.index, { sync: false });
  }
  isSyncLocked(): boolean {
    return this.syncLock !== null;
  }

  private toggleSync(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    if (!d.sync && this.syncLock) {
      this.log.info("engine", this.syncLock);
      return;
    }
    if (d.sync) {
      this.patchDeck(deck, { sync: false });
      return;
    }
    if (!this.baseBpm(deck)) {
      this.log.warn("engine", `Deck ${deckLetter(deck)}: can't SYNC yet — no BPM (analysis still running?)`);
      return;
    }
    let m = this.state.masterDeck;
    if (m === null || m === deck || !this.baseBpm(m) || this.state.decks[m].status !== "ready") {
      m = this.pickMaster(deck);
      if (m === null) {
        // Nothing to follow: this deck leads.
        this.patchState({ masterDeck: deck });
        this.patchDeck(deck, { sync: true });
        return;
      }
      this.patchState({ masterDeck: m });
    }
    this.patchDeck(deck, { sync: true });
    this.matchTempo(deck, m);
    // Both playing: snap onto the beat once (short de-clicked jump), then the phase lock keeps it there.
    const err = this.phaseError(deck, m);
    const bl = this.beatLength(deck);
    if (err !== null && bl && Math.abs(err) > 0.02) this.seekTo(deck, this.audio.getPosition(deck) - err * bl);
  }

  /** Another loaded deck with a BPM, preferring one that is playing. */
  private pickMaster(except: number): number | null {
    let best: number | null = null;
    for (let i = 0; i < this.deckCount; i++) {
      const d = this.state.decks[i];
      if (i === except || d.status !== "ready" || !this.baseBpm(i)) continue;
      if (best === null || (d.playing && !this.state.decks[best].playing)) best = i;
    }
    return best;
  }

  /** Make a deck the tempo master (synced decks follow it). */
  setMaster(deck: number): void {
    const d = this.state.decks[deck];
    if (!d || d.status !== "ready") return;
    this.patchState({ masterDeck: deck });
    this.syncFollowers();
  }

  private reassignMaster(leaving: number): void {
    const next = this.pickMaster(leaving);
    this.patchState({ masterDeck: next });
  }

  /** Re-match every synced follower's tempo (after the master's tempo or grid changed). */
  private syncFollowers(): void {
    const m = this.state.masterDeck;
    if (m === null) return;
    for (let f = 0; f < this.deckCount; f++) if (f !== m && this.state.decks[f].sync) this.matchTempo(f, m);
  }

  private matchTempo(f: number, m: number): void {
    const r = this.followRate(f, m);
    if (r) this.setRateDirect(f, r.rate);
  }

  /** Set an exact playback rate, widening the tempo range if needed so the slider stays truthful. */
  setRateDirect(deck: number, rate: number): void {
    const d = this.state.decks[deck];
    let range = d.tempoRange;
    if (Math.abs(rate - 1) > range + 1e-9) range = TEMPO_RANGES.find((r) => r >= Math.abs(rate - 1)) ?? 1;
    const tempo = clamp((rate - 1) / range, -1, 1);
    this.audio.setRate(deck, rate);
    this.patchDeck(deck, { tempo, rate, tempoRange: range });
    this.applyAllFx();
  }

  // ───────────────────────────── LOOPS ─────────────────────────────

  private rolls: ({ origin: number; startedAt: number; rate: number; prev: LoopState | null } | null)[] = [];
  private warnedNoBpm = new Set<number>();

  /** Seek; leaving an active loop's range exits the loop (it stays available for RELOOP). */
  seekTo(deck: number, seconds: number): void {
    const d = this.state.decks[deck];
    const t = clamp(seconds, 0, Math.max(0, d.duration));
    const lp = d.loop;
    if (lp?.active && (t < lp.start - 0.001 || t >= lp.end)) this.setLoop(deck, { ...lp, active: false });
    this.audio.seek(deck, t);
  }

  private setLoop(deck: number, loop: LoopState | null): void {
    this.patchDeck(deck, { loop });
    this.audio.setLoop(deck, loop?.active ? { start: loop.start, end: loop.end } : null);
  }

  private beatLenOrDefault(deck: number): number {
    const bl = this.beatLength(deck);
    if (bl) return bl;
    if (!this.warnedNoBpm.has(deck)) {
      this.warnedNoBpm.add(deck);
      this.log.warn("engine", `Deck ${deckLetter(deck)}: no BPM yet — loops assume 120 BPM until the track is analysed.`);
    }
    return 0.5;
  }

  /** Nearest beat-grid position (quantize), or t itself without a grid. */
  private quantize(deck: number, t: number): number {
    const g = this.state.decks[deck].beatGrid;
    if (!g) return t;
    const bl = 60 / g.bpm;
    const q = g.firstBeat + Math.round((t - g.firstBeat) / bl) * bl;
    return Math.abs(q - t) < bl * 0.5 ? Math.max(0, q) : t;
  }

  /** Auto loop of `beats` starting on the beat (or sub-beat) the playhead is in; pressing the same size again exits. */
  beatLoop(deck: number, beats: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    if (d.loop?.active && d.loop.beats === beats) {
      this.setLoop(deck, { ...d.loop, active: false });
      return;
    }
    this.setLoop(deck, this.makeBeatLoop(deck, beats));
  }

  private makeBeatLoop(deck: number, beats: number): LoopState {
    const d = this.state.decks[deck];
    const bl = this.beatLenOrDefault(deck);
    const len = beats * bl;
    const pos = this.audio.getPosition(deck);
    let start = pos;
    if (d.beatGrid) {
      const unit = beats >= 1 ? bl : len;
      start = d.beatGrid.firstBeat + Math.floor((pos - d.beatGrid.firstBeat) / unit + 1e-6) * unit;
      if (start < 0 || start + len <= pos) start = pos;
    }
    return { start, end: Math.min(start + len, d.duration), beats, active: true };
  }

  /** Loop roll: loops while held; on release playback continues where it would have been (slip). */
  private loopRoll(deck: number, beats: number, down: boolean): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    if (down) {
      if (!this.rolls[deck]) this.rolls[deck] = { origin: this.audio.getPosition(deck), startedAt: performance.now(), rate: d.playing ? d.rate : 0, prev: d.loop };
      this.setLoop(deck, this.makeBeatLoop(deck, beats));
      return;
    }
    const r = this.rolls[deck];
    if (!r) return;
    this.rolls[deck] = null;
    this.setLoop(deck, r.prev ? { ...r.prev, active: false } : null);
    this.audio.seek(deck, clamp(r.origin + ((performance.now() - r.startedAt) / 1000) * r.rate, 0, d.duration));
  }

  private loopIn(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    this.patchDeck(deck, { loopIn: this.quantize(deck, this.audio.getPosition(deck)) });
  }

  private loopOut(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    const start = d.loopIn ?? d.loop?.start ?? null;
    if (start === null) return;
    const end = this.quantize(deck, this.audio.getPosition(deck));
    if (end - start < 0.01) return;
    const bl = this.beatLength(deck);
    const beats = bl ? Math.round(((end - start) / bl) * 100) / 100 : null;
    this.patchDeck(deck, { loopIn: null });
    this.setLoop(deck, { start, end, beats, active: true });
  }

  /** EXIT while looping; RELOOP (jump back into the last loop) otherwise. */
  private loopExit(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready" || !d.loop) return;
    if (d.loop.active) {
      this.setLoop(deck, { ...d.loop, active: false });
      return;
    }
    const pos = this.audio.getPosition(deck);
    this.setLoop(deck, { ...d.loop, active: true });
    if (pos < d.loop.start || pos >= d.loop.end) this.audio.seek(deck, d.loop.start);
  }

  private resizeLoop(deck: number, factor: number): void {
    const d = this.state.decks[deck];
    const lp = d.loop;
    if (!lp) return;
    const len = (lp.end - lp.start) * factor;
    if (len < 0.01 || lp.start + len > d.duration) return;
    const next: LoopState = { ...lp, end: lp.start + len, beats: lp.beats ? lp.beats * factor : null };
    this.setLoop(deck, next);
    const pos = this.audio.getPosition(deck);
    if (lp.active && pos >= next.end) this.audio.seek(deck, next.start + ((pos - next.start) % len));
  }

  private moveLoop(deck: number, dir: 1 | -1): void {
    const d = this.state.decks[deck];
    const lp = d.loop;
    if (!lp) return;
    const shift = (lp.end - lp.start) * dir;
    if (lp.start + shift < 0 || lp.end + shift > d.duration) return;
    this.setLoop(deck, { ...lp, start: lp.start + shift, end: lp.end + shift });
    if (lp.active) this.audio.seek(deck, clamp(this.audio.getPosition(deck) + shift, 0, d.duration));
  }

  /** Current tempo of a deck in BPM (analysed or metadata BPM x pitch), or null. */
  getBpm(deck: number): number | null {
    const d = this.state.decks[deck];
    if (!d) return null;
    const base = d.beatGrid?.bpm ?? d.track?.bpm ?? null;
    return base ? base * d.rate : null;
  }

  getPosition(deck: number): number {
    return this.audio.getPosition(deck);
  }

  /** Cumulative jog ticks since start (for calibrating ticks-per-revolution). */
  getJogTicks(deck: number): number {
    return this.jogTicks[deck] ?? 0;
  }

  resetJogTicks(deck: number): void {
    this.jogTicks[deck] = 0;
  }

  /**
   * Controller feedback (LEDs). Returns 0..1 for a feedback key such as
   * "deck1.playing", "deck1.hotcue.3", "mixer.channel2.cue".
   */
  getFeedback(key: string): number {
    const deckMatch = /^deck(\d+)\.(.+)$/.exec(key);
    if (deckMatch) {
      const d = this.state.decks[Number(deckMatch[1]) - 1];
      if (!d) return 0;
      const f = deckMatch[2];
      switch (f) {
        case "playing":
          return d.playing ? 1 : 0;
        case "cue":
          return d.playing || d.previewing || (d.status === "ready" && this.isAtCue(d.index)) ? 1 : 0;
        case "sync":
          return d.sync ? 1 : 0;
        case "master":
          return this.state.masterDeck === d.index ? 1 : 0;
        case "loop":
          return d.loop?.active ? 1 : 0;
        case "keylock":
          return d.keylock ? 1 : 0;
        case "vinyl":
          return d.vinyl ? 1 : 0;
        case "loaded":
          return d.status === "ready" ? 1 : 0;
      }
      if (f === "stems") return d.stems.enabled ? 1 : 0;
      const sm = /^stem\.(\w+)$/.exec(f);
      if (sm) {
        const k = STEM_NAMES.indexOf(sm[1] as StemName);
        return k >= 0 && d.stems.enabled && !d.stems.muted[k] && d.stems.volume[k] > 0 ? 1 : 0;
      }
      const hc = /^hotcue\.(\d+)$/.exec(f);
      if (hc) return d.hotcues[Number(hc[1]) - 1] != null ? 1 : 0;
      return 0;
    }
    const fxMatch = /^fx\.unit(\d+)\.(on|assign\.deck(\d+)|slot(\d)\.on)$/.exec(key);
    if (fxMatch) {
      const u = this.state.fx[Number(fxMatch[1]) - 1];
      if (!u) return 0;
      if (fxMatch[2] === "on") return u.slots.some((s) => s.on) ? 1 : 0;
      if (fxMatch[4]) return u.slots[Number(fxMatch[4]) - 1]?.on ? 1 : 0;
      return u.decks[Number(fxMatch[3]) - 1] ? 1 : 0;
    }
    const chMatch = /^mixer\.channel(\d+)\.(.+)$/.exec(key);
    if (chMatch) {
      const c = this.state.mixer.channels[Number(chMatch[1]) - 1];
      if (!c) return 0;
      switch (chMatch[2]) {
        case "cue":
          return c.pfl ? 1 : 0;
        case "mute":
          return c.mute ? 1 : 0;
        case "eq.high.kill":
          return c.killHigh ? 1 : 0;
        case "eq.mid.kill":
          return c.killMid ? 1 : 0;
        case "eq.low.kill":
          return c.killLow ? 1 : 0;
      }
    }
    return 0;
  }

  cancelPendingLoad(deck: number): void {
    if (this.state.decks[deck]?.status !== "loading") return;
    ++this.loadTokens[deck];
    this.loadAborts[deck]?.abort();
    this.audio.setPlaying(deck, false);
    this.audio.unloadDeck(deck);
    this.patchDeck(deck, { status: "empty", track: null, playing: false, duration: 0, beatGrid: null });
    this.emit("event", { type: "trackUnloaded", deck });
  }

  async loadTrack(deck: number, track: TrackInfo, source: "manual" | "auto-dj" = "manual"): Promise<void> {
    this.emit("event", { type: "loadRequested", deck, source });
    const d = this.state.decks[deck];
    if (!d) return;
    const policy = this.canLoad(track);
    if (!policy.ok) {
      this.log.warn("engine", `Can't load "${track.title}" onto a deck: ${policy.reason ?? "not permitted by its source"}`);
      return;
    }
    if (this.settings.lockPlayingDecks && d.playing) {
      this.log.warn("engine", `Deck ${deckLetter(deck)} is playing — pause it before loading a new track.`);
      return;
    }
    if (track.unavailableReason) {
      this.log.warn("engine", `Can't load "${track.title}": ${track.unavailableReason}`);
      return;
    }
    const token = ++this.loadTokens[deck];
    this.loadAborts[deck]?.abort();
    const abort = new AbortController();
    this.loadAborts[deck] = abort;
    this.patchDeck(deck, { status: "loading", track, error: undefined, loadProgress: null, loadMessage: undefined });
    let lastPatch = 0;
    const onProgress = (p: LoadProgress) => {
      if (token !== this.loadTokens[deck]) return;
      const now = performance.now();
      if (!p.message && now - lastPatch < 100) return; // throttle UI updates
      lastPatch = now;
      this.patchDeck(deck, { loadProgress: p.fraction, loadMessage: p.message });
    };
    try {
      const bytes = await this.loadBytes(track, { onProgress, signal: abort.signal });
      if (token !== this.loadTokens[deck]) return;
      // decodeAudioData is allowed to detach its input ArrayBuffer. Preserve the
      // original bytes because preparation hashes them after decoding.
      const decoded = await this.audio.decode(bytes.slice(0));
      if (token !== this.loadTokens[deck]) return;
      const prepared = await this.preparation?.restore(track, bytes, decoded.duration) ?? {};
      if (token !== this.loadTokens[deck]) return;
      track = prepared.track ?? track;
      this.audio.setPlaying(deck, false);
      this.audio.loadDeck(deck, decoded);
      this.patchDeck(deck, {
        status: "ready",
        loadProgress: undefined,
        loadMessage: undefined,
        duration: decoded.duration,
        playing: false,
        previewing: false,
        cuePoint: 0,
        hotcues: new Array(HOTCUE_COUNT).fill(null),
        cueDetails: new Array(HOTCUE_COUNT).fill(null),
        savedLoops: [],
        beatGrid: null,
        stems: { ...this.state.decks[deck].stems, muted: [false, false, false, false], status: this.stemsSupport.ok ? "waiting" : "unavailable", progress: 0, message: undefined },
        loop: null,
        loopIn: null,
        ...prepared,
      });
      this.rolls[deck] = null;
      this.applyStems(deck);
      this.applyTempo(deck, this.state.decks[deck].tempo);
      this.log.info("engine", `Loaded "${track.title}" into deck ${deckLetter(deck)} (${decoded.duration.toFixed(1)} s)`);
      this.emit("event", { type: "trackLoaded", deck, track, audioHandle: decoded.handle });
    } catch (err) {
      if (token !== this.loadTokens[deck]) return;
      const message = err instanceof Error ? err.message : String(err);
      this.patchDeck(deck, { status: "error", error: message, loadProgress: undefined, loadMessage: undefined });
      this.log.error("engine", `Failed to load "${track.title}" into deck ${deckLetter(deck)}: ${message}`);
    }
  }

  // ─────────────────────────── command handlers ───────────────────────────

  private registerHandlers(): void {
    const on = (action: string, fn: (v: number) => void) => this.bus.handle(action, fn);
    const pressed = (fn: () => void) => (v: number) => {
      if (v > 0) fn();
    };

    for (let i = 0; i < this.deckCount; i++) {
      const p = `deck${i + 1}`;
      const m = `mixer.channel${i + 1}`;
      on(`${p}.play`, pressed(() => this.onPlay(i)));
      on(`${p}.cue`, (v) => this.onCue(i, v > 0));
      on(`${p}.vinyl`, pressed(() => this.toggleVinyl(i)));
      on(`${p}.keylock`, pressed(() => this.setKeylock(i, !this.state.decks[i].keylock)));
      on(`${p}.eject`, pressed(() => this.eject(i)));
      on(`${p}.stems`, pressed(() => this.setStemsEnabled(i, !this.state.decks[i].stems.enabled)));
      STEM_NAMES.forEach((s, k) => {
        on(`${p}.stem.${s}.toggle`, pressed(() => this.toggleStem(i, k)));
        on(`${p}.stem.${s}.isolate`, pressed(() => this.isolateStem(i, k)));
        on(`${p}.stem.${s}.volume`, (v) => this.setStemVolume(i, k, v));
      });
      on(`${p}.seek`, (v) => {
        const d = this.state.decks[i];
        if (d.status === "ready") this.seekTo(i, clamp(v, 0, 1) * d.duration);
      });
      on(`${p}.sync`, pressed(() => this.toggleSync(i)));
      on(`${p}.master`, pressed(() => this.setMaster(i)));
      on(`${p}.loop.in`, pressed(() => this.loopIn(i)));
      on(`${p}.loop.out`, pressed(() => this.loopOut(i)));
      on(`${p}.loop.exit`, pressed(() => this.loopExit(i)));
      on(`${p}.loop.halve`, pressed(() => this.resizeLoop(i, 0.5)));
      on(`${p}.loop.double`, pressed(() => this.resizeLoop(i, 2)));
      on(`${p}.loop.move.back`, pressed(() => this.moveLoop(i, -1)));
      on(`${p}.loop.move.forward`, pressed(() => this.moveLoop(i, 1)));
      for (const s of BEATLOOP_SIZES) {
        on(`${p}.beatloop.${s}`, pressed(() => this.beatLoop(i, Number(s))));
        on(`${p}.beatloop.roll.${s}`, (v) => this.loopRoll(i, Number(s), v > 0));
      }
      on(`${p}.tempo`, (v) => this.onTempoSlider(i, v));
      on(`${p}.tempo.range`, pressed(() => this.cycleTempoRange(i)));
      on(`${p}.tempo.reset`, pressed(() => this.applyTempo(i, 0)));
      on(`${p}.jog.touch`, (v) => this.onJogTouch(i, v > 0));
      on(`${p}.jog.platter`, (v) => this.onJog(i, "platter", v));
      on(`${p}.jog.ring`, (v) => this.onJog(i, "ring", v));
      on(`${p}.jog.search`, (v) => this.onJog(i, "search", v));
      for (let h = 0; h < HOTCUE_COUNT; h++) {
        on(`${p}.hotcue.${h + 1}`, (v) => this.onHotcue(i, h, v > 0));
        on(`${p}.hotcue.${h + 1}.clear`, pressed(() => this.clearHotcue(i, h)));
      }

      on(`${m}.gain`, (v) => this.patchChannel(i, { gain: v }));
      on(`${m}.eq.high`, (v) => this.patchChannel(i, { eqHigh: v }));
      on(`${m}.eq.mid`, (v) => this.patchChannel(i, { eqMid: v }));
      on(`${m}.eq.low`, (v) => this.patchChannel(i, { eqLow: v }));
      on(`${m}.eq.high.kill`, pressed(() => this.patchChannel(i, { killHigh: !this.state.mixer.channels[i].killHigh })));
      on(`${m}.eq.mid.kill`, pressed(() => this.patchChannel(i, { killMid: !this.state.mixer.channels[i].killMid })));
      on(`${m}.eq.low.kill`, pressed(() => this.patchChannel(i, { killLow: !this.state.mixer.channels[i].killLow })));
      on(`${m}.filter`, (v) => this.patchChannel(i, { filter: v }));
      on(`${m}.volume`, (v) => this.patchChannel(i, { volume: v }));
      on(`${m}.cue`, pressed(() => this.patchChannel(i, { pfl: !this.state.mixer.channels[i].pfl })));
      on(`${m}.mute`, pressed(() => this.patchChannel(i, { mute: !this.state.mixer.channels[i].mute })));

      on(`browser.load.deck${i + 1}`, pressed(() => {
        const t = this.browser.getSelected();
        if (t && this.onBrowserLoad) this.onBrowserLoad(i, t);
        else if (t) void this.loadTrack(i, t);
        else this.log.warn("engine", "Nothing selected in the browser to load.");
      }));
    }

    on("mixer.crossfader", (v) => this.patchMixer({ crossfader: clamp(v, 0, 1) }));
    on("mixer.master.level", (v) => this.patchMixer({ masterLevel: clamp(v, 0, 1) }));
    on("mixer.headphone.mix", (v) => this.patchMixer({ headMix: clamp(v, 0, 1) }));
    on("mixer.headphone.level", (v) => this.patchMixer({ headLevel: clamp(v, 0, 1) }));
    on("browser.scroll", (v) => this.browser.moveSelection(Math.sign(v) * Math.max(1, Math.round(Math.abs(v)))));

    for (let u = 0; u < this.state.fx.length; u++) {
      const f = `fx.unit${u + 1}`;
      for (let k = 0; k < FX_SLOTS; k++) {
        const s = `${f}.slot${k + 1}`;
        const toggle = pressed(() => this.patchSlot(u, k, { on: !this.state.fx[u].slots[k].on }));
        on(`${s}.toggle`, toggle);
        on(`${f}.button${k + 1}`, toggle); // DDJ-SB FX1/FX2/FX3 buttons
        on(`${s}.next`, pressed(() => this.cycleSlotType(u, k, 1)));
        on(`${s}.prev`, pressed(() => this.cycleSlotType(u, k, -1)));
        on(`${s}.param`, (v) => this.patchSlot(u, k, { param: clamp(v, 0, 1) }));
      }
      // Unit on/off: everything off, or FX1 on when nothing is running.
      on(
        `${f}.on`,
        pressed(() => {
          const any = this.state.fx[u].slots.some((s) => s.on);
          this.patchFx(u, { slots: this.state.fx[u].slots.map((s, k) => ({ ...s, on: any ? false : k === 0 })) });
        }),
      );
      on(`${f}.chain.next`, pressed(() => this.cycleSlotType(u, 0, 1)));
      on(`${f}.chain.prev`, pressed(() => this.cycleSlotType(u, 0, -1)));
      const nextBeats = (d: 1 | -1, wrap: boolean) =>
        pressed(() => {
          const i = FX_BEATS.indexOf(this.state.fx[u].beats as (typeof FX_BEATS)[number]);
          let j = i + d;
          if (wrap) j = (j + FX_BEATS.length) % FX_BEATS.length;
          this.patchFx(u, { beats: FX_BEATS[clamp(j, 0, FX_BEATS.length - 1)] });
        });
      on(`${f}.target.next`, pressed(() => {
        const t = FX_TARGETS[(FX_TARGETS.indexOf(this.state.fx[u].target) + 1) % FX_TARGETS.length];
        this.patchFx(u, { target: t });
      }));
      on(`${f}.beats.next`, nextBeats(1, false));
      on(`${f}.beats.prev`, nextBeats(-1, false));
      on(`${f}.knob`, (v) => this.patchFx(u, { mix: clamp(v, 0, 1) }));
      on(`${f}.mix`, (v) => this.patchFx(u, { mix: clamp(v, 0, 1) }));
      // SHIFT + FX knob: the parameter of every slot in the unit (depth / feedback / rate…).
      const allParams = (v: number) => this.patchFx(u, { slots: this.state.fx[u].slots.map((s) => ({ ...s, param: clamp(v, 0, 1) })) });
      on(`${f}.knob.shift`, allParams);
      on(`${f}.param`, allParams);
      for (let d = 0; d < this.deckCount; d++) {
        on(
          `${f}.assign.deck${d + 1}`,
          pressed(() => {
            const decks = this.state.fx[u].decks.slice();
            decks[d] = !decks[d];
            this.patchFx(u, { decks });
          }),
        );
      }
    }

    // Everything else in the catalogue is accepted (so mappings validate and the
    // MIDI monitor shows the resolved action) but reported as not yet implemented.
    for (const meta of actionCatalog().values()) {
      if (this.bus.has(meta.id) || meta.id === "modifier.shift") continue;
      const dm = /^deck(\d+)\./.exec(meta.id) ?? /^mixer\.channel(\d+)\./.exec(meta.id) ?? /^browser\.load\.deck(\d+)$/.exec(meta.id);
      if (dm && Number(dm[1]) > this.deckCount) continue;
      on(meta.id, (v) => {
        if (v !== 0) this.warnUnimplemented(meta.id, `"${meta.label}" is mapped but not implemented yet.`);
      });
    }
  }

  private warnUnimplemented(key: string, message: string): void {
    if (this.warnedUnimplemented.has(key)) return;
    this.warnedUnimplemented.add(key);
    this.log.info("engine", message);
  }

  // ───────────────────────────── deck logic ─────────────────────────────

  private isAtCue(deck: number): boolean {
    return Math.abs(this.audio.getPosition(deck) - this.state.decks[deck].cuePoint) < AT_CUE_TOLERANCE_S;
  }

  private onPlay(deck: number): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    if (d.previewing) {
      // Play pressed while holding CUE/hot cue: keep playing after release (CDJ behaviour).
      this.preview[deck].latchPlay = true;
      return;
    }
    const playing = !d.playing;
    // While scratching the platter owns the velocity; the audio engine applies
    // the play state when the hand is released.
    this.audio.setPlaying(deck, playing);
    this.patchDeck(deck, { playing });
  }

  /**
   * CDJ-style CUE:
   *  - playing → return to cue point and pause
   *  - paused away from cue point → set cue point here
   *  - paused at cue point → preview while held; release returns to cue (unless PLAY was pressed)
   */
  private onCue(deck: number, down: boolean): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    if (down) {
      if (d.playing && !d.previewing) {
        this.audio.setPlaying(deck, false);
        this.seekTo(deck, d.cuePoint);
        this.patchDeck(deck, { playing: false });
      } else if (!this.isAtCue(deck)) {
        const pos = this.audio.getPosition(deck);
        this.patchDeck(deck, { cuePoint: pos });
      } else {
        this.startPreview(deck, d.cuePoint);
      }
    } else if (d.previewing) {
      this.endPreview(deck);
    }
  }

  private startPreview(deck: number, origin: number): void {
    this.preview[deck] = { origin, latchPlay: false };
    this.audio.seek(deck, origin);
    this.audio.setPlaying(deck, true);
    this.patchDeck(deck, { previewing: true, playing: true });
  }

  private endPreview(deck: number): void {
    const pv = this.preview[deck];
    if (pv.latchPlay) {
      this.patchDeck(deck, { previewing: false, playing: true });
      return;
    }
    this.audio.setPlaying(deck, false);
    this.audio.seek(deck, pv.origin);
    this.patchDeck(deck, { previewing: false, playing: false });
  }

  private onHotcue(deck: number, idx: number, down: boolean): void {
    const d = this.state.decks[deck];
    if (d.status !== "ready") return;
    const point = d.hotcues[idx];
    if (down) {
      if (point == null) {
        const hotcues = d.hotcues.slice();
        hotcues[idx] = this.audio.getPosition(deck);
        this.patchDeck(deck, { hotcues });
      } else if (d.playing && !d.previewing) {
        this.seekTo(deck, point);
      } else {
        this.startPreview(deck, point);
      }
    } else if (d.previewing && point != null && this.preview[deck].origin === point) {
      this.endPreview(deck);
    }
  }

  private clearHotcue(deck: number, idx: number): void {
    const hotcues = this.state.decks[deck].hotcues.slice();
    hotcues[idx] = null;
    this.patchDeck(deck, { hotcues });
  }

  private eject(deck: number): void {
    const d = this.state.decks[deck];
    if (d.playing) {
      this.log.warn("engine", `Deck ${deckLetter(deck)} is playing — not ejecting.`);
      return;
    }
    this.loadTokens[deck]++;
    this.loadAborts[deck]?.abort();
    this.audio.unloadDeck(deck);
    this.patchDeck(deck, { ...initialDeck(deck), tempo: d.tempo, tempoRange: d.tempoRange, rate: d.rate, vinyl: d.vinyl, keylock: d.keylock });
    this.rolls[deck] = null;
    if (this.state.masterDeck === deck) this.reassignMaster(deck);
    this.emit("event", { type: "trackUnloaded", deck });
  }

  private toggleVinyl(deck: number): void {
    const d = this.state.decks[deck];
    const vinyl = !d.vinyl;
    if (!vinyl && d.scratching) {
      this.audio.setScratching(deck, false);
      this.patchDeck(deck, { vinyl, scratching: false });
      return;
    }
    this.patchDeck(deck, { vinyl });
  }

  private onTempoSlider(deck: number, v: number): void {
    let bipolar = (clamp(v, 0, 1) - 0.5) * 2;
    if (Math.abs(bipolar) < 0.005) bipolar = 0; // centre detent
    if (!this.settings.tempoDownIsFaster) bipolar = -bipolar;
    const d = this.state.decks[deck];
    if (d.sync && this.state.masterDeck !== deck) {
      // Moving a synced deck's own tempo means the DJ wants manual control of it.
      this.patchDeck(deck, { sync: false });
      this.log.info("engine", `Deck ${deckLetter(deck)}: SYNC off (tempo moved by hand)`);
    }
    this.applyTempo(deck, bipolar);
  }

  private applyTempo(deck: number, tempo: number): void {
    const d = this.state.decks[deck];
    const rate = 1 + tempo * d.tempoRange;
    this.audio.setRate(deck, rate);
    this.patchDeck(deck, { tempo, rate });
    this.applyAllFx();
    if (this.state.masterDeck === deck) this.syncFollowers();
  }

  private cycleTempoRange(deck: number): void {
    const d = this.state.decks[deck];
    const i = TEMPO_RANGES.indexOf(d.tempoRange as (typeof TEMPO_RANGES)[number]);
    const tempoRange = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
    this.patchDeck(deck, { tempoRange });
    this.applyTempo(deck, d.tempo);
  }

  /** Key lock: tempo changes keep the track's pitch (time-stretched in the deck worklet). */
  setKeylock(deck: number, on: boolean): void {
    this.audio.setKeylock(deck, on);
    this.patchDeck(deck, { keylock: on });
  }

  private onJogTouch(deck: number, touched: boolean): void {
    const d = this.state.decks[deck];
    if (d.vinyl && d.status === "ready") {
      this.audio.setScratching(deck, touched);
      this.patchDeck(deck, { jogTouched: touched, scratching: touched });
    } else {
      this.patchDeck(deck, { jogTouched: touched });
    }
  }

  /**
   * On-screen scratching (dragging the scrolling waveform): like a hand on a vinyl-mode platter,
   * whatever the vinyl setting. Holding still stops the sound; letting go resumes playback,
   * or stays paused if the deck was paused.
   */
  beginScratch(deck: number): boolean {
    const d = this.state.decks[deck];
    if (!d || d.status !== "ready") return false;
    this.audio.setScratching(deck, true);
    this.patchDeck(deck, { scratching: true });
    return true;
  }
  /** Move the record by `seconds` of track time (negative = backwards). */
  scratchBy(deck: number, seconds: number): void {
    if (this.state.decks[deck]?.scratching && Number.isFinite(seconds)) this.audio.scratchMove(deck, seconds);
  }
  endScratch(deck: number): void {
    const d = this.state.decks[deck];
    if (!d?.scratching || d.jogTouched) return; // a hand still on the hardware platter keeps it
    this.audio.setScratching(deck, false);
    this.patchDeck(deck, { scratching: false });
  }

  private onJog(deck: number, surface: "platter" | "ring" | "search", ticks: number): void {
    if (surface !== "search") this.jogTicks[deck] += ticks;
    const d = this.state.decks[deck];
    const intent = jogIntent(
      surface,
      ticks,
      { playing: d.playing, vinylMode: d.vinyl, touched: d.jogTouched, loaded: d.status === "ready" },
      this.settings.jog,
    );
    switch (intent.kind) {
      case "scratch":
        this.audio.scratchMove(deck, intent.seconds);
        break;
      case "nudge":
        this.audio.nudge(deck, intent.rateOffset);
        this.lastNudge[deck] = Date.now();
        break;
      case "seek": {
        const pos = clamp(this.audio.getPosition(deck) + intent.seconds, 0, d.duration);
        this.seekTo(deck, pos);
        break;
      }
    }
  }

  // ───────────────────────────── mixer ─────────────────────────────

  private applyMixer(): void {
    const mx = this.state.mixer;
    const [xl, xr] = crossfaderGains(mx.crossfader, this.settings.crossfaderCurve);
    for (let i = 0; i < this.deckCount; i++) {
      const c = mx.channels[i];
      const assign = this.settings.crossfaderAssign[i] ?? "thru";
      const xg = assign === "left" ? xl : assign === "right" ? xr : 1;
      this.audio.setChannel(i, {
        trimGain: dbToGain(gainKnobToDb(c.gain)),
        eqHighDb: c.killHigh ? EQ_KILL_DB : eqKnobToDb(c.eqHigh),
        eqMidDb: c.killMid ? EQ_KILL_DB : eqKnobToDb(c.eqMid),
        eqLowDb: c.killLow ? EQ_KILL_DB : eqKnobToDb(c.eqLow),
        filter: filterKnobToParams(c.filter),
        outputGain: c.mute ? 0 : faderToGain(c.volume) * xg,
        pfl: c.pfl,
      });
    }
    const [cueG, mstG] = headMixGains(mx.headMix);
    this.audio.setMaster({
      masterGain: faderToGain(mx.masterLevel),
      headCueGain: cueG,
      headMasterGain: mstG,
      headphoneGain: faderToGain(mx.headLevel),
    });
  }

  // ───────────────────────────── FX ─────────────────────────────

  private applyAllFx(): void {
    for (let u = 0; u < this.state.fx.length; u++) this.applyFx(u);
  }

  /** Beat-synced FX time from the first assigned deck's tempo (120 BPM if unknown). */
  private applyFx(u: number): void {
    const f = this.state.fx[u];
    const deck = f.decks.findIndex(Boolean);
    const bpm = (deck >= 0 ? this.getBpm(deck) : null) ?? 120;
    this.audio.setFx(u, {
      slots: f.slots.map((s) => ({ type: s.type, enabled: s.on, param: s.param })),
      mix: f.mix,
      timeSec: clamp((f.beats * 60) / bpm, 0.01, 3.9),
      decks: f.decks,
      stemMask: f.target === "deck" ? null : STEM_NAMES.map((s) => (s === f.target ? 1 : 0)),
    });
  }

  private patchSlot(u: number, k: number, patch: Partial<FxSlotState>): void {
    const slots = this.state.fx[u].slots.slice();
    slots[k] = { ...slots[k], ...patch };
    this.patchFx(u, { slots });
  }

  private cycleSlotType(u: number, k: number, dir: 1 | -1): void {
    const i = FX_TYPES.indexOf(this.state.fx[u].slots[k].type);
    this.setFxSlotType(u, k, FX_TYPES[(i + dir + FX_TYPES.length) % FX_TYPES.length]);
  }

  /** Assign an effect to FX1/FX2/FX3 of a unit (remembered in settings). */
  setFxSlotType(u: number, k: number, type: FxType): void {
    if (!this.state.fx[u]?.slots[k] || !FX_TYPES.includes(type)) return;
    this.patchSlot(u, k, { type });
    const fxAssign = this.state.fx.map((unit) => unit.slots.map((s) => s.type));
    this.settings = { ...this.settings, fxAssign };
  }

  private patchFx(u: number, patch: Partial<FxUnitState>): void {
    const fx = this.state.fx.slice();
    fx[u] = { ...fx[u], ...patch };
    this.state = { ...this.state, fx };
    this.applyFx(u);
    this.emit("state", this.state);
  }

  // ───────────────────────────── state plumbing ─────────────────────────────

  private patchDeck(deck: number, patch: Partial<DeckState>): void {
    const previous = this.state.decks[deck];
    const decks = this.state.decks.slice();
    decks[deck] = { ...decks[deck], ...patch };
    this.state = { ...this.state, decks };
    this.emit("state", this.state);
    if (!this.restoringPreparation && previous.status === "ready" && decks[deck].status === "ready" && !("status" in patch)) {
      const durablePatch = this.rolls[deck] && "loop" in patch ? { ...patch, loop: undefined } : patch;
      if (this.rolls[deck]) delete durablePatch.loop;
      this.preparation?.changed(previous, decks[deck], durablePatch);
    }
  }

  private patchChannel(ch: number, patch: Partial<ChannelState>): void {
    const channels = this.state.mixer.channels.slice();
    channels[ch] = { ...channels[ch], ...patch };
    this.state = { ...this.state, mixer: { ...this.state.mixer, channels } };
    this.applyMixer();
    this.emit("state", this.state);
  }

  private patchState(patch: Partial<Pick<EngineState, "masterDeck">>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  private patchMixer(patch: Partial<Omit<MixerState, "channels">>): void {
    this.state = { ...this.state, mixer: { ...this.state.mixer, ...patch } };
    this.applyMixer();
    this.emit("state", this.state);
  }
}

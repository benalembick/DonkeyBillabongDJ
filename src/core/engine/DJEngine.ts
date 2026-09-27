/**
 * DJ Engine: owns deck/mixer state and DJ behaviour (cue logic, jog modes,
 * tempo, hot cues, mixer curves). It receives Commands from the CommandBus and
 * drives an AudioEngine. It knows nothing about React, MIDI or files.
 */
import { actionCatalog, HOTCUE_COUNT, deckLetter } from "../actions";
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

export const TEMPO_RANGES = [0.06, 0.1, 0.16, 1.0] as const;
export const FX_TYPES: FxType[] = ["echo", "delay", "reverb", "flanger", "filter"];
export const FX_BEATS = [0.25, 0.5, 0.75, 1, 2, 4] as const;

export interface BeatGrid {
  bpm: number;
  firstBeat: number;
  confidence: number;
  source: "analysis" | "metadata" | "none";
}

export interface FxUnitState {
  type: FxType;
  on: boolean;
  mix: number;
  param: number;
  beats: number;
  decks: boolean[];
}
const AT_CUE_TOLERANCE_S = 0.02;

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
  /** Estimated beat grid from analysis (null until analysed). */
  beatGrid: BeatGrid | null;
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
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  jog: DEFAULT_JOG_SETTINGS,
  tempoDownIsFaster: true,
  crossfaderCurve: "additive",
  lockPlayingDecks: true,
  crossfaderAssign: ["left", "right", "left", "right"],
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

export type EngineEvent =
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
    beatGrid: null,
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
      fx: [
        { type: "echo", on: false, mix: 0.5, param: 0.5, beats: 0.75, decks: Array.from({ length: this.deckCount }, (_, i) => i === 0) },
        { type: "reverb", on: false, mix: 0.5, param: 0.5, beats: 1, decks: Array.from({ length: this.deckCount }, (_, i) => i === 1) },
      ],
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

  getSettings(): EngineSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<EngineSettings>): void {
    this.settings = { ...this.settings, ...patch, jog: { ...this.settings.jog, ...patch.jog } };
    this.applyMixer();
    for (let d = 0; d < this.deckCount; d++) this.applyTempo(d, this.state.decks[d].tempo);
  }

  /** Called by the analysis service when a deck's beat grid is known. */
  setBeatGrid(deck: number, grid: BeatGrid): void {
    if (!this.state.decks[deck] || this.state.decks[deck].status !== "ready") return;
    this.patchDeck(deck, { beatGrid: grid });
    this.applyAllFx();
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
        case "keylock":
          return d.keylock ? 1 : 0;
        case "vinyl":
          return d.vinyl ? 1 : 0;
        case "loaded":
          return d.status === "ready" ? 1 : 0;
      }
      const hc = /^hotcue\.(\d+)$/.exec(f);
      if (hc) return d.hotcues[Number(hc[1]) - 1] != null ? 1 : 0;
      return 0;
    }
    const fxMatch = /^fx\.unit(\d+)\.(on|assign\.deck(\d+))$/.exec(key);
    if (fxMatch) {
      const u = this.state.fx[Number(fxMatch[1]) - 1];
      if (!u) return 0;
      if (fxMatch[2] === "on") return u.on ? 1 : 0;
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

  async loadTrack(deck: number, track: TrackInfo): Promise<void> {
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
      const decoded = await this.audio.decode(bytes);
      if (token !== this.loadTokens[deck]) return;
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
        beatGrid: null,
      });
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
      on(`${p}.keylock`, pressed(() => {
        this.patchDeck(i, { keylock: !this.state.decks[i].keylock });
        this.warnUnimplemented(`${p}.keylock`, "Key lock (time-stretching) arrives in Phase 2; the flag is stored only.");
      }));
      on(`${p}.eject`, pressed(() => this.eject(i)));
      on(`${p}.seek`, (v) => {
        const d = this.state.decks[i];
        if (d.status === "ready") this.audio.seek(i, clamp(v, 0, 1) * d.duration);
      });
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
      const toggleOn = pressed(() => this.patchFx(u, { on: !this.state.fx[u].on }));
      on(`${f}.on`, toggleOn);
      on(`${f}.button1`, toggleOn);
      const nextType = (d: 1 | -1) =>
        pressed(() => {
          const i = FX_TYPES.indexOf(this.state.fx[u].type);
          this.patchFx(u, { type: FX_TYPES[(i + d + FX_TYPES.length) % FX_TYPES.length] });
        });
      on(`${f}.button2`, nextType(1));
      on(`${f}.chain.next`, nextType(1));
      on(`${f}.chain.prev`, nextType(-1));
      const nextBeats = (d: 1 | -1, wrap: boolean) =>
        pressed(() => {
          const i = FX_BEATS.indexOf(this.state.fx[u].beats as (typeof FX_BEATS)[number]);
          let j = i + d;
          if (wrap) j = (j + FX_BEATS.length) % FX_BEATS.length;
          this.patchFx(u, { beats: FX_BEATS[clamp(j, 0, FX_BEATS.length - 1)] });
        });
      on(`${f}.button3`, nextBeats(1, true));
      on(`${f}.beats.next`, nextBeats(1, false));
      on(`${f}.beats.prev`, nextBeats(-1, false));
      on(`${f}.knob`, (v) => this.patchFx(u, { mix: clamp(v, 0, 1) }));
      on(`${f}.mix`, (v) => this.patchFx(u, { mix: clamp(v, 0, 1) }));
      on(`${f}.knob.shift`, (v) => this.patchFx(u, { param: clamp(v, 0, 1) }));
      on(`${f}.param`, (v) => this.patchFx(u, { param: clamp(v, 0, 1) }));
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
        this.audio.seek(deck, d.cuePoint);
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
        this.audio.seek(deck, point);
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
    this.patchDeck(deck, { ...initialDeck(deck), tempo: d.tempo, tempoRange: d.tempoRange, rate: d.rate, vinyl: d.vinyl });
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
    this.applyTempo(deck, bipolar);
  }

  private applyTempo(deck: number, tempo: number): void {
    const d = this.state.decks[deck];
    const rate = 1 + tempo * d.tempoRange;
    this.audio.setRate(deck, rate);
    this.patchDeck(deck, { tempo, rate });
    this.applyAllFx();
  }

  private cycleTempoRange(deck: number): void {
    const d = this.state.decks[deck];
    const i = TEMPO_RANGES.indexOf(d.tempoRange as (typeof TEMPO_RANGES)[number]);
    const tempoRange = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
    this.patchDeck(deck, { tempoRange });
    this.applyTempo(deck, d.tempo);
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
        break;
      case "seek": {
        const pos = clamp(this.audio.getPosition(deck) + intent.seconds, 0, d.duration);
        this.audio.seek(deck, pos);
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
      type: f.type,
      enabled: f.on,
      mix: f.mix,
      param: f.param,
      timeSec: clamp((f.beats * 60) / bpm, 0.01, 3.9),
      decks: f.decks,
    });
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
    const decks = this.state.decks.slice();
    decks[deck] = { ...decks[deck], ...patch };
    this.state = { ...this.state, decks };
    this.emit("state", this.state);
  }

  private patchChannel(ch: number, patch: Partial<ChannelState>): void {
    const channels = this.state.mixer.channels.slice();
    channels[ch] = { ...channels[ch], ...patch };
    this.state = { ...this.state, mixer: { ...this.state.mixer, channels } };
    this.applyMixer();
    this.emit("state", this.state);
  }

  private patchMixer(patch: Partial<Omit<MixerState, "channels">>): void {
    this.state = { ...this.state, mixer: { ...this.state.mixer, ...patch } };
    this.applyMixer();
    this.emit("state", this.state);
  }
}

/**
 * Renderer side of STEM separation.
 *
 *   deck loads a track ─→ StemService ─(MessagePort)─→ stem worker (utilityProcess, ONNX Runtime)
 *                              ↑                              │ regions (Int16) + envelopes
 *   engine / UI ←── status ────┴──── audio.stemsRegion ←──────┘
 *
 * The original audio is always playing; separated regions are handed to the
 * deck worklet as they finish (starting at the playhead) and the worklet
 * crossfades to the stem mix only where stems exist. Nothing here ever blocks
 * the audio thread: the worker is a separate OS process and region buffers are
 * transferred, not copied.
 *
 * Licensing: local files are cached on disk (keyed by audio content). Audius
 * tracks are separated in memory only and never persisted. Spotify / Apple
 * Music audio never reaches the app, so it can't be separated.
 */
import { Emitter } from "../core/events";
import type { DJEngine } from "../core/engine/DJEngine";
import type { AudioEngine, TrackInfo } from "../core/engine/types";
import type { EventLog } from "../core/log";
import { deckLetter } from "../core/actions";
import type { FromWorker, StemDevice, ToWorker, WorkerStatus } from "./protocol";
import { ENV_HOP, MODEL_RATE, SEGMENT, makePlan, type Quality } from "./separator";

export type StemMode = "off" | "automatic" | "preanalyse" | "realtime";

export interface StemSettings {
  mode: StemMode;
  quality: Quality;
}

export interface StemBridge {
  status(): Promise<{ model: { name: string; installed: boolean; bytes: number; path: string }; config: { cacheDir: string; maxCacheGB: number; device: StemDevice }; platform?: { ok: boolean; reason?: string } }>;
  downloadModel(): Promise<boolean>;
  onDownloadProgress(cb: (p: { received: number; total: number }) => void): () => void;
  onWorkerExit(cb: () => void): () => void;
  connect(): Promise<boolean>;
  fileKey(path: string): Promise<string>;
  index(): Promise<Record<string, "complete" | "partial">>;
  setIndex(ref: string, key: string | null): Promise<void>;
  remove(refs: string[]): Promise<void>;
  cacheInfo(): Promise<{ entries: number; bytes: number; complete: number }>;
  clearCache(): Promise<void>;
  setConfig(patch: Partial<{ cacheDir: string; maxCacheGB: number; device: StemDevice }>): Promise<unknown>;
  pickCacheDir(): Promise<string | null>;
  renderData(ref: string): Promise<{ rate: number; total: number; pcm: ArrayBuffer }>;
}

/** Per-deck waveform envelopes (150 fps), filled in as regions arrive. */
export interface StemEnvelopes {
  vocals: Float32Array;
  drums: Float32Array;
  bass: Float32Array;
  instruments: Float32Array;
  /** Seconds per envelope frame. */
  hop: number;
  /** Bumped whenever new data arrives (waveform tiles re-render). */
  version: number;
}

interface DeckJob {
  id: number;
  deck: number;
  track: TrackInfo;
  persist: boolean;
  key: string;
  buffer: AudioBuffer;
  total: number;
  inited: boolean;
  runSent: boolean;
  /** Cache miss in Pre-analyse mode: separation starts when STEMS is switched on. */
  awaitingUser: boolean;
  regionsDone: number;
  regions: number;
  started: number;
}

interface LibraryJob {
  id: number;
  ref: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

const SETTINGS_KEY = "dbdj.stems.v1";
export const DEFAULT_STEM_SETTINGS: StemSettings = { mode: "automatic", quality: "balanced" };

type Events = {
  status: StemServiceStatus;
  envelopes: { deck: number };
  index: Record<string, "complete" | "partial">;
};

export interface StemServiceStatus {
  available: boolean;
  reason?: string;
  modelInstalled: boolean;
  worker: WorkerStatus;
  settings: StemSettings;
  /** Last measured compute seconds per second of audio. */
  rtf?: number;
  download?: { received: number; total: number } | null;
  libraryQueue: number;
}

export class StemService extends Emitter<Events> {
  private port: MessagePort | null = null;
  private portWaiters: ((p: MessagePort) => void)[] = [];
  private connecting: Promise<MessagePort> | null = null;
  private nextId = 1;
  private deckJobs: (DeckJob | null)[] = [];
  private libJobs = new Map<number, LibraryJob>();
  private libQueue: string[] = [];
  private libRunning = false;
  private envs: (StemEnvelopes | null)[] = [];
  private idx: Record<string, "complete" | "partial"> = {};
  private st: StemServiceStatus;
  private seekTimer: ReturnType<typeof setInterval> | null = null;
  private lastPrio: number[] = [];

  private readonly engine: DJEngine;
  private readonly audio: AudioEngine;
  private readonly log: EventLog;
  private readonly bridge: StemBridge | null;

  constructor(engine: DJEngine, audio: AudioEngine, log: EventLog, bridge: StemBridge | null) {
    super();
    this.engine = engine;
    this.audio = audio;
    this.log = log;
    this.bridge = bridge;
    const settings = loadSettings();
    this.st = { available: false, modelInstalled: false, worker: { state: "idle" }, settings, libraryQueue: 0 };
    if (!bridge) {
      this.setAvailable(false, "STEMS need the desktop app (separation runs locally with ONNX Runtime).");
      return;
    }
    window.addEventListener("message", (e) => {
      if (e.data === "dbdj:stems:port" && e.ports[0]) this.attachPort(e.ports[0]);
    });
    bridge.onWorkerExit(() => {
      this.port = null;
      this.connecting = null;
      this.patchStatus({ worker: { state: "error", message: "The stem worker stopped; it restarts automatically on next use. Decks keep playing the original audio." } });
      for (const j of this.deckJobs) if (j) this.engine.setStemStatus(j.deck, { status: "error", message: "Stem worker stopped" });
      this.deckJobs = [];
      for (const lj of this.libJobs.values()) lj.reject(new Error("stem worker stopped"));
      this.libJobs.clear();
    });
    engine.on("event", (e) => {
      if (e.type === "trackLoaded") void this.onDeckLoaded(e.deck, e.track, e.audioHandle as AudioBuffer);
      if (e.type === "trackUnloaded") this.cancelDeck(e.deck);
    });
    // Switching STEMS on in Pre-analyse mode starts separation for that deck.
    engine.on("state", (s) => {
      s.decks.forEach((d, i) => {
        const j = this.deckJobs[i];
        if (d.stems.enabled && j?.awaitingUser) {
          j.awaitingUser = false;
          void this.startRun(j);
        }
      });
    });
    void this.refresh();
    void this.refreshIndex();
  }

  // ─────────────────────────── status & settings ───────────────────────────

  get status(): StemServiceStatus {
    return this.st;
  }

  envelopes(deck: number): StemEnvelopes | null {
    return this.envs[deck] ?? null;
  }

  index(): Record<string, "complete" | "partial"> {
    return this.idx;
  }
  renderData(ref: string) { if (!this.bridge || typeof this.bridge.renderData !== "function") return Promise.reject(new Error("Restart DonkeyBillabongDJ to enable offline rendering")); return this.bridge.renderData(ref); }

  async refresh(): Promise<void> {
    if (!this.bridge) return;
    try {
      const s = await this.bridge.status();
      this.platformReason = s.platform && !s.platform.ok ? s.platform.reason ?? "not supported here" : null;
      this.patchStatus({ modelInstalled: s.model.installed });
      this.updateAvailability();
    } catch (err) {
      this.setAvailable(false, `STEM status unavailable: ${String(err)}`);
    }
  }

  async refreshIndex(): Promise<void> {
    if (!this.bridge) return;
    try {
      this.idx = await this.bridge.index();
      this.emit("index", this.idx);
    } catch {
      /* cache index is optional */
    }
  }

  updateSettings(patch: Partial<StemSettings>): void {
    const settings = { ...this.st.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* best effort */
    }
    this.patchStatus({ settings });
    this.updateAvailability();
  }

  async downloadModel(): Promise<void> {
    if (!this.bridge) return;
    const off = this.bridge.onDownloadProgress((p) => this.patchStatus({ download: p }));
    try {
      this.log.info("stems", "Downloading the HT-Demucs separation model (~166 MB, one time)…");
      await this.bridge.downloadModel();
      this.port = null;
      this.connecting = null;
      this.log.info("stems", "Separation model installed and verified");
    } finally {
      off();
      this.patchStatus({ download: null });
      await this.refresh();
    }
  }

  /** Re-measure speed on the selected device. */
  async benchmark(): Promise<void> {
    (await this.getPort()).postMessage({ type: "bench" } satisfies ToWorker);
  }

  private updateAvailability(): void {
    if (!this.bridge) return;
    if (this.platformReason) return this.setAvailable(false, this.platformReason);
    if (this.st.settings.mode === "off") return this.setAvailable(false, "STEMS are switched off in Settings → STEMS.");
    if (!this.st.modelInstalled) return this.setAvailable(false, "Install the separation model in Settings → STEMS.");
    this.setAvailable(true);
  }

  private setAvailable(ok: boolean, reason?: string): void {
    const was = this.st.available;
    this.patchStatus({ available: ok, reason });
    this.engine.setStemsSupport(ok, reason);
    if (ok && !was) {
      // Pick up tracks that were already loaded before separation became available.
      this.engine.getState().decks.forEach((d, i) => {
        const buf = this.loadedBuffers[i];
        if (d.status === "ready" && d.track && buf) void this.onDeckLoaded(i, d.track, buf);
      });
      this.startSeekWatch();
    }
    if (!ok) {
      for (let d = 0; d < this.deckJobs.length; d++) this.cancelDeck(d);
      // Back to the untouched original on every deck.
      this.engine.getState().decks.forEach((_, d) => {
        this.audio.stemsClear(d);
        this.envs[d] = null;
        this.emit("envelopes", { deck: d });
      });
    }
  }

  private patchStatus(p: Partial<StemServiceStatus>): void {
    this.st = { ...this.st, ...p };
    this.emit("status", this.st);
  }

  // ─────────────────────────── worker channel ───────────────────────────

  private attachPort(p: MessagePort): void {
    this.port = p;
    p.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    p.start();
    for (const w of this.portWaiters.splice(0)) w(p);
  }

  private getPort(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    if (!this.connecting) {
      this.connecting = new Promise<MessagePort>((resolve, reject) => {
        this.portWaiters.push(resolve);
        this.bridge!.connect().then(
          (ok) => {
            if (!ok) reject(new Error("separation model not installed"));
          },
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      }).catch((err) => {
        this.connecting = null;
        throw err;
      });
    }
    return this.connecting;
  }

  /**
   * Structured clone, no transfer list: Electron's MessagePortMain can't receive
   * transferred ArrayBuffers (the message arrives as null). One copy per track.
   */
  private post(m: ToWorker): void {
    void this.getPort().then((p) => p.postMessage(m));
  }

  private onWorker(m: FromWorker): void {
    if (m.type === "status") {
      this.patchStatus({ worker: m.status, rtf: m.status.rtf ?? this.st.rtf });
      return;
    }
    const lib = this.libJobs.get(m.jobId);
    if (lib) return this.onLibraryMsg(lib, m);
    const job = this.deckJobs.find((j) => j?.id === m.jobId);
    if (!job) return; // superseded by a newer load
    switch (m.type) {
      case "cache":
        if (m.state === "miss") {
          if (this.shouldAutoRun(job)) void this.startRun(job);
          else {
            job.awaitingUser = true;
            this.engine.setStemStatus(job.deck, { status: "waiting", message: "Switch STEMS on to analyse this track" });
          }
        } else {
          this.initDeck(job, m.total!, m.stride!, m.regions!);
          this.engine.setStemStatus(job.deck, { status: "loading", message: "Loading STEMS from cache…" });
          if (m.state === "partial") void this.startRun(job); // continue where it stopped
        }
        break;
      case "region":
        this.initDeck(job, m.total, m.stride, Math.ceil(m.total / m.stride));
        this.audio.stemsRegion(job.deck, m.region, m.data);
        this.writeEnv(job.deck, m.env);
        job.regionsDone++;
        this.engine.setStemStatus(job.deck, { progress: Math.min(1, job.regionsDone / job.regions) });
        break;
      case "progress": {
        const rtf = m.secondsPerSegment ? m.secondsPerSegment / (SEGMENT / MODEL_RATE) : undefined;
        if (rtf) this.patchStatus({ rtf: Math.round(rtf * 100) / 100 });
        this.engine.setStemStatus(job.deck, { status: "analysing", progress: m.done / m.regions, message: undefined });
        break;
      }
      case "done":
        this.engine.setStemStatus(job.deck, { status: "ready", progress: 1, message: undefined });
        this.log.info("stems", `Deck ${deckLetter(job.deck)}: STEMS ready${!job.persist ? " (kept in memory only)" : job.runSent ? " (saved to cache)" : " (from cache)"} — ${((performance.now() - job.started) / 1000).toFixed(1)} s`);
        if (job.persist) void this.bridge?.setIndex(job.track.ref, job.key).then(() => this.refreshIndex());
        break;
      case "error":
        this.engine.setStemStatus(job.deck, { status: "error", message: m.message });
        this.log.error("stems", `Deck ${deckLetter(job.deck)}: separation failed — ${m.message}. The original audio keeps playing.`);
        break;
    }
  }

  // ─────────────────────────── decks ───────────────────────────

  private loadedBuffers: (AudioBuffer | null)[] = [];
  private platformReason: string | null = null;

  private shouldAutoRun(job: DeckJob): boolean {
    const mode = this.st.settings.mode;
    return mode === "automatic" || mode === "realtime" || this.engine.getState().decks[job.deck].stems.enabled;
  }

  private async onDeckLoaded(deck: number, track: TrackInfo, buffer: AudioBuffer): Promise<void> {
    this.loadedBuffers[deck] = buffer;
    this.cancelDeck(deck);
    this.envs[deck] = null;
    this.emit("envelopes", { deck });
    if (!this.st.available || !buffer || typeof buffer.getChannelData !== "function") return;
    if (track.source !== "local" && track.source !== "audius") {
      this.engine.setStemStatus(deck, { status: "unavailable", message: "STEMS aren't available for this source" });
      return;
    }
    const persist = track.source === "local";
    const job: DeckJob = { id: this.nextId++, deck, track, persist, key: "", buffer, total: 0, inited: false, runSent: false, awaitingUser: false, regionsDone: 0, regions: 0, started: performance.now() };
    this.deckJobs[deck] = job;
    try {
      // Content-based cache key (tags excluded) so renamed/moved/re-tagged files still hit the cache.
      job.key = persist ? await this.bridge!.fileKey(track.ref) : `mem${job.id}`;
      if (this.deckJobs[deck] !== job) return;
      this.post({ type: "open", jobId: job.id, key: job.key, persist });
    } catch (err) {
      this.engine.setStemStatus(deck, { status: "error", message: String(err) });
    }
  }

  private async startRun(job: DeckJob): Promise<void> {
    if (job.runSent) return;
    job.runSent = true;
    this.engine.setStemStatus(job.deck, { status: "analysing", message: "Analysing STEMS…" });
    try {
      const [left, right] = await toModelRate(job.buffer);
      if (this.deckJobs[job.deck] !== job) return;
      const plan = makePlan(left.length, this.st.settings.quality);
      this.initDeck(job, plan.total, plan.stride, plan.regions);
      const startFrame = Math.floor(this.engine.getPosition(job.deck) * MODEL_RATE);
      this.post({ type: "run", jobId: job.id, left, right, startFrame, quality: this.st.settings.quality });
    } catch (err) {
      this.engine.setStemStatus(job.deck, { status: "error", message: String(err) });
    }
  }

  private initDeck(job: DeckJob, total: number, stride: number, regions: number): void {
    if (job.inited) return;
    job.inited = true;
    job.total = total;
    job.regions = regions;
    this.audio.stemsInit(job.deck, { stride, regions, rate: MODEL_RATE });
    const n = Math.ceil(total / ENV_HOP);
    this.envs[job.deck] = {
      vocals: new Float32Array(n),
      drums: new Float32Array(n),
      bass: new Float32Array(n),
      instruments: new Float32Array(n),
      hop: ENV_HOP / MODEL_RATE,
      version: 0,
    };
  }

  private writeEnv(deck: number, env: { start: number; vocals: Float32Array; drums: Float32Array; bass: Float32Array; instruments: Float32Array }): void {
    const e = this.envs[deck];
    if (!e) return;
    for (const k of ["vocals", "drums", "bass", "instruments"] as const) {
      const src = env[k];
      e[k].set(src.subarray(0, Math.max(0, Math.min(src.length, e[k].length - env.start))), env.start);
    }
    e.version++;
    this.emit("envelopes", { deck });
  }

  private cancelDeck(deck: number): void {
    const j = this.deckJobs[deck];
    if (!j) return;
    this.deckJobs[deck] = null;
    if (this.port) this.port.postMessage({ type: "cancel", jobId: j.id } satisfies ToWorker);
    this.envs[deck] = null;
  }

  /** After a seek/jump, separate from the new playhead first. */
  private startSeekWatch(): void {
    if (this.seekTimer) return;
    this.seekTimer = setInterval(() => {
      for (const j of this.deckJobs) {
        if (!j || !j.runSent || j.regionsDone >= j.regions || !j.regions) continue;
        const pos = this.engine.getPosition(j.deck);
        if (this.audio.stemsReadyAtPlayhead(j.deck)) {
          this.lastPrio[j.deck] = pos;
          continue;
        }
        // Still heading for a target ahead of the playhead → let it finish instead of chasing.
        const target = this.lastPrio[j.deck];
        if (target !== undefined && target >= pos - 1 && target - pos < 30) continue;
        // Aim where the playhead will be once ~2 segments are computed (measured speed).
        const d = this.engine.getState().decks[j.deck];
        const segSec = (SEGMENT / MODEL_RATE) * (this.st.rtf ?? 1);
        const ahead = d.playing ? 2 * segSec * d.rate + 0.5 : 0;
        const next = Math.min(d.duration, pos + ahead);
        this.lastPrio[j.deck] = next;
        this.post({ type: "priority", jobId: j.id, startFrame: Math.floor(next * MODEL_RATE) });
      }
    }, 500);
  }

  // ─────────────────────────── library pre-analysis ───────────────────────────

  /** Queue local tracks for background separation into the cache. */
  analyse(tracks: TrackInfo[], readAudio: (ref: string) => Promise<ArrayBuffer>): void {
    if (!this.bridge) return;
    const local = tracks.filter((t) => t.source === "local").map((t) => t.ref);
    const skipped = tracks.length - local.length;
    if (skipped) this.log.warn("stems", `${skipped} track(s) skipped: only local files can be pre-analysed (streamed audio is never cached).`);
    for (const r of local) if (!this.libQueue.includes(r) && this.idx[r] !== "complete") this.libQueue.push(r);
    this.patchStatus({ libraryQueue: this.libQueue.length });
    void this.pumpLibrary(readAudio);
  }

  async removeCache(refs: string[]): Promise<void> {
    if (!this.bridge) return;
    await this.bridge.remove(refs);
    await this.refreshIndex();
    this.log.info("stems", `Removed STEM cache for ${refs.length} track(s)`);
  }

  private async pumpLibrary(readAudio: (ref: string) => Promise<ArrayBuffer>): Promise<void> {
    if (this.libRunning) return;
    this.libRunning = true;
    try {
      while (this.libQueue.length && this.st.available) {
        const ref = this.libQueue.shift()!;
        this.patchStatus({ libraryQueue: this.libQueue.length + 1 });
        try {
          const key = await this.bridge!.fileKey(ref);
          const bytes = await readAudio(ref);
          // Decoding straight to 44.1 kHz does the resampling for the model.
          const buf = await new OfflineAudioContext(2, 1, MODEL_RATE).decodeAudioData(bytes);
          const [left, right] = channelsOf(buf);
          const id = this.nextId++;
          await new Promise<void>((resolve, reject) => {
            this.libJobs.set(id, { id, ref, resolve, reject });
            this.post({ type: "open", jobId: id, key, persist: true });
            this.pendingRun.set(id, { left, right });
          });
          await this.bridge!.setIndex(ref, key);
          await this.refreshIndex();
        } catch (err) {
          this.log.warn("stems", `Couldn't analyse STEMS for ${ref.split(/[\\/]/).pop()}: ${String(err)}`);
        }
      }
    } finally {
      this.libRunning = false;
      this.patchStatus({ libraryQueue: this.libQueue.length });
    }
  }

  private pendingRun = new Map<number, { left: Float32Array; right: Float32Array }>();

  private onLibraryMsg(lib: LibraryJob, m: FromWorker): void {
    const finish = (err?: Error) => {
      this.libJobs.delete(lib.id);
      this.pendingRun.delete(lib.id);
      if (err) lib.reject(err);
      else lib.resolve();
    };
    switch (m.type) {
      case "cache": {
        if (m.state === "complete") return; // "done" follows once cached regions are read
        const pcm = this.pendingRun.get(lib.id);
        this.pendingRun.delete(lib.id);
        if (pcm) this.post({ type: "run", jobId: lib.id, left: pcm.left, right: pcm.right, startFrame: 0, quality: this.st.settings.quality });
        break;
      }
      case "done":
        finish();
        break;
      case "error":
        finish(new Error(m.message));
        break;
      case "region":
        break; // library jobs only fill the cache
    }
  }
}

function loadSettings(): StemSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_STEM_SETTINGS, ...JSON.parse(raw) } : DEFAULT_STEM_SETTINGS;
  } catch {
    return DEFAULT_STEM_SETTINGS;
  }
}

function channelsOf(buf: AudioBuffer): [Float32Array, Float32Array] {
  const l = new Float32Array(buf.getChannelData(0));
  const r = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : new Float32Array(l);
  return [l, r];
}

/** The model runs at 44.1 kHz; resample off the main thread with an OfflineAudioContext when needed. */
async function toModelRate(buf: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  if (buf.sampleRate === MODEL_RATE) return channelsOf(buf);
  const frames = Math.ceil((buf.length * MODEL_RATE) / buf.sampleRate);
  const ctx = new OfflineAudioContext(2, frames, MODEL_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return channelsOf(await ctx.startRendering());
}

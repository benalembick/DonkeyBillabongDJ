/**
 * Composition root: the only place where layers are wired together.
 *
 *   UI ─┐                         ┌─ AudioEngine (Web Audio worklets)
 *   Keyboard ─┼→ CommandBus → DJEngine ─┼─ LibraryStore (browser port)
 *   Controllers┘      ↑                 └─ AnalysisService (worker)
 *        └──── LED feedback ←── engine state
 */
import { AnalysisService } from "../analysis/AnalysisService";
import { WebAudioEngine } from "../audio/WebAudioEngine";
import { CommandBus } from "../core/commands";
import { DJEngine, DEFAULT_ENGINE_SETTINGS, type EngineSettings } from "../core/engine/DJEngine";
import { DEFAULT_AUDIO_CONFIG, type AudioConfig } from "../core/engine/types";
import { EventLog } from "../core/log";
import { ControllerManager } from "../controllers/ControllerManager";
import { buildDdjSbMapping } from "../controllers/profiles/pioneer-ddj-sb";
import { KeyboardShortcuts } from "../input/keyboard";
import { LibraryStore } from "../library/LibraryStore";
import { createPlatform, type AudioFileRef, type Platform } from "../platform";
import { PROVIDER_CAPABILITIES } from "../providers/MusicProvider";
import { StreamingStore } from "../providers/StreamingStore";
import type { TrackInfo } from "../core/engine/types";
import { applyTags } from "../library/tags";
import { MatchingService } from "./matching";
import { AudiusClient } from "../providers/audius/AudiusClient";
import { AudiusSource } from "../providers/audius/AudiusSource";
import { AudiusStore, BrowserRouter } from "../providers/audius/AudiusStore";
import { audiusIdFromRef } from "../providers/audius/audiusTracks";
import { StemService } from "../stems/StemService";

export interface App {
  bus: CommandBus;
  log: EventLog;
  audio: WebAudioEngine;
  engine: DJEngine;
  controllers: ControllerManager;
  library: LibraryStore;
  analysis: AnalysisService;
  /** STEM separation (desktop only; local ONNX model). */
  stems: StemService;
  keyboard: KeyboardShortcuts;
  platform: Platform;
  streaming: StreamingStore;
  matching: MatchingService;
  audius: AudiusStore;
  /** Which list the controller's browse encoder / LOAD buttons act on. */
  browser: BrowserRouter;
  /** Set a local track's star rating (persisted). */
  setRating(ref: string, rating: number): Promise<void>;
  /** Add files to the library and optionally load the first one into a deck. */
  addFiles(refs: AudioFileRef[], loadIntoDeck?: number): Promise<number>;
  saveAudioConfig(c: AudioConfig): void;
  saveEngineSettings(s: Partial<EngineSettings>): void;
}

const AUDIO_KEY = "dbdj.audioConfig.v1";
const ENGINE_KEY = "dbdj.engineSettings.v1";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* settings persistence is best-effort */
  }
}

export function createApp(): App {
  const log = new EventLog();
  const bus = new CommandBus();
  const platform = createPlatform();
  const library = new LibraryStore();
  const audiusClient = new AudiusClient();
  const audiusStore = new AudiusStore(audiusClient, log);
  const browser = new BrowserRouter(library);
  const audioConfig = load<AudioConfig>(AUDIO_KEY, DEFAULT_AUDIO_CONFIG);
  const audio = new WebAudioEngine(2, audioConfig);
  const storedSettings = load<Partial<EngineSettings>>(ENGINE_KEY, {});
  const engine = new DJEngine({
    bus,
    audio,
    log,
    browser,
    // Audius: stream the full track into memory (Range-resume on network drops); local: read the file.
    loadBytes: (t, { onProgress, signal }) =>
      t.source === "audius" ? audiusClient.downloadAudio(audiusIdFromRef(t.ref), onProgress, signal) : platform.readAudio(t.ref),
    onBrowserLoad: (deck, t) => void matching.loadToDeck(deck, t),
    deckCount: 2,
    canLoad: (t) => {
      const cap = PROVIDER_CAPABILITIES[t.source];
      return cap?.canLoadIntoDeck ? { ok: true } : { ok: false, reason: cap?.restriction ?? "source not permitted" };
    },
    settings: { ...storedSettings, jog: { ...DEFAULT_ENGINE_SETTINGS.jog, ...storedSettings.jog } },
  });
  const analysis = new AnalysisService(engine);
  const stems = new StemService(engine, audio, log, platform.kind === "desktop" ? (window.dbdjDesktop?.stems ?? null) : null);
  const controllers = new ControllerManager({ bus, feedback: engine, log, mappings: [buildDdjSbMapping()] });
  const keyboard = new KeyboardShortcuts(bus);
  const streaming = new StreamingStore(platform.streaming, log);
  const matching = new MatchingService({ engine, log, library, storage: platform.mappingStorage, remoteSources: [new AudiusSource(audiusClient)] });
  // "Available" only after a real API request succeeds.
  void audiusStore.testConnection().then(() => matching.notifySourcesChanged());

  /** Read embedded tags (ISRC, duration, BPM, key) in the background and persist them. */
  let tagQueue: string[] = [];
  let tagging = false;
  const enrichTags = async (refs: string[]) => {
    tagQueue.push(...refs);
    if (tagging) return;
    tagging = true;
    let done = 0;
    let withIsrc = 0;
    try {
      while (tagQueue.length) {
        const batch = tagQueue.splice(0, 25);
        let results;
        try {
          results = await platform.readTags(batch);
        } catch (err) {
          log.warn("library", `Couldn't read tags: ${String(err)}`);
          continue;
        }
        const updated: TrackInfo[] = [];
        for (const r of results) {
          const t = library.getByRef(r.ref);
          if (!t) continue;
          const u = applyTags(t, r);
          if (u.isrc) withIsrc++;
          updated.push(u);
        }
        library.patchTracks(updated);
        await platform.library?.save(updated).catch((err) => log.warn("library", `Library database: ${String(err)}`));
        done += updated.length;
      }
    } finally {
      tagging = false;
    }
    if (done) log.info("library", `Read tags for ${done} track(s) (${withIsrc} with ISRC)`);
  };

  // Restore the persisted library (desktop), then fill in any tags not read yet.
  if (platform.library) {
    void platform.library
      .load()
      .then((tracks) => {
        if (tracks.length === 0) return;
        library.hydrate(tracks);
        log.info("library", `Loaded ${tracks.length} track(s) from your library database`);
        const pending = tracks.filter((t) => !t.tagsRead).map((t) => t.ref);
        if (pending.length) void enrichTags(pending);
      })
      .catch((err) => log.warn("library", `Library database unavailable: ${String(err)}`));
  }

  bus.on("failed", ({ cmd, error }) => log.error("engine", `Action ${cmd.action} failed: ${String(error)}`));
  audio.on((e) => {
    if (e.type === "error") log.error("audio", e.message);
  });

  // Resilience: surface UI errors in the log; they never reach the audio thread.
  window.addEventListener("error", (e) => log.error("ui", e.message));
  window.addEventListener("unhandledrejection", (e) => log.error("ui", `Unhandled: ${String(e.reason)}`));
  window.addEventListener("beforeunload", () => controllers.shutdown());

  log.info("app", `Donkey Billabong DJ starting (${platform.kind} mode, ${platform.os})`);
  void audio.start().then(
    () => {
      const s = audio.getStatus();
      log.info("audio", `Audio running: ${s.sampleRate} Hz, base latency ${(s.baseLatency * 1000).toFixed(1)} ms, output latency ${(s.outputLatency * 1000).toFixed(1)} ms`);
    },
    () => undefined,
  );
  void controllers.init();
  keyboard.attach(window);
  // Sync phase lock (and other time-based engine work) runs off the UI frame loop.
  setInterval(() => engine.tick(), 40);

  return {
    bus,
    log,
    audio,
    engine,
    controllers,
    library,
    analysis,
    stems,
    keyboard,
    platform,
    streaming,
    matching,
    audius: audiusStore,
    browser,
    setRating: async (ref, rating) => {
      const t = library.setRating(ref, rating);
      if (t) await platform.library?.save([t]).catch((err) => log.warn("library", `Library database: ${String(err)}`));
    },
    addFiles: async (refs, loadIntoDeck) => {
      const added = library.addFiles(refs);
      if (refs.length === 0) {
        log.warn("library", "No supported audio files found (MP3, WAV, M4A/AAC, FLAC, OGG, AIFF).");
        return 0;
      }
      const n = added.length;
      if (n > 0) {
        log.info("library", `Added ${n} track(s) to the library`);
        await platform.library?.save(added).catch((err) => log.warn("library", `Library database: ${String(err)}`));
        void enrichTags(added.map((t) => t.ref));
      }
      if (loadIntoDeck !== undefined) {
        const t = library.getByRef(refs[0].ref);
        if (t) await engine.loadTrack(loadIntoDeck, t);
      }
      return n;
    },
    saveAudioConfig: (c) => save(AUDIO_KEY, c),
    saveEngineSettings: (s) => {
      engine.updateSettings(s);
      save(ENGINE_KEY, engine.getSettings());
    },
  };
}

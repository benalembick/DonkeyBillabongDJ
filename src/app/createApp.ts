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

export interface App {
  bus: CommandBus;
  log: EventLog;
  audio: WebAudioEngine;
  engine: DJEngine;
  controllers: ControllerManager;
  library: LibraryStore;
  analysis: AnalysisService;
  keyboard: KeyboardShortcuts;
  platform: Platform;
  streaming: StreamingStore;
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
  const audioConfig = load<AudioConfig>(AUDIO_KEY, DEFAULT_AUDIO_CONFIG);
  const audio = new WebAudioEngine(2, audioConfig);
  const storedSettings = load<Partial<EngineSettings>>(ENGINE_KEY, {});
  const engine = new DJEngine({
    bus,
    audio,
    log,
    browser: library,
    loadBytes: (t) => platform.readAudio(t.ref),
    deckCount: 2,
    canLoad: (t) => {
      const cap = PROVIDER_CAPABILITIES[t.source];
      return cap?.canLoadIntoDeck ? { ok: true } : { ok: false, reason: cap?.restriction ?? "source not permitted" };
    },
    settings: { ...storedSettings, jog: { ...DEFAULT_ENGINE_SETTINGS.jog, ...storedSettings.jog } },
  });
  const analysis = new AnalysisService(engine);
  const controllers = new ControllerManager({ bus, feedback: engine, log, mappings: [buildDdjSbMapping()] });
  const keyboard = new KeyboardShortcuts(bus);
  const streaming = new StreamingStore(platform.streaming, log);

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

  return {
    bus,
    log,
    audio,
    engine,
    controllers,
    library,
    analysis,
    keyboard,
    platform,
    streaming,
    addFiles: async (refs, loadIntoDeck) => {
      const n = library.addFiles(refs);
      if (refs.length === 0) {
        log.warn("library", "No supported audio files found (MP3, WAV, M4A/AAC, FLAC, OGG, AIFF).");
        return 0;
      }
      if (n > 0) log.info("library", `Added ${n} track(s) to the library`);
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

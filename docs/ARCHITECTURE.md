# Architecture

## Layers

```
┌──────────────────────── Renderer process ────────────────────────┐
│  UI (React)            src/ui/          reads state, sends Commands │
│      │  ▲ state snapshots (coalesced to 1 render / frame)          │
│      ▼  │                                                          │
│  Command Bus           src/core/commands.ts   action id + value    │
│      ▲        ▲                    │                               │
│  Keyboard   Controller engine      ▼                               │
│  src/input  src/controllers   DJ Engine  src/core/engine/DJEngine  │
│               │  ▲ LED feedback     │  deck/mixer state, cue/jog/   │
│               │  └──────────────────┤  tempo logic, mixer curves    │
│  Mapping layer (normalised JSON)    ├──► Audio Engine (interface)   │
│  ▲ Mixxx importer                   │     └ WebAudioEngine + deck   │
│  Web MIDI ◄── DDJ-SB                │       AudioWorklets (RT thread)│
│                                     ├──► Library (BrowserPort)      │
│                                     └──► events → Analysis (Worker) │
│  Providers (MusicProvider) — streaming metadata, capability gated   │
└──────────────────────────────────────────────────────────────────┘
┌──────── Electron main process (electron/main.ts) ────────┐
│ window, permissions (MIDI, audio output), file dialogs,    │
│ folder scan, read-only file access (narrow IPC surface)    │
└────────────────────────────────────────────────────────────┘
```

| Layer | Path | Depends on | Must not depend on |
|---|---|---|---|
| Core (actions, command bus, events, log) | `src/core/` | nothing | React, DOM, MIDI, Web Audio |
| DJ Engine | `src/core/engine/` | Core, `AudioEngine` interface, `BrowserPort`, loader function | React, Web Audio, MIDI |
| Audio Engine | `src/audio/` | Web Audio, engine types | React, MIDI, DJ logic |
| Controller engine + mapping | `src/controllers/` | Core, Web MIDI | React, Web Audio |
| Mixxx compatibility layer | `src/controllers/mixxx/` | mapping schema, action catalogue | runtime/engine |
| Analysis | `src/analysis/` | DJ engine events, Web Worker | UI |
| Library | `src/library/` | Core | UI, audio |
| Platform | `src/platform/` | Electron preload bridge / DOM file inputs | engine |
| Providers | `src/providers/` | engine types | engine internals |
| UI | `src/ui/` | everything above, via `App` services | — |
| Composition root | `src/app/createApp.ts` | wires all layers | — |

## Key contracts

- **Actions** (`src/core/actions.ts`): the stable vocabulary, e.g. `deck1.play`, `deck2.jog.platter`, `mixer.channel1.eq.high`, `mixer.crossfader`, `browser.load.deck1`. It is generated for up to 4 decks. Every action has a value type:
  - `button`: 1 = press, 0 = release;
  - `absolute`: 0..1;
  - `relative`: signed ticks.
  
  Actions the engine does not implement yet are still accepted: they are logged once and marked in the test screen.
- **Command bus**: the only way in. Handler exceptions are caught and logged, and never propagate into MIDI or audio callbacks.
- **AudioEngine interface** (`src/core/engine/types.ts`): backend-neutral (`loadDeck`, `setPlaying`, `seek`, `setRate`, `nudge`, `setScratching`, `scratchMove`, `setChannel`, `setMaster`, `getPosition`…). The DJ engine computes all mixer maths itself (`mixerMath.ts`), so a native backend only has to apply the final numbers.
- **Feedback keys**: `DJEngine.getFeedback("deck1.playing" | "deck1.hotcue.3" | "mixer.channel1.cue" …)` drives LEDs through the mapping's `outputs`.

## Threads

| Work | Thread |
|---|---|
| Sample playback, interpolation, scratch smoothing | AudioWorklet (real-time audio thread) |
| EQ / filter / gains | Web Audio native nodes (audio thread) |
| MIDI input → mapping → command → engine | Renderer main thread; O(1) map lookups, no allocation-heavy work |
| Waveform overview (later BPM, key, beat grid) | Web Worker |
| Decoding | `decodeAudioData` (Chromium decodes off-thread) |
| React rendering | Renderer main thread, coalesced to ≤ 1 render per animation frame; playheads and meters update DOM/canvas directly in rAF |
| Filesystem | Electron main process (async IPC) |

## Resilience rules

1. UI panels are wrapped in error boundaries. A crashed panel shows "Retry"; the engine lives outside React (`src/main.tsx`) and keeps running.
2. Emitters isolate listener exceptions.
3. Controller disconnects only detach MIDI handlers; audio is untouched. Reconnection is automatic through Web MIDI `statechange`.
4. Track load failures mark the deck `error` and log; other decks are unaffected. Stale loads are cancelled by token.
5. By default the engine refuses to load a new track into a playing deck.
6. Provider and network errors are confined to the provider layer (Phase 5), and providers never touch decks directly.

## Scaling to 4 decks

`DJEngine` and `WebAudioEngine` take `deckCount`, and actions exist for decks 1–4. The UI currently renders 2 decks. Crossfader assignment per deck is in `EngineSettings.crossfaderAssign`.

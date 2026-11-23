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
| Deck layers + soft takeover | `src/controllers/layers.ts`, `src/controllers/softTakeover.ts` (wired in `ControllerManager`) | Core, mapping schema, a value reader (`DJEngine.getActionValue`) | React, Web Audio, a specific controller |
| Workspace (2/4 DECK, densities, lanes, focus) | `src/workspace/` | Core events | engine, audio — switching never touches playback |
| Analysis | `src/analysis/` | DJ engine events, Web Worker | UI |
| Library | `src/library/` | Core | UI, audio |
| Platform | `src/platform/` | Electron preload bridge / DOM file inputs | engine |
| Providers | `src/providers/` | engine types | engine internals |
| AI Set Studio | `src/setstudio/` (pure scoring/curves/optimiser + `SetStudioService`, `LibraryIntelligence`) | Library, Preparation, AnalysisService, Playlists, Auto DJ, DJ Engine (public APIs only) | Web Audio, a second analysis or playback path — see [architecture/AI_SET_STUDIO.md](architecture/AI_SET_STUDIO.md) |
| Drum Transcriber | `src/production/drums/` (pure DSP/classifier/timing/MIDI + `DrumTranscriber` service, worker) | Production Studio sources and output, WebAudioEngine decode, Preparation grids, `DocStore` — see [DRUM-TRANSCRIBER.md](DRUM-TRANSCRIBER.md) | a second sequencer, audio engine or persistence path |
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

## Four decks

The engine and audio graph always run four decks (`DECK_COUNT` in `createApp.ts`). The **2 DECK / 4 DECK** workspace mode (`src/workspace/WorkspaceStore.ts`) only changes what is shown.

- Each channel has its own crossfader assignment (A | THRU | B) in `EngineSettings.crossfaderAssign`.
- Unattended automation may only use decks reserved for it (`EngineState.reservations`: A/B automation, C/D manual).
- A two-channel controller reaches decks C/D through deck layers, with soft takeover for absolute controls.

Full design, verification results and the Phase 2–5 roadmap are in [architecture/four-deck-performance-engine.md](architecture/four-deck-performance-engine.md).

## Deck colour identity

Deck A is blue, B orange, C green and D purple. Every deck-specific colour comes from `src/ui/deckTheme.ts`:

- **Canvas waveforms** read the packed palette (`deckWavePalette(deck)`).
- **CSS** reads variables that `installDeckThemeCss()` writes onto `:root` at startup. Deck scopes (`.deck-a`…`.deck-d`, `.deck-scope-a`…`-d`, `.strip.channel-a`…`-d`) map them to `--deck-color` and related names.

Do not hardcode deck colours in components. Colours belong to the deck index, never to the track, and functional colours keep their meaning: hot cues, STEM colours, transport states, meters, warnings. The default waveform style, Dual-Deck Tonal, maps the cached low/mid/high analysis onto each deck's three-band ramp at draw time, so no re-analysis is needed. See [DECK-COLOUR-IDENTITY.md](DECK-COLOUR-IDENTITY.md).

## Feature catalogue

The user-facing About screen is backed by `src/about/features.ts`. This file is the canonical catalogue of capabilities that are currently developed and features explicitly marked as coming soon.

Every change that adds, removes, renames, substantially changes, or completes a product feature **must update `src/about/features.ts` in the same change set**. When a planned feature ships, move it from `COMING_SOON` into the appropriate `DEVELOPED_FEATURES` group rather than leaving duplicate or stale entries. Keep descriptions factual and avoid listing speculative work that has not been accepted into the roadmap.

The About UI (`src/ui/About.tsx`) only renders this catalogue. Feature descriptions must not be hard-coded elsewhere in that component, which keeps catalogue maintenance reviewable and prevents the displayed status from drifting away from the application architecture.

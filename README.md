# Donkey Billabong DJ

A cross-platform (macOS / Windows) two-deck DJ application, built around hardware control. The first target controller is the **Pioneer DDJ-SB**.

React + TypeScript UI · Electron desktop shell · Web Audio / AudioWorklet engine · Web MIDI controller engine · normalised controller mappings with a **Mixxx mapping importer**.

> **Status: Phase 1: hardware + audio proof of concept.** The interface is deliberately utilitarian until the DDJ-SB → app → audio path has been proven on real hardware. See [docs/HARDWARE-TEST-PLAN.md](docs/HARDWARE-TEST-PLAN.md).

## Quick start

```bash
npm install
npm run dev        # desktop app with hot reload
npm test           # unit tests
npm run smoke      # launch, self-check, print a health report
```

Loading music:

- **⏏ LOAD…** on a deck (or click an empty deck's title) opens a file picker.
- **Drag files or folders** from Explorer or Finder onto a deck to load them there, or onto the library to add them.
- Library → **+ Add files… / + Add folder…**, then double-click a row, drag it onto a deck, or use the **→ A / → B** buttons.
- DDJ-SB: turn the browse encoder, then press **LOAD A/B**.

Streaming: Library → MUSIC → **Spotify** or **Apple Music** walks you through connecting your account. **Smart Match** then finds each Spotify/Apple track in your own library (by ISRC, then title, artist, version and length) and loads *your file* (see [docs/STREAMING-INTEGRATIONS.md](docs/STREAMING-INTEGRATIONS.md)).

## What works now (Phase 1)

- Electron desktop app (Windows verified by an automated smoke test with real audio output; macOS build configured).
- Two independent decks on a real-time AudioWorklet player: play/pause, CDJ-style CUE (set, return, hold-to-preview), tempo with ±6/10/16%/WIDE ranges, jog nudge while playing, precise jog positioning while paused, vinyl scratching, 8 hot cues, click-to-seek overview waveform (computed in a worker).
- Mixer: gain, 3-band EQ with kills, filter, channel faders, crossfader (3 curves), master, headphone cue/mix on 4-output devices, level meters.
- DDJ-SB auto-detection and hot-plug ("Pioneer DDJ-SB — Connected" / "disconnected — playback continues"), full MIDI mapping (52 physical controls, 200 bindings), LED feedback.
- **Live controller events** feed (`PLAY A`, `JOG A +4`, `TEMPO A +1.7%`, `EQ HIGH A 64`…), **MIDI monitor**, **controller test** screen with a copyable pass/fail report.
- **Mixxx mapping importer**: translates any Mixxx `.midi.xml` into our format. On the real DDJ-SB mapping it translates 183 of 220 controls, all identical to our built-in mapping.
- Keyboard shortcuts (Space = Deck A play, Shift+Space = Deck B, C/M = cue, 1–4 / 7–0 = hot cues, A/D and J/L = jog, ↑/↓ browse, Shift+←/→ load).
- Diagnostics (audio backend, sample rate, latency estimate, MIDI devices, messages/sec, event log) and settings (audio device, routing, latency, sample rate, jog calibration and sensitivities, tempo direction, crossfader curve, mapping import/export).

## Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ (awaiting hardware sign-off) | Hardware + audio proof of concept |
| 2 | BPM / beat grid / key analysis, scrolling + stacked waveforms, sync, loops, key lock, isolator EQ |
| 3 | SQLite library, tag reading, playlists, smart playlists, history, analysis cache |
| 4 | Mapping editor (MIDI learn), full LED coverage, FX/sampler actions for the DDJ-SB |
| 5 | Spotify / Apple Music providers, **metadata and browsing only** (see below) |
| 6 | Recording, advanced FX, 4 decks, more controllers |

**Streaming:** you can connect Spotify Premium and Apple Music accounts to browse playlists, liked or library songs and search, and tracks you also own locally are matched and loadable. Spotify's and Apple's public developer terms do not allow their audio to be mixed in third-party software; DJ integration is licensed privately to partner apps such as rekordbox and Serato. So streaming-only tracks cannot be loaded onto decks. Details are in [docs/STREAMING-INTEGRATIONS.md](docs/STREAMING-INTEGRATIONS.md).

## Documentation

- [Technical findings](docs/TECHNICAL-FINDINGS.md): architecture decision, audio, DDJ-SB, Mixxx, Spotify, Apple, risks
- [Architecture](docs/ARCHITECTURE.md)
- [Controller mappings](docs/CONTROLLER-MAPPINGS.md): format, DDJ-SB, Mixxx import, adding controllers, debugging MIDI
- [Audio engine](docs/AUDIO-ENGINE.md): design, latency, native backend option, adding effects
- [Streaming integrations](docs/STREAMING-INTEGRATIONS.md): provider abstraction, restrictions, adding providers
- [Smart Metadata Matching](docs/SMART-METADATA-MATCHING.md): Spotify/Apple Music playlists resolved to your own files (ISRC + metadata scoring)
- [Development](docs/DEVELOPMENT.md): running, building macOS / Windows, layout, conventions
- [Hardware test plan](docs/HARDWARE-TEST-PLAN.md) and the generated [DDJ-SB test matrix](docs/DDJ-SB-TEST-MATRIX.md)

## Acknowledgements

DDJ-SB MIDI layout information comes from the [Mixxx](https://mixxx.org) DDJ-SB mapping by Joan Ardiaca Jové, wingcom and Hilton Rudham (MIT-licensed script). Mixxx is not affiliated with this project. Pioneer DJ and DDJ-SB are trademarks of their owners.

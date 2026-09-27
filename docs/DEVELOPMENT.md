# Development

## Prerequisites

- Node.js 22+ (developed on Node 24) and npm.
- macOS 12+ or Windows 10/11.
- Optional: a Pioneer DDJ-SB. Close Serato, rekordbox and Mixxx first, because Windows MIDI ports are single-client.

```bash
npm install
```

## Run

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Electron with hot reload and DevTools (full desktop functionality) |
| `npm run dev:web` | Browser mode at http://localhost:5173. Use Chrome or Edge (Web MIDI). Folder scanning is limited to the browser's picker, and output routing depends on the browser |
| `npm run build` then `npm start` | Production renderer in Electron |
| `npm run smoke` | Builds, launches Electron headless-ish, prints a JSON health report (audio, MIDI, errors) and exits. Add `DBDJ_SMOKE_TRACK=/path/file.wav` to also check real playback |
| `npm test` | Unit tests (Vitest): engine logic, mixer and jog maths, mapping runtime, DDJ-SB mapping integrity, Mixxx importer |
| `MIXXX_MAPPING=/path/Pioneer-DDJ-SB.midi.xml npm test` | Also runs the importer against a real Mixxx mapping |
| `npm run typecheck` | TypeScript |
| `npm run docs:test-matrix` | Regenerates `docs/DDJ-SB-TEST-MATRIX.md` from the mapping |

> The Electron launcher (`scripts/run-electron.mjs`) clears `ELECTRON_RUN_AS_NODE`. Some hosts, such as VS Code extension terminals, set it, which would otherwise make Electron start as plain Node.

## Build installers

```bash
npm run dist:win   # on Windows → release/DonkeyBillabongDJ-Setup.exe
npm run dist:mac   # on macOS   → release/DonkeyBillabongDJ-macOS.dmg (universal)
```

> On this PC the build fails with `EPERM … rename win-unpacked.tmp` inside Documents, because Windows protection (Controlled Folder Access or OneDrive) blocks it. Build to another folder instead:
> `npx electron-builder --win --publish never --config.directories.output=C:/Temp/dbdj-release`

## Publishing a release (GitHub)

The browser version's **⬇ Get the desktop app** button links to the *latest GitHub Release* of the repo in `package.json → repository` (`benalembick/DonkeyBillabongDJ`), using the stable asset names above.

1. The repo (or at least its releases) must be **public**, otherwise visitors can't download.
2. Bump `version` in package.json, commit, then tag and push:
   ```bash
   git tag v0.1.1 && git push origin main v0.1.1
   ```
3. `.github/workflows/release.yml` builds on Windows and macOS runners, runs the tests, and builds each installer, then a final job publishes whatever built to a GitHub Release marked "latest", so one platform failing does not block the other.
4. Optional signing: add the secrets listed in the workflow to remove the SmartScreen and Gatekeeper warnings.

For distribution without warnings:

- **macOS**: set `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID certificate) and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for notarisation. `hardenedRuntime` is already enabled in `package.json`.
- **Windows**: set `CSC_LINK` to a code-signing certificate, or SmartScreen will warn.

## Project layout

```
electron/            main process + preload (narrow IPC)
src/core/            actions, command bus, events, log, DJ engine (platform-neutral)
src/audio/           Web Audio engine + deck AudioWorklet
src/controllers/     Web MIDI manager, mapping schema/runtime, Mixxx importer, profiles
src/analysis/        worker-based analysis (overview waveform; BPM/key later)
src/library/         library store (in-memory now, SQLite in Phase 3)
src/providers/       MusicProvider abstraction + capability declarations
src/input/           keyboard shortcuts
src/platform/        desktop vs browser file access
src/ui/              React UI
tests/               Vitest
docs/                design docs, findings, test plans
```

## Debugging

- DevTools opens automatically in `npm run dev`. `window.dbdj` gives access to `engine`, `audio`, `bus`, `controllers`, `library` and `log`.
- The Diagnostics tab shows audio backend and latency, MIDI devices and messages per second, loaded tracks, and the event log.
- For MIDI debugging, see [CONTROLLER-MAPPINGS.md](CONTROLLER-MAPPINGS.md#debugging-midi).

## Conventions

- New behaviour goes into an **action** (catalogue) plus an **engine handler**. UI, keyboard and controllers only dispatch actions.
- The engine must not import React, the DOM (outside the platform/audio layers) or Web MIDI.
- No allocation, logging or imports in AudioWorklet `process()` code.
- A feature that is not implemented yet stays in the catalogue with `implemented: false`, so mappings stay complete and the test screen is honest.

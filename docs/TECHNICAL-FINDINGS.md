# Technical Findings (Phase 0)

_Research date: 27 September 2026. Re-check the streaming sections before Phase 5; both services changed their terms in the last 18 months._

## 1. Desktop architecture — **Electron** (recommended, implemented)

| Criterion | Electron | Tauri |
|---|---|---|
| MIDI (DDJ-SB) | Web MIDI works on macOS + Windows (Chromium); hot-plug events | **macOS WebKit (WKWebView) has no Web MIDI.** We would need a Rust `midir` plugin plus IPC for every message |
| Low-latency audio | Chromium Web Audio + AudioWorklet, identical on both OSes; `AudioContext.setSinkId` for device choice | WebKit on macOS / WebView2 on Windows: two different audio stacks and feature sets; no `setSinkId` in WebKit |
| Filesystem | Node APIs in main process (narrow IPC surface) | Rust commands |
| Consistency | One engine (Chromium) on every OS → one set of bugs | Two web engines |
| Packaging | `electron-builder`: DMG/ZIP (mac), NSIS/ZIP (Windows), signing + notarisation supported | Smaller binaries |
| Toolchain here | Node 24 only | Needs Rust (not installed on this machine) |

The decisive factor is that Tauri on macOS has no Web MIDI. The DJ engine code is platform-neutral, so the wrapper can be swapped later. Browser mode (`npm run dev:web`) runs the same app in Chrome or Edge with Web MIDI; it lacks folder scanning, file paths and device routing.

## 2. Audio engine — **Web Audio + AudioWorklet now, native backend behind the same interface later**

- Every deck is an `AudioWorkletNode` on the real-time audio thread. It plays decoded PCM at a signed variable velocity with Hermite interpolation, which covers tempo, nudge, reverse and scratch in one mechanism. Parameter ramps and de-click fades are built in.
- The mixer (trim → 3-band EQ → HP/LP filter → fader × crossfader, plus a pre-fader PFL send) uses native Web Audio nodes.
- **Measured on this Windows machine (default device, WASAPI shared):** `baseLatency` 10 ms and `outputLatency` about 48 ms. The 48 ms is dominated by the device and Windows shared-mode mixing, not by the engine. The DDJ-SB's own USB audio should be far lower, but it must be measured on the hardware. Controller-to-audio feel is the key go/no-go test in Phase 1.
- **Risk / fallback:** if Chromium's WASAPI shared-mode latency is too high on Windows, add a `NativeAudioEngine` that implements the same `AudioEngine` interface. It would use a Node native addon (PortAudio or RtAudio via N-API, or a Rust cpal addon) giving ASIO/WASAPI-exclusive on Windows and CoreAudio on macOS, fed from a SharedArrayBuffer ring buffer. The DJ engine, mapping layer and UI would not change.
- **Key lock** (time-stretching) needs a phase-vocoder or WSOLA stretcher in the worklet (e.g. a SoundTouch port or Rubber Band via WASM). This is Phase 2.

## 3. DDJ-SB connection method

- The DDJ-SB is a **USB class-compliant MIDI + audio device**. MIDI needs no driver on macOS; on Windows the class driver works, and Pioneer's driver adds ASIO.
- **MIDI:** Web MIDI in Electron's renderer. Port names are matched with `DDJ[- ]?SB(?![0-9])`, which deliberately excludes the SB2 and SB3. Hot-plug is handled through `onstatechange` with a debounced rescan. A disconnect never touches audio; the status reads "Pioneer DDJ-SB disconnected — playback continues", and the controller re-attaches automatically.
- **Audio:** the built-in sound card exposes master and headphone outputs as one 4-channel device. The engine's **quad routing** sends master to outputs 1/2 and the headphone cue mix to 3/4 from a single `AudioContext`, with no clock-drift problems. **Risk:** Chromium only exposes 4 channels if the OS reports them. On Windows the device may need to be set to a 4-channel/quadraphonic format in Sound settings. If only 2 channels are visible, headphone cueing on the DDJ-SB needs the native backend (ASIO exposes all channels).
- **Windows exclusivity:** WinMM MIDI ports are single-client. If Serato, rekordbox or Mixxx is running, the port cannot be opened. Close them first.
- **Jog resolution** is not documented. Mixxx uses 720 ticks per revolution for scratching. The app shows live cumulative jog ticks so this can be calibrated in a few seconds on the hardware.

## 4. Mixxx mapping strategy

- **Location:** `mixxxdj/mixxx` → `res/controllers/Pioneer-DDJ-SB.midi.xml` plus `Pioneer-DDJ-SB-scripts.js`.
- **Licence:** Mixxx is GPL-2.0-or-later, but the DDJ-SB script header states it is **published under the MIT licence** (authors Joan Ardiaca Jové, wingcom, Hilton Rudham). We still neither bundle nor execute Mixxx files. Our built-in mapping is an independent re-expression of the MIDI facts in our own schema, with attribution.
- **Format:** XML `<control>` entries (`group` like `[Channel1]`, `key`, `status`, `midino`, `options`) and `<output>` entries for LEDs. The options are `normal`, `invert`, `fourteen-bit-msb/lsb`, `selectknob`, `script-binding` and a few others. Most DDJ-SB controls are `<script-binding/>`: the JS computes 14-bit values, jog behaviour, shift and LEDs.
- **What the DDJ-SB mapping tells us:**
  - Deck buttons are notes on channel 1/2.
  - EQ, fader and tempo are **14-bit CC pairs** (MSB n, LSB n+0x20).
  - Jog wheels are relative, centred on 0x40: 0x21 is the ring, 0x22/0x23 the platter, 0x1F/0x26 shifted, and notes 0x35/0x36/0x67 are touch.
  - The browse encoder is two's-complement relative.
  - Pads are on channel 8/9, and **the pad mode is chosen in hardware**. Each mode and shift layer sends different notes: hot cue 0x00+ (0x40+ for cues 5–8), auto loop 0x10+, manual loop 0x20+, sampler 0x30+, and shift adds 0x08.
  - The global section is on channel 7: crossfader, headphone mix, filters and load buttons.
  - **LEDs** are driven by sending the same note back with 0x7F/0x00.
  - There is **no trim knob**; Mixxx uses SHIFT+FILTER for gain, and we do the same.
- **Compatibility layer:** `MixxxImporter` handles any Mixxx `.midi.xml`. Exact `(group, key)` pairs translate through a table of Mixxx's public control names. Script-bound controls are inferred from their function names and flagged "heuristic", with 14-bit MSB/LSB pairs merged. Everything else is listed as unresolved. Script JS is never executed.
- **Validation:** importing the real DDJ-SB XML gives **183 of 220 controls translated, and all 183 agree exactly with our hand-built mapping**. The 19 unresolved entries are FX buttons whose meaning lives in script code, the deck-toggle, and Mixxx skin toggles. This suggests the importer will bring many other Mixxx-supported controllers most of the way.

## 5. Spotify

- **Public API (Web API + Web Playback SDK):**
  - The Developer Terms (v10, effective 15 May 2025) prohibit altering Spotify content and enabling stream capture.
  - Spotify's developer policy explicitly lists **"DJ/Mixes — using Spotify's catalog to segue, mix, re-mix, or overlap any Spotify Content with any other audio content"** and synchronising recordings as prohibited.
  - Since **February–March 2026**, Development Mode apps need a Premium account, are limited to one client ID with 5 authorised users, and get a reduced endpoint set. Broader access requires Spotify's extended-quota review.
- **What exists for DJs:** Spotify has integrated with rekordbox, Serato and djay since September 2025, and with VirtualDJ, Cross DJ and edjing since September 2026. These are **licensed partner integrations**, not a public API.
- **Therefore:** a Spotify provider can offer OAuth (PKCE), library, playlist and search browsing, metadata and artwork only. Spotify tracks are shown as "not loadable" with the restriction text. No playback enters our engine, and there is no recording. Stream extraction, DRM circumvention and cookie scraping are not options.

## 6. Apple Music

- **Public API:** the Apple Music API and MusicKit JS need an Apple Developer membership and a MusicKit developer token (JWT). They allow authentication, library and playlist access, catalogue search, metadata and artwork, plus **MusicKit-controlled playback** of DRM-protected (FairPlay/Widevine) audio. That audio cannot be routed into our DSP.
- **What exists for DJs:** "DJ with Apple Music" (rekordbox, Serato, Engine DJ, djay; March 2025) is a **partner entitlement**, not available through public MusicKit.
- **Therefore:** browse, metadata and artwork are fine, and optionally a separate MusicKit player for preview. Stock Electron lacks Widevine; the Castlabs Electron build would be needed. Apple Music tracks cannot be loaded onto decks or recorded. A partner application to Apple is the only legitimate route to mixing.

## 7. Major technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Windows output latency via Chromium/WASAPI shared (~48 ms measured on the default device) | Feel of jog and cue | Measure with the DDJ-SB sound card; choose the lowest latency setting; native backend fallback (see §2) |
| DDJ-SB 4-channel output not exposed to Chromium | No headphone cueing on the controller | Windows quadraphonic speaker setup; native ASIO backend |
| Jog resolution and direction assumptions (720 ticks, slider down = faster) | Scratch and nudge scaling | Live tick counter and settings; confirmed during the hardware spike |
| MIDI on the renderer main thread shares time with React | Controller jitter under heavy UI | UI renders coalesced to one frame; mapping is O(1) lookups; move the UI to a separate process or worker if needed |
| Memory: decoded PCM kept twice (main + worklet) | About 200 MB per 5-min track pair | Phase 2: Int16 storage or a shared buffer |
| Key lock quality in WASM | Audible artefacts | Evaluate SoundTouch vs Rubber Band in Phase 2 |
| Streaming terms change | Feature availability | All streaming sits behind `MusicProvider` with declared capabilities |

Sources: [Spotify Developer Terms](https://developer.spotify.com/terms) · [Spotify compliance tips](https://developer.spotify.com/compliance-tips) · [Spotify Feb 2026 dev-mode changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) · [Spotify DJ partner integration](https://newsroom.spotify.com/2025-09-24/dj-software-integration-premium/) · [DJ with Apple Music (DJ Mag)](https://djmag.com/tech/you-can-now-dj-apple-music-using-rekordbox-serato-and-more) · [Mixxx controllers](https://github.com/mixxxdj/mixxx/tree/main/res/controllers) · [Mixxx DDJ-SB manual](https://manual.mixxx.org/2.3/sl/hardware/controllers/pioneer_ddj_sb)

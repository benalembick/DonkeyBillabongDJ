# Audio Engine

## Current backend: Web Audio + AudioWorklet (`src/audio/`)

### Deck player (`deck-processor.ts`, real-time thread)

- Holds each deck's decoded PCM (`Float32Array` per channel, transferred, not copied, into the worklet).
- **Velocity model**: every render quantum it computes a target velocity in source frames per output frame:
  - playing: `(rate + bend) × srcRate/ctxRate`;
  - scratching: the platter's target position minus the playhead, divided by a 2.5-block lag, then smoothed and clamped to ±12×;
  - paused: 0 after a 4 ms fade.
  
  Velocity is ramped per sample across the block, so tempo moves, nudges and scratches are click-free. Negative velocity plays in reverse.
- **Nudge** (jog while playing) adds to `bend`, which decays with τ = 60 ms. The jog therefore gives a temporary pitch bend that returns to the set tempo, which is how CDJs feel.
- **Interpolation**: 4-point Hermite. Hot cue and cue jumps use a 96-sample fade-in.
- **Position reporting**: about every 3 blocks it posts `{seconds, speed, contextTime, seq}`. The main thread extrapolates the playhead using `AudioContext.getOutputTimestamp()`, so displayed and cue-set positions match what is **audible**, not what was just rendered. Reports carry the sequence number of the last command, so stale reports never undo a fresh seek or pause.
- Rules: no allocation in `process()`, no logging, no imports.

### Mixer graph

```
Deck worklet → trim → low shelf 220 Hz → peaking 1 kHz → high shelf 3.5 kHz → HPF → LPF ─┬→ fader×xfader → meter → master bus → master gain
                                                                                        └→ PFL send → cue bus
```

- EQ runs from −40 dB (kill) to +6 dB. The curves live in `src/core/engine/mixerMath.ts` and are shared by every backend.
- Filter knob: left sweeps a low-pass from 20 kHz down to 60 Hz; right sweeps a high-pass from 20 Hz up to 8 kHz; the centre is bypassed.
- Crossfader curves: additive (default), smooth (constant power) and sharp (scratch).
- All parameter changes use `setTargetAtTime` with an 8 ms time constant, so there is no zipper noise.

### Output routing

| Routing | Outputs | Use |
|---|---|---|
| `stereo` | master → 1/2 | Laptop / single stereo interface; no headphone cue |
| `quad` | master → 1/2, headphone mix (cue ↔ master, level) → 3/4 | DDJ-SB built-in sound card, 4-output interfaces |

Quad routing builds a 4-channel destination (`channelInterpretation: "discrete"`) with a ChannelMerger. It falls back to stereo with a logged warning if the device exposes fewer than 4 channels.

Device selection uses `AudioContext.setSinkId()`. A device change is applied live. Changing the sample rate, latency or routing rebuilds the context: loaded tracks, positions and play state are restored automatically.

### Latency

- `latencyHint` accepts "interactive" (lowest), a number of seconds (≈ buffer size), or "balanced".
- Diagnostics show `baseLatency` (the processing buffer), `outputLatency` (device plus OS), and their sum as the estimated total.
- **Dropped buffers** are not exposed by Web Audio today. If Chromium's `AudioContext.playoutStats` becomes available in our Electron version, we will surface it; until then, listen for glitches during the hardware spike.
- Measured on the development PC (default output, WASAPI shared): base 10 ms plus output ≈ 48 ms.

### Known limitations (planned)

| Item | Phase |
|---|---|
| Key lock (time-stretch; SoundTouch or Rubber Band in WASM inside the worklet) | 2 |
| Isolator-style EQ (Linkwitz-Riley crossover) | 2 |
| Separate headphone device (second context with clock-drift compensation) | 2 |
| Recording (tap the master bus into a worklet, write WAV in a worker; local sources only) | 6 |
| Int16 or shared PCM storage (halves memory) | 2 |

## Native backend option

If Windows shared-mode latency is not good enough, implement `AudioEngine` (`src/core/engine/types.ts`) natively:

- a Node addon (N-API) using PortAudio or RtAudio, or a Rust cpal addon via napi-rs, giving ASIO or WASAPI-exclusive on Windows and CoreAudio on macOS;
- the worklet's deck algorithm ported (it is about 150 lines, with no Web APIs in its core);
- commands sent from the renderer over a `SharedArrayBuffer` ring buffer (requires cross-origin isolation headers in Electron), or the engine run in a utility process.

The DJ engine, mappings and UI stay unchanged. That independence is the reason the interface exists.

## FX engine (implemented)

- **Two FX units** (`src/audio/fx.ts`). Each mixer channel has one slot per unit, placed after the channel filter and before the fader and PFL.
- **Types:**
  - Echo and Delay: tempo-synced feedback delays. Echo has a darkening low-pass in the feedback loop.
  - Reverb: convolution with a generated impulse, size set by the parameter.
  - Flanger: LFO-modulated short delay with feedback.
  - Filter: resonant low-pass or high-pass sweep.
- **Send vs insert:** Echo, Delay and Reverb are *send* effects. The dry signal stays at full level, and turning the unit off closes the send so tails ring out. Flanger and Filter are *insert* effects: dry drops as the level rises.
- **Timing:** `timeSec = beats × 60 / BPM` of the first assigned deck (analysed or tagged BPM × pitch). It is recomputed on every tempo change.
- **Actions:** `fx.unitN.on / mix / param / chain.next|prev / beats.next|prev / assign.deckK`. DDJ-SB: FX button 1 = on (LED), 2 = next effect, 3 = beat length; FX knob = level; SHIFT + knob = parameter.

## Track analysis (waveforms + beat grid)

`src/analysis/analyzeTrack.ts` runs in a Web Worker. It produces:

- a 3-band waveform: one-pole crossovers at 200 Hz and 2.5 kHz, with peaks stored 150 times per second;
- a tempo estimate: onset-strength envelope, then autocorrelation to find the tempo family, then a fine comb search (±2 %) for exact BPM and phase.

A tag or service BPM is used as a hint and is octave-aware. The result is an **estimated** beat grid: BPM, first beat, and downbeats assumed every 4 beats. Unit tests confirm 96, 128 and 174 BPM are detected within ±0.3 BPM and 30 ms of phase on synthetic tracks. Manual grid editing, key detection and sync are Phase 2.

## Waveform styles

Settings → Waveform (also in the VIEW menu) offers five Mixxx-style renderings. The choice applies immediately to both decks, the overview and the scrolling waveform in every layout, and is remembered:

| Style | Rendering |
|---|---|
| Simple | Full-band peak in one colour; stereo tracks show left above and right below the centre |
| Filtered | Red lows, green mids, blue highs as stacked bands |
| RGB (default) | One waveform whose colour mixes low (R), mid (G) and high (B) energy; overlaps give orange, yellow, purple |
| RGB L/R | RGB colouring per channel: left above, right below |
| HSV | Hue follows the spectral balance, highs desaturate, strong lows darken |

The data comes from the same analysis pass. It adds per-channel display bands: 2-pole splits at ~250 Hz and ~4 kHz, plus a full-band peak, stored 150 times per second. The mono 200 Hz / 2.5 kHz bands that drive beat, energy and cue detection are unchanged. Display bands are cached with the waveform as 8-bit square-root-companded data. Tracks cached before this feature display at once from the mono bands, and gain the stereo data in the background the next time they are loaded; their cached grid, cues and sections are kept as they were. All styles share one renderer (), so every view of a track matches.

## Waveform styles

Settings → Waveform (also in the VIEW menu) offers five Mixxx-style renderings. The choice applies immediately to both decks, the overview and the scrolling waveform in every layout, and is remembered:

| Style | Rendering |
|---|---|
| Simple | Full-band peak in one colour; stereo tracks show left above and right below the centre |
| Filtered | Red lows, green mids, blue highs as stacked bands |
| RGB (default) | One waveform whose colour mixes low (R), mid (G) and high (B) energy; overlaps give orange, yellow, purple |
| RGB L/R | RGB colouring per channel: left above, right below |
| HSV | Hue follows the spectral balance, highs desaturate, strong lows darken |

The data comes from the same analysis pass. It adds per-channel display bands: 2-pole splits at ~250 Hz and ~4 kHz, plus a full-band peak, stored 150 times per second. The mono 200 Hz / 2.5 kHz bands that drive beat, energy and cue detection are unchanged. Display bands are cached with the waveform as 8-bit square-root-companded data. Tracks cached before this feature display at once from the mono bands, and gain the stereo data in the background the next time they are loaded; their cached grid, cues and sections are kept as they were. All styles share one renderer (`src/ui/waveStyle.ts`), so every view of a track matches.

## Adding an audio effect (Phase 6 structure)

1. Create `src/audio/effects/<Name>.ts` that exposes `{ input: AudioNode, output: AudioNode, setParam(name, value) }`, or an AudioWorklet processor for custom DSP.
2. Register it in the effect registry, then add actions (`fx.unitN.*` already exist in the catalogue) and map them in the DJ engine.
3. Insert it after the LPF in the channel chain (a per-channel FX send) or on the master bus.

## STEMS (implemented)

The deck worklet has three outputs: output 0 is the deck audio, outputs 1 and 2 are the per-stem sends for FX units 1 and 2. Separated vocals, drums and bass arrive as Int16 regions (`stemsInit` / `stemsRegion` messages; buffers are transferred, never copied on the audio thread). The worklet reads them at the same fractional position as the original, computes instruments as `original − vocals − drums − bass`, applies smoothed per-stem gains (6 ms), and crossfades between the original and the stem mix (12 ms) depending on whether the region under the playhead is ready. Separation itself runs in a separate process. See [STEMS.md](STEMS.md).

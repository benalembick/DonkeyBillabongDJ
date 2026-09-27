# STEMS: real-time stem separation

Each deck can split its track into **Vocals, Drums, Bass and Instruments** and mix them live: mute, solo, per-stem volume and per-stem FX sends. The separation is real: a neural network (HT-Demucs) runs locally. No cloud service is used, and no audio leaves the computer.

## Architecture

```
 renderer (UI thread)                 stem worker (Electron utilityProcess)          audio thread (AudioWorklet)
 ───────────────────                  ──────────────────────────────────            ─────────────────────────
 DJEngine: deck.stems state ──┐        ONNX Runtime (onnxruntime-node)               deck-processor.ts
   actions deckN.stem.*       │        HT-Demucs 4-stem, 44.1 kHz, 7.8 s segments      original track (always)
 StemService ────── MessagePort ────▶  SeparationJob (overlap-add, playhead first) ── + stem regions (Int16)
   decoded track → 44.1 kHz  │         StemCache (disk, content-keyed)                  mix = Σ stem·gain
   regions ──────────────────┼──────────────────────────────────────────────────────▶ crossfades per region
   envelopes → STEM waveform │                                                         FX sends (outputs 1/2)
 main process: model download, settings, cache index, worker lifecycle (electron/stems/host.ts)
```

- **Never blocks audio.** Inference runs in a separate OS process (`electron/stems/worker.ts`). The audio thread only receives finished regions, transferred without copying, and reads them the same way it reads the original track. If the worker crashes or is slow, the deck simply keeps playing the original.
- **Progressive.** The track is split into regions of about 5.9 s (the segment stride). Each region is sent to the deck as soon as every segment overlapping it has been separated. The job starts at the playhead. After a seek or hot-cue jump it re-prioritises from a point slightly ahead of the playhead, worked out from the measured speed, so it doesn't chase a moving target.
- **Sample accurate, fully synced.** Stems are read at the same fractional position as the original, with the same Hermite interpolation. Tempo, pitch range, nudges, scratching, cues, hot cues, loops and seeks therefore affect stems exactly as they affect the track. Where a region isn't separated yet, the deck crossfades (12 ms) back to the original, so there are never gaps.
- **Loss-free by construction.** Only vocals, drums and bass are stored. Instruments are computed as `original − vocals − drums − bass`. With every stem up, the output equals the original track bit-for-bit (up to Int16 rounding of the three stored stems).
- **Per-stem FX.** An FX unit can target the whole deck or one stem (FX bar selector, or `fx.unitN.target.next`). For echo, delay and reverb the worklet sends the chosen stem, after its mute and volume, to that unit's dedicated output. Filter and flanger are inserts and always act on the whole channel.

## Model and acceleration

| | |
|---|---|
| Model | HT-Demucs 4-stem (Défossez et al., Meta AI), ONNX export `StemSplitio/htdemucs-onnx`, MIT licence, pinned revision + SHA-256 |
| Size | 166 MB, downloaded once from Settings → STEMS, checksum-verified, stored in the app's user-data folder |
| Runtime | ONNX Runtime 1.30 (`onnxruntime-node`) |
| Windows | DirectML (any DirectX 12 GPU: NVIDIA, AMD, Intel), falling back to CPU |
| macOS | CoreML (Apple Silicon GPU / Neural Engine), falling back to CPU. **Intel Macs are not supported**: ONNX Runtime ships no x64 macOS build. The app says so and plays normally. |
| Device choice | *Auto* tries the GPU with a real validation run and uses it only if it works. A GPU that fails is remembered, and *Measure speed* retries it. *CPU* / *GPU* force a device. |

### Is it real-time?

It depends on the machine, so the app measures speed rather than assuming it. Settings shows `N× real time` and a verdict.

Measured on the development PC (Windows 11, Intel CPU with integrated GPU, 8 inference threads):

| | |
|---|---|
| DirectML on the Intel iGPU | fails ("GPU device instance has been suspended"); automatic CPU fallback |
| CPU speed | ~0.42 s of compute per second of audio (≈ 2.4× real time, *Balanced*) |
| Model load + validation | ~15 s on first use per session |
| First stems at the playhead after loading a track | ~15.6 s (includes model load) |
| Stems at a new position after a seek while playing | ~6–7 s |
| Whole 45 s track | ~25 s after the model is loaded |
| Reloading a cached track | 0.3 s |
| Deck speed during separation | 1.00× (no effect on playback) |

A discrete NVIDIA/AMD GPU or Apple Silicon should be several times faster. On slow machines, **Pre-analyse** tracks from the library before a set; cached stems load instantly.

## Modes (Settings → STEMS)

| Mode | Behaviour |
|---|---|
| Off | No separation; STEMS controls are disabled. |
| Automatic (default) | Every loaded local/Audius track starts separating from the playhead immediately. |
| Pre-analyse | Nothing runs automatically. Separation starts when you switch STEMS on for a deck, or from the library (right-click → *Analyse STEMS*). Cached tracks are always used. |
| Real-time | Selectable only when the measured speed is at least 2× real time; behaves like Automatic. |

Quality sets the segment overlap: Performance 10%, Balanced 25%, High 50% (≈ 1.5× slower, smoother segment joins).

## Cache

- Location: `<userData>/stems` by default. It can be changed in Settings, along with a maximum size (default 20 GB). The oldest entries are removed automatically once the cache is over the limit.
- Key: SHA-256 of the file's audio bytes, excluding ID3v1/ID3v2 tags. Renaming, moving or re-tagging a file keeps its cache.
- Format per track: `meta.json` (regions done, quality), `stems.pcm` (Int16 interleaved vocals/drums/bass, 44.1 kHz), `env.f32` (waveform envelopes).
- Partial analyses are kept and resumed.
- Library: a **STEMS** badge marks cached tracks (**STEMS…** means partial). Right-click → *Analyse STEMS* / *Remove STEM Cache*.
- Original audio files are never modified.

**Licensing:** only local files are cached. **Audius** tracks are separated in memory only and never written to disk. Spotify and Apple Music audio is never available to the app, so it can't be separated.

## Controls

| | Toggle (mute/unmute) | Solo (isolate) | Volume |
|---|---|---|---|
| Actions | `deckN.stem.{vocals,drums,bass,instruments}.toggle` | `….isolate` | `….volume` (0–1) |
| STEMS on/off | `deckN.stems` | | |
| Keyboard deck A | Q W E R | Shift + Q W E R | |
| Keyboard deck B | U I O P | Shift + U I O P | |
| DDJ-SB | Pads in **SAMPLER** mode: pad 1–4 | SHIFT + pad 1–4 | |
| Mouse | click the stem button | Shift+click or right-click | slider (double-click resets) |

Pressing a stem control switches STEMS on for that deck. Solo on the stem that is already solo'd brings all stems back. A new track resets the mutes but keeps STEMS on and the volumes. Pad LEDs (`deckN.stem.X` feedback) light when that stem is audible.

The waveform toggle (**STD / STEM**, bottom-left of each scrolling waveform) switches between frequency colours and four stem lanes (vocals pink, drums yellow, bass blue, instruments green). Muted stems are dimmed. Lanes fill in as regions are separated.

## Testing

- `tests/separator.test.ts`: segment/region planning and overlap-add reconstruction.
- `tests/djEngine.test.ts` (STEMS): mute, solo toggle-back, volume, reset on load, support gating, FX stem target.
- `tests/mapping.test.ts`: DDJ-SB SAMPLER pads → stem toggle / SHIFT solo.
- End-to-end smoke test with the real model. It checks: normal playback while separating; stems reaching the playhead; pad mutes and solos changing the measured output; per-stem FX; seek re-prioritisation; cache on reload; library pre-analysis while a deck plays.

  ```
  DBDJ_SMOKE_TEST=1 DBDJ_STEMS_MODEL_PATH=/path/htdemucs_fp16weights.onnx DBDJ_SMOKE_STEMS=/path/track.wav node scripts/run-electron.mjs
  ```

## Limitations and next steps

- The per-stem FX UI is one target per FX unit. Routing multiple stems to one unit is supported by the engine (`stemMask`) but not yet exposed.
- A 4-stem model can't reliably separate lead vocals from backing vocals, or single instruments.
- Intel Macs: no ONNX Runtime build. A WebGPU/ONNX-Web path in the renderer would be possible, but slower.

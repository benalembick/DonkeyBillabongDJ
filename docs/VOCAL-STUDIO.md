# Vocal Studio — architecture and build phases

Vocal Studio lets someone record vocals in Production Studio and then use pitch, timing, tone, dynamics, harmony and effects processing to turn the performance into a polished vocal:

**Record → Analyse → Correct Pitch → Correct Timing → Enhance Tone → Add Harmony/Double → Mix → Send to Arrangement**

Ground rules for every phase:

- **The original recording is never modified.** Every take is kept as the dry capture. Processing is described by data and rendered when needed. Only an explicit **Bounce/Render** creates new audio, and that is a *new* take or track.
- **No fake controls.** A control appears only when the DSP behind it exists. If something needs DSP the browser can't provide well, use the architecture in §4 instead of simulating it.
- Natural results, low-latency monitoring and non-destructive editing come before control count.

Status: **Phase 1 (Vocal Recording) and Phase 2 (Pitch Correction) are built and tested.** Phases 3–7 below are the plan.

---

## 1. What exists and is reused

| Existing piece | Where | Used for |
|---|---|---|
| Web Audio engine, single `AudioContext`, master and headphone (cue) buses | `src/audio/WebAudioEngine.ts` | All vocal audio. `createMonitorOutput()` (new) sends to the **headphone mix** when 4-channel routing exists (e.g. DDJ-SB phones on outputs 3/4), otherwise to the main output with a UI warning. |
| AudioWorklet pattern (`?worker&url`, `addModule`, no allocation in `process`) | `src/audio/deck-processor.ts` | `src/audio/capture-processor.ts` (new). Future pitch/formant/dynamics worklets follow the same rules. |
| Production arrangement, scheduler, metronome, undo/autosave, per-track meters | `src/production/ProductionStudio.ts` | Backing playback while recording. Vocal tracks are normal audio tracks. `play(options)` (new) adds metronome, backing on/off, mute the record track and no-loop; `getPlayClock()` (new) gives the audio-clock origin used for sample-accurate take placement. |
| Recording store (IndexedDB) | `src/production/recordings.ts` | Dry takes (`production-vocal://…`, mono 16-bit WAV). |
| WAV encoder | `src/production/wav.ts` | Mono support added for takes. |
| Pitch detection (YIN) | `src/production/pitch.ts` | Phase 2 note/pitch analysis; Phase 4 pitch-stability scoring. |
| Transient/onset detection, zero crossings, Auto Clean | `src/production/slicing.ts` | Phase 2 note segmentation; Phase 6 *Create Vocal Chop*. |
| Sampler (pads, chromatic mode, root detection) | `ProductionStudio` sampler API | Phase 6 *Send to Sampler* (`saveClipAsSample`, `setChromaticFromSample`). |
| Microphone permission (desktop) | `window.dbdjDesktop.requestMicrophone` | Used by `VocalStudio.openInput()`. |
| Stem separation | `src/stems/StemService.ts` | Phase 4/5 guide vocal from a song (vocals stem). |

## 2. Phase 1 — what was built

```
src/audio/capture-processor.ts       AudioWorklet: raw PCM blocks + audio-clock frame index
src/production/vocal/VocalStudio.ts  session service: input, meters, monitoring, latency, record/punch flow
src/production/vocal/analysis.ts     pure maths: placeTake, analyseTake, measureClickLatency, blockPeaks
src/production/types.ts              VocalTake, VocalTakeAnalysis, VocalTrackData, ProductionTrack.vocal, AudioClip.takeId
src/production/ProductionStudio.ts   play(options), getPlayClock(), addVocalTrack/addVocalTake/setActiveTake/renameTake
src/audio/WebAudioEngine.ts          createMonitorOutput()
src/ui/VocalStudioWorkspace.tsx      the VOCAL tab
tests/vocal-studio.test.ts           placement, analysis, latency, storage
```

### Input graph (engine `AudioContext`)

```
getUserMedia (EC/NS/AGC off) → source ─┬→ rawMeter                (true input clipping, before trim)
                                       └→ trim ─┬→ meter          (post-trim peak/RMS, sticky clip)
                                                ├→ capture worklet → mute(0) → monitor out   (pulled by the graph)
                                                └→ monitorGain → monitor out  (headphone mix if available)
                                                     ▲ Phase 2 inserts: pitch-correct worklet → vocal FX here
```

### Take placement (sample-accurate)

The capture worklet tags every block with `currentFrame`, so each sample has an audio-clock time. When the arrangement starts, `getPlayClock()` records that arrangement `position` sounds at context time `contextTime`. A singer sings in time with what they *hear*, and that reaches the input one round-trip latency `L` later. So:

```
arrangement position of captured sample i = clock.position + (captureStart + i/rate − clock.contextTime) − L
```

`placeTake()` turns that into `{ start, offset, duration }`. The WAV holds the **whole** capture, including count-in and pre-roll. The take clip skips `offset` seconds, so compensation is reversible and the original stays complete.

**Latency `L`:** *Auto* uses the measured value if there is one, else the estimate (`baseLatency + outputLatency + track.getSettings().latency`); *Manual* uses a fixed value.
- **MEASURE LATENCY** plays six clicks through the main output and finds their onsets in the capture (`measureClickLatency`). Only onsets that agree within ±3 ms count, and at least 3 must, so singing or noise during the test can't produce a false value.
- The measurement needs an acoustic path or a loopback cable. Without one it says so instead of guessing.

### Recording flow

- **Count-in:** one bar of pre-roll. The arrangement starts a bar early, or if the record point is in bar 1, clicks play first and the transport starts on time.
- **Metronome and backing:** BACKING is an explicit choice, **Off by default**: *Off* (only count-in/metronome), *Full arrangement* (every other track), or *one track* (`PlayOptions.only`). The chosen clips are shown in a BACKING lane, so nothing plays unseen. The record track is always muted, and the loop region is ignored while recording. ▶ on a take plays that take plus the chosen backing only.
- **Punch:** pre-roll plays, only the in–out range is kept, and recording auto-stops at punch out. The previous take keeps its parts before and after the punch, joined with 10 ms crossfades.
- **Takes:** every take is kept (`track.vocal.takes`). ★ chooses the take the track plays. Discard is only available *during* recording. There is no take deletion, by design (Phase 4 comping relies on it).
- **Analysis (Phase 1 subset):** peak, RMS, clipped samples, noise floor (10th-percentile 50 ms window) and voice-activity ratio. Pitch, timing, sibilance, breath and key analysis come in the phases that use them; they are not shown as placeholders.
- **Persistence:** take metadata lives in the project JSON (autosave and `.dbdjproject`); audio lives in IndexedDB. Limitation inherited from recordings: `.dbdjproject` files don't embed take audio yet (see Phase 6, *Collect Project Files*).

### Monitoring (Phase 1)

- Dry monitoring through Web Audio.
- Route: the headphone mix when the engine has 4-channel routing; otherwise the main output, which needs an explicit "I'm wearing headphones" confirmation.
- Measured browser monitoring latency is typically 20–60 ms (Windows shared mode, default buffers). That's usable for checking but not ideal for singing to; see §3.

---

## 3. Browser and DSP constraints (explicit)

| Constraint | Consequence / decision |
|---|---|
| Web Audio runs at the `AudioContext` rate with a fixed 128-frame render quantum. Input → output adds `baseLatency + outputLatency + input latency` (often 20–60 ms on Windows shared mode, more with Bluetooth). | **Tuned live monitoring in the browser cannot reach hardware-monitoring latency.** Show the measured value and keep the dry path minimal. For < 10 ms monitoring, plan a **native audio companion** (WASAPI exclusive / ASIO / CoreAudio) behind the same `AudioEngine` interface (already the fallback plan for DJ latency). Never route the live mic to speakers without a warning. |
| `getUserMedia` processing (echo cancellation, noise suppression, AGC) colours vocals. | Always disabled (done). Device selection by `deviceId`; labels only after permission. Sample rate follows the shared context, so takes are written at the context rate. |
| `MediaRecorder` re-encodes and has no sample timing. | Not used for vocals. Raw PCM via AudioWorklet (done). |
| AudioWorklet: no allocation or GC in `process()`, no `SharedArrayBuffer` without cross-origin isolation (Electron can enable COOP/COEP; the browser build may not). | Real-time DSP worklets must preallocate. Large data (pitch maps, render caches) is passed by transfer, or by `SharedArrayBuffer` only in Electron. Capture allocates once per 2048-frame block, never per quantum. |
| JS DSP performance. | TD-PSOLA is O(n) overlap-add, and YIN on a 16 kHz copy every 5 ms is cheap enough, so Phase 2 runs in **plain TypeScript**: offline in a Web Worker / chunked async, live in an allocation-free AudioWorklet (measured: renders far faster than real time; the tune worklet is a few % of one core). **WASM is reserved for heavier Phase 5 DSP** (spectral-envelope formant shifting, phase-vocoder harmonies) where JS throughput becomes the limit. |
| High-quality pitch/formant shifting (PSOLA / phase vocoder / WORLD-style vocoder) is hard to fake. | Phase 2 implements **TD-PSOLA** (monophonic voice, low latency, formants preserved naturally), driven by a pitch map. A phase vocoder with spectral-envelope formant correction is the fallback for harmonies (Phase 5). No shortcut such as `playbackRate` resampling is labelled "pitch correction". |
| Time stretching (Phase 4 timing correction). | WSOLA exists in the deck worklet (key lock) and can be reused offline for phrase stretching. Elastic warping uses a time map rendered by the same engine. |
| ML voice models (Phase 7). | ONNX Runtime is already a dependency for stems (`onnxruntime-node`, desktop). Voice transformation runs **only in the desktop build** through a provider interface; the browser build shows it as unavailable. |
| Storage. | Takes in IndexedDB (per machine). Project portability needs *Collect Project Files* (bundle takes as WAV next to the project), planned in Phase 6. |

---

## 4. Processing architecture (for Phases 2–7)

### Non-destructive chain

Each vocal track gets a **`VocalChain`** stored in the project (versioned data, never audio):

```ts
interface VocalChain {
  version: 1;
  bypass: boolean;                 // ORIGINAL | ENHANCED A/B
  processors: VocalProcessor[];    // ordered; each has { id, type, enabled, params }
  pitchMap?: PitchEdit[];          // Phase 2: per-note target pitch / correction / bypass
  timeMap?: TimeWarp[];            // Phase 4: anchor pairs (source time → arrangement time)
  comp?: CompSegment[];            // Phase 4: [start,end) → takeId, crossfade
  layers?: LayerSpec[];            // Phase 5: doubles / harmonies (rendered to their own tracks)
  amount: number;                  // Auto Enhance macro 0–1 (scales processor params)
}
```

- **Rendering.** `renderVocal(track) → AudioBuffer` runs the chain offline in an `OfflineAudioContext` using the same worklets, so live and rendered results match. Results are cached by a hash of (take refs, chain JSON); arrangement playback uses the cache.
- **Bounce/Render** writes the cached render as a *new* take, keeping provenance in `take.derivedFrom`.
- **Live preview** while editing runs the chain in the live context on the active take (and on the monitor path, for processors marked `realtime`).
- **A/B.** ORIGINAL plays the comp or take without the chain; ENHANCED plays the render. Loudness is matched by an integrated-loudness estimate (ITU-R BS.1770 K-weighting) of both, applying the difference as gain on the ORIGINAL path only. Every processor has its own bypass.
- **Simple vs Advanced** are two views of the same `VocalChain`. Simple macros (PITCH, TIMING, TONE, HARMONY, WIDTH, SPACE, AUTO ENHANCE) map onto processor parameters through documented curves; Advanced edits the parameters directly.

### Planned modules

```
src/production/vocal/
  VocalStudio.ts          (Phase 1) session: input, monitoring, recording
  analysis.ts             (Phase 1) placement, levels, latency
  pitchTrack.ts           (P2) worker: YIN/pYIN frame f0 + voicing → notes (onset/offset, median pitch, drift, vibrato)
  scales.ts               (P2) key/scale model, Detect Song Key (chroma of backing + vocal), Use Project Key
  pitchCorrect.ts         (P2) target pitch curve from notes + retune speed / strength / humanize / transitions
  chain.ts                (P2→) VocalChain model, render cache, A/B loudness match
  cleanup.ts, enhance.ts  (P3, built) gate/expander, de-esser, EQ, gain rider, compressor, multiband, breath control, limiter; Auto Enhance
  timing.ts               (P4) onset/phrase detection, grid / backing / guide alignment, WSOLA time map
  comp.ts                 (P4) per-phrase take scoring + Smart Comp + crossfades
  layers.ts               (P5) doubler, harmony voices (scale/chord aware), formant, vibrato
  space.ts                (P5) plate/hall/room (convolution IRs, generated), delays, chorus, saturation
  voiceTransform/         (P7) provider interface, consent/provenance, desktop-only inference
src/audio/
  capture-processor.ts    (P1)
  tune-processor.ts       (P2) live tuned monitoring: realtime YIN + scale snap + TD-PSOLA (TypeScript AudioWorklet)
  dynamics-processor.ts   (P3) sample-accurate detectors (de-esser sidechain, gain rider)
src/ui/VocalStudioWorkspace.tsx  → tabs: RECORD | PITCH | ENHANCE (built) | TIMING | PRODUCE | MIX (+ SIMPLE/ADVANCED)
```

### Monitoring with processing (Phase 2+)

```
trim → [psola worklet (pitch map = live scale snap)] → [EQ → comp → reverb/delay sends] → monitorGain → monitor out
     → capture worklet (always the dry signal)
```

The tuned monitor uses a short analysis window (≤ 20 ms) and accepts slightly lower quality than the offline render. The displayed monitoring latency includes the worklet's lookahead.

### Voice Transform (Phase 7) — provider interface

```ts
interface VoiceModelProvider {
  id: string; name: string;
  listModels(): Promise<VoiceModel[]>;            // each model carries license + consent metadata
  transform(input: VoiceTransformInput, model: VoiceModel, onProgress): Promise<AudioBuffer>;
}
interface VoiceModel {
  id: string; name: string;
  kind: "generic-synthetic" | "licensed" | "user-owned" | "consented";
  license: { holder: string; terms: string; url?: string };
  consent?: { subject: string; grantedAt: string; evidenceRef: string };   // required for "consented" / "user-owned"
}
```

- Inputs are the dry take plus the pitch map, time map and expression (loudness and vibrato curves), so melody, lyrics, timing and expression come from the singer.
- No provider or model may be described as, or matched to, a real artist. Models without license or consent metadata are rejected.
- Generated audio is a new take with `provenance: { provider, modelId, modelKind, sourceTakeId, createdAt }`, shown in the UI and exported as WAV metadata (`LIST/INFO ICMT`). The source take is never replaced.
- Inference runs on desktop only (ONNX Runtime, CPU/GPU), and only after the core Vocal Studio phases ship.

---

## 5. Build phases (each one buildable and testable on its own)

Each phase: inspect current code → implement → unit tests for the pure maths → Electron end-to-end check with the fake-device microphone (`--use-file-for-fake-audio-capture`) → stop for review.

### Phase 1 — Vocal Recording ✅
Input selection, trim, meters, clip warnings, dry monitoring with headphone routing and feedback warning, latency estimate, measurement and compensation, count-in, metronome, backing playback, punch-in, multiple takes with waveforms, level analysis, persistence.
*Accepted:* 13 unit tests plus 25 end-to-end checks (`tests/vocal-studio.test.ts`; harness notes in §6).

### Phase 2 — Pitch Detection & Correction ✅
**Built:**

```
src/production/vocal/scales.ts        keys/scales (Major, Minor, Harmonic Minor, Chromatic, Pentatonic, Minor Pentatonic,
                                      Blues, Dorian, Mixolydian, Custom), nearest scale note, FFT, chroma from notes/audio,
                                      Krumhansl–Kessler key detection, key fit
src/production/vocal/pitchTrack.ts    YIN f0 every 5 ms on a 16 kHz copy (voicing, octave-error cleanup), note segmentation
                                      (unvoiced gaps; pitch change judged on a 100 ms median so vibrato is never split),
                                      per-note median pitch, drift (¢/s) and vibrato (rate, depth)
src/production/vocal/pitchCorrect.ts  correction curve: corrected = target + (1 − drift)·trend + preserve·expression,
                                      × strength (humanize fades short notes), note transitions, retune-speed one-pole;
                                      bypassed notes return to zero correction; presets Natural / Studio / Strong / Hard Tune
src/production/vocal/psola.ts         offline TD-PSOLA: period-integrated analysis marks, Hann grains (2 periods),
                                      fractional synthesis spacing, interpolated pitch/correction, window-sum normalisation;
                                      formant preserve on = original grains, off = grains resampled by the ratio
src/production/vocal/pitch.worker.ts  pitch tracking off the UI thread (inline fallback when Workers are unavailable)
src/production/vocal/VocalPitch.ts    service: analysis after each recording, f0 cache (memory + IndexedDB `<take>#pitch`),
                                      settings/notes edits (undoable), renders (`production-vocal-render://take@hash`,
                                      snapshot per ref, loudness-matched), Detect Song Key, project key
src/audio/tune-processor.ts           live tuned monitoring worklet (realtime YIN on 16 kHz, scale snap, retune smoothing,
                                      TD-PSOLA, 1024-frame delay ≈ 21 ms at 48 kHz, reported to the UI)
src/ui/VocalPitchEditor.tsx           PITCH tab
```

- **Data.** `VocalTrackData.pitch` (PitchSettings), `VocalTake.pitch` (notes: `{ id, start, end, detected, target | null (auto), bypass, transitionMs | null, driftCents, vibrato }`, the take's own key), `ProductionProject.key`. All are project data, so edits are undoable, autosaved and in `.dbdjproject`.
- **Non-destructive playback.** With correction on, a take's clips play `production-vocal-render://<takeId>@<hash(settings, notes)>`, served through `ProductionStudio.registerBufferProvider`. The hash names exactly the data rendered: a snapshot is stored when the ref is made, so later edits can never leak into a cached render. **ORIGINAL** plays the untouched take (bit-identical). TUNED is loudness-matched (active RMS).
- **UI (PITCH tab).**
  - ORIGINAL | TUNED A/B, play the take with backing, choose the take.
  - Key and scale, with the 12 custom pitch-class toggles. DETECT SONG KEY combines analysed vocal notes, MIDI parts (not drums) and audio backing chroma. USE / SET AS PROJECT KEY. "% in key".
  - The four presets. RETUNE SPEED (Natural ↔ Hard Tune), STRENGTH, HUMANIZE, TRANSITION, DRIFT CORRECT, PRESERVE EXPRESSION, FORMANT PRESERVE. AUTO CORRECT ALL. TUNED MONITOR (also in the RECORD tab).
  - The editor shows scale rows, the sung pitch curve (grey) and the pitch you'll hear (yellow). Each note is a blob: a dashed outline at the detected pitch and a solid bar at the target, labelled with its cents deviation and ∿ for vibrato.
  - Drag a note to a scale note (Alt = free, to the cent); double-click to split; shift-click or drag across empty space to select. On a selection: SNAP TO SCALE, ±10¢, BYPASS, RESET, JOIN, per-note TRANSITION, CORRECT SECTION.
- **Live tuned monitoring.** Monitor path is trim → tune worklet → monitor gain. The capture worklet stays on the dry signal, so recordings are never tuned.

**Accepted** (unit tests `tests/vocal-pitch.test.ts` plus 19 end-to-end checks on a recorded, out-of-tune fake singer):
- detection within ±8¢ (vibrato notes ±12¢)
- 7 detuned notes (±20–40¢) land within **0.0–1.4¢** with Hard Tune
- Natural keeps vibrato (35¢ vs 34¢ original)
- Hard Tune reaches target in < 20 ms; a 200 ms retune is visibly slower
- strength 50% moves halfway; bypass, manual targets, split, join and undo all work
- formant-off still lands on pitch
- level within 10%, length identical, ORIGINAL bit-identical
- the live worklet turns a note sung 40¢ flat into −0.1¢ (+21 ms)
- the reopened project renders identically (same ref, max sample difference < 1e-6)

**Limitations:**
- Monophonic voice only (TD-PSOLA). Breathy or very noisy sections fall back to unvoiced pass-through.
- Formant *shifting* (as opposed to preserving) is Phase 5.
- The live monitor's ~21 ms adds to the browser's output latency (see §3).
- Render cost grows with take length (computed on demand and cached; a few hundred ms for a typical verse).

### Phase 3 — Vocal Cleanup & Auto Enhance ✅
**Built:**

```
src/production/vocal/cleanup.ts   offline DSP (pure, Vitest-tested), gain traces in dB per 10 ms:
                                  gate/expander (10 ms RMS detector, 5 ms look-ahead, dB-domain hold/release, range, ratio)
                                  de-esser (zero-phase split band above 4–10 kHz, brick-wall to threshold, only while the band dominates)
                                  EQ (2nd-order ×2 high-pass, warmth shelf, mud, presence, air shelf, ≤ 3 narrow resonance cuts)
                                  AUTO LEVEL rider (voiced-only, zero-phase look-ahead, Natural ±6 / Balanced ±9 / Aggressive ±12 dB)
                                  compressor (RMS, soft knee), 3-band multiband (zero-phase crossovers, recombine exactly),
                                  breath detection + control (Keep / Reduce −9 / Strong −20 dB: gain only, never deletion),
                                  look-ahead limiter; runChain (order + meters), scaleChain (AMOUNT), analyseVocal
src/production/vocal/enhance.ts   AUTO ENHANCE: analysis → chain + pitch preset + a plain-language report line per decision;
                                  presets Natural, Clean Studio, Pop, EDM, Rock, Warm, Hard Tune
src/production/vocal/VocalPitch.ts  the same render service now runs pitch correction then the cleanup chain; per-ref
                                  readouts (gain traces, breaths, level swing); updateChain / setListen / autoEnhance
src/ui/VocalEnhancePanel.tsx      ENHANCE tab
```

- **Processing order.** gate → de-esser → EQ → auto level → compressor → multiband → breath → limiter. Breaths are *found* right after the gate, on the clean signal, but *lowered* after the dynamics. Otherwise the compressor's makeup gain would bring them straight back up: "Reduce −9 dB" really is −9 dB in the finished vocal.
- **Data.** `VocalTrackData.chain = { amount, preset, processors, report }` and `VocalTrackData.listen = "original" | "processed"`. These are project data: undoable, autosaved, in `.dbdjproject`. AMOUNT drags and A/B switches are not undo steps; everything else is one step each.
- **Non-destructive.** The take is never modified. With pitch correction and/or any processor on, the clip plays `production-vocal-render://<take>@<hash(pitch settings + notes, amount + processors)>`. The snapshot rule from Phase 2 applies.
  - The render is loudness-matched to the original (active RMS, gain ≤ 4×), then held under the limiter ceiling.
  - **ORIGINAL** plays the untouched take (bit-identical). It is one master A/B, shared by the PITCH and ENHANCE tabs; PITCH keeps its own PITCH CORRECTION on/off.
- **AUTO ENHANCE VOCAL** measures the take's singing level, noise floor, level swing (10–90 % of voiced level), sibilance (bright unvoiced moments vs the singing), band energies, resonances and breaths. It then decides:
  - **Gate:** on only with audible noise. The threshold is the noise floor + 8 dB, and the ratio is steep enough that the noise floor gets the preset's full range.
  - **De-esser:** on only with measured sibilance. The threshold sits *n* dB under the "s" peaks, where *n* grows with how harsh they are.
  - **EQ:**
    - high-pass from the lowest sung note;
    - a mud cut only when 200–500 Hz sits > 6 dB above 500–1000 Hz;
    - presence and air from the measured deficit plus the preset;
    - resonance cuts only for narrow peaks that stay at the same frequency in ≥ 2/3 of the separate phrases, so the sung harmonics, which move with the note, are never notched.
  - **Auto Level:** the mode steps up with a larger swing.
  - **Compressor / multiband:** from the preset and the singing level.
  - **Limiter:** −1 dBFS.
  - **Pitch:** the preset's correction (when notes exist).

  Every decision is listed under **WHAT WAS APPLIED**, starting with the measurements. **AMOUNT** 0–100 % scales every processor: ranges, cuts, boosts, ratios and makeup. Below 15 % breaths are kept; at 0 % the chain is off.
- **UI (ENHANCE tab).**
  - **SIMPLE:** ORIGINAL | ENHANCED, PLAY, AUTO ENHANCE VOCAL, AMOUNT, the 7 preset cards (APPLIED badge) and the report with the level swing before → after and the breaths found.
  - **ADVANCED:** the same chain, one card per processor in processing order. Each card has an on/bypass switch, every real parameter, and a live readout: GR max/avg and a gain graph over the take. Auto Level shows its ride both ways ("rides −x … +y dB").
  - Editing any parameter marks the chain *Custom*.

**Accepted:**
- **Unit tests** (`tests/vocal-cleanup.test.ts`, 14):
  - gate range; de-esser ≥ 6 dB on "s" with the voice band unchanged; EQ curves;
  - Auto Level halves a 12 dB swing without lifting gaps;
  - compressor −9 dB at 4:1, 12 dB over;
  - multiband recombines exactly; limiter ceiling;
  - breaths found and not confused with "s"; Breath Control's −9 dB survives a compressor with +6 dB makeup;
  - Auto Level never lifts an "s" or breath beside a quiet phrase;
  - harmonics are never taken for resonances while a fixed 1.8 kHz resonance is found;
  - Auto Enhance report; full chain; AMOUNT 0.
- **End to end** (25 checks; a recorded "untreated home take": room noise at −54 dB, a 12 dB loud/quiet swing, "s" bursts as loud as the voice, a breath):
  - Auto Enhance turns on exactly gate, breath, de-esser, EQ, level, compressor and limiter, and reports each.
  - The gate takes the gap noise 12 dB down vs bypassed (6 dB better relative to the singing overall).
  - "s" bursts drop 3.2 dB relative to the voice (de-esser GR −9 dB).
  - The level swing goes from 12.3 to 4.0 dB.
  - The breath is lowered 8.6 dB vs Breath Control bypassed.
  - Peak −1.00 dBFS; loudness within 0.1 dB; length identical; ORIGINAL bit-identical and not an undo step.
  - Each of the 8 processors bypasses on its own; bypass and undo work.
  - AMOUNT 50 % halves the gate and de-esser action, and 0 % switches the chain off.
  - EDM is measurably heavier than Clean Studio.
  - The UI path works: preset + AUTO ENHANCE, 8 ADVANCED cards with gain graphs, and a card switch bypassing a processor.
  - The reopened project renders identically (max sample difference 0).

**Limitations / not in this phase:**
- Mouth-click reduction (planned here originally) is deferred.
- **Wide** and **Dreamy** need width and space effects, so they arrive with Phase 5. So do saturation, reverb and delay.
- The chain is offline (render-on-change, cached); the live TUNED MONITOR still applies pitch only. A typical verse renders in well under a second; long takes take longer.
- Analysis heuristics are tuned on synthetic and fake-device takes. The real-microphone check (noisy room, a singer moving off-mic) is still to do.

### Phase 4 — Timing & Comping
- Phrase and onset detection, with alignment to the grid, backing transients or a **GUIDE VOCAL**: any track, or the vocals stem of a song.
- **AUTO ALIGN** with Natural ↔ Tight. It moves phrase anchors, not every syllable, and has max-shift limits.
- A WSOLA time map (reusing key-lock code offline), plus manual phrase move and stretch.
- **Comping:** take lanes (Phase 1 UI) with drag-select ranges per take and crossfades.
- **SMART COMP:** each phrase of each take is scored on pitch accuracy and stability (Phase 2 data), timing deviation, clipping, noise floor, completeness and SNR. The best per phrase is suggested, with every choice editable. Takes are never deleted.

### Phase 5 — Vocal Production
- **FORMANT and VOCAL CHARACTER:** formant shift ±4 semitones via spectral-envelope warping; Warmth, Body, Presence, Air and Brightness as tilt and shelving EQ macros with limits.
- **VIBRATO:** Preserve / Reduce / Smooth / Add, with rate, depth, delay and amount, all on the pitch map.
- **VOCAL DOUBLER:** Double, Triple and Wide, with timing and pitch micro-variation. Rendered layers are panned with the lead kept centred.
- **HARMONY:** up to four voices — Above, Below, Third, Fifth or Octave — scale- and chord-aware via the pitch map. Each voice has volume, pan, formant, humanize and timing controls. Presets: Backing Vocal, Pop Harmony, Choir, Wide Chorus, Octave Stack.
- **Space:** plate, hall and room (generated IRs, convolution); slap, stereo and ping-pong delay; chorus; saturation; the **VOCAL SPACE** Dry ↔ Huge macro; genre presets.

### Phase 6 — Integration
- **SEND TO SAMPLER**: a selection becomes a sample, then pad or chromatic, reusing `saveClipAsSample` and `setChromaticFromSample`.
- **Create Vocal Chop**: syllable and phrase boundaries become slices.
- **Send to Arrangement / Bounce Vocal**: render becomes a new take or track.
- **Export Vocal Stem**: WAV.
- **Duplicate; Create Harmony / Double Tracks**: layers become proper tracks.
- Mixer integration, automation of the macros, and controller mapping (record arm, punch, A/B).
- **Collect Project Files**: takes exported next to the `.dbdjproject`.

### Phase 7 — Advanced AI (desktop, later)
The provider interface in §4: licensed, user-owned, consented and generic models only; provenance on every generated take; never blocks the core phases.

---

## 6. Testing notes

- **Unit:** `tests/vocal-studio.test.ts` (placement, latency, analysis, mono WAV, persistence).
- **End to end:** Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`, loading a `file://` page so IndexedDB works.
  - The fake device has no acoustic path, so latency *measurement* is expected to report "no clicks heard". Measurement accuracy is covered by unit tests with synthetic delayed clicks.
  - Real-hardware checklist (manual): measure latency with speakers, record to the backing, and confirm the take lines up with the beat by ear and by transients (within ±3 ms after compensation).
- **Workers and worklets:** keep the maths in pure modules testable under Vitest; wrap them for worklet/worker use.
- **Phase 3 end to end:** a fake "untreated" take (room noise, 12 dB swing, loud "s", breath). Each processor's effect is measured as an A/B against its own bypass inside the full chain (what the user hears), plus an overall check against the original.
- **Phase 2 end to end:** fake singer WAV (A-minor phrase sung 20–40¢ out, with vibrato); an OfflineAudioContext with `processorOptions` verifies the tune worklet; renders are re-tracked with `trackPitch` to measure the result in cents.

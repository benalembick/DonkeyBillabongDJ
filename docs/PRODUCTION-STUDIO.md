# Production Studio architecture

Production Studio is a modular DAW subsystem that deliberately reuses the DonkeyBillabongDJ platform and audio layers.

## Phase 1 boundaries

- `ProductionStudio` owns the versioned project model, edit history, autosave/recovery data, transport scheduling, microphone recording and offline rendering.
- `WebAudioEngine.createProductionOutput()` supplies a production bus connected to the existing master path. Production playback therefore uses the selected DonkeyBillabongDJ audio device and master metering rather than creating a competing output engine.
- `Platform` remains the file boundary. Desktop projects reference durable local paths; browser projects can reference files only for the current browser session.
- Existing `LibraryStore` tracks and its drag payload are accepted directly by the arrangement. Existing decoding handles the application's supported formats and macOS transcode fallback.
- `.dbdjproject` is versioned JSON. It stores non-destructive clip edits and media references; a future Collect Project Files command will package referenced media.
- WAV export uses `OfflineAudioContext`, preserves arrangement alignment, and renders track/clip gain, pan, mute and solo state.

## Runtime limitations

- Native VST3 and Audio Unit binaries cannot be loaded safely by Chromium/Web Audio. Real plugin support requires a sandboxed native companion host with scanner, validation, crash isolation, IPC parameter automation, and shared-memory or low-latency audio transport. No plugin controls are faked in Phase 1.
- Web Audio does not expose trustworthy application CPU load. The toolbar labels CPU as unavailable instead of inventing a value.
- Browser file handles are not durable across sessions. The Electron desktop build can reopen path-backed media; browser users must re-authorise source files after reload.
- `MediaRecorder` chooses an input capture codec supported by the runtime. Recorded takes remain internal sources (bytes kept in the `dbdj-production-recordings` IndexedDB store, so they survive restarts on the same machine) and decode into the arrangement; collecting/transcoding them to portable WAV media belongs with Collect Project Files.
- Bluetooth output latency varies outside the application's control and is not sample accurate.

## Extension seams

The project format already separates tracks, clips, markers, tempo and mixer state. Later phases should add discriminated MIDI clips, automation lanes, instrument/effect device graphs, buses/returns, live clip slots and media manifests through format migrations rather than replacing the Phase 1 model. Computational analysis should continue through worker/native services so DSP and rendering do not block React.

## Phase 2

Project format version 2 adds beat-based MIDI clips, notes with velocity/duration/channel, instrument tracks, synth settings, drum patterns and swing. Version 1 projects migrate automatically.

- MIDI clips play through the same scheduled production bus and are included in offline WAV export.
- The subtractive synth provides four oscillator shapes, ADSR, low-pass cutoff/resonance, detune and output volume. Glide is stored for forward-compatible voice handling.
- The built-in drum kit provides kick, snare, closed/open hats, clap and percussion voices through a 16-step pattern editor.
- The piano roll supports drawing, selection, deletion, moving, resizing, duplication, velocity, octave transpose, quantisation, humanisation and scale highlighting.
- Web MIDI and the computer keyboard feed armed tracks. MIDI record captures note, velocity, duration and channel into an active or newly-created MIDI clip.

## Sampler in the arrangement and live

- Pad and saved samples appear under **SAMPLES** in the arrangement browser. Drag one onto an audio track, or press **＋** (or **＋ ADD TO ARRANGEMENT** in the Sampler) to place it at the playhead on a `Samples` track. `sampleToClip` turns the sample into an ordinary audio clip that keeps its region, gain, normalize, reverse (`AudioClip.reverse`, offset measured from the source end) and fades (`fadeIn`/`fadeOut`). Playback and WAV export both honour them.
- Pads are polyphonic: each pad has its own voice on a shared pad bus (`padVolume`), so pads layer over each other and over the DJ mix. One-shot retriggers, toggle and loop stop on the next press, gate plays while held.
- The DJ screen shows the 16 pads in the collapsible **SAMPLER** bar under the FX units. Pads dispatch `samplerN.play` (press 1 / release 0); `samplerN.stop`, `samplerN.load` (assign the Sampler editor sample), `samplerN.eject`, `sampler.stopall` and `sampler.volume` are also in the action catalogue for MIDI learn.

## Sampler Phase 2 — transients, slicing and pad banks

Workflow: **Audio → Analyse Transients → Slice → Map to Pads → Rearrange.**

- `slicing.ts` holds the pure analysis (unit-tested on synthetic loops, checked on the example sample pack): `detectTransients` (5 ms frames; dB rise of full-band and first-difference energy over the previous 15 ms, gated 40 dB under the loudest frame; peaks refined to the attack start and snapped back to a zero crossing), `transientMarkers` (sensitivity cut), `beatMarkers`, `equalMarkers`, `sliceRegions`, `nearestZeroCrossing` and `analyseClean`.
- `SamplerProjectState.slicing` stores the mode (transient / beat / equal / manual), sensitivity, beat length, equal count, BPM override, the detected transients of `sourceRef` and the editable `markers` (source seconds inside the editor start/end). Changing a mode or setting regenerates markers; manual edits stay until RESET. Marker drags are one undo step (`preview`/`endGesture`).
- Pads are 64: banks A–D × 16 (`padLabel`, `PADS_PER_BANK`). `SamplerPad.params` holds pan, pitch (semitones, by playback rate), ADSR, low-pass cutoff/resonance, mute, solo and choke group 0–4. Gain, start/end, reverse and playback mode stay on the pad's sample. Phase 1 projects (16 pads, no params/slicing) are upgraded by `normalizeSampler`; the project format version is unchanged.
- Pad voice chain: source → low-pass → level/fades → ADSR → pan → `out`. `out` gives every stop at least a 4 ms fade (or the pad's release). Choke stops the other pads in the group on trigger; muted pads and pads outside an active solo set are silent (PREVIEW ignores both).
- `mapSlicesToPads` starts at pad 1 of the current bank and continues through later banks (up to D16). With AUTO CLEAN SLICES each slice gets `analyseClean`: silence trimmed (-60 dBFS, 2 ms headroom, never outside its slice), zero-crossing edges and 2–3 ms anti-click fades. **✧ AUTO CLEAN** applies the same to the editor sample and reports peak, RMS and clipped samples. Level is never changed.
- `sampler1…16.*` actions address the current bank; `sampler.bank.a…d/next/prev` switch banks (live bar and MIDI learn).

Limitations: transient detection runs on the UI thread (about 1 ms per second of audio). Beat slicing treats the region start as the downbeat. Per-pad pitch, filter, envelope and pan are not carried into arrangement clips by `sampleToClip`.

## Sampler Phase 3 — MIDI, patterns and the piano roll

Workflow: **Slice → Pads → Perform → MIDI Pattern → Piano Roll → Arrangement.**

- **Notes.** Pads follow `sampler.baseNote` chromatically (default 36, shown as C2 because the app names middle C as C4 = 60). BASE NOTE re-maps every pad; `setPadNote` remaps one pad and swaps with any pad already on that note, so notes stay unique.
- **One input path.** Pads (mouse and touch), the computer keyboard (SLICES: `Z X C V / A S D F / Q W E R / 1 2 3 4`; CHROMATIC: a piano row from `A`, with `Z`/`X` for octave), MIDI devices without a DJ mapping (`createApp` monitor → `handleSamplerMidi`) and the live bar / `samplerN.play` actions all call `samplerNoteOn/Off`. Velocity scales the voice. DJ controllers that have a mapping are not routed to the Sampler.
- **Modes.** SLICES: a note plays the pad mapped to it. CHROMATIC: `chromatic.sample` plays at `rootNote` unchanged and is transposed by playback rate for other notes. Voices are polyphonic, one per note. `pitch.ts` (YIN over the sustained part) fills `detectedRoot` when a sample is chosen; ROOT overrides it.
- **Recording.** RECORD PATTERN has an optional one-bar count-in and click, both scheduled on the audio clock. Notes are captured in beats with their duration and velocity. A hit up to 1/16 note before the downbeat counts as on it. The pattern can be up to 8 bars and stores raw timing. `quantizeToGrid` (OFF, 1/4, 1/8, 1/16, 1/32, 1/8-triplet, strength 0–100%) is applied when the pattern is played, opened or sent, so you can change it after recording.
- **Arrangement.** `patternToArrangement` creates a normal MIDI clip on a Sampler track (`instrument.type = "sampler"`, `samplerMode` set from the pattern). OPEN IN PIANO ROLL also switches to it. The pattern can also be dragged from the browser's SAMPLER PATTERN item. In the piano roll a SLICES track shows one row per loaded pad (pad and sample name); CHROMATIC shows ±2 octaves around the root.
- **Playback and export.** `scheduleSamplerTracks` turns Sampler-track notes into sample voices, both live and in WAV export. One-shot pads play out; gate, toggle and loop pads and chromatic notes hold for the note length, then release. A pad cuts its own previous hit and its choke group, as when played live. MIDI, pad and chromatic edits re-schedule a playing arrangement (debounced 150 ms).

Limitations: root detection returns nothing for chords and unpitched sounds; set ROOT by hand for those. Chromatic transposition changes speed as well as pitch (no time-stretch). Pattern recording runs on its own clock and is not synchronised to arrangement playback.

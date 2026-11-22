# Drum Transcriber (Production Studio)

Audio → onsets → drum classes → editable MIDI drum lanes → `.mid`. A sub-workspace of Production Studio, next to
Arrangement, Sampler, Vocal and Looper. Phase 1 (isolated drums) is built; Phases 2–4 are planned below.

## Using it

1. **Production Studio → Drum Transcriber.**
2. Bring in audio. **⤓ IMPORT AUDIO…** opens a file. You can also drop a file or a library track onto the module, or
   pick a clip **From the Arrangement**. Separated **Drums stems** are listed first. Nothing is analysed yet.
3. **MODE**: *Isolated drums (loop / break / stem)*. *Full song* is Phase 2 and is disabled.
4. **✦ ANALYSE** runs in a background worker, with stage, progress and CANCEL.
5. Review the hits:
   - **⚑ NEXT TO REVIEW** walks through Unknown and flagged hits.
   - Change a lane in **SELECTION**, or drag a note up or down.
   - **✓ ACCEPT** clears a hit's review flag.
6. Edit the notes:
   - Double-click a lane to add a hit. Double-click a note, or press Delete, to remove it.
   - Drag notes to move them; they snap to the quantise grid, and Alt drags off-grid.
   - Drag a box, or Shift+click, to select several. Ctrl+C / Ctrl+V pastes at the playhead. Ctrl+A selects all.
   - Ctrl+Z / Ctrl+Shift+Z undo and redo.
   - Drag bars in the **VELOCITY** lane. **AUTO** returns a hit to the derived velocity.
7. Set the tempo and quantise:
   - **BPM**, **÷2 / ×2**, **OFFSET** (a downbeat in seconds), **⇥ DOWNBEAT HERE**, **RESET GRID**.
   - **QUANTISE** with **STRENGTH**. Quantise is non-destructive.
8. Preview:
   - **A · ORIGINAL / A+B / B · MIDI**; **A/B ⇄** flips while playing.
   - AUDIO and MIDI levels, LOOP, FOLLOW.
   - Space plays and pauses.
9. Map the notes: **DRUM MAP** sets a MIDI note per lane (General MIDI by default). Save and apply map presets.
10. Export:
    - **⤒ EXPORT MIDI**: format 1, tempo track plus one drum track on channel 10.
    - **PER LANE**: one track per lane.
    - **JSON**: the event list.
    - **→ ARRANGEMENT**: a new **Drums** track with one MIDI clip (see *Sending to the Arrangement*).
    - Transcriptions save automatically after analysis. **OPEN…** reopens them without re-analysing.

## Sending to the Arrangement

**→ ARRANGEMENT** (`toArrangement.ts`, `ProductionStudio.addMidiClip`) adds a new built-in **Drums** instrument track with one MIDI clip. The whole send is one undo step in the Arrangement.

- **Placement is by time.**
  - If the source is an Arrangement clip, for example a Drums stem, source time *t* lands at `clip.start + (t − clip.offset)`. Only hits inside that clip's region are used, so the MIDI plays under the audio it came from.
  - A file source starts at the arrangement playhead.
  - Quantised hits within 30 ms outside the region are kept at its edge.
- **Tempo choice:** when the BPMs differ, the dialog offers *Set arrangement to <transcription BPM>*, so bars line up, or *Keep <arrangement BPM>*. Either way, notes are converted to beats at the tempo the arrangement ends up with, so they play at the right seconds. Audio clips are positioned in seconds and don't move; other MIDI clips follow a tempo change.
- **Unmapped lanes:** hits on Unknown Perc, or any unmapped lane, are left out and counted.
- **Sound:** it plays on the Arrangement's built-in six-voice drum kit. Kick, snare and clap have their own voices; other notes play as filtered noise.
- **Editing in the Arrangement:**
  - A Drums clip of one bar on 16ths opens in the 16-step sequencer.
  - Longer or finer clips open in the piano roll, with rows named by General MIDI percussion name (Kick 36, Snare 38…).

## Pipeline

```
source ref ──ProductionStudio.sourceBytes()──► bytes ──contentTrackId()──► identity hash
     │                                           └──WebAudioEngine.decode()──► AudioBuffer (playback + waveform)
     ▼ (mono copy, transferred)
transcribe.worker.ts → transcribeDrums():
  toAnalysisRate   halve to ≤ 32 kHz (31-tap windowed-sinc low-pass) — e.g. 48 k → 24 k
  bandSpectrogram  Hann STFT, 1024 / hop 128 (≈5.3 ms at 24 kHz), 22 third-octave bands up to 10 kHz (mean |X| per bin)
  detectOnsets     SuperFlux-style log flux per region (<200 Hz, 200–5 k, >5 k) + whole-spectrum flux;
                   adaptive threshold (local mean of the previous 100 ms + sensitivity × 98th-percentile flux),
                   absolute floor per region, 25 ms minimum spacing; then refineOnset() in the time domain
                   (≈1 ms peak envelopes of x and Δx, largest jump, walk back to 10 % above the floor; steps back
                   to an earlier burst that truly rises from a floor — claps)
  classifier       DrumClassifier (default TemplateNmfClassifier, below)
  detectDrumTempo  ≥ 8 s: analyzeTrack's detectBeats() on the same 150 fps envelope the deck analyser uses;
                   shorter: Live Looper estimateTempo() when the clip is a whole loop (confidence ≥ .85), else a
                   kick/snare-weighted beat comb 70–180 BPM with an octave check; downbeat = phase putting the
                   most kick strength on bar lines (ties → the earliest kick)
```

Grid precedence when a transcription is created or re-analysed:
1. A grid the user set by hand in the transcriber (`manual`).
2. The library's grid for the same audio (looked up by hash or ref). A hand-edited library grid (`library-manual`) is
   kept even on re-analysis.
3. The detected tempo (`detected` / `loop`).
4. 120 BPM (`default`), shown in amber.

**RESET GRID** returns to 2, then 3.

### Baseline classifier (`template-nmf@1`)

- **NMF:** semi-adaptive KL-NMF with three prior templates: kick (40–180 Hz), snare (noise-dominant 0.8–8 kHz plus
  a 200 Hz body) and hi-hat (above 5.5 kHz). Templates may drift at most 15 % toward the recording, and only late in
  the 30 iterations. At each onset, every component's activation rise is measured independently, so one onset can
  produce several hits.
- **Absolute evidence gates:** these stop NMF cross-talk from inventing notes. They use the onset's power-rise
  profile in the observed spectrum (fractions below 120 Hz, 150–330 Hz body, 0.8–5 kHz noise and above 5.5 kHz air):
  - **kick** needs ≥ 8 % of the rise below 120 Hz;
  - **snare/clap** needs ≥ 1.2 % noise and must not have a lone-hat profile;
  - **hat** needs air that the snare doesn't explain.
- **Sub-labels:**
  - **open vs closed hat:** how long the hat activation takes to fall to 25 %, stopping at the next hat;
  - **crash:** decay longer than 0.7 s; always flagged for review;
  - **clap vs snare:** little body plus noise bursts in the first 45 ms. A clap is flagged "Clap or snare?" unless
    the evidence is strong. Under a kick the body can't be judged.
- **Confidence, Unknown and review:** labels below *Min confidence* move to **Unknown Perc** with their ranked
  guesses. An onset that no component explains also goes to Unknown. Weak hits in a multi-hit onset are flagged
  "Possible overlapping hit".
- **Velocity:** strength is the activation rise relative to that instrument's 90th-percentile rise, in a 36 dB
  range, from 0 to 1.

### Measured accuracy (`npm test` prints this report)

Tolerance ±30 ms. Synthetic voices and the example sample pack's real MP3 one-shots:

| Case | Missed | False + | Class | Timing (mean / max) |
|---|---|---|---|---|
| single kick / snare / closed hat / open hat / clap | 0 | 0 | 100 % | 0.5–0.6 / 0.6 ms |
| 4-on-the-floor, kick + snare backbeat | 0 | 0 | 100 % | ≤ 0.4 / 0.9 ms |
| kick + hat, kick + snare simultaneous | 0 | 0 | 100 % | 0.7 ms |
| humanised (±21 ms off-grid) kick/snare/hat | 0 | 0 | 100 % | 1.1 / 5.6 ms |
| grooves @ 90 / 124 / 160 BPM (synthetic) | 0 | 0 | 83–85 % ¹ | ≤ 1.8 / 5.6 ms |
| groove @ 120 from pack one-shots | 0 | 0 | 85 % ¹ | 0.6 / 5.7 ms |
| pack one-shots alone, pack kick+hat, kick+snare | 0 | 0 | 100 % | 0.5 ms |
| pack 120 BPM loop (no ground truth) | — | — | — | 8 onsets, all on the 1/16 grid; 120 BPM |

¹ Every miss is a hi-hat struck at the same instant as a snare (the known limitation below); kicks, snares and the
other hats score 100 %. Tests assert that nothing is mislabelled at those moments.

These are synthetic and sample-pack fixtures. Real acoustic kits, room sound, bleed and full mixes will be worse,
and that needs measuring on real material (see *Next steps*).

## Data model (`src/production/drums/types.ts`)

`DrumTranscription` (schema 1) is stored as a versioned JSON document with kind `drumtx`. It holds:
- **source:** `ref`, `name`, `hash` (SHA-256, the same id library preparation uses), `duration`, `sampleRate`,
  `channels`, `origin`;
- **grid:** `bpm`, `firstBeat` (a downbeat), `beatsPerBar`, `source`, `confidence`;
- **settings:** mode, detection sensitivity, minimum confidence, quantise grid and strength, velocity curve;
- **mapping:** lane → MIDI note, where `null` means not exported; plus `mappingPresetId`;
- **analysis:** engine, onset detector, `classifier@version`, analysis rate, elapsed time, every onset time, the
  settings used, and the detected tempo;
- **hits:** a list of `DrumHit`.

Each `DrumHit` holds:
- `lane`;
- `time`: unquantised seconds, changed only by manual moves;
- `onset`: the original detection, never edited; `null` when added by hand;
- `detected`: the classifier's label;
- `confidence`, `strength`, `candidates`;
- `velocity`: a manual override, else `null`;
- `review`, `group` (simultaneous hits) and `edited`.

Quantised positions, velocities and notes are all derived when read (`timing.ts: deriveNotes`). Changing or removing
quantise, velocity settings or the map never loses timing.

Map presets (`DrumMapPreset`) use document kind `drummap`. If the running Electron main process predates these kinds (a dev session whose main wasn't restarted), `withLocalFallback` saves to localStorage instead of failing. Lists merge both stores, newest copy wins, and any storage error shows in the module's banner.

**Persistence** reuses `DocStore`/`DocPersistence`: on desktop, the SQLite table `setstudio_docs` gets the new kinds
added to its whitelist in `electron/library/db.ts`; in the browser, it falls back to localStorage. The last open
transcription is remembered in `localStorage["dbdj.drumtx.last"]`. On reopen:
- the hits load immediately;
- the source loads only for the waveform and playback;
- a missing file shows **RELINK…**;
- a file whose hash differs is flagged, and relinking asks before using it.

Original audio is never written.

## Classifier interface

```ts
interface DrumClassifier {
  readonly id: string; readonly version: number; readonly description: string;
  classify(input: { spec: BandSpectrogram; mono: Float32Array; onsets: Onset[]; minConfidence: number;
                    sensitivity: number; checkpoint?(fraction: number): Promise<void> | void }): Promise<ClassifiedHit[]>;
}
```

`transcribeDrums(..., { classifier })` accepts any implementation. Each `ClassifiedHit` carries `onsetIndex`,
`time`, `lane`, `confidence`, `strength`, ranked `candidates` and `review`. Several hits may share an `onsetIndex`.
`AnalysisInfo.classifier` records `id@version`, so saved work shows which model produced it.

## MIDI conversion (`midiFile.ts`)

- **Origin:** tick 0 is the last bar line at or before both the earliest hit and the grid's downbeat
  (`gridOrigin`), so bars line up with the audio and nothing is negative.
- **Format:** PPQ 480. Track 0 holds the name, time signature (`beatsPerBar`/4) and tempo (µs per quarter =
  60 000 000 / BPM). Drum tracks use status `0x99`/`0x89`: channel 10, index 9.
- **Simultaneous hits** share a tick. At an equal tick, note-offs are written before note-ons. Notes are 1/16 long,
  cut short at the next hit of the same pitch.
- **Unmapped lanes** (Unknown, by default) are skipped, and the export says how many.
- **Verification:** files are re-read in tests with the independent [`midi-file`](https://www.npmjs.com/package/midi-file)
  parser (MIT, dev dependency).

## Performance

- Analysis runs in a module worker, so the UI never blocks. Cancel terminates the worker.
- Without workers (tests, old runtimes) it runs inline and yields at checkpoints.
- Cost is roughly linear in duration: a 2 s loop analysed in 81 ms in the Electron smoke run. A 60 s file is covered by a test, but its time has not been benchmarked.
- Memory is about 0.1 MB of spectrogram per second of audio. Input is capped at 20 minutes.
- The spectrogram reports progress every 2000 frames, the NMF every 5 iterations, and classification every 200
  onsets.
- In the UI, the playhead moves via `requestAnimationFrame` without React re-renders. Preview notes are scheduled
  200 ms ahead on the AudioContext clock: the same clock as the original audio, so A and B stay in sync. Derived
  notes are memoised per project revision.
- Hits are rendered as DOM nodes; about 2000 are comfortable. Very dense full-song transcriptions (Phase 2) may want
  canvas rendering of the grid.

## Dependencies, licensing and packaging

- **Runtime:** nothing added. The DSP is in-house TypeScript; Web Audio handles decoding and playback.
- **Dev:** `midi-file@1.2.4` (MIT), tests only.
- **Preview kit:** `src/assets/drumkit/*.mp3` are copies of the project's own example sample pack (see its README:
  original synthetic samples, free for DonkeyBillabongDJ use). Inlined as data URLs, about 100 KB. Toms, cymbals,
  perc and the Unknown click are synthesised.
- **Packaging:** there's no Python and no new native module, and the worker is bundled by Vite. The doc-kind change
  needs the rebuilt Electron main, which `npm run dev` / `build` already does.

## Known limitations (Phase 1)

- A hi-hat struck **at the same instant as a snare** is usually not detected: the snare's own noise masks it. Add it
  by hand, or copy and paste a hat pattern. Decay-based inference was tried and rejected: it failed on the sample
  pack.
- **Toms, ride and "other percussion"** are never auto-detected. Low toms can be labelled kick; cymbal swells are
  only tentatively labelled crash.
- **Flams and rolls** closer than 25 ms merge into one hit. Ghost notes much quieter than the main hits of their
  instrument may fall under the threshold. Raise *Sensitivity* to catch them.
- **Clap vs snare** relies on body and burst heuristics. Layered snare+clap samples are often called snare.
- **Velocity** is an estimate from the audio, normalised per instrument. It is not the drummer's real MIDI velocity.
- **Full mixes are refused** in Phase 1. Use **Arrangement → ✦ SEPARATE INTO TRACKS** and transcribe the Drums stem.
- **Tempo is constant**, with one grid per transcription. Live drummers who drift need Phase 3's variable grid.
- **Browser builds:** a picked file is only readable in that session. A reopened transcription keeps its notes and
  asks to relink.

## Roadmap

### Phase 2 — AI drum separation and transcription

1. **Full-song mode.** Reuse the existing HT-Demucs stem worker (`src/stems/`, ONNX Runtime, already
   downloaded/cached, GPU when available). Pipeline: song → `StemService` separation of drums only (or a cached
   stem) → `transcribeDrums` on the drums stem. Progress = separation (0–70 %) + transcription.
   - Add `StemService.renderDrums(ref, onProgress, signal)`: a thin wrapper over the existing progressive scheduler,
     writing to the stem cache.
   - Enable the `song` option in the mode select and `TranscribeOptions.mode`.
   - Do **not** substitute band-pass filtering.
2. **Model classifier.** Implement a `DrumClassifier` around a frame-wise ADT network (kick/snare/hat, plus toms
   and cymbals where trained), run with `onnxruntime-node` in the stem worker process. Keep the NMF baseline as
   fallback and for low-confidence arbitration. Candidates to evaluate. **Check model licences before shipping**:
   - [ADTOF](https://github.com/MZehren/ADTOF): strong on real music. The repo is **CC BY-NC-SA 4.0**, which is not
     acceptable for a distributed app without the authors' permission.
   - Vogl et al. multi-instrument models (madmom / [Omnizart](https://github.com/erdalgunes/omnizart)): verify the
     licences of the model files. Omnizart's drum model was trained on YouTube audio, which raises a rights question.
   - [Magenta OaF Drums](https://magenta.tensorflow.org/oaf-drums) (E-GMD): verify the checkpoint licence and
     whether it converts to ONNX.
   - [DrumScript](https://drumscript.github.io/DrumScript/) is a non-ML, librosa + Demucs pipeline, conceptually
     like our baseline. It's useful as a reference, not a dependency (Python).
   - Training our own on CC-licensed E-GMD/STAR data is the cleanest licensing route.
3. **Downloadable models.** Reuse the stem model's download, cache and status UI (`StemBridge.downloadModel`). Store
   the `classifier@version` (already persisted) and offer **Re-analyse with newer model** when it changes.
4. **Device choice.** Reuse `StemDevice` (CPU/GPU) from Stem settings.
5. **Acceptance:** measure on real material — acoustic kits, electronic kits and full mixes — with labelled
   excerpts (E-GMD/STAR test split, licence permitting). Report precision, recall and F1 per class at ±30 ms, plus
   timing error, alongside the existing synthetic report.

### Phase 3 — Advanced drum editing

- **Ghost notes:** a second, lower threshold per lane, with a `ghost` flag and a velocity cap.
- **Flams and rolls:** allow under 25 ms spacing per lane when the burst structure says so.
- **Swing:** detect swing from the hits' offsets against the 1/16 grid, quantise with swing, and add humanise.
- **Variable-tempo grids:** share them with the Beat grid editor's planned multi-anchor grids.
- **Patterns:** loop and repeated-pattern detection that consolidates repeated bars and suggests masked hats, for
  example a hat under the snare when every other 8th has one.
- **Review mode:** confidence-sorted queue and a "review all Unknown" flow.
- **Learning from corrections:** every reclassification already keeps `detected` versus `lane`. Feed them into
  per-user template adaptation for the NMF baseline.
- **Kit remapping presets:** GM, plus maps for common drum machines and plugins.

### Phase 4 — Production Studio integration

- **Arrangement:** *done:* **→ ARRANGEMENT** (see above). *Still to do:* send into an existing track, drag-out, and bar-aligned placement for file sources. The original note: "Send to Arrangement" creates a Drums instrument track (or Sampler track) and a `MidiClip`. Use
  `toMidiNotes()`: beats from the origin, channel 10, durations 1/16. Place the clip at `source clip start + origin`
  so it lines up with an arrangement audio clip. Drag-out uses the existing `PATTERN_MIME`.
- **Sampler:** map lanes to pads (`setPadNote`). Preview through the user's pads instead of the built-in kit.
- **Live Looper:** "Transcribe loop" on a loop track uses the loop's rendered layers and the looper's bar grid
  (exact BPM and downbeat).
- **AI Set Studio:** expose per-track drum density and pattern features (kick-on-beat ratio, hat subdivision) to
  `LibraryIntelligence` for transition preparation.
- **DJ decks:** transcribe a deck's track via its cached Drums stem, then practise or remix from the MIDI.

## Files

| File | Role |
|---|---|
| `src/production/drums/types.ts` | Model, GM map, settings, validation/migration |
| `src/production/drums/dsp.ts` | Rate conversion, FFT, band spectrogram, envelopes |
| `src/production/drums/onsets.ts` | Region flux, adaptive peak picking, attack refinement |
| `src/production/drums/classifier.ts` | `DrumClassifier` interface, NMF baseline, rise profile, sub-labels |
| `src/production/drums/tempo.ts` | Tempo/downbeat (reuses `detectBeats`, `estimateTempo`) |
| `src/production/drums/transcribe.ts` / `transcribe.worker.ts` | Pipeline, validation, cancellation; worker |
| `src/production/drums/timing.ts` | Origin, quantise (reuses `quantizeToGrid`), velocity, derived notes |
| `src/production/drums/midiFile.ts` | SMF writer, MIDI/JSON export |
| `src/production/drums/kit.ts` | Preview kit |
| `src/production/drums/DrumTranscriber.ts` | Service: state, history, analysis jobs, playback, persistence, export |
| `src/ui/DrumTranscriberWorkspace.tsx` | UI |
| `electron/drumsSmoke.ts` | `DBDJ_SMOKE_DRUMS=/file (+ DBDJ_SMOKE_DRUMS_SHOTS=/dir)` end-to-end UI smoke with screenshots |
| `tests/drum-transcriber*.test.ts`, `tests/drums-helpers.ts` | Accuracy report, model/MIDI/service tests |

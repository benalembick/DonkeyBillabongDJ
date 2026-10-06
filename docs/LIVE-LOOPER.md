# Live Looper — scope, architecture and phases

Production Studio → **⟲ LOOPER**. One performer builds a song from silence:

**Make Sound → Record Loop → Process → Layer → Overdub → Add Samples → Arrange Live → Perform → Capture Song**

Status: **Phases 1–2 (Core Live Looper, Overdub & Timing) are built.** Phase 2's audio-graph behaviour (overdub layering, UNDO/REDO, LOOP QUANTIZE, master-loop tempo detection) still needs a real-mic Electron pass before it's "tested" like Phase 1 — see §2. Everything from Phase 3 on is future work, listed so these phases don't block it, but none of it is shown as a control yet (no fake controls).

---

## 1. Phase 1 — exactly what is in it

| Area | Built in Phase 1 |
|---|---|
| Workspace | LOOPER tab in Production Studio, with large performance controls. |
| Transport | Looper transport on the audio clock at the **project BPM and time signature**. Bar.beat display. Starts on the first REC or PLAY, stops on STOP ALL. Tempo locks while loops exist. |
| Input | Vocal Studio's input chain, shared rather than duplicated: device, channel, trim, meter, clip warning, dry monitoring (headphone output when 4-channel routing exists), latency compensation. One owner at a time. Vocal Studio refuses to record while the Looper holds the input, and vice versa. |
| Tracks | Six defaults (Percussion, Bass, Chords, Melody, Vocal, Samples) plus **＋ ADD TRACK**, and rename. |
| Per track | **REC → LOOP**, **PLAY / STOP**, **MUTE**, **SOLO**, **CLEAR** and **VOL**. Tracks are independent: clearing one loop doesn't touch the others. |
| Bar sync | REC starts on the next bar line, with a one-bar count-in when the transport is stopped. **LOOP closes on the nearest bar line** (pressed early: recording continues to it; pressed late: cut at it). Every loop is a whole number of bars, so loops of different lengths (1, 2, 4… bars) stay in phase. |
| Seamless first repeat | The capture finishes after the loop end (latency plus transfer). So the first repeat plays from the audio already captured, the tail comes from the final audio, and then the repeating loop takes over. There's no gap on the downbeat. |
| One-touch | The big header button is REC, then LOOP, on the **selected** track. After LOOP the next empty track is selected. Space does the same (and never starts the hidden arrangement). |
| Visual state | EMPTY ○, WAITING ◔ (count-in shown), RECORDING ● (pulsing border), CLOSING ⟳, PLAYING ▶ and STOPPED ■. Muted or not-soloed tracks are dimmed and labelled. Each track has a progress ring with bar ticks, a waveform and its length ("2 BARS"). State isn't shown by colour alone. |
| Click | Count-in always clicks; CLICK toggles the metronome. Clicks go to the **monitor output** (headphones when available), not to the audience. |
| Safety | **PLAY ALL**, **STOP ALL** (discards an unfinished recording), **MUTE ALL** and **PANIC**. PANIC stops every loop, recording, pad and note and turns live monitoring off; loops are kept. |
| Persistence | `project.looper` (tracks, loops, mute/solo/volume, count-in/click, selected track) autosaves and is in `.dbdjproject`. Loop audio is stored untouched as latency-compensated mono WAV in IndexedDB (`production-loop://…`). Production Studio undo covers clear, add, remove and rename. |

**Phase 1 is not:** overdub, undo/redo of overdubs, configurable quantize, BPM detection, master loop (Phase 2); sampler/MIDI/instrument loops (3); FX, sends, vocal tuning (4); scenes and variations (5); performance capture (6); rolling capture, multi-output routing, replace/versions, external sync (7); foot controllers (8).

### MVP Definition of Done — status

| # | Requirement | Status |
|---|---|---|
| 1 | Open Production Studio → Live Looper | ✅ Phase 1 |
| 2 | Select a microphone/input | ✅ Phase 1 |
| 3 | Record a percussion sound | ✅ Phase 1 |
| 4 | Turn it into a repeating loop | ✅ Phase 1 (seamless first repeat) |
| 5 | Record a second loop while the first continues | ✅ Phase 1 |
| 6–8 | Add bass, chords, vocals | ✅ Phase 1 (audio loops from the input) |
| 9 | Overdub another vocal | ✅ Phase 2 (⧉ DUB) |
| 10 | Undo a bad overdub | ✅ Phase 2 (↶ UNDO / ↷ REDO, plus Phase 1's CLEAR and project undo) |
| 11 | Mute/unmute individual parts | ✅ Phase 1 (plus solo) |
| 12 | Add effects | ⏳ Phase 4 |
| 13 | Keep all loops synchronised | ✅ Phase 1 (bar-locked loops, verified by listening test); Phase 2 adds LOOP QUANTIZE for PLAY/STOP |
| 14–15 | Save and reopen without losing the performance | ✅ Phase 1 (loops and settings; no performance recording until Phase 6) |

---

## 2. Phase 2 — exactly what is in it

| Area | Built in Phase 2 |
|---|---|
| Overdub | **⧉ DUB** on a track with a loop starts recording on that loop's own next cycle (always in phase); DUB again closes it. Holding through more than one repeat folds every pass into one new layer (sums the cycles). Non-destructive: `LoopAudio.layers: LoopLayer[]` (each its own WAV) plus `active` — playback sums the layers up to `active`. |
| Undo / redo | **↶ UNDO** / **↷ REDO** per track move `active` by one; layers are never deleted, so REDO always restores exactly what UNDO hid. Recording a new overdub after an UNDO drops the hidden (redone-away) layers first. This is separate from Production Studio's own undo (CLEAR, add/remove/rename track). |
| LOOP QUANTIZE | OFF, 1/4, 1/2 or 1 beat, 1, 2 or 4 bars (header dropdown, `LooperSession.quantize`). PLAY, STOP and TOGGLE land on the chosen grid line once the transport is running (no wait if nothing's playing yet). REC/LOOP use it too, clamped up to a whole bar, so a loop's length is always a whole number of bars. |
| Master loop | With **no loops yet** and the transport stopped, REC is free-running (no count-in, no bar grid). LOOP runs onset detection (`slicing.ts` `detectTransients`) and tempo estimation (`looper/tempo.ts`) over candidate take lengths of 2/4/8/16 beats, and proposes BPM, bar count and downbeat in a banner with editable fields and a confidence score. **USE THIS TEMPO** sets the project BPM, starts the transport at the detected downbeat and commits the take as that track's base loop; **DISCARD** throws it away so REC can be pressed again. |
| Threshold Recording (Auto-Start) | **AUTO-START** (header, `LooperSession.thresholdRecord` + `thresholdDb`, −60 to −6 dB). REC arms the track (◉ ARMED, pulsing blue) and waits silently; the first capture sample past the threshold becomes the take's start, so a base-loop recording never carries leading silence. Applies to a fresh base-loop take only — not DUB, which must start exactly on the loop's own cycle boundary to stay in phase. REC/LOOP on the same track while armed cancels it. |
| Manual Trim | Every loop track gets an **IN** slider (the Manual Trim in-point) and a **✂ STRIP** button under DUB/UNDO/REDO. Non-destructive: `LoopAudio.trimIn` just rotates where playback starts in the (always-complete) buffer — nothing is cut, `duration`/`bars` never change, and every active layer shares the one `trimIn` so overdubs stay aligned with the base. STRIP runs the Sampler's `analyseClean` on the base layer and sets `trimIn` to its detected leading silence in one click; the slider is there for fine, by-ear adjustment afterwards. Useful for "production-style" takes (a spoken phrase, a one-shot hit) where you primed the recording ahead of the sound, rather than a tightly bar-synced performance loop. |
| UI | Big header button becomes **⧉ DUB** when the selected track already has a loop (REC otherwise); Space follows the same rule. Each loop track gets a DUB / UNDO / REDO row and an IN / STRIP row under PLAY/MUTE/SOLO/CLEAR, plus a "2/3 PASSES" badge and a combined (summed) waveform when it has more than one layer. |

**Still outstanding before Phase 2 is "tested" like Phase 1:** a real-mic Electron pass — listen for overdub-punch timing, LOOP QUANTIZE feel at each grid setting, tempo-detection accuracy on a clapped/tapped take, Threshold Recording's trigger feel at different dB settings, and Manual Trim / STRIP SILENCE on a real take with genuine leading silence (not just the synthetic unit tests).

---

## 3. Architecture

```
src/production/looper/timing.ts      pure maths: bar lines, closeLoop, loopRegion, loopPhase, firstPassPlan, sealLoop, peaks, mixPeaks, foldCycles,
                                      dbToLinear, thresholdCrossing, trimmedOffset
src/production/looper/tempo.ts       pure maths: estimateTempo (onset autocorrelation → BPM, bars, downbeat, confidence)
src/production/looper/LiveLooper.ts  engine: transport, click scheduler, record/overdub/close/play/stop, arm-and-wait, master-loop confirm,
                                      trim/strip-silence, gains, perform() commands
src/production/types.ts              LooperSession, LoopTrack, LoopAudio, LoopLayer, LoopQuantize, blankLooper, ProductionProject.looper
src/ui/LiveLooperWorkspace.tsx       the LOOPER tab
reused: VocalStudio.beginCapture()   (shared input), ProductionStudio.updateLooper/storeAudio/getBuffer,
        WebAudioEngine.createProductionOutput/createMonitorOutput, recordings.ts (IndexedDB), wav.ts,
        slicing.ts detectTransients (master-loop tempo) and analyseClean (STRIP SILENCE)
```

**Graph:** loop voice(s) (one AudioBufferSourceNode per active layer, `loop = true`) → voice fade (de-click on stop/start) → track gain (volume × mute × solo, smoothed) → looper bus → Production Studio output → master. Overdub layers are summed simply by connecting every active layer's source into the same voice fade node. Click goes to the monitor output.

**Timing model.** The transport origin is the audio-clock time of bar 0. A loop stores `bars`, `anchorBar` (the bar it started on, mod `bars`), and the `bpm` / `beatsPerBar` it was recorded at. The playback offset at time t is `((t − origin) − anchorBar·bar) mod (bars·bar)` (`loopPhase`). Starting, stopping and restarting a loop never moves it off the grid. A loop recorded at a different BPM refuses to play until the tempo matches; time-stretching to a new tempo is a later phase. Capture alignment uses the same latency model as Vocal Studio: musical time t is captured at t + round-trip latency. `nextBar`/`closeLoop` are generic over the "bar" unit, which Phase 2 reuses directly: a loop's own cycle length for overdub boundaries, and LOOP QUANTIZE's grid for PLAY/STOP/TOGGLE and (clamped up to a whole bar) REC/LOOP.

**Threshold Recording.** REC still calls `vocal.beginCapture()` immediately (so monitoring/metering stay live) but, when armed, doesn't set a real `start` — `LooperState.recording.armed` is true and every incoming chunk is scanned (`thresholdCrossing`) against the linear threshold (`dbToLinear(thresholdDb)`). The trigger resolves a pending promise (`armResolve`) with the capture-clock time of the crossing sample; `record()` is restructured so `busy` is released *before* that wait, so REC/LOOP on the same track can still reach `closeRecording()` → `discardRecording()` to cancel (which also resolves `armResolve` with `null`, unblocking the wait cleanly). The trigger time minus latency becomes `rec.start`, and recording then proceeds exactly as the non-threshold path (bar-rounded LOOP close, or tempo detection if it's the master loop) — threshold mode only changes *when* `start` is chosen, nothing downstream. Doesn't apply to DUB, which must start exactly on the loop's own cycle boundary.

**Manual Trim.** `trimmedOffset(phase, trimIn, duration)` just adds `trimIn` to the computed playback phase (mod `duration`) before passing it as the `AudioBufferSourceNode` start offset — since the node already loops the whole buffer (`loopStart=0`, `loopEnd=buffer.duration`), moving the offset is enough; nothing about the stored audio or `bars`/`duration` changes. `layerKey()` (the string `reconcile()` compares to know a voice needs rebuilding) folds `trimIn` in alongside the layer refs, so dragging the IN slider on a *playing* loop re-triggers `restartVoiceLayers()` and is audible within one 15 ms fade. STRIP SILENCE decodes the base layer (`layers[0]`) and runs `analyseClean` on it, exactly like the Sampler's Auto Clean.

**Layer sync.** `LiveLooper` tracks which layer refs (plus `trimIn`) each playing voice currently sounds (`voiceLayers`). `ProductionStudio.subscribe` fires `reconcile()` on every project change (undo, reopen, overdub committed, UNDO/REDO, CLEAR, trim); when a playing track's key no longer matches what's sounding, `reconcile()` stops and restarts that voice with a 15 ms fade so it always catches up — overdub, UNDO, REDO and Manual Trim don't need their own playback-patching code.

**Commands.** Every button calls `LiveLooper.perform(action, trackId?)` with these actions:
`record, overdub, loop, play, stop, toggle, mute, solo, clear, undo, redo, strip-silence, select, next-track, play-all, stop-all, mute-all, panic`.
`confirmMaster`/`discardMaster` (the tempo-detection banner) and `setTrim` (the IN slider, a continuous value) take structured arguments and aren't part of `perform()`. Phase 8 maps MIDI foot switches, keys and DDJ-SB buttons to these through the existing `CommandBus` / action catalogue (`looper.*` actions), with no UI coupling.

---

## 4. Future phases

Each phase: inspect → implement → unit-test the pure maths → Electron end-to-end with the fake input (`--use-file-for-fake-audio-capture`, plus a continuous ScriptProcessor tap for listening checks) → regression (Production Studio, Sampler, Vocal Studio) → stop for review.

### Phase 3 — Samples, MIDI & Instruments
- **Input source per track:** Input (mic/interface) or Production Studio bus. Internal sources (Sampler, instruments) are tapped from their output nodes into a capture worklet instance, so no microphone is needed.
- **MIDI loops:** `LoopTrack.kind = "midi"`. Notes are captured in beats (reusing Sampler pattern recording) and played by the scheduler into Synth, Drums or Sampler tracks, staying editable in the piano roll.
- **Sampler → Loop:** record pad performances as audio or MIDI. **Loop → Sampler:** `saveClipAsSample`-style hand-off.

### Phase 4 — Effects, Mixer & Vocal Processing
- **Per-track insert chain**, all real Web Audio or worklet DSP and changeable while playing: EQ, filter, compressor, reverb (convolution), delay and ping-pong, chorus/flanger/phaser, distortion/saturation, bitcrusher, gate, limiter. This reuses the deck FX code (`src/audio/fx.ts`) where it applies.
- **Quick macros:** PITCH, FILTER, TONE, DRIVE, SPACE, DELAY, WIDTH, REVERSE.
- **Sends A/B and output selection.** Loop tracks become first-class Production Studio mixer strips (same meters and bus model), not a second mixer.
- **Vocal Studio processing** on vocal loops: pitch correction, formant, doubler.

### Phase 5 — Scenes & Live Arrangement
`LooperSession.scenes: { id, name, tracks: Record<trackId, "play" | "mute" | "stop">, variation?: Record<trackId, versionId> }[]`. Launching a scene is quantised to the next bar (configurable). Loop **variations** (A/B/C/D) are alternative `LoopAudio`s per track, launched with quantisation.

### Phase 6 — Performance Capture
**RECORD PERFORMANCE** logs a timeline of events (launch, stop, mute, solo, volume, scene, FX parameter, MIDI) with audio-clock times, plus any newly recorded audio. **SEND TO ARRANGEMENT** turns it into Production Studio tracks:
- each loop becomes an audio track with clips repeated where it played, and mutes become clip gaps
- MIDI loops become MIDI clips
- mixer and FX moves become automation (adds an automation-lane model)

### Phase 7 — Advanced Live Performance
- **Rolling capture and CAPTURE LAST 1/2/4/8 bars:** an input ring buffer in the capture worklet (preallocated, about 30 s at the context rate), read back on demand.
- **Multi-output routing:** master, monitor, click and cue, extending `WebAudioEngine` channel routing (4-channel today). The click stays headphones-only unless explicitly routed.
- **Loop REPLACE / versions** (V1, V2…) and performance optimisation.
- **External sync:** MIDI Clock in and out first (Web MIDI timing clock), then Ableton Link or equivalent through a native helper in the desktop build, subject to licensing.

### Phase 8 — Hands-Free Performance
`looper.*` actions in `src/core/actions.ts` mapped to MIDI foot switches, keyboard and DDJ-SB buttons. Foot-controller workflow: REC → LOOP → NEXT TRACK → OVERDUB → UNDO → SCENE → STOP.

---

## 5. Constraints

- **Monitoring and click latency are browser output latency** (the Vocal Studio note applies: typically 20–60 ms on Windows shared mode). Loop placement is latency-compensated. A native audio backend is the long-term fix for live-monitoring feel.
- **One shared input:** Phase 1 records one loop at a time from the input chain (Phase 2's overdub still uses the same single input, just a second pass). Multi-input recording needs multi-channel capture (Phase 7).
- **Loop audio lives in IndexedDB** on this machine. Project portability arrives with *Collect Project Files* (shared with Vocal Studio).
- **Tempo detection is a heuristic:** it scores 2/4/8/16-beat candidates by how well onsets fit the grid and takes the most confident; an ambiguous or sparse take (long pads, silence, off-grid playing) can get the wrong bar count or BPM, which is why Phase 2 always proposes for confirmation rather than committing automatically.

# Teach Me: Live Looping — architecture, scope and roadmap

Learn → **🎓 Teach Me: Live Looping**. A gamified, hands-on tutorial for the Live Looper (Production Studio → ⟲ LOOPER): short lessons, immediate audio-clock-accurate feedback, and milestones — played by performing real actions in the real looper engine, never a simulation.

Status: **Phases 1 and 2 are built.** Phase 1 is the complete beginner journey end to end: Module 1 (The Perfect Loop), Fix My Timing, and Progressive Sandbox Level 1. Phase 2 is Module 2 (Layering & Frequency Management). No microphone, account, MIDI controller or external service is required by either. Phases 3–5 below are design only — listed so they don't block what's built, not shown as active lesson controls (locked "Planned" cards).

---

## 1. Phase 1 — exactly what is in it

| Area | Built in Phase 1 |
|---|---|
| Entry point | Learn → **🎓 Teach Me: Live Looping** tile (`LibraryPanel.tsx`, dispatches `dbdj:navigate` → `"teachloop"`, same mechanism as DJ Training), and a promo box on the About page. A new top-level `navigation.area` in `App.tsx`, alongside `"training"`/`"lighting"`. |
| Overview | Activity cards (Module 1, Fix My Timing, Progressive Sandbox 1) with a completed/best-score badge each, plus locked **Planned** cards for Modules 2–5 at the time (Module 2 unlocked — see §2). A milestone counter and a confirm-gated **Reset training progress** action. |
| Module 1 — The Perfect Loop | Drill A (beat-one taps, scored each with signed ms feedback) then Drill B (capture a real 4-bar loop, scored for start/end/duration accuracy). 90 BPM, 4/4, one bar → four bars, per the spec. |
| Fix My Timing | A deliberately misaligned one-bar backing loop (its real downbeat sits 110 ms after the loop restarts). Hear it, inspect the IN point, correct it with Manual Trim (drag) or STRIP SILENCE (one click), compare before/after, replay. |
| Progressive Sandbox 1 | A protected drum backing loop plays; the learner records/overdubs/undoes/mutes/clears their own pad layer over it, in Strict or Sandbox mode, using the real REC/DUB/UNDO/MUTE/CLEAR actions. |
| Instruments | Four synthesised pads — KICK, SNARE, BASS, CHIME (keys A/S/D/F) — plus a synthesised one-bar ghost drum loop and a synthesised A-minor ghost synth phrase. Nothing is downloaded; `sounds.ts`'s `SOUND_MANIFEST` documents role, key, duration and loop points for each ("source: generated", no license needed). |
| Ghost loops | `LoopTrack.protected` (new, optional field on the shared type): REC, DUB, CLEAR and remove-track all refuse on a protected track; mute, solo and volume work normally. Engine-level, so it benefits any future protected-backing use, not just this lesson. |
| Strict / Sandbox | Strict = Threshold Recording on (arms REC, captures the real unquantised onset) + LOOP QUANTIZE off. Sandbox = Threshold Recording off + LOOP QUANTIZE `1-bar`. Both are existing Live Looper Phase 2 features, just configured differently per mode — nothing new was built for this. |
| Timing authority | Every score comes from `LiveLooper.now()` (a new, trivial accessor for `ctx.currentTime`) compared against `LiveLooper.getState().origin`, using the lesson's own pure `scoring.ts` helpers. `setInterval`/`requestAnimationFrame` only drive the view (`useTick`, same as the real Looper workspace). |
| Persistence | `dbdj.teachloop.v1` (localStorage, JSON: `{ progress, milestones }`), storage injectable for tests, mirroring `TrainingService`'s pattern. Training recordings live in a **separate** `ProductionStudio` instance with its own autosave key (`dbdj.teachloop.scratch.v1`) — the user's real project is never read or written. |
| Accessibility | Beat-number text is always shown (not just the ring); the ring's pulse is wrapped in `prefers-reduced-motion: no-preference`. Status uses icon + label text, never colour alone. Keyboard: Space/A/S/D/F, repeat-filtered, ignored while typing (mirrors `LiveLooperWorkspace`'s existing pattern). Large touch-friendly pad buttons. |

**Phase 1 is not:** Module 2 (§2, also built) or Modules 3–5 (§4, still planned); transient/time-stretch correction inside a recording (Fix My Timing explicitly says so rather than imply boundary quantization fixes it); a microphone anywhere in this module (Phase 3).

---

## 2. Phase 2 — Module 2: Layering & Frequency Management — exactly what is in it

| Area | Built in Phase 2 |
|---|---|
| Entry | Unlocked overview card, gated on Module 1 being completed (`prerequisites: ["perfect-loop"]`, same lock mechanism every planned module already uses). |
| Layers | Four pre-seeded, already-looping tracks — **Drums** (protected, always on), **Bass** (deliberately in the kick's own frequency range — the clash this module exists to teach), **Melody** (higher register, out of the way by design), **Vocal/Percussion** (short bandpassed chops, top end). All four start together (muted ones silent), so **ADD LAYER** is an instant, phase-locked unmute — never a fresh, potentially late `play()`. |
| Frequency-clash diagnosis | A real low-band energy analysis, not a guess: each layer's actual rendered audio is run through `lowBandEnvelope` (a one-pole ~250 Hz low-pass, then RMS per window) once at seed time. `clashReport()` pairs every two currently-playing layers and scores how often they're both loud down low at the same instant (`lowBandClash`, 0–1), worst first, shown as a labelled bar (never colour alone) — e.g. "Bass × Drums: 78% low-end overlap — these are fighting for the same space." |
| Correction | **LOW CUT** per track (new, see below), **MUTE**, **VOLUME** — "supported… controls" per the brief, since that's genuinely what the engine supports today (no per-track EQ bands yet, so none are offered). **COMPARE** (`toggleLayeringCompare()`) flips every correction off so the learner can A/B their fix by ear against the unfixed mix, then flips back. |
| Milestone | **Balanced the Low End** — awarded once all four layers are in *and* a correction (low cut or mute) has been applied to at least one of bass/melody/vocalPerc. Deliberately a completion check, not an automated "is it actually better" judgement (which the brief explicitly warns against over-claiming) — the audible improvement is for the learner's own ears via COMPARE. |

**New engine capability (shared, not lesson-only):** `LoopTrack.lowCutHz?: number` and `LiveLooper.setLowCut(trackId, hz)` — a real-time highpass filter per track (`BiquadFilterNode`, inserted between the voice and the track gain via a new `filterFor()`, mirroring how `gainFor()` already works). `hz` ≤ 20 or unset is "off" (no separate enabled flag needed). This is a genuine Looper Studio mixing control, exposed in the real `LiveLooperWorkspace` too (a LOW CUT slider next to VOL) — Module 2 is simply the first thing to use it, exactly the pattern Phase 1 set with `LoopTrack.protected`.

**Phase 2 is not:** a live-updating clash score as corrections are applied (the report is computed once from the original rendered audio; COMPARE is how the "after" is actually verified, by ear) — real-time per-track analysis would need a new `AnalyserNode` tap per track, deferred rather than built speculatively; multi-band (only sub/low vs. everything else, not a full spectrum) EQ beyond the single low-cut filter; automated "this mix is objectively better" scoring.

---

## 3. Architecture

```
src/teachloop/scoring.ts          pure maths: TIMING_WINDOWS, nearestBeatErrorMs, judgeTap, describeTap, tapScore,
                                   consistencyScore, scoreLoopCapture, lowBandEnvelope, lowBandClash, describeClash
                                   — unit-tested, no engine access
src/teachloop/curriculum.ts       pure data: ACTIVITIES (Modules 1-2 + Fix My Timing + Sandbox 1, Modules 3-5 as
                                   planned:true), MILESTONES, default BPM/bars/attempt counts
src/teachloop/sounds.ts           pure-ish synthesis: PADS, SOUND_MANIFEST, LAYERS (Module 2's drums/bass/melody/
                                   vocalPerc), synthesizePad/GhostDrums/GhostSynth/Layer (OfflineAudioContext, no
                                   files, no license)
src/teachloop/PadCapture.ts       LooperInputSource: taps the lesson's pad bus with the same dbdj-capture worklet
                                   Vocal Studio uses for the microphone — no mic, no new worklet
src/teachloop/TeachLoopService.ts the lesson runner — owns a dedicated ProductionStudio + LiveLooper, pads,
                                   ghost-loop/layer seeding, drills, scoring, milestones, persistence
src/ui/TeachLoopWorkspace.tsx     the Learn → Teach Me: Live Looping screen
reused: LiveLooper.perform()/now()/startClick()/setLowCut(), ProductionStudio.storeAudio/getBuffer/updateLooper,
        the Sampler's analyseClean (STRIP SILENCE), slicing.ts, wav.ts, the dbdj-capture AudioWorklet
```

### 3.1 Isolation — one real engine, two instances, never shared state

The non-negotiable constraints were "reuse the real engine" and "never touch the user's real project." The resolution: `TeachLoopService` constructs its **own** `ProductionStudio` and `LiveLooper` — the exact same classes Production Studio uses, not a parallel implementation — wired together exactly as `createApp.ts` wires the real ones, with two differences:

1. **`ProductionStudio.storageKey`** (new, optional constructor parameter, defaults to the real autosave key so the real app is unaffected). The lesson instance passes `"dbdj.teachloop.scratch.v1"`. Without this, a second `ProductionStudio` would autosave over the user's real project on its very first edit — this was the one genuine landmine in the "just make a second instance" plan, and the fix is a two-line change.
2. **`LiveLooper`'s input** is no longer hardcoded to `VocalStudio`. It now takes a `LooperInputSource` (`{ beginCapture, setSettings }`), a structural interface `VocalStudio` already satisfies — zero change at the real call site. The lesson passes a `PadCapture` instead, so Module 1 never requests microphone access.

Everything else about isolation falls out for free: loop/recording audio blobs live in IndexedDB keyed by a globally-unique `ref` (`production-loop://…`), so the two instances' recordings never collide even though they share the same IndexedDB database. The shared `WebAudioEngine`/`AudioContext` is the one thing genuinely shared across the whole app (decks, Production Studio, Vocal Studio, the real Looper, and this lesson) — `createProductionOutput()` hands back a **new** `GainNode` on every call, so the lesson's audio graph and the real Production Studio's audio graph never fight over the same bus.

One consequence worth naming: because nothing is shared, "restore the user's previous settings when leaving the lesson" (§4 of the brief) is moot by construction — there is nothing of the real Production Studio's state to restore, because the lesson never touched it. What *is* restored is the lesson's own last-used Strict/Sandbox preference, via the same `dbdj.teachloop.v1` progress store (`TeachLoopState.mode`).

### 3.2 Pads without a microphone

`PadCapture` implements `LooperInputSource` by reusing `src/audio/capture-processor.ts` — the exact AudioWorklet Vocal Studio already records with. The worklet doesn't know or care what's connected to its input; Vocal Studio connects a microphone `MediaStreamSource`, `PadCapture` connects the lesson's pad bus (the same `GainNode` pad hits are already being played into, so what you hear is exactly what gets captured). Because the whole path — pad source → bus → capture worklet — never leaves one `AudioContext` and touches no real-world I/O, there is **no round-trip latency to compensate**: `PadCapture`'s `latency` is always `0`, more precise than a microphone take.

### 3.3 Protected tracks

`LoopTrack.protected?: boolean` (new, optional — old saved loops are unaffected). `LiveLooper.record()`, `.overdub()`, `.clear()` and `.removeTrack()` each gained a one-line guard that refuses with a clear message on a protected track; `setTrack()` (mute/solo/volume) was left untouched, so a protected ghost loop behaves exactly like a normal one for *listening*, just not for *editing*. This lives in the shared engine, not the lesson code, so any future "backing track you shouldn't be able to wreck" use case gets it for free.

### 3.4 Scoring is computed from raw input, independent of what the engine does with it

The spec's hardest constraint was "capture and assess the user's raw timing, independent of scheduled quantized actions." The resolution: every scored action reads `LiveLooper.now()` (audio-clock seconds) and `LiveLooper.getState().origin` **in the UI event handler, before calling `perform()`** — e.g. `beginLoopRecording()` captures the raw REC-press time, computes its signed ms error against the nearest bar with `nearestBeatErrorMs`, and *only then* calls `looper.perform("record", trackId)`. Whatever the engine does afterwards (quantize to the next bar in Sandbox; arm-and-wait for Threshold Recording in Strict) never touches that already-captured number. Drill B's duration score is computed the same way, from the raw REC-press and LOOP-press timestamps — never from the engine's own (always-integer) `bars` count — which is how a result like "4.08 bars instead of 4.00" is possible at all.

Strict vs. Sandbox is therefore pure **session configuration**, not a second scoring path:

```
setMode("strict")  → looper.setOptions({ thresholdRecord: true,  thresholdDb: -50, quantize: "off"   })
setMode("sandbox") → looper.setOptions({ thresholdRecord: false,                   quantize: "1-bar" })
```

"Do not award a Strict timing milestone from quantized output": `foundDownbeat` from Drill B's loop capture is gated on `mode === "strict"`; `firstLoop` (just finishing a playable loop) is awarded in either mode, since it's about completion, not precision. Drill A has no quantization path to begin with — a tap is a tap — so it's scored identically in both modes.

### 3.5 Interruption and staleness

Every attempt carries the service's `attemptId`, incremented by `retry()`/`selectActivity()`/`interrupt()`. Any async completion (`finishBeatDrill`, `endLoopRecording`) re-checks its captured `attemptId` before committing a result, so a stale callback from an abandoned attempt can never double-score or overwrite a newer one. `document.visibilitychange` and the shared `WebAudioEngine`'s `status` event (`state === "suspended"`) both call `interrupt()` during `countin`/`practice`, which pans, resets to `ready`, and marks the attempt **not scored** rather than penalising a performer for a backgrounded tab or a suspended `AudioContext`.

### 3.6 What Phase 1 does *not* claim

No sub-millisecond "lab-grade" timing claim is made anywhere in the UI or code — the windows (`TIMING_WINDOWS`, `scoring.ts`) are deliberately forgiving (40/90/180 ms) beginner targets, documented in one place. Browser output latency, input-device latency and display refresh jitter are not modelled or compensated for in Phase 1 (there is no audio input device in this module at all — pads are generated and played/captured entirely inside one `AudioContext`, which sidesteps most of that uncertainty, but the *display* of the beat clock still rides on `requestAnimationFrame`/`setInterval` polling, so what a learner *sees* can lag what they *hear* by a frame or two; scoring never uses what's on screen, only `looper.now()`).

---

## 4. Later phases — full design

Each phase: inspect what the prior phases built → implement → unit-test pure maths → Electron end-to-end → regression (Looper Studio, Sampler, Vocal Studio, DJ Training) → stop for review. Phase 2 (Module 2 — Layering & Frequency Management) is now built — see §2; it turned out not to need Live Looper's own Phase 4 (per-track EQ) after all, since a single real-time low-cut filter was enough to teach and resolve the sub/low clash this module targets. Everything below is still design only; the cards exist today so the roadmap is visible, locked, with no live controls.

### Phase 3 — Module 3: Dead Space & Microphone Progression

- **Scope.** Keep performance flow while building the first layer (no dead air between actions); then progress to a real microphone, reusing Live Looper's existing Threshold Recording for auto-start and the existing Vocal Studio input chain (device, trim, meter, latency) rather than building a second one.
- **Dependencies.** `VocalStudio` directly (the real one, not `PadCapture`) — meaning this module's `LiveLooper` either becomes the REAL Production Studio's looper (session-isolation then has to come from a different mechanism, e.g. a disposable Vocal Studio session) or the lesson gets its own `VocalStudio` instance sharing the real input-device logic. The latter keeps isolation intact and is the recommended path.
- **Data model.** `ProgressiveSandboxLevel: 1 | 2 | 3` on `TeachLoopState`; Level 2 adds a mic clap/snap layer over the Level 1 backing; Level 3 drops sample backing entirely.
- **Engine/API changes.** None required beyond what Vocal Studio + Threshold Recording already provide; this phase is almost entirely lesson/UX work.
- **Scoring.** Reuses Drill A/B's timing scorers unchanged for mic taps (claps). Input-level/activity measurement (not musical-quality judgement — explicitly out of scope per the brief: never infer "audience engagement" from silence).
- **UX.** Input device picker, gain guidance, meter, a latency-calibration step (reusing `VocalStudio.measureLatency`), false-trigger handling for Threshold Recording (raise the default dB floor, show a "didn't trigger — try louder or closer" hint), and a sample-based fallback path when no microphone is available or permission is denied (so the module is never a hard wall).
- **Acceptance criteria.** Complete Level 2 and Level 3 with a working mic input; complete the sample-based fallback end to end with mic access denied.
- **Risks.** Permission UX (denied/revoked mid-lesson), device hot-swap, and false triggers are the real complexity here, not the audio engine.
- **Migration.** None.

### Phase 4 — Module 4: Song Structure & Performance

- **Scope.** Verse/chorus/outro arrangement: independent tracks, A/B/C sections, quantised section transitions, adding/removing layers live, a clear ending. Final challenge: a short structured performance, assessed on observable actions (section changes, transition timing, layer control) plus optional learner reflection text.
- **Dependencies.** Live Looper's own Phase 5 ("Scenes & Live Arrangement", `docs/LIVE-LOOPER.md`) — `LooperSession.scenes` and quantised scene-launch don't exist yet. This module is gated on that landing in the real engine first (reuse, not reimplementation, is the whole point of this architecture).
- **Data model.** A performance-event log (`{ type, t, data }[]`) timestamped on the real audio clock, mirroring Live Looper's own planned Phase 6 ("Performance Capture").
- **Scoring.** Section-transition timing (reuses `nearestBeatErrorMs` against the chosen quantise grid) and a simple "did every planned section happen" completeness check.
- **UX.** A timeline view of the planned structure vs. what actually happened.
- **Acceptance criteria.** Complete a 3-section (verse/chorus/outro) performance with every transition inside the Sandbox-mode quantise window.
- **Risks.** This is the first module that really needs multi-minute attempt durations; interruption/resume handling (§3.5) needs to tolerate a pause without discarding 90 seconds of performance.
- **Migration.** None additive to existing data; a new `performance` record shape is new, not a change to old.

### Phase 5 — Advanced Practice

- **Scope.** Adaptive difficulty (tighten `TIMING_WINDOWS` as milestones accumulate), longer loops, alternative tempos/meters (3/4, 6/8), optional MIDI mapping for pads (reusing the existing MIDI/controller stack, `ControllerManager`), external clock / Ableton Link where feasible (gated on Live Looper's own Phase 7, "External sync"), advanced timing correction (transient-level nudge/time-stretch — explicitly deferred from Fix My Timing in Phase 1), full performance recording, and optional hands-free control (gated on Live Looper's Phase 8 foot-controller mapping).
- **Dependencies.** The most dependency-heavy phase — several items are directly gated on corresponding Live Looper engine phases landing first (external sync → Looper Phase 7; hands-free → Looper Phase 8). These are called out explicitly rather than assumed.
- **Data model, scoring, UX, acceptance criteria, risks, migration.** Deferred to a dedicated design pass once Phases 2–4 are built and real usage data (which milestones are easy/hard, where learners actually struggle) exists to design adaptive difficulty against, rather than guessing now.

---

## 5. Constraints

- **Two autosave keys, one real project.** `ProductionStudio.storageKey` must never default differently for the lesson instance — if a future refactor removes the explicit `"dbdj.teachloop.scratch.v1"` argument at the `TeachLoopService` call site, the lesson would silently start reading and overwriting the user's real project on its first edit. Treat that constructor argument as load-bearing.
- **IndexedDB grows unbounded.** Every `seedGhost()`/`beginLayering()` call (each time an activity using pre-seeded loops is opened or retried) stores new WAV blobs; nothing currently prunes old lesson-scratch recordings from `dbdj-production-recordings`. Harmless for a while, worth a cleanup pass once usage data exists.
- **No audio-input uncertainty in Phases 1–2, by design.** Pads and layers are synthesised and captured entirely inside one `AudioContext`, so there's no device/driver latency to model — this disappears the moment Phase 3 adds a real microphone, which is why Phase 3 explicitly reuses Vocal Studio's existing latency-measurement flow rather than inventing a new one.
- **Module 2's clash report is a snapshot, not a live meter.** `clashReport()` is computed once from each layer's original rendered audio at seed time; applying LOW CUT changes what you *hear* in real time (it's a real filter in the playback graph) but does not recompute the displayed percentages. This was a deliberate scope cut (§2) — COMPARE (A/B by ear) is the intended way to verify an improvement, not a re-scored number. A live per-track `AnalyserNode` tap would remove this gap if it's worth the engine-side cost later.
- **Not yet verified on real hardware/browsers.** Phases 1–2 have only been checked with `tsc` and the unit suite (`tests/teachloop.test.ts` — timing maths, curriculum/sound-manifest integrity, lesson-state transitions, mode separation, protected-track guards, low-band energy maths and persistence, all audio-free) plus a manual code read of the engine integration points. Neither has had a real Electron pass (hear the pads, the ghost/layer loops, the count-in, play through Drill A/B, Sandbox and the Module 2 layering flow end to end) the way Live Looper Phase 1/2 did. Do that before calling either phase "tested," the same bar the rest of this app holds itself to.

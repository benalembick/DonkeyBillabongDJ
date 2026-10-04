# DJ Training Curriculum

Seven lessons, each with an explanation, objective, illustrated example, guided practice and an assessed attempt. Open it from **Practice Mode → DJ Training Curriculum** or **About → Open DJ Training**.

## Code

| Part | File |
|---|---|
| Lesson content, requirements, steps, assists (data) | `src/training/curriculum.ts` |
| What's measured: samples, boundaries, phase, exact B-entry position (pure) | `src/training/measure.ts` |
| Live step checks, hints, highlights, phrase counter (pure) | `src/training/coach.ts` |
| Lesson-specific scoring with "how it was calculated" (pure) | `src/training/scoring.ts` |
| Track readiness and suggested pairs (pure) | `src/training/pairs.ts` |
| Session state machine, snapshot/restore, timers, persistence | `src/training/TrainingService.ts` |
| UI: dashboard, setup, coaching panel, results, illustrations | `src/ui/TrainingWorkspace.tsx` |

Control highlights use `data-train` attributes on the real controls (tempo, jog, PLAY/CUE, SYNC, faders, EQs, filter, crossfader, FX units): a dashed, pulsing outline — never an overlay — plus the control's name in the panel.

## Lessons

| Lesson | Level | Assessed attempt scores |
|---|---|---|
| Manual Beatmatching | Beginner | tempo match (last 20 s), beat alignment (median ms), stability (% within 25 ms), time to lock in — SYNC locked, Track B starts ±2–3.5% off |
| Phrase Mixing | Beginner | phrase recognition (taps, latency-corrected), entry on the phrase, completion, alignment |
| Quick Cut | Beginner | B's entry on the chosen bar/phrase, A's cut timing, clean switch (A out ↔ B in) |
| Bass Swap | Intermediate | bass cut before entry, swap timing (bar 9), bass overlap, bass gap, completion, alignment |
| Harmonic Mixing | Intermediate | key choice (Camelot; uncertain keys flagged), entry on the phrase, completion, alignment |
| Long Blend | Advanced | overlap length (32 bars), alignment through the blend, stability, bass handover, level continuity — SYNC locked |
| Effects Transition (echo-out) | Advanced | ECHO on beat 4 before the boundary, A cut timing, tail length (4 bars), effect level (45–75%), B entry |

Pass mark: 60. Each metric shows its value and how it was scored; metrics without data (no grid, unknown keys) are **unavailable** and excluded from the weighted total. Not doing the task scores 0.

## What is (and isn't) measured

- Only engine data: deck positions from the audio clock, playback rate, beat grids, mixer and FX settings. No perceptual audio analysis — "level continuity" and "effect level" use fader/knob positions and say so.
- Inputs: mouse, keyboard and DJ controllers all drive the engine through the same command bus, and training observes the engine state, so every input source works. `training.tap` is a mappable action. With no mapped controller connected, hints name the keyboard and on-screen controls instead (e.g. "hold J, or drag Track B's on-screen jog wheel anticlockwise"; "scroll the mouse wheel down over the fader for fine steps").
- **Latency:** both decks pass through the same output latency, so musical alignment (B's entry against A's beats) is measured directly on the audio clock. B's entry is computed exactly from a later sample: `A position − (B position − cue) / B rate × A rate`. Phrase taps are reactions to what was heard, so they're corrected by the output latency. Fader/FX timings are sampled every 15 ms.
- **Analysis confidence:** uncertain grids add a note to timing metrics; grids and phrase markers can be corrected (Transitions page / deck grid editing). Phrases are 8 bars from the grid's first bar and phrase offset — every bar is not a phrase.

## Safety and restoration

- Training never presses PLAY. It won't start while a deck is playing; the user must choose "Stop decks & start practice".
- On the first start it snapshots both decks (track, position, tempo, key lock, vinyl, sync), the mixer (gain, EQs, filters, faders, crossfader), the FX units (level, deck assignment, slots on/off) and the display assists, and restores them all on Exit.
- SYNC is locked in the engine (`lockSync`) for lessons that teach manual matching — from any input — and unlocked on finish/exit. The BPM display is hidden where the lesson's assessed attempt turns it off.
- The 15 ms sampling interval is the only timer; it's cleared on pause, finish and exit.

## Progress

`localStorage` key `dbdj.training.v1`: per lesson — completed, best score, practised, last 20 attempts (date, total, metric scores, tracks). "Reset progress…" (with confirmation) clears it. The suggested next lesson is the first incomplete one whose prerequisites are done.

## Track choice

Suggested pairs come from analysed local tracks that meet the lesson's needs (beat grids, tempo gap within reach, keys for Harmonic Mixing), ranked by tempo fit, grid confidence and key compatibility, with the reasons shown. Missing analysis can be run from the setup page. No training audio is bundled: with fewer than two analysed tracks the lesson explains what's needed.

## Verified

- `tests/training.test.ts` (21 tests): phrase vs bar boundaries, exact B-entry position, every lesson's scoring with known timing (perfect beatmatch vs 1 BPM off; quick cut on the phrase vs 100 ms late; entering on a bar that isn't a phrase; latency-corrected taps; clean vs clashing bass swap; a textbook echo-out), unavailable metrics excluded from the total, harmonic key scoring incl. uncertain keys, coaching hints (tempo direction, nudge direction, wait for the phrase, bass clash), the 8-bar hold, pair suggestions and readiness, and sessions on the real engine: blocked while a deck plays, no auto-play, SYNC lock, beatmatch offsets per retry, results saved and reloaded, reset, restoration of the previous track/tempo/mixer.
- In the app (`DBDJ_SMOKE_TRAINING="a.wav|b.wav"`): beatmatching practice driven like a user — Track B started +3% off, SYNC press ignored, hint "running fast (+3.72 BPM) — move Track B's tempo fader up", tempo matched, aligned with 31 jog nudges to 5 ms, all 5 steps completed; an assessed quick cut on the phrase scored entry 8–18 ms late (100), cut 8–18 ms (100), clean switch 0 ms (100) and was saved as completed; Exit restored the earlier track at +2%, fader 0.4, crossfader 0.3 and B's LOW at 70%, SYNC unlocked; PLAY and SYNC then worked normally.

## Limitations

- Scores use control and playback data only — they can't tell whether a mix *sounded* good (e.g. clashing melodies, actual loudness).
- Beat grids drive everything: an analysis error moves every timing score until the grid is corrected.
- Training uses decks A and B; there's no separate practice player.
- The quick cut/effects cut moment is sampled every 15 ms (±15 ms resolution); B's entry is exact.

# Transition Intelligence

The **Transitions** area (top bar) turns two tracks' analysis into a bar-accurate mix plan, recommends techniques, and rehearses the transition on the decks.

## Code

| Part | File |
|---|---|
| Bar/beat maths, point selection, techniques, steps, warnings, rehearsal clock (pure, tested) | `src/transitions/planner.ts` |
| Vocal regions from STEMS (pure, tested) | `src/transitions/vocals.ts` |
| Pairing, facts, analysis/vocal jobs, persistence, invalidation, rehearsal | `src/transitions/TransitionService.ts` |
| UI | `src/ui/TransitionWorkspace.tsx`; waveform markers in `src/ui/Waveforms.tsx` |

## Where the numbers come from

- **Bars:** 4 beats from the beat grid's first beat (bar 1). **Phrases:** 8 bars from a per-track phrase offset (0–7 bars, user-correctable).
- **Times:** `firstBeat + bar × 240 / BPM` in each track's own timeline — the time the deck shows. The transition's wall-clock length is `bars × 240 / targetBpm`; Track B's timeline advances by that × its playback rate.
- **Tempo:** target = Track A's BPM unless the user sets one. B's rate is `target / BPM_B` (half/double time considered). Beatmatched techniques need ≤ ±16% (warning beyond ±10%); a quick cut or echo-out only matches B's tempo within ±10% and otherwise leaves it alone.
- **Transition points:** candidate phrase starts are scored — A: near its outro / recommended mix-out, lower energy across the window, no vocals in it; B: inside its intro, lower energy, no vocals. With vocals for both, A and B are chosen together to minimise overlapping vocals. Manual points (± bar / ± phrase) override.
- **Energy per bar:** from the waveform analysis (`low + 0.6 × mid` per frame, averaged per bar).
- **Vocals:** only from STEMS — the deck's live vocal envelope if the track is on a deck with STEMS ready, else the STEMS cache (`renderData`), else separation is started first. Without STEMS, vocal activity is reported as unknown; vocal-dependent techniques are unavailable.
- **Sections/phrases are approximate:** the analysis finds intro/outro/breakdowns from a 32-slice energy profile, then the planner snaps to the grid's phrases. The plan is marked "≈ Approximate" unless both grids were set by hand.

## Techniques

| Technique | Lengths | Needs | Shape |
|---|---|---|---|
| Phrase-aligned blend | 8/16/32 | beatmatch | B starts at bar 1 (bass cut), gradual bass exchange at the middle bar, A out at the end |
| Bass swap | 8/16/32 | beatmatch | B in with bass cut, one-move swap on the middle downbeat |
| Quick cut | 1/2/4 | A grid | A's filter build for N bars, cut to B on the downbeat |
| Echo-out | 2/4/8 | A grid | echo on 1 beat before the downbeat, A cut on it, B starts, tail for N bars |
| Vocal-to-instrumental | 8/16/32 | vocals for both | blend chosen so A's last vocal ends over B's instrumental |
| STEMS swap | 8/16/32 | STEMS for both | B's drums/bass under A's vocal, swap drums/bass mid-way, then vocals |

Each option shows why it suits (or why it's unavailable), difficulty and an analysis confidence (grid confidence, key confidence; technique-specific).

## Saved plans and invalidation

Saved in `localStorage` (`dbdj.transitions.v1`) by `outTrackId>inTrackId` (content hashes), with the settings (technique, length, target BPM, phrase offsets, manual points) and an analysis stamp per track (analysed?, grid BPM/first beat, manual flag, vocal regions). Reopening resolves the track IDs to current file paths. When a track's preparation record changes (re-analysis, grid edit), the plan is recalculated and a notice says so; a saved plan auto-saves after that. Detected vocal regions are cached per track ID (`dbdj.vocals.v1`).

## Rehearsal

- Uses the two decks. If a deck is playing (a live mix), rehearsal is **blocked** until the user explicitly chooses "Stop decks & rehearse". There is no separate preview player in the audio engine.
- Prepares: loads both tracks (Track A stays on its deck if already loaded), sets both tempos and key lock as the plan says, seeks B to its cue and sets a **session-only** cue point (CUE returns there; the track's saved cue is untouched), sets the mixer start state (EQs/filter centre, A fader up, B fader down, B LOW cut for blends), and starts A the chosen number of bars (2/4/8/16) before the transition.
- The countdown, current/next instruction and transition bar come from Track A's playback position (`engine.getPosition`, the AudioWorklet's clock), every frame.
- When the user presses PLAY on B, the start error is measured from the same clock and shown in ms and beats.
- Replay / Reset / Stop / Try another technique.

## Verified

- `tests/transitions.test.ts` (16 tests): bar/beat maths and labels, tempo match incl. half/double time, per-bar energy, exact plan timestamps/bars/seconds/tempo/swap bar/step times, recalculation on length/tempo/phrase changes, manual overrides, outro alignment at the track's last bar, missing-analysis states, unknown vocals and unavailable techniques, vocal-overlap warnings and steering, far tempo/key clash (cut recommended, B keeps its tempo), echo-on-beat-4 timing, rehearsal countdown and step switching, vocal regions from STEMS PCM.
- In the app (`DBDJ_SMOKE_TRANSITIONS="a.wav|b.wav"`), two generated tracks (124 and 122 BPM, 96 bars, 16-bar intro/outro): analysis run from the page with its stages shown; grids 124.00 BPM @ 0.247 s and 122.01 BPM @ 0.251 s; plan "When Track A reaches 02:35.1 (bar 81.1), start Track B from 00:00.3. Blend over 16 bars (31.0 s at 124.00 BPM), exchange the bass at bar 9 of the blend (02:50.6), and finish by 03:06.1", B +1.63%; save → reopen identical; grid shifted one beat → plan moved exactly one beat with the recalculation notice; rehearsal with a 2-bar lead-in, B pressed at "NOW" measured 7–13 ms late (0.02–0.03 beat); a playing deck blocked the rehearsal until the explicit stop.

## Limitations

- Phrase/section detection is energy-based and approximate; the phrase marker and point controls are the correction path. Downbeats assume the grid's first beat is bar 1 (correct it with "◀ beat / beat ▶").
- Vocal activity requires STEMS (model + separation); no vocal detection without them.
- No isolated preview path: rehearsal needs both decks.
- Rehearsal gives timing feedback for starting B; fader/EQ moves are guided but not scored (Practice Mode scores mixes).

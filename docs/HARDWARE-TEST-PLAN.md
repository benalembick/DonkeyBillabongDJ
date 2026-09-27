# DDJ-SB Hardware Test Plan (Phase 1 spike)

The aim is to prove **DDJ-SB → application → audio engine** is reliable, with low enough latency to DJ, before building more UI.

## Setup

1. Close Serato, rekordbox, Mixxx and any other MIDI software.
2. Connect the DDJ-SB by USB directly, not through a hub, for the first run.
3. Run `npm run dev` (or `npm start` after `npm run build`).
4. **Expected:** the top bar shows `● Pioneer DDJ-SB — Connected`. If it shows `○ No DJ Controller Detected`, open Diagnostics and note the MIDI port names listed. Report them, since the port-name pattern may need adjusting.
5. Library tab → **Add folder** → pick a folder containing MP3 or WAV files.

## A. Controller → events (no audio needed)

Open **Live controller events** and operate each control. You should see lines such as:

| Do | Expect |
|---|---|
| PLAY A | `PLAY A` |
| CUE A | `CUE A` |
| Turn the jog A side ring | `JOG A +4 (side)` / negative when turning back |
| Touch the jog A top | `JOG TOUCH A ON`, then `OFF` on release |
| Turn the jog A top while touching | `JOG A +n` |
| Tempo A | `TEMPO A +1.7%` (value follows the slider) |
| EQ HIGH A | `EQ HIGH A 64` at centre |
| Crossfader | `CROSSFADER 0…127` |
| Pad A1 in HOT CUE mode | `PAD A1 · Hot cue 1 A` |

Any line saying **UNMAPPED** is a control we don't know yet. Note the raw bytes shown on the right.

## B. Controller → audio

1. Turn the browse encoder: the library selection moves. Press **LOAD A**: the track loads into Deck A and a waveform appears.
2. **PLAY A**: audio plays and the PLAY LED lights.
3. Channel fader A: volume changes smoothly with no zipper noise.
4. Crossfader: fully right silences A (additive curve).
5. Tempo A: speed changes. Check the direction: **pulling the slider towards you should speed up**. If it is reversed, untick "down = faster" in Settings and report it.
6. **Jog while playing** (side ring): a temporary speed-up or slow-down that returns to tempo.
7. **Pause**, then jog: the position moves precisely and the playhead follows.
8. **VINYL on** (LED lit), touch the top of the platter while playing: audio stops under your hand; move it to scratch; release: playback resumes.
9. **CUE**:
   - pause away from the cue point and press CUE: this sets a new cue point;
   - hold CUE: plays from the cue point, and returns there on release;
   - press CUE while playing: returns to the cue point and pauses.
10. Pads (HOT CUE mode): press on an empty pad to set a cue (the pad LED lights), press again to jump. SHIFT+pad clears it.
11. EQ and FILTER knobs affect Deck A audio. SHIFT+FILTER changes gain.

## C. Latency and feel (the go/no-go)

1. With audio playing, tap the jog repeatedly and listen for how quickly the nudge responds.
2. Record Diagnostics → *Estimated total* latency for each setting:
   - Settings → Audio → Latency **Lowest**, **~5 ms** and **~10 ms**;
   - with output set to the system default;
   - with output set to the DDJ-SB (if listed).
3. Scratch test: are scratches smooth, or stepped or laggy? Try scratch sensitivity 0.5× / 1× / 2×.
4. Listen for crackles over 5 minutes of two-deck playback with the UI busy (switch tabs, open the MIDI monitor).

## D. Jog calibration

Pause Deck A, press **reset** next to JOG TICKS, and turn the platter exactly **one full revolution**. Enter the number shown in Settings → Jog ticks per revolution (default 720). Report the value.

## E. Headphone cueing through the DDJ-SB

1. Settings → Audio → Output device: DDJ-SB. Routing: **4 channels**. Apply.
2. Diagnostics → Output channels should show 4.
   - If it shows 2 on Windows: Control Panel → Sound → DDJ-SB → Configure → **Quadraphonic**, restart the app, and try again. Report the result either way.
3. Press HP CUE on deck B and turn HP MIX: deck B should be audible in the headphones only.

## F. Resilience

1. While Deck A plays, **unplug the DDJ-SB**. Audio must continue, and the top bar shows `Pioneer DDJ-SB disconnected — playback continues`.
2. Plug it back in: it reconnects automatically, and PLAY works again.

## Reporting

- **Controller test** tab: operate every control, mark ✓ or ✗, add a note for failures, and use **Copy test report** to paste a Markdown table into an issue.
- The full per-control matrix with expected MIDI is in [DDJ-SB-TEST-MATRIX.md](DDJ-SB-TEST-MATRIX.md).
- Include Diagnostics values (OS, sample rate, latencies, output channels) and the event log if anything went wrong.

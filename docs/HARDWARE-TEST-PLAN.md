# DDJ-SB Hardware Test Plan (Phase 1 spike)

The aim is to prove **DDJ-SB → application → audio engine** is reliable, with low enough latency to DJ, before building more UI.

## Setup

1. Close Serato, rekordbox, Mixxx and any other MIDI software.
2. Connect the DDJ-SB by USB directly, not through a hub, for the first run.
3. Run `npm run dev` (or `npm start` after `npm run build`).
4. **Expected:** the top bar shows `● Pioneer DDJ-SB — Connected`. If it shows `○ No DJ Controller Detected`, open Diagnostics (sliders icon, top right of the top bar) and note the MIDI port names listed. Report them, since the port-name pattern may need adjusting.
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

## G. Four decks (deck layers and soft takeover)

Not yet verified on hardware. The layer button and LED follow Mixxx's 4-deck DDJ-SB script, and have only been checked by simulating its MIDI through the app.

1. Load a track on each of decks A–D. Click **4 DECK** in the toolbar, or press Ctrl+Shift+D.
2. Press **SHIFT + KEY LOCK** (printed TEMPO RANGE) on the left side.
   - **Expected:** the four-deck bar shows `LEFT CONTROLLER: DECK C`, deck C gets a green outline and a "◀ LEFT CONTROLLER" tag, and the SHIFT+KEY LOCK LED (0x60) lights.
   - Press it again to return to deck A, and the LED goes out.
   - Repeat on the right side for B/D.
   - Report whether the LED lights with or without SHIFT held.
3. With the left side on deck C, check that each of these drives deck C and none of them drives deck A: PLAY, CUE, SYNC, jog (nudge, scratch, search), tempo slider, channel fader, EQ, FILTER, SHIFT+FILTER (gain), HP CUE, pads in all four modes, and LOAD A.
4. Pad LEDs, PLAY/CUE/SYNC LEDs and the HP CUE LED should show deck C's state, and switch back to deck A's when you toggle.
5. **Soft takeover**:
   1. Set deck A's fader to about 80% with the hardware.
   2. On screen, set deck C's channel fader to about 20%.
   3. Toggle the left side to deck C and move the hardware fader slowly.
   4. **Expected:** deck C stays at 20% (the screen shows ▼ 20% guidance) until the fader reaches 20%, then follows smoothly.
   5. Repeat with an EQ knob and the tempo slider.
   6. Report how the pickup feels; the tolerance is in Settings → Four decks.
6. Hold CUE on deck A, toggle the layer with your other hand, then release CUE. Deck A must stop previewing, and deck C must be unaffected.
7. Hot cue banks: switch between pads 1–4 and 5–8 on deck C. The layer must not change.
8. Press **2 DECK**. The sides return to A/B, SHIFT + KEY LOCK is tempo range again, and a deck C that is still playing shows a dashed "PLAYING" row.
9. Unplug and replug the DDJ-SB while four decks play. Playback must continue, and after reconnection every fader and knob waits for pickup (no jumps).

## Reporting

- **Controller test** tab: operate every control, mark ✓ or ✗, add a note for failures, and use **Copy test report** to paste a Markdown table into an issue.
- The full per-control matrix with expected MIDI is in [DDJ-SB-TEST-MATRIX.md](DDJ-SB-TEST-MATRIX.md).
- Include Diagnostics values (OS, sample rate, latencies, output channels) and the event log if anything went wrong.

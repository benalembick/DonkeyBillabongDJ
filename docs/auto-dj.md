# Playlists and Auto DJ

Import music → create a playlist → add and arrange tracks → **START AUTO DJ**.

Use **Create New Playlist** in the library sidebar. Select library tracks with Ctrl/⌘ or Shift, then choose **Add to Playlist**, use the right-click menu, or drag them onto a playlist. Local files can also be dropped directly into a playlist. Playlist rows can be dragged into order, or moved with the arrow buttons. Removing a row or deleting a playlist never deletes an audio file. Playlists can be renamed and duplicated, and show track count and total known duration.

Start from the beginning or the selected track. Ordered playback starts at that track and continues to the end. Shuffle includes the entire playlist and pins the selected starting track first. Optional key-aware ordering prefers compatible known keys; unknown keys are retained. Shuffle and ordering changes take effect on the next start or repeat cycle.

The queue shows the current deck, the prepared next track and upcoming tracks. Reorder, remove, add library tracks, select Play Next or Skip. These changes affect only the current session unless **Save queue back to playlist** is chosen. That saves the played/current/upcoming references in their runtime order; repeated references collapse to a single playlist entry. Repeat starts a fresh pass through the source playlist.

Smart + Auto is the default. The transition planner uses the existing beat grids, BPM, cue points, known musical keys, duration and waveform RMS. Compatible reliable grids permit phrase-aligned 4/8/16/32-bar mixes using the existing Sync system. Tempo matching is limited to the normal ±10% deck range; otherwise the planner uses a conventional crossfade or quick fade. Explicit lengths are bounded by the available duration of both tracks. Estimated phrase boundaries assume four beats per bar; waveform energy estimates audible intro/outro bounds, not vocal sections or guaranteed musical structure. Unknown keys are not guessed.

Once started, manual crossfader, playhead, deck, jog, cue, Sync and channel actions do not switch Auto DJ off. **Stop Auto DJ** is the explicit off control. Stop preserves the current session and queue; **Restart Auto DJ** resumes it directly from the Auto DJ Queue screen. If Stop was pressed during a transition, Restart returns control to the prior outgoing deck, stops the other deck, restores the crossfader side and prepares the queued next track. Failed loads and audio errors enter a visible blocked state with **Retry Auto DJ** rather than silently discarding tracks.

The Auto DJ settings let the user choose an automatic duration or a fixed 3, 5, 8, 10, 15, 20, 30, 45 or 60 second crossfade. Phrase bars remain a separate musical-alignment setting. The controls display the actual current plan duration in seconds, its countdown, and a Deck A → Deck B transition banner while mixing. The scrolling and overview waveforms read that same plan object: orange **MIX OUT** and green **MIX IN** markers are placed at `mixOut` and `mixIn`, and their shaded regions span `plan.seconds × deck.rate` track seconds. Replanning immediately moves these markers and regions.

The transition badge distinguishes the requested setting from the effective plan. **Beat Mix** uses BPM matching, phrase alignment and phase Sync when both tracks have reliable grids and their required tempo change is within ±10%. If those conditions are not met, playback safely falls back to Crossfade and the interface states both the fallback and its reason. **Crossfade** and **Quick Fade** use those types directly. **Smart** chooses Beat Mix for suitable tracks and a fade otherwise.

When analysis cues are unavailable, Auto DJ does not invent an analysed cue. The existing planner falls back to the first/last audible waveform bounds, then the deck cue or duration bounds, and snaps to reliable phrase grids when available. The waveform still labels the resulting operational **MIX IN**/**MIX OUT** plan so it shows what playback will do. Without reliable grids, it is shown as a conventional crossfade rather than a beat-mix. If no plan exists yet because the next deck is loading, the waveform shows no planned marker or region and the duration display shows the configured bar choice or **Auto**.

## Transition display acceptance criteria

- Changing Auto DJ's transition-length setting updates the control immediately; once both tracks are prepared, the displayed seconds equal `TransitionPlan.seconds`.
- Before a transition, **Transition in** equals `AutoDJState.nextSeconds`. During it, the banner identifies the actual outgoing and incoming deck from `AutoDJState.deck`.
- The outgoing marker starts at `TransitionPlan.mixOut`; the incoming marker starts at `TransitionPlan.mixIn`.
- Each shaded region ends at its marker plus `TransitionPlan.seconds × that deck's playback rate`, clamped to track duration.
- Scrolling markers remain anchored in track time while zooming or moving, and overview markers use the same timestamps.
- Any new plan replaces the prior display on the next Auto DJ state/frame update. With no current plan, no planned markers or regions are drawn.
- Missing analysed cues use the documented planner fallback and never receive a fabricated analysis-confidence value.

On desktop, playlists and metadata use the existing SQLite library. Embedded art is cached by content hash. In browser mode, metadata and small covers use IndexedDB, playlists/preferences use local storage, and original audio remains in local files. After a reload use **Reconnect files**, selecting the same originals, then resume. File identity uses name, size and modification time; moved unchanged files reconnect, while changed/re-encoded files need to be added again. Browser audio can still be limited by the browser's background/sleep policies; use the desktop application for unattended sets.

Artwork uses the existing metadata reader for supported MP3, M4A/AAC, FLAC and tagged WAV files. The library, playlists, queue, deck headers and track information views use the same cover component, with the coloured initial tile as fallback.

## Validation

`npm test`, `npm run typecheck`, and `npm run build` cover the unit suite and builds. The optional `DBDJ_SMOKE_AUTODJ=1` flag with `npm run smoke` generates disposable tagged WAV fixtures and verifies real deck playback/crossfade, manual MIDI takeover, embedded artwork under the production CSP, and playlist persistence. Add `DBDJ_SMOKE_BROWSER=1` to test browser storage and file reselection. Smoke tests use a disposable profile and mute the generated test audio.

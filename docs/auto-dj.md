# Playlists and Auto DJ

Import music → create a playlist → add and arrange tracks → **START AUTO DJ**.

Use **Create New Playlist** in the library sidebar. Select library tracks with Ctrl/⌘ or Shift, then choose **Add to Playlist**, use the right-click menu, or drag them onto a playlist. Local files can also be dropped directly into a playlist. Playlist rows can be dragged into order, or moved with the arrow buttons. Removing a row or deleting a playlist never deletes an audio file. Playlists can be renamed and duplicated, and show track count and total known duration.

Start from the beginning or the selected track. Ordered playback starts at that track and continues to the end. Shuffle includes the entire playlist and pins the selected starting track first. Optional key-aware ordering prefers compatible known keys; unknown keys are retained. Shuffle and ordering changes take effect on the next start or repeat cycle.

The queue shows the current deck, the prepared next track and upcoming tracks. Reorder, remove, add library tracks, select Play Next or Skip. These changes affect only the current session unless **Save queue back to playlist** is chosen. That saves the played/current/upcoming references in their runtime order; repeated references collapse to a single playlist entry. Repeat starts a fresh pass through the source playlist.

Smart + Auto is the default. The transition planner uses the existing beat grids, BPM, cue points, known musical keys, duration and waveform RMS. Compatible reliable grids permit phrase-aligned 4/8/16/32-bar mixes using the existing Sync system. Tempo matching is limited to ±6%; otherwise the planner uses a conventional crossfade or quick fade. Explicit lengths are bounded by the available duration of both tracks. Estimated phrase boundaries assume four beats per bar; waveform energy estimates audible intro/outro bounds, not vocal sections or guaranteed musical structure. Unknown keys are not guessed.

Manual crossfader, deck, jog, cue, Sync, loading and channel control pauses Auto DJ. **Pause** and **Stop** leave playing decks running and do not move the crossfader. **Resume** uses the currently playing deck, or continues a paused transition from the current crossfader position. If both decks are playing independently, pause one first. Queue editing is locked during a transition, including a paused transition, until it is resumed or stopped. Failed loads pause automation with a recovery message rather than silently discarding tracks.

On desktop, playlists and metadata use the existing SQLite library. Embedded art is cached by content hash. In browser mode, metadata and small covers use IndexedDB, playlists/preferences use local storage, and original audio remains in local files. After a reload use **Reconnect files**, selecting the same originals, then resume. File identity uses name, size and modification time; moved unchanged files reconnect, while changed/re-encoded files need to be added again. Browser audio can still be limited by the browser's background/sleep policies; use the desktop application for unattended sets.

Artwork uses the existing metadata reader for supported MP3, M4A/AAC, FLAC and tagged WAV files. The library, playlists, queue, deck headers and track information views use the same cover component, with the coloured initial tile as fallback.

## Validation

`npm test`, `npm run typecheck`, and `npm run build` cover the unit suite and builds. The optional `DBDJ_SMOKE_AUTODJ=1` flag with `npm run smoke` generates disposable tagged WAV fixtures and verifies real deck playback/crossfade, manual MIDI takeover, embedded artwork under the production CSP, and playlist persistence. Add `DBDJ_SMOKE_BROWSER=1` to test browser storage and file reselection. Smoke tests use a disposable profile and mute the generated test audio.

# Live Mashup architecture and phased implementation

Live Mashup extends the two existing decks. It does not introduce another audio path. Each source is decoded by the normal audio engine, separated by the existing cached STEM worker, routed through the existing per-deck stem mixer and channel DSP, then combined on the normal master bus.

## State model

`LiveMashupState` is the single runtime model:

- `status`: idle, preparing, ready, playing, paused or error.
- `a` / `b`: source track, assigned deck, selected stems, four live levels and phrase-aligned entry timestamp.
- `targetBpm` / `targetKey`: the arrangement targets derived from persisted analysis.
- `score`: the existing multi-factor compatibility score.
- `phraseBars`: the phrase alignment unit.
- `warning` / `message`: incompatibility and preparation feedback. Unknown analysis remains unknown.

Each source has four ordered stem channels: Vocals, Drums, Bass and Melody/Instruments. UI controls mutate this model through `LiveMashupService`; the service immediately calls `DJEngine.setStemMix`, so displayed values and audible values cannot diverge.

## Phase 1 — live arrangement (implemented)

- Open **Mashup Mode**, choose a recommendation and select **Create Live Mashup**.
- Load the sources into Deck A/B and reuse existing analysis and cached STEMS.
- Default to Track A vocals plus Track B drums, bass and melody; swap or select any combination.
- Choose a midpoint target BPM within a conservative range, set independent deck rates, phrase-snap both entries, start both decks and engage the existing continuous phase Sync.
- Display both source identities, BPM/key/Camelot/energy, target BPM/key, compatibility, phrase alignment, aligned overview waveforms and STEM progress.
- Apply live per-stem levels, vocal low-frequency reduction, conservative deck gain and master headroom.
- Persist editable versioned recipes in local storage.
- Optional Auto DJ **Intelligent Mashups** uses the same cached STEM eligibility and performs a vocal overlay followed by a drums/bass/melody handover. It falls back to the normal transition unless the plan is beat-synchronised and both STEM caches are complete.

Independent key shifting is deliberately not simulated: the current deck engine stores Key Lock as a future flag but has no pitch-preserving time-stretch/key-shift processor. Compatible Camelot tracks are used unchanged; incompatible or unknown keys show a warning.

## Phase 2 — editable projects and arrangement timeline (implemented)

- Recipes use the desktop SQLite application database and browser persistent storage, with reopen, delete and migration from version 1.
- Editable 8/16/32-bar arrangement blocks automate the selected stems and stored levels during playback.
- Vocal activity is derived from the separated vocal envelopes and shown as timeline ranges.
- The workspace includes aligned detailed scrolling waveforms plus whole-track overviews, beat grids, downbeats, cues and playheads from the existing deck renderer.
- Project recipes retain source references, offsets, BPM/key targets, phrase size, stem routing, levels, arrangement blocks and a versioned semitone field.

Pitch-preserving semitone processing remains unavailable because the current deck worklet is a varispeed player and its Key Lock flag has no DSP implementation. Phase 2 stores the versioned adjustment field but does not expose a control that would falsely imply independent pitch processing. Harmonic compatibility therefore warns and refuses extreme correction. A real phase-vocoder or licensed time-stretch implementation is a prerequisite for enabling that control.

## Phase 3 — deterministic offline render and library integration (implemented)

- **Save Mashup MP3** sends the saved recipe and copied source PCM to a dedicated render worker. Rendering stays off the UI and playback threads.
- The renderer applies the recipe's source offsets, tempo rates, arrangement blocks, stem routing, stem levels, vocal low-frequency management, headroom and output limiting. It reuses the cached separated PCM rather than separating the tracks again.
- The bundled MIT-licensed `wasm-media-encoders` LAME implementation creates a real 320 kbps stereo MP3. Title, combined artist and DonkeyBillabongDJ comment metadata are written before saving.
- Desktop builds use the operating-system save dialog. Browser builds download a new file. Source files are read only and are never overwritten.
- A completed export is registered as a normal local library track, queued for normal background analysis and added to the persistent **Mashups** playlist. This makes it available to decks, playlists, Auto DJ and future discovery searches.
- Saved versioned projects remain independent of rendered files, so they can be reopened, edited and exported again.

## Acceptance criteria for the implemented phases
- Create Live Mashup loads the selected recommendation into the existing two decks.
- Cached STEMS are reused; uncached sources show asynchronous progress and never block the UI thread.
- Default routing is A vocals plus B instrumental, and Swap produces the inverse immediately.
- Every checkbox and slider updates `DeckState.stems` and the audio worklet routing immediately.
- The target BPM never requires more than a 10% rate change; larger gaps warn instead of forcing a poor result.
- PLAY starts both phrase-snapped positions and enables continuous deck Sync after both decks run.
- Auto DJ Intelligent Mashups activates only for a sync-capable plan with two complete caches and otherwise retains the existing transition.
- Recipe persistence contains source references, offsets, routing and levels and does not claim to be rendered audio.

- Saving a project works across a renderer hot reload even when the desktop preload is from an older build; restarting the desktop app activates the new native MP3 save bridge.
- Exported MP3 files contain title, artist and comment metadata and are imported into the persistent **Mashups** playlist without modifying either source track.

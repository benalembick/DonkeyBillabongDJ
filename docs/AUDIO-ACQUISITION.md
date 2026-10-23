# Audio acquisition

The **Audio Sources** workspace is the entry point for the acquire → convert or record → tag → import → DJ workflow.

## Delivered

- Local audio files can be converted offline to MP3, FLAC, 24-bit PCM WAV, or M4A/AAC with the bundled FFmpeg worker.
- The worker copies available metadata and artwork when the target container supports it, verifies the output duration, then publishes it with a same-filesystem rename.
- Existing destination files are never overwritten. Each completed file is imported into the library and queued for normal analysis.
- Progress, measured real-time speed, cancellation, batch rights confirmation, and an always-visible permission reminder are included.
- Embedded lyrics are retained by metadata mapping, stored in the local library database, and available from the loaded deck's **LYRICS** button.
- On Windows x64, the Vivaldi recorder uses native WASAPI process loopback and saves 48 kHz stereo WAV. It captures audio from Vivaldi and its child processes, so other Vivaldi tabs may be included.

## Capability-gated

Application-isolated recording uses native WASAPI process loopback on supported Windows builds. This build does not include a Core Audio process-tap bridge for macOS, so recording remains unavailable there.

Silent routing is a separate capability and must only be enabled after the selected backend and application have been tested. DRM bypass and universal streaming downloads are out of scope.

## Later adapters

Authorized provider downloads and lyrics downloads require provider-specific APIs, credentials, reuse rules, attribution, and rate-limit handling. No provider is inferred to grant export rights merely because it can play a track.

## Spotify Session boundary

`SpotifyPlaybackAdapter` reuses the existing PKCE-authenticated Spotify browser and opens tracks through Spotify's official application URL. Its playback state has no audio-buffer API and never connects to a DJ deck.

`RecordingSourceAdapter` is a separate deny-by-default gate. It requires both an explicit provider recording agreement and a verified process-specific OS capture backend. Login, Premium status, playback success, or a user checkbox cannot enable it. Remote Spotify devices are rejected because their audio is not present on the local capture bus.

`SpotifySessionCoordinator` persists ordered entries with the Spotify track reference, expected duration, acquisition classification, chosen method, metadata revision, state, and resulting local asset. Completed results survive retry without being duplicated. A future authorized adapter can drive the existing capture and encoder pipeline through this boundary; this build does not advertise Spotify recording.

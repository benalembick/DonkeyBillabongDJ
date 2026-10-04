# Spotify → Local

Turn a Spotify playlist, a track, or a set of Spotify search results into a **local DonkeyBillabongDJ playlist of real audio files**, in the original order. Ready tracks can be played or queued in Auto DJ while the rest are still being prepared.

Spotify supplies only the playlist reference and the metadata. The decks always play local files: a file already in your library, a file your own converter saves into a watched folder, or a file from a download provider (Audius, or your installed spotDL). Spotify audio is never used. Spotify's terms don't allow it to be mixed in third-party apps (see [STREAMING-INTEGRATIONS.md](STREAMING-INTEGRATIONS.md)).

## What's automatic and what isn't

| Step | Automatic? |
|---|---|
| Read the Spotify playlist, Liked Songs or track (pagination, order, repeats, removed tracks, podcast and local-file entries) | ✅ |
| Create the local playlist at once, showing unresolved entries | ✅ |
| Find tracks already in your library (saved match → ISRC → artist, title, version and duration), checking the file still exists and decodes | ✅ |
| Pick up files your converter saves into the **watched folder**, wait until they finish writing, match them by tags, validate, import and analyse | ✅ |
| Download missing tracks from a provider: Audius (where the artist enabled downloads) or your installed **spotDL** (YouTube Music audio). Only download tracks you have permission to. | ✅ when enabled and available |
| Converting a Spotify track into a file (e.g. with ViWizard) | ❌ **Still manual, in that tool.** ViWizard has no documented automation interface (no CLI or API), so DonkeyBillabongDJ doesn't drive it. Convert in ViWizard and save into the watched folder; everything after that is automatic. |
| Choosing between two plausible versions (radio edit vs live, remix vs original…) | ❌ You confirm. Ambiguous matches are never accepted silently. |

## Setup (desktop app, Windows and macOS)

1. **Connect Spotify:** Library → STREAMING → Spotify. You need a Client ID and Premium; see [STREAMING-INTEGRATIONS.md](STREAMING-INTEGRATIONS.md#spotify-premium).
2. Open **Library → ⇄ Spotify → Local → ⚙ Folders & providers**:
   - **Watch Download Folder:** choose your converter's output folder (in ViWizard, *Preferences → Output Folder*) and tick **Watching**. Files already in the folder are checked once, then new files are picked up as they finish writing.
   - **Download destination:** a folder for provider downloads. Downloads are written only inside this folder.
   - **Download providers:** see below.
   - **Matching:** the auto-accept threshold (default 85%), the review threshold (70%) and the length tolerance (15 s).
3. Nothing else needs installing for library matching, the watched folder or Audius: the desktop app reads tags and audio formats itself. Only the optional **spotDL** provider needs Python, spotDL and FFmpeg (see [Setting up spotDL](#setting-up-spotdl)).

macOS: the first time you choose a folder inside Downloads, Documents or Desktop, macOS may ask to allow access; choose **Allow**. Windows: network drives work, but are scanned every 15 s instead of being watched live.

Browser mode (`npm run dev:web`): a web page can't watch folders, write files or run downloaders on your computer, so only library matching works there. Use the desktop app for the full workflow.

## Using it

- **From your playlists:** in Spotify → Local, pick a playlist under *Your Spotify playlists*, or select a playlist under Library → Spotify and choose **⇄ Prepare Local Playlist**.
- **From a link:** paste an `open.spotify.com/playlist/…` or `/track/…` link, or a `spotify:` URI, then choose **Preview**.
- **From search results:** under Library → Spotify, search, tick tracks, then choose **⇄ Prepare Local Playlist (n)**.

The preview shows how many tracks are already local, how many need review and how many need a file. Set the local playlist name, decide whether to use download providers, and optionally tick **Append tracks to Auto DJ automatically**. The button reads **Download Playlist** only when an enabled provider can actually download right now. Otherwise it reads **Prepare Local Playlist**, and missing tracks wait for files.

### Entry states

Each state shows an icon and text, so it doesn't rely on colour.

| | State | Meaning |
|---|---|---|
| ○ | Pending | Queued |
| ⌕ | Matching | Searching the library, then providers |
| ⏳ | Awaiting File | Not available locally; save it into the watched folder, or use **Match…** to choose a file or library track |
| ? | Needs Review | Several plausible versions, or a borderline score. Choose with **Review** (scores and reasons shown), or **None of these** |
| ⇩ | Downloading | From a download provider (progress shown where the provider reports it) |
| ⇥ | Importing | File validated, being added to the library |
| ◔ | Analysing | **Playable now**; BPM, key, beatgrid and waveform are being analysed |
| ✓ | Ready | Audio and analysis ready (or analysis skipped for very long files; it then runs on deck load) |
| ✕ | Failed | Reason shown (e.g. *File rejected: length differs from Spotify by 40 s*, *Podcast episodes can't be prepared*) |
| ⊘ | Cancelled | Cancelled by you; **Resume** / **Retry** restarts it |

Each row shows the audio source (*Local library*, *Watched folder*, *Audius (artist-enabled download)*, *Chosen by you*), the version accepted, the confidence, and the **actual file's** codec, bitrate, sample rate and duration.

### Playing while it prepares

- **Load Deck A / B** on any playable row. A deck that's playing is never replaced.
- **Play Next**: next in Auto DJ when it's running, otherwise onto a deck that isn't playing.
- **Add Ready Tracks to Auto DJ**: starts Auto DJ with the linked playlist if Auto DJ is off and no deck is playing. If Auto DJ is running, it appends only entries not queued before, at the end, so your queue edits are kept. Entries that aren't ready yet are skipped, and the message says how many. If Auto DJ is off while a deck is playing, it tells you to pause first rather than taking over.
- **Auto-append new ready tracks** (explicit opt-in per playlist): appends each newly ready entry once while Auto DJ is running.

### Refresh from Spotify

**⟳ Refresh from Spotify** previews added, removed and moved entries. Moves are real reorders, not shifts caused by inserts. **Apply** reorders the local playlist and processes new entries. Removed entries leave the playlist, but their audio files, library records, cues and beatgrids are never deleted.

The local playlist keeps its link. Its playlist view shows a banner (*Linked to Spotify “…” · 12/20 ready · 8 not local yet*) with the unresolved entries.

## Resolution order and matching

For each entry:

1. **Library:** a saved Spotify-ID→file mapping (yours or an earlier automatic one), then ISRC, then artist, title, version and duration, using the Smart Matching scorer ([SMART-METADATA-MATCHING.md](SMART-METADATA-MATCHING.md)). The matched file is checked: it must still exist, parse as audio and decode (a full decode unless it was already analysed), with a plausible length.
2. **Watched folder:** files seen this session that match the entry. New files are matched against every unresolved entry of every linked playlist.
3. **Providers:** enabled and available ones, if the job uses providers and a destination is chosen.
4. Otherwise **Awaiting File**.

Version rules: titles are never stripped of version text. Remix, radio edit, extended, club, live, acoustic, instrumental, dub, VIP, remaster and clean/explicit are classified separately:

- a conflicting version is never accepted automatically;
- if one side names a distinct recording (live, remix, extended, club…) and the other states no version, the pairing goes to **review**;
- radio edit or edit vs unlabelled is accepted only when the score and length agree;
- two strong candidates that differ in version or length always go to review.

Confirmed choices are saved as mappings and reused by later imports and by Smart Match everywhere in the app.

ISRCs: Spotify stopped returning `external_ids` (ISRC) to Development-Mode apps in 2026, so most entries have no ISRC. ISRCs are used only when both sides really have one; nothing is guessed.

## Download providers

> ⚖ **Only download tracks you have permission to download** — for example tracks you've bought, that are licensed to you, or that the rights holder makes available. You are responsible for what you download. The app shows this reminder next to the download option, above the provider list and on every job that uses providers.

| Provider | Audio source | Status |
|---|---|---|
| **Audius** | Audius, the artist's original upload | ✅ Enabled. Official API (`/v1/tracks/{id}/download`). Only tracks the artist made downloadable and that aren't gated (follow, purchase, NFT). Mostly independent artists, so many commercial Spotify tracks won't be there. |
| **spotDL** | **YouTube / YouTube Music** (metadata match, not the Spotify master) | ✅ Enabled when installed on this computer (the app detects it; it never installs it) |
| spottydl | **YouTube Music** (metadata match) | Listed, not bundled. It's a Node library, not a tool you install; spotDL covers the same source. |

Verified October 2026:

- **[spottydl](https://github.com/Thanatoslayer6/spottydl)**: *“it scrapes data from Spotify, then finds the right track/song from Youtube-Music”*. Needs FFmpeg ≥ 4.
- **[spotDL](https://github.com/spotDL/spotify-downloader)**: *“spotDL uses YouTube as a source for music downloads … 128 kbps for regular users and 256 kbps for YouTube Music premium users.”*

Neither downloads from Spotify, and neither gives you the Spotify master. Both download a YouTube recording that resembles the Spotify metadata; switching between them changes the implementation, not the audio source. Nothing here decrypts Spotify DRM, reads Spotify's cache, hooks its client or intercepts its streams.

### Setting up spotDL

1. Install [Python 3](https://www.python.org/downloads/). On Windows, tick *Add Python to PATH*.
2. In a terminal, run `pip install spotdl` (macOS: `pip3 install spotdl`), then `spotdl --download-ffmpeg`.
3. In **⚙ Folders & providers**, choose a **Download destination** and press **Check again** next to spotDL. It should show *✓ available (spotDL x.y.z)*.

The app looks for `spotdl` on PATH, then `py -m spotdl` / `python -m spotdl` (Windows) or `python3 -m spotdl` (macOS), including the usual pip and Homebrew folders that a packaged macOS app doesn't see. FFmpeg can be spotDL's own copy (`~/.spotdl`) or one on PATH.

How a spotDL download runs:

1. The app passes spotDL only the entry's Spotify track link (`https://open.spotify.com/track/<id>`, re-checked in the main process). spotDL runs with an argument list, never a shell, inside a private temp folder under `<destination>/.dbdj-partial/`.
2. The app asks for Opus at the source bitrate (`--format opus --bitrate disable`), so YouTube's stream is kept rather than re-encoded. Older spotDL versions that don't support this get spotDL's defaults.
3. The file must have the same length as the Spotify track (within the tolerance) or it's **rejected as a different version**. It's then validated, decoded and moved like any other download, as `Artist - Title [spotdl <id>].opus`.
4. The row shows *YouTube Music via spotDL* as the audio source and *“YouTube match chosen by spotDL; length checked against Spotify”* instead of a match score, because spotDL chose the recording.
5. Cancel stops spotDL and the FFmpeg processes it started. If spotDL fails (no YouTube match, a Spotify API change, rate limits), its own error is shown on the row and the entry stays retryable.

Spotify entries that are "local files" have no track link, so spotDL skips them.

Adding a provider means implementing `AcquisitionProvider` in [src/acquire/providers.ts](../src/acquire/providers.ts) and adding its URL rule to `PROVIDER_RULES` in [electron/acquire/ipc.ts](../electron/acquire/ipc.ts). Search, verification, download and ingestion are separate steps.

Quality: files keep the quality the source provides and are never re-encoded. Transcoding a 128 kbps source to FLAC or 320 kbps would not improve it.

## Reliability

- **Persistence:** jobs, entry states, provenance (origin, provider, candidate id, confidence, method, accepted version) and the Auto DJ "queued" flags are stored in the library database (`import_jobs` table; localStorage in browser mode). Confirmed matches go in `track_resolutions`. Folder settings are in `spotify-local.json` in the app's data folder. Provider and threshold settings are in local preferences.
- **Restart:** work that was in progress goes back to *Pending* and resumes once provider and folder availability is known. Leftover `.dbdj-partial/*.part` files are removed at startup.
- **Bounded work:** 3 entries at a time, 2 provider searches, 2 downloads, and **1 file decode at a time** (decoding runs off the audio thread; analysis remains the existing one-at-a-time background queue). Provider searches time out after 15 s, downloads after 10 min.
- **Retries:** rate limits (honouring `Retry-After`), timeouts and network errors are retried up to 3 times with exponential backoff (capped at 30 s). Refusals such as 403 fail immediately with the reason.
- **Isolation:** one failed entry never stops the playlist. An unavailable provider is skipped and never blocks library or watched-folder matching.
- **Idempotency:** a repeated track (in one playlist or across playlists) is acquired once and shared. The library de-duplicates by file. Downloads land at `<destination>/<Artist - Title> [<provider> <id>].<ext>`, and an identical existing file is reused rather than fetched again. A watched file already attached is never imported twice. Auto DJ entries are queued once.
- **Validation before Ready:** a download goes to a temp file and must be non-empty, parse as audio, have a length within tolerance of Spotify's and decode in the audio engine. Only then is it moved into the destination, added to the library and marked playable. A file that merely exists is never reported as success.

## Security

- **No network listener:** the renderer talks to the desktop main process over Electron IPC (context-isolated preload, sandboxed renderer). Nothing new listens on a port; only the existing short-lived Spotify and Apple Music sign-in callbacks use 127.0.0.1.
- **Folders:** chosen only in native dialogs and remembered by the main process; the renderer can't supply a path to write to. Downloads are written only inside the destination, under sanitised names (Windows-reserved names and separators removed), with `path.relative` checks against traversal.
- **Download URLs:** re-validated per provider (HTTPS only, exact host and path pattern, the id must match). Redirects must stay HTTPS, and size is capped at 600 MB.
- **No shell commands**, so there's no shell injection surface. spotDL is started with an argument list (`execFile` / `spawn`, `windowsHide`), and only ever receives a validated Spotify track link and paths the app created. Spotify tokens stay in the main process (OS keychain), are never passed to spotDL, and nothing logged contains tokens.
- **Spotify references:** validated (22-character base62 ids, playlist/track/liked only) before any API call.

## Spotify access limits

The current Development Mode rules (Feb 2026 [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)) apply. The app explains each case when it happens:

- **Playlists by other people:** all playlists in your library are listed and their tracks are always requested (`/playlists/{id}/items`, then the older `/tracks`). Spotify answers **403** for playlists you don't own or collaborate on, for apps under the 2026 rules. Verified October 2026 on an app that still receives ISRCs, so ISRCs aren't a reliable sign of older access.
  - **In the app**, playlists you can open come first. Playlists by other people are listed below them under **🔒 By other people**.
  - **With spotDL installed (desktop)**, a locked playlist can still be opened deliberately: its tracks are read with spotDL (`spotdl save`, metadata only, nothing downloaded) using spotDL's own Spotify access. That's slow: a 103-track playlist took about 10 minutes. The result is cached for 12 hours in `spotdl-playlists/` in the app's data folder, and an older cached copy is used if a later read fails. spotDL returned no ISRCs, so matching uses title, artist, version and length.
  - **Without spotDL**, locked playlists are greyed out; copy one into your own playlist in Spotify to use it.
- Spotify-generated mixes and editorial playlists may return 404.
- Batch `GET /tracks` was removed; pasted track links use the single `GET /tracks/{id}`.
- No ISRCs (`external_ids` removed) and no popularity data.
- Premium is required, with at most 5 users per app.

Removed tracks, podcast episodes and Spotify "local file" entries keep their positions: podcasts are marked unsupported, removed tracks without metadata fail with a reason, and Spotify local files are matched by their name, artist and length.

## Code map

| | |
|---|---|
| [src/acquire/SpotifyLocalService.ts](../src/acquire/SpotifyLocalService.ts) | Orchestrator: jobs, pipeline, review, refresh, Auto DJ and decks, persistence and recovery |
| [src/acquire/match.ts](../src/acquire/match.ts) | Library, file and duration matching rules (on the Smart Matching scorer) |
| [src/acquire/providers.ts](../src/acquire/providers.ts) | Provider interface, Audius adapter, informational YouTube matchers |
| [src/acquire/refresh.ts](../src/acquire/refresh.ts) | Refresh diff (pairs repeats, LIS-based "moved") |
| [src/acquire/jobs.ts](../src/acquire/jobs.ts) | Limiter, timeouts, retry/backoff, cancellation |
| [src/acquire/spotifyRef.ts](../src/acquire/spotifyRef.ts) | Pasted link parsing |
| [src/providers/spotify/SpotifyClient.ts](../src/providers/spotify/SpotifyClient.ts) | `resolveSource`: ordered entries, pagination, access errors, 429 handling |
| [electron/acquire/](../electron/acquire/) | Folder watcher, validated downloads, spotDL detection and runner (`spotdl.ts`), IPC, smoke-only folder setter |
| [src/ui/SpotifyLocalPanel.tsx](../src/ui/SpotifyLocalPanel.tsx) | UI (panel, review, refresh dialog, settings, linked-playlist banner) |

## Validation

- `npm test` runs `tests/spotifyLocalUnits.test.ts`, `tests/spotifyLocalService.test.ts`, `tests/acquireFiles.test.ts` and `tests/spotdl.test.ts`. The spotDL tests use a fake process runner, so no spotDL runs and nothing is downloaded. They cover detection and setup messages, argument-list launching, link validation, the older-version fallback, error reporting and cancel. The other tests cover link parsing, entry mapping, version-aware matching, the refresh diff, retry/backoff/limits and the acceptance scenarios against the real library, playlist store and resolver:
  - source order and repeats;
  - local reuse;
  - watched-folder arrival, both live and before the job;
  - decode rejection;
  - ambiguous versions sent to review and remembered;
  - provider failure isolation;
  - an unavailable provider;
  - a single download for repeats;
  - Auto DJ start, append-once and auto-append;
  - decks never replaced;
  - cancel, restart and retry without duplicates;
  - refresh;
  - actionable errors.
  
  The file tests run on real temp folders with generated WAVs: the watcher, partial files, stability, probing, idempotent finalisation, path safety and download checks.
- `DBDJ_SMOKE_SPOTIFY_LOCAL=1 npm run smoke` drives the real Electron app with generated audio:
  1. a deck plays;
  2. a job reuses a library file for a repeated track;
  3. a file written as `.part` and renamed in a real watched folder resolves its entry and is analysed to Ready;
  4. Auto DJ is refused while a deck plays, then started, and a second press adds nothing;
  5. the job is persisted and the job table renders.
  
  The playing deck's playhead is sampled throughout. Latest run: 47 samples, 0 stalls, worst lag 10 ms.
- No commercial audio is downloaded in any test.

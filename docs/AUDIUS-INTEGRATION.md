# Audius Integration

Audius is the first **playable streaming source**. Its tracks load into the same Deck A / Deck B pipeline as local files, so the DJ engine, mixer and DDJ-SB mapping all apply. Audius is also a **Smart Matching** target for Spotify and Apple Music metadata.

```
Audius → Search/Browse ─┐
                        ├─→ TrackInfo(source "audius") → loadBytes: stream full track into memory
Spotify → Smart Match ──┘       → decodeAudioData → deck AudioWorklet → EQ/filter/fader/crossfader → output
                                                  ↑ DDJ-SB (same mapping; the controller drives the deck, not the provider)
```

_Researched and tested 27 Sep 2026 against the live API._

## 1. Research findings

| Topic | Finding |
|---|---|
| API | Official REST API, `https://api.audius.co/v1`. The JS SDK (`@audius/sdk`) wraps the same endpoints. We call REST directly, which avoids a large dependency and works in both browser and desktop mode |
| Authentication | **None required for read and stream.** Requests carry `app_name=DonkeyBillabongDJ` (overridable with `VITE_AUDIUS_APP_NAME`). "Log in with Audius" exists for user actions (favourites, uploads) and isn't needed here |
| API key | Optional. A free key gives higher limits ([api.audius.co/plans](https://api.audius.co/plans)); not used. **No secrets exist anywhere in the app** |
| Rate limits | Free tier: **10 requests/s, 500k/month**. No rate-limit headers were observed |
| Endpoints used | `GET /v1/tracks/search?query`, `/v1/tracks/trending`, `/v1/tracks/{id}`, `/v1/tracks/{id}/stream`, `/v1/users/search`, `/v1/users/{id}/tracks`, `/v1/playlists/search`, `/v1/playlists/{id}/tracks` |
| Identifiers | Track `id` (short hash, e.g. `vZJJz`) plus numeric `track_id`; user `id`; playlist `id` |
| ISRC | **Field exists (`isrc`) but is usually `null`.** Never fabricated; matching falls back to metadata |
| Other metadata | title, `user.name`, `duration` (seconds), genre, mood, **`bpm`**, **`musical_key`**, release date, license, play count, `cover_original_song_title` / `_artist`, `remix_of`, and artwork URLs (`artwork["150x150" | "480x480" | "1000x1000"]`). There is no album field on tracks, only `album_backlink` |
| Stream | `/v1/tracks/{id}/stream` → **302** to a content node → **307** to signed object storage (2-hour expiry). Full **MP3** (`audio/mpeg`, e.g. 7–9 MB for 3–4 min). **Range requests supported (206)**. **CORS `*`** at every hop |
| Availability flags | `is_streamable`, `access.stream`, `is_stream_gated`, `stream_conditions` (premium, purchase or follow gates). Creators can opt tracks out of API access. We only load open, streamable tracks |
| Waveform data | The API has no waveform endpoint; we generate the waveform from the decoded audio (§4) |

### Licence (what our DJ use relies on)

The [Audius Open Music License](https://openaudiofoundation.org/open-music-license.pdf) (2 July 2025) says, §1.2:

> Licensor hereby grants to Music Players a worldwide, non-exclusive, royalty-free, perpetual, irrevocable right and license … to reproduce, publicly perform, distribute, electronically or digitally transmit, stream, and otherwise use in whole or part, the Licensed Material, in connection with a Music Player's services.

"Music Players" are "developers creating or operating software applications designed to play back audio files on the Audius Protocol". This app is one.

- **Permitted** (our reading): streaming, playback and public performance, "otherwise use in whole or part" as part of the player. That covers seeking, cueing, looping and hot cues, and real-time processing that happens inside the player (tempo, EQ, filter, jog, scratch, mixing two tracks).
- **Not expressly granted:** modification or derivative works as *separate artefacts*. §1.6 reserves "all rights … not expressly granted". We therefore **disable recording** for Audius sources and **never store Audius audio on disk**.
- **Attribution (§1.5, commercial use):** we show the artist name, a link to the track on audius.co (↗), and a notice referencing the OML in the Audius browser.
- **Uncertain / needs review:** the separate *Audius API Terms* (audius.co/legal/api-terms) returned a server error when fetched, so they could not be reviewed. Treat real-time DJ transformation as an interpretation of the OML, not an explicit grant. Before commercial distribution, confirm with Audius (api@audius.co) that DJ-style processing and public performance mixes are within the API Terms.

## 2. Architecture (reusing existing components)

| Piece | File | Role |
|---|---|---|
| `AudiusClient` | `src/providers/audius/AudiusClient.ts` | REST calls; **5 req/s throttle**; retry with back-off on 429/5xx/network; in-flight **de-duplication**; **10-min metadata cache**; stats (latency, requests, errors, last stream) |
| Stream download | `AudiusClient.downloadAudio` | Streams the full MP3 into memory with progress. **Resumes with `Range: bytes=N-`** after a dropped connection (up to 5 tries). Fails fast on permanent 4xx |
| `AudiusStore` | `src/providers/audius/AudiusStore.ts` | Browser state: trending, search tabs, artist and playlist drill-down, selection. Also a `BrowserPort` for the controller |
| `BrowserRouter` | same file | The DDJ-SB browse encoder and LOAD A/B act on the list on screen (Local or Audius) |
| `AudiusSource` | `src/providers/audius/AudiusSource.ts` | `PlayableSource` for the SmartTrackResolver. Available only after a successful API test |
| Mapping | `src/providers/audius/audiusTracks.ts` | Audius → `TrackInfo` (`source: "audius"`, `ref: audius:<id>`) and → `TrackIdentity` (covers → version "other", `remix_of` → remix) |
| Engine | `DJEngine.loadTrack` | Unchanged pipeline. `loadBytes` gained progress and abort, so decks show BUFFERING and network messages |
| Policy | `PROVIDER_CAPABILITIES.audius` | `canLoadIntoDeck: true`, `canRecord: false` |

No separate player exists. Audius audio is decoded into the same AudioWorklet deck as local files.

## 3. Buffering, network failure and isolation

- **Strategy: full-track buffer before play.** The deck shows `BUFFERING n%` and becomes playable when the whole file is in memory. DJs need instant seeking, scratching, loops and hot cues anywhere in the track, and a waveform of the whole track. Measured: **4.6–6.9 s** for 8.9 MB on this connection (time to first byte 0.4–3.7 s).
- After loading, playback **needs no network**: an outage never interrupts a loaded deck.
- During loading, a dropped connection shows `Audius connection interrupted — retrying (n/5)…` on the affected deck and resumes from the last byte.
- The audio lives in memory only, is released on eject or load, and is never written to disk (no persistent caching of Audius audio).
- **Isolation (tested):** with a local track playing on Deck B, a failing Audius load on Deck A showed an error on Deck A within 0.27 s, while Deck B kept playing at an unchanged level. Provider calls are async and outside the audio thread, and their errors stay in the provider store or deck state.

## 4. DJ capability matrix (Audius audio in our engine)

Tested live on 27 Sep 2026 with real Audius tracks, driven by **simulated DDJ-SB MIDI** (the same bytes → mapping → command path as the hardware). **Physical DDJ-SB confirmation is still pending (user).**

| Feature | Audius | How verified |
|---|---|---|
| Playback | ✓ | Live: playing; output level measured |
| Pause | ✓ | Live: position stable after pause |
| Seek | ✓ | Live: seek to 50 % landed within 0.3 s |
| Cue (CDJ behaviour) | ✓ | Same engine code as local files (unit-tested) |
| Hot cues | ✓ | Live: PAD A1 set hot cue 1 |
| Jog / nudge | ✓ | Live: jog ring sped playback up |
| Scratch | ✓ (engine) | Same worklet as local files; needs physical platter test |
| Tempo | ✓ | Live: +10 % slider → measured 1.104× |
| Pitch (varispeed) | ✓ | Tempo changes pitch, as on vinyl |
| Key lock | ✗ | Not implemented in the engine yet (Phase 2); not an Audius restriction |
| EQ (3-band + kills) | ✓ | Live: all EQs cut → −31 dB |
| Filter | ✓ | Live: low-pass reduced level |
| Channel fader / crossfader | ✓ | Live: crossfader to B → Deck A −50 dB |
| Loop | ✗ | Not implemented in the engine yet |
| Sync | ✗ | Not implemented in the engine yet (needs beat grid) |
| Waveform | ✓ | Generated from the decoded audio by our analysis worker |
| BPM / key | ✓ (metadata) | From Audius `bpm` / `musical_key`; our own BPM analysis is Phase 2 |
| Effects | ✗ | FX engine not implemented yet |
| Recording | ✗ **disabled** | Not granted by the OML (see §1) |

## 5. Smart Matching (Spotify → Local → Audius)

- Default source order: **Local Library → Audius** → Beatport / Beatsource / SoundCloud (partner-only). It can be reordered, and Audius switched off, in Settings → Streaming.
- Search sends only **artist + title** (then title only if nothing is found). The local library never leaves the machine.
- Conservative by design:
  - Audius covers (`cover_original_*`) count as version "other" and always conflict with originals.
  - `remix_of` counts as a remix.
  - Mashups, sped-up, slowed and nightcore uploads are "other".
  - Uploader ≠ artist, so the artist score is 0 and the total is capped at 50.
- **Tested live:**
  - A real Audius track presented as Spotify metadata resolved to Audius at **95 %** (title and artist exact, length within 0.7 s) and loaded into Deck B.
  - "Get Lucky" by Daft Punk from Spotify was **rejected**: every Audius result was a cover or flip scoring under 40. The deck was untouched and the user was prompted instead.
  - A repeated lookup made **0** new API requests (cache).
- **Caching:** confident matches are stored as mappings (Spotify ID → Audius ID, ISRC, confidence, method, date, user-confirmed) in SQLite. Only identifiers are stored, never audio. Remembered Audius matches show immediately in playlist views and are re-validated (track still exists and is streamable) when loaded.
- **Manual:** Match Details lists Audius candidates with **Use this version** / **Load → A/B**, and saves a user-confirmed mapping.
- **Playlists:** opening a Spotify playlist matches against the local library instantly. **⟳ Resolve playlist** adds Audius asynchronously (rate-limited) and shows e.g. `47 tracks · 31 Local · 9 Audius · 3 to review · 4 unavailable · 40 / 47 PLAYABLE`.

## 6. UI

- **Library → MUSIC → Audius:**
  - trending by default, and search (debounced 450 ms) across Tracks, Artists and Playlists;
  - artist and playlist drill-down;
  - columns: art, title, artist, genre, BPM, key, time, source, and LOAD A / LOAD B;
  - drag to a deck, or double-click to load into a free deck;
  - ↗ opens the track on audius.co;
  - gated tracks show 🔒 with the reason.
- **Decks:** show an `AUDIUS` source badge, `BUFFERING n%` with a progress bar, and network messages. Spotify → Audius loads show `SPOTIFY → AUDIUS · Smart Match 95%`, and the tooltip separates metadata from audio.
- **Controller:** while the Audius browser is on screen, the DDJ-SB browse encoder moves the selection and LOAD A/B loads it.
- **Settings → Streaming → Audius:** connection status, **Test connection**, auth ("none needed"), rate-limit policy and usage counters, and **Use Audius for Smart Matching** (default ON). The provider table shows Audius as AVAILABLE only after a successful test.
- **Diagnostics → Audius:** API host and status, last/average latency, request/cache/retry/error counts, and the last stream (track id, time to first byte, full-buffer time, size, retries). It also shows per-deck Audius status and Smart Match score.

## 7. Known issues and limits

- Loading needs the whole file (about 5–7 s on this connection) before it can play; very long mixes take longer and use more memory (about 10 MB of MP3 plus decoded PCM per 4 minutes).
- ISRC is rarely present, so Spotify → Audius relies on metadata. Uploads by other users of well-known tracks are deliberately rejected.
- Trending and search are general-purpose and not DJ-specific. There is no Audius genre filter in the UI yet (the API supports `genre` on trending).
- Tests use simulated MIDI. Physical DDJ-SB confirmation is pending.
- API Terms not reviewed (see §1). Recording stays disabled until clarified.

## 8. Tests

- `tests/audius.test.ts` covers:
  - mapping and no invented fields;
  - gated tracks;
  - covers and remixes;
  - de-duplication and cache;
  - 429 retry;
  - the 5 req/s throttle;
  - **Range-resume after a dropped stream**;
  - conservative matching (remix and cover rejected, true match accepted);
  - availability only after a successful API test;
  - playlist summary by source and cached remote mappings.
- Electron smoke checks (`DBDJ_SMOKE_AUDIUS`, `DBDJ_SMOKE_SPOTIFY_AUDIUS`, `DBDJ_SMOKE_ISOLATION`) run the live end-to-end checks above (see DEVELOPMENT.md).

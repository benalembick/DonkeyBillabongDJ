# Smart Metadata Matching

**Spotify and Apple Music are discovery, playlist and metadata sources, never DJ audio sources.** When you load a streaming track, the app works out *which recording* you mean and plays that recording from a source the DJ engine may actually use. Today that source is your local library.

```
Spotify / Apple Music track (official Web API: metadata + ISRC)
  → TrackIdentity (normalised)
  → SmartTrackResolver
       1. user-confirmed mapping?     (always wins while the target exists)
       2. cached automatic mapping?   (re-validated: target must still exist)
       3. sources in priority order:  Local Library → Audius → Beatport → Beatsource → SoundCloud → …
  → score candidates (transparent reasons)
  → resolved / possible / ambiguous / unavailable
  → playable TrackInfo { audio: local file, resolvedFrom: { metadata: spotify, … } }
  → DJ engine
```

Status (27 Sep 2026): Phases 1–3 are implemented, plus caching and manual overrides from Phase 6. The provider adapter architecture from Phase 4 is in place. **Audius is the first live playable provider** (see [AUDIUS-INTEGRATION.md](AUDIUS-INTEGRATION.md)). Beatport, Beatsource and SoundCloud are **unavailable** because they require partner access; see §8.

## 1. Architecture

| Layer | Module | Notes |
|---|---|---|
| Metadata providers | `src/providers/spotify/SpotifyClient.ts`, `src/providers/apple/AppleMusicClient.ts` | Official APIs only. They supply title, artists[], album, duration, **ISRC**, release date, explicit flag and artwork |
| Normalised identity | `src/matching/identity.ts` | `TrackIdentity`, title/version/featured-artist parsing, ISRC validation, version compatibility |
| Scoring | `src/matching/scoring.ts` | Two scoring models, configurable duration tolerances, confidence bands, reasons |
| Playable sources | `src/matching/sources.ts` | `PlayableSource` interface + capabilities; `LocalLibrarySource`; partner-only adapters |
| Resolver | `src/matching/SmartTrackResolver.ts` | Priority order, remote timeouts, ambiguity detection, cache and overrides, diagnostics ring buffer |
| App service | `src/app/matching.ts` | Deck loading, playlist resolution, pre-resolution, prompts to the UI, settings |
| Local tags + DB | `electron/library/tags.ts`, `electron/library/db.ts` | music-metadata (read-only), Node's built-in SQLite in the app-data folder |
| UI | `src/ui/LibraryPanel.tsx`, `src/ui/MatchDialog.tsx`, Diagnostics / Settings panels | Status badges, summary, Resolve playlist, Match Details, Find in my library |

The resolver is not Spotify-specific. Anything that can produce a `TrackIdentity` (Apple Music, playlist imports, future Universal Playlists) resolves through the same path, and anything that implements `PlayableSource` can supply audio.

## 2. TrackIdentity

```ts
TrackIdentity {
  source, sourceTrackId          // metadata origin, e.g. "spotify", "4uLU6hMCjMI75M1A2tKUQC"
  title                          // as provided
  baseTitle                      // normalised; version and "feat." text removed
  artists[], artistKeys[]        // display names; normalised (featured artists included)
  album, durationMs, isrc        // isrc validated ^[A-Z]{2}[A-Z0-9]{3}\d{7}$, upper-case
  version { kind, raw, remixer?, explicitlyStated }
  releaseDate?, explicit?, artworkUrl?, bpm?, key?
}
```

Version kinds: `original, remaster, radio, extended, club, edit, remix, live, acoustic, instrumental, dub, vip, clean, explicit, other`. They're parsed from trailing `(…)`, `[…]` or ` - …` segments, e.g. "Get Lucky (Radio Edit) [feat. Pharrell Williams]" gives base "get lucky", radio, and featured Pharrell Williams.

`compareVersions()` returns `match | compatible | uncertain | conflict`. It never treats radio/extended, original/remix or live/studio as interchangeable. "No version stated" against a named version is *uncertain*, and the length then decides.

## 3. ISRC handling

- **Spotify:** `track.external_ids.isrc`. Development-mode apps lost `external_ids` in Feb 2026, but Spotify restored it in March 2026.
- **Apple Music:** `attributes.isrc` on catalogue songs. Library songs often omit it, and matching then falls back to metadata.
- **Local files** (read-only, via music-metadata's common mapping): ID3v2 `TSRC` (MP3, AIFF, WAV `id3 ` chunk), Vorbis `ISRC` (FLAC/OGG), MP4 `----:com.apple.iTunes:ISRC` (M4A/AAC). Stored in `tracks.isrc` (indexed). Files are never modified to add one.
- An ISRC identifies a *recording*, not a file. Several releases can share it, so an ISRC match is always cross-checked against artist, title, length and version.

## 4. Local matching algorithm

1. Index: `LocalLibrarySource` keeps an ISRC map plus an inverted index of title words, rebuilt (debounced) whenever the library changes.
2. Candidates: every ISRC hit, plus tracks sharing at least one significant title word (rarest words first, capped at 200).
3. Score each candidate (§5), drop those under 40, and sort by score then source priority.
4. Decide:
   - **unavailable**: nothing reaches 70.
   - **ambiguous**: the top two are both ≥ 70, within 10 points, *and* materially different (version conflict or > 5 s length difference).
   - **resolved**: at or above the auto-load threshold (default 85).
   - **possible**: anything else.
5. Only *resolved* loads automatically. Everything else opens Match Details.

Everything runs on your machine. The library index is never uploaded anywhere.

## 5. Confidence scoring

**ISRC model** (both sides share an ISRC):

| Signal | Points |
|---|---|
| ISRC exact | +70 |
| Artist exact / partial / differs | +10 / +6 / −10 |
| Title exact / ≥ 85 % / differs | +10 / +6 / −10 |
| Duration < 2 s / < 5 s / < 15 s / unknown / ≥ 15 s | +10 / +7 / +3 / +5 / −15 |
| Version conflict | −25 |

**Metadata model** (no shared ISRC):

| Signal | Points |
|---|---|
| Title exact / ≥ 90 % / ≥ 80 % | +35 / +28 / +18 |
| Artist exact / primary artist / partial | +25 / +18 / +10 |
| Duration < 2 s / < 5 s / < 15 s / unknown / ≥ 15 s | +20 / +15 / +8 / +6 / −20 |
| Version match or compatible / uncertain / conflict | +10 / +4 / −30 |
| Album match / unknown on one side | +10 / +5 |
| Different ISRC on both sides | −15 |

Caps: title similarity below 80 % caps the score at 40, and no artist overlap caps it at 50. Similarity is a Sørensen–Dice bigram score on normalised text.

Bands: **95–100** exact · **85–94** high · **70–84** possible · **< 70** never auto-loaded.

The duration tolerances (2/5/15 s), the auto-load threshold and the source order can be changed in Settings → Streaming → Smart Matching. Every candidate carries its `reasons[]`, which Match Details and Diagnostics show.

Test cases (`tests/matching.test.ts`, `tests/tags.test.ts`):
- ISRC exact scores ≥ 95.
- "Club Version" against an untagged local file scores ≥ 85, with the version flagged as unconfirmed.
- Radio edit against an extended mix with a length gap scores < 70.
- Same title by a different artist scores < 70.
- Version choice is driven by duration.
- Ambiguity triggers a prompt.
- A real WAV tagged with TSRC resolves by ISRC.

## 6. Provider adapter architecture

```ts
interface PlayableSource {
  id, name, remote
  capabilities(): { canPlay, canSeek, canPitchShift, canScratch, canLoop,
                    canAnalyseWaveform, canAnalyseBPM, canSetHotCues, canRecord }
  availability(): { available, reason?, docsUrl? }
  search(identity, signal?): Promise<SourceCandidate[]>
  exists(id), candidateFor(id)          // cache validation and manual overrides
}
```

- Local sources are searched synchronously, which keeps playlist views instant.
- Remote sources are awaited with an 8 s timeout, so a slow provider never blocks local matching or the UI.
- Capabilities travel with the candidate. The deck only loads a candidate whose `canPlay` is true, and the engine's source policy still refuses any Spotify or Apple Music audio.

## 7. Resolution caching and overrides

Mappings are stored in the SQLite table `track_resolutions` (browser mode uses localStorage):

```
key (metadataSource:trackId), metadata_source, metadata_track_id,
audio_source, audio_track_id, isrc, confidence, method (isrc|metadata|manual),
user_confirmed, resolved_at
```

- Confident automatic results are cached, and re-scored when reused.
- If the target file disappears, an automatic mapping is dropped. A user-confirmed one is kept for when the file returns, and falls through to fresh matching in the meantime.
- **Choose different match / Match to local track / Find in my library** save a user-confirmed mapping, which takes precedence from then on. **Clear saved match** removes it.
- **Resolve playlist** pre-resolves every track, providers included, and caches the confident ones before a set.

Every loaded deck track carries `resolvedFrom { metadataSource, metadataTrackId, requestedTitle, requestedArtist, isrc, audioSource, confidence, method }`, shown as a "via SPOTIFY · 96%" badge on the deck.

## 8. Provider capabilities and limitations (researched 27 Sep 2026)

| Source | Metadata / search | DJ playback in our engine | Status |
|---|---|---|---|
| **Local Library** | ✅ | ✅ everything | Implemented |
| **Spotify** | ✅ official Web API (dev mode: 5 users, Premium, search limit 10) | ❌ Developer Terms and policy prohibit mixing, altering or capturing | Metadata source only |
| **Apple Music** | ✅ Apple Music API (needs a MusicKit key) | ❌ DRM; DJ use is partner-only ("DJ with Apple Music") | Metadata source only |
| **Audius** | ✅ public REST API, no key, often no ISRC | ✅ Open Music License (recording disabled) | **Implemented**: browse, deck playback, Smart Match target |
| **Beatport** | ⛔ API v4 is partner-gated, with no public sign-up | ⛔ Beatport Streaming only in partner DJ apps | Adapter present, reports *unavailable* |
| **Beatsource** | ⛔ No public API | ⛔ Beatsource LINK only in partner DJ apps (rekordbox, Serato, djay, VirtualDJ…) | Adapter present, reports *unavailable* |
| **SoundCloud** | ⚠ API keys by application only (OAuth 2.1 + PKCE) | ⛔ DJ use (Go+ / DJ plans) only in partner apps | Adapter present, reports *unavailable* |

No provider functionality is faked. Unavailable adapters return no candidates, and Settings and Match Details show the reason with a link.

## 9. API and authentication requirements

- **Spotify:** your own app in the Developer Dashboard (Client ID, PKCE, redirect `http://127.0.0.1:43821/callback` on desktop and `http://127.0.0.1:5173/` for the web version). Scopes: `user-read-private playlist-read-private playlist-read-collaborative user-library-read`. All playlists are listed; for apps created under Spotify's 2026 rules, items are only returned for playlists you own or collaborate on (older apps get them all).
- **Apple Music:** Apple Developer Program membership, a MusicKit key (.p8), and Team ID + Key ID, which the app uses to sign an ES256 developer token. The user token comes from MusicKit JS sign-in.
- **Beatport / Beatsource / SoundCloud:** a partner agreement would be required for DJ playback. For SoundCloud metadata only, an approved API application.

## 10. Licensing and API issues requiring attention

1. **Never** extract, capture, decrypt or proxy Spotify or Apple Music audio. The engine enforces this with `canLoad` (source policy), independently of the UI.
2. Spotify development mode allows 5 users. Distributing Spotify features publicly needs Spotify's extended-quota review, and the app must follow its display and attribution rules (artwork unmodified, links back to Spotify, which the ↗ button provides).
3. A MusicKit developer token is tied to one Apple developer account. For a public release, sign tokens server-side rather than asking each user for a key.
4. The DJ streaming services all need business partnerships; apply before building their adapters out.
5. Privacy: matching is local. Only a provider's own search terms (artist and title) would ever be sent to that provider, never your library.

## Next steps

- **Phase 5:** Audius done (`src/providers/audius/AudiusSource.ts`). Next, any partner provider that grants access.
- **Universal Playlists:** a playlist of `TrackIdentity` references, each resolved at load time through the same resolver. The schema and resolver already support it.
- A match-review queue for "possible" results across a whole playlist.

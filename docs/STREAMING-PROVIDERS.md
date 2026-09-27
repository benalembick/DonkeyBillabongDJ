# Streaming / Music Providers

Every source is one of two kinds:

- **metadata / playlist source**: supplies what to play (discovery, playlists, ISRC);
- **playable audio source**: supplies audio the DJ engine may process.

The two are recorded separately for every deck track (`resolvedFrom`: metadata source vs audio source).

| Provider | Role | Status in app | Authentication | DJ playback | Notes |
|---|---|---|---|---|---|
| **Local Library** | Playable | Available | none | ✓ all features | Tags incl. ISRC read locally; SQLite index on this machine |
| **Audius** | Playable + browsable + Smart Match target | Available after an API test | none (`app_name`) | ✓ play/seek/cue/hot cues/tempo/EQ/filter/jog/scratch/mix; ✗ recording | See [AUDIUS-INTEGRATION.md](AUDIUS-INTEGRATION.md). Open Music License |
| **Spotify** | Metadata / playlists | Connect in Library → Spotify | OAuth PKCE (your own Client ID) | ✗ never | Terms prohibit mixing; used for Smart Matching only |
| **Apple Music** | Metadata / library | Connect in Library → Apple Music | MusicKit key + Apple ID | ✗ never | DRM; partner-only DJ use |
| **Beatport** | (Playable if partnered) | Partner access required | partner OAuth | ✗ | API v4 partner-gated |
| **Beatsource** | (Playable if partnered) | Partner access required | partner | ✗ | LINK only in partner DJ apps |
| **SoundCloud** | (Playable if partnered) | Partner access required | approved app, OAuth 2.1 | ✗ | DJ use limited to partner apps |

## Where it lives in the code

- Metadata providers: `src/providers/spotify`, `src/providers/apple`. Desktop sign-in adapters are in `electron/streaming`.
- Playable sources implement `PlayableSource` (`src/matching/sources.ts`): `LocalLibrarySource`, `AudiusSource` (`src/providers/audius`), and the partner-only adapters, which report themselves unavailable with the reason.
- Engine policy: `PROVIDER_CAPABILITIES` (`src/providers/MusicProvider.ts`) and `DJEngine.canLoad`. Spotify and Apple Music audio can never be loaded.
- Settings → Streaming shows the live status table, the Audius panel, and Smart Matching order and toggles.

## Adding a playable provider

1. Confirm its **terms** permit third-party playback *and* DJ processing, and document the clauses.
2. Implement a client with throttling, retry and caching (see `AudiusClient`), and keep any credentials out of the renderer (desktop: main process plus keychain).
3. Implement `PlayableSource` (`search`, `exists`, `candidateFor`, honest `availability()` and `capabilities()`).
4. Add a `TrackSource` id, `PROVIDER_CAPABILITIES` entry, and a `loadBytes` branch in `createApp.ts`.
5. Add it to `DEFAULT_ORDER` in `src/app/matching.ts`, a browser pane if it's browsable, and tests.

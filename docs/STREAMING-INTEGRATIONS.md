# Streaming Integrations

All streaming enters through `MusicProvider` (`src/providers/MusicProvider.ts`). Each provider declares `PlaybackCapabilities`. The engine and the recorder enforce them, and never assume a provider's audio may be mixed.

```ts
interface MusicProvider {
  authenticate(); search(q); getTrack(id); getPlaylist(id); getUserPlaylists(); getArtwork(t);
  getPlaybackCapabilities(): { canLoadIntoDeck; canPreviewExternally; canRecord; restriction? }
}
```

## Status (researched 27 Sep 2026; re-verify before Phase 5)

| | Local | Spotify | Apple Music |
|---|---|---|---|
| Browse / search / playlists / metadata / artwork | ✅ | ✅ via Web API, OAuth PKCE | ✅ via Apple Music API + MusicKit user token |
| Load into a deck (waveform, tempo, EQ, scratch, mix) | ✅ | ❌ | ❌ |
| Play at all | ✅ | ❌ in our app (the Web Playback SDK may not be mixed or overlapped) | ⚠ MusicKit's own player only (DRM; needs a Widevine-capable Electron build), never through our mixer |
| Record | ✅ | ❌ | ❌ |

### What restriction prevents DJ playback

**Spotify:**

- **Developer Terms** v10 (15 May 2025) prohibit modifying or altering the Spotify Platform and content, and enabling stream ripping or capture. Caching is limited to metadata, cover art and Spotify's own time-limited "Conditional Downloads".
- The **developer policy / compliance guidance** explicitly prohibits "DJ/Mixes: using Spotify's catalog to segue, mix, re-mix, or overlap any Spotify Content with any other audio content", as well as syncing recordings with other recordings.
- **Access limits since Feb/Mar 2026:** Development Mode requires Premium, allows one client ID with at most 5 users, and has a reduced endpoint set. Wider release requires extended-quota approval.
- Spotify's DJ integrations (rekordbox, Serato, djay since Sep 2025; VirtualDJ, Cross DJ, edjing since Sep 2026) are **private partner agreements**, not a public API.

**Apple Music:**

- Catalogue audio is DRM-protected, and MusicKit plays it only inside Apple's player (MusicKit JS uses EME/DRM), so no PCM is available to third-party DSP.
- "DJ with Apple Music" (March 2025: rekordbox, Serato, Engine DJ, djay) is a partner entitlement and cannot be obtained through public MusicKit.

We will not use unofficial stream extraction, DRM circumvention, scraping or cookie extraction. The only legitimate route to mixing is to apply to each service's DJ partner programme.

## Connecting your accounts (implemented)

Open **Library → MUSIC → Spotify / Apple Music**. Both need the desktop app. Credentials and tokens live only in the Electron main process, encrypted with the OS keychain (`electron/streaming/secureStore.ts`), and the renderer never sees them.

### Spotify Premium

1. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), choose **Create app**. Add the redirect URI **`http://127.0.0.1:43821/callback`** and tick **Web API**.
2. Paste the app's **Client ID** into Donkey Billabong DJ and choose **Save**, then **Connect Spotify account**. Your browser opens Spotify's sign-in page, and you approve read-only access.
3. How it works: Authorization Code + PKCE (no client secret), with a loopback redirect on 127.0.0.1:43821. Scopes: `user-read-private playlist-read-private playlist-read-collaborative user-library-read`.
4. Development-mode limits (since Feb/Mar 2026):
   - the app owner needs Premium;
   - at most 5 users, each added under *User Management*;
   - search returns at most 10 results per page (we fetch 3 pages);
   - playlist tracks are only returned for playlists you own or collaborate on, so other playlists show 🔒.

### Apple Music

1. Apple requires a **MusicKit key** from the Apple Developer Program. An Apple Music subscription alone cannot authorise third-party apps.
2. Create a key with *Media Services (MusicKit)*, then enter your **Team ID** and **Key ID** and choose the **.p8** file. The app signs an ES256 developer token locally, valid about 5 months. Alternatively, paste an existing developer token. The token is checked against the Apple Music catalogue before it is saved.
3. **Connect Apple Music account** opens `http://127.0.0.1:43822/apple-auth` in your browser. That page runs MusicKit JS; you sign in with your Apple ID and the page returns the Music User Token to the app. A per-session nonce protects this step.
4. What you can use afterwards: Library Songs, library playlists, and catalogue search in your storefront.

### Browser mode

The same Spotify and Apple Music clients (`src/providers/spotify`, `src/providers/apple`) also run in the browser version:

- **Spotify**: sign-in happens in a popup that redirects back to the web app. The popup passes the result to the main window (`handleOAuthPopup`), so decks keep playing. Register the web app's address as an extra redirect URI in your Spotify app, e.g. `http://127.0.0.1:5173/` for `npm run dev:web` or `https://your-site/` when hosted. Spotify rejects "localhost", so the dev server binds to 127.0.0.1.
- **Apple Music**: MusicKit JS is loaded into the page and `authorize()` shows Apple's sign-in. If you provide a .p8 key, the browser signs a developer token once and **discards the key**; only the token is kept.
- Tokens are kept in this browser's localStorage, whereas the desktop app uses the OS keychain. The UI says so.

### What you can do with connected services

- Browse playlists and liked or library songs, and search the catalogue (title, artist, album, duration, artwork).
- **Local matching:** each streaming track is matched against your local library by normalised title and artist. The match ignores "Remastered", "feat." and punctuation. Matched rows show ✓ with **→ A / → B** buttons, and dragging a matched row loads the **local file**. Your Spotify or Apple Music playlists therefore work as crates for music you own.
- Open a track in the service's own app (↗).
- Unmatched tracks show 🔒 *stream only*. Dropping one on a deck shows the provider's restriction message. `DJEngine` enforces this through a source policy, independently of the UI.

## UI rules (Phase 5)

- Spotify and Apple Music appear under **MUSIC** in the browser, with a source badge (SPOTIFY or APPLE MUSIC) on every row.
- Rows that are not loadable show a lock icon. Dragging one onto a deck shows the provider's `restriction` text instead of loading.
- Provider network errors are shown in the provider pane only. They never block local decks, since provider calls are async and isolated.
- Useful legitimate features: import a Spotify or Apple Music playlist as a **"find locally" playlist** that matches tracks in the local library by artist and title (ISRC where available).

## Adding a provider

1. Implement `MusicProvider` in `src/providers/<name>/`.
2. Add its `TrackSource` id and set `PROVIDER_CAPABILITIES[id]` honestly from its terms.
3. Store tokens in the OS keychain (Electron `safeStorage`), never in localStorage.
4. Keep every network call off the audio and controller paths: plain async functions with timeouts, and errors surfaced in the provider pane.
5. Document the provider's restrictions here, with a link to the clause.

/**
 * Streaming for browser mode: the same Spotify / Apple Music clients as the
 * desktop app, with localStorage and in-browser sign-in.
 *
 * Spotify sign-in opens a popup that redirects back to this web app; the popup
 * hands the result to the main window (see handleOAuthPopup) so decks keep
 * playing. Apple Music uses MusicKit JS directly in the page.
 */
import type { StreamingBridge } from "../../platform";
import { AppleMusicClient, loadMusicKit } from "../apple/AppleMusicClient";
import { SpotifyClient } from "../spotify/SpotifyClient";
import type { StreamingProviderId } from "../streamingTypes";
import { LocalStorageStore } from "../web";

const OAUTH_MESSAGE = "dbdj-oauth";

/** Spotify refuses "localhost" redirects; loopback must be 127.0.0.1. */
export function spotifyRedirectUri(loc: Location = location): string {
  const host = loc.hostname === "localhost" ? "127.0.0.1" : loc.hostname;
  return `${loc.protocol}//${host}${loc.port ? `:${loc.port}` : ""}${loc.pathname}`;
}

/**
 * Call before booting the app. If this window is the Spotify sign-in popup
 * returning with ?code/?error, pass the result to the opener and close.
 */
export function handleOAuthPopup(): boolean {
  const params = new URLSearchParams(location.search);
  const state = params.get("state") ?? "";
  if (!state.startsWith("dbdj-") || !(params.has("code") || params.has("error"))) return false;
  if (window.opener) {
    window.opener.postMessage({ type: OAUTH_MESSAGE, search: location.search }, location.origin);
    window.close();
  }
  document.body.textContent = "Sign-in complete — you can close this window.";
  return true;
}

function popupAuthorize(authUrl: string, state: string): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const popup = window.open(authUrl, "dbdj-signin", "width=520,height=760");
    if (!popup) {
      reject(new Error("The sign-in window was blocked — allow pop-ups for this site and try again."));
      return;
    }
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== OAUTH_MESSAGE) return;
      const params = new URLSearchParams(String(e.data.search));
      if (params.get("state") !== state) return;
      cleanup();
      resolve(params);
    };
    const poll = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("Sign-in window was closed before finishing."));
      }
    }, 500);
    window.addEventListener("message", onMessage);
  });
}

export function createBrowserStreaming(): StreamingBridge {
  const store = new LocalStorageStore();
  const onLocalhost = location.hostname === "localhost";
  const spotify = new SpotifyClient(
    store,
    { redirectUri: spotifyRedirectUri(), authorize: popupAuthorize },
    "Browser mode: your sign-in is kept in this browser's storage. The desktop app stores it in the OS keychain.",
  );
  const apple = new AppleMusicClient(
    store,
    {
      obtainUserToken: async (developerToken) => {
        const music = await loadMusicKit(developerToken);
        const token = await music.authorize();
        if (!token) throw new Error("Apple Music sign-in was cancelled.");
        return String(token);
      },
    },
    // Never keep a private key in browser storage: sign a token once and discard the key.
    { keepPrivateKey: false },
  );
  const clients = { spotify, "apple-music": apple };
  const guardLocalhost = (id: StreamingProviderId) => {
    if (!/^https?:$/.test(location.protocol)) {
      throw new Error("Streaming sign-in needs the web app served over http(s), e.g. npm run dev:web → http://127.0.0.1:5173.");
    }
    if (id === "spotify" && onLocalhost) {
      throw new Error(`Spotify doesn't allow "localhost" sign-ins. Open this app at ${spotifyRedirectUri()} instead.`);
    }
  };

  return {
    status: (id) => clients[id].status(),
    configure: async (id, cfg) => {
      await clients[id].configure(cfg as never);
      return clients[id].status();
    },
    connect: async (id) => {
      guardLocalhost(id);
      return clients[id].connect();
    },
    disconnect: async (id, forget) => {
      await clients[id].disconnect(forget);
      return clients[id].status();
    },
    playlists: (id) => clients[id].playlists(),
    playlistTracks: (id, pid) => clients[id].playlistTracks(pid),
    search: (id, q) => clients[id].search(q),
  };
}

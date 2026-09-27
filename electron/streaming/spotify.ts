/**
 * Desktop Spotify sign-in: the shared SpotifyClient with OS-keychain storage
 * and a loopback redirect (RFC 8252) opened in the system browser. Spotify
 * requires 127.0.0.1 (not "localhost") for loopback redirects.
 */
import { shell } from "electron";
import { SpotifyClient } from "../../src/providers/spotify/SpotifyClient";
import { htmlPage, startLoopback } from "./http";
import { secureStore } from "./secureStore";

export const SPOTIFY_PORT = 43821;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_PORT}/callback`;

export function createDesktopSpotify(): SpotifyClient {
  return new SpotifyClient(secureStore, {
    redirectUri: SPOTIFY_REDIRECT_URI,
    authorize: (authUrl) =>
      new Promise<URLSearchParams>((resolve, reject) => {
        let server: { close: () => void } | null = null;
        const timer = setTimeout(() => {
          server?.close();
          reject(new Error("Timed out waiting for Spotify sign-in."));
        }, 5 * 60_000);
        startLoopback(SPOTIFY_PORT, (_req, url, res) => {
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const ok = url.searchParams.has("code");
          res
            .writeHead(ok ? 200 : 400, { "content-type": "text/html" })
            .end(
              ok
                ? htmlPage("Spotify connected", "You can close this tab and return to Donkey Billabong DJ.")
                : htmlPage("Spotify sign-in failed", url.searchParams.get("error") ?? "Invalid response"),
            );
          clearTimeout(timer);
          server?.close();
          resolve(url.searchParams);
        })
          .then((s) => {
            server = s;
            return shell.openExternal(authUrl);
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      }),
  });
}

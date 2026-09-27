/**
 * Desktop Apple Music sign-in: the shared AppleMusicClient with OS-keychain
 * storage. MusicKit JS runs in the user's system browser on a loopback page,
 * which posts the Music User Token back to the app (guarded by a nonce).
 */
import { shell } from "electron";
import { AppleMusicClient } from "../../src/providers/apple/AppleMusicClient";
import { randomToken } from "../../src/providers/web";
import { readBody, startLoopback } from "./http";
import { secureStore } from "./secureStore";

export const APPLE_PORT = 43822;

export function createDesktopAppleMusic(): AppleMusicClient {
  return new AppleMusicClient(
    secureStore,
    {
      obtainUserToken: (developerToken) =>
        new Promise<string>((resolve, reject) => {
          const nonce = randomToken(16);
          let server: { close: () => void } | null = null;
          const timer = setTimeout(() => {
            server?.close();
            reject(new Error("Timed out waiting for Apple Music sign-in."));
          }, 5 * 60_000);
          startLoopback(APPLE_PORT, async (req, url, res) => {
            if (req.method === "GET" && url.pathname === "/apple-auth") {
              res.writeHead(200, { "content-type": "text/html" }).end(authPage(developerToken, nonce));
              return;
            }
            if (req.method === "POST" && url.pathname === "/apple-token") {
              const body = JSON.parse(await readBody(req)) as { nonce?: string; token?: string };
              if (body.nonce !== nonce || !body.token) {
                res.writeHead(400).end("bad request");
                return;
              }
              res.writeHead(200).end("ok");
              clearTimeout(timer);
              setTimeout(() => server?.close(), 500);
              resolve(body.token);
              return;
            }
            res.writeHead(404).end();
          })
            .then((s) => {
              server = s;
              return shell.openExternal(`http://127.0.0.1:${APPLE_PORT}/apple-auth`);
            })
            .catch((e) => {
              clearTimeout(timer);
              reject(e);
            });
        }),
    },
    { keepPrivateKey: true },
  );
}

/** Loopback page that runs MusicKit JS in the user's browser to obtain a Music User Token. */
function authPage(developerToken: string, nonce: string): string {
  const cfg = JSON.stringify({ developerToken, nonce }).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>Connect Apple Music</title>
<body style="font:16px system-ui;background:#0d0f12;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;text-align:center">
<h2>Connect Apple Music to Donkey Billabong DJ</h2>
<p id="msg">Loading MusicKit…</p>
<button id="go" disabled style="font-size:18px;padding:10px 20px;border-radius:8px">Sign in with Apple Music</button>
</div>
<script>
const CFG = ${cfg};
const msg = document.getElementById("msg"), go = document.getElementById("go");
document.addEventListener("musickitloaded", async () => {
  try {
    await MusicKit.configure({ developerToken: CFG.developerToken, app: { name: "Donkey Billabong DJ", build: "0.1.0" } });
    msg.textContent = "Ready. Sign in to allow read-only access to your Apple Music library and playlists.";
    go.disabled = false;
  } catch (e) { msg.textContent = "MusicKit failed to start: " + e; }
});
go.onclick = async () => {
  try {
    const token = await MusicKit.getInstance().authorize();
    const r = await fetch("/apple-token", { method: "POST", body: JSON.stringify({ nonce: CFG.nonce, token }) });
    msg.textContent = r.ok ? "Connected! You can close this tab and return to the app." : "The app did not accept the token.";
    go.remove();
  } catch (e) { msg.textContent = "Sign-in failed: " + e; }
};
</script>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>`;
}

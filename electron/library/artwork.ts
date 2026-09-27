/**
 * Embedded cover art cache. Pictures found in tags (ID3 APIC, MP4 covr, FLAC /
 * Vorbis PICTURE) are shrunk once to a 256 px JPEG and stored by content hash
 * in the app-data folder, so a whole album shares one file and the audio is
 * never parsed again for artwork. Served read-only to the renderer as
 * dbdj-art://img/<hash>. Audio files are never modified.
 */
import { app, nativeImage, protocol } from "electron";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const ART_SCHEME = "dbdj-art";
const HASH = /^[a-f0-9]{40}$/;
const SIZE = 256;

const dir = () => path.join(app.getPath("userData"), "artwork");

/** Must run before the app is ready. */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function handleArtProtocol(): void {
  protocol.handle(ART_SCHEME, async (req) => {
    const hash = new URL(req.url).pathname.replace(/^\/+/, "");
    if (!HASH.test(hash)) return new Response("bad request", { status: 400 });
    try {
      const data = await fs.readFile(path.join(dir(), `${hash}.jpg`));
      return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "max-age=31536000, immutable" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

const pending = new Map<string, Promise<string | null>>();

/** Store a picture (any format Chromium decodes) and return its cache id, or null if unusable. */
export function storeArtwork(data: Uint8Array): Promise<string | null> {
  const hash = createHash("sha1").update(data).digest("hex");
  let p = pending.get(hash);
  if (!p) {
    p = (async () => {
      const file = path.join(dir(), `${hash}.jpg`);
      try {
        await fs.access(file);
        return hash; // already cached (e.g. another track from the same album)
      } catch {
        /* not cached yet */
      }
      let img = nativeImage.createFromBuffer(Buffer.from(data));
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      if (Math.max(width, height) > SIZE) img = img.resize(width >= height ? { width: SIZE, quality: "good" } : { height: SIZE, quality: "good" });
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(file, img.toJPEG(85));
      return hash;
    })()
      .catch(() => null)
      .finally(() => pending.delete(hash));
    pending.set(hash, p);
  }
  return p;
}

export const artUrl = (hash: string) => `${ART_SCHEME}://img/${hash}`;

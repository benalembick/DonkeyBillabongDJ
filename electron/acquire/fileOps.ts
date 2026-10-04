/**
 * File operations for Spotify → Local (pure Node — no Electron imports, unit-tested).
 *
 *  - downloads go to <destination>/.dbdj-partial/<random>.part, are validated, then renamed
 *    into the destination folder; nothing half-written is ever imported
 *  - every path is resolved inside its root (no traversal), names are sanitised for
 *    Windows and macOS, and no shell is ever invoked
 *  - a file is only reported valid when it is non-empty, parses as audio and has a plausible duration
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseFile } from "music-metadata";
import type { AudioQuality } from "../../src/acquire/types";

export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".opus", ".aif", ".aiff"]);
/** Names browsers / converters use while a file is still being written. */
const PARTIAL_NAME = /\.(part|partial|crdownload|download|tmp|temp|!ut|opdownload)$|^~\$|^\./i;
export const PARTIAL_DIR = ".dbdj-partial";

export function isAudioPath(p: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase());
}

export function isPartialName(name: string): boolean {
  return PARTIAL_NAME.test(name);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file-name stem that is safe on Windows and macOS (no separators, reserved names or control chars). */
export function sanitizeFileName(stem: string, max = 150): string {
  let s = stem
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!s) s = "track";
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

/** Resolve `name` inside `root`; throws if the result would escape the root. */
export function safeJoin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  const rel = path.relative(base, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes the destination folder");
  return full;
}

export async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

/** Technical metadata of an audio file. Throws when the file isn't readable audio. */
export async function probeAudio(p: string): Promise<AudioQuality> {
  const st = await fs.stat(p);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size === 0) throw new Error("File is empty");
  const m = await parseFile(p, { duration: true, skipCovers: true });
  const f = m.format;
  const durationMs = f.duration && Number.isFinite(f.duration) ? Math.round(f.duration * 1000) : null;
  if (!durationMs) throw new Error("No audio duration found — the file may be damaged or not audio");
  return {
    codec: f.codec ?? null,
    container: f.container ?? null,
    bitrateKbps: f.bitrate ? Math.round(f.bitrate / 1000) : null,
    sampleRate: f.sampleRate ?? null,
    channels: f.numberOfChannels ?? null,
    lossless: typeof f.lossless === "boolean" ? f.lossless : null,
    durationMs,
    sizeBytes: st.size,
  };
}

/**
 * Wait until a file stops changing: same size and mtime over `checks` consecutive polls,
 * non-empty, and openable for reading (Windows refuses while another process writes it).
 */
export async function waitForStable(p: string, o: { intervalMs?: number; checks?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ size: number; mtimeMs: number }> {
  const interval = o.intervalMs ?? 1000;
  const need = o.checks ?? 2;
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  let last = "";
  let same = 0;
  while (Date.now() < deadline) {
    if (o.signal?.aborted) throw new Error("Cancelled");
    try {
      const st = await fs.stat(p);
      const sig = `${st.size}:${st.mtimeMs}`;
      if (st.size > 0 && sig === last) {
        same++;
        if (same >= need) {
          const fh = await fs.open(p, "r");
          await fh.close();
          return { size: st.size, mtimeMs: st.mtimeMs };
        }
      } else same = 0;
      last = sig;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error("File disappeared");
      same = 0; // EBUSY / EPERM while being written: keep waiting
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("File never finished writing");
}

const TYPE_EXT: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/aiff": ".aiff",
  "audio/x-aiff": ".aiff",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
};
const CONTAINER_EXT: Record<string, string> = { MPEG: ".mp3", WAVE: ".wav", FLAC: ".flac", AIFF: ".aiff", "AIFF-C": ".aiff", Ogg: ".ogg", "M4A/mp42": ".m4a", "M4A/isom": ".m4a", "MPEG-4": ".m4a" };

/** Extension from Content-Disposition / Content-Type, or null. */
export function extFromHeaders(contentType: string | null, disposition: string | null): string | null {
  const name = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] : undefined;
  if (name) {
    const ext = path.extname(decodeURIComponent(name)).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) return ext;
  }
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return (type && TYPE_EXT[type]) || null;
}

export function extFromContainer(container: string | null): string | null {
  if (!container) return null;
  return CONTAINER_EXT[container] ?? (/mp4|m4a/i.test(container) ? ".m4a" : null);
}

export interface FetchLike {
  (url: string, init: { signal?: AbortSignal; redirect?: "follow" }): Promise<{ ok: boolean; status: number; url: string; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }>;
}

/** Stream a URL to `dest` (overwritten), enforcing HTTPS, a size cap and a timeout. */
export async function downloadToFile(
  url: string,
  dest: string,
  o: { fetchImpl?: FetchLike; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; onProgress?: (received: number, total: number | null) => void },
): Promise<{ bytes: number; contentType: string | null; disposition: string | null }> {
  const max = o.maxBytes ?? 600 * 1024 * 1024;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("Download timed out")), o.timeoutMs ?? 10 * 60_000);
  const onAbort = () => ctl.abort(new Error("Cancelled"));
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const f = o.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.url.startsWith("https://")) throw new Error("Download was redirected to a non-HTTPS address");
    if (res.status === 429) throw new Error("Provider rate limit (429)");
    if (!res.ok || !res.body) throw new Error(res.status === 403 || res.status === 401 ? "The provider refused this download (not permitted)" : `Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || null;
    if (total && total > max) throw new Error(`File too large (${Math.round(total / 1048576)} MB)`);
    let received = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        received += chunk.byteLength;
        if (received > max) throw new Error("File too large");
        o.onProgress?.(received, total);
        c.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(dest));
    return { bytes: received, contentType: res.headers.get("content-type"), disposition: res.headers.get("content-disposition") };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Move a validated temp file into place as `<stem><ext>`. If a file with that name already
 * exists with identical content the temp file is discarded and the existing one reused
 * (idempotent retries); a different file with the same name gets a " (2)" suffix.
 */
export async function finalizeFile(tmp: string, destDir: string, stem: string, ext: string): Promise<{ path: string; reused: boolean }> {
  const safeStem = sanitizeFileName(stem);
  const tmpHash = await sha256File(tmp);
  for (let n = 1; n < 100; n++) {
    const target = safeJoin(destDir, `${safeStem}${n > 1 ? ` (${n})` : ""}${ext}`);
    let exists = true;
    try {
      await fs.access(target);
    } catch {
      exists = false;
    }
    if (exists) {
      if ((await sha256File(target).catch(() => "")) === tmpHash) {
        await fs.rm(tmp, { force: true });
        return { path: target, reused: true };
      }
      continue;
    }
    await fs.rename(tmp, target);
    return { path: target, reused: false };
  }
  throw new Error("Too many files with the same name");
}

export function tempPath(destDir: string): string {
  return safeJoin(destDir, PARTIAL_DIR, `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.part`);
}

/** Remove leftovers of interrupted downloads (startup / before a new batch). */
export async function cleanPartials(destDir: string): Promise<number> {
  const dir = safeJoin(destDir, PARTIAL_DIR);
  let n = 0;
  // Older builds let spotDL strip the dot and write into "dbdj-partial": remove its spotDL temp folders.
  const legacy = safeJoin(destDir, PARTIAL_DIR.slice(1));
  const legacyEntries = await fs.readdir(legacy).catch(() => null);
  if (legacyEntries && legacyEntries.every((name) => name.endsWith("-spotdl"))) {
    await fs.rm(legacy, { recursive: true, force: true }).catch(() => undefined);
    n += legacyEntries.length;
  }
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".part") && !name.endsWith("-spotdl")) continue;
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    n++;
  }
  return n;
}

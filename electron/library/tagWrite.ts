/**
 * Writes title/artist/album/genre/year back into a local audio file itself, so
 * a rename made here shows up the same way in any other player or tag editor.
 *
 * MP3/WAV go through node-id3 (id3Riff.ts), the same way cueTags.ts does: read
 * the full existing tag, merge in the requested fields, and write back a
 * complete, explicit tag object so other frames — including this app's own
 * embedded hot cues — survive untouched.
 *
 * Every other supported container (FLAC, M4A/AAC/MP4, OGG/Opus, AIFF) has no
 * such frame at stake, so those go through a lossless ffmpeg remux (-c copy)
 * into a temp file, verified against the original's duration, then swapped
 * in — the same safety pattern electron/acquire/converter.ts uses.
 *
 * Vorbis-comment containers (OGG/Opus) only pick up metadata set at the
 * per-stream level, not the global level ffmpeg also exposes — both are set
 * here since the other containers want the global one. AIFF's muxer needs
 * -write_id3v2 to carry anything beyond a title at all; passing it for every
 * format is harmless (unsupporting muxers just ignore it).
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { TagPatch } from "../../src/library/tags";
import { probeAudio } from "../acquire/fileOps";
import { artUrl, storeArtwork } from "./artwork";
import { id3Container, readId3Tags, withoutRaw, writeId3Tags } from "./id3Riff";

const FFMPEG_EXTENSIONS = new Set([".flac", ".m4a", ".aac", ".mp4", ".ogg", ".opus", ".aif", ".aiff"]);

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
};

function mimeForImage(p: string): string {
  return IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "image/jpeg";
}

function clamp(s: string, max: number): string {
  return s.trim().slice(0, max);
}

/** Normalises + validates a patch (throws on an out-of-range year); drops untouched (undefined) fields. */
function sanitize(patch: TagPatch): TagPatch {
  const out: TagPatch = {};
  if (patch.title !== undefined) out.title = clamp(patch.title, 300);
  if (patch.artist !== undefined) out.artist = clamp(patch.artist, 300);
  if (patch.album !== undefined) out.album = clamp(patch.album, 300);
  if (patch.genre !== undefined) out.genre = clamp(patch.genre, 100);
  if (patch.year !== undefined) {
    if (patch.year !== null && (!Number.isInteger(patch.year) || patch.year < 1000 || patch.year > 9999)) {
      throw new Error("Year must be a 4-digit number.");
    }
    out.year = patch.year;
  }
  if (patch.artwork !== undefined) {
    if (patch.artwork !== null && (typeof patch.artwork.path !== "string" || !patch.artwork.path)) {
      throw new Error("Invalid artwork file.");
    }
    out.artwork = patch.artwork;
  }
  return out;
}

async function writeViaId3(filePath: string, kind: "mp3" | "wav", patch: TagPatch, image: { buffer: Buffer; mime: string } | null | undefined): Promise<void> {
  const existing = await readId3Tags(filePath, kind);
  const merged = withoutRaw({
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.artist !== undefined ? { artist: patch.artist } : {}),
    ...(patch.album !== undefined ? { album: patch.album } : {}),
    ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
    ...(patch.year !== undefined ? { year: patch.year == null ? "" : String(patch.year) } : {}),
  });
  if (image !== undefined) {
    if (image === null) delete merged.image;
    else merged.image = { mime: image.mime, type: { id: 3 }, description: "", imageBuffer: image.buffer };
  }
  await writeId3Tags(filePath, kind, merged);
}

function ffmpegMetadataArgs(patch: TagPatch): string[] {
  const pairs: [string, string][] = [];
  if (patch.title !== undefined) pairs.push(["title", patch.title]);
  if (patch.artist !== undefined) pairs.push(["artist", patch.artist]);
  if (patch.album !== undefined) pairs.push(["album", patch.album]);
  if (patch.genre !== undefined) pairs.push(["genre", patch.genre]);
  if (patch.year !== undefined) pairs.push(["date", patch.year == null ? "" : String(patch.year)]);
  const args: string[] = [];
  for (const [k, v] of pairs) args.push("-metadata", `${k}=${v}`, "-metadata:s:a:0", `${k}=${v}`);
  return args;
}

async function writeViaFfmpeg(filePath: string, patch: TagPatch, artworkPath: string | null | undefined): Promise<void> {
  if (typeof ffmpegPath !== "string" || !ffmpegPath) throw new Error("The bundled media tool is unavailable.");
  const dir = path.dirname(filePath), ext = path.extname(filePath);
  const temp = path.join(dir, `.${path.basename(filePath, ext)}.tagwrite.${Date.now().toString(36)}${ext}`);
  const before = await probeAudio(filePath);
  try {
    await new Promise<void>((resolve, reject) => {
      const hasNewArt = artworkPath !== undefined && artworkPath !== null;
      const clearArt = artworkPath === null;
      const args = ["-hide_banner", "-nostdin", "-y", "-i", filePath];
      if (hasNewArt) args.push("-i", artworkPath);
      if (clearArt) args.push("-map", "0:a");
      else if (hasNewArt) args.push("-map", "0:a", "-map", "1:0");
      else args.push("-map", "0");
      args.push("-c", "copy");
      if (hasNewArt) args.push("-c:v", "mjpeg", "-disposition:v", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
      args.push("-map_metadata", "0", "-write_id3v2", "1", ...ffmpegMetadataArgs(patch), temp);
      const child = spawn(ffmpegPath!, args, { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-4000); });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Tag writer exited with code ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`))));
    });
    const after = await probeAudio(temp);
    if (!after.durationMs || Math.abs(after.durationMs - (before.durationMs ?? after.durationMs)) > 2000) {
      throw new Error("Tag write verification failed: duration does not match the original file.");
    }
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * Writes the given fields into the file at `filePath`. A field left `undefined` in `patch` is
 * untouched; `null`/"" clears it. `patch.artwork` is `{ path }` (a picked image file) to replace
 * the embedded cover, `null` to remove it, or left out to leave it alone. On a change, the result
 * carries the new cached `artworkUrl` (or `null` once removed) so the caller can update its display
 * without re-reading the whole file.
 */
export async function writeTags(filePath: string, patch: TagPatch): Promise<{ ok: boolean; error?: string; artworkUrl?: string | null }> {
  try {
    const clean = sanitize(patch);
    if (Object.keys(clean).length === 0) return { ok: true };
    let image: { buffer: Buffer; mime: string } | null | undefined;
    let artworkUrl: string | null | undefined;
    if (clean.artwork !== undefined) {
      if (clean.artwork === null) {
        image = null;
        artworkUrl = null;
      } else {
        const buf = await fs.readFile(clean.artwork.path);
        const hash = await storeArtwork(buf);
        if (!hash) return { ok: false, error: "Unsupported or unreadable image file." };
        image = { buffer: buf, mime: mimeForImage(clean.artwork.path) };
        artworkUrl = artUrl(hash);
      }
    }
    const kind = id3Container(filePath);
    if (kind) {
      await writeViaId3(filePath, kind, clean, image);
    } else if (FFMPEG_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      await writeViaFfmpeg(filePath, clean, clean.artwork === undefined ? undefined : clean.artwork === null ? null : clean.artwork.path);
    } else {
      return { ok: false, error: "Editing tags isn't supported for this file type." };
    }
    return artworkUrl !== undefined ? { ok: true, artworkUrl } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

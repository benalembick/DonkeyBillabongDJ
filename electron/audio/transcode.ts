/**
 * macOS: converts audio Chromium can't decode (Apple Lossless, CAF…) to WAV with
 * the system's afconvert, which reads anything Core Audio can. The renderer only
 * asks after its own decoder has failed (WebAudioEngine.setDecodeFallback).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const AFCONVERT = "/usr/bin/afconvert";

/** File extension hint for afconvert from the container's magic bytes. */
function extensionFor(bytes: Uint8Array): string {
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (ascii(4, 4) === "ftyp") return ".m4a";
  if (ascii(0, 4) === "caff") return ".caf";
  if (ascii(0, 4) === "FORM") return ".aiff";
  if (ascii(0, 4) === "RIFF") return ".wav";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return ".mp3";
  return ".audio";
}

export async function transcodeToWav(input: Uint8Array): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-transcode-"));
  try {
    const src = path.join(dir, `in${extensionFor(input)}`);
    const dst = path.join(dir, "out.wav");
    await fs.writeFile(src, input);
    // 32-bit float keeps 24-bit sources exact; Chromium decodes float WAV.
    await new Promise<void>((resolve, reject) =>
      execFile(AFCONVERT, ["-f", "WAVE", "-d", "LEF32", src, dst], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await fs.readFile(dst);
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsc, promises as fs } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ConversionProgress, ConversionRequest, ConversionResult } from "../../src/acquire/types";
import { probeAudio, sanitizeFileName } from "./fileOps";

const running = new Map<string, ChildProcessWithoutNullStreams>();

export function converterAvailable(): boolean { return typeof ffmpegPath === "string" && ffmpegPath.length > 0; }
export function cancelConversion(id: string): void { running.get(id)?.kill(); }

async function availableOutput(destination: string, stem: string, extension: string): Promise<string> {
  for (let n = 0; n < 10_000; n++) {
    const candidate = path.join(destination, `${stem}${n ? ` (${n})` : ""}.${extension}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
  throw new Error("Could not choose an unused output filename.");
}

function argsFor(request: ConversionRequest, output: string): string[] {
  const metadata = ["-map_metadata", "0"];
  if (request.format === "mp3") return ["-map", "0:a:0", "-map", "0:v?", ...metadata, "-c:a", "libmp3lame", "-b:a", `${request.bitrateKbps ?? 320}k`, "-c:v", "copy", "-id3v2_version", "3", output];
  if (request.format === "flac") return ["-map", "0:a:0", "-map", "0:v?", ...metadata, "-c:a", "flac", "-compression_level", "5", "-c:v", "copy", output];
  if (request.format === "m4a") return ["-map", "0:a:0", "-map", "0:v?", ...metadata, "-c:a", "aac", "-b:a", `${request.bitrateKbps ?? 256}k`, "-c:v", "copy", "-movflags", "+faststart", output];
  return ["-map", "0:a:0", ...metadata, "-c:a", "pcm_s24le", output];
}

export async function convertFile(request: ConversionRequest, progress: (p: ConversionProgress) => void): Promise<ConversionResult> {
  if (!request.rightsConfirmed) throw new Error("Confirm that you have permission to convert this audio.");
  if (!/^convert_[a-z0-9_-]+$/i.test(request.id)) throw new Error("Invalid conversion id");
  if (!converterAvailable()) throw new Error("The bundled media converter is unavailable.");
  const input = path.resolve(request.input), destination = path.resolve(request.destination);
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error("The selected source is not a file.");
  await fs.access(destination, fsc.W_OK);
  const source = await probeAudio(input);
  const stem = sanitizeFileName(path.basename(input, path.extname(input)));
  const final = await availableOutput(destination, stem, request.format);
  const temp = path.join(destination, `.${stem}.${request.id}.part.${request.format}`);
  if (path.normalize(final).toLowerCase() === path.normalize(input).toLowerCase()) throw new Error("Choose a different output folder or format so the source is not overwritten.");
  progress({ id: request.id, state: "probing", progress: 0 });
  const started = Date.now();
  let stderr = "", outTimeMs = 0, wasCancelled = false;
  try {
    const child = spawn(ffmpegPath!, ["-hide_banner", "-nostdin", "-y", "-i", input, ...argsFor(request, temp), "-progress", "pipe:2", "-nostats"], { windowsHide: true });
    running.set(request.id, child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12_000);
      for (const line of chunk.split(/\r?\n/)) {
        const match = /^out_time_ms=(\d+)/.exec(line);
        if (match) {
          outTimeMs = Number(match[1]) / 1000;
          const ratio = source.durationMs ? Math.min(.99, outTimeMs / source.durationMs) : 0;
          const elapsed = Math.max(1, Date.now() - started);
          progress({ id: request.id, state: "converting", progress: ratio, speed: outTimeMs / elapsed });
        }
      }
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { wasCancelled = signal !== null; resolve(code); }); });
    running.delete(request.id);
    if (exitCode !== 0) throw new Error(exitCode === null ? "Conversion cancelled" : `Converter exited with code ${exitCode}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
    progress({ id: request.id, state: "verifying", progress: .99 });
    const quality = await probeAudio(temp);
    if (!quality.durationMs || Math.abs(quality.durationMs - (source.durationMs ?? quality.durationMs)) > 2000) throw new Error("Output verification failed: duration does not match the source.");
    await fs.rename(temp, final);
    const elapsedMs = Date.now() - started;
    const result = { id: request.id, path: final, name: path.basename(final), quality, elapsedMs, speed: source.durationMs ? source.durationMs / elapsedMs : null };
    progress({ id: request.id, state: "completed", progress: 1, speed: result.speed ?? undefined, output: final });
    return result;
  } catch (error) {
    const cancelled = wasCancelled || (error instanceof Error && /cancel/i.test(error.message));
    progress({ id: request.id, state: cancelled ? "cancelled" : "failed", progress: source.durationMs ? Math.min(.99, outTimeMs / source.durationMs) : 0, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    running.delete(request.id);
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

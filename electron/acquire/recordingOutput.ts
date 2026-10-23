import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export type RecordingOutputFormat = "mp3" | "wav";

export function recordingOutputFormat(filePath: string): RecordingOutputFormat {
  return path.extname(filePath).toLowerCase() === ".wav" ? "wav" : "mp3";
}

export async function prepareRecordingOutput(wavPath: string, directory: string, format: RecordingOutputFormat): Promise<string> {
  if (format === "wav") return wavPath;
  if (!ffmpegPath) throw new Error("The bundled MP3 encoder is unavailable.");
  const output = path.join(directory, "recording.mp3");
  const args = ["-hide_banner", "-nostdin", "-y", "-i", wavPath, "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3", output];
  let stderr = "";
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    throw new Error(`MP3 encoder exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
  return output;
}

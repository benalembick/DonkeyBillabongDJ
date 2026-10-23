import { BrowserWindow, desktopCapturer, dialog, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareRecordingOutput, recordingOutputFormat } from "./recordingOutput";
import { wavHeader } from "./wav";

const execFileAsync = promisify(execFile);
const MAX_PCM_BYTES = 2_000_000_000;

type NativeCapture = { start(pid: number, includeTree: boolean, callback: (chunk: Buffer) => void): void; stop(): void };
type ActiveRecording = { owner: number; capture: NativeCapture; fd: number; dir: string; file: string; bytes: number; error: Error | null; lastHeaderAt: number };
let active: ActiveRecording | null = null;

export function nativeRecordingActive(owner: WebContents): boolean { return active?.owner === owner.id; }

function addon(): { LoopbackCapture: new () => NativeCapture } {
  // External to the Electron bundle so its prebuilt N-API binary loads from node_modules.
  return require("loopback-capture") as { LoopbackCapture: new () => NativeCapture };
}

export function nativeRecorderAvailable(): boolean {
  if (process.platform !== "win32" || process.arch !== "x64") return false;
  try { return !!addon().LoopbackCapture; } catch { return false; }
}

async function vivaldiPid(sourceName: string): Promise<number> {
  if (!/\bVivaldi$/i.test(sourceName)) throw new Error("Choose a Vivaldi window and refresh the window list if needed.");
  const command = "Get-Process -Name vivaldi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10_000, maxBuffer: 128_000 });
  const parsed: unknown = JSON.parse(stdout || "[]");
  const windows = Array.isArray(parsed) ? parsed : [parsed];
  const candidates = windows.filter((item): item is { Id: number; MainWindowTitle: string } =>
    !!item && typeof item === "object" && typeof item.Id === "number" && typeof item.MainWindowTitle === "string");
  const exact = candidates.find((item) => item.MainWindowTitle === sourceName);
  if (exact) return exact.Id;
  if (candidates.length === 1) return candidates[0].Id;
  throw new Error("Could not identify that Vivaldi window. Refresh the list and try again.");
}

function updateHeader(recording: ActiveRecording): void {
  if (writeSync(recording.fd, wavHeader(recording.bytes), 0, 44, 0) !== 44) throw new Error("Could not finish the WAV header.");
  recording.lastHeaderAt = Date.now();
}

export async function startNativeRecording(owner: WebContents, sourceId: string): Promise<void> {
  if (!nativeRecorderAvailable()) throw new Error("Windows application audio capture is unavailable in this build.");
  if (active) throw new Error("An audio recording is already in progress.");
  const source = (await desktopCapturer.getSources({ types: ["window"] })).find((item) => item.id === sourceId);
  if (!source) throw new Error("That window is no longer available. Refresh the window list and try again.");
  const pid = await vivaldiPid(source.name);
  if (active) throw new Error("An audio recording is already in progress.");
  const dir = mkdtempSync(path.join(os.tmpdir(), "dbdj-recording-"));
  const file = path.join(dir, "recording.wav");
  let fd: number | null = null;
  try {
    fd = openSync(file, "wx");
    if (writeSync(fd, wavHeader(0), 0, 44, 0) !== 44) throw new Error("Could not start the WAV file.");
    const capture = new (addon().LoopbackCapture)();
    const recording: ActiveRecording = { owner: owner.id, capture, fd, dir, file, bytes: 0, error: null, lastHeaderAt: Date.now() };
    active = recording;
    capture.start(pid, true, (chunk) => {
      if (active !== recording || recording.error || !Buffer.isBuffer(chunk)) return;
      try {
        if (recording.bytes + chunk.length > MAX_PCM_BYTES) throw new Error("Recording exceeded the WAV size limit.");
        if (writeSync(recording.fd, chunk, 0, chunk.length, 44 + recording.bytes) !== chunk.length) throw new Error("Could not write all captured audio.");
        recording.bytes += chunk.length;
        if (Date.now() - recording.lastHeaderAt >= 1_000) updateHeader(recording);
      } catch (error) { recording.error = error instanceof Error ? error : new Error(String(error)); }
    });
  } catch (error) {
    if (active) {
      try { active.capture.stop(); } catch { /* Preserve the original start error. */ }
    }
    active = null;
    if (fd != null) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function stopNativeRecording(owner: WebContents): Promise<{ path: string; name: string } | null> {
  const recording = active;
  if (!recording || recording.owner !== owner.id) throw new Error("No recording is in progress for this window.");
  active = null;
  try { recording.capture.stop(); }
  catch (error) { recording.error = error instanceof Error ? error : new Error(String(error)); }
  try { updateHeader(recording); }
  catch (error) { throw new Error(`Could not finalize the recording. A recovery copy remains at ${recording.file}. ${String(error)}`); }
  finally { closeSync(recording.fd); }
  if (recording.error) {
    if (recording.bytes) throw new Error(`${recording.error.message} A recovery copy remains at ${recording.file}.`);
    rmSync(recording.dir, { recursive: true, force: true });
    throw recording.error;
  }
  if (!recording.bytes) {
    rmSync(recording.dir, { recursive: true, force: true });
    throw new Error("Vivaldi produced no audio samples. Keep audio playing and try again.");
  }
  const window = BrowserWindow.fromWebContents(owner);
  const options = {
    title: "Save Vivaldi audio recording",
    defaultPath: `Recording-${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`,
    filters: [
      { name: "MP3 audio", extensions: ["mp3"] },
      { name: "WAV audio", extensions: ["wav"] },
    ],
  };
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) {
    rmSync(recording.dir, { recursive: true, force: true });
    return null;
  }
  try {
    const output = await prepareRecordingOutput(recording.file, recording.dir, recordingOutputFormat(choice.filePath));
    await fs.copyFile(output, choice.filePath);
  }
  catch (error) { throw new Error(`Could not save the recording. A recovery copy remains at ${recording.file}. ${String(error)}`); }
  rmSync(recording.dir, { recursive: true, force: true });
  return { path: choice.filePath, name: path.basename(choice.filePath) };
}

export function stopNativeRecordingOnExit(): void {
  const recording = active;
  if (!recording) return;
  active = null;
  recording.capture.stop();
  try { updateHeader(recording); } finally { closeSync(recording.fd); }
  // Keep the temporary WAV for recovery if the application closes mid-recording.
}

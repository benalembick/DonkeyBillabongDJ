/**
 * spotDL adapter (https://github.com/spotDL/spotify-downloader), run as the user's own
 * installed command-line tool. spotDL reads the Spotify track's metadata, finds a matching
 * recording on YouTube / YouTube Music and downloads that audio — it is not the Spotify master,
 * so the version is checked afterwards by duration (and the user can review it).
 *
 * Runs without a shell (argument arrays only), inside a private temp folder; the result is
 * validated and moved by the caller like any other download. Pure Node: the process runner is
 * injectable for tests.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAudioPath } from "./fileOps";
import type { SourceTrack } from "../../src/acquire/types";

export interface ToolStatus {
  available: boolean;
  version?: string;
  reason?: string;
  setup?: string;
}

export interface Runner {
  /** Run to completion (short commands such as --version). */
  run(cmd: string, args: string[], o: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Start a long-running process. */
  start(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
}

export const nodeRunner: Runner = {
  run: (cmd, args, o) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: o.timeoutMs, env: o.env, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((err as { code: number }).code) : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
      });
    }),
  start: (cmd, args, o) => spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
};

const SPOTIFY_TRACK = /^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})$/;
const SPOTIFY_PLAYLIST = /^https:\/\/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})$/;

/** The fields of a spotDL "save" entry that the app uses (spotDL's Song object). */
export interface SpotdlSong {
  name?: string;
  artists?: string[];
  artist?: string;
  album_name?: string;
  /** Seconds. */
  duration?: number;
  isrc?: string | null;
  song_id?: string;
  url?: string;
  explicit?: boolean;
  cover_url?: string | null;
  date?: string | null;
  list_position?: number | null;
}

/** spotDL's saved song → Spotify source metadata (missing fields stay null). */
export function spotdlSongToSource(s: SpotdlSong): SourceTrack {
  const id = typeof s.song_id === "string" && /^[A-Za-z0-9]{22}$/.test(s.song_id) ? s.song_id : null;
  const artists = Array.isArray(s.artists) && s.artists.length ? s.artists.map(String) : s.artist ? [String(s.artist)] : [];
  return {
    id,
    uri: id ? `spotify:track:${id}` : null,
    title: String(s.name ?? ""),
    artists,
    album: String(s.album_name ?? ""),
    durationMs: typeof s.duration === "number" && s.duration > 0 ? Math.round(s.duration * 1000) : null,
    explicit: typeof s.explicit === "boolean" ? s.explicit : null,
    isrc: typeof s.isrc === "string" && s.isrc ? s.isrc : null,
    url: id ? `https://open.spotify.com/track/${id}` : null,
  };
}

/** Packaged macOS apps get a minimal PATH; add the usual pip / Homebrew locations. */
export async function toolEnv(base: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): Promise<NodeJS.ProcessEnv> {
  const extra: string[] = [];
  if (platform === "darwin" || platform === "linux") {
    extra.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"));
    const pyBase = path.join(home, "Library", "Python");
    for (const v of await fs.readdir(pyBase).catch(() => [] as string[])) extra.push(path.join(pyBase, v, "bin"));
  } else if (platform === "win32") {
    const appData = base.APPDATA ?? path.join(home, "AppData", "Roaming");
    const local = base.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    for (const root of [path.join(appData, "Python"), path.join(local, "Programs", "Python")]) {
      for (const v of await fs.readdir(root).catch(() => [] as string[])) extra.push(path.join(root, v, "Scripts"), path.join(root, v));
    }
  }
  // spotDL's own FFmpeg (spotdl --download-ffmpeg) lives here.
  extra.push(path.join(home, ".spotdl"));
  const key = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  return { ...base, [key]: [base[key] ?? "", ...extra].filter(Boolean).join(sep), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
}

/** Ways spotDL may be installed, in the order tried. */
function launchers(platform: string): { cmd: string; pre: string[] }[] {
  const l = [{ cmd: "spotdl", pre: [] as string[] }];
  if (platform === "win32") l.push({ cmd: "py", pre: ["-m", "spotdl"] }, { cmd: "python", pre: ["-m", "spotdl"] });
  else l.push({ cmd: "python3", pre: ["-m", "spotdl"] });
  return l;
}

export class SpotDL {
  private launcher: { cmd: string; pre: string[] } | null = null;
  private status: ToolStatus | null = null;

  constructor(private runner: Runner = nodeRunner, private platform = process.platform, private home = os.homedir()) {}

  async check(force = false): Promise<ToolStatus> {
    if (this.status && !force) return this.status;
    const env = await toolEnv(process.env, this.platform, this.home);
    let found: { cmd: string; pre: string[]; version: string } | null = null;
    for (const l of launchers(this.platform)) {
      // Python start-up (and antivirus scanning it) can take a while, especially while downloads run.
      const r = await this.runner.run(l.cmd, [...l.pre, "--version"], { timeoutMs: 45_000, env }).catch(() => null);
      const version = r && r.code === 0 ? (r.stdout || r.stderr).trim().split(/\s+/).pop() : undefined;
      if (version) {
        found = { ...l, version };
        break;
      }
    }
    if (!found) {
      this.launcher = null;
      return (this.status = {
        available: false,
        reason: "spotDL isn't installed (or isn't on PATH).",
        setup: this.platform === "win32" ? "Install Python 3, then in a terminal run: pip install spotdl  and then: spotdl --download-ffmpeg" : "Install Python 3, then run: pip3 install spotdl  and then: spotdl --download-ffmpeg",
      });
    }
    const ffmpegName = this.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const bundled = await fs.access(path.join(this.home, ".spotdl", ffmpegName)).then(() => true, () => false);
    const onPath = bundled || (await this.runner.run("ffmpeg", ["-version"], { timeoutMs: 30_000, env }).then((r) => r.code === 0, () => false));
    if (!onPath) {
      this.launcher = null;
      return (this.status = { available: false, version: found.version, reason: `spotDL ${found.version} found, but FFmpeg is missing.`, setup: "Run: spotdl --download-ffmpeg" });
    }
    this.launcher = { cmd: found.cmd, pre: found.pre };
    return (this.status = { available: true, version: found.version });
  }

  /**
   * Download one Spotify track's YouTube-matched audio into `workDir` (created, private).
   * Returns the produced audio file. Keeps YouTube's audio stream without re-encoding where
   * spotDL allows it (opus, bitrate "disable").
   */
  async download(url: string, workDir: string, o: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<string> {
    if (!SPOTIFY_TRACK.test(url)) throw new Error("spotDL: only open.spotify.com track links are accepted");
    if (!this.launcher) {
      const s = await this.check(true);
      if (!s.available) throw new Error(`${s.reason} ${s.setup ?? ""}`.trim());
    }
    await fs.mkdir(workDir, { recursive: true });
    // A relative template (spotDL runs inside workDir): spotDL sanitises its output template, and a
    // Windows drive path ("C:\…") would be rewritten into nested folders it then saves into.
    const base = ["download", url, "--output", "{artists} - {title}.{output-ext}", "--format", "opus", "--threads", "1"];
    try {
      return await this.runOnce([...base, "--bitrate", "disable", "--print-errors"], workDir, o);
    } catch (err) {
      // Older spotDL versions don't know these optional flags: retry with its defaults.
      if (/unrecognized arguments|invalid choice/i.test(String(err))) return this.runOnce(base, workDir, o);
      throw err;
    }
  }

  /**
   * Read a playlist's track list with spotDL's own Spotify access (`spotdl save`, metadata only —
   * nothing is downloaded). Used when Spotify won't return a playlist's tracks to this app.
   */
  async readPlaylist(url: string, workDir: string, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SpotdlSong[]> {
    if (!SPOTIFY_PLAYLIST.test(url)) throw new Error("spotDL: only open.spotify.com playlist links are accepted");
    if (!this.launcher) {
      const s = await this.check(true);
      if (!s.available) throw new Error(`${s.reason} ${s.setup ?? ""}`.trim());
    }
    await fs.mkdir(workDir, { recursive: true });
    const l = this.launcher!;
    const env = await toolEnv(process.env, this.platform, this.home);
    const child = this.runner.start(l.cmd, [...l.pre, "save", url, "--save-file", "songs.spotdl"], { cwd: workDir, env });
    const tail: string[] = [];
    const onData = (b: Buffer) => {
      for (const line of b.toString("utf8").split(/\r?\n|\r/)) if (line.trim()) tail.push(line.trim());
      if (tail.length > 30) tail.splice(0, tail.length - 30);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const kill = () => killTree(child, this.platform);
    const timer = setTimeout(kill, o.timeoutMs ?? 15 * 60_000);
    o.signal?.addEventListener("abort", kill, { once: true });
    const code = await new Promise<number>((resolve) => {
      child.on("error", (e) => {
        tail.push(String(e.message));
        resolve(-1);
      });
      child.on("close", (c) => resolve(c ?? -1));
    });
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", kill);
    if (o.signal?.aborted) throw new Error("Cancelled");
    const raw = await fs.readFile(path.join(workDir, "songs.spotdl"), "utf8").catch(() => null);
    if (!raw) throw new Error(`spotDL couldn't read this playlist${explain(tail, code)}`);
    const songs = JSON.parse(raw) as SpotdlSong[];
    if (!Array.isArray(songs)) throw new Error("spotDL returned an unexpected playlist format");
    return songs.sort((a, b) => (a.list_position ?? 0) - (b.list_position ?? 0));
  }

  private async runOnce(args: string[], workDir: string, o: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void }): Promise<string> {
    const l = this.launcher!;
    const env = await toolEnv(process.env, this.platform, this.home);
    const child = this.runner.start(l.cmd, [...l.pre, ...args], { cwd: workDir, env });
    const tail: string[] = [];
    const onData = (b: Buffer) => {
      for (const line of b.toString("utf8").split(/\r?\n|\r/)) {
        const t = line.trim();
        if (!t) continue;
        tail.push(t);
        if (tail.length > 30) tail.shift();
        o.onLine?.(t);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const kill = () => killTree(child, this.platform);
    const timer = setTimeout(kill, o.timeoutMs ?? 10 * 60_000);
    o.signal?.addEventListener("abort", kill, { once: true });
    const code = await new Promise<number>((resolve) => {
      child.on("error", (e) => {
        tail.push(String(e.message));
        resolve(-1);
      });
      child.on("close", (c) => resolve(c ?? -1));
    });
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", kill);
    if (o.signal?.aborted) throw new Error("Cancelled");
    // Look everywhere under workDir: whatever spotDL produced is validated by the caller anyway.
    const files = (await audioFiles(workDir)).sort((a, b) => b.size - a.size);
    if (!files.length) throw new Error(`spotDL couldn't download this track${explain(tail, code)}`);
    return files[0].p;
  }
}

/** Audio files anywhere under `dir` (a few levels deep). */
async function audioFiles(dir: string, depth = 0): Promise<{ p: string; size: number }[]> {
  if (depth > 8) return [];
  const out: { p: string; size: number }[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await audioFiles(p, depth + 1)));
    else if (e.isFile() && isAudioPath(p)) out.push({ p, size: (await fs.stat(p)).size });
  }
  return out;
}

/** spotDL's error, without its progress-bar lines. */
export function explain(tail: string[], code: number): string {
  const lines = tail.filter((t) => !/^-+$|\d+%|-{4,}|^\d+:\d\d|^(Done|Error|Processing|Skipping)\b/i.test(t));
  const errors = lines.filter((t) => /error|could not|no results|failed|not found|unrecognized|lookup|rate limit|sign in|unavailable|forbidden|http/i.test(t));
  const pick = (errors.length ? errors : lines).slice(-3).map((t) => t.replace(/\s{2,}/g, " "));
  if (pick.some((t) => /yt-dlp|AudioProviderError/i.test(t))) {
    pick.push("YouTube refused or changed — update with: pip install -U spotdl yt-dlp (and install Deno, which spotDL recommends for YouTube)");
  }
  return pick.length ? `: ${pick.join(" · ")}` : code ? ` (exit code ${code})` : "";
}

function killTree(child: ChildProcess, platform: string): void {
  if (child.exitCode !== null || !child.pid) return;
  // spotDL starts FFmpeg children; end the whole tree.
  if (platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  else child.kill("SIGTERM");
}

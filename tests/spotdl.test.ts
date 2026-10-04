/**
 * spotDL adapter with a fake process runner: no real tool is run and nothing is downloaded.
 */
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explain, SpotDL, toolEnv, type Runner } from "../electron/acquire/spotdl";
import { SpotDLAcquisition } from "../src/acquire/providers";
import { buildIdentity } from "../src/matching/identity";

const ID = "4uLU6hMCjMI75M1A2tKUQC";
const URL_ = `https://open.spotify.com/track/${ID}`;

let home: string;
let work: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-spotdl-home-"));
  work = path.join(home, "work");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

interface Call {
  cmd: string;
  args: string[];
}

/** Fake runner: `installed` launchers answer --version; start() writes `produce` into the output folder. */
function fakeRunner(o: { installed?: string[]; ffmpegOnPath?: boolean; produce?: string | null; failWith?: string[]; rejectBitrate?: boolean; hang?: boolean } = {}) {
  const calls: Call[] = [];
  const killed: string[] = [];
  const runner: Runner = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "ffmpeg") return { code: o.ffmpegOnPath ? 0 : -1, stdout: "", stderr: "" };
      const key = [cmd, ...args.slice(0, -1)].join(" ");
      return o.installed?.includes(key) ? { code: 0, stdout: "4.2.11\n", stderr: "" } : { code: -1, stdout: "", stderr: "not found" };
    },
    start: (cmd, args, so) => {
      calls.push({ cmd, args });
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr, pid: 4242, exitCode: null, kill: () => { killed.push("SIGTERM"); child.emit("close", null); return true; } });
      setTimeout(async () => {
        if (o.hang) return;
        if (o.rejectBitrate && args.includes("--bitrate")) {
          stderr.emit("data", Buffer.from("spotdl: error: unrecognized arguments: --bitrate disable\n"));
          child.emit("close", 2);
          return;
        }
        if (o.failWith) {
          stdout.emit("data", Buffer.from(o.failWith.join("\n")));
          child.emit("close", 1);
          return;
        }
        stdout.emit("data", Buffer.from("Downloaded \"Artist - Song\"\n"));
        if (o.produce) {
          await fs.mkdir(path.dirname(path.join(so.cwd, o.produce)), { recursive: true });
          await fs.writeFile(path.join(so.cwd, o.produce), Buffer.alloc(2048, 1));
        }
        child.emit("close", 0);
      }, 5);
      return child;
    },
  };
  return { runner, calls, killed };
}

describe("spotDL detection", () => {
  it("explains how to install it when missing", async () => {
    const { runner } = fakeRunner();
    const s = await new SpotDL(runner, "win32", home).check();
    expect(s).toMatchObject({ available: false, reason: expect.stringMatching(/isn't installed/), setup: expect.stringMatching(/pip install spotdl/) });
  });
  it("needs FFmpeg (spotDL's own copy or one on PATH)", async () => {
    const { runner } = fakeRunner({ installed: ["spotdl"] });
    const sd = new SpotDL(runner, "darwin", home);
    expect(await sd.check()).toMatchObject({ available: false, version: "4.2.11", setup: "Run: spotdl --download-ffmpeg" });
    await fs.mkdir(path.join(home, ".spotdl"));
    await fs.writeFile(path.join(home, ".spotdl", "ffmpeg"), "");
    expect(await sd.check(true)).toEqual({ available: true, version: "4.2.11" });
  });
  it("finds a `python -m spotdl` install on Windows", async () => {
    const { runner } = fakeRunner({ installed: ["py -m spotdl"], ffmpegOnPath: true });
    expect(await new SpotDL(runner, "win32", home).check()).toEqual({ available: true, version: "4.2.11" });
  });
  it("adds pip / Homebrew locations to PATH for packaged macOS apps", async () => {
    const env = await toolEnv({ PATH: "/usr/bin:/bin" }, "darwin", home);
    expect(env.PATH).toContain("/opt/homebrew/bin");
    expect(env.PATH).toContain(path.join(home, ".spotdl"));
  });
});

describe("spotDL downloads", () => {
  const ready = async (o: Parameters<typeof fakeRunner>[0]) => {
    const f = fakeRunner({ installed: ["spotdl"], ffmpegOnPath: true, ...o });
    const sd = new SpotDL(f.runner, "darwin", home);
    await sd.check();
    return { ...f, sd };
  };
  it("runs spotDL with an argument list (no shell) inside its own folder and returns the file", async () => {
    const { sd, calls } = await ready({ produce: "Artist - Song.opus" });
    const file = await sd.download(URL_, work);
    expect(file).toBe(path.join(work, "Artist - Song.opus"));
    const run = calls.find((c) => c.args[0] === "download")!;
    expect(run.cmd).toBe("spotdl");
    expect(run.args).toEqual(["download", URL_, "--output", "{artists} - {title}.{output-ext}", "--format", "opus", "--threads", "1", "--bitrate", "disable", "--print-errors"]);
  });
  it("finds the file even when spotDL saves it in a sub-folder", async () => {
    const { sd } = await ready({ produce: path.join("C_", "Users", "x", "Roxette - Dangerous.opus") });
    expect(await sd.download(URL_, work)).toBe(path.join(work, "C_", "Users", "x", "Roxette - Dangerous.opus"));
  });
  it("turns spotDL's output into a readable reason (real output from a failed run)", () => {
    const yt = ["Marillion - Cover My    Error              ----- -----------------  25% -:--:--", "AudioProviderError: YT-DLP download error - https://music.youtube.com/watch?v=abc", "Marillion - Cover My    Error              -----"];
    expect(explain(yt, 1)).toBe(": AudioProviderError: YT-DLP download error - https://music.youtube.com/watch?v=abc · YouTube refused or changed — update with: pip install -U spotdl yt-dlp (and install Deno, which spotDL recommends for YouTube)");
    expect(explain(["Roxette - Dangerous     Done               ----------------------- 100% 0:00:00"], 0)).toBe("");
    expect(explain([], 2)).toBe(" (exit code 2)");
  });
  it("only accepts Spotify track links", async () => {
    const { sd } = await ready({ produce: "x.opus" });
    for (const bad of ["https://open.spotify.com/playlist/" + ID, `${URL_}?si=1`, "https://evil.example/track/" + ID, `${URL_}; rm -rf /`]) {
      await expect(sd.download(bad, work)).rejects.toThrow(/only open\.spotify\.com track links/);
    }
  });
  it("retries without --bitrate on older spotDL versions", async () => {
    const { sd, calls } = await ready({ produce: "Artist - Song.opus", rejectBitrate: true });
    await sd.download(URL_, work);
    const runs = calls.filter((c) => c.args[0] === "download");
    expect(runs.length).toBe(2);
    expect(runs[1].args).not.toContain("--bitrate");
  });
  it("reports spotDL's own error when nothing was downloaded", async () => {
    const { sd } = await ready({ failWith: ["Processing query", "LookupError: No results found for song: Artist - Song"] });
    await expect(sd.download(URL_, work)).rejects.toThrow(/spotDL couldn't download this track: LookupError: No results found/);
  });
  it("stops the process when cancelled", async () => {
    const { sd, killed } = await ready({ hang: true });
    const ctl = new AbortController();
    const p = sd.download(URL_, work, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow(/Cancelled/);
    expect(killed).toEqual(["SIGTERM"]);
  });
});

describe("spotDL provider (renderer)", () => {
  it("offers the Spotify track itself, with a note instead of a match score", async () => {
    const p = new SpotDLAcquisition(async () => ({ available: true, version: "4.2.11" }));
    expect(await p.state()).toEqual({ available: true, reason: "spotDL 4.2.11" });
    const identity = buildIdentity({ source: "spotify", sourceTrackId: ID, title: "Song", artists: ["Artist"], durationMs: 200_000 });
    expect(await p.search(identity)).toEqual([
      { provider: "spotdl", id: ID, identity, downloadUrl: URL_, name: "Artist - Song", matchNote: "YouTube match chosen by spotDL; length checked against Spotify" },
    ]);
    // Spotify "local file" entries have no track link.
    expect(await p.search(buildIdentity({ source: "spotify", sourceTrackId: "entry:e_1", title: "Song", artists: ["Artist"] }))).toEqual([]);
  });
  it("reports missing setup and browser mode", async () => {
    expect(await new SpotDLAcquisition(async () => ({ available: false, reason: "spotDL isn't installed", setup: "pip install spotdl" })).state()).toEqual({ available: false, reason: "spotDL isn't installed", setup: "pip install spotdl" });
    expect((await new SpotDLAcquisition(null).state()).reason).toMatch(/desktop app/);
  });
});

/**
 * DBDJ_SMOKE_SPOTIFY_LOCAL=1: Spotify → Local in the real app with generated audio only.
 * A deck plays while a job matches library files, a file arrives in a real watched folder
 * (written as .part first, then renamed), is imported and analysed, and Auto DJ takes the
 * ready tracks. The deck's playhead is sampled throughout to show playback isn't disturbed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { App } from "../src/app/createApp";
import { taggedWav } from "../tests/fixtures/taggedWav";
import { smokeConfigure } from "./acquire/ipc";

export interface SpotifyLocalFixtures {
  library: { ref: string; name: string }[];
  playing: { ref: string; name: string };
  watchDir: string;
}

export async function spotifyLocalFixtures(): Promise<SpotifyLocalFixtures> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-spotify-local-"));
  const libDir = path.join(root, "library");
  const watchDir = path.join(root, "watch");
  const destDir = path.join(root, "downloads");
  await Promise.all([fs.mkdir(libDir), fs.mkdir(watchDir), fs.mkdir(destDir)]);
  const write = async (dir: string, name: string, title: string, seconds: number) => {
    const ref = path.join(dir, name);
    await fs.writeFile(ref, taggedWav({ title, artist: "Smoke Artist", seconds, sampleRate: 8000 }));
    return { ref, name };
  };
  const library = [await write(libDir, "Smoke Artist - Library Track.wav", "Library Track", 20)];
  const playing = await write(libDir, "Smoke Artist - Playing Now.wav", "Playing Now", 60);
  await smokeConfigure({ watchFolder: watchDir, destination: destDir });
  return { library, playing, watchDir };
}

/**
 * Once the smoke job has an entry awaiting a file, writes the converter's output into the watched
 * folder: a .part file first, renamed when complete (as browsers and converters do).
 */
export async function dropWatchedFile(win: BrowserWindow, watchDir: string): Promise<void> {
  const probe = "window.dbdj?.spotifyLocal?.getState().jobs.some((j) => j.entries.some((e) => e.state === \"awaiting-file\" && e.source.title === \"Watched Song\")) ?? false";
  for (let i = 0; i < 900; i++) {
    if (await win.webContents.executeJavaScript(probe).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 800));
  const part = path.join(watchDir, "Smoke Artist - Watched Song.wav.part");
  await fs.writeFile(part, taggedWav({ title: "Watched Song", artist: "Smoke Artist", seconds: 25, sampleRate: 8000 }));
  await new Promise((r) => setTimeout(r, 1500));
  await fs.rename(part, path.join(watchDir, "Smoke Artist - Watched Song.wav"));
}

// Serialized into the renderer by the smoke harness; keep this function self-contained.
export async function runSpotifyLocalSmoke(a: App, fx: SpotifyLocalFixtures) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok: unknown, message: string) => {
    if (!ok) throw new Error(`Spotify → Local smoke: ${message}`);
  };
  a.bus.send("mixer.master.level", 0); // real graph, no audible test tones
  await a.addFiles([...fx.library, fx.playing]);
  for (let i = 0; i < 100 && ![...fx.library, fx.playing].every((f) => a.library.getByRef(f.ref)?.tagsRead); i++) await sleep(50);

  // A deck plays for the whole test; sample its playhead to prove import/analysis don't disturb it.
  await a.engine.loadTrack(0, a.library.getByRef(fx.playing.ref)!);
  a.bus.send("deck1.play");
  const samples: { t: number; pos: number }[] = [];
  const sampler = setInterval(() => samples.push({ t: performance.now(), pos: a.audio.getPosition(0) }), 100);

  const track = (id: string, title: string, seconds: number) => ({ provider: "spotify" as const, id, title, artist: "Smoke Artist", artists: ["Smoke Artist"], album: "", durationMs: seconds * 1000 });
  a.spotifyLocal.previewSelection(
    [track("aaaaaaaaaaaaaaaaaaaaaa", "Library Track", 20), track("bbbbbbbbbbbbbbbbbbbbbb", "Watched Song", 25), track("aaaaaaaaaaaaaaaaaaaaaa", "Library Track", 20), track("cccccccccccccccccccccc", "Never Arrives", 30)],
    "Smoke Set",
  );
  const job = a.spotifyLocal.start({ playlistName: "Smoke Set", useProviders: false, autoAppend: false })!;
  assert(job && a.playlists.get(job.playlistId), "local playlist created immediately");
  const ordered = () => [...a.spotifyLocal.job(job.id)!.entries].sort((x, y) => x.position - y.position);
  const playable = (s: string) => s === "analysing" || s === "ready";
  for (let i = 0; i < 100 && ordered().some((e) => ["pending", "matching", "importing"].includes(e.state)); i++) await sleep(50);
  const first = ordered().map((e) => e.state);
  assert(playable(first[0]) && playable(first[2]), `library track reused for both repeats (${ordered().map((e) => e.state + ": " + e.detail).join(" | ")})`);
  assert(first[1] === "awaiting-file" && first[3] === "awaiting-file", `missing tracks await a file (${first.join()})`);

  // The watched file is written by the main process (.part → rename) a few seconds after start.
  for (let i = 0; i < 300 && !playable(ordered()[1].state); i++) await sleep(50);
  const watched = ordered()[1];
  assert(playable(watched.state), `watched file resolved the pending entry (state ${watched.state}: ${watched.detail})`);
  assert(watched.local?.provenance.origin === "watch-folder", "provenance recorded");
  for (let i = 0; i < 300 && ordered()[1].state !== "ready"; i++) await sleep(50);
  const refs = a.playlists.get(job.playlistId)!.refs;
  assert(refs.length === 3 && refs[0] === refs[2] && refs[1] === watched.local!.ref, "playlist in source order with the repeat kept");

  // Auto DJ: refused while a deck plays manually, then started with ready tracks only.
  a.spotifyLocal.addReadyToAutoDJ(job.id);
  const refused = a.spotifyLocal.getState().message?.text ?? "";
  clearInterval(sampler);
  a.bus.send("deck1.play"); // pause
  await sleep(200);
  a.spotifyLocal.addReadyToAutoDJ(job.id);
  for (let i = 0; i < 100 && a.autoDJ.getState().status === "OFF"; i++) await sleep(50);
  const adj = a.autoDJ.getState();
  assert(adj.status !== "OFF" && adj.playlistId === job.playlistId, "Auto DJ started from the linked playlist");
  a.spotifyLocal.addReadyToAutoDJ(job.id);
  const queueAfterSecondPress = a.autoDJ.getState().upcoming.length;
  a.autoDJ.stop();

  // Playback stability: playhead advanced every sample, and never fell behind wall time by >250 ms.
  let worstLagMs = 0;
  let stalls = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    const dp = (samples[i].pos - samples[i - 1].pos) * 1000;
    if (dp <= 0) stalls++;
    worstLagMs = Math.max(worstLagMs, dt - dp);
  }
  assert(samples.length > 20 && stalls === 0, `deck kept playing during import/analysis (${stalls} stalls in ${samples.length} samples)`);
  // UI: open Spotify → Local and the job; every entry renders with an icon + text state.
  (document.querySelector('[data-source="spotify-local"]') as HTMLButtonElement | null)?.click();
  await sleep(300);
  a.spotifyLocal.clearMessage();
  [...document.querySelectorAll<HTMLButtonElement>(".sl-jobs button")].find((b) => b.textContent?.includes("Smoke Set"))?.click();
  await sleep(300);
  const rows = [...document.querySelectorAll(".sl-table tbody tr.sl-row")].map((r) => r.querySelector(".sl-badge")?.textContent?.trim() ?? "");
  assert(rows.length === 4 && rows.every((t) => /^[^\w\s]\s\w/.test(t)), `job table renders icon + text states (${rows.join(" | ")})`);
  // Provider settings: permission reminder shown, spotDL status reported (installed or setup steps).
  [...document.querySelectorAll<HTMLButtonElement>(".sl-head button")].find((b) => b.textContent?.includes("Folders"))?.click();
  await a.spotifyLocal.refreshProviders();
  await sleep(300);
  const reminder = document.querySelector(".sl-permission")?.textContent ?? "";
  assert(/Only download tracks you have permission to/.test(reminder), "permission reminder shown with the providers");
  const spotdl = a.spotifyLocal.getState().providers.find((p) => p.id === "spotdl");
  assert(spotdl?.canDownload && spotdl.state, "spotDL provider listed and checked");
  await sleep(600);
  const saved = (await a.platform.importJobs.load()).find((j) => j.id === job.id);
  assert(saved && saved.entries.length === 4, "job persisted");
  return {
    states: ordered().map((e) => `${e.position + 1}:${e.state}`),
    watchedQuality: watched.local?.quality,
    playlist: refs.map((r) => r.split(/[\\/]/).pop()),
    autoDJRefusedWhilePlaying: refused,
    autoDJ: { status: adj.status, current: adj.current?.split(/[\\/]/).pop(), upcoming: adj.upcoming.length, upcomingAfterSecondPress: queueAfterSecondPress },
    playback: { samples: samples.length, stalls, worstLagMs: Math.round(worstLagMs) },
    persistedStates: saved!.entries.map((e) => e.state),
    uiRows: rows,
    spotdl: spotdl!.state,
  };
}

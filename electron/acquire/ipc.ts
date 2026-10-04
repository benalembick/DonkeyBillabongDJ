/**
 * Spotify → Local, desktop side: watched download folder, validated provider downloads and
 * job persistence. Runs in the Electron main process next to the library, so files land on
 * this computer. There is no network listener: the renderer talks to it over IPC only.
 *
 * Security:
 *  - folders come only from native dialogs and are remembered here, never from the renderer
 *  - downloads are written inside the chosen destination only, under sanitised names
 *  - download URLs are re-validated against each provider's rules (HTTPS, host, path)
 *  - no shell commands; nothing logged contains tokens
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { constants as fsc, promises as fs } from "node:fs";
import path from "node:path";
import type { AcquireConfig, DownloadResult, SourceTrack, WatchedFile, WatchStatus } from "../../src/acquire/types";
import * as libraryDb from "../library/db";
import { readTags } from "../library/tags";
import { cleanPartials, downloadToFile, extFromContainer, extFromHeaders, finalizeFile, isAudioPath, PARTIAL_DIR, probeAudio, safeJoin, tempPath } from "./fileOps";
import { SpotDL, spotdlSongToSource } from "./spotdl";
import { FolderWatcher, type StableFile } from "./watcher";

const CONFIG_FILE = () => path.join(app.getPath("userData"), "spotify-local.json");

/** Provider download rules: only these URL shapes may be fetched. */
const PROVIDER_RULES: Record<string, (u: URL, candidateId: string) => boolean> = {
  audius: (u, id) => u.protocol === "https:" && u.hostname === "api.audius.co" && u.pathname === `/v1/tracks/${id}/download` && /^[A-Za-z0-9]+$/.test(id),
  // spotDL is given the Spotify track link; it finds and downloads matching YouTube audio itself.
  spotdl: (u, id) => u.protocol === "https:" && u.hostname === "open.spotify.com" && u.pathname === `/track/${id}` && !u.search && /^[A-Za-z0-9]{22}$/.test(id),
};

const spotdl = new SpotDL();

/** Playlist track lists read via spotDL are cached for this long (they can take minutes to read). */
const PLAYLIST_CACHE_MS = 12 * 60 * 60_000;
const playlistReads = new Map<string, Promise<SourceTrack[]>>();

/**
 * Tracks of a Spotify playlist that Spotify won't return to this app (e.g. by other people),
 * read with the user's installed spotDL — metadata only, nothing is downloaded. Cached.
 */
export function readPlaylistViaSpotdl(playlistId: string): Promise<SourceTrack[]> {
  if (!/^[A-Za-z0-9]{22}$/.test(playlistId)) return Promise.reject(new Error("Invalid playlist id"));
  const running = playlistReads.get(playlistId);
  if (running) return running;
  const task = (async () => {
    const cacheDir = path.join(app.getPath("userData"), "spotdl-playlists");
    const cacheFile = path.join(cacheDir, `${playlistId}.json`);
    const cached = await fs.readFile(cacheFile, "utf8").then((t) => JSON.parse(t) as { at: number; tracks: SourceTrack[] }, () => null);
    if (cached && Date.now() - cached.at < PLAYLIST_CACHE_MS && Array.isArray(cached.tracks)) return cached.tracks;
    const status = await spotdl.check();
    if (!status.available) throw new Error(`${status.reason ?? "spotDL unavailable"} ${status.setup ?? ""}`.trim());
    const work = path.join(app.getPath("temp"), `dbdj-spotdl-playlist-${playlistId}-${Date.now().toString(36)}`);
    try {
      const songs = await spotdl.readPlaylist(`https://open.spotify.com/playlist/${playlistId}`, work);
      const tracks = songs.map(spotdlSongToSource);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ at: Date.now(), tracks }));
      return tracks;
    } catch (err) {
      // An older cached copy is better than nothing.
      if (cached?.tracks?.length) return cached.tracks;
      throw err;
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  })().finally(() => playlistReads.delete(playlistId));
  playlistReads.set(playlistId, task);
  return task;
}

let config: AcquireConfig = { destination: null, watchFolder: null, watching: false };
let watcher: FolderWatcher | null = null;
let watchError: string | undefined;
const downloads = new Map<string, AbortController>();

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

async function isDir(p: string | null): Promise<boolean> {
  if (!p) return false;
  return (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;
}

async function loadConfig(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE(), "utf8"));
    config = {
      destination: (await isDir(raw.destination)) ? String(raw.destination) : null,
      watchFolder: (await isDir(raw.watchFolder)) ? String(raw.watchFolder) : null,
      watching: !!raw.watching,
    };
  } catch {
    /* first run */
  }
}

async function saveConfig(): Promise<void> {
  await fs.writeFile(CONFIG_FILE(), JSON.stringify(config, null, 2));
}

function status(): WatchStatus {
  return { folder: config.watchFolder, watching: !!watcher, error: watchError, seen: watcher?.seen ?? 0 };
}

async function describeFile(f: StableFile): Promise<WatchedFile> {
  const [tags] = await readTags([f.path]);
  let quality = null;
  let error: string | undefined;
  try {
    quality = await probeAudio(f.path);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    ...f,
    tags: tags?.ok ? { title: tags.title, artist: tags.artist, album: tags.album, isrc: tags.isrc, durationMs: tags.durationMs } : {},
    quality,
    error: error ?? (tags && !tags.ok ? tags.error : undefined),
  };
}

async function startWatching(): Promise<void> {
  watcher?.stop();
  watcher = null;
  watchError = undefined;
  if (!config.watchFolder) throw new Error("Choose a folder to watch first.");
  const w = new FolderWatcher({
    folder: config.watchFolder,
    onFile: async (f) => broadcast("dbdj:acquire:file", await describeFile(f)),
    onError: (message) => {
      watchError = message;
      broadcast("dbdj:acquire:watchStatus", status());
    },
  });
  await w.start();
  watcher = w;
  broadcast("dbdj:acquire:watchStatus", status());
}

async function pick(e: IpcMainInvokeEvent, title: string): Promise<string | null> {
  const w = BrowserWindow.fromWebContents(e.sender);
  const opts = { title, properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
  const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0] ?? null;
}

async function download(raw: unknown): Promise<DownloadResult> {
  const r = raw as { id?: unknown; provider?: unknown; candidateId?: unknown; url?: unknown; name?: unknown; expectedDurationMs?: unknown; toleranceS?: unknown };
  const id = String(r?.id ?? "");
  const provider = String(r?.provider ?? "");
  const candidateId = String(r?.candidateId ?? "");
  const rule = PROVIDER_RULES[provider];
  if (!rule) throw new Error(`Downloads from "${provider}" aren't enabled.`);
  let url: URL;
  try {
    url = new URL(String(r?.url ?? ""));
  } catch {
    throw new Error("Invalid download URL");
  }
  if (!rule(url, candidateId)) throw new Error("Download URL rejected by the provider's rules");
  const dest = config.destination;
  if (!dest || !(await isDir(dest))) throw new Error("Choose a destination folder for downloads first (Spotify → Local → Settings).");
  await fs.mkdir(safeJoin(dest, PARTIAL_DIR), { recursive: true });

  const ctl = new AbortController();
  downloads.set(id, ctl);
  const tmp = tempPath(dest);
  let work = tmp;
  let lastSent = 0;
  const spotdlDir = `${tmp.slice(0, -".part".length)}-spotdl`;
  try {
    if (provider === "spotdl") {
      const expected = Number(r?.expectedDurationMs) || 0;
      const tol = Math.max(5, Number(r?.toleranceS) || 15);
      const plausible = (ms: number | null) => !(expected > 0 && ms && Math.abs(ms - expected) / 1000 > tol);
      // Already downloaded for this Spotify track (earlier run, retry, or another playlist): reuse it.
      const tag = `[spotdl ${candidateId}]`;
      for (const name of await fs.readdir(dest).catch(() => [] as string[])) {
        if (!name.includes(tag) || !isAudioPath(name)) continue;
        const existing = path.join(dest, name);
        const q = await probeAudio(existing).catch(() => null);
        if (q && plausible(q.durationMs)) return { path: existing, name, reused: true, quality: q };
      }
      // External tool in its own temp folder; its file is validated and moved like any download.
      work = await spotdl.download(`https://open.spotify.com/track/${candidateId}`, spotdlDir, { signal: ctl.signal });
      const ext = path.extname(work).toLowerCase();
      const quality = await probeAudio(work);
      if (!plausible(quality.durationMs)) {
        throw new Error(`spotDL found a ${Math.round((quality.durationMs ?? 0) / 1000)} s recording but the Spotify track is ${Math.round(expected / 1000)} s — rejected as a different version`);
      }
      const done = await finalizeFile(work, dest, `${String(r?.name ?? "track")} [spotdl ${candidateId}]`, ext);
      return { path: done.path, name: path.basename(done.path), reused: done.reused, quality };
    }
    const got = await downloadToFile(url.toString(), tmp, {
      signal: ctl.signal,
      onProgress: (received, total) => {
        const now = Date.now();
        if (total && now - lastSent > 250) {
          lastSent = now;
          broadcast("dbdj:acquire:progress", id, received / total);
        }
      },
    });
    if (got.bytes === 0) throw new Error("The provider sent an empty file");
    let ext = extFromHeaders(got.contentType, got.disposition);
    if (!ext) ext = extFromContainer((await probeAudio(tmp).catch(() => null))?.container ?? null);
    if (!ext) throw new Error("The downloaded file isn't a recognised audio format");
    work = `${tmp}${ext}`;
    await fs.rename(tmp, work);
    const quality = await probeAudio(work);
    const expected = Number(r?.expectedDurationMs) || 0;
    const tol = Math.max(5, Number(r?.toleranceS) || 15);
    if (expected > 0 && quality.durationMs && Math.abs(quality.durationMs - expected) / 1000 > tol) {
      throw new Error(`Downloaded file is ${Math.round(quality.durationMs / 1000)} s long but the Spotify track is ${Math.round(expected / 1000)} s — rejected as a different version`);
    }
    const stem = `${String(r?.name ?? "track")} [${provider} ${candidateId}]`;
    const done = await finalizeFile(work, dest, stem, ext);
    return { path: done.path, name: path.basename(done.path), reused: done.reused, quality };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (work !== tmp) await fs.rm(work, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    downloads.delete(id);
    await fs.rm(spotdlDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function registerAcquireIpc(): Promise<void> {
  await loadConfig();
  if (config.destination) void cleanPartials(config.destination);
  if (config.watching && config.watchFolder) void startWatching().catch((err) => (watchError = String(err instanceof Error ? err.message : err)));

  ipcMain.handle("dbdj:acquire:config", () => ({ config, watch: status(), platform: process.platform }));
  ipcMain.handle("dbdj:acquire:pickDestination", async (e) => {
    const dir = await pick(e, "Folder for downloaded tracks");
    if (dir) {
      await fs.access(dir, fsc.W_OK).catch(() => {
        throw new Error("That folder isn't writable — choose another.");
      });
      config.destination = dir;
      await saveConfig();
    }
    return { config, watch: status() };
  });
  ipcMain.handle("dbdj:acquire:pickWatchFolder", async (e) => {
    const dir = await pick(e, "Folder your converter saves files to");
    if (dir) {
      config.watchFolder = dir;
      await saveConfig();
      if (config.watching) await startWatching();
    }
    return { config, watch: status() };
  });
  ipcMain.handle("dbdj:acquire:setWatching", async (_e, on: unknown) => {
    config.watching = !!on;
    await saveConfig();
    if (config.watching) await startWatching();
    else {
      watcher?.stop();
      watcher = null;
      watchError = undefined;
    }
    return { config, watch: status() };
  });
  ipcMain.handle("dbdj:acquire:rescan", async () => {
    await watcher?.rescan();
    return status();
  });
  ipcMain.handle("dbdj:acquire:download", (_e, req: unknown) => download(req));
  // External download tools installed on this computer (detected, never installed by the app).
  ipcMain.handle("dbdj:acquire:toolStatus", (_e, id: unknown, force: unknown) => {
    if (id === "spotdl") return spotdl.check(!!force);
    return { available: false, reason: `Unknown tool ${String(id)}` };
  });
  ipcMain.handle("dbdj:acquire:cancelDownload", (_e, id: unknown) => {
    downloads.get(String(id))?.abort();
  });
  // Does a library file still exist, and is it readable audio? (Header parse; the renderer decodes.)
  ipcMain.handle("dbdj:acquire:probe", async (_e, p: unknown) => {
    const file = String(p ?? "");
    if (!isAudioPath(file)) return { ok: false, error: "Not a supported audio file" };
    try {
      return { ok: true, quality: await probeAudio(file) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, error: code === "ENOENT" ? "File no longer exists" : err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("dbdj:acquire:jobs:load", () => libraryDb.loadImportJobs());
  ipcMain.handle("dbdj:acquire:jobs:save", (_e, job: unknown) => libraryDb.saveImportJob(job as never));
  ipcMain.handle("dbdj:acquire:jobs:remove", (_e, id: unknown) => libraryDb.removeImportJob(String(id)));
}

/** Smoke tests only (throwaway profile): set folders without native dialogs and start watching. */
export async function smokeConfigure(c: { watchFolder: string; destination: string }): Promise<void> {
  if (!process.env.DBDJ_SMOKE_TEST) throw new Error("smokeConfigure is only available in smoke tests");
  config = { destination: c.destination, watchFolder: c.watchFolder, watching: true };
  await saveConfig();
  await startWatching();
}

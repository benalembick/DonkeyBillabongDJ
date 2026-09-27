/**
 * Electron main process.
 *
 * Responsibilities are deliberately small: window lifecycle, OS permissions
 * (MIDI / audio output selection), and filesystem access for the renderer via
 * a narrow IPC surface. All DJ, audio and controller logic lives in the
 * renderer's engine layers so it can also run in browser mode.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerStreamingIpc } from "./streaming/ipc";
import * as libraryDb from "./library/db";
import { readTags } from "./library/tags";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".opus", ".aif", ".aiff"]);
const ALLOWED_PERMISSIONS = new Set(["midi", "midiSysex", "media", "speaker-selection", "clipboard-sanitized-write"]);

// Smoke tests run in a throwaway profile so they never touch the user's library, settings or credentials.
if (process.env.DBDJ_SMOKE_TEST) {
  app.setPath("userData", process.env.DBDJ_SMOKE_USERDATA ?? path.join(os.tmpdir(), `dbdj-smoke-${process.pid}`));
}

// A DJ app must keep processing controller input and audio when not focused / minimised.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function isAudioFile(p: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase());
}

async function scanFolder(root: string, maxDepth = 6): Promise<{ path: string; name: string; size: number }[]> {
  const out: { path: string; name: string; size: number }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip, never fail the whole scan
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && isAudioFile(e.name)) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, name: e.name, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function registerIpc(): void {
  // Dialogs are parented to the app window; unparented dialogs can open behind it on Windows.
  const open = (e: IpcMainInvokeEvent, opts: OpenDialogOptions) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts);
  };

  ipcMain.handle("dbdj:openAudioFiles", async (e) => {
    const r = await open(e, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Audio", extensions: [...AUDIO_EXTENSIONS].map((x) => x.slice(1)) }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle("dbdj:openFolder", async (e) => {
    const r = await open(e, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("dbdj:scanFolder", async (_e, dir: string) => scanFolder(String(dir)));

  // Expand paths dropped from Explorer/Finder: audio files are kept, folders are scanned.
  ipcMain.handle("dbdj:expandPaths", async (_e, paths: unknown) => {
    const out: { path: string; name: string; size: number }[] = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      const p = String(raw);
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) out.push(...(await scanFolder(p)));
        else if (st.isFile() && isAudioFile(p)) out.push({ path: p, name: path.basename(p), size: st.size });
      } catch {
        /* vanished or unreadable: skip */
      }
    }
    return out;
  });

  // Local library database + tag reading (all local; nothing is uploaded anywhere).
  ipcMain.handle("dbdj:library:load", () => libraryDb.loadTracks());
  ipcMain.handle("dbdj:library:upsert", (_e, rows: libraryDb.TrackRow[]) => libraryDb.upsertTracks(Array.isArray(rows) ? rows : []));
  ipcMain.handle("dbdj:library:remove", (_e, refs: string[]) => libraryDb.removeTracks(Array.isArray(refs) ? refs.map(String) : []));
  ipcMain.handle("dbdj:mappings:load", () => libraryDb.loadMappings());
  ipcMain.handle("dbdj:mappings:put", (_e, row: libraryDb.MappingRow) => libraryDb.putMapping(row));
  ipcMain.handle("dbdj:mappings:remove", (_e, key: string) => libraryDb.removeMapping(String(key)));
  ipcMain.handle("dbdj:tags:read", (_e, paths: string[]) => readTags((Array.isArray(paths) ? paths : []).map(String).filter(isAudioFile)));

  ipcMain.handle("dbdj:openExternal", async (_e, url: string) => {
    const u = new URL(String(url));
    const allowed = ["open.spotify.com", "developer.spotify.com", "music.apple.com", "developer.apple.com"];
    if (u.protocol !== "https:" || !allowed.includes(u.hostname)) throw new Error("URL not allowed");
    await shell.openExternal(u.toString());
  });

  ipcMain.handle("dbdj:readAudioFile", async (_e, filePath: string) => {
    const p = String(filePath);
    // Only audio files are readable through this channel. Original files are never modified.
    if (!isAudioFile(p)) throw new Error(`Not a supported audio file: ${p}`);
    const buf = await fs.readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle("dbdj:readTextFile", async (_e, filePath: string) => {
    const p = String(filePath);
    if (![".xml", ".json"].includes(path.extname(p).toLowerCase())) throw new Error("Only .xml/.json mapping files");
    return fs.readFile(p, "utf8");
  });

  ipcMain.handle("dbdj:openMappingFile", async (e) => {
    const r = await open(e, {
      properties: ["openFile"],
      filters: [{ name: "Controller mappings", extensions: ["xml", "json"] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
}

/**
 * `npm run smoke`: launch, let the engines start, print a JSON health report
 * (audio status, MIDI devices, errors) to stdout and exit. Used to verify
 * the desktop build on each OS / CI without clicking through the UI.
 */
function runSmokeTest(win: BrowserWindow): void {
  const errors: string[] = [];
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      let report: unknown = null;
      try {
        // Optional playback check: DBDJ_SMOKE_TRACK=/path/to/file.wav loads it into deck A,
        // plays ~1.5 s through the real output device and reports playhead/levels.
        const track = JSON.stringify(process.env.DBDJ_SMOKE_TRACK ?? "");
        report = await win.webContents.executeJavaScript(`(async () => {
          const a = window.dbdj;
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          let playback = null;
          const ref = ${track};
          if (ref) {
            await a.engine.loadTrack(0, { ref, title: "smoke", artist: "", album: "", source: "local", bpm: null, key: null });
            a.bus.send("mixer.channel1.volume", 0.3);
            a.bus.send("deck1.play");
            let peak = 0;
            for (let i = 0; i < 15; i++) { await sleep(100); peak = Math.max(peak, a.audio.getLevels().channels[0]); }
            const pos1 = a.engine.getPosition(0);
            a.bus.send("deck1.tempo", 1);
            const rate = a.engine.getState().decks[0].rate;
            a.bus.send("deck1.play");
            await sleep(300);
            const posPaused = a.engine.getPosition(0);
            await sleep(300);
            playback = { state: a.engine.getState().decks[0].status, duration: a.engine.getState().decks[0].duration,
              positionAfter1500ms: pos1, peakLevel: peak, rateAtTempoMax: rate,
              pausedPositionStable: Math.abs(a.engine.getPosition(0) - posPaused) < 0.001 };
          }
          // File loading path used by drag & drop: expand a folder, add to library, load into deck B.
          const checks = {};
          if (ref && window.dbdjDesktop) {
            const dir = ref.replace(/[\\\\/][^\\\\/]+$/, "");
            const refs = (await window.dbdjDesktop.expandPaths([dir])).map((f) => ({ ref: f.path, name: f.name }));
            checks.expandedFolderFiles = refs.length;
            await a.addFiles(refs, 1);
            checks.deckBAfterDropLoad = a.engine.getState().decks[1].status;
            checks.libraryCount = a.library.getState().tracks.length;
          }
          // Smart Match demo: a Spotify track (metadata + ISRC only) resolved to a tagged local file and loaded.
          const matchFile = ${JSON.stringify(process.env.DBDJ_SMOKE_MATCH_FILE ?? "")};
          if (matchFile) {
            await a.addFiles([{ ref: matchFile, name: matchFile.split(/[\/]/).pop() }]);
            for (let i = 0; i < 50 && !a.library.getByRef(matchFile)?.tagsRead; i++) await sleep(100);
            await sleep(500); // local index refresh is debounced
            const sp = { provider: "spotify", id: "smoke-sp-1", title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk, Pharrell Williams",
              artists: ["Daft Punk", "Pharrell Williams"], album: "Random Access Memories", durationMs: 2000, isrc: "USQX91300809" };
            await a.matching.loadToDeck(1, { ref: "spotify:smoke-sp-1", title: sp.title, artist: sp.artist, album: sp.album, source: "spotify", bpm: null, key: null, durationMs: 2000, isrc: sp.isrc }, sp);
            const d = a.engine.getState().decks[1];
            const lt = a.library.getByRef(matchFile);
            checks.smartMatch = { deckStatus: d.status, deckTitle: d.track?.title, audioSource: d.track?.source, resolvedFrom: d.track?.resolvedFrom,
              localTags: { title: lt?.title, artist: lt?.artist, isrc: lt?.isrc, durationMs: lt?.durationMs } };
          }
          if (${JSON.stringify(!!process.env.DBDJ_SMOKE_INSPECT)} && a.matching.resolver.recent[0]) a.matching.emit("prompt", { deck: 1, result: a.matching.resolver.recent[0] });
          const persisted = ${JSON.stringify(process.env.DBDJ_SMOKE_EXPECT_LIBRARY ?? "")};
          if (persisted) checks.libraryAfterRestart = a.library.getState().tracks.map((t) => ({ title: t.title, isrc: t.isrc }));

          // Streaming IPC round-trips (no network sign-in).
          const bridge = window.dbdjDesktop;
          if (bridge) {
          checks.spotifyStatus = await bridge.streaming.status("spotify");
          checks.appleStatus = await window.dbdjDesktop.streaming.status("apple-music");
          try { await window.dbdjDesktop.streaming.configure("spotify", { clientId: "not-an-id" }); checks.badClientIdRejected = false; }
          catch { checks.badClientIdRejected = true; }
          }
          // Streaming track must be refused by the engine.
          await a.engine.loadTrack(0, { ref: "spotify:x", title: "Streamed", artist: "", album: "", source: "spotify", bpm: null, key: null });
          checks.streamingRefused = a.engine.getState().decks[0].track?.title !== "Streamed";

          // Render every tab once and collect any panel that crashed.
          const tabErrors = [];
          for (const btn of document.querySelectorAll(".tabs button")) {
            btn.click();
            await sleep(250);
            const err = document.querySelector(".panel-error");
            if (err) tabErrors.push(btn.textContent + ": " + err.textContent);
          }
          document.querySelector(".tabs button:nth-child(1)")?.click();
          await sleep(200);
          document.querySelectorAll(".browser-sources button")[1]?.click();
          await sleep(400);
          // Simulate what an OS file drop does by default: navigate to the file. Must be blocked.
          if (ref) location.href = "file:///" + ref.replace(/\\\\/g, "/");
          await sleep(800);
          checks.stillOnAppAfterNavigationAttempt = !!document.querySelector(".topbar");
          const clickSel = ${JSON.stringify(process.env.DBDJ_SMOKE_BROWSER_CLICK ?? "")};
          if (clickSel) { document.querySelector(clickSel)?.click(); await sleep(1500); }
          return {
            checks,
            tabErrors,
            audio: a.audio.getStatus(),
            midi: a.controllers.getAvailability(),
            controllers: a.controllers.getControllers(),
            playback,
            log: a.log.all().map(e => e.level + " [" + e.source + "] " + e.message),
          };
        })()`);
      } catch (err) {
        errors.push(String(err));
      }
      for (const e of (report as { tabErrors?: string[] } | null)?.tabErrors ?? []) errors.push(`panel crashed: ${e}`);
      const shot = process.env.DBDJ_SMOKE_SCREENSHOT;
      if (shot) {
        try {
          await fs.writeFile(shot, (await win.webContents.capturePage()).toPNG());
        } catch (err) {
          errors.push(`screenshot: ${String(err)}`);
        }
      }
      process.stdout.write(`DBDJ_SMOKE ${JSON.stringify({ report, errors }, null, 2)}\n`);
      app.exit(errors.length ? 1 : 0);
    }, Number(process.env.DBDJ_SMOKE_WAIT_MS ?? 8000));
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0d0f12",
    title: "Donkey Billabong DJ",
    webPreferences: {
      // DBDJ_SMOKE_BROWSER=1 omits the desktop bridge to exercise browser mode in smoke tests.
      preload: process.env.DBDJ_SMOKE_BROWSER ? undefined : path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Dropping a file on the window must never navigate away from the app (Electron's default).
  win.webContents.on("will-navigate", (e, url) => {
    const devServer = process.env.DBDJ_DEV_SERVER;
    if (!(devServer && url.startsWith(devServer))) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.DBDJ_SMOKE_TEST) runSmokeTest(win);

  const devServer = process.env.DBDJ_DEV_SERVER;
  if (devServer) {
    void win.loadURL(devServer);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  registerIpc();
  registerStreamingIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

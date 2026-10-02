/**
 * Checks GitHub Releases for a newer desktop app (shortly after launch, every
 * few hours, and from About → Check for updates).
 *
 * Installed Windows app: electron-updater downloads the new installer in the
 * background; it installs when the user clicks "Restart & install" or quits.
 * It never restarts on its own, so a set is never interrupted.
 * macOS / dev builds: unsigned Mac apps can't replace themselves, so the user
 * is offered the new .dmg as a browser download instead.
 */
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import { autoUpdater } from "electron-updater";
import pkg from "../package.json" with { type: "json" };
import { isNewerVersion, type UpdateStatus } from "../src/platform/updates";

const REPO = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository.url)![1];
const ASSET = { win32: "DonkeyBillabongDJ-Setup.exe", darwin: "DonkeyBillabongDJ-macOS.dmg" } as Record<string, string>;
const FIRST_CHECK_MS = 15_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

const current = app.getVersion();
const autoInstall = process.platform === "win32" && app.isPackaged;
let status: UpdateStatus = { state: "idle", current };

function setStatus(s: UpdateStatus): void {
  status = s;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("dbdj:update:status", s);
}

const busy = () => status.state === "checking" || status.state === "downloading" || status.state === "ready";

/** Latest release via the GitHub API (macOS / dev builds). */
async function checkGitHub(): Promise<void> {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return setStatus({ state: "none", current, checkedAt: Date.now() }); // nothing published yet
  if (!r.ok) throw new Error(`GitHub responded ${r.status}`);
  const j = (await r.json()) as { tag_name?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] };
  const version = String(j.tag_name ?? "").replace(/^v/i, "");
  const notesUrl = j.html_url ?? `https://github.com/${REPO}/releases/latest`;
  if (!version || !isNewerVersion(version, current)) return setStatus({ state: "none", current, checkedAt: Date.now() });
  const asset = j.assets?.find((a) => a.name === ASSET[process.platform]);
  setStatus({ state: "available", current, version, mode: "manual", downloadUrl: asset?.browser_download_url ?? notesUrl, notesUrl });
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (busy()) return status;
  setStatus({ state: "checking", current });
  try {
    if (autoInstall) {
      const r = await autoUpdater.checkForUpdates();
      // The events below report progress; this covers "already up to date".
      if (!r?.isUpdateAvailable && status.state === "checking") setStatus({ state: "none", current, checkedAt: Date.now() });
    } else {
      await checkGitHub();
    }
  } catch (err) {
    setStatus({ state: "error", current, message: err instanceof Error ? err.message : String(err) });
  }
  return status;
}

export function registerUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("update-available", (info) => setStatus({ state: "downloading", current, version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => {
    if (status.state === "downloading") setStatus({ ...status, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => setStatus({ state: "ready", current, version: info.version }));
  autoUpdater.on("error", (err) => setStatus({ state: "error", current, message: err?.message ?? String(err) }));

  ipcMain.handle("dbdj:update:status", () => status);
  ipcMain.handle("dbdj:update:check", () => checkForUpdates());
  // Only ever opens the URL found by the check, never one supplied by the page.
  ipcMain.handle("dbdj:update:download", async () => {
    if (status.state === "available") await shell.openExternal(status.downloadUrl);
  });
  ipcMain.handle("dbdj:update:notes", async () => {
    await shell.openExternal(status.state === "available" ? status.notesUrl : `https://github.com/${REPO}/releases/latest`);
  });
  ipcMain.handle("dbdj:update:install", () => {
    if (status.state === "ready") setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  if (process.env.DBDJ_SMOKE_TEST) return;
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(), RECHECK_MS);
}

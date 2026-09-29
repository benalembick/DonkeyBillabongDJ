/**
 * Main-process side of STEM separation: owns the stem worker (utilityProcess),
 * the model download, settings (cache folder / size / device) and the cache
 * index. Audio data flows renderer ⇄ worker over a direct MessagePort.
 */
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, shell, utilityProcess, type UtilityProcess } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { StemDevice } from "../../src/stems/protocol";
import { StemCache } from "./cache";
import { fileKey } from "./fileKey";

export const MODEL = {
  name: "HT-Demucs (4 stems, ONNX, fp16 weights)",
  file: "htdemucs_fp16weights.onnx",
  // Pinned revision + checksum (StemSplitio/htdemucs-onnx, MIT licence).
  url: "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx",
  sha256: "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a",
  bytes: 165612636,
};

export interface StemConfig {
  cacheDir: string;
  maxCacheGB: number;
  device: StemDevice;
  /** Auto mode found the GPU unusable on this machine (skipped until re-measured). */
  gpuFailed?: boolean;
}

let worker: UtilityProcess | null = null;
let config: StemConfig;
let downloading: Promise<void> | null = null;
let configPatched = false;

/** ONNX Runtime ships native builds for Windows x64/arm64 and Apple Silicon only. */
export function platformSupport(): { ok: boolean; reason?: string } {
  if (process.platform === "darwin" && process.arch !== "arm64") return { ok: false, reason: "STEMS need an Apple Silicon Mac (ONNX Runtime has no Intel macOS build)." };
  if (process.platform !== "darwin" && process.platform !== "win32") return { ok: false, reason: "STEMS are supported on Windows and macOS." };
  return { ok: true };
}

/** Worker diagnostics (errors, device choice), readable from Settings → STEMS → Show log. */
export const logFile = () => path.join(app.getPath("userData"), "logs", "stems.log");
let logReady: Promise<void> | null = null;
function appendLog(text: string): void {
  logReady ??= (async () => {
    await fs.mkdir(path.dirname(logFile()), { recursive: true });
    // Keep the log small: start over once it passes 1 MB.
    const st = await fs.stat(logFile()).catch(() => null);
    if (st && st.size > 1024 * 1024) await fs.writeFile(logFile(), "");
  })().catch(() => undefined);
  void logReady.then(() => fs.appendFile(logFile(), text)).catch(() => undefined);
}

const configFile = () => path.join(app.getPath("userData"), "stems-config.json");
const modelPath = () => process.env.DBDJ_STEMS_MODEL_PATH || path.join(app.getPath("userData"), "models", MODEL.file);

async function loadConfig(): Promise<StemConfig> {
  const defaults: StemConfig = { cacheDir: path.join(app.getPath("userData"), "stems"), maxCacheGB: 20, device: "auto" };
  try {
    return { ...defaults, ...JSON.parse(await fs.readFile(configFile(), "utf8")) };
  } catch {
    return defaults;
  }
}

async function modelInstalled(): Promise<boolean> {
  try {
    const st = await fs.stat(modelPath());
    return st.size === MODEL.bytes || !!process.env.DBDJ_STEMS_MODEL_PATH;
  } catch {
    return false;
  }
}

function ensureWorker(): UtilityProcess {
  if (worker) return worker;
  const w = utilityProcess.fork(path.join(__dirname, "stems-worker.cjs"), [], { serviceName: "Donkey Billabong DJ — stems", stdio: "pipe" });
  w.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(`[stems] ${d}`);
    appendLog(String(d));
  });
  w.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[stems] ${d}`);
    appendLog(String(d));
  });
  appendLog(`${new Date().toISOString()} worker start (${process.platform}/${process.arch}, app ${app.getVersion()}, device ${config.device}${config.gpuFailed ? ", GPU marked failed" : ""})\n`);
  let epInUse = "";
  w.postMessage({ type: "init", modelPath: modelPath(), cacheDir: config.cacheDir, device: config.device, gpuFailed: !!config.gpuFailed });
  const markGpu = (failed: boolean) => {
    config = { ...config, gpuFailed: failed };
    void fs.writeFile(configFile(), JSON.stringify(config)).catch(() => undefined);
  };
  w.on("message", (m: { type?: string; failed?: boolean; ep?: string }) => {
    if (m?.type === "gpuFailed") markGpu(!!m.failed);
    if (m?.type === "trying" || m?.type === "session") epInUse = String(m.ep ?? "");
  });
  w.postMessage({ type: "config", maxCacheBytes: config.maxCacheGB * 1024 ** 3, cacheDir: config.cacheDir, device: config.device });
  w.on("exit", (code) => {
    process.stderr.write(`[stems] worker exited (code ${code})\n`);
    appendLog(`${new Date().toISOString()} worker exited (code ${code}) while using ${epInUse || "no device"}\n`);
    // Died on the GPU (e.g. a native CoreML/DirectML crash): never try it automatically again.
    if (code !== 0 && epInUse && epInUse !== "cpu") markGpu(true);
    // A crash only ends separation; decks keep playing the original audio. Respawned on next use.
    worker = null;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("dbdj:stems:workerExit");
  });
  worker = w;
  return w;
}

async function download(onProgress: (p: { received: number; total: number }) => void): Promise<void> {
  const dest = modelPath();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  const res = await fetch(MODEL.url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status})`);
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.length;
    if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    onProgress({ received, total: MODEL.bytes });
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  if (hash.digest("hex") !== MODEL.sha256) {
    await fs.rm(part, { force: true });
    throw new Error("Model checksum mismatch — download discarded.");
  }
  await fs.rename(part, dest);
}

export async function registerStemIpc(): Promise<void> {
  // Defaults first so every handler exists immediately; the saved config replaces them a moment later.
  config = { cacheDir: path.join(app.getPath("userData"), "stems"), maxCacheGB: 20, device: "auto" };
  void loadConfig().then((c) => (config = { ...c, ...(configPatched ? config : {}) }));

  ipcMain.handle("dbdj:stems:status", async () => ({ model: { ...MODEL, installed: await modelInstalled(), path: modelPath() }, config, platform: platformSupport(), logPath: logFile() }));
  ipcMain.handle("dbdj:stems:revealLog", async () => {
    await fs.mkdir(path.dirname(logFile()), { recursive: true });
    await fs.appendFile(logFile(), "");
    shell.showItemInFolder(logFile());
  });

  ipcMain.handle("dbdj:stems:downloadModel", async (e) => {
    if (!downloading) {
      downloading = download((p) => e.sender.send("dbdj:stems:downloadProgress", p)).finally(() => (downloading = null));
    }
    await downloading;
    worker?.kill(); // restart so the worker loads the new model
    worker = null;
    return true;
  });

  // Hand the renderer a direct channel to the worker (large audio buffers never pass through main).
  ipcMain.handle("dbdj:stems:connect", async (e) => {
    if (!platformSupport().ok || !(await modelInstalled())) return false;
    const w = ensureWorker();
    const { port1, port2 } = new MessageChannelMain();
    w.postMessage({ type: "port" }, [port1]);
    e.sender.postMessage("dbdj:stems:port", null, [port2]);
    return true;
  });

  ipcMain.handle("dbdj:stems:fileKey", (_e, p: string) => fileKey(String(p)));

  ipcMain.handle("dbdj:stems:index", async () => {
    const c = new StemCache(config.cacheDir);
    const idx = await c.readIndex();
    const out: Record<string, "complete" | "partial"> = {};
    for (const [ref, key] of Object.entries(idx)) {
      const m = await c.meta(key);
      if (m) out[ref] = m.complete ? "complete" : "partial";
    }
    return out;
  });

  ipcMain.handle("dbdj:stems:setIndex", (_e, ref: string, key: string | null) => new StemCache(config.cacheDir).setIndex(String(ref), key ? String(key) : null));
  ipcMain.handle("dbdj:stems:renderData", async (_e, ref: string) => {
    const cache = new StemCache(config.cacheDir), key = (await cache.readIndex())[String(ref)];
    if (!key) throw new Error("No cached STEMS for this track");
    return cache.renderData(key);
  });

  ipcMain.handle("dbdj:stems:remove", async (_e, refs: string[]) => {
    const c = new StemCache(config.cacheDir);
    const idx = await c.readIndex();
    for (const ref of refs) {
      const key = idx[ref];
      if (key) await c.remove(key);
      await c.setIndex(ref, null);
    }
  });

  ipcMain.handle("dbdj:stems:cacheInfo", async () => {
    const list = await new StemCache(config.cacheDir).list();
    return { entries: list.length, bytes: list.reduce((s, m) => s + m.bytes, 0), complete: list.filter((m) => m.complete).length };
  });

  ipcMain.handle("dbdj:stems:clearCache", async () => {
    await fs.rm(config.cacheDir, { recursive: true, force: true });
  });

  ipcMain.handle("dbdj:stems:setConfig", async (_e, patch: Partial<StemConfig>) => {
    config = { ...config, ...patch };
    configPatched = true;
    await fs.writeFile(configFile(), JSON.stringify(config));
    worker?.postMessage({ type: "config", maxCacheBytes: config.maxCacheGB * 1024 ** 3, cacheDir: config.cacheDir, device: config.device });
    return config;
  });

  ipcMain.handle("dbdj:stems:pickCacheDir", async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = w ? await dialog.showOpenDialog(w, { properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  app.on("before-quit", () => worker?.kill());
}

/**
 * Stem separation worker (Electron utilityProcess).
 *
 * Runs HT-Demucs through ONNX Runtime off the UI and audio threads, in its own
 * OS process: a crash or a slow GPU driver can never stall playback. Picks the
 * supported execution provider (CPU on macOS, DirectML on Windows GPUs) and falls
 * back to the CPU if the GPU fails its validation run.
 */
import os from "node:os";
import { gpuProvider, sessionOptions } from "./runtime";
import type { MessagePortMain } from "electron";
import type * as Ort from "onnxruntime-node";
import type { FromWorker, StemDevice, ToWorker, WorkerStatus } from "../../src/stems/protocol";
import { SEGMENT, SeparationJob, makePlan, type RegionOutput } from "../../src/stems/separator";
import { StemCache, type CacheMeta } from "./cache";

interface InitMsg {
  type: "init";
  modelPath: string;
  cacheDir: string;
  device: StemDevice;
  gpuFailed?: boolean;
}

let retryGpu = false;
/** Set after the GPU failed during this worker's life: stay on the CPU. */
let forceCpu = false;

let ort: typeof Ort | null = null;
/** Load ONNX Runtime on first use so a missing/blocked native library is reported instead of killing the worker. */
function loadOrt(): typeof Ort {
  if (ort) return ort;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ort = require("onnxruntime-node") as typeof Ort;
    return ort;
  } catch (err) {
    const msg = `ONNX Runtime could not be loaded on this computer: ${String(err).slice(0, 300)}`;
    log(msg);
    setStatus({ state: "error", message: msg });
    throw new Error(msg);
  }
}

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

/** Tell the main process which execution provider is in use (so a native GPU crash can be recognised). */
function tellMain(m: { type: "trying" | "session"; ep: string } | { type: "gpuFailed"; failed: boolean }): void {
  try {
    process.parentPort.postMessage(m);
  } catch {
    /* parent gone */
  }
}

/** HT-Demucs output must be finite; some GPU back-ends silently produce NaN/Inf in fp16. */
function outputLooksValid(data: Float32Array): boolean {
  const step = Math.max(1, Math.floor(data.length / 20000));
  for (let i = 0; i < data.length; i += step) if (!Number.isFinite(data[i])) return false;
  return true;
}

let port: MessagePortMain | null = null;
let init: InitMsg | null = null;
let session: Ort.InferenceSession | null = null;
let sessionEp = "";
let sessionDevice = "";
let status: WorkerStatus = { state: "idle" };
let cache: StemCache | null = null;

interface ActiveJob {
  id: number;
  key: string;
  persist: boolean;
  meta: CacheMeta | null;
  job: SeparationJob | null;
  cancelled: boolean;
  /** Pending cache writes (serialised). */
  writes: Promise<void>;
}
const jobs = new Map<number, ActiveJob>();
let running = false;
const runQueue: number[] = [];

function send(msg: FromWorker, transfer: ArrayBuffer[] = []): void {
  // MessagePortMain clones; typed arrays arrive intact in the renderer.
  void transfer;
  port?.postMessage(msg);
}

function setStatus(s: Partial<WorkerStatus>): void {
  status = { ...status, ...s };
  send({ type: "status", status });
}

const threads = () => Math.max(2, Math.floor(os.cpus().length * 0.6)); // leave headroom for audio + UI

async function createSession(provider: string): Promise<Ort.InferenceSession> {
  return loadOrt().InferenceSession.create(init!.modelPath, sessionOptions(process.platform, provider, threads()));
}

async function timedRun(s: Ort.InferenceSession): Promise<number> {
  const mix = new Float32Array(2 * SEGMENT);
  // Music-like test signal (tone + noise bursts) rather than a pure sine, so the validation exercises real paths.
  for (let i = 0; i < SEGMENT; i++) mix[i] = mix[SEGMENT + i] = Math.sin(i * 0.02) * 0.2 + (i % 22050 < 2000 ? (Math.random() - 0.5) * 0.3 : 0);
  const t = Date.now();
  const out = await s.run({ mix: new (loadOrt().Tensor)("float32", mix, [1, 2, SEGMENT]) });
  const data = out[s.outputNames[0]].data as Float32Array;
  if (!outputLooksValid(data)) throw new Error("model produced invalid (NaN/Inf) output on this device");
  return (Date.now() - t) / 1000 / (SEGMENT / 44100);
}

/** Load the model on the best working device (validated with a real run). */
async function ensureSession(): Promise<Ort.InferenceSession> {
  if (session) return session;
  if (!init) throw new Error("stem worker not initialised");
  setStatus({ state: "loading-model", message: "Loading separation model…" });
  // Test hook (smoke tests only): a CPU session posing as a GPU that later fails or crashes.
  const simulate = process.env.DBDJ_STEMS_SIMULATE_GPU;
  const gpu = simulate ? "sim-gpu" : gpuProvider(process.platform);
  // Auto skips a GPU that already failed on this machine (remembered by main) unless re-measuring.
  const skipGpu = init.device === "auto" && init.gpuFailed && !retryGpu;
  retryGpu = false;
  const candidates = init.device === "cpu" || !gpu || skipGpu || forceCpu ? ["cpu"] : [gpu, "cpu"];
  let lastErr = "";
  for (const ep of candidates) {
    try {
      tellMain({ type: "trying", ep });
      log(`creating session on ${ep}`);
      const s = await createSession(ep);
      const rtf = await timedRun(s);
      log(`session on ${ep} ok, rtf ${rtf.toFixed(2)}`);
      session = s;
      sessionEp = ep;
      tellMain({ type: "session", ep });
      sessionDevice = ep === "cpu" ? `CPU (${threads()} threads)` : ep === "dml" ? "GPU (DirectML)" : "GPU/Neural Engine (CoreML)";
      const gpuFailed = ep === "cpu" && candidates[0] !== "cpu";
      if (gpuFailed || (ep !== "cpu" && init.gpuFailed)) tellMain({ type: "gpuFailed", failed: gpuFailed });
      setStatus({
        state: "ready",
        device: sessionDevice,
        rtf: Math.round(rtf * 100) / 100,
        message: process.platform === "darwin" && !simulate ? "Using CPU: CoreML is incompatible with this separation model" : gpuFailed ? `GPU unavailable (${lastErr.slice(0, 120)}); using CPU` : skipGpu ? "GPU failed on an earlier run; using CPU (Measure speed retries the GPU)" : undefined,
      });
      return s;
    } catch (err) {
      lastErr = String(err);
      log(`session on ${ep} failed: ${lastErr}`);
    }
  }
  setStatus({ state: "error", message: `Could not load the separation model: ${lastErr.slice(0, 200)}` });
  throw new Error(lastErr);
}

let simRuns = 0;

async function runOn(s: Ort.InferenceSession, planar: Float32Array): Promise<Float32Array> {
  if (sessionEp === "sim-gpu" && ++simRuns >= 2) {
    if (process.env.DBDJ_STEMS_SIMULATE_GPU === "crash") process.exit(3);
    throw new Error("simulated GPU failure");
  }
  const out = await s.run({ mix: new (loadOrt().Tensor)("float32", planar, [1, 2, SEGMENT]) });
  const data = out[s.outputNames[0]].data as Float32Array;
  if (!outputLooksValid(data)) throw new Error("invalid (NaN/Inf) model output");
  return data;
}

/**
 * One segment. If the GPU fails on real audio (it passed validation but a later
 * segment errors or returns garbage), switch to the CPU for good and redo the
 * segment — the job carries on instead of ending in an error.
 */
async function modelRun(planar: Float32Array): Promise<Float32Array> {
  const s = await ensureSession();
  try {
    return await runOn(s, planar);
  } catch (err) {
    if (sessionEp === "cpu") throw err;
    log(`GPU (${sessionEp}) failed during separation: ${String(err)} — switching to CPU`);
    forceCpu = true;
    session = null;
    tellMain({ type: "gpuFailed", failed: true });
    const cpu = await ensureSession();
    setStatus({ message: `GPU failed during separation (${String(err).slice(0, 100)}); continuing on CPU` });
    return runOn(cpu, planar);
  }
}

function regionMsg(jobId: number, total: number, stride: number, r: RegionOutput): FromWorker {
  return { type: "region", jobId, total, stride, ...r };
}

async function handleOpen(m: Extract<ToWorker, { type: "open" }>): Promise<void> {
  const j: ActiveJob = { id: m.jobId, key: m.key, persist: m.persist, meta: null, job: null, cancelled: false, writes: Promise.resolve() };
  jobs.set(m.jobId, j);
  if (!m.persist || !cache) {
    send({ type: "cache", jobId: m.jobId, state: "miss" });
    return;
  }
  const meta = await cache.meta(m.key);
  if (!meta) {
    send({ type: "cache", jobId: m.jobId, state: "miss" });
    return;
  }
  j.meta = meta;
  send({ type: "cache", jobId: m.jobId, state: meta.complete ? "complete" : "partial", total: meta.total, stride: meta.stride, regions: meta.regions });
  for await (const r of cache.readRegions(meta)) {
    if (j.cancelled) return;
    send(regionMsg(m.jobId, meta.total, meta.stride, r));
  }
  if (meta.complete) {
    send({ type: "done", jobId: m.jobId, cached: true });
    jobs.delete(m.jobId);
  }
}

async function handleRun(m: Extract<ToWorker, { type: "run" }>): Promise<void> {
  const j = jobs.get(m.jobId);
  if (!j || j.cancelled) return;
  const plan = makePlan(m.left.length, m.quality);
  const reuse = j.meta && j.meta.total === plan.total && j.meta.stride === plan.stride ? j.meta.done : undefined;
  // The cache entry must exist before the first region is emitted.
  if (j.persist && cache) j.meta = await cache.open(j.key, plan.total, plan.stride, plan.regions, m.quality);
  j.job = new SeparationJob({
    left: m.left,
    right: m.right,
    quality: m.quality,
    run: modelRun,
    startFrame: m.startFrame,
    doneRegions: reuse,
    emit: (r) => {
      send(regionMsg(j.id, plan.total, plan.stride, r));
      const meta = j.meta;
      if (j.persist && cache && meta) j.writes = j.writes.then(() => cache!.writeRegion(meta, r)).catch(() => undefined);
    },
  });
  runQueue.push(j.id);
  void pump();
}

/** One job at a time (the model saturates the CPU/GPU); yields between segments so messages are handled. */
async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (runQueue.length) {
      const id = runQueue[0];
      const j = jobs.get(id);
      if (!j || j.cancelled || !j.job) {
        runQueue.shift();
        continue;
      }
      setStatus({ state: "busy" });
      try {
        const t = Date.now();
        const more = await j.job.next();
        const regions = j.job.plan.regions;
        const done = Math.round(j.job.progress * regions);
        send({ type: "progress", jobId: id, done, regions, secondsPerSegment: (Date.now() - t) / 1000 });
        if (!more) {
          runQueue.shift();
          jobs.delete(id);
          await j.writes; // "done" means the cache entry is complete on disk
          send({ type: "done", jobId: id, cached: j.persist });
          if (j.persist && cache) void cache.cleanup(maxCacheBytes, new Set([j.key])).catch(() => undefined);
        }
      } catch (err) {
        runQueue.shift();
        jobs.delete(id);
        log(`job ${id} failed: ${String((err as Error)?.stack ?? err)}`);
        send({ type: "error", jobId: id, message: String(err).slice(0, 300) });
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    running = false;
    if (status.state === "busy") setStatus({ state: "ready" });
  }
}

let maxCacheBytes = 20 * 1024 ** 3;

function onPortMessage(m: ToWorker): void {
  switch (m.type) {
    case "open":
      void handleOpen(m).catch((err) => send({ type: "error", jobId: m.jobId, message: String(err) }));
      break;
    case "run":
      void handleRun(m).catch((err) => send({ type: "error", jobId: m.jobId, message: String(err) }));
      break;
    case "priority": {
      jobs.get(m.jobId)?.job?.prioritise(m.startFrame);
      // A deck's job jumps ahead of background (library) jobs.
      const i = runQueue.indexOf(m.jobId);
      if (i > 0) {
        runQueue.splice(i, 1);
        runQueue.unshift(m.jobId);
      }
      break;
    }
    case "cancel": {
      const j = jobs.get(m.jobId);
      if (j) j.cancelled = true;
      jobs.delete(m.jobId);
      break;
    }
    case "bench":
      session = null; // re-validate device choice (and give a previously failed GPU another chance)
      retryGpu = true;
      void ensureSession().catch(() => undefined);
      break;
  }
}

// Report, don't die: a failed segment must never take separation (or anything else) down silently.
process.on("uncaughtException", (err) => {
  log(`uncaught: ${err?.stack ?? err}`);
  setStatus({ state: "error", message: String(err).slice(0, 200) });
});
process.on("unhandledRejection", (err) => {
  log(`unhandled rejection: ${(err as Error)?.stack ?? err}`);
});

process.parentPort.on("message", (e: Electron.MessageEvent) => {
  const data = e.data as InitMsg | { type: "port" } | { type: "config"; maxCacheBytes: number; cacheDir: string; device: StemDevice };
  if (data.type === "init") {
    init = data;
    cache = new StemCache(data.cacheDir);
    setStatus({ state: "idle" });
  } else if (data.type === "config") {
    if (init && (init.device !== data.device || init.cacheDir !== data.cacheDir)) {
      init = { ...init, device: data.device, cacheDir: data.cacheDir };
      cache = new StemCache(data.cacheDir);
      session = null;
    }
    maxCacheBytes = data.maxCacheBytes;
  } else if (data.type === "port" && e.ports[0]) {
    port = e.ports[0];
    port.on("message", (ev) => {
      if (ev.data && typeof ev.data === "object") onPortMessage(ev.data as ToWorker);
    });
    port.start();
    send({ type: "status", status });
  }
});

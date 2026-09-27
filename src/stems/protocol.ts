/** Messages between the renderer's StemService and the stem worker process (over a MessagePort). */
import type { Quality } from "./separator";

export type StemDevice = "auto" | "cpu" | "gpu";

export interface WorkerStatus {
  state: "idle" | "loading-model" | "ready" | "busy" | "error" | "no-model";
  /** Execution provider actually in use, e.g. "DirectML", "CoreML", "CPU (8 threads)". */
  device?: string;
  /** Real-time factor of the last benchmark (seconds of compute per second of audio; < 1 = faster than real time). */
  rtf?: number;
  message?: string;
}

export type ToWorker =
  | { type: "open"; jobId: number; key: string; persist: boolean }
  | { type: "run"; jobId: number; left: Float32Array; right: Float32Array; startFrame: number; quality: Quality }
  | { type: "priority"; jobId: number; startFrame: number }
  | { type: "cancel"; jobId: number }
  | { type: "bench" };

export interface RegionMsg {
  type: "region";
  jobId: number;
  region: number;
  start: number;
  frames: number;
  total: number;
  stride: number;
  data: Int16Array;
  env: { start: number; vocals: Float32Array; drums: Float32Array; bass: Float32Array; instruments: Float32Array };
}

export type FromWorker =
  | { type: "status"; status: WorkerStatus }
  | { type: "cache"; jobId: number; state: "complete" | "partial" | "miss"; total?: number; stride?: number; regions?: number }
  | RegionMsg
  | { type: "progress"; jobId: number; done: number; regions: number; secondsPerSegment?: number }
  | { type: "done"; jobId: number; cached: boolean }
  | { type: "error"; jobId: number; message: string };

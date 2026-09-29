import type { InferenceSession } from "onnxruntime-node";

/** The bundled HT-Demucs graph fails CoreML's Slice compilation on macOS. */
export function gpuProvider(platform: NodeJS.Platform): string | null {
  return platform === "win32" ? "dml" : null;
}

export function sessionOptions(platform: NodeJS.Platform, provider: string, threads: number): InferenceSession.SessionOptions {
  return {
    executionProviders: [provider === "sim-gpu" ? "cpu" : provider],
    graphOptimizationLevel: "all",
    ...(provider === "cpu" || provider === "sim-gpu" ? { intraOpNumThreads: threads } : {}),
    // Electron's macOS allocator traps on the arena's 2 GiB growth allocation.
    // Allocate individual tensors and avoid large pooled buffers on later runs too.
    ...(platform === "darwin" ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
  };
}

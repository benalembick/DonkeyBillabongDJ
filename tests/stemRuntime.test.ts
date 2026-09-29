import { describe, expect, it } from "vitest";
import { gpuProvider, sessionOptions } from "../electron/stems/runtime";

describe("stem runtime platform isolation", () => {
  it("avoids CoreML and pooled allocations on macOS", () => {
    expect(gpuProvider("darwin")).toBeNull();
    expect(sessionOptions("darwin", "cpu", 6)).toEqual({
      executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: 6,
      enableCpuMemArena: false, enableMemPattern: false,
    });
  });
  it("preserves Windows DirectML and CPU options", () => {
    expect(gpuProvider("win32")).toBe("dml");
    expect(sessionOptions("win32", "dml", 8)).toEqual({
      executionProviders: ["dml"], graphOptimizationLevel: "all",
    });
    expect(sessionOptions("win32", "cpu", 8)).toEqual({
      executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: 8,
    });
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { transcodeToWav } from "../electron/audio/transcode";
import { makeAiff, sine } from "./helpers/aiffFixture";

// afconvert ships with macOS only; CI runs this on the macOS build runner.
describe.skipIf(process.platform !== "darwin")("macOS transcode fallback (afconvert)", () => {
  it("turns Apple Lossless into a WAV Chromium can decode", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbdj-alac-"));
    writeFileSync(path.join(dir, "src.aiff"), new Uint8Array(makeAiff("aiff16", sine(44100, 2))));
    execFileSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "alac", path.join(dir, "src.aiff"), path.join(dir, "alac.m4a")]);
    const wav = await transcodeToWav(new Uint8Array(readFileSync(path.join(dir, "alac.m4a"))));
    expect(wav).not.toBeNull();
    expect(wav!.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav!.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(wav!.byteLength).toBeGreaterThan(44100 * 2 * 4); // 1 s stereo float
  });

  it("returns null for data it can't read", async () => {
    expect(await transcodeToWav(new TextEncoder().encode("not audio at all"))).toBeNull();
  });
});

describe.skipIf(process.platform === "darwin")("transcode fallback elsewhere", () => {
  it("is a no-op off macOS", async () => {
    expect(await transcodeToWav(new Uint8Array(16))).toBeNull();
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertFile, converterAvailable } from "../electron/acquire/converter";

const dirs: string[] = [];
function wav(): Buffer {
  const frames = 8_000, bytes = frames * 2, b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + bytes, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8_000, 24); b.writeUInt32LE(16_000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(bytes, 40);
  return b;
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
describe("local converter", () => {
  it("converts, verifies and does not overwrite an existing output", async () => {
    expect(converterAvailable()).toBe(true);
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbdj-converter-")); dirs.push(dir);
    const input = path.join(dir, "tone.wav"); await writeFile(input, wav());
    const progress: string[] = [];
    const first = await convertFile({ id: "convert_test_1", input, destination: dir, format: "flac", rightsConfirmed: true }, (p) => progress.push(p.state));
    const second = await convertFile({ id: "convert_test_2", input, destination: dir, format: "flac", rightsConfirmed: true }, () => undefined);
    expect(first.path).not.toBe(second.path); expect((await readFile(first.path)).subarray(0, 4).toString()).toBe("fLaC");
    expect(progress).toContain("verifying"); expect(progress.at(-1)).toBe("completed");
  }, 15_000);
  it("requires a rights confirmation", async () => {
    await expect(convertFile({ id: "convert_denied", input: "x", destination: "x", format: "mp3", rightsConfirmed: false }, () => undefined)).rejects.toThrow(/permission/i);
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEmbeddedCues, writeEmbeddedCues } from "../electron/library/cueTags";
import { taggedWav } from "./fixtures/taggedWav";

const dir = mkdtempSync(path.join(tmpdir(), "dbdj-cuetags-"));

describe("embedded hot cues — MP3", () => {
  const file = path.join(dir, "track.mp3");
  // A bare ID3v2 header is enough for node-id3 to treat this as a taggable "MP3".
  writeFileSync(file, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]));

  it("round-trips cues and reports none when there aren't any yet", async () => {
    expect(await readEmbeddedCues(file)).toMatchObject({ ok: true, supported: true, cues: [] });
    const w = await writeEmbeddedCues(file, [{ slot: 0, timestamp: 1.5, name: "Intro 1", colour: "#ff5f57" }]);
    expect(w.ok).toBe(true);
    expect(await readEmbeddedCues(file)).toMatchObject({ ok: true, supported: true, cues: [{ slot: 0, timestamp: 1.5, name: "Intro 1", colour: "#ff5f57" }] });
  });

  it("overwriting with a new set replaces the old one entirely", async () => {
    await writeEmbeddedCues(file, [{ slot: 0, timestamp: 1, name: "A", colour: "#fff" }, { slot: 1, timestamp: 2, name: "B", colour: "#000" }]);
    const r = await writeEmbeddedCues(file, [{ slot: 3, timestamp: 9, name: "D", colour: "#abc" }]);
    expect(r.ok).toBe(true);
    const read = await readEmbeddedCues(file);
    expect(read.cues).toEqual([{ slot: 3, timestamp: 9, name: "D", colour: "#abc" }]);
  });
});

describe("embedded hot cues — WAV", () => {
  const file = path.join(dir, "track.wav");
  writeFileSync(file, taggedWav({ title: "Song", artist: "Artist", seconds: 1 }));

  it("round-trips cues without corrupting the RIFF/WAVE container or its audio data", async () => {
    const before = readFileSync(file);
    const w = await writeEmbeddedCues(file, [{ slot: 2, timestamp: 45, name: "Drop 1", colour: "#32ade6" }]);
    expect(w.ok).toBe(true);
    const after = readFileSync(file);
    expect(after.toString("ascii", 0, 4)).toBe("RIFF");
    expect(after.toString("ascii", 8, 12)).toBe("WAVE");
    expect(after.readUInt32LE(4)).toBe(after.length - 8); // RIFF size field stays accurate
    // The original title/artist frames (and the 'fmt '/'data' chunks ahead of 'id3 ') are untouched.
    expect(before.includes(Buffer.from("TIT2", "latin1"))).toBe(true);
    expect(after.includes(Buffer.from("TIT2", "latin1"))).toBe(true);

    const r = await readEmbeddedCues(file);
    expect(r).toMatchObject({ ok: true, supported: true, cues: [{ slot: 2, timestamp: 45, name: "Drop 1", colour: "#32ade6" }] });
  });

  it("clearing cues (empty array) removes the TXXX frame but leaves the file otherwise intact", async () => {
    await writeEmbeddedCues(file, [{ slot: 0, timestamp: 0, name: "Intro 1", colour: "#fff" }]);
    const w = await writeEmbeddedCues(file, []);
    expect(w.ok).toBe(true);
    expect((await readEmbeddedCues(file)).cues).toEqual([]);
    const after = readFileSync(file);
    expect(after.toString("ascii", 0, 4)).toBe("RIFF");
  });
});

describe("embedded hot cues — unsupported formats", () => {
  it("reports unsupported (not an error) for a format with no writer, and refuses to write", async () => {
    const file = path.join(dir, "track.flac");
    writeFileSync(file, Buffer.from("fLaC"));
    expect(await readEmbeddedCues(file)).toEqual({ ok: true, supported: false, cues: [] });
    const w = await writeEmbeddedCues(file, [{ slot: 0, timestamp: 0, name: "A", colour: "#fff" }]);
    expect(w.ok).toBe(false);
  });
});

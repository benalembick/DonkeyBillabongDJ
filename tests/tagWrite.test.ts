import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { describe, expect, it } from "vitest";
import { readEmbeddedCues, writeEmbeddedCues } from "../electron/library/cueTags";
import { readTags } from "../electron/library/tags";
import { writeTags } from "../electron/library/tagWrite";
import { taggedWav } from "./fixtures/taggedWav";

const dir = mkdtempSync(path.join(tmpdir(), "dbdj-tagwrite-"));

describe("writeTags — MP3", () => {
  const file = path.join(dir, "track.mp3");
  writeFileSync(file, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]));

  it("writes title/artist/album/genre/year and reads them back", async () => {
    const w = await writeTags(file, { title: "New Title", artist: "New Artist", album: "New Album", genre: "House", year: 2021 });
    expect(w).toEqual({ ok: true });
    const [t] = await readTags([file]);
    expect(t).toMatchObject({ ok: true, title: "New Title", artist: "New Artist", album: "New Album", genre: "House", year: 2021 });
  });

  it("only touches the fields given, leaving the rest alone", async () => {
    await writeTags(file, { album: "Другой Album" });
    const [t] = await readTags([file]);
    expect(t).toMatchObject({ title: "New Title", artist: "New Artist", album: "Другой Album", genre: "House", year: 2021 });
  });

  it("rejects an invalid year", async () => {
    const w = await writeTags(file, { year: 12 });
    expect(w.ok).toBe(false);
    expect(w.error).toMatch(/year/i);
  });
});

describe("writeTags — WAV (preserves embedded hot cues)", () => {
  const file = path.join(dir, "track.wav");
  writeFileSync(file, taggedWav({ title: "Song", artist: "Artist", seconds: 1 }));

  it("renames the track without disturbing its embedded hot cues", async () => {
    const cueWrite = await writeEmbeddedCues(file, [{ slot: 0, timestamp: 1.5, name: "Drop", colour: "#fff" }]);
    expect(cueWrite.ok).toBe(true);

    const tagWrite = await writeTags(file, { title: "Renamed Song", artist: "New Artist" });
    expect(tagWrite).toEqual({ ok: true });

    const [t] = await readTags([file]);
    expect(t).toMatchObject({ ok: true, title: "Renamed Song", artist: "New Artist" });
    const cues = await readEmbeddedCues(file);
    expect(cues).toMatchObject({ ok: true, supported: true, cues: [{ slot: 0, timestamp: 1.5, name: "Drop", colour: "#fff" }] });
  });
});

describe("writeTags — FLAC (ffmpeg remux)", () => {
  const file = path.join(dir, "track.flac");

  it("writes tags into a real FLAC file via a lossless remux", async () => {
    execFileSync(ffmpegPath as string, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "title=Orig", file]);
    const before = (await readTags([file]))[0];
    expect(before.title).toBe("Orig");

    const w = await writeTags(file, { title: "Flac Title", artist: "Flac Artist", genre: "Techno", year: 2019 });
    expect(w).toEqual({ ok: true });

    const after = await readTags([file]);
    expect(after[0]).toMatchObject({ ok: true, title: "Flac Title", artist: "Flac Artist", genre: "Techno", year: 2019 });
    expect(after[0].durationMs).toBeGreaterThan(900);
    expect(after[0].durationMs).toBeLessThan(1100);
  }, 15_000);
});

describe("writeTags — unsupported", () => {
  it("reports an error instead of throwing for a file type it can't write", async () => {
    const file = path.join(dir, "track.xyz");
    writeFileSync(file, "not audio");
    const w = await writeTags(file, { title: "x" });
    expect(w.ok).toBe(false);
  });
});

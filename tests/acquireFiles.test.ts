/**
 * Desktop file operations for Spotify → Local (electron/acquire), on real temp folders with
 * generated WAV fixtures — no commercial audio involved.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanPartials, downloadToFile, extFromHeaders, finalizeFile, isPartialName, probeAudio, safeJoin, sanitizeFileName, tempPath, waitForStable, type FetchLike } from "../electron/acquire/fileOps";
import { FolderWatcher, type StableFile } from "../electron/acquire/watcher";

/** A valid PCM WAV of `seconds` of silence (8 kHz mono 16-bit). */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbdj-acquire-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("names and paths", () => {
  it("sanitises file names for Windows and macOS", () => {
    expect(sanitizeFileName('AC/DC: "Back" <in> Black?')).toBe("AC_DC_ _Back_ _in_ Black_");
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("  ...  ")).toBe("track");
    expect(sanitizeFileName("x".repeat(400)).length).toBe(150);
    expect(sanitizeFileName("../../etc/passwd")).not.toContain("/");
  });
  it("refuses paths that escape the destination", () => {
    expect(safeJoin(dir, "a.mp3")).toBe(path.join(dir, "a.mp3"));
    expect(() => safeJoin(dir, "..", "evil.mp3")).toThrow(/escapes/);
    expect(() => safeJoin(dir, path.resolve("/tmp/elsewhere.mp3"))).toThrow(/escapes/);
    expect(() => safeJoin(dir, "")).toThrow(/escapes/);
  });
  it("recognises partial downloads and container types", () => {
    expect(isPartialName("song.mp3.part")).toBe(true);
    expect(isPartialName("song.crdownload")).toBe(true);
    expect(isPartialName(".hidden.mp3")).toBe(true);
    expect(isPartialName("song.mp3")).toBe(false);
    expect(extFromHeaders("audio/mpeg; charset=binary", null)).toBe(".mp3");
    expect(extFromHeaders("application/octet-stream", 'attachment; filename="Track.flac"')).toBe(".flac");
    expect(extFromHeaders("text/html", null)).toBeNull();
  });
});

describe("validation", () => {
  it("reads codec, sample rate and duration from a real file", async () => {
    const p = path.join(dir, "tone.wav");
    await fs.writeFile(p, wav(3));
    const q = await probeAudio(p);
    expect(q).toMatchObject({ sampleRate: 8000, channels: 1, durationMs: 3000 });
    expect(q.sizeBytes).toBeGreaterThan(0);
  });
  it("rejects empty and non-audio files", async () => {
    const empty = path.join(dir, "empty.mp3");
    await fs.writeFile(empty, "");
    await expect(probeAudio(empty)).rejects.toThrow(/empty/);
    const html = path.join(dir, "page.mp3");
    await fs.writeFile(html, "<html>not audio</html>");
    await expect(probeAudio(html)).rejects.toThrow();
  });
  it("waits until a file stops growing", async () => {
    const p = path.join(dir, "growing.wav");
    await fs.writeFile(p, wav(1).subarray(0, 100));
    const done = waitForStable(p, { intervalMs: 20, checks: 2 });
    let finished = false;
    void done.then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 15));
    await fs.appendFile(p, wav(1).subarray(100));
    expect(finished).toBe(false);
    const st = await done;
    expect(st.size).toBe(wav(1).length);
  });
});

describe("finalising downloads", () => {
  it("moves a validated temp file into place and reuses an identical earlier download", async () => {
    await fs.mkdir(path.join(dir, ".dbdj-partial"));
    const t1 = tempPath(dir);
    await fs.writeFile(t1, wav(2));
    const a = await finalizeFile(t1, dir, "Artist - Song [audius 1]", ".wav");
    expect(a).toEqual({ path: path.join(dir, "Artist - Song [audius 1].wav"), reused: false });
    const t2 = tempPath(dir);
    await fs.writeFile(t2, wav(2));
    const b = await finalizeFile(t2, dir, "Artist - Song [audius 1]", ".wav");
    expect(b).toEqual({ path: a.path, reused: true });
    await expect(fs.access(t2)).rejects.toThrow(); // temp removed
    const t3 = tempPath(dir);
    await fs.writeFile(t3, wav(3));
    const c = await finalizeFile(t3, dir, "Artist - Song [audius 1]", ".wav");
    expect(c.path).toBe(path.join(dir, "Artist - Song [audius 1] (2).wav"));
    expect((await fs.readdir(dir)).filter((n) => n.endsWith(".wav")).length).toBe(2);
  });
  it("cleans up interrupted downloads", async () => {
    await fs.mkdir(path.join(dir, ".dbdj-partial"));
    await fs.writeFile(tempPath(dir), "half");
    // Leftovers of the old spotDL bug (dot stripped) are removed too, but only spotDL temp folders.
    await fs.mkdir(path.join(dir, "dbdj-partial", "abc-spotdl"), { recursive: true });
    expect(await cleanPartials(dir)).toBe(2);
    expect(await fs.readdir(path.join(dir, ".dbdj-partial"))).toEqual([]);
    await expect(fs.access(path.join(dir, "dbdj-partial"))).rejects.toThrow();
    await fs.mkdir(path.join(dir, "dbdj-partial", "my-own-folder"), { recursive: true });
    await cleanPartials(dir);
    await expect(fs.access(path.join(dir, "dbdj-partial", "my-own-folder"))).resolves.toBeUndefined();
  });
});

describe("downloading", () => {
  const fakeFetch = (o: { url?: string; status?: number; body?: Buffer; headers?: Record<string, string> }): FetchLike => async () => ({
    ok: (o.status ?? 200) < 400,
    status: o.status ?? 200,
    url: o.url ?? "https://cdn.example/file",
    headers: { get: (n: string) => o.headers?.[n.toLowerCase()] ?? null },
    body: o.body ? new ReadableStream({ start(c) { c.enqueue(new Uint8Array(o.body!)); c.close(); } }) : null,
  });
  it("streams to a file and reports progress", async () => {
    const dest = path.join(dir, "x.part");
    const seen: number[] = [];
    const r = await downloadToFile("https://api.example/x", dest, { fetchImpl: fakeFetch({ body: wav(1), headers: { "content-type": "audio/wav", "content-length": String(wav(1).length) } }), onProgress: (n) => seen.push(n) });
    expect(r.bytes).toBe(wav(1).length);
    expect(seen.at(-1)).toBe(wav(1).length);
    expect((await fs.readFile(dest)).length).toBe(wav(1).length);
  });
  it("refuses non-HTTPS redirects, refusals and oversized files", async () => {
    const dest = path.join(dir, "y.part");
    await expect(downloadToFile("https://a", dest, { fetchImpl: fakeFetch({ url: "http://insecure/x", body: wav(1) }) })).rejects.toThrow(/non-HTTPS/);
    await expect(downloadToFile("https://a", dest, { fetchImpl: fakeFetch({ status: 403 }) })).rejects.toThrow(/not permitted/);
    await expect(downloadToFile("https://a", dest, { fetchImpl: fakeFetch({ body: wav(1), headers: { "content-length": "999999999" } }), maxBytes: 1000 })).rejects.toThrow(/too large/);
  });
});

describe("watching a folder", () => {
  it("reports completed audio files once, ignoring partial and non-audio files", async () => {
    await fs.writeFile(path.join(dir, "existing.wav"), wav(1));
    const got: StableFile[] = [];
    const w = new FolderWatcher({ folder: dir, onFile: (f) => void got.push(f), intervalMs: 20, stableChecks: 2, rescanMs: 50 });
    await w.start();
    await fs.writeFile(path.join(dir, "new.wav.part"), wav(1));
    await fs.writeFile(path.join(dir, "notes.txt"), "hi");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "Artist - Song.wav"), wav(2));
    const until = Date.now() + 3000;
    while (got.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150)); // a few more rescans: no duplicates
    w.stop();
    expect(got.map((f) => f.name).sort()).toEqual(["Artist - Song.wav", "existing.wav"]);
    expect(w.seen).toBe(2);
  });
  it("re-reports a file that is replaced, and errors clearly for a missing folder", async () => {
    const got: string[] = [];
    const w = new FolderWatcher({ folder: dir, onFile: (f) => void got.push(`${f.name}:${f.size}`), intervalMs: 20, stableChecks: 2, rescanMs: 40, initialScan: false });
    await w.start();
    await fs.writeFile(path.join(dir, "a.wav"), wav(1));
    let until = Date.now() + 3000;
    while (got.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 30));
    await fs.writeFile(path.join(dir, "a.wav"), wav(2));
    until = Date.now() + 3000;
    while (got.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    w.stop();
    expect(got).toEqual([`a.wav:${wav(1).length}`, `a.wav:${wav(2).length}`]);
    await expect(new FolderWatcher({ folder: path.join(dir, "nope"), onFile: () => undefined }).start()).rejects.toThrow(/not found/);
  });
});

/**
 * ID3v2 tag I/O shared by cueTags.ts (embedded hot cues) and tagWrite.ts
 * (title/artist/album/genre/year): reading an MP3's tag is native to
 * node-id3, but WAV needs the RIFF 'id3 ' chunk handled by hand since
 * ID3v2 isn't native to RIFF — Picard/Mp3tag/foobar2000/music-metadata
 * all recognise it carried that way, so that's what's read/written here
 * too, never prepended raw (which would corrupt the RIFF/WAVE magic).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import * as NodeID3 from "node-id3";

export type Id3Container = "mp3" | "wav";

export function id3Container(filePath: string): Id3Container | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "mp3";
  if (ext === ".wav") return "wav";
  return null;
}

export interface RiffChunk { id: string; dataStart: number; size: number }

/** Every top-level chunk's id/offset/size; throws if `buf` isn't a RIFF/WAVE file. */
export function parseRiffChunks(buf: Buffer): RiffChunk[] {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    chunks.push({ id, dataStart, size });
    offset = dataStart + size + (size % 2); // chunks are word-aligned: a pad byte follows an odd-sized one
  }
  return chunks;
}

export function findId3Chunk(chunks: RiffChunk[]): RiffChunk | undefined {
  return chunks.find((c) => c.id === "id3 " || c.id === "ID3 ");
}

export async function readWavId3Tags(filePath: string): Promise<NodeID3.Tags> {
  const buf = await fs.readFile(filePath);
  const chunk = findId3Chunk(parseRiffChunks(buf));
  if (!chunk) return {};
  return NodeID3.Promise.read(buf.subarray(chunk.dataStart, chunk.dataStart + chunk.size));
}

/** Replaces (or adds) the 'id3 ' chunk with a fresh tag built from exactly `tags`, leaving every other chunk — and the audio data — byte-identical. */
export async function writeWavId3Tags(filePath: string, tags: NodeID3.Tags): Promise<void> {
  let buf = await fs.readFile(filePath);
  const chunks = parseRiffChunks(buf);
  const existing = findId3Chunk(chunks);
  const fresh = await NodeID3.Promise.create(tags);
  if (existing) {
    const end = existing.dataStart + existing.size + (existing.size % 2);
    buf = Buffer.concat([buf.subarray(0, existing.dataStart - 8), buf.subarray(end)]);
  }
  const header = Buffer.alloc(8);
  header.write("id3 ", 0, "ascii");
  header.writeUInt32LE(fresh.length, 4);
  const pad = fresh.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  buf = Buffer.concat([buf, header, fresh, pad]);
  buf.writeUInt32LE(buf.length - 8, 4); // RIFF container size = whole file minus the 'RIFF'+size field itself
  await fs.writeFile(filePath, buf);
}

export async function readId3Tags(filePath: string, kind: Id3Container): Promise<NodeID3.Tags> {
  return kind === "mp3" ? NodeID3.Promise.read(filePath) : readWavId3Tags(filePath);
}

export async function writeId3Tags(filePath: string, kind: Id3Container, tags: NodeID3.Tags): Promise<void> {
  if (kind === "mp3") await NodeID3.Promise.write(tags, filePath);
  else await writeWavId3Tags(filePath, tags);
}

/** `tags.raw` only ever comes back from a read, as an informational mirror of the frames above it — never valid write input. */
export function withoutRaw(tags: NodeID3.Tags): NodeID3.Tags {
  const { raw: _raw, ...rest } = tags;
  return rest;
}

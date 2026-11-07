/**
 * Reads/writes hot cues embedded directly in a local audio file's own ID3v2 tag,
 * in a private TXXX frame, so they travel with the file independent of this
 * app's preparation database. Other tag frames (title, artist, artwork…) are
 * read back in and written out unchanged alongside it.
 *
 * MP3: the tag lives at the start of the file (node-id3's normal file mode).
 * WAV: ID3v2 isn't native to RIFF, but Picard/Mp3tag/foobar2000/music-metadata
 * all recognise it carried in an 'id3 ' (or 'ID3 ') RIFF chunk, so that's what
 * we read/write here too — never prepended raw, which would corrupt the file
 * (RIFF readers require the 'RIFF'/'WAVE' magic at byte 0).
 * Other containers (FLAC, M4A/AAC, OGG/Opus, AIFF…) use entirely different
 * metadata systems and aren't supported yet.
 *
 * Every write re-reads the full existing tag first and writes back a complete,
 * explicit tag object (node-id3's `write`/`create`, not `update`): `update`
 * can't be trusted to remove a frame when told its new value is an empty
 * array, which would leave stale cues behind when the last one is deleted.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import * as NodeID3 from "node-id3";
import type { EmbeddedCue, EmbeddedCueResult } from "../../src/library/embeddedCues";

const CUE_FRAME = "DBDJ_HOTCUES_V1";

type Container = "mp3" | "wav";

function container(filePath: string): Container | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "mp3";
  if (ext === ".wav") return "wav";
  return null;
}

function isValidCue(c: unknown): c is EmbeddedCue {
  const v = c as Partial<EmbeddedCue> | null;
  return !!v && Number.isInteger(v.slot) && v.slot! >= 0 && v.slot! < 8
    && typeof v.timestamp === "number" && Number.isFinite(v.timestamp) && v.timestamp >= 0
    && typeof v.name === "string" && typeof v.colour === "string";
}

// ───────────────────────── RIFF/WAVE 'id3 ' chunk ─────────────────────────

interface RiffChunk { id: string; dataStart: number; size: number }

/** Every top-level chunk's id/offset/size; throws if `buf` isn't a RIFF/WAVE file. */
function parseRiffChunks(buf: Buffer): RiffChunk[] {
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

function findId3Chunk(chunks: RiffChunk[]): RiffChunk | undefined {
  return chunks.find((c) => c.id === "id3 " || c.id === "ID3 ");
}

async function readWavId3Tags(filePath: string): Promise<NodeID3.Tags> {
  const buf = await fs.readFile(filePath);
  const chunk = findId3Chunk(parseRiffChunks(buf));
  if (!chunk) return {};
  return NodeID3.Promise.read(buf.subarray(chunk.dataStart, chunk.dataStart + chunk.size));
}

/** Replaces (or adds) the 'id3 ' chunk with a fresh tag built from exactly `tags`, leaving every other chunk — and the audio data — byte-identical. */
async function writeWavId3Tags(filePath: string, tags: NodeID3.Tags): Promise<void> {
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

async function readTags(filePath: string, kind: Container): Promise<NodeID3.Tags> {
  return kind === "mp3" ? NodeID3.Promise.read(filePath) : readWavId3Tags(filePath);
}

/** `tags.raw` only ever comes back from a read, as an informational mirror of the frames above it — never valid write input. */
function withoutRaw(tags: NodeID3.Tags): NodeID3.Tags {
  const { raw: _raw, ...rest } = tags;
  return rest;
}

// ───────────────────────────────── public API ─────────────────────────────────

export async function readEmbeddedCues(filePath: string): Promise<EmbeddedCueResult> {
  const kind = container(filePath);
  if (!kind) return { ok: true, supported: false, cues: [] };
  try {
    const tags = await readTags(filePath, kind);
    const frame = tags.userDefinedText?.find((t) => t.description === CUE_FRAME);
    if (!frame) return { ok: true, supported: true, cues: [] };
    const parsed: unknown = JSON.parse(frame.value);
    return { ok: true, supported: true, cues: Array.isArray(parsed) ? parsed.filter(isValidCue) : [] };
  } catch (err) {
    return { ok: false, supported: true, cues: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeEmbeddedCues(filePath: string, cues: EmbeddedCue[]): Promise<{ ok: boolean; error?: string }> {
  const kind = container(filePath);
  if (!kind) return { ok: false, error: "Embedded hot cues are only supported for MP3 and WAV files." };
  try {
    const existing = await readTags(filePath, kind);
    const others = (existing.userDefinedText ?? []).filter((t) => t.description !== CUE_FRAME);
    const clean = cues.filter(isValidCue).map((c) => ({ slot: c.slot, timestamp: c.timestamp, name: c.name, colour: c.colour }));
    const userDefinedText = clean.length ? [...others, { description: CUE_FRAME, value: JSON.stringify(clean) }] : others;
    const merged = withoutRaw({ ...existing, userDefinedText });
    if (kind === "mp3") await NodeID3.Promise.write(merged, filePath);
    else await writeWavId3Tags(filePath, merged);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

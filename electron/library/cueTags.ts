/**
 * Reads/writes hot cues embedded directly in a local audio file's own ID3v2 tag,
 * in a private TXXX frame, so they travel with the file independent of this
 * app's preparation database. Other tag frames (title, artist, artwork…) are
 * read back in and written out unchanged alongside it.
 *
 * MP3/WAV tag I/O (including the WAV RIFF 'id3 ' chunk) lives in id3Riff.ts,
 * shared with tagWrite.ts (title/artist/album/genre/year editing).
 * Other containers (FLAC, M4A/AAC, OGG/Opus, AIFF…) use entirely different
 * metadata systems and aren't supported yet.
 *
 * Every write re-reads the full existing tag first and writes back a complete,
 * explicit tag object (node-id3's `write`/`create`, not `update`): `update`
 * can't be trusted to remove a frame when told its new value is an empty
 * array, which would leave stale cues behind when the last one is deleted.
 */
import type * as NodeID3 from "node-id3";
import type { EmbeddedCue, EmbeddedCueResult } from "../../src/library/embeddedCues";
import { id3Container, readId3Tags, withoutRaw, writeId3Tags } from "./id3Riff";

const CUE_FRAME = "DBDJ_HOTCUES_V1";

function isValidCue(c: unknown): c is EmbeddedCue {
  const v = c as Partial<EmbeddedCue> | null;
  return !!v && Number.isInteger(v.slot) && v.slot! >= 0 && v.slot! < 8
    && typeof v.timestamp === "number" && Number.isFinite(v.timestamp) && v.timestamp >= 0
    && typeof v.name === "string" && typeof v.colour === "string";
}

export async function readEmbeddedCues(filePath: string): Promise<EmbeddedCueResult> {
  const kind = id3Container(filePath);
  if (!kind) return { ok: true, supported: false, cues: [] };
  try {
    const tags = await readId3Tags(filePath, kind);
    const frame = tags.userDefinedText?.find((t: { description: string }) => t.description === CUE_FRAME);
    if (!frame) return { ok: true, supported: true, cues: [] };
    const parsed: unknown = JSON.parse(frame.value);
    return { ok: true, supported: true, cues: Array.isArray(parsed) ? parsed.filter(isValidCue) : [] };
  } catch (err) {
    return { ok: false, supported: true, cues: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeEmbeddedCues(filePath: string, cues: EmbeddedCue[]): Promise<{ ok: boolean; error?: string }> {
  const kind = id3Container(filePath);
  if (!kind) return { ok: false, error: "Embedded hot cues are only supported for MP3 and WAV files." };
  try {
    const existing = await readId3Tags(filePath, kind);
    const others = (existing.userDefinedText ?? []).filter((t: { description: string }) => t.description !== CUE_FRAME);
    const clean = cues.filter(isValidCue).map((c) => ({ slot: c.slot, timestamp: c.timestamp, name: c.name, colour: c.colour }));
    const userDefinedText: NodeID3.Tags["userDefinedText"] = clean.length ? [...others, { description: CUE_FRAME, value: JSON.stringify(clean) }] : others;
    const merged = withoutRaw({ ...existing, userDefinedText });
    await writeId3Tags(filePath, kind, merged);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

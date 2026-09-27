/**
 * Deterministic cache key for an audio file: SHA-256 of the audio payload,
 * excluding ID3v2 (start) and ID3v1 (last 128 bytes) tag blocks, so renaming a
 * file or editing its MP3 tags doesn't trigger a new analysis.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export async function fileKey(filePath: string): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const { size } = await fh.stat();
    let start = 0;
    let end = size;
    const head = Buffer.alloc(10);
    await fh.read(head, 0, 10, 0);
    if (head.toString("latin1", 0, 3) === "ID3") {
      const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      start = 10 + tagSize + (head[5] & 0x10 ? 10 : 0);
    }
    if (size >= 128) {
      const tail = Buffer.alloc(3);
      await fh.read(tail, 0, 3, size - 128);
      if (tail.toString("latin1") === "TAG") end = size - 128;
    }
    const hash = createHash("sha256");
    const buf = Buffer.alloc(1 << 20);
    for (let pos = start; pos < end; ) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return hash.digest("hex").slice(0, 40);
  } finally {
    await fh.close();
  }
}

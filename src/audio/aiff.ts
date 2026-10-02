/**
 * AIFF / AIFF-C support. Chromium's decodeAudioData can't read AIFF (common in
 * Mac DJ libraries), so the PCM is rewritten as a WAV, which it can decode and
 * resample like any other file. Handles uncompressed big-endian PCM (AIFF,
 * AIFC NONE/twos), little-endian PCM (sowt) and floating point (fl32/fl64).
 */

export function isAiff(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  const v = new DataView(bytes);
  const form = tag(v, 0);
  const kind = tag(v, 8);
  return form === "FORM" && (kind === "AIFF" || kind === "AIFC");
}

/** WAV bytes for an AIFF/AIFC file, or null if it isn't one we can convert. */
export function aiffToWav(bytes: ArrayBuffer): ArrayBuffer | null {
  if (!isAiff(bytes)) return null;
  const v = new DataView(bytes);
  const aifc = tag(v, 8) === "AIFC";
  let comm: { channels: number; frames: number; bits: number; rate: number; compression: string } | null = null;
  let data: { start: number; end: number } | null = null;
  for (let p = 12; p + 8 <= bytes.byteLength; ) {
    const id = tag(v, p);
    const size = v.getUint32(p + 4);
    const body = p + 8;
    if (id === "COMM" && size >= 18) {
      comm = {
        channels: v.getUint16(body),
        frames: v.getUint32(body + 2),
        bits: v.getUint16(body + 6),
        rate: extended80(v, body + 8),
        compression: aifc && size >= 22 ? tag(v, body + 18) : "NONE",
      };
    } else if (id === "SSND" && size >= 8) {
      const offset = v.getUint32(body);
      // Some writers leave the size at 0 or too large for streamed files: clamp to the file.
      data = { start: body + 8 + offset, end: Math.min(bytes.byteLength, size > 8 ? body + size : bytes.byteLength) };
    }
    p = body + size + (size & 1);
    if (size === 0 && id !== "SSND") break;
  }
  if (!comm || !data || comm.channels < 1 || !(comm.rate > 0)) return null;

  const c = comm.compression.toLowerCase();
  const float = c === "fl32" || c === "fl64";
  if (!float && !["none", "twos", "sowt"].includes(c)) return null; // compressed AIFC (ima4, ulaw…)
  const inBytes = float ? (c === "fl64" ? 8 : 4) : Math.ceil(comm.bits / 8);
  if (!float && (inBytes < 1 || inBytes > 4)) return null;
  const outBytes = float ? 4 : inBytes;
  const littleEndian = c === "sowt";
  const frameIn = inBytes * comm.channels;
  const frames = Math.min(comm.frames || Infinity, Math.floor((data.end - data.start) / frameIn));
  if (!(frames > 0)) return null;
  const samples = frames * comm.channels;

  const dataSize = samples * outBytes;
  const out = new ArrayBuffer(44 + dataSize + (dataSize & 1));
  const w = new DataView(out);
  writeTag(w, 0, "RIFF");
  w.setUint32(4, out.byteLength - 8, true);
  writeTag(w, 8, "WAVE");
  writeTag(w, 12, "fmt ");
  w.setUint32(16, 16, true);
  w.setUint16(20, float ? 3 : 1, true); // 3 = IEEE float
  w.setUint16(22, comm.channels, true);
  w.setUint32(24, Math.round(comm.rate), true);
  w.setUint32(28, Math.round(comm.rate) * comm.channels * outBytes, true);
  w.setUint16(32, comm.channels * outBytes, true);
  w.setUint16(34, outBytes * 8, true);
  writeTag(w, 36, "data");
  w.setUint32(40, dataSize, true);

  const src = new Uint8Array(bytes, data.start, samples * inBytes);
  const dst = new Uint8Array(out, 44, dataSize);
  if (float) {
    const sv = new DataView(bytes, data.start, samples * inBytes);
    const dv = new DataView(out, 44, dataSize);
    for (let i = 0; i < samples; i++) dv.setFloat32(i * 4, inBytes === 8 ? sv.getFloat64(i * 8) : sv.getFloat32(i * 4), true);
  } else if (inBytes === 1) {
    for (let i = 0; i < samples; i++) dst[i] = (src[i] + 128) & 0xff; // AIFF 8-bit is signed, WAV 8-bit unsigned
  } else if (littleEndian) {
    dst.set(src);
  } else {
    for (let i = 0; i < samples; i++) {
      const o = i * inBytes;
      for (let b = 0; b < inBytes; b++) dst[o + b] = src[o + inBytes - 1 - b];
    }
  }
  return out;
}

function tag(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

function writeTag(v: DataView, at: number, s: string): void {
  for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
}

/** IEEE 754 80-bit extended (AIFF sample rate). */
function extended80(v: DataView, at: number): number {
  const se = v.getUint16(at);
  const exp = (se & 0x7fff) - 16383;
  const hi = v.getUint32(at + 2);
  const lo = v.getUint32(at + 6);
  const value = hi * 2 ** (exp - 31) + lo * 2 ** (exp - 63);
  return se & 0x8000 ? -value : value;
}

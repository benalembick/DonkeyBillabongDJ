/** Builds small AIFF / AIFF-C files for tests. */
export type AiffKind = "aiff16" | "aiff24" | "aiff8" | "sowt16" | "fl32";

export function sine(frames: number, channels: number, rate = 44100): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin((2 * Math.PI * (440 + 110 * c) * i) / rate)));
}

function ext80(rate: number): Uint8Array {
  const b = new Uint8Array(10), v = new DataView(b.buffer);
  const e = Math.floor(Math.log2(rate));
  v.setUint16(0, 16383 + e);
  v.setUint32(2, Math.floor((rate / 2 ** e) * 2 ** 31));
  return b;
}

export function makeAiff(kind: AiffKind, data: Float32Array[], rate = 44100): ArrayBuffer {
  const ch = data.length, frames = data[0].length;
  const aifc = kind === "sowt16" || kind === "fl32";
  const bytesPer = kind === "aiff8" ? 1 : kind === "aiff24" ? 3 : kind === "fl32" ? 4 : 2;
  const commSize = aifc ? 24 : 18;
  const ssndBody = 8 + frames * ch * bytesPer;
  const total = 12 + 8 + commSize + 8 + ssndBody;
  const out = new ArrayBuffer(total), v = new DataView(out), u = new Uint8Array(out);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) u[at + i] = s.charCodeAt(i); };
  tag(0, "FORM"); v.setUint32(4, total - 8); tag(8, aifc ? "AIFC" : "AIFF");
  tag(12, "COMM"); v.setUint32(16, commSize);
  v.setUint16(20, ch); v.setUint32(22, frames); v.setUint16(26, kind === "fl32" ? 32 : bytesPer * 8); u.set(ext80(rate), 28);
  if (aifc) { tag(38, kind === "sowt16" ? "sowt" : "fl32"); v.setUint16(42, 0); }
  const s = 12 + 8 + commSize;
  tag(s, "SSND"); v.setUint32(s + 4, ssndBody); v.setUint32(s + 8, 0); v.setUint32(s + 12, 0);
  let p = s + 16;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < ch; c++) {
      const x = data[c][i];
      if (kind === "fl32") v.setFloat32(p, x);
      else if (kind === "aiff8") v.setInt8(p, Math.round(x * 127));
      else if (kind === "aiff24") { const n = Math.round(x * 8388607); v.setUint8(p, (n >> 16) & 0xff); v.setUint8(p + 1, (n >> 8) & 0xff); v.setUint8(p + 2, n & 0xff); }
      else v.setInt16(p, Math.round(x * 32767), kind === "sowt16");
      p += bytesPer;
    }
  return out;
}

/** Builds a small WAV file with an embedded ID3v2.3 tag ("id3 " RIFF chunk) for tag-reading tests. */
export function taggedWav(opts: { title: string; artist: string; isrc?: string; seconds?: number; sampleRate?: number; cover?: Buffer }): Buffer {
  const sr = opts.sampleRate ?? 44100;
  const n = Math.round(sr * (opts.seconds ?? 2));
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 330 * i) / sr) * 0.2 * 32767);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const frame = (id: string, text: string) => {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
    const h = Buffer.alloc(10);
    h.write(id, 0, "latin1");
    h.writeUInt32BE(data.length, 4);
    return Buffer.concat([h, data]);
  };
  const pictures: Buffer[] = [];
  if (opts.cover) {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from("image/png\0", "latin1"), Buffer.from([3, 0]), opts.cover]);
    const header = Buffer.alloc(10);
    header.write("APIC"); header.writeUInt32BE(data.length, 4);
    pictures.push(Buffer.concat([header, data]));
  }
  const frames = Buffer.concat([frame("TIT2", opts.title), frame("TPE1", opts.artist), ...(opts.isrc ? [frame("TSRC", opts.isrc)] : []), ...pictures]);
  const size = frames.length;
  const id3 = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
    frames,
  ]);
  const chunk = (id: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, "latin1");
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(sr, 4);
  fmt.writeUInt32LE(sr * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), chunk("fmt ", fmt), chunk("data", pcm), chunk("id3 ", id3)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

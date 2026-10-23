export const WAV_RATE = 48_000, WAV_CHANNELS = 2, WAV_BITS = 16;

export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(WAV_RATE, 24);
  header.writeUInt32LE(WAV_RATE * WAV_CHANNELS * WAV_BITS / 8, 28);
  header.writeUInt16LE(WAV_CHANNELS * WAV_BITS / 8, 32);
  header.writeUInt16LE(WAV_BITS, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

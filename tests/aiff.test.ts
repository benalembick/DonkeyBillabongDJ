import { describe, expect, it } from "vitest";
import { aiffToWav, isAiff } from "../src/audio/aiff";
import { makeAiff, sine, type AiffKind } from "./helpers/aiffFixture";

/** Minimal WAV reader for checking the conversion. */
function readWav(buf: ArrayBuffer) {
  const v = new DataView(buf);
  const tag = (at: number) => String.fromCharCode(...new Uint8Array(buf, at, 4));
  expect(tag(0)).toBe("RIFF");
  expect(tag(8)).toBe("WAVE");
  const format = v.getUint16(20, true), channels = v.getUint16(22, true), rate = v.getUint32(24, true), bits = v.getUint16(34, true);
  const size = v.getUint32(40, true), bytes = bits / 8, frames = size / bytes / channels;
  const sample = (i: number, c: number) => {
    const at = 44 + (i * channels + c) * bytes;
    if (format === 3) return v.getFloat32(at, true);
    if (bytes === 1) return (v.getUint8(at) - 128) / 127;
    if (bytes === 2) return v.getInt16(at, true) / 32767;
    const n = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16);
    return n / 8388607;
  };
  return { format, channels, rate, bits, frames, sample };
}

describe("AIFF → WAV (Chromium can't decode AIFF)", () => {
  const data = sine(1000, 2);
  const cases: [AiffKind, number, number, number][] = [
    ["aiff16", 1, 16, 1 / 30000],
    ["aiff24", 1, 24, 1e-6],
    ["aiff8", 1, 8, 1 / 100],
    ["sowt16", 1, 16, 1 / 30000],
    ["fl32", 3, 32, 1e-7],
  ];
  for (const [kind, format, bits, tolerance] of cases) {
    it(`converts ${kind} sample-accurately`, () => {
      const aiff = makeAiff(kind, data);
      expect(isAiff(aiff)).toBe(true);
      const wav = readWav(aiffToWav(aiff)!);
      expect(wav).toMatchObject({ format, bits, channels: 2, rate: 44100, frames: 1000 });
      for (const i of [0, 1, 17, 500, 999]) for (const c of [0, 1]) expect(Math.abs(wav.sample(i, c) - data[c][i])).toBeLessThanOrEqual(tolerance);
    });
  }

  it("reads non-44.1k sample rates and mono", () => {
    const wav = readWav(aiffToWav(makeAiff("aiff16", sine(480, 1, 48000), 48000))!);
    expect(wav).toMatchObject({ channels: 1, rate: 48000, frames: 480 });
  });

  it("leaves other files alone", () => {
    expect(isAiff(new TextEncoder().encode("RIFF....WAVEfmt ").buffer)).toBe(false);
    expect(aiffToWav(new ArrayBuffer(4))).toBeNull();
  });

  it("survives a truncated file (keeps the complete frames)", () => {
    const full = makeAiff("aiff16", data);
    const wav = readWav(aiffToWav(full.slice(0, full.byteLength - 1001))!);
    expect(wav.frames).toBe(1000 - Math.ceil(1001 / 4));
  });
});

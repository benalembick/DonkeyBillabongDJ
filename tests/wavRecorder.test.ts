import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { prepareRecordingOutput, recordingOutputFormat } from "../electron/acquire/recordingOutput";
import { wavHeader, WAV_BITS, WAV_CHANNELS, WAV_RATE } from "../electron/acquire/wav";

describe("native recorder WAV output", () => {
  it("describes the exact PCM stream provided by Windows process loopback", () => {
    const header = wavHeader(192_000);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.readUInt32LE(4)).toBe(192_036);
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.readUInt16LE(20)).toBe(1);
    expect(header.readUInt16LE(22)).toBe(WAV_CHANNELS);
    expect(header.readUInt32LE(24)).toBe(WAV_RATE);
    expect(header.readUInt16LE(34)).toBe(WAV_BITS);
    expect(header.readUInt32LE(40)).toBe(192_000);
  });

  it("uses MP3 by default while preserving WAV when selected", () => {
    expect(recordingOutputFormat("Recording.mp3")).toBe("mp3");
    expect(recordingOutputFormat("Recording.wav")).toBe("wav");
    expect(recordingOutputFormat("Recording.WAV")).toBe("wav");
  });

  it("encodes the captured WAV as a playable 320 kbps MP3", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "dbdj-mp3-test-"));
    try {
      const frames = WAV_RATE;
      const pcm = Buffer.alloc(frames * WAV_CHANNELS * (WAV_BITS / 8));
      for (let frame = 0; frame < frames; frame++) {
        const sample = Math.round(Math.sin((frame / WAV_RATE) * Math.PI * 2 * 440) * 12_000);
        for (let channel = 0; channel < WAV_CHANNELS; channel++) pcm.writeInt16LE(sample, (frame * WAV_CHANNELS + channel) * 2);
      }
      const wavPath = path.join(directory, "input.wav");
      writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));
      const mp3Path = await prepareRecordingOutput(wavPath, directory, "mp3");
      const metadata = await parseFile(mp3Path);
      expect(readFileSync(mp3Path).length).toBeGreaterThan(30_000);
      expect(metadata.format.container).toBe("MPEG");
      expect(metadata.format.duration).toBeCloseTo(1, 1);
      expect(metadata.format.bitrate).toBeGreaterThan(300_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

import { describe, expect, it } from "vitest";
import { analyzeTrack, DISPLAY_KEYS } from "../src/analysis/analyzeTrack";
import { packWaveform, unpackWaveform } from "../src/preparation/types";
import { hsvColor, rgbColor, waveData } from "../src/ui/waveStyle";

const SR = 44100;
const tone = (hz: number, secs = 2, amp = 0.5) => {
  const a = new Float32Array(SR * secs);
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return a;
};
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;

describe("waveform display bands", () => {
  it.each([
    [60, "lowL"],
    [1000, "midL"],
    [9000, "highL"],
  ] as const)("a %d Hz tone lands in %s", (hz, band) => {
    const x = tone(hz);
    const a = analyzeTrack([x, x], SR, 100);
    const b = a.bands!;
    const bands = { lowL: mean(b.lowL), midL: mean(b.midL), highL: mean(b.highL) };
    const winner = Object.entries(bands).sort((p, q) => q[1] - p[1])[0][0];
    expect(winner).toBe(band);
    expect(b.stereo).toBe(false); // the same buffer for both channels is mono
  });

  it("keeps left and right separate for stereo material", () => {
    const l = tone(440);
    const r = new Float32Array(l.length); // silent right channel
    const b = analyzeTrack([l, r], SR, 100).bands!;
    expect(b.stereo).toBe(true);
    expect(mean(b.allL)).toBeGreaterThan(0.4);
    expect(mean(b.allR)).toBeLessThan(1e-6);
  });

  it("mono sources duplicate L into R", () => {
    const x = tone(440);
    const b = analyzeTrack([x], SR, 100).bands!;
    expect(b.stereo).toBe(false);
    expect(Array.from(b.allR)).toEqual(Array.from(b.allL));
  });

  it("round-trips through the waveform cache (8-bit) and old caches still load", () => {
    const l = tone(120);
    const r = tone(5000);
    const a = analyzeTrack([l, r], SR, 100);
    const back = unpackWaveform(packWaveform("t", a));
    for (const k of DISPLAY_KEYS) {
      const src = a.bands![k];
      const got = back.bands![k];
      expect(got.length).toBe(src.length);
      const max = Math.max(...src, 1e-9);
      for (let i = 0; i < src.length; i += 17) expect(Math.abs(got[i] - src[i])).toBeLessThan(max * 0.02);
    }
    const legacy = packWaveform("t", { ...a, bands: undefined });
    expect(legacy.bands).toBeUndefined();
    const old = unpackWaveform(legacy);
    expect(old.bands).toBeUndefined();
    expect(waveData(old).n).toBe(a.low.length); // falls back to the mono bands
  });
});

describe("waveform colours", () => {
  const rgb = (s: string) => s.match(/\d+/g)!.map(Number);
  it("RGB maps low/mid/high to red/green/blue and mixes overlaps", () => {
    expect(rgbColor(1, 0, 0)).toBe("rgb(255,0,0)");
    expect(rgbColor(0, 1, 0)).toBe("rgb(0,255,0)");
    expect(rgbColor(0, 0, 1)).toBe("rgb(0,0,255)");
    const [r, g, b] = rgb(rgbColor(1, 1, 0)); // kick + vocal → yellow
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(0);
    const [pr, , pb] = rgb(rgbColor(1, 0, 0.6)); // kick + hats → purple/magenta
    expect(pr).toBe(255);
    expect(pb).toBeGreaterThan(120);
  });

  it("HSV: highs are less saturated, strong lows are darker", () => {
    const sat = (s: string) => {
      const c = rgb(s);
      return (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    };
    const val = (s: string) => Math.max(...rgb(s)) / 255;
    expect(sat(hsvColor(0, 0, 1))).toBeLessThan(sat(hsvColor(0, 1, 0)));
    expect(val(hsvColor(1, 0, 0))).toBeLessThan(val(hsvColor(0, 1, 0)));
  });
});

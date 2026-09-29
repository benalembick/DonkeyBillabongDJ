import { describe, expect, it } from "vitest";
import { analyzeTrack, DISPLAY_KEYS } from "../src/analysis/analyzeTrack";
import { packWaveform, unpackWaveform } from "../src/preparation/types";
import { deckEq, drawColumn, EqSmoother, hsvColor, rgbColor, waveData } from "../src/ui/waveStyle";
import { eqVisualGain } from "../src/core/engine/mixerMath";

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
    // 8-bit values are scaled to the loudest band of the track: error is judged against that scale.
    const scale = Math.max(...DISPLAY_KEYS.map((k) => Math.max(...a.bands![k])));
    for (const k of DISPLAY_KEYS) {
      const src = a.bands![k];
      const got = back.bands![k];
      expect(got.length).toBe(src.length);
      for (let i = 0; i < src.length; i += 17) expect(Math.abs(got[i] - src[i])).toBeLessThan(scale * 0.01);
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

describe("EQ-reactive waveforms", () => {
  /** Bar sink that records what would be drawn (colour as #rrggbb). */
  const recorder = () => {
    const bars: { color: string; len: number }[] = [];
    const g = { bar: (_p: number, _from: number, len: number, rgb: number) => len > 0 && bars.push({ color: `#${rgb.toString(16).padStart(6, "0")}`, len }) };
    return { g, bars };
  };
  // One column with strong bass + vocals (orange/yellow in RGB), a little high end.
  const col = { L: [1, 0.9, 0.8, 0.1] as [number, number, number, number], R: [1, 0.9, 0.8, 0.1] as [number, number, number, number] };
  const data = { fps: 150, n: 1, L: null, R: null, stereo: false, normAll: 1, normBand: 1 } as unknown as Parameters<typeof drawColumn>[3];
  const draw = (style: Parameters<typeof drawColumn>[1], eq?: readonly [number, number, number]) => {
    const r = recorder();
    drawColumn(r.g, style, col, data, 0, 50, 50, false, eq);
    return r.bars;
  };
  const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  it("maps EQ knobs through the audio EQ curve: centre = 1, kill/full cut = 0, boost compressed", () => {
    expect(eqVisualGain(0.5, false)).toBe(1);
    expect(eqVisualGain(0.5, true)).toBe(0);
    expect(eqVisualGain(0, false)).toBe(0);
    const quarter = eqVisualGain(0.25, false);
    expect(quarter).toBeGreaterThan(0.1);
    expect(quarter).toBeLessThan(0.5);
    expect(eqVisualGain(1, false)).toBeCloseTo(1.5, 1);
  });

  it("RGB: turning LOW down removes red; killing it leaves green; neutral restores the original", () => {
    const [before] = draw("rgb");
    const [r0, g0] = rgbOf(before.color);
    expect(r0).toBe(255); // bass + vocals → orange/yellow
    expect(g0).toBeGreaterThan(200);
    const [half] = draw("rgb", [0.3, 1, 1]);
    expect(rgbOf(half.color)[0]).toBeLessThan(r0);
    const [killed] = draw("rgb", [0, 1, 1]);
    const [rk, gk] = rgbOf(killed.color);
    expect(rk).toBe(0);
    expect(gk).toBe(255);
    expect(killed.len).toBeLessThan(before.len); // less is audible → smaller waveform
    const [restored] = draw("rgb", [1, 1, 1]);
    expect(restored).toEqual(before);
  });

  it("Filtered: a killed band's layer disappears, the others stay", () => {
    const colours = (bars: { color: string; len: number }[]) => bars.filter((b) => b.len > 0).map((b) => b.color);
    expect(colours(draw("filtered"))).toEqual(["#ff3b30", "#30d158", "#2f7bff"]);
    expect(colours(draw("filtered", [0, 1, 1]))).toEqual(["#30d158", "#2f7bff"]);
    expect(colours(draw("filtered", [1, 1, 0]))).toEqual(["#ff3b30", "#30d158"]);
  });

  it("boosts grow the waveform only a little (no blow-out)", () => {
    const [n] = draw("rgb");
    const [b] = draw("rgb", [1.5, 1.5, 1.5]);
    expect(b.len).toBeGreaterThanOrEqual(n.len);
    expect(b.len).toBeLessThanOrEqual(100); // clamped to the lane
    expect(rgbOf(b.color).every((c) => c <= 255)).toBe(true);
  });

  it("each deck uses its own EQ", () => {
    const ch = (low: number, killLow = false) => ({ eqLow: low, eqMid: 0.5, eqHigh: 0.5, killLow, killMid: false, killHigh: false });
    const state = { mixer: { channels: [ch(0.5, true), ch(0.5)] } } as unknown as Parameters<typeof deckEq>[0];
    expect(deckEq(state, 0)).toEqual([0, 1, 1]);
    expect(deckEq(state, 1)).toEqual([1, 1, 1]);
  });

  it("smooths knob moves quickly and settles exactly on the target", () => {
    const s = new EqSmoother();
    let t = 1000;
    s.step([1, 1, 1], t);
    const first = s.step([0, 1, 1], (t += 16)).gains[0];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    let last = first;
    for (let i = 0; i < 20; i++) last = s.step([0, 1, 1], (t += 16)).gains[0];
    expect(last).toBe(0);
  });

  it("cached display bands from other crossovers are ignored (upgraded on next load)", () => {
    const x = tone(100);
    const rec = packWaveform("t", analyzeTrack([x, x], SR, 50));
    expect(unpackWaveform(rec).bands).toBeDefined();
    const stale = { ...rec, bands: { ...rec.bands!, xover: [250, 4000] as [number, number] } };
    expect(unpackWaveform(stale).bands).toBeUndefined();
  });
});

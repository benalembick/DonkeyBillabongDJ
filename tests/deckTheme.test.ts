import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeTrack } from "../src/analysis/analyzeTrack";
import { allDeckCssVars, deckCssLetter, deckTheme, deckWavePalette, FOUR_DECK_THEME, hexToPacked, installDeckThemeCss } from "../src/ui/deckTheme";
import { migratePrefs } from "../src/ui/layout";
import { DEFAULT_WAVE_STYLE, drawColumn, NEUTRAL_EQ, tonalColor, tonalShares, WAVE_STYLES, waveData, type Column, type EqGains, type WaveData } from "../src/ui/waveStyle";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`.toUpperCase();
const lum = (c: number) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);

describe("deck colour identity", () => {
  it("decks A–D resolve to the specified blue, orange, green and purple", () => {
    expect([0, 1, 2, 3].map((d) => deckTheme(d).primary)).toEqual(["#38A4FF", "#FF7956", "#48D69A", "#B38AFF"]);
    expect(deckTheme(0)).toMatchObject({ deep: "#1E5FD0", highlight: "#BFE3FF", background: "#0A1828", glow: "#38A4FF" });
    expect(deckTheme(0).waveform).toEqual({ low: "#1E5FD0", mid: "#38A4FF", high: "#BFE3FF" });
    expect(deckTheme(1)).toMatchObject({ deep: "#C2412A", highlight: "#FFD3C4", background: "#24120D", glow: "#FF7956" });
    expect(deckTheme(1).waveform).toEqual({ low: "#C2412A", mid: "#FF7956", high: "#FFD3C4" });
    expect(deckTheme(2).waveform).toEqual({ low: "#1C8C5E", mid: "#48D69A", high: "#C6F5DE" });
    expect(deckTheme(3).waveform).toEqual({ low: "#6B3FD1", mid: "#B38AFF", high: "#E4D6FF" });
    expect([0, 1, 2, 3].map(deckCssLetter)).toEqual(["a", "b", "c", "d"]);
  });

  it("the waveform renderer's packed palette is the same definition as the theme", () => {
    for (const deck of [0, 1, 2, 3]) {
      const t = deckTheme(deck).waveform;
      expect(deckWavePalette(deck)).toEqual({ low: hexToPacked(t.low), mid: hexToPacked(t.mid), high: hexToPacked(t.high) });
    }
  });

  it("CSS variables come from the same definitions", () => {
    const vars = allDeckCssVars();
    expect(vars["--deck-a-primary"]).toBe("#38A4FF");
    expect(vars["--deck-a-low"]).toBe("#1E5FD0");
    expect(vars["--deck-b-primary"]).toBe("#FF7956");
    expect(vars["--deck-b-high"]).toBe("#FFD3C4");
    expect(vars["--deck-c-primary"]).toBe("#48D69A");
    expect(vars["--deck-d-primary"]).toBe("#B38AFF");
    const set: Record<string, string> = {};
    installDeckThemeCss({ style: { setProperty: (k, v) => (set[k] = v) } });
    expect(set).toEqual(vars);
  });

  it("the stylesheet only references deck variables the theme defines, and hardcodes no deck colour", () => {
    const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
    const defined = new Set(Object.keys(allDeckCssVars()));
    const used = new Set([...css.matchAll(/var\((--deck-[a-d]-[a-z]+)\)/g)].map((m) => m[1]));
    for (const v of used) if (!/^--deck-[a-d]-strong$/.test(v)) expect(defined, v).toContain(v);
    expect(used).toContain("--deck-c-primary");
    expect(used).toContain("--deck-d-ink");
    const root = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
    for (const l of ["a", "b", "c", "d"]) expect(root).toContain(`--deck-${l}: var(--deck-${l}-primary)`);
    expect(root).not.toMatch(/--deck-[a-d]: #/);
  });

  it("identity belongs to the deck: the same track data draws in each deck's colour, from one cached analysis", () => {
    const x = new Float32Array(44100);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const analysis = analyzeTrack([x, x], 44100, 100);
    const wd = waveData(analysis);
    expect(waveData(analysis)).toBe(wd); // memoised: switching deck never re-derives the data
    const colours = (deck: number) => {
      const out = new Set<string>();
      const col: Column = { L: [wd.L.all[20], wd.L.low[20], wd.L.mid[20], wd.L.high[20]], R: [wd.R.all[20], wd.R.low[20], wd.R.mid[20], wd.R.high[20]] };
      drawColumn({ bar: (_p, _f, len, rgb) => len > 0 && out.add(hex(rgb)) }, "tonal", col, wd, 0, 50, 50, false, NEUTRAL_EQ, deckWavePalette(deck));
      return [...out];
    };
    const [a, b, c, d] = [0, 1, 2, 3].map(colours);
    expect(a.length).toBeGreaterThan(0);
    const ch = (hexc: string, i: number) => parseInt(hexc.slice(1 + i * 2, 3 + i * 2), 16);
    // Blue deck: blue dominates red; orange: red dominates blue; green: green dominates red; purple: blue dominates green.
    for (const x of a) expect(ch(x, 2)).toBeGreaterThan(ch(x, 0));
    for (const x of b) expect(ch(x, 0)).toBeGreaterThan(ch(x, 2));
    for (const x of c) expect(ch(x, 1)).toBeGreaterThan(ch(x, 0));
    for (const x of d) expect(ch(x, 2)).toBeGreaterThan(ch(x, 1));
    expect(deckTheme(4)).toBe(deckTheme(0)); // further indices wrap
    expect(FOUR_DECK_THEME).toHaveLength(4);
  });
});

describe("Dual-Deck Tonal waveform", () => {
  type Bar = { from: number; len: number; rgb: number };
  const data = (over: Partial<WaveData> = {}) => ({ fps: 150, n: 1, L: null, R: null, stereo: false, normAll: 1, normBand: 1, bandNorm: [1, 1, 1], ...over }) as unknown as WaveData;
  const col = (all: number, lo: number, md: number, hi: number): Column => ({ L: [all, lo, md, hi], R: [all, lo, md, hi] });
  const draw = (c: Column, deck = 0, eq: EqGains = NEUTRAL_EQ, d = data(), style: "tonal" | "rgb" = "tonal") => {
    const bars: Bar[] = [];
    drawColumn({ bar: (_p, from, len, rgb) => len > 0 && bars.push({ from, len, rgb }) }, style, c, d, 0, 50, 50, false, eq, deckWavePalette(deck));
    return bars;
  };
  const total = (bars: Bar[]) => bars.reduce((s, b) => s + b.len, 0);
  const coloursOf = (bars: Bar[]) => new Set(bars.map((b) => hex(b.rgb)));

  it("is the default style, and every earlier style is still available", () => {
    expect(DEFAULT_WAVE_STYLE).toBe("tonal");
    expect(WAVE_STYLES.map((s) => s.id)).toEqual(["tonal", "simple", "filtered", "rgb", "rgbLR", "hsv"]);
    expect(WAVE_STYLES[0].label).toBe("Dual-Deck Tonal");
  });

  it.each([
    [0, "#1E5FD0", "#38A4FF", "#BFE3FF"],
    [1, "#C2412A", "#FF7956", "#FFD3C4"],
    [2, "#1C8C5E", "#48D69A", "#C6F5DE"],
    [3, "#6B3FD1", "#B38AFF", "#E4D6FF"],
  ])("deck %i: lows → %s, mids → %s, highs → %s", (deck, low, mid, high) => {
    expect([...coloursOf(draw(col(1, 1, 0, 0), deck))]).toEqual([low]);
    expect([...coloursOf(draw(col(1, 0, 1, 0), deck))]).toEqual([mid]);
    expect([...coloursOf(draw(col(1, 0, 0, 1), deck))]).toEqual([high]);
  });

  it("lows are the core, mids the body, highs the outer edges", () => {
    const bars = draw(col(1, 1, 1, 1)); // equal energy in all three bands
    const p = deckWavePalette(0);
    const core = bars.find((b) => b.rgb === p.low)!;
    const edges = bars.filter((b) => b.rgb === p.high);
    expect(core.from + core.len / 2).toBeCloseTo(50); // centred
    expect(edges).toHaveLength(2);
    const top = Math.min(...bars.map((b) => b.from));
    expect(edges.some((e) => e.from === top)).toBe(true); // outermost
    // The body is a genuine blend of all three palette colours (not a flat single tint).
    const body = bars.find((b) => b.rgb !== p.low && b.rgb !== p.high)!;
    expect(body).toBeDefined();
    expect(coloursOf(bars).size).toBe(3);
  });

  it("mixed content blends: more bass widens the low core, more highs widen the bright edges", () => {
    const coreLen = (bars: Bar[]) => bars.filter((b) => b.rgb === deckWavePalette(0).low).reduce((s, b) => s + b.len, 0);
    const edgeLen = (bars: Bar[]) => bars.filter((b) => b.rgb === deckWavePalette(0).high).reduce((s, b) => s + b.len, 0);
    expect(coreLen(draw(col(1, 0.8, 0.3, 0.2)))).toBeGreaterThan(coreLen(draw(col(1, 0.3, 0.8, 0.2))));
    expect(edgeLen(draw(col(1, 0.2, 0.3, 0.8)))).toBeGreaterThan(edgeLen(draw(col(1, 0.2, 0.8, 0.3))));
  });

  it("keeps the true amplitude: same height as the RGB style whatever the band mix", () => {
    for (const c of [col(1, 1, 0, 0), col(1, 0.2, 0.9, 0.4), col(0.4, 0, 0, 1), col(0.7, 0.5, 0.5, 0.5)]) {
      expect(total(draw(c))).toBeCloseTo(total(draw(c, 0, NEUTRAL_EQ, data(), "rgb")), 6);
    }
  });

  it("silence draws nothing; quiet passages are subdued", () => {
    expect(draw(col(0, 0, 0, 0))).toEqual([]);
    const loud = draw(col(1, 0, 1, 0))[0].rgb;
    const quiet = draw(col(0.05, 0, 0.05, 0))[0].rgb;
    expect(lum(quiet)).toBeLessThan(lum(loud) * 0.75);
  });

  it("normalises bands per track so bass-heavy tracks don't drown mids and highs, without inventing highs", () => {
    // Bass-heavy track: the low band's typical peak is 2.5-3x the others'. A column that is loud in
    // every band (relative to the track) reads as balanced, not as all bass.
    const raw = tonalShares(0.8, 0.32, 0.24, undefined);
    expect(raw[0]).toBeGreaterThan(0.5); // without normalisation the bass would dominate
    const heavy = tonalShares(0.8, 0.32, 0.24, [1, 0.4, 0.3]);
    for (const s of heavy) expect(s).toBeCloseTo(1 / 3, 6);
    // The boost is capped: bands at 20% and 10% of the loudest are normalised as if they were at 30%.
    const [l, m, h] = [0.8 / 1, 0.16 / 0.3, 0.08 / 0.3];
    expect(tonalShares(0.8, 0.16, 0.08, [1, 0.2, 0.1])[2]).toBeCloseTo(h / (l + m + h), 6);
    // A track with almost no high end: boost is capped, so its trace of highs stays a trace.
    const dull = tonalShares(0.5, 0.5, 0.005, [1, 1, 0.01]);
    expect(dull[2]).toBeLessThan(0.02);
    expect(tonalShares(0, 0, 0, [1, 1, 1])).toEqual([0, 0, 0]);
  });

  it("tonalColor gives the composite colour for single-colour consumers", () => {
    expect(tonalColor(1, 0, 0, deckWavePalette(1))).toBe("rgb(194,65,42)");
    expect(tonalColor(0, 0, 1, deckWavePalette(0))).toBe("rgb(191,227,255)");
  });
});

describe("EQ-reactive Dual-Deck Tonal", () => {
  // normAll below the column's level: the bar fills the lane and stays at full brightness even
  // after an EQ cut, so each palette colour can be identified exactly.
  const data = { fps: 150, n: 1, L: null, R: null, stereo: false, normAll: 0.5, normBand: 1, bandNorm: [1, 1, 1] } as unknown as WaveData;
  const c: Column = { L: [1, 0.8, 0.8, 0.8], R: [1, 0.8, 0.8, 0.8] };
  const draw = (eq: EqGains, deck = 0) => {
    const bars: { len: number; rgb: number }[] = [];
    drawColumn({ bar: (_p, _f, len, rgb) => len > 0 && bars.push({ len, rgb }) }, "tonal", c, data, 0, 50, 50, false, eq, deckWavePalette(deck));
    return bars;
  };
  const lenOf = (bars: { len: number; rgb: number }[], rgb: number) => bars.filter((b) => b.rgb === rgb).reduce((s, b) => s + b.len, 0);

  it.each([0, 1, 2, 3])("deck %i: cutting LOW removes the low colour, HIGH the high colour, MID shrinks the body", (deck) => {
    const p = deckWavePalette(deck);
    const base = draw([1, 1, 1], deck);
    expect(lenOf(base, p.low)).toBeGreaterThan(0);
    expect(lenOf(base, p.high)).toBeGreaterThan(0);
    expect(lenOf(draw([0, 1, 1], deck), p.low)).toBe(0);
    expect(lenOf(draw([0.4, 1, 1], deck), p.low)).toBeLessThan(lenOf(base, p.low));
    expect(lenOf(draw([1, 1, 0], deck), p.high)).toBe(0);
    const body = (bars: { len: number; rgb: number }[]) => bars.filter((b) => b.rgb !== p.low && b.rgb !== p.high).reduce((s, b) => s + b.len, 0);
    expect(body(draw([1, 0, 1], deck))).toBeLessThan(body(base));
  });

  it("neutral EQ (or EQ-reactive off) restores the original picture exactly", () => {
    const base = draw(NEUTRAL_EQ);
    draw([0, 0.2, 1.5]);
    expect(draw([1, 1, 1])).toEqual(base);
  });

  it("EQ moves never change the analysed data", () => {
    const x = new Float32Array(22050);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 80 * i) / 44100);
    const wd = waveData(analyzeTrack([x], 44100, 100));
    const before = Array.from(wd.L.low);
    const col: Column = { L: [wd.L.all[5], wd.L.low[5], wd.L.mid[5], wd.L.high[5]], R: [wd.R.all[5], wd.R.low[5], wd.R.mid[5], wd.R.high[5]] };
    drawColumn({ bar: () => undefined }, "tonal", col, wd, 0, 50, 50, false, [0, 0, 0], deckWavePalette(1));
    expect(Array.from(wd.L.low)).toEqual(before);
  });
});

describe("waveform preferences", () => {
  it("prefs saved with the old default (RGB) switch to Dual-Deck Tonal once", () => {
    expect(migratePrefs({ waveStyle: "rgb" }).waveStyle).toBe("tonal");
    expect(migratePrefs({}).waveStyle).toBe("tonal");
  });
  it("any other saved choice, and RGB picked again afterwards, is kept", () => {
    expect(migratePrefs({ waveStyle: "filtered" }).waveStyle).toBe("filtered");
    expect(migratePrefs({ waveStyle: "hsv" }).waveStyle).toBe("hsv");
    const once = migratePrefs({ waveStyle: "rgb" });
    expect(migratePrefs({ ...once, waveStyle: "rgb" }).waveStyle).toBe("rgb");
  });
  it("EQ-reactive waveforms default on and an off choice persists", () => {
    expect(migratePrefs({}).waveEqReactive).toBe(true);
    expect(migratePrefs({ waveEqReactive: false }).waveEqReactive).toBe(false);
  });
  it("unknown saved styles fall back to the default", () => {
    expect(migratePrefs({ waveStyle: "nope" as never }).waveStyle).toBe("tonal");
  });
});

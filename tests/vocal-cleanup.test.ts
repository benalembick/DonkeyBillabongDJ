import { describe, expect, it } from "vitest";
import { analyseVocal, applyBiquad, autoLevel, biquad, breathControl, compress, deEsser, defaultChain, detectBreaths, equalize, gate, limit, multiband, runChain, scaleChain } from "../src/production/vocal/cleanup";
import { buildEnhance, ENHANCE_PRESETS } from "../src/production/vocal/enhance";

const RATE = 48_000;
let seed = 11; const rnd = () => { seed = (seed * 16_807) % 2_147_483_647; return seed / 1_073_741_823 - 1; };
const rms = (x: Float32Array, a = 0, b = x.length) => { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, b - a)); };
const dB = (v: number) => 20 * Math.log10(Math.max(1e-9, v));
const S = (t: number) => Math.round(t * RATE);
const voice = (x: Float32Array, a: number, b: number, hz = 220, amp = .3) => { let ph = 0; for (let i = S(a); i < S(b); i++) { ph += 2 * Math.PI * hz / RATE; const env = Math.min(1, (i - S(a)) / 480, (S(b) - i) / 480); x[i] += env * amp * (Math.sin(ph) + .5 * Math.sin(2 * ph) + .3 * Math.sin(3 * ph)); } };
const noise = (x: Float32Array, a: number, b: number, amp: number, hp?: number, lp?: number) => { let y: Float32Array = Float32Array.from({ length: S(b) - S(a) }, () => rnd() * amp); if (hp) y = applyBiquad(applyBiquad(y, biquad("hp", hp, RATE)), biquad("hp", hp, RATE)); if (lp) y = applyBiquad(applyBiquad(y, biquad("lp", lp, RATE)), biquad("lp", lp, RATE)); for (let i = 0; i < y.length; i++) x[S(a) + i] += y[i]; };

describe("gate / expander", () => {
  it("pulls the noise between phrases down by its range and leaves the singing alone", () => {
    const x = new Float32Array(S(2.4)); noise(x, 0, 2.4, .003); voice(x, .2, .8); voice(x, 1.6, 2.2);
    const { out, gr } = gate(x, RATE, { ...defaultChain().gate, on: true, threshold: -40, range: 18 });
    expect(dB(rms(out, S(1.15), S(1.35))) - dB(rms(x, S(1.15), S(1.35)))).toBeLessThan(-15); // middle of the gap, after the release
    expect(Math.abs(dB(rms(out, S(.4), S(.6))) - dB(rms(x, S(.4), S(.6))))).toBeLessThan(.2);
    expect(Math.min(...gr)).toBeLessThan(-15);
  });
});

describe("de-esser", () => {
  it("turns down sibilant bursts ≥ 6 dB without changing the voice band", () => {
    const x = new Float32Array(S(1.5)); voice(x, 0, 1.5, 200, .2); noise(x, .5, .65, .5, 6000); noise(x, 1.0, 1.15, .5, 6000);
    const { out } = deEsser(x, RATE, { on: true, freq: 5500, threshold: -30, maxReduction: 10 });
    const hiIn = applyBiquad(x, biquad("hp", 6000, RATE)), hiOut = applyBiquad(out, biquad("hp", 6000, RATE));
    expect(dB(rms(hiOut, S(.52), S(.63))) - dB(rms(hiIn, S(.52), S(.63)))).toBeLessThan(-6);
    const loIn = applyBiquad(x, biquad("lp", 1500, RATE)), loOut = applyBiquad(out, biquad("lp", 1500, RATE));
    expect(Math.abs(dB(rms(loOut, S(.2), S(.4))) - dB(rms(loIn, S(.2), S(.4))))).toBeLessThan(.3);
  });
});

describe("EQ", () => {
  const tone = (hz: number) => Float32Array.from({ length: S(.5) }, (_, i) => Math.sin(2 * Math.PI * hz * i / RATE) * .5);
  it("high-passes rumble and shapes presence / air / resonances", () => {
    const eq = { ...defaultChain().eq, on: true, hpf: 80, presence: { freq: 3500, gain: 4, q: 1 }, resonances: [{ freq: 1000, gain: -6, q: 5 }] };
    const gainAt = (hz: number) => { const x = tone(hz); return dB(rms(equalize(x, RATE, eq), S(.2))) - dB(rms(x, S(.2))); };
    expect(gainAt(30)).toBeLessThan(-12); expect(Math.abs(gainAt(400))).toBeLessThan(.5); expect(gainAt(3500)).toBeGreaterThan(3.5); expect(gainAt(1000)).toBeLessThan(-5);
  });
});

describe("dynamics", () => {
  it("Auto Level halves a 12 dB level swing (poor mic technique) without boosting the gaps", () => {
    const x = new Float32Array(S(4)); voice(x, 0, .9, 220, .4); voice(x, 1, 1.9, 220, .1); voice(x, 2, 2.9, 220, .4); voice(x, 3, 3.9, 220, .1); noise(x, 0, 4, .0005);
    const r = autoLevel(x, RATE, { on: true, mode: "balanced", target: null });
    expect(r.spreadBefore).toBeGreaterThan(10); expect(r.spreadAfter).toBeLessThan(r.spreadBefore * .5);
    expect(dB(rms(r.out, S(.93), S(.97)))).toBeLessThan(dB(rms(x, S(.93), S(.97))) + .5);
  });
  it("compressor: steady level 12 dB over threshold at 4:1 is reduced ~9 dB", () => {
    const x = Float32Array.from({ length: S(1) }, (_, i) => Math.sin(2 * Math.PI * 220 * i / RATE) * .5 * Math.SQRT2 * 10 ** (-12 / 20 + 6 / 20)); // ≈ −12 dBFS RMS… scaled below
    const level = dB(rms(x)); const { out, gr } = compress(x, RATE, { threshold: level - 12, ratio: 4, attackMs: 5, releaseMs: 100, knee: 0, makeup: 0 });
    expect(dB(rms(out, S(.5))) - level).toBeCloseTo(-9, 0); expect(Math.min(...gr)).toBeLessThan(-8);
  });
  it("multiband recombines exactly when nothing compresses", () => {
    const x = new Float32Array(S(1)); voice(x, 0, 1, 180); noise(x, 0, 1, .05);
    const { out } = multiband(x, RATE, { ...defaultChain().multiband, on: true, bands: [{ threshold: 0, ratio: 2 }, { threshold: 0, ratio: 2 }, { threshold: 0, ratio: 2 }] });
    let err = 0; for (let i = S(.1); i < S(.9); i++) err = Math.max(err, Math.abs(out[i] - x[i])); expect(err).toBeLessThan(1e-3);
  });
  it("limiter never exceeds the ceiling and only acts near peaks", () => {
    const x = new Float32Array(S(1)); voice(x, 0, 1, 220, .2); for (const t of [.3, .6]) for (let i = 0; i < 300; i++) x[S(t) + i] += Math.sin(i / 5) * .9;
    const { out } = limit(x, RATE, { ceiling: -1, releaseMs: 60 }); let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(dB(peak)).toBeLessThanOrEqual(-.99); expect(Math.abs(dB(rms(out, S(.45), S(.55))) - dB(rms(x, S(.45), S(.55))))).toBeLessThan(.2);
  });
});

describe("breath control", () => {
  it("finds breaths between phrases (not 's' sounds) and lowers them without deleting them", () => {
    const x = new Float32Array(S(3)); voice(x, .1, 1, 220, .3); voice(x, 1.6, 2.6, 220, .3); noise(x, 1.15, 1.45, .03, 300, 2500); noise(x, 2.7, 2.85, .05, 6000);
    const sung = (t: number) => (t > .1 && t < 1) || (t > 1.6 && t < 2.6);
    const breaths = detectBreaths(x, RATE, sung); expect(breaths).toHaveLength(1); expect(breaths[0].start).toBeGreaterThan(1.1); expect(breaths[0].end).toBeLessThan(1.5);
    const { out } = breathControl(x, RATE, breaths, "reduce"); const change = dB(rms(out, S(1.2), S(1.4))) - dB(rms(x, S(1.2), S(1.4)));
    expect(change).toBeLessThan(-8); expect(change).toBeGreaterThan(-10); expect(rms(out, S(1.2), S(1.4))).toBeGreaterThan(0);
  });
});

describe("Auto Enhance", () => {
  const take = () => { const x = new Float32Array(S(4)); noise(x, 0, 4, .004); voice(x, .2, 1.4, 196, .35); voice(x, 1.9, 3.6, 220, .12); noise(x, 1.0, 1.1, .4, 6000); noise(x, 1.55, 1.8, .08, 300, 2500); return x; };
  const sung = (t: number) => (t > .2 && t < 1.4 && !(t > 1 && t < 1.1)) || (t > 1.9 && t < 3.6);
  it("measures the take and builds a chain that explains itself", () => {
    const a = analyseVocal(take(), RATE, sung, 196);
    expect(a.noiseFloorDb).toBeGreaterThan(-60); expect(a.spreadDb).toBeGreaterThan(6); expect(a.sibilanceDb).toBeGreaterThan(-12); expect(a.breaths).toBeGreaterThanOrEqual(1);
    const { chain, report, pitch } = buildEnhance(a, "pop");
    expect(chain.gate.on && chain.deesser.on && chain.breath.on && chain.eq.on && chain.level.on && chain.comp.on && chain.multiband.on && chain.limiter.on).toBe(true);
    expect(pitch).toBe("studio"); expect(report.length).toBeGreaterThanOrEqual(8); expect(report.join("\n")).toMatch(/Gate\/Expander: threshold/);
    expect(Object.keys(ENHANCE_PRESETS)).toEqual(["natural", "clean-studio", "pop", "edm", "rock", "warm", "hard-tune"]);
  });
  it("the full chain evens out levels, tames 's', keeps the ceiling", () => {
    const x = take(); const { chain } = buildEnhance(analyseVocal(x, RATE, sung, 196), "clean-studio"); const r = runChain(x, RATE, chain, sung);
    expect(r.levelSpread!.after).toBeLessThan(r.levelSpread!.before); expect(r.meters.deesser!.maxGr).toBeLessThan(-3); expect(r.meters.gate!.maxGr).toBeLessThan(-6);
    let peak = 0; for (const v of r.out) peak = Math.max(peak, Math.abs(v)); expect(dB(peak)).toBeLessThanOrEqual(-.99);
  });
  it("resonance cuts only for peaks that stay put across notes — never the sung harmonics", () => {
    const notes = [[.1, .7, 196], [.8, 1.4, 247], [1.5, 2.1, 294], [2.2, 2.8, 220]] as const; const inNote = (t: number) => notes.some(([a, b]) => t > a && t < b);
    const x = new Float32Array(S(3)); for (const [a, b, hz] of notes) voice(x, a, b, hz, .25);
    expect(analyseVocal(x, RATE, inNote, 196).resonances).toEqual([]); // harmonics move with the note
    const ringing = applyBiquad(x, biquad("peak", 1800, RATE, 12, 14)); // a fixed room / mic resonance
    const r = analyseVocal(ringing, RATE, inNote, 196).resonances; expect(r.length).toBeGreaterThanOrEqual(1); expect(Math.abs(Math.log2(r[0].freq / 1800))).toBeLessThan(.1);
  });
  it("Auto Level rides only the singing: an 's' or a breath next to a quiet phrase is not lifted", () => {
    const x = new Float32Array(S(3)); voice(x, .1, 1, 220, .4); noise(x, 1.1, 1.4, .02, 300, 2500); voice(x, 1.5, 2.4, 220, .1); noise(x, 2.45, 2.55, .1, 6000); noise(x, 0, 3, .0005);
    const sung = (t: number) => (t > .1 && t < 1) || (t > 1.5 && t < 2.4);
    const r = autoLevel(x, RATE, { on: true, mode: "balanced", target: null }, sung); const change = (a: number, b: number) => dB(rms(r.out, S(a), S(b))) - dB(rms(x, S(a), S(b)));
    expect(change(1.7, 2.2)).toBeGreaterThan(4); // the quiet phrase comes up
    expect(change(1.15, 1.35)).toBeLessThan(.5); expect(change(2.47, 2.53)).toBeLessThan(.5); // the breath and the "s" do not
  });
  it("Breath Control's cut survives the compressor (applied after the dynamics)", () => {
    const x = new Float32Array(S(3)); voice(x, .1, 1, 220, .3); voice(x, 1.6, 2.6, 220, .3); noise(x, 1.15, 1.45, .03, 300, 2500);
    const sung = (t: number) => (t > .1 && t < 1) || (t > 1.6 && t < 2.6); const base = defaultChain(); base.comp = { ...base.comp, on: true, threshold: -30, ratio: 4, makeup: 6 };
    const on = runChain(x, RATE, { ...base, breath: { on: true, mode: "reduce" } }, sung), off = runChain(x, RATE, base, sung);
    expect(dB(rms(on.out, S(1.2), S(1.4))) - dB(rms(off.out, S(1.2), S(1.4)))).toBeCloseTo(-9, 0);
  });
  it("AMOUNT 0 leaves the voice untouched in tone and level", () => {
    const x = take(); const { chain } = buildEnhance(analyseVocal(x, RATE, sung, 196), "edm"); const r = runChain(x, RATE, { ...scaleChain(chain, 0), limiter: { ...chain.limiter, on: false }, gate: { ...chain.gate, on: false } }, sung);
    expect(Math.abs(dB(rms(r.out, S(.4), S(.9))) - dB(rms(x, S(.4), S(.9))))).toBeLessThan(.5);
  });
});

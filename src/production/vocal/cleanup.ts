/**
 * Vocal Studio Phase 3 — vocal cleanup DSP (offline, mono, sample-accurate). Pure functions so they are unit-tested.
 *
 * Chain order (after pitch correction): Gate/Expander → Breath Control → De-esser → EQ → Auto Level (gain rider)
 * → Compressor → Multiband Compressor → Limiter. Every processor returns its output and a gain-change trace
 * (dB per 10 ms) for the UI's gain-reduction readouts. Nothing here touches the original recording: the chain runs
 * on a copy inside the content-addressed render.
 */
import { fft } from "./scales";

export interface GateParams { on: boolean; threshold: number; range: number; ratio: number; attackMs: number; holdMs: number; releaseMs: number }
export type BreathMode = "keep" | "reduce" | "strong";
export interface BreathParams { on: boolean; mode: BreathMode }
export interface DeEsserParams { on: boolean; freq: number; threshold: number; maxReduction: number }
export interface EqBand { freq: number; gain: number; q: number }
export interface EqParams { on: boolean; hpf: number; lowShelf: EqBand; mud: EqBand; presence: EqBand; air: EqBand; resonances: EqBand[] }
export type LevelMode = "natural" | "balanced" | "aggressive";
export interface LevelParams { on: boolean; mode: LevelMode; target: number | null }
export interface CompParams { on: boolean; threshold: number; ratio: number; attackMs: number; releaseMs: number; knee: number; makeup: number }
export interface MultibandParams { on: boolean; lowFreq: number; highFreq: number; bands: { threshold: number; ratio: number }[] }
export interface LimiterParams { on: boolean; ceiling: number; releaseMs: number }
export interface CleanupChain { gate: GateParams; breath: BreathParams; deesser: DeEsserParams; eq: EqParams; level: LevelParams; comp: CompParams; multiband: MultibandParams; limiter: LimiterParams }
export type ProcessorId = keyof CleanupChain;
/** Processing order (breaths are detected right after the gate, on the clean signal, but lowered after the dynamics). */
export const PROCESSOR_ORDER: ProcessorId[] = ["gate", "deesser", "eq", "level", "comp", "multiband", "breath", "limiter"];

export const defaultChain = (): CleanupChain => ({
  gate: { on: false, threshold: -50, range: 18, ratio: 4, attackMs: 1, holdMs: 40, releaseMs: 120 },
  breath: { on: false, mode: "reduce" },
  deesser: { on: false, freq: 5500, threshold: -30, maxReduction: 8 },
  eq: { on: false, hpf: 80, lowShelf: { freq: 180, gain: 0, q: .7 }, mud: { freq: 350, gain: 0, q: 1.2 }, presence: { freq: 3500, gain: 0, q: 1 }, air: { freq: 10000, gain: 0, q: .7 }, resonances: [] },
  level: { on: false, mode: "balanced", target: null },
  comp: { on: false, threshold: -20, ratio: 3, attackMs: 8, releaseMs: 120, knee: 6, makeup: 0 },
  multiband: { on: false, lowFreq: 250, highFreq: 4000, bands: [{ threshold: -24, ratio: 2.5 }, { threshold: -22, ratio: 2 }, { threshold: -26, ratio: 2.5 }] },
  limiter: { on: false, ceiling: -1, releaseMs: 60 },
});

export const LEVEL_MODES: Record<LevelMode, { range: number; smoothMs: number; label: string }> = {
  natural: { range: 6, smoothMs: 400, label: "Natural" }, balanced: { range: 9, smoothMs: 200, label: "Balanced" }, aggressive: { range: 12, smoothMs: 90, label: "Aggressive" },
};
export const BREATH_GAIN: Record<BreathMode, number> = { keep: 0, reduce: -9, strong: -20 };

const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v));
const lin = (d: number) => 10 ** (d / 20);
const coef = (ms: number, rate: number) => (ms <= 0 ? 1 : 1 - Math.exp(-1 / (rate * ms / 1000)));
const TRACE = .01;

/** Gain trace (dB per 10 ms; negative = reduction) from a per-sample linear gain. */
function trace(gain: Float32Array, rate: number): Float32Array { const per = Math.round(rate * TRACE); const out = new Float32Array(Math.ceil(gain.length / per)); for (let i = 0; i < out.length; i++) { let m = Infinity; for (let j = i * per; j < Math.min(gain.length, (i + 1) * per); j++) m = Math.min(m, gain[j]); out[i] = db(m); } return out; }

// ── biquads (RBJ cookbook) ──
type Biquad = [number, number, number, number, number]; // b0 b1 b2 a1 a2 (a0 = 1)
export function biquad(type: "hp" | "lp" | "peak" | "lowshelf" | "highshelf" | "bp", freq: number, rate: number, q = .7071, gainDb = 0): Biquad {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * Math.min(freq, rate * .45) / rate, cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q); let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case "hp": b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "lp": b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "bp": b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case "peak": b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case "lowshelf": { const s = 2 * Math.sqrt(A) * alpha; b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break; }
    case "highshelf": { const s = 2 * Math.sqrt(A) * alpha; b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break; }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
export function applyBiquad(x: Float32Array, c: Biquad): Float32Array { const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
/** Zero-phase filtering (forward + backward): offline band splits that recombine exactly. */
export function filtfilt(x: Float32Array, c: Biquad): Float32Array { const f = applyBiquad(x, c); f.reverse(); const b = applyBiquad(f, c); return b.reverse(); }

// ── processors ──
/**
 * Gate / expander with 5 ms lookahead: below threshold the level falls `ratio`× faster, at most `range` dB. The
 * detector is a 10 ms RMS (the same measure as the analysed noise floor; a peak detector would sit ~6–10 dB above it
 * on noise and never close).
 */
export function gate(x: Float32Array, rate: number, p: GateParams): { out: Float32Array; gr: Float32Array } {
  const n = x.length, look = Math.round(rate * .005), env = new Float32Array(n); const k = coef(10, rate); let ms = 0;
  for (let i = 0; i < n; i++) { const v = x[Math.min(n - 1, i + look)]; ms += (v * v - ms) * k; env[i] = Math.sqrt(ms); }
  // Gain smoothed in dB (a natural, even release), opening fast, holding, then closing over releaseMs.
  const gain = new Float32Array(n); const att = coef(p.attackMs, rate), relG = coef(p.releaseMs, rate), hold = Math.round(rate * p.holdMs / 1000); let gd = 0, held = 0;
  for (let i = 0; i < n; i++) {
    const ed = db(env[i]); const target = ed >= p.threshold ? 0 : Math.max(-p.range, (ed - p.threshold) * (p.ratio - 1));
    if (target >= gd) { gd += (target - gd) * att; held = hold; } else if (held > 0) held--; else gd += (target - gd) * relG;
    gain[i] = lin(gd);
  }
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = x[i] * gain[i]; return { out, gr: trace(gain, rate) };
}

/**
 * Short-time spectral features on 10 ms hops: level (dB), spectral centroid (Hz), flatness (0–1, over 0.3–5 kHz) and
 * the low/high power ratio (0.3–3 kHz ÷ 4–12 kHz: breaths are low-mid heavy, "s"/"sh" high heavy, hiss barely counts).
 */
export function spectralFrames(x: Float32Array, rate: number): { hop: number; level: Float32Array; centroid: Float32Array; flatness: Float32Array; lowHigh: Float32Array } {
  const hop = Math.round(rate * .01), N = 1024, frames = Math.floor(x.length / hop); const level = new Float32Array(frames), centroid = new Float32Array(frames), flatness = new Float32Array(frames), lowHigh = new Float32Array(frames);
  const l0 = Math.ceil(300 * N / rate), l1 = Math.floor(3000 * N / rate), h0 = Math.ceil(4000 * N / rate), h1 = Math.min(N / 2 - 1, Math.floor(12000 * N / rate));
  const re = new Float32Array(N), im = new Float32Array(N); const win = Float32Array.from({ length: N }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (N - 1)));
  for (let f = 0; f < frames; f++) {
    const c = f * hop; let e = 0; for (let i = 0; i < N; i++) { const v = x[c - N / 2 + i] ?? 0; re[i] = v * win[i]; im[i] = 0; e += v * v; } level[f] = db(Math.sqrt(e / N));
    fft(re, im); let num = 0, den = 0, logSum = 0, sum = 0, bins = 0; const f0 = Math.ceil(300 * N / rate), f1 = Math.floor(5000 * N / rate);
    // Centroid over the whole spectrum; flatness over 0.3–5 kHz (breath noise is band-limited, so a full-band
    // flatness would read it as tonal).
    let lowP = 0, highP = 0;
    for (let k = 2; k < N / 2; k++) { const p2 = re[k] * re[k] + im[k] * im[k]; const m = Math.sqrt(p2) + 1e-12; num += m * k * rate / N; den += m; if (k >= f0 && k <= f1) { logSum += Math.log(m); sum += m; bins++; } if (k >= l0 && k <= l1) lowP += p2; else if (k >= h0 && k <= h1) highP += p2; }
    centroid[f] = den ? num / den : 0; flatness[f] = Math.exp(logSum / bins) / (sum / bins); lowHigh[f] = lowP / (highP + 1e-18);
  }
  return { hop: .01, level, centroid, flatness, lowHigh };
}

/**
 * Breaths: unvoiced, noise-like (flat 0.3–5 kHz spectrum), low-mid heavy (0.3–3 kHz power ≥ 1.5 × 4–12 kHz, which
 * rules out "s"/"sh") sounds 12–45 dB below the singing, 120–900 ms long.
 */
export function detectBreaths(x: Float32Array, rate: number, voiced: (t: number) => boolean): { start: number; end: number; levelDb: number }[] {
  const s = spectralFrames(x, rate); const voicedLevels: number[] = []; for (let f = 0; f < s.level.length; f++) if (voiced(f * s.hop)) voicedLevels.push(s.level[f]);
  if (!voicedLevels.length) return []; voicedLevels.sort((a, b) => a - b); const sing = voicedLevels[voicedLevels.length >> 1];
  const out: { start: number; end: number; levelDb: number }[] = []; let a = -1, sum = 0;
  const close = (b: number) => { const dur = (b - a) * s.hop; if (dur >= .12 && dur <= .9) out.push({ start: a * s.hop, end: b * s.hop, levelDb: Math.round(sum / (b - a)) }); a = -1; sum = 0; };
  for (let f = 0; f < s.level.length; f++) {
    const breathy = !voiced(f * s.hop) && s.level[f] < sing - 12 && s.level[f] > sing - 45 && s.flatness[f] > .15 && s.lowHigh[f] > 1.5;
    if (breathy) { if (a < 0) a = f; sum += s.level[f]; } else if (a >= 0) close(f);
  }
  if (a >= 0) close(s.level.length); return out;
}
/** Breath control: lowers detected breaths (never deletes them) with 15 ms ramps. */
export function breathControl(x: Float32Array, rate: number, breaths: { start: number; end: number }[], mode: BreathMode): { out: Float32Array; gr: Float32Array } {
  const gain = new Float32Array(x.length).fill(1); const g = lin(BREATH_GAIN[mode]); const ramp = Math.round(rate * .015);
  for (const b of breaths) { const a = Math.round(b.start * rate), e = Math.round(b.end * rate); for (let i = Math.max(0, a - ramp); i < Math.min(x.length, e + ramp); i++) { const edge = Math.min(1, (i - (a - ramp)) / ramp, ((e + ramp) - i) / ramp); gain[i] = Math.min(gain[i], 1 + (g - 1) * Math.max(0, Math.min(1, edge))); } }
  const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = x[i] * gain[i]; return { out, gr: trace(gain, rate) };
}

/** Split-band de-esser: only the band above `freq` is turned down, and only while it dominates (sibilance). */
export function deEsser(x: Float32Array, rate: number, p: DeEsserParams): { out: Float32Array; gr: Float32Array } {
  const hpC = biquad("hp", p.freq, rate); const hi = filtfilt(filtfilt(x, hpC), hpC); const n = x.length;
  const envHi = new Float32Array(n), envAll = new Float32Array(n); const a = coef(5, rate); let eh = 0, ea = 0;
  for (let i = 0; i < n; i++) { eh += (hi[i] * hi[i] - eh) * a; ea += (x[i] * x[i] - ea) * a; envHi[i] = Math.sqrt(eh); envAll[i] = Math.sqrt(ea); }
  const gain = new Float32Array(n); const att = coef(1, rate), rel = coef(40, rate); let g = 1;
  for (let i = 0; i < n; i++) {
    const over = db(envHi[i]) - p.threshold; const dominant = envAll[i] > 0 && envHi[i] / envAll[i] > .4;
    const target = over > 0 && dominant ? lin(-Math.min(p.maxReduction, over)) : 1; // brick-wall on the sibilant band, up to maxReduction
    g += (target - g) * (target < g ? att : rel); gain[i] = g;
  }
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = (x[i] - hi[i]) + hi[i] * gain[i]; return { out, gr: trace(gain, rate) };
}

/** Corrective / tone EQ: high-pass, low shelf, mud cut, presence, air, and narrow resonance cuts. */
export function equalize(x: Float32Array, rate: number, p: EqParams): Float32Array {
  let y = x; if (p.hpf > 0) { y = applyBiquad(y, biquad("hp", p.hpf, rate)); y = applyBiquad(y, biquad("hp", p.hpf, rate)); }
  if (p.lowShelf.gain) y = applyBiquad(y, biquad("lowshelf", p.lowShelf.freq, rate, p.lowShelf.q, p.lowShelf.gain));
  for (const band of [p.mud, p.presence, ...p.resonances]) if (band.gain) y = applyBiquad(y, biquad("peak", band.freq, rate, band.q, band.gain));
  if (p.air.gain) y = applyBiquad(y, biquad("highshelf", p.air.freq, rate, p.air.q, p.air.gain));
  return y === x ? x.slice() : y;
}

/**
 * Auto Level (gain rider): rides 10 ms loudness toward the singing's median level within ±range dB, before the
 * compressor — evens out mic-distance swings without squashing. Never boosts quiet gaps (noise stays down).
 */
export function autoLevel(x: Float32Array, rate: number, p: LevelParams, voiced?: (t: number) => boolean): { out: Float32Array; gr: Float32Array; spreadBefore: number; spreadAfter: number } {
  const per = Math.round(rate * .01), frames = Math.ceil(x.length / per); const lv = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let e = 0, k = 0; for (let i = f * per; i < Math.min(x.length, (f + 1) * per); i++) { e += x[i] * x[i]; k++; } lv[f] = db(Math.sqrt(e / Math.max(1, k))); }
  // Short-term loudness (50 ms) of active frames.
  const st = new Float32Array(frames); for (let f = 0; f < frames; f++) { let s = 0, k = 0; for (let j = Math.max(0, f - 2); j <= Math.min(frames - 1, f + 2); j++) { s += 10 ** (lv[j] / 10); k++; } st[f] = 10 * Math.log10(s / k + 1e-18); }
  // Singing = within 18 dB of the typical sung level (breaths, room noise and tails are well below it and are never ridden up).
  const sorted = Array.from(st).sort((a, b) => a - b); const peak = sorted[sorted.length - 1] ?? -120; const loud = sorted.filter((v) => v > Math.max(-60, peak - 40)); const typical = loud.length ? loud[loud.length >> 1] : -20;
  // With the pitch track, only sung (voiced) frames are ridden: an "s" or a breath is never mistaken for a quiet phrase.
  const loudEnough = (v: number) => v > Math.max(-60, peak - 40, typical - 18);
  const isActive = Uint8Array.from(st, (v, f) => (loudEnough(v) && (!voiced || voiced(f * .01)) ? 1 : 0)); const active = (f: number) => isActive[f] === 1;
  const act = Array.from(st).filter((_, f) => active(f)).sort((a, b) => a - b); const target = p.target ?? (act.length ? act[act.length >> 1] : -20); const mode = LEVEL_MODES[p.mode];
  // Desired gain on active frames. Consonant-length gaps (< 250 ms) follow the quieter neighbour (no more than the notes
  // around them); pauses (< 1 s) take the gain between their neighbours but are never boosted; longer ones stay at 0 dB.
  const want = new Float32Array(frames).fill(NaN); const pause = new Uint8Array(frames); for (let f = 0; f < frames; f++) if (active(f)) want[f] = Math.max(-mode.range, Math.min(mode.range, target - st[f]));
  for (let f = 0; f < frames;) {
    if (!Number.isNaN(want[f])) { f++; continue; } let e = f; while (e < frames && Number.isNaN(want[e])) e++; const before = f > 0 ? want[f - 1] : NaN, after = e < frames ? want[e] : NaN; const len = (e - f) * .01;
    for (let k = f; k < e; k++) {
      if (len < .25 && !(Number.isNaN(before) && Number.isNaN(after))) { want[k] = Math.min(Number.isNaN(before) ? Math.min(0, after) : before, Number.isNaN(after) ? Math.min(0, before) : after); continue; }
      const t = (k - f + 1) / (e - f + 1); want[k] = Math.min(0, len < 1 && !Number.isNaN(before) && !Number.isNaN(after) ? before + (after - before) * t : 0); pause[k] = 1;
    }
    f = e;
  }
  // Offline look-ahead: zero-phase smoothing (forward + backward one-pole), so level changes are met on time, not late.
  const fg = new Float32Array(frames); const a = 1 - Math.exp(-.01 / (mode.smoothMs / 2000)); let g = want[0] || 0;
  for (let f = 0; f < frames; f++) { g += (want[f] - g) * a; fg[f] = g; } g = fg[frames - 1] ?? 0; for (let f = frames - 1; f >= 0; f--) { g += (fg[f] - g) * a; fg[f] = g; }
  // The smoothing must not carry a phrase's boost into the gap next to it (a breath before a quiet phrase would come
  // back up): clamp the gaps to ≤ 0 dB again, then soften those edges with a short (20 ms) zero-phase pass.
  for (let f = 0; f < frames; f++) if (pause[f]) fg[f] = Math.min(0, fg[f]);
  const b = 1 - Math.exp(-.01 / .01); g = fg[0] ?? 0; for (let f = 0; f < frames; f++) { g += (fg[f] - g) * b; fg[f] = g; } g = fg[frames - 1] ?? 0; for (let f = frames - 1; f >= 0; f--) { g += (fg[f] - g) * b; fg[f] = g; }
  const gain = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const t = i / per - .5; const f0 = Math.max(0, Math.min(frames - 1, Math.floor(t))), f1 = Math.min(frames - 1, f0 + 1), fr = Math.max(0, Math.min(1, t - f0)); gain[i] = lin(fg[f0] + (fg[f1] - fg[f0]) * fr); }
  const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = x[i] * gain[i];
  // Level swing = 10–90 % spread of phrase-level (400 ms) loudness over active frames, before and after.
  const phrase = (lvl: (f: number) => number) => { const v: number[] = []; for (let f = 0; f < frames; f++) { if (!active(f)) continue; let s = 0, k = 0; for (let j = Math.max(0, f - 20); j <= Math.min(frames - 1, f + 20); j++) if (active(j)) { s += 10 ** (lvl(j) / 10); k++; } v.push(10 * Math.log10(s / k)); } return v.sort((x1, x2) => x1 - x2); };
  const spread = (vals: number[]) => vals.length < 10 ? 0 : vals[Math.floor(vals.length * .9)] - vals[Math.floor(vals.length * .1)];
  return { out, gr: trace(gain, rate), spreadBefore: spread(phrase((f) => st[f])), spreadAfter: spread(phrase((f) => st[f] + fg[f])) };
}

/** Feed-forward compressor (RMS detector, soft knee, attack/release on the gain). */
export function compress(x: Float32Array, rate: number, p: Pick<CompParams, "threshold" | "ratio" | "attackMs" | "releaseMs" | "knee" | "makeup">): { out: Float32Array; gr: Float32Array } {
  const n = x.length; const det = coef(Math.max(1, p.attackMs), rate); const att = coef(p.attackMs, rate), rel = coef(p.releaseMs, rate); let e = 0, grDb = 0; const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    e += (x[i] * x[i] - e) * det; const lvl = 10 * Math.log10(e + 1e-18); const over = lvl - p.threshold; const k = p.knee / 2;
    const want = over <= -k ? 0 : over >= k ? -over * (1 - 1 / p.ratio) : -((over + k) ** 2 / (2 * p.knee || 1)) * (1 - 1 / p.ratio);
    grDb += (want - grDb) * (want < grDb ? att : rel); gain[i] = lin(grDb);
  }
  const out = new Float32Array(n); const mk = lin(p.makeup); for (let i = 0; i < n; i++) out[i] = x[i] * gain[i] * mk; return { out, gr: trace(gain, rate) };
}

/** Three-band compressor on zero-phase splits (low / mid / high recombine exactly when no band compresses). */
export function multiband(x: Float32Array, rate: number, p: MultibandParams): { out: Float32Array; gr: Float32Array; bandGr: Float32Array[] } {
  const low = filtfilt(x, biquad("lp", p.lowFreq, rate)); const high = filtfilt(x, biquad("hp", p.highFreq, rate)); const mid = new Float32Array(x.length); for (let i = 0; i < x.length; i++) mid[i] = x[i] - low[i] - high[i];
  const bands = [low, mid, high].map((b, k) => compress(b, rate, { threshold: p.bands[k].threshold, ratio: p.bands[k].ratio, attackMs: [20, 10, 4][k], releaseMs: [200, 120, 80][k], knee: 6, makeup: 0 }));
  const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = bands[0].out[i] + bands[1].out[i] + bands[2].out[i];
  const gr = new Float32Array(bands[0].gr.length); for (let i = 0; i < gr.length; i++) gr[i] = Math.min(bands[0].gr[i], bands[1].gr[i], bands[2].gr[i]);
  return { out, gr, bandGr: bands.map((b) => b.gr) };
}

/** Look-ahead (5 ms) peak limiter: the gain is already down when the peak arrives; never exceeds the ceiling. */
export function limit(x: Float32Array, rate: number, p: Pick<LimiterParams, "ceiling" | "releaseMs">): { out: Float32Array; gr: Float32Array } {
  const n = x.length, L = Math.max(1, Math.round(rate * .005)), ceil = lin(p.ceiling); const req = new Float32Array(n); for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); req[i] = a > ceil ? ceil / a : 1; }
  // Minimum over the next L samples (monotonic deque), so the gain is down before each peak.
  const ahead = new Float32Array(n); const dq: number[] = []; let head = 0;
  for (let i = n - 1; i >= 0; i--) { while (dq.length > head && req[dq[dq.length - 1]] >= req[i]) dq.pop(); dq.push(i); while (dq[head] > i + L) head++; ahead[i] = req[dq[head]]; if (head > 1024) { dq.splice(0, head); head = 0; } }
  const gain = new Float32Array(n); const rel = coef(p.releaseMs, rate); let g = 1; const att = 1 / L;
  for (let i = 0; i < n; i++) { const t = ahead[i]; if (t < g) g = Math.max(t, g - att); else g += (t - g) * rel; gain[i] = Math.min(g, req[i]); }
  const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = x[i] * gain[i]; return { out, gr: trace(gain, rate) };
}

/** Per-processor gain trace (dB per 10 ms): maxGr = deepest cut, maxBoost = largest lift (Auto Level rides both ways). */
export interface ChainResult { out: Float32Array; meters: Partial<Record<ProcessorId, { gr: Float32Array; maxGr: number; avgGr: number; maxBoost: number }>>; breaths: { start: number; end: number; levelDb: number }[]; levelSpread: { before: number; after: number } | null }

/** Runs the enabled processors in order. `voiced(t)` comes from the pitch track (breath detection). */
export function runChain(input: Float32Array, rate: number, chain: CleanupChain, voiced: (t: number) => boolean): ChainResult {
  let x = input; const meters: ChainResult["meters"] = {}; let breaths: ChainResult["breaths"] = []; let levelSpread: ChainResult["levelSpread"] = null;
  const meter = (id: ProcessorId, gr: Float32Array) => { let m = 0, up = 0, s = 0, k = 0; for (const v of gr) { m = Math.min(m, v); up = Math.max(up, v); if (v < -.1) { s += v; k++; } } meters[id] = { gr, maxGr: m, avgGr: k ? s / k : 0, maxBoost: up }; };
  if (chain.gate.on) { const r = gate(x, rate, chain.gate); x = r.out; meter("gate", r.gr); }
  // Breaths are found on the clean (gated) signal but turned down after the dynamics, so the compressor's makeup and
  // the rider can't bring them back up: "Reduce −9 dB" means −9 dB relative to the finished vocal.
  if (chain.breath.on) breaths = detectBreaths(x, rate, voiced);
  if (chain.deesser.on) { const r = deEsser(x, rate, chain.deesser); x = r.out; meter("deesser", r.gr); }
  if (chain.eq.on) x = equalize(x, rate, chain.eq);
  if (chain.level.on) { const r = autoLevel(x, rate, chain.level, voiced); x = r.out; meter("level", r.gr); levelSpread = { before: r.spreadBefore, after: r.spreadAfter }; }
  if (chain.comp.on) { const r = compress(x, rate, chain.comp); x = r.out; meter("comp", r.gr); }
  if (chain.multiband.on) { const r = multiband(x, rate, chain.multiband); x = r.out; meter("multiband", r.gr); }
  if (chain.breath.on && chain.breath.mode !== "keep") { const r = breathControl(x, rate, breaths, chain.breath.mode); x = r.out; meter("breath", r.gr); }
  if (chain.limiter.on) { const r = limit(x, rate, chain.limiter); x = r.out; meter("limiter", r.gr); }
  return { out: x === input ? input.slice() : x, meters, breaths, levelSpread };
}

/** Scales the chain's intensity (Auto Enhance AMOUNT): 0 = no change, 1 = as set. */
export function scaleChain(c: CleanupChain, amount: number): CleanupChain {
  const a = Math.max(0, Math.min(1, amount)); const s = JSON.parse(JSON.stringify(c)) as CleanupChain; const r = (ratio: number) => 1 + (ratio - 1) * a;
  s.gate.range *= a; s.deesser.maxReduction *= a; for (const b of [s.eq.lowShelf, s.eq.mud, s.eq.presence, s.eq.air, ...s.eq.resonances]) b.gain *= a; if (a < .05) s.eq.hpf = 0;
  s.comp.ratio = r(s.comp.ratio); s.comp.makeup *= a; s.multiband.bands = s.multiband.bands.map((b) => ({ ...b, ratio: r(b.ratio) }));
  if (a < .34 && s.breath.mode === "strong") s.breath.mode = "reduce"; if (a < .15) s.breath.mode = "keep";
  if (a < .34) s.level.mode = "natural"; else if (a < .67 && s.level.mode === "aggressive") s.level.mode = "balanced"; if (a < .05) s.level.on = false;
  return s;
}

// ── analysis for Auto Enhance ──
export interface VocalAnalysis { peakDb: number; singDb: number; noiseFloorDb: number; spreadDb: number; sibilanceDb: number; bands: Record<"low" | "mud" | "body" | "mid" | "presence" | "air", number>; resonances: EqBand[]; breaths: number; lowestHz: number }

/** Long-term band energies, noise floor, level spread, sibilance and narrow resonances of a take. */
export function analyseVocal(x: Float32Array, rate: number, voiced: (t: number) => boolean, lowestHz = 100): VocalAnalysis {
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const s = spectralFrames(x, rate); const voicedLv: number[] = [], all: number[] = []; for (let f = 0; f < s.level.length; f++) { all.push(s.level[f]); if (voiced(f * s.hop)) voicedLv.push(s.level[f]); }
  all.sort((a, b) => a - b); voicedLv.sort((a, b) => a - b); const sing = voicedLv.length ? voicedLv[voicedLv.length >> 1] : all[all.length >> 1] ?? -60; const noise = all.length ? all[Math.floor(all.length * .05)] : -120;
  const spread = voicedLv.length > 10 ? voicedLv[Math.floor(voicedLv.length * .9)] - voicedLv[Math.floor(voicedLv.length * .1)] : 0;
  // Long-term spectrum of voiced frames (4096-point, 0.1 s hop).
  // Each voiced run (phrase / note) also keeps its own spectrum, for the resonance test below.
  const N = 4096, re = new Float32Array(N), im = new Float32Array(N), acc = new Float64Array(N / 2); let frames = 0; const runs: { acc: Float64Array; frames: number }[] = []; let inRun = false;
  for (let at = 0; at + N < x.length; at += Math.round(rate * .1)) {
    if (!voiced((at + N / 2) / rate)) { inRun = false; continue; } if (!inRun) { runs.push({ acc: new Float64Array(N / 2), frames: 0 }); inRun = true; } const run = runs[runs.length - 1];
    for (let i = 0; i < N; i++) { re[i] = x[at + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (N - 1))); im[i] = 0; } fft(re, im); for (let k = 0; k < N / 2; k++) { const p2 = re[k] * re[k] + im[k] * im[k]; acc[k] += p2; run.acc[k] += p2; } frames++; run.frames++;
  }
  const band = (lo: number, hi: number) => { let e = 0, k0 = Math.max(1, Math.floor(lo * N / rate)), k1 = Math.min(N / 2 - 1, Math.ceil(hi * N / rate)); for (let k = k0; k <= k1; k++) e += acc[k]; return 10 * Math.log10(e / Math.max(1, frames) / Math.max(1, k1 - k0 + 1) + 1e-20); };
  const bands = { low: band(80, 200), mud: band(200, 500), body: band(500, 1000), mid: band(1000, 3000), presence: band(3000, 6000), air: band(8000, 14000) };
  // Resonances: narrow peaks standing > 5 dB above a 1/3-octave-smoothed spectrum (200 Hz – 5 kHz), up to 3. A sung
  // harmonic is also a narrow peak, but it moves with the note; a room / mic resonance stays put. So a peak only counts
  // when it is also present (> 3 dB) in at least 2/3 of the separate voiced runs, and there are at least 3 runs.
  const spec = Array.from(acc, (e) => 10 * Math.log10(e / Math.max(1, frames) + 1e-20)); const resonances: EqBand[] = [];
  const excessAt = (sp: ArrayLike<number>, k: number) => { const w = Math.max(3, Math.round(k * .12)); let sum = 0, c = 0; for (let j = k - w; j <= k + w; j++) if (j !== k) { sum += sp[j]; c++; } return sp[k] - sum / c; };
  const runSpecs = runs.filter((r) => r.frames >= 2).map((r) => Array.from(r.acc, (e) => 10 * Math.log10(e / r.frames + 1e-20)));
  const stable = (k: number) => runSpecs.length >= 3 && runSpecs.filter((sp) => Math.max(excessAt(sp, k - 1), excessAt(sp, k), excessAt(sp, k + 1)) > 3).length >= runSpecs.length * 2 / 3;
  if (frames) {
    const cands: { k: number; excess: number }[] = [];
    for (let k = Math.ceil(200 * N / rate); k < Math.floor(5000 * N / rate); k++) { const excess = excessAt(spec, k); if (excess > 5 && spec[k] >= spec[k - 1] && spec[k] >= spec[k + 1] && stable(k)) cands.push({ k, excess }); }
    cands.sort((a, b) => b.excess - a.excess); for (const c of cands) { const f = c.k * rate / N; if (resonances.every((r) => Math.abs(Math.log2(r.freq / f)) > .3) && resonances.length < 3) resonances.push({ freq: Math.round(f), gain: -Math.min(6, Math.round((c.excess - 3) * 10) / 10), q: 5 }); }
  }
  // Sibilance: brightest unvoiced moments relative to the singing.
  const sib: number[] = []; for (let f = 0; f < s.level.length; f++) if (!voiced(f * s.hop) && s.centroid[f] > 4500 && s.level[f] > sing - 30) sib.push(s.level[f]); sib.sort((a, b) => a - b);
  const breaths = detectBreaths(x, rate, voiced).length;
  return { peakDb: db(peak), singDb: sing, noiseFloorDb: noise, spreadDb: spread, sibilanceDb: sib.length ? sib[Math.floor(sib.length * .9)] - sing : -60, bands, resonances, breaths, lowestHz };
}

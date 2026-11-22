/**
 * Drum Transcriber test fixtures: deterministic synthetic drum voices, pattern rendering with ground truth, the
 * example sample pack decoded through ffmpeg-static, and transcription accuracy metrics (onset timing, false
 * positives, missed hits and classification accuracy reported separately).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { DrumLane } from "../src/production/drums/types";

export const RATE = 44100;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; }; }

/** RBJ band-pass (constant skirt) over a buffer. */
function bandpass(x: Float32Array, rate: number, f: number, q: number): Float32Array {
  const w = 2 * Math.PI * f / rate, a = Math.sin(w) / (2 * q); const b0 = a, b2 = -a, a0 = 1 + a, a1 = -2 * Math.cos(w), a2 = 1 - a;
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function highpass(x: Float32Array, rate: number, f: number): Float32Array {
  const w = 2 * Math.PI * f / rate, q = .707, a = Math.sin(w) / (2 * q), c = Math.cos(w); const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const noise = (n: number, seed: number) => { const r = rng(seed); return Float32Array.from({ length: n }, () => r()); };

export type SynthVoice = "kick" | "snare" | "closed-hat" | "open-hat" | "clap";

/** One synthetic drum hit (peak ≈ 1 × gain). Seed varies the noise so repeated hits are not bit-identical. */
export function voice(kind: SynthVoice, gain = 1, seed = 1, rate = RATE): Float32Array {
  const len = { kick: .6, snare: .4, "closed-hat": .1, "open-hat": .8, clap: .4 }[kind]; const n = Math.round(len * rate); const out = new Float32Array(n);
  if (kind === "kick") {
    let ph = 0; const click = noise(Math.round(.002 * rate), seed);
    for (let i = 0; i < n; i++) { const t = i / rate; const f = 48 + 110 * Math.exp(-t / .028); ph += 2 * Math.PI * f / rate; out[i] = Math.sin(ph) * Math.exp(-t / .22) * Math.min(1, t / .0015); }
    for (let i = 0; i < click.length; i++) out[i] += click[i] * .15 * (1 - i / click.length);
  } else if (kind === "snare") {
    const nz = highpass(noise(n, seed), rate, 900);
    for (let i = 0; i < n; i++) { const t = i / rate; out[i] = .55 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / .07) + .75 * nz[i] * Math.exp(-t / .1); }
  } else if (kind === "closed-hat" || kind === "open-hat") {
    const nz = highpass(highpass(noise(n, seed), rate, 7000), rate, 7000); const tau = kind === "closed-hat" ? .018 : .22;
    for (let i = 0; i < n; i++) out[i] = 1.6 * nz[i] * Math.exp(-i / rate / tau);
  } else {
    const nz = bandpass(noise(n, seed), rate, 1300, .9);
    for (let i = 0; i < n; i++) { const t = i / rate; let env = 0; for (const b of [0, .011, .022]) if (t >= b) env += Math.exp(-(t - b) / .0035) * (t - b < .009 ? 1 : 0); if (t >= .03) env += .6 * Math.exp(-(t - .03) / .07); out[i] = 2.4 * nz[i] * env; }
  }
  // 15 ms fade-out so the end of a voice is never a click (an extra onset no drummer played).
  const fade = Math.round(.015 * rate); for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v)); for (let i = 0; i < n; i++) out[i] = out[i] / peak * gain;
  return out;
}

export interface TruthHit { time: number; lane: DrumLane; gain?: number }

/** Renders hits into a mono buffer of `duration` seconds (summed; overlapping hits mix). */
export function render(hits: TruthHit[], duration: number, rate = RATE, voices?: Partial<Record<DrumLane, Float32Array>>): Float32Array {
  const out = new Float32Array(Math.round(duration * rate));
  hits.forEach((h, i) => {
    const v = voices?.[h.lane] ? scale(voices[h.lane]!, h.gain ?? .8) : voice(h.lane as SynthVoice, h.gain ?? .8, i + 7, rate); const at = Math.round(h.time * rate);
    for (let j = 0; j < v.length && at + j < out.length; j++) out[at + j] += v[j];
  });
  return out;
}
const scale = (x: Float32Array, g: number) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return Float32Array.from(x, (v) => v / (p || 1) * g); };

/** A 16th-note grid pattern from a string per lane ("x" hit, "o" soft hit, "." rest), one char per 16th. */
export function pattern(bpm: number, lanes: Partial<Record<DrumLane, string>>, offset = 0, bars = 1): TruthHit[] {
  const sixteenth = 15 / bpm; const out: TruthHit[] = [];
  for (let bar = 0; bar < bars; bar++) for (const [lane, steps] of Object.entries(lanes) as [DrumLane, string][]) [...steps].forEach((c, i) => { if (c !== ".") out.push({ time: offset + (bar * steps.length + i) * sixteenth, lane, gain: c === "o" ? .3 : .8 }); });
  return out.sort((a, b) => a.time - b.time);
}

export interface Metrics {
  truth: number; detected: number;
  /** Ground-truth hits with any detected hit (any lane) within tolerance. */
  onsetsFound: number; missed: number;
  /** Detected hits that match no ground-truth hit of any lane in time. */
  falsePositives: number;
  /** Of the truth hits whose onset was found, how many have a detected hit of the right lane. */
  correctClass: number; classAccuracy: number;
  meanTimingErrorMs: number; maxTimingErrorMs: number;
  confusions: Record<string, number>;
}

export function evaluate(detected: { time: number; lane: DrumLane }[], truth: TruthHit[], tolerance = .03): Metrics {
  const usedAny = new Set<number>(); const usedLane = new Set<number>(); let onsetsFound = 0, correctClass = 0; const errs: number[] = []; const confusions: Record<string, number> = {};
  for (const t of truth) {
    const near = detected.map((d, i) => ({ d, i, e: Math.abs(d.time - t.time) })).filter((x) => x.e <= tolerance);
    if (!near.length) continue; onsetsFound++; near.forEach((x) => usedAny.add(x.i));
    const right = near.filter((x) => x.d.lane === t.lane && !usedLane.has(x.i)).sort((a, b) => a.e - b.e)[0];
    if (right) { correctClass++; usedLane.add(right.i); errs.push(right.e * 1000); }
    else { const got = near.sort((a, b) => a.e - b.e)[0].d.lane; confusions[`${t.lane}→${got}`] = (confusions[`${t.lane}→${got}`] ?? 0) + 1; }
  }
  const falsePositives = detected.filter((_, i) => !usedAny.has(i)).length;
  return { truth: truth.length, detected: detected.length, onsetsFound, missed: truth.length - onsetsFound, falsePositives, correctClass, classAccuracy: onsetsFound ? correctClass / onsetsFound : 0,
    meanTimingErrorMs: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0, maxTimingErrorMs: errs.length ? Math.max(...errs) : 0, confusions };
}

export const fmt = (name: string, m: Metrics) => `${name.padEnd(34)} truth ${String(m.truth).padStart(3)} | detected ${String(m.detected).padStart(3)} | missed ${m.missed} | false+ ${m.falsePositives} | class ${(m.classAccuracy * 100).toFixed(0)}% | timing mean ${m.meanTimingErrorMs.toFixed(1)} ms, max ${m.maxTimingErrorMs.toFixed(1)} ms${Object.keys(m.confusions).length ? ` | ${JSON.stringify(m.confusions)}` : ""}`;

export const SAMPLE_PACK = join(__dirname, "DonkeyBillabongDJ_Example_Sample_Pack");
/** Decodes an MP3 from the example sample pack to mono float at RATE via ffmpeg-static (null when unavailable). */
export function decodePack(file: string): Float32Array | null {
  const path = join(SAMPLE_PACK, file); if (!ffmpegPath || !existsSync(path)) return null;
  const r = spawnSync(ffmpegPath as unknown as string, ["-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const buf = r.stdout as Buffer; return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

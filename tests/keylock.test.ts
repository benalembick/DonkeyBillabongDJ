/**
 * Key lock: runs the real deck AudioWorklet (src/audio/deck-processor.ts) offline with a
 * fake worklet scope and measures what comes out.
 */
import { beforeAll, describe, expect, it } from "vitest";

const SR = 48000;
const BLOCK = 128;

interface Processor {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Deck: new () => Processor;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => reports.push(m) };
  };
  g.registerProcessor = (_name: string, ctor: new () => Processor) => (Deck = ctor);
  // The worklet registers itself on import (it has no exports, so import it by path).
  const worklet = "../src/audio/deck-processor";
  await import(/* @vite-ignore */ worklet);
});

const reports: unknown[] = [];

function deck(channels: Float32Array[], srcRate = SR) {
  const d = new Deck();
  const send = (m: Record<string, unknown>) => d.port.onmessage!({ data: m });
  send({ type: "load", channels, srcRate, seq: 1 });
  const render = (seconds: number) => {
    const n = Math.round((seconds * SR) / BLOCK);
    const out = new Float32Array(n * BLOCK);
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    for (let b = 0; b < n; b++) {
      d.process([], [[L, R]]);
      out.set(L, b * BLOCK);
    }
    return out;
  };
  const position = () => {
    reports.length = 0;
    for (let i = 0; i < 3; i++) d.process([], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]]);
    const r = reports.at(-1) as { seconds: number };
    return r.seconds;
  };
  return { d, send, render, position };
}

const sine = (hz: number, seconds: number, rate = SR) => Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

/** Frequency from zero crossings (pure tones). */
function pitch(x: Float32Array, from = 0.2): number {
  const a = Math.round(from * SR);
  let crossings = 0;
  for (let i = a + 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) crossings++;
  return crossings / 2 / ((x.length - a) / SR);
}

/** RMS in 10 ms windows → [min, max] after the start. */
function envelope(x: Float32Array, from = 0.2): [number, number] {
  const w = SR / 100;
  let lo = Infinity, hi = 0;
  for (let s = Math.round(from * SR); s + w <= x.length; s += w) {
    let e = 0;
    for (let i = s; i < s + w; i++) e += x[i] * x[i];
    const r = Math.sqrt(e / w);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  return [lo, hi];
}

const maxJump = (x: Float32Array, from = 0.05) => {
  let m = 0;
  for (let i = Math.round(from * SR) + 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

describe("key lock (deck worklet time-stretch)", () => {
  it("keeps the original pitch when the tempo changes, and changes it when off", () => {
    const src = sine(440, 6);
    for (const [on, expected] of [[false, 440 * 1.08], [true, 440]] as const) {
      const k = deck([src, src]);
      k.send({ type: "rate", rate: 1.08 });
      k.send({ type: "keylock", on });
      k.send({ type: "play", playing: true, seq: 2 });
      expect(pitch(k.render(2))).toBeCloseTo(expected, -0.5); // within ~1.5 Hz
    }
  });

  it("still moves the playhead at the deck's tempo (beat grids and sync stay right)", () => {
    const src = sine(440, 10);
    const k = deck([src, src]);
    k.send({ type: "rate", rate: 1.08 });
    k.send({ type: "keylock", on: true });
    k.send({ type: "play", playing: true, seq: 2 });
    k.render(3);
    expect(k.position()).toBeCloseTo(3 * 1.08, 1);
  });

  it("is (near-)identical to key lock off at 0% tempo", () => {
    const src = Float32Array.from({ length: SR * 3 }, (_, i) => 0.4 * Math.sin(i / 7) + 0.3 * Math.sin(i / 53) * Math.sin(i / 3001));
    const off = deck([src, src]);
    off.send({ type: "play", playing: true, seq: 2 });
    const a = off.render(2);
    const on = deck([src, src]);
    on.send({ type: "keylock", on: true });
    on.send({ type: "play", playing: true, seq: 2 });
    const b = on.render(2);
    let diff = 0;
    for (let i = SR * 0.1; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeLessThan(1e-4);
  });

  it("keeps a steady level (no grain wobble) on a sustained tone at +10% and -10%", () => {
    const src = sine(220, 8);
    for (const rate of [1.1, 0.9]) {
      const k = deck([src, src]);
      k.send({ type: "rate", rate });
      k.send({ type: "keylock", on: true });
      k.send({ type: "play", playing: true, seq: 2 });
      const [lo, hi] = envelope(k.render(3));
      expect(lo).toBeGreaterThan(0.5 / Math.SQRT2 * 0.85);
      expect(hi).toBeLessThan(0.5 / Math.SQRT2 * 1.1);
    }
  });

  it("keeps beats at the new tempo: a 120 BPM click track at +10% plays at 132 BPM", () => {
    const beat = SR / 2;
    const src = new Float32Array(SR * 8);
    for (let b = 0; b * beat < src.length; b++) for (let i = 0; i < 240; i++) src[b * beat + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / 60);
    const k = deck([src, src]);
    k.send({ type: "rate", rate: 1.1 });
    k.send({ type: "keylock", on: true });
    k.send({ type: "play", playing: true, seq: 2 });
    const y = k.render(5);
    // Onsets: first sample above 0.1 after 100 ms below it.
    const onsets: number[] = [];
    let quiet = SR;
    for (let i = 0; i < y.length; i++) {
      const loud = Math.abs(y[i]) > 0.1;
      if (loud && quiet > SR * 0.1) onsets.push(i);
      quiet = loud ? 0 : quiet + 1;
    }
    const gaps = onsets.slice(1).map((o, i) => (o - onsets[i]) / SR);
    expect(gaps.length).toBeGreaterThan(6);
    for (const g of gaps) expect(g).toBeCloseTo(0.5 / 1.1, 2); // ±5 ms
  });

  it("switches on and off mid-play without a click", () => {
    const src = sine(330, 6);
    const k = deck([src, src]);
    k.send({ type: "rate", rate: 1.06 });
    k.send({ type: "play", playing: true, seq: 2 });
    const parts = [k.render(0.5)];
    k.send({ type: "keylock", on: true });
    parts.push(k.render(0.5));
    k.send({ type: "keylock", on: false });
    parts.push(k.render(0.5));
    const y = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (y.set(p, o), (o += p.length));
    // A 330 Hz sine at 0.5 moves at most 2π·f·A/SR ≈ 0.022 per sample (×1.06 varispeed).
    expect(maxJump(y)).toBeLessThan(0.035);
  });

  it("loops seamlessly with key lock on", () => {
    const src = sine(250, 10);
    const k = deck([src, src]);
    k.send({ type: "rate", rate: 1.05 });
    k.send({ type: "keylock", on: true });
    k.send({ type: "loop", start: 1, end: 1.5 });
    k.send({ type: "seek", seconds: 1, seq: 3 });
    k.send({ type: "play", playing: true, seq: 4 });
    const y = k.render(3); // ~6 loop passes
    expect(maxJump(y, 0.1)).toBeLessThan(0.04);
    const p = k.position();
    expect(p).toBeGreaterThanOrEqual(1);
    expect(p).toBeLessThan(1.5);
  });

  it("scratching bypasses key lock (vinyl behaviour)", () => {
    const src = sine(440, 6);
    const k = deck([src, src]);
    k.send({ type: "keylock", on: true });
    k.send({ type: "play", playing: true, seq: 2 });
    k.render(0.5);
    k.send({ type: "scratch", active: true, seq: 3 });
    // Hand moves the record at 1.5× for a second: pitch follows the hand.
    const y = new Float32Array(SR);
    for (let b = 0; b < SR / BLOCK; b++) {
      k.send({ type: "scratchMove", seconds: (1.5 * BLOCK) / SR });
      const L = new Float32Array(BLOCK);
      k.d.process([], [[L, new Float32Array(BLOCK)]]);
      y.set(L, b * BLOCK);
    }
    expect(pitch(y, 0.3)).toBeCloseTo(660, -1);
  });

  it("works with 44.1 kHz files on a 48 kHz device", () => {
    const src = sine(440, 6, 44100);
    const k = deck([src, src], 44100);
    k.send({ type: "rate", rate: 0.94 });
    k.send({ type: "keylock", on: true });
    k.send({ type: "play", playing: true, seq: 2 });
    expect(pitch(k.render(2))).toBeCloseTo(440, -0.5);
  });

  it("runs well inside the real-time budget", () => {
    const src = Float32Array.from({ length: SR * 20 }, () => Math.random() - 0.5);
    const k = deck([src, src]);
    k.send({ type: "rate", rate: 1.07 });
    k.send({ type: "keylock", on: true });
    k.send({ type: "play", playing: true, seq: 2 });
    k.render(1); // warm up the JIT
    const t0 = performance.now();
    k.render(5);
    const perBlockMs = (performance.now() - t0) / ((5 * SR) / BLOCK);
    // One 128-frame block lasts 2.67 ms; a deck should use a small fraction of it.
    expect(perBlockMs).toBeLessThan(0.25);
    console.log(`key lock: ${(perBlockMs * 1000).toFixed(1)} µs per 128-frame block (${((perBlockMs / 2.667) * 100).toFixed(1)}% of real time)`);
  });
});

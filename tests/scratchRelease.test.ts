/**
 * Releasing the jog wheel after spinning it backwards (a backspin) should ease the playhead
 * back to normal speed over SCRATCH_RELEASE_S, not snap to it in a single ~2.7 ms block — see
 * src/audio/deck-processor.ts. Runs the real deck AudioWorklet offline with a fake worklet scope.
 */
import { beforeAll, describe, expect, it } from "vitest";

const SR = 48000;
const BLOCK = 128;

interface Processor {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Deck: new () => Processor;
let reports: { type: string; speed?: number }[] = [];

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => reports.push(m as { type: string; speed?: number }) };
  };
  g.registerProcessor = (_name: string, ctor: new () => Processor) => (Deck = ctor);
  // The worklet registers itself on import (it has no exports, so import it by path).
  const worklet = "../src/audio/deck-processor";
  await import(/* @vite-ignore */ worklet);
});

const sine = (hz: number, seconds: number) => Float32Array.from({ length: seconds * SR }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR));

function deck() {
  const src = sine(440, 8);
  const d = new Deck();
  const send = (m: Record<string, unknown>) => d.port.onmessage!({ data: m });
  send({ type: "load", channels: [src, src], srcRate: SR, seq: 1 });
  const block = () => {
    d.process([], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]]);
  };
  /**
   * Runs `blocks` render quanta, returning the "speed" from the last "pos" report in that span
   * (reports only post every REPORT_EVERY_BLOCKS blocks, so pass at least 3 to guarantee one).
   */
  const runBlocks = (blocks: number): number => {
    let last: number | undefined;
    for (let i = 0; i < blocks; i++) {
      const before = reports.length;
      block();
      for (let j = before; j < reports.length; j++) {
        const r = reports[j];
        if (r.type === "pos" && r.speed !== undefined) last = r.speed;
      }
    }
    if (last === undefined) throw new Error("no \"pos\" report in this span — run at least 3 blocks");
    return last;
  };
  return { send, block, runBlocks };
}

describe("backspin release", () => {
  it("eases back to playback speed instead of snapping instantly", () => {
    const { send, block, runBlocks } = deck();
    send({ type: "play", playing: true, seq: 2 });
    send({ type: "scratch", active: true, seq: 3 });
    // Spin backwards hard and continuously, like a fast hand-driven backspin.
    for (let i = 0; i < 40; i++) {
      send({ type: "scratchMove", seconds: -0.08 });
      block();
    }
    const duringSpin = runBlocks(3);
    expect(duringSpin).toBeLessThan(-3); // clearly spinning backwards, not idling

    // Let go: speed must not jump straight back to 1× in the very next couple of blocks...
    send({ type: "scratch", active: false, seq: 4 });
    const justAfterRelease = runBlocks(3);
    expect(justAfterRelease).toBeLessThan(0.5);

    // ...but must recover to normal forward speed well within a second.
    const recovered = runBlocks(Math.ceil((0.6 * SR) / BLOCK));
    expect(recovered).toBeGreaterThan(0.95);
    expect(recovered).toBeLessThanOrEqual(1.01);
  });

  it("still resumes immediately when there was no speed gap to recover from", () => {
    const { send, block, runBlocks } = deck();
    send({ type: "play", playing: true, seq: 2 });
    send({ type: "scratch", active: true, seq: 3 });
    // Hand moves the record forward at exactly playback speed, long enough for the scratch
    // chase itself (independent of release smoothing) to settle there.
    for (let i = 0; i < 200; i++) {
      send({ type: "scratchMove", seconds: BLOCK / SR });
      block();
    }
    send({ type: "scratch", active: false, seq: 4 });
    const after = runBlocks(3);
    expect(after).toBeCloseTo(1, 1);
  });
});

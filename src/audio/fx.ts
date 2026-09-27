/**
 * Web Audio FX processors, one slot per (channel, FX unit).
 *
 *   channel post-filter ─┬─ dry ───────────────────────┬─→ channel output
 *                        └─ send → [effect] → wet ─────┘
 *
 * Echo / delay / reverb are send-style (dry stays at full level; switching
 * the unit off closes the send so tails ring out naturally). Flanger and
 * filter are insert-style (dry is reduced as the effect is mixed in).
 */
import type { FxDsp, FxType } from "../core/engine/types";

const SMOOTH = 0.02;

export const INSERT_TYPES = new Set<FxType>(["flanger", "filter"]);

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export class FxSlot {
  readonly send: GainNode;
  /** Per-stem send from the deck worklet (used instead of the whole channel when a stem is targeted). */
  readonly stemIn: GainNode;
  private readonly input: GainNode;
  readonly wet: GainNode;
  private type: FxType | null = null;
  private nodes: AudioNode[] = [];
  private delay: DelayNode | null = null;
  private feedback: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private lfo: OscillatorNode | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbSize = -1;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, source: AudioNode, destination: AudioNode, stemSource?: { node: AudioNode; output: number }) {
    this.ctx = ctx;
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.stemIn = ctx.createGain();
    this.stemIn.gain.value = 0;
    this.input = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    source.connect(this.send);
    if (stemSource) stemSource.node.connect(this.stemIn, stemSource.output);
    this.send.connect(this.input);
    this.stemIn.connect(this.input);
    this.wet.connect(destination);
  }

  /** Apply unit parameters; `active` = unit enabled and this channel assigned. */
  update(fx: FxDsp, active: boolean, useStems = false): void {
    if (fx.type !== this.type) this.build(fx.type);
    const t = this.ctx.currentTime;
    const insert = INSERT_TYPES.has(fx.type);
    this.send.gain.setTargetAtTime(active && !useStems ? 1 : 0, t, SMOOTH);
    this.stemIn.gain.setTargetAtTime(active && useStems ? 1 : 0, t, SMOOTH);
    // Send FX keep their wet level so tails decay after switching off; insert FX drop out entirely.
    this.wet.gain.setTargetAtTime(insert ? (active ? fx.mix : 0) : fx.mix, t, SMOOTH);
    const p = fx.param;
    switch (fx.type) {
      case "echo":
        this.delay!.delayTime.setTargetAtTime(fx.timeSec, t, 0.05);
        this.feedback!.gain.setTargetAtTime(0.25 + p * 0.6, t, SMOOTH);
        this.filter!.frequency.setTargetAtTime(1500 + p * 4000, t, SMOOTH);
        break;
      case "delay":
        this.delay!.delayTime.setTargetAtTime(fx.timeSec, t, 0.05);
        this.feedback!.gain.setTargetAtTime(0.1 + p * 0.6, t, SMOOTH);
        break;
      case "reverb": {
        const size = Math.round((0.8 + p * 3.2) * 4) / 4; // 0.8–4 s, quantised to avoid constant rebuilds
        if (size !== this.reverbSize) {
          this.reverbSize = size;
          this.convolver!.buffer = impulse(this.ctx, size);
        }
        break;
      }
      case "flanger":
        this.lfo!.frequency.setTargetAtTime(0.05 + p * 1.5, t, SMOOTH);
        break;
      case "filter": {
        // Left half: low-pass sweep, right half: high-pass sweep (resonant).
        const f = this.filter!;
        if (p < 0.5) {
          f.type = "lowpass";
          f.frequency.setTargetAtTime(20000 * Math.pow(200 / 20000, (0.5 - p) * 2), t, SMOOTH);
        } else {
          f.type = "highpass";
          f.frequency.setTargetAtTime(20 * Math.pow(5000 / 20, (p - 0.5) * 2), t, SMOOTH);
        }
        break;
      }
    }
  }

  /** How much this slot replaces the dry signal (insert effects only). */
  dryReduction(fx: FxDsp, active: boolean): number {
    return INSERT_TYPES.has(fx.type) && active ? fx.mix : 0;
  }

  private teardown(): void {
    try {
      this.input.disconnect();
    } catch {
      /* not connected */
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.lfo?.stop();
    this.nodes = [];
    this.delay = this.feedback = this.filter = this.convolver = null;
    this.lfo = null;
    this.reverbSize = -1;
  }

  private build(type: FxType): void {
    this.teardown();
    const ctx = this.ctx;
    this.type = type;
    const keep = <T extends AudioNode>(n: T) => (this.nodes.push(n), n);
    switch (type) {
      case "echo":
      case "delay": {
        const delay = keep(ctx.createDelay(4));
        const fb = keep(ctx.createGain());
        this.input.connect(delay);
        if (type === "echo") {
          const lp = keep(ctx.createBiquadFilter());
          lp.type = "lowpass";
          delay.connect(lp).connect(fb);
          this.filter = lp;
        } else {
          delay.connect(fb);
        }
        fb.connect(delay);
        delay.connect(this.wet);
        this.delay = delay;
        this.feedback = fb;
        break;
      }
      case "reverb": {
        const hp = keep(ctx.createBiquadFilter());
        hp.type = "highpass";
        hp.frequency.value = 250;
        const conv = keep(ctx.createConvolver());
        this.input.connect(hp).connect(conv).connect(this.wet);
        this.convolver = conv;
        break;
      }
      case "flanger": {
        const delay = keep(ctx.createDelay(0.05));
        delay.delayTime.value = 0.004;
        const fb = keep(ctx.createGain());
        fb.gain.value = 0.55;
        const lfo = ctx.createOscillator();
        const depth = keep(ctx.createGain());
        depth.gain.value = 0.0025;
        lfo.connect(depth).connect(delay.delayTime);
        lfo.start();
        this.lfo = lfo;
        this.input.connect(delay);
        delay.connect(fb).connect(delay);
        // Flanger = dry + modulated copy; the wet path carries both so the insert mix sounds right.
        this.input.connect(this.wet);
        delay.connect(this.wet);
        break;
      }
      case "filter": {
        const f = keep(ctx.createBiquadFilter());
        f.Q.value = 4;
        this.input.connect(f).connect(this.wet);
        this.filter = f;
        break;
      }
    }
  }
}

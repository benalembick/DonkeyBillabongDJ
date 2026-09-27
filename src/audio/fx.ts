/**
 * Web Audio FX processors: one FxSlot per (channel, FX unit, slot).
 *
 *   channel post-filter ─┬─ dry ────────────────────────────────┬─→ channel output
 *   worklet stem send ───┼─ send/stemIn → input → [effect] → wet ┘
 *
 * Echo / delay / reverb are send-style (dry stays at full level; switching the
 * slot off closes the send so tails ring out naturally). Everything else is
 * insert-style: the dry signal is reduced as the effect is mixed in.
 *
 * Effects are built lazily the first time a slot is switched on, so the nine
 * idle slots of a deck cost no DSP. Parameter changes are smoothed; switching
 * uses short gain ramps, never hard cuts.
 */
import type { FxType } from "../core/engine/types";

const SMOOTH = 0.02;

export const INSERT_TYPES = new Set<FxType>(["flanger", "phaser", "filter", "bitcrusher", "distortion", "gate", "roll"]);
/** Effects whose tail keeps ringing after they are switched off. */
const TAIL_TYPES = new Set<FxType>(["echo", "delay", "reverb"]);

export interface FxSlotParams {
  type: FxType;
  /** Unit level (dry/wet) 0..1. */
  mix: number;
  /** Effect-specific 0..1. */
  param: number;
  /** Beat-synced time in seconds (echo/delay/gate/roll). */
  timeSec: number;
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

/** Quantiser curve for the bitcrusher (bits of resolution). */
function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const levels = Math.pow(2, bits - 1);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

/** Soft-clip curve for distortion, level-compensated. */
function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const k = 1 + drive * 40;
  const norm = Math.tanh(k);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
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
  private filters: BiquadFilterNode[] = [];
  private lfo: OscillatorNode | null = null;
  private lfoDepth: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private gate: GainNode | null = null;
  private rollIn: GainNode | null = null;
  private rollDirect: GainNode | null = null;
  private reverbSize = -1;
  private shaperKey = -1;
  private wasActive = false;
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

  /** Apply parameters; `active` = slot on and this channel assigned to the unit. */
  update(fx: FxSlotParams, active: boolean, useStems = false): void {
    if (fx.type !== this.type) {
      // Build on first use; an idle slot whose effect changed just drops the old one.
      if (active) this.build(fx.type);
      else if (this.type !== null && !(TAIL_TYPES.has(this.type) && this.wasActive)) this.teardown();
    }
    const built = this.type === fx.type;
    const t = this.ctx.currentTime;
    const insert = INSERT_TYPES.has(fx.type);
    this.send.gain.setTargetAtTime(active && !useStems ? 1 : 0, t, SMOOTH);
    this.stemIn.gain.setTargetAtTime(active && useStems ? 1 : 0, t, SMOOTH);
    // Send FX keep their wet level so tails decay after switching off; insert FX drop out entirely.
    this.wet.gain.setTargetAtTime(insert ? (active ? fx.mix : 0) : fx.mix, t, SMOOTH);
    const rising = active && !this.wasActive;
    const falling = !active && this.wasActive;
    this.wasActive = active;
    if (!built) return;
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
      case "phaser":
        this.lfo!.frequency.setTargetAtTime(0.1 + p * 3, t, SMOOTH);
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
      case "bitcrusher": {
        const bits = Math.round(12 - p * 10); // 12 → 2 bits
        if (bits !== this.shaperKey) {
          this.shaperKey = bits;
          this.shaper!.curve = crushCurve(bits);
        }
        // Sample-rate reduction feel: a falling low-pass after the quantiser.
        this.filter!.frequency.setTargetAtTime(18000 * Math.pow(0.08, p), t, SMOOTH);
        break;
      }
      case "distortion": {
        const key = Math.round(p * 20);
        if (key !== this.shaperKey) {
          this.shaperKey = key;
          this.shaper!.curve = driveCurve(key / 20);
        }
        break;
      }
      case "gate": {
        // Square LFO at the beat time; depth = how far the gate closes.
        const depth = 0.3 + p * 0.7;
        this.lfo!.frequency.setTargetAtTime(1 / Math.max(0.03, fx.timeSec), t, 0.05);
        this.lfoDepth!.gain.setTargetAtTime(depth / 2, t, SMOOTH);
        this.gate!.gain.setTargetAtTime(1 - depth / 2, t, SMOOTH);
        break;
      }
      case "roll": {
        // Capture one beat-length slice, then repeat it (delay loop with unity feedback).
        const T = Math.min(3.9, Math.max(0.03, fx.timeSec));
        const d = this.delay!;
        if (rising) {
          d.delayTime.cancelScheduledValues(t);
          d.delayTime.setValueAtTime(T, t);
          for (const [g, before, after] of [
            [this.rollIn!, 1, 0],
            [this.rollDirect!, 1, 0],
            [this.feedback!, 0, 0.8 + p * 0.2],
          ] as const) {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(before, t);
            g.gain.setValueAtTime(after, t + T);
          }
        } else if (falling) {
          for (const g of [this.rollIn!, this.rollDirect!, this.feedback!]) {
            g.gain.cancelScheduledValues(t);
            g.gain.setTargetAtTime(0, t, 0.005);
          }
        }
        break;
      }
    }
  }

  /** How much this slot replaces the dry signal (insert effects only). */
  dryReduction(fx: FxSlotParams, active: boolean): number {
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
    this.filters = [];
    this.delay = this.feedback = this.filter = this.convolver = null;
    this.shaper = this.gate = this.rollIn = this.rollDirect = this.lfoDepth = null;
    this.lfo = null;
    this.type = null;
    this.reverbSize = -1;
    this.shaperKey = -1;
  }

  private build(type: FxType): void {
    this.teardown();
    const ctx = this.ctx;
    this.type = type;
    const keep = <T extends AudioNode>(n: T) => (this.nodes.push(n), n);
    const startLfo = (wave: OscillatorType, depth: number) => {
      const lfo = ctx.createOscillator();
      lfo.type = wave;
      const g = keep(ctx.createGain());
      g.gain.value = depth;
      lfo.connect(g);
      lfo.start();
      this.lfo = lfo;
      this.lfoDepth = g;
      return g;
    };
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
        startLfo("sine", 0.0025).connect(delay.delayTime);
        this.input.connect(delay);
        delay.connect(fb).connect(delay);
        // Flanger = dry + modulated copy; the wet path carries both so the insert mix sounds right.
        this.input.connect(this.wet);
        delay.connect(this.wet);
        break;
      }
      case "phaser": {
        // Four swept all-pass stages summed with the dry signal → moving notches.
        const mod = startLfo("sine", 700);
        let prev: AudioNode = this.input;
        for (let i = 0; i < 4; i++) {
          const ap = keep(ctx.createBiquadFilter());
          ap.type = "allpass";
          ap.frequency.value = 900 + i * 300;
          ap.Q.value = 0.8;
          mod.connect(ap.frequency);
          prev.connect(ap);
          prev = ap;
          this.filters.push(ap);
        }
        this.input.connect(this.wet);
        prev.connect(this.wet);
        break;
      }
      case "filter": {
        const f = keep(ctx.createBiquadFilter());
        f.Q.value = 4;
        this.input.connect(f).connect(this.wet);
        this.filter = f;
        break;
      }
      case "bitcrusher": {
        const sh = keep(ctx.createWaveShaper());
        const lp = keep(ctx.createBiquadFilter());
        lp.type = "lowpass";
        this.input.connect(sh).connect(lp).connect(this.wet);
        this.shaper = sh;
        this.filter = lp;
        break;
      }
      case "distortion": {
        const sh = keep(ctx.createWaveShaper());
        sh.oversample = "2x";
        const out = keep(ctx.createGain());
        out.gain.value = 0.7;
        this.input.connect(sh).connect(out).connect(this.wet);
        this.shaper = sh;
        break;
      }
      case "gate": {
        const gate = keep(ctx.createGain());
        gate.gain.value = 1;
        // Smooth the square wave's edges so the gate doesn't click.
        const smooth = keep(ctx.createBiquadFilter());
        smooth.type = "lowpass";
        smooth.frequency.value = 180;
        const depth = startLfo("square", 0.5);
        depth.disconnect();
        this.lfo!.disconnect();
        this.lfo!.connect(smooth).connect(depth).connect(gate.gain);
        this.input.connect(gate).connect(this.wet);
        this.gate = gate;
        break;
      }
      case "roll": {
        const rollIn = keep(ctx.createGain());
        rollIn.gain.value = 0;
        const direct = keep(ctx.createGain());
        direct.gain.value = 0;
        const delay = keep(ctx.createDelay(4));
        const fb = keep(ctx.createGain());
        fb.gain.value = 0;
        this.input.connect(rollIn).connect(delay);
        delay.connect(fb).connect(delay);
        delay.connect(this.wet);
        // The first pass is the live signal; afterwards the captured slice repeats.
        this.input.connect(direct).connect(this.wet);
        this.rollIn = rollIn;
        this.rollDirect = direct;
        this.delay = delay;
        this.feedback = fb;
        this.wasActive = false; // the next update is a fresh trigger
        break;
      }
    }
  }
}

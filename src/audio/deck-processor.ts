/**
 * Deck player AudioWorklet (runs on the real-time audio thread).
 *
 * Plays decoded PCM at an arbitrary signed velocity with 4-point Hermite
 * interpolation, which gives us tempo (varispeed), pitch bend/nudge, reverse
 * and scratching in one mechanism. Velocity changes are ramped per sample and
 * play/pause/seek are de-clicked.
 *
 * Rules for this file: no allocation in process(), no imports, no logging.
 */

interface WorkletScope {
  sampleRate: number;
  currentTime: number;
  registerProcessor(name: string, ctor: unknown): void;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
}
const scope = globalThis as unknown as WorkletScope;

type Msg =
  | { type: "load"; channels: Float32Array[]; srcRate: number; seq: number }
  | { type: "unload"; seq: number }
  | { type: "play"; playing: boolean; seq: number }
  | { type: "seek"; seconds: number; seq: number }
  | { type: "rate"; rate: number }
  | { type: "nudge"; offset: number }
  | { type: "scratch"; active: boolean; seq: number }
  | { type: "scratchMove"; seconds: number };

const BEND_TAU_S = 0.06; // nudge decay time constant
const BEND_MAX = 0.9;
const FADE_S = 0.004; // play/pause de-click
const SEEK_FADE_SAMPLES = 96;
const SCRATCH_LAG_BLOCKS = 2.5; // how quickly the playhead chases the hand
const SCRATCH_SMOOTH = 0.35;
const SCRATCH_MAX_VEL = 12;
const REPORT_EVERY_BLOCKS = 3;

class DeckProcessor extends scope.AudioWorkletProcessor {
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private len = 0;
  private ratio = 1; // source frames per output frame at rate 1

  private pos = 0; // source frames (double)
  private playing = false;
  private rate = 1;
  private bend = 0;
  private scratching = false;
  private scratchTarget = 0;
  private scratchVel = 0;
  private vel = 0; // current velocity, source frames per output frame
  private gain = 0; // play/pause envelope
  private seekFade = 1;
  private seq = 0;
  private blockCount = 0;
  private endedSent = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => this.onMessage(e.data);
  }

  private onMessage(m: Msg): void {
    switch (m.type) {
      case "load":
        this.left = m.channels[0] ?? null;
        this.right = m.channels[1] ?? m.channels[0] ?? null;
        this.len = this.left ? this.left.length : 0;
        this.ratio = m.srcRate / scope.sampleRate;
        this.pos = 0;
        this.playing = false;
        this.scratching = false;
        this.vel = 0;
        this.gain = 0;
        this.bend = 0;
        this.endedSent = false;
        this.seq = m.seq;
        break;
      case "unload":
        this.left = this.right = null;
        this.len = 0;
        this.playing = false;
        this.seq = m.seq;
        break;
      case "play":
        this.playing = m.playing;
        if (m.playing) this.endedSent = false;
        this.seq = m.seq;
        break;
      case "seek":
        this.pos = Math.max(0, m.seconds * scope.sampleRate * this.ratio);
        if (this.scratching) this.scratchTarget = this.pos;
        this.seekFade = 0;
        this.endedSent = false;
        this.seq = m.seq;
        break;
      case "rate":
        this.rate = m.rate;
        break;
      case "nudge":
        this.bend = Math.max(-BEND_MAX, Math.min(BEND_MAX, this.bend + m.offset));
        break;
      case "scratch":
        this.scratching = m.active;
        this.scratchTarget = this.pos;
        this.scratchVel = m.active ? 0 : this.vel;
        this.seq = m.seq;
        break;
      case "scratchMove":
        this.scratchTarget += m.seconds * scope.sampleRate * this.ratio;
        break;
    }
  }

  private sample(buf: Float32Array, p: number): number {
    const i = Math.floor(p);
    const f = p - i;
    const n = this.len;
    const xm1 = i - 1 >= 0 && i - 1 < n ? buf[i - 1] : 0;
    const x0 = i >= 0 && i < n ? buf[i] : 0;
    const x1 = i + 1 >= 0 && i + 1 < n ? buf[i + 1] : 0;
    const x2 = i + 2 >= 0 && i + 2 < n ? buf[i + 2] : 0;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    const N = outL.length;
    const L = this.left;
    const R = this.right;

    if (!L || !R || this.len === 0) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      this.report();
      return true;
    }

    // Decay pitch bend (nudge) once per block.
    this.bend *= Math.exp(-N / scope.sampleRate / BEND_TAU_S);
    if (Math.abs(this.bend) < 1e-5) this.bend = 0;

    let target: number;
    let gainTarget: number;
    if (this.scratching) {
      const desired = (this.scratchTarget - this.pos) / (N * SCRATCH_LAG_BLOCKS);
      this.scratchVel += (desired - this.scratchVel) * SCRATCH_SMOOTH;
      if (this.scratchVel > SCRATCH_MAX_VEL) this.scratchVel = SCRATCH_MAX_VEL;
      else if (this.scratchVel < -SCRATCH_MAX_VEL) this.scratchVel = -SCRATCH_MAX_VEL;
      target = this.scratchVel;
      gainTarget = 1;
    } else if (this.playing) {
      target = (this.rate + this.bend) * this.ratio;
      gainTarget = 1;
    } else {
      // Keep moving at the last speed while fading out, then stop.
      target = this.gain > 0 ? this.vel : 0;
      gainTarget = 0;
    }

    const v0 = this.vel;
    const dv = (target - v0) / N;
    const gStep = 1 / (FADE_S * scope.sampleRate);
    let pos = this.pos;
    let g = this.gain;
    let sf = this.seekFade;

    for (let i = 0; i < N; i++) {
      if (g < gainTarget) g = Math.min(gainTarget, g + gStep);
      else if (g > gainTarget) g = Math.max(gainTarget, g - gStep);
      if (sf < 1) sf = Math.min(1, sf + 1 / SEEK_FADE_SAMPLES);
      const amp = g * sf;
      if (amp > 0 && pos >= 0 && pos < this.len) {
        outL[i] = this.sample(L, pos) * amp;
        outR[i] = R === L ? outL[i] : this.sample(R, pos) * amp;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
      if (g > 0 || this.scratching) pos += v0 + dv * (i + 1);
    }

    this.vel = gainTarget === 0 && g === 0 ? 0 : target;
    this.gain = g;
    this.seekFade = sf;
    if (pos < -this.len) pos = -this.len;
    this.pos = pos;

    if (this.playing && !this.scratching && pos >= this.len && !this.endedSent) {
      this.endedSent = true;
      this.playing = false;
      this.pos = this.len;
      this.port.postMessage({ type: "ended", seq: this.seq });
    }

    this.report();
    return true;
  }

  private report(): void {
    if (++this.blockCount % REPORT_EVERY_BLOCKS !== 0) return;
    const srcRate = this.ratio * scope.sampleRate;
    this.port.postMessage({
      type: "pos",
      seconds: this.pos / srcRate,
      // Audible speed in seconds of track per second of wall-clock time.
      speed: this.gain > 0 || this.scratching ? (this.vel * scope.sampleRate) / srcRate : 0,
      time: scope.currentTime,
      seq: this.seq,
    });
  }
}

scope.registerProcessor("dbdj-deck", DeckProcessor);

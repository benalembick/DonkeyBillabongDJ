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
  | { type: "scratchMove"; seconds: number }
  // STEMS: separated vocals/drums/bass arrive per region (Int16, interleaved [vL vR dL dR bL bR] at 44.1 kHz).
  | { type: "stemsInit"; stride: number; regions: number; rate: number }
  | { type: "stemsRegion"; region: number; data: Int16Array }
  | { type: "stemsMix"; enabled: boolean; gains: number[] }
  | { type: "stemsFx"; unit: number; mask: number[] }
  | { type: "stemsClear" };

const BEND_TAU_S = 0.06; // nudge decay time constant
const BEND_MAX = 0.9;
const FADE_S = 0.004; // play/pause de-click
const SEEK_FADE_SAMPLES = 96;
const SCRATCH_LAG_BLOCKS = 2.5; // how quickly the playhead chases the hand
const SCRATCH_SMOOTH = 0.35;
const SCRATCH_MAX_VEL = 12;
const REPORT_EVERY_BLOCKS = 3;
const STEM_GAIN_S = 0.006; // per-stem gain smoothing
const STEM_BLEND_S = 0.012; // original ⇄ stem-mix crossfade (entering/leaving analysed regions)
const I16 = 1 / 32768;

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

  // STEMS
  private stemRegions: (Int16Array | null)[] = [];
  private stemStride = 1;
  private stemRatio = 1; // stem frames (44.1 kHz) per source frame
  private stemsEnabled = false;
  private stemTarget = [1, 1, 1, 1]; // vocals, drums, bass, instruments
  private stemGain = [1, 1, 1, 1];
  private stemAmt = 0; // 0 = original, 1 = stem mix
  private fxMask = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  private stemTap = new Float32Array(6);

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
        this.stemRegions = [];
        this.stemAmt = 0;
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
      case "stemsInit":
        this.stemRegions = new Array(m.regions).fill(null);
        this.stemStride = m.stride;
        this.stemRatio = m.rate / (this.ratio * scope.sampleRate);
        break;
      case "stemsRegion":
        if (m.region >= 0 && m.region < this.stemRegions.length) this.stemRegions[m.region] = m.data;
        break;
      case "stemsMix":
        this.stemsEnabled = m.enabled;
        for (let k = 0; k < 4; k++) this.stemTarget[k] = m.gains[k] ?? 1;
        break;
      case "stemsFx":
        if (m.unit === 0 || m.unit === 1) this.fxMask[m.unit] = m.mask.slice(0, 4);
        break;
      case "stemsClear":
        this.stemRegions = [];
        this.stemAmt = 0;
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

  /** Is separated audio available at source position p? */
  private stemsReadyAt(p: number): boolean {
    const r = Math.floor((p * this.stemRatio) / this.stemStride);
    return r >= 0 && r < this.stemRegions.length && this.stemRegions[r] !== null;
  }

  /** Hermite-interpolated 6-channel stem sample at source position p → this.stemTap. */
  private stemSample(p: number): void {
    const q = p * this.stemRatio;
    const i = Math.floor(q);
    const f = q - i;
    const t = this.stemTap;
    for (let ch = 0; ch < 6; ch++) {
      const xm1 = this.stemAt(i - 1, ch);
      const x0 = this.stemAt(i, ch);
      const x1 = this.stemAt(i + 1, ch);
      const x2 = this.stemAt(i + 2, ch);
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      t[ch] = (((c3 * f + c2) * f + c1) * f + x0) * I16;
    }
  }

  private stemAt(frame: number, ch: number): number {
    if (frame < 0) return 0;
    const r = Math.floor(frame / this.stemStride);
    const reg = this.stemRegions[r];
    if (!reg) return 0;
    const idx = (frame - r * this.stemStride) * 6 + ch;
    return idx < reg.length ? reg[idx] : 0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    const N = outL.length;
    const L = this.left;
    const R = this.right;
    const fx0 = outputs[1];
    const fx1 = outputs[2];

    if (!L || !R || this.len === 0) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      for (const o of [fx0, fx1]) if (o) for (const c of o) c.fill(0);
      this.report();
      return true;
    }
    const hasStems = this.stemRegions.length > 0;
    const m0 = this.fxMask[0];
    const m1 = this.fxMask[1];
    const fxActive = hasStems && (m0[0] + m0[1] + m0[2] + m0[3] + m1[0] + m1[1] + m1[2] + m1[3] > 0);
    const gStepStem = 1 / (STEM_GAIN_S * scope.sampleRate);
    const blendStep = 1 / (STEM_BLEND_S * scope.sampleRate);
    const sg = this.stemGain;
    const st = this.stemTarget;

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
        let oL = this.sample(L, pos);
        let oR = R === L ? oL : this.sample(R, pos);
        let s0L = 0;
        let s0R = 0;
        let s1L = 0;
        let s1R = 0;
        if (hasStems) {
          for (let k = 0; k < 4; k++) {
            if (sg[k] < st[k]) sg[k] = Math.min(st[k], sg[k] + gStepStem);
            else if (sg[k] > st[k]) sg[k] = Math.max(st[k], sg[k] - gStepStem);
          }
          const ready = this.stemsReadyAt(pos);
          const blendTarget = this.stemsEnabled && ready ? 1 : 0;
          if (this.stemAmt < blendTarget) this.stemAmt = Math.min(1, this.stemAmt + blendStep);
          else if (this.stemAmt > blendTarget) this.stemAmt = Math.max(0, this.stemAmt - blendStep);
          if (ready && (this.stemAmt > 0 || fxActive)) {
            this.stemSample(pos);
            const t = this.stemTap;
            // instruments = original − (vocals + drums + bass): all gains at 1 reproduces the original exactly.
            const iL = oL - t[0] - t[2] - t[4];
            const iR = oR - t[1] - t[3] - t[5];
            if (this.stemAmt > 0) {
              const mixL = t[0] * sg[0] + t[2] * sg[1] + t[4] * sg[2] + iL * sg[3];
              const mixR = t[1] * sg[0] + t[3] * sg[1] + t[5] * sg[2] + iR * sg[3];
              oL += this.stemAmt * (mixL - oL);
              oR += this.stemAmt * (mixR - oR);
            }
            if (fxActive) {
              // Per-stem FX sends (e.g. echo on vocals only), after the stem mutes/volumes.
              s0L = t[0] * sg[0] * m0[0] + t[2] * sg[1] * m0[1] + t[4] * sg[2] * m0[2] + iL * sg[3] * m0[3];
              s0R = t[1] * sg[0] * m0[0] + t[3] * sg[1] * m0[1] + t[5] * sg[2] * m0[2] + iR * sg[3] * m0[3];
              s1L = t[0] * sg[0] * m1[0] + t[2] * sg[1] * m1[1] + t[4] * sg[2] * m1[2] + iL * sg[3] * m1[3];
              s1R = t[1] * sg[0] * m1[0] + t[3] * sg[1] * m1[1] + t[5] * sg[2] * m1[2] + iR * sg[3] * m1[3];
            }
          }
        }
        outL[i] = oL * amp;
        outR[i] = oR * amp;
        if (fx0) {
          fx0[0][i] = s0L * amp;
          if (fx0[1]) fx0[1][i] = s0R * amp;
        }
        if (fx1) {
          fx1[0][i] = s1L * amp;
          if (fx1[1]) fx1[1][i] = s1R * amp;
        }
      } else {
        outL[i] = 0;
        outR[i] = 0;
        if (fx0) {
          fx0[0][i] = 0;
          if (fx0[1]) fx0[1][i] = 0;
        }
        if (fx1) {
          fx1[0][i] = 0;
          if (fx1[1]) fx1[1][i] = 0;
        }
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
      stemsReady: this.stemRegions.length > 0 && this.stemsReadyAt(this.pos),
    });
  }
}

scope.registerProcessor("dbdj-deck", DeckProcessor);

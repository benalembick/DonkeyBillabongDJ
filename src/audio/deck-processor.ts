/**
 * Deck player AudioWorklet (runs on the real-time audio thread).
 *
 * Plays decoded PCM at an arbitrary signed velocity with 4-point Hermite
 * interpolation, which gives us tempo (varispeed), pitch bend/nudge, reverse
 * and scratching in one mechanism. Velocity changes are ramped per sample and
 * play/pause/seek are de-clicked.
 *
 * KEY LOCK (time-stretch, WSOLA): the playhead still moves at the deck's tempo, but the
 * sound comes from two overlapping Hann-windowed grains that read the track at its
 * original speed, so the pitch never changes. Each new grain starts at the playhead,
 * shifted by up to ±KL_SEARCH_S to where it best matches the grain it overlaps (no
 * phasing or flamming). At 0% tempo the grains line up exactly: identical to key lock off.
 * Scratching always bypasses it (vinyl behaviour).
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
  | { type: "keylock"; on: boolean }
  | { type: "nudge"; offset: number }
  | { type: "scratch"; active: boolean; seq: number }
  | { type: "scratchMove"; seconds: number }
  // STEMS: separated vocals/drums/bass arrive per region (Int16, interleaved [vL vR dL dR bL bR] at 44.1 kHz).
  | { type: "stemsInit"; stride: number; regions: number; rate: number }
  | { type: "stemsRegion"; region: number; data: Int16Array }
  | { type: "stemsMix"; enabled: boolean; gains: number[] }
  | { type: "stemsFx"; unit: number; mask: number[] }
  | { type: "stemsClear" }
  // Loop between two track positions (seconds); null start = no loop.
  | { type: "loop"; start: number | null; end: number };

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
const LOOP_XF_S = 0.004; // crossfade into the loop start before wrapping (click-free loops)
const LOOP_CATCH_S = 0.25; // a loop set just behind the playhead (e.g. LOOP OUT) still engages
const KL_GRAIN_S = 0.042; // key lock grain length (output time); grains overlap by half
const KL_SEARCH_S = 0.009; // ± how far a grain start may move to line up with the previous one
const KL_CORR_STEP = 4; // correlation uses every 4th sample (cost vs. accuracy)
const KL_BLEND_S = 0.012; // key lock on/off crossfade

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
  // Output frame: [L, R, fx0L, fx0R, fx1L, fx1R] (+ a second one for loop crossfades).
  private fr = new Float64Array(6);
  private fr2 = new Float64Array(6);
  private fg1 = new Float64Array(6);
  private fg2 = new Float64Array(6);

  // KEY LOCK (grain positions in source frames)
  private klOn = false;
  private klAmt = 0; // 0 = varispeed, 1 = time-stretched
  private klActive = false;
  private klPhase = 0; // output samples into the current half-grain
  private klOld = 0; // grain in its second half (fading out)
  private klNew = 0; // grain in its first half (fading in)
  private readonly klH: number;
  private readonly klWin: Float32Array;
  private readonly klRef: Float32Array;

  // LOOP (source frames)
  private loopOn = false;
  private loopStart = 0;
  private loopEnd = 0;

  constructor() {
    super();
    this.klH = Math.max(64, Math.round((KL_GRAIN_S * scope.sampleRate) / 2));
    const W = this.klH * 2;
    // Periodic Hann: w[n] + w[n + H] = 1, so two grains half a grain apart sum to unity.
    this.klWin = new Float32Array(W);
    for (let n = 0; n < W; n++) this.klWin[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / W);
    this.klRef = new Float32Array(Math.ceil(this.klH / KL_CORR_STEP));
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
        this.loopOn = false;
        this.klActive = false;
        this.seq = m.seq;
        break;
      case "unload":
        this.loopOn = false;
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
        this.klActive = false;
        this.seq = m.seq;
        break;
      case "rate":
        this.rate = m.rate;
        break;
      case "keylock":
        this.klOn = m.on;
        break;
      case "nudge":
        this.bend = Math.max(-BEND_MAX, Math.min(BEND_MAX, this.bend + m.offset));
        break;
      case "scratch":
        this.scratching = m.active;
        this.scratchTarget = this.pos;
        this.scratchVel = m.active ? 0 : this.vel;
        this.klActive = false;
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
      case "loop": {
        const sr = this.ratio * scope.sampleRate;
        if (m.start === null || m.end <= m.start) {
          this.loopOn = false;
          break;
        }
        this.loopStart = m.start * sr;
        this.loopEnd = m.end * sr;
        this.loopOn = true;
        // The playhead may already be slightly past the new end (message latency): wrap now.
        if (this.pos >= this.loopEnd && this.pos < this.loopEnd + LOOP_CATCH_S * sr) {
          this.pos -= this.loopEnd - this.loopStart;
          this.seekFade = 0;
        }
        break;
      }
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

  /** Render one output frame at source position p into `o` (stem gains/blend already advanced). */
  private renderFrame(p: number, o: Float64Array, hasStems: boolean, fxActive: boolean, m0: number[], m1: number[]): void {
    const L = this.left!;
    const R = this.right!;
    let oL = this.sample(L, p);
    let oR = R === L ? oL : this.sample(R, p);
    let s0L = 0;
    let s0R = 0;
    let s1L = 0;
    let s1R = 0;
    if (hasStems && this.stemsReadyAt(p) && (this.stemAmt > 0 || fxActive)) {
      const sg = this.stemGain;
      this.stemSample(p);
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
    o[0] = oL;
    o[1] = oR;
    o[2] = s0L;
    o[3] = s0R;
    o[4] = s1L;
    o[5] = s1R;
  }

  /**
   * Render source position p with loop handling: crossfade into the loop start just before
   * the loop end, and (for key lock grains, which can run slightly past the playhead) wrap
   * positions beyond the end back into the loop.
   */
  private renderLooped(p: number, o: Float64Array, wrap: boolean, hasStems: boolean, fxActive: boolean, m0: number[], m1: number[]): void {
    const loopLen = this.loopEnd - this.loopStart;
    if (wrap && p >= this.loopEnd) p = this.loopStart + ((p - this.loopStart) % loopLen);
    this.renderFrame(p, o, hasStems, fxActive, m0, m1);
    if (!wrap) return;
    const xf = Math.max(1, Math.min(LOOP_XF_S * scope.sampleRate * this.ratio, loopLen * 0.25));
    if (p >= this.loopEnd - xf && p < this.loopEnd) {
      const w = (p - (this.loopEnd - xf)) / xf;
      const o2 = this.fr2;
      this.renderFrame(p - loopLen, o2, hasStems, fxActive, m0, m1);
      for (let k = 0; k < 6; k++) o[k] += w * (o2[k] - o[k]);
    }
  }

  /** Mono source sample (nearest frame) for grain alignment. */
  private mono(p: number, wrap: boolean): number {
    if (wrap && p >= this.loopEnd) p = this.loopStart + ((p - this.loopStart) % (this.loopEnd - this.loopStart));
    const i = Math.round(p);
    return i >= 0 && i < this.len ? this.left![i] + this.right![i] : 0;
  }

  /**
   * WSOLA: where near `ideal` should a new grain start so its opening matches what the
   * overlapping grain (now at `ref`) plays next? Normalised cross-correlation, coarse then fine.
   */
  private klAlign(ideal: number, ref: number, wrap: boolean): number {
    const step = KL_CORR_STEP * this.ratio;
    const r = this.klRef;
    let refEnergy = 0;
    for (let k = 0; k < r.length; k++) {
      r[k] = this.mono(ref + k * step, wrap);
      refEnergy += r[k] * r[k];
    }
    if (refEnergy < 1e-6) return ideal; // silence: nothing to line up with
    const search = Math.round(KL_SEARCH_S * scope.sampleRate * this.ratio);
    let bestOff = 0;
    let best = this.klScore(ideal, step, wrap);
    for (let off = -search; off <= search; off += 2) {
      if (off === 0) continue;
      const sc = this.klScore(ideal + off, step, wrap);
      if (sc > best) {
        best = sc;
        bestOff = off;
      }
    }
    const coarse = bestOff;
    for (let off = coarse - 1; off <= coarse + 1; off += 2) {
      const sc = this.klScore(ideal + off, step, wrap);
      if (sc > best) {
        best = sc;
        bestOff = off;
      }
    }
    return ideal + bestOff;
  }

  private klScore(start: number, step: number, wrap: boolean): number {
    const r = this.klRef;
    let c = 0;
    let e = 1e-9;
    for (let k = 0; k < r.length; k++) {
      const x = this.mono(start + k * step, wrap);
      c += x * r[k];
      e += x * x;
    }
    return c / Math.sqrt(e);
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
    const inLoop = this.loopOn && !this.scratching;
    const loopLen = this.loopEnd - this.loopStart;
    let g = this.gain;
    let sf = this.seekFade;
    // Key lock while moving forward under the deck's own power; never while scratching.
    const klTarget = this.klOn && !this.scratching && target > 0 && v0 >= 0 ? 1 : 0;
    const klStep = 1 / (KL_BLEND_S * scope.sampleRate);
    const H = this.klH;
    const win = this.klWin;
    // Grains read at original speed (original pitch) once the deck is up to speed; while the
    // playhead speeds up from a stop they accelerate with it, so they stay locked to it.
    const grainScale = target > 0 ? this.ratio / target : 0;

    for (let i = 0; i < N; i++) {
      if (!this.klActive && (klTarget > 0 || this.klAmt > 0)) {
        // (Re)anchor the grains at the playhead (key lock switched on, or after a seek/scratch),
        // the fading-out one at full weight.
        this.klOld = this.klNew = pos;
        this.klPhase = 0;
        this.klActive = true;
      }
      if (g < gainTarget) g = Math.min(gainTarget, g + gStep);
      else if (g > gainTarget) g = Math.max(gainTarget, g - gStep);
      if (sf < 1) sf = Math.min(1, sf + 1 / SEEK_FADE_SAMPLES);
      const amp = g * sf;
      if (amp > 0 && pos >= 0 && pos < this.len) {
        if (hasStems) {
          for (let k = 0; k < 4; k++) {
            if (sg[k] < st[k]) sg[k] = Math.min(st[k], sg[k] + gStepStem);
            else if (sg[k] > st[k]) sg[k] = Math.max(st[k], sg[k] - gStepStem);
          }
          const blendTarget = this.stemsEnabled && this.stemsReadyAt(pos) ? 1 : 0;
          if (this.stemAmt < blendTarget) this.stemAmt = Math.min(1, this.stemAmt + blendStep);
          else if (this.stemAmt > blendTarget) this.stemAmt = Math.max(0, this.stemAmt - blendStep);
        }
        const o = this.fr;
        // Inside an active loop: crossfade into the loop start near its end (seamless wrap).
        const wrap = inLoop && loopLen > 0 && pos >= this.loopStart - 2 && pos < this.loopEnd;
        if (this.klAmt < 1) this.renderLooped(pos, o, wrap, hasStems, fxActive, m0, m1);
        if (this.klAmt > 0) {
          const a = this.fg1;
          const b = this.fg2;
          this.renderLooped(this.klOld, a, wrap, hasStems, fxActive, m0, m1);
          this.renderLooped(this.klNew, b, wrap, hasStems, fxActive, m0, m1);
          const wo = win[this.klPhase + H];
          const wn = win[this.klPhase];
          const kl = this.klAmt;
          for (let k = 0; k < 6; k++) {
            const grain = a[k] * wo + b[k] * wn;
            o[k] = kl >= 1 ? grain : o[k] + kl * (grain - o[k]);
          }
        }
        outL[i] = o[0] * amp;
        outR[i] = o[1] * amp;
        if (fx0) {
          fx0[0][i] = o[2] * amp;
          if (fx0[1]) fx0[1][i] = o[3] * amp;
        }
        if (fx1) {
          fx1[0][i] = o[4] * amp;
          if (fx1[1]) fx1[1][i] = o[5] * amp;
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
      if (this.klAmt < klTarget) {
        this.klAmt = Math.min(1, this.klAmt + klStep);
      } else if (this.klAmt > klTarget) {
        this.klAmt = Math.max(0, this.klAmt - klStep);
        if (this.klAmt === 0) this.klActive = false;
      }
      if (g > 0 || this.scratching) {
        const prev = pos;
        pos += v0 + dv * (i + 1);
        // Forward playback crossing the loop end jumps back by exactly one loop length.
        if (inLoop && pos >= this.loopEnd && prev < this.loopEnd && prev >= this.loopStart - 2) pos -= loopLen;
        if (this.klActive) {
          const grainStep = grainScale > 0 ? (v0 + dv * (i + 1)) * grainScale : this.ratio;
          this.klOld += grainStep;
          this.klNew += grainStep;
          if (++this.klPhase >= H) {
            // The fading-in grain is at its peak: it becomes the old one, and a new grain
            // starts at the playhead, lined up with it.
            this.klPhase = 0;
            this.klOld = this.klNew;
            const wrapNow = inLoop && loopLen > 0 && pos >= this.loopStart - 2 && pos < this.loopEnd;
            this.klNew = this.klAlign(pos, this.klOld, wrapNow);
          }
        }
      }
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

/**
 * Live tuned monitoring AudioWorklet (Vocal Studio Phase 2).
 *
 *   input → YIN on a ~16 kHz copy every render quantum → nearest scale note (retune-speed smoothed)
 *         → real-time TD-PSOLA (grains two periods long, one target period apart) → output, delayed by DELAY frames.
 *
 * Latency added = DELAY / sampleRate (~21 ms at 48 kHz) and is reported to the UI. Only the monitor hears this:
 * the recording is captured dry before it. Rules: no allocation / imports / logging in process().
 */

interface TuneScope { sampleRate: number; registerProcessor(name: string, ctor: unknown): void; AudioWorkletProcessor: new (options?: unknown) => { readonly port: MessagePort } }
const tuneScope = globalThis as unknown as TuneScope;
type TuneMsg = { type: "config"; enabled: boolean; mask: boolean[]; retuneMs: number; strength: number };

const RING = 16384, MASK = RING - 1, DEC_RING = 4096, DEC_MASK = DEC_RING - 1;
const DELAY = 1024;      // output delay (frames): room for one grain of the lowest voice
const MAX_MARKS = 64;

class TuneProcessor extends tuneScope.AudioWorkletProcessor {
  private rate = tuneScope.sampleRate;
  private factor = Math.max(1, Math.floor(this.rate / 16000));
  private decRate = this.rate / this.factor;
  private W = Math.round(this.decRate * .024);
  private maxLag = Math.min(Math.floor(this.decRate / 75), this.W - 2);
  private minLag = Math.max(2, Math.floor(this.decRate / 1000));
  private input = new Float32Array(RING); private out = new Float32Array(RING); private wsum = new Float32Array(RING);
  private dec = new Float32Array(DEC_RING); private d = new Float32Array(this.maxLag + 2);
  private n = 0; private decN = 0; private decAcc = 0; private decCount = 0;
  private cents = 0;
  private marks = new Float64Array(MAX_MARKS); private markPeriods = new Float32Array(MAX_MARKS); private markCount = 0; private nextMark = 0;
  private ts = DELAY; private enabled = false; private mask = [true, true, true, true, true, true, true, true, true, true, true, true]; private retuneMs = 20; private strength = 1;

  constructor(options?: { processorOptions?: Omit<TuneMsg, "type"> }) {
    super(options);
    const apply = (m: Omit<TuneMsg, "type">) => { this.enabled = m.enabled; this.mask = m.mask.slice(); this.retuneMs = m.retuneMs; this.strength = m.strength; };
    if (options?.processorOptions) apply(options.processorOptions); // initial config, effective from the first block
    this.port.onmessage = (e: MessageEvent<TuneMsg>) => { if (e.data.type === "config") apply(e.data); };
    this.port.postMessage({ type: "latency", ms: DELAY / this.rate * 1000 });
  }

  /** YIN on the decimated ring; returns the period in input samples (0 = unvoiced). */
  private detect(): number {
    const W = this.W, maxLag = this.maxLag, dec = this.dec, d = this.d; const from = this.decN - W - maxLag; if (from < 0) return 0;
    let e = 0; for (let i = 0; i < W; i++) { const x = dec[(from + i) & DEC_MASK]; e += x * x; } if (e / W < 1e-6) return 0;
    let run = 0, best = -1, bestV = 1;
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0; for (let i = 0; i < W; i++) { const a = dec[(from + i) & DEC_MASK] - dec[(from + i + tau) & DEC_MASK]; s += a * a; }
      run += s; const cm = run > 0 ? s * tau / run : 1; d[tau] = cm;
      if (tau >= this.minLag && best < 0 && cm < .15) { best = tau; bestV = cm; }
      else if (best > 0 && tau === best + 1) { if (cm < bestV) { best = tau; bestV = cm; } else break; }
    }
    if (best < 0) return 0;
    const a = d[best - 1], b = d[best], c = d[best + 1] ?? b; const den = a - 2 * b + c; const shift = den ? (a - c) / (2 * den) : 0;
    return (best + (Math.abs(shift) < 1 ? shift : 0)) * this.factor;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inp = inputs[0]?.[0]; const outCh = outputs[0]; const frames = outCh[0]?.length ?? 128;
    // 1. write input (and the decimated copy)
    for (let i = 0; i < frames; i++) {
      const x = inp ? inp[i] : 0; this.input[(this.n + i) & MASK] = x;
      this.decAcc += x; if (++this.decCount === this.factor) { this.dec[this.decN++ & DEC_MASK] = this.decAcc / this.factor; this.decAcc = 0; this.decCount = 0; }
    }
    this.n += frames;
    const first = outCh[0]; if (!first) return true;
    if (!this.enabled) { for (let i = 0; i < frames; i++) first[i] = this.input[(this.n - frames - DELAY + i) & MASK]; for (let c = 1; c < outCh.length; c++) outCh[c].set(first); return true; }
    // 2. pitch + correction (smoothed by retune speed)
    const P = this.detect();
    let desired = 0;
    if (P > 0) { const midi = 69 + 12 * Math.log2(this.rate / P / 440); let best = Math.round(midi), dist = 99; for (let k = -6; k <= 6; k++) { const nn = Math.round(midi) + k; if (!this.mask[((nn % 12) + 12) % 12]) continue; const dd = Math.abs(nn - midi); if (dd < dist) { dist = dd; best = nn; } } desired = (best - midi) * 100 * this.strength; }
    const a = this.retuneMs <= 0 ? 1 : 1 - Math.exp(-frames / this.rate / (this.retuneMs / 1000)); this.cents += (desired - this.cents) * a;
    // 3. analysis marks, one period apart (fixed 5 ms steps when unvoiced), up to the newest usable input
    const step = P > 0 ? P : this.rate * .005; const newest = this.n - DELAY / 2;
    if (this.nextMark < this.n - RING / 2) this.nextMark = this.n - DELAY;
    while (this.nextMark + step < newest) { const slot = this.markCount++ % MAX_MARKS; this.marks[slot] = this.nextMark; this.markPeriods[slot] = P; this.nextMark += step; }
    // 4. synthesis grains up to the end of this block's output window
    const readEnd = this.n - DELAY; if (this.ts < readEnd - frames) this.ts = readEnd - frames;
    while (this.ts < readEnd + frames && this.markCount > 0) {
      let k = -1, bestDist = Infinity; const oldest = Math.max(0, this.markCount - MAX_MARKS);
      for (let m = oldest; m < this.markCount; m++) { const dist = Math.abs(this.marks[m % MAX_MARKS] - this.ts); if (dist < bestDist) { bestDist = dist; k = m % MAX_MARKS; } }
      if (k < 0) break;
      const mp = this.markPeriods[k]; const center = this.marks[k]; const ratio = mp > 0 ? 2 ** (this.cents / 1200) : 1; const half = mp > 0 ? Math.round(mp) : Math.round(this.rate * .005);
      const ts = Math.round(this.ts); const c = Math.round(center);
      for (let j = -half; j < half; j++) { const w = .5 + .5 * Math.cos(Math.PI * j / half); this.out[(ts + j) & MASK] += this.input[(c + j) & MASK] * w; this.wsum[(ts + j) & MASK] += w; }
      this.ts += mp > 0 ? Math.max(1, mp / ratio) : half;
    }
    // 5. emit the delayed, window-normalised output and clear it behind us
    const start = this.n - frames - DELAY;
    for (let i = 0; i < frames; i++) { const idx = (start + i) & MASK; const w = this.wsum[idx]; first[i] = w > .05 ? this.out[idx] / w : this.input[idx]; this.out[idx] = 0; this.wsum[idx] = 0; }
    for (let c = 1; c < outCh.length; c++) outCh[c].set(first);
    return true;
  }
}

tuneScope.registerProcessor("dbdj-tune", TuneProcessor);

/**
 * Drum Transcriber DSP primitives: analysis-rate conversion, a radix-2 FFT and a third-octave band spectrogram.
 * Pure functions over Float32Arrays so they run in the worker, on the UI thread and in tests.
 */

/** Analysis runs at roughly 22–24 kHz: enough for hi-hat energy up to ~11 kHz at half the cost of 44.1/48 kHz. */
export const MAX_ANALYSIS_RATE = 32000;

/** Halves the rate (31-tap windowed-sinc low-pass, then every second sample) until it is ≤ MAX_ANALYSIS_RATE. */
export function toAnalysisRate(data: Float32Array, rate: number): { data: Float32Array; rate: number } {
  let out = data, r = rate;
  while (r > MAX_ANALYSIS_RATE) { out = halfBand(out); r /= 2; }
  return { data: out, rate: r };
}

const TAPS = (() => {
  const n = 31, mid = (n - 1) / 2, fc = .225; const h = new Float32Array(n); let sum = 0;
  for (let i = 0; i < n; i++) { const k = i - mid; const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k); const w = .42 - .5 * Math.cos(2 * Math.PI * i / (n - 1)) + .08 * Math.cos(4 * Math.PI * i / (n - 1)); h[i] = sinc * w; sum += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= sum; return h;
})();
function halfBand(x: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(x.length / 2)); const half = (TAPS.length - 1) / 2;
  for (let o = 0; o < out.length; o++) { const c = o * 2; let s = 0; for (let t = 0; t < TAPS.length; t++) { const i = c + t - half; if (i >= 0 && i < x.length) s += x[i] * TAPS[t]; } out[o] = s; }
  return out;
}

/** In-place iterative radix-2 FFT (re/im length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Third-octave-style band edges (Hz). Bands above Nyquist are dropped. */
export const BAND_EDGES = [30, 60, 90, 120, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];

export interface BandSpectrogram {
  rate: number; size: number; hop: number;
  /** Number of frames and bands. */
  frames: number; bands: number;
  /** Band centre frequencies (Hz). */
  centres: number[];
  /** Mean magnitude per bin in each band, frame-major: data[frame * bands + band]. */
  data: Float32Array;
  /** Time (s) of the centre of frame `f`. */
  timeOf(f: number): number;
  /** Nearest frame whose centre is at or before `t`. */
  frameAt(t: number): number;
}

export interface SpectrogramOptions { size?: number; hop?: number; checkpoint?: (fraction: number) => Promise<void> | void }

/**
 * STFT (Hann window) summarised into log-spaced bands. Mean (not summed) magnitude per band so wide high bands are
 * comparable with narrow low ones. `checkpoint` is called every ~2000 frames (progress, cancellation, yielding).
 */
export async function bandSpectrogram(data: Float32Array, rate: number, options: SpectrogramOptions = {}): Promise<BandSpectrogram> {
  const size = options.size ?? 1024, hop = options.hop ?? 128; const half = size / 2;
  const edges = BAND_EDGES.filter((f) => f < rate / 2 - 1); const bins = edges.map((f) => Math.round(f / rate * size));
  const ranges: [number, number][] = []; const centres: number[] = [];
  for (let b = 0; b + 1 < edges.length; b++) { const lo = Math.max(1, bins[b]); const hi = Math.max(lo + 1, bins[b + 1]); ranges.push([lo, Math.min(half, hi)]); centres.push(Math.sqrt(edges[b] * edges[b + 1])); }
  const bands = ranges.length; const frames = Math.max(1, Math.ceil(data.length / hop)); const out = new Float32Array(frames * bands);
  const win = new Float64Array(size); for (let i = 0; i < size; i++) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / size);
  const re = new Float64Array(size), im = new Float64Array(size); const norm = 2 / size;
  // Frame f is centred on sample f*hop (zero-padded either side), so frame time = f*hop/rate.
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < size; i++) { const j = start + i; re[i] = j >= 0 && j < data.length ? data[j] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bands; b++) { const [lo, hi] = ranges[b]; let s = 0; for (let k = lo; k < hi; k++) s += Math.hypot(re[k], im[k]); out[f * bands + b] = s / (hi - lo) * norm; }
    if (options.checkpoint && f % 2000 === 1999) await options.checkpoint(f / frames);
  }
  return { rate, size, hop, frames, bands, centres, data: out, timeOf: (f) => f * hop / rate, frameAt: (t) => Math.max(0, Math.min(frames - 1, Math.floor(t * rate / hop))) };
}

/** Peak-amplitude envelope in blocks of `block` samples (≈1 ms), used for attack refinement and burst counting. */
export function blockEnvelope(data: Float32Array, block: number, diff = false): Float32Array {
  const n = Math.ceil(data.length / block); const out = new Float32Array(n);
  for (let b = 0; b < n; b++) { let m = 0; const end = Math.min(data.length, (b + 1) * block); for (let i = b * block; i < end; i++) { const v = Math.abs(diff ? data[i] - (i > 0 ? data[i - 1] : 0) : data[i]); if (v > m) m = v; } out[b] = m; }
  return out;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  if (!values.length) return 0; const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

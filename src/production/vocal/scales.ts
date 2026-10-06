/**
 * Keys and scales for pitch correction (Vocal Studio Phase 2): scale masks, nearest scale note,
 * Krumhansl–Kessler key detection from a pitch-class profile, chroma from notes or audio, key fit.
 */

export type ScaleName = "major" | "minor" | "harmonic-minor" | "chromatic" | "pentatonic" | "minor-pentatonic" | "blues" | "dorian" | "mixolydian" | "custom";
export const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const SCALE_INTERVALS: Record<Exclude<ScaleName, "custom">, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], "harmonic-minor": [0, 2, 3, 5, 7, 8, 11], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  pentatonic: [0, 2, 4, 7, 9], "minor-pentatonic": [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
export const SCALE_LABELS: Record<ScaleName, string> = { major: "Major", minor: "Minor", "harmonic-minor": "Harmonic Minor", chromatic: "Chromatic", pentatonic: "Pentatonic", "minor-pentatonic": "Minor Pentatonic", blues: "Blues", dorian: "Dorian", mixolydian: "Mixolydian", custom: "Custom" };

/** Allowed pitch classes (index 0 = C). `custom` is relative to the root (index 0 = root). */
export function scaleMask(root: number, scale: ScaleName, custom?: boolean[]): boolean[] {
  const mask = new Array<boolean>(12).fill(false); const r = ((root % 12) + 12) % 12;
  if (scale === "custom") { (custom ?? []).forEach((on, i) => { if (on) mask[(r + i) % 12] = true; }); if (!mask.some(Boolean)) mask.fill(true); return mask; }
  for (const i of SCALE_INTERVALS[scale]) mask[(r + i) % 12] = true; return mask;
}

/** Nearest allowed MIDI note to a (fractional) pitch; ties go to the note below. */
export function nearestInScale(midi: number, mask: boolean[]): number {
  const base = Math.round(midi); let best = base, dist = Infinity;
  for (let d = -6; d <= 6; d++) { const n = base + d; if (!mask[((n % 12) + 12) % 12]) continue; const dd = Math.abs(n - midi); if (dd < dist - 1e-9 || (Math.abs(dd - dist) < 1e-9 && n < best)) { dist = dd; best = n; } }
  return best;
}

// Krumhansl & Kessler (1982) probe-tone profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const pearson = (a: number[], b: number[]) => { const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length; let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? n / Math.sqrt(da * db) : 0; };

/** Key from a 12-bin pitch-class profile. Confidence = margin of the best correlation over the runner-up. */
export function detectKey(chroma: number[]): { root: number; scale: "major" | "minor"; correlation: number; confidence: number } | null {
  if (chroma.reduce((s, x) => s + x, 0) <= 0) return null;
  const ranked: { root: number; scale: "major" | "minor"; correlation: number }[] = [];
  for (let root = 0; root < 12; root++) for (const [scale, profile] of [["major", MAJOR_PROFILE], ["minor", MINOR_PROFILE]] as const) ranked.push({ root, scale, correlation: pearson(chroma, profile.map((_, i) => profile[(i - root + 12) % 12])) });
  ranked.sort((a, b) => b.correlation - a.correlation);
  return { ...ranked[0], confidence: Math.max(0, Math.min(1, (ranked[0].correlation - ranked[1].correlation) * 5 + ranked[0].correlation * .5)) };
}

/** Duration-weighted pitch-class profile of notes (MIDI pitch, seconds or beats). */
export function chromaFromNotes(notes: { pitch: number; duration: number }[]): number[] {
  const c = new Array<number>(12).fill(0); for (const n of notes) c[((Math.round(n.pitch) % 12) + 12) % 12] += Math.max(0, n.duration); return c;
}

/** Share of note time whose pitch class is in the scale (0–1). */
export function keyFit(notes: { pitch: number; duration: number }[], mask: boolean[]): number {
  let total = 0, fit = 0; for (const n of notes) { total += n.duration; if (mask[((Math.round(n.pitch) % 12) + 12) % 12]) fit += n.duration; } return total ? fit / total : 0;
}

/** In-place radix-2 complex FFT (re/im length = power of two). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}

/** Pitch-class profile of audio (backing tracks): 8192-point spectra every ~0.25 s, 55 Hz–2 kHz, up to `maxSeconds`. */
export function chromaFromAudio(data: Float32Array, rate: number, maxSeconds = 90): number[] {
  const N = 8192, hop = Math.round(rate * .25), end = Math.min(data.length - N, Math.round(maxSeconds * rate)); const c = new Array<number>(12).fill(0);
  const re = new Float32Array(N), im = new Float32Array(N); const win = Float32Array.from({ length: N }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const lo = Math.ceil(55 * N / rate), hi = Math.floor(2000 * N / rate);
  for (let at = 0; at < end; at += hop) {
    for (let i = 0; i < N; i++) { re[i] = data[at + i] * win[i]; im[i] = 0; } fft(re, im);
    for (let k = lo; k <= hi; k++) { const mag = Math.hypot(re[k], im[k]); const midi = 69 + 12 * Math.log2(k * rate / N / 440); c[((Math.round(midi) % 12) + 12) % 12] += mag; }
  }
  return c;
}

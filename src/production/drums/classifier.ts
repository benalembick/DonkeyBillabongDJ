/**
 * Drum classification — the pluggable interface plus the Phase 1 baseline.
 *
 * Baseline ("template-nmf"): semi-adaptive NMF (Dittmar & Gärtner 2014 style). Three spectral templates — kick,
 * snare, hi-hat — over the third-octave band spectrogram; activations are solved with KL-divergence multiplicative
 * updates while the templates are allowed to drift (late in the iterations, at most halfway) towards this
 * recording's actual sounds. Each component's activation is examined independently at every onset, so one onset can
 * yield several simultaneous hits (kick + hat, kick + snare + crash…).
 *
 * Per onset and component: `rise` = activation jump across the onset; `share` = that component's part of the
 * explained energy in its home frequency region. A component is present when both pass thresholds. Sub-labels come
 * from simple, documented measurements and get lower confidence: open vs closed hat (activation decay time), crash
 * (very long hat-like decay), clap vs snare (multiple noise bursts in the first 40 ms and little low body).
 *
 * What it does NOT do (Phase 2/3): toms, ride, other percussion, ghost notes, flams, full-mix robustness. Anything it
 * is not sure about is returned on the Unknown lane with its ranked guesses, never silently invented or dropped.
 */
import { blockEnvelope, percentile, type BandSpectrogram } from "./dsp";
import type { Onset } from "./onsets";
import type { DrumCandidate, DrumLane } from "./types";

export interface ClassifierInput {
  spec: BandSpectrogram;
  /** Analysis-rate mono signal (same rate as spec). */
  mono: Float32Array;
  onsets: Onset[];
  /** Labels below this confidence are returned on the Unknown lane. */
  minConfidence: number;
  /** 0–1 detection sensitivity (also scales how quiet a component may be and still count). */
  sensitivity: number;
  checkpoint?: (fraction: number) => Promise<void> | void;
}

export interface ClassifiedHit {
  onsetIndex: number;
  time: number;
  lane: DrumLane;
  confidence: number;
  /** 0–1, normalised per instrument (for velocity). */
  strength: number;
  candidates: DrumCandidate[];
  review: string | null;
}

/** A replaceable classifier: Phase 2 models (ONNX drum transcription) implement this same contract. */
export interface DrumClassifier {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  classify(input: ClassifierInput): Promise<ClassifiedHit[]>;
}

type Component = "kick" | "snare" | "hat";
/** How far templates may drift towards this recording (at the last iteration). */
const ADAPT = .15;
const COMPONENTS: Component[] = ["kick", "snare", "hat"];
const lg = (x: number) => Math.log2(x);
const gauss = (f: number, centre: number, width: number) => Math.exp(-(lg(f / centre) ** 2) / (2 * width * width));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Prior spectral templates (mean magnitude per bin, per band centre), unit-sum columns. */
export function priorTemplates(centres: number[]): Float32Array[] {
  // Kick: fundamental + pitch sweep 40–180 Hz, faint beater click. Snare: a short body near 200 Hz but mostly broadband
  // noise 1–8 kHz. Hi-hat: noise above ~5.5 kHz. Keeping most of the snare's mass in its noise stops it explaining kicks.
  const kick = centres.map((f) => gauss(f, 70, .8) + .008 * sigmoid(lg(f / 1500) * 4) * sigmoid(lg(7000 / f) * 4));
  const snare = centres.map((f) => .35 * gauss(f, 210, .3) + .32 * sigmoid(lg(f / 800) * 5) * sigmoid(lg(8000 / f) * 4));
  const hat = centres.map((f) => .002 + sigmoid(lg(f / 5800) * 5));
  return [kick, snare, hat].map((t) => { const s = t.reduce((a, b) => a + b, 0); return Float32Array.from(t, (x) => x / s); });
}

/** Home region of each component (band index predicate) used for the share measure. */
function homeBands(centres: number[]): Record<Component, number[]> {
  const idx = (p: (f: number) => boolean) => centres.map((f, i) => (p(f) ? i : -1)).filter((i) => i >= 0);
  return { kick: idx((f) => f < 140), snare: idx((f) => f >= 160 && f < 4500), hat: idx((f) => f >= 6000) };
}

export interface NmfResult { W: Float32Array[]; H: Float32Array[] }

/** Semi-adaptive KL-NMF: V (frames×bands) ≈ H·Wᵀ with W blended towards the prior. */
export async function semiAdaptiveNmf(spec: BandSpectrogram, prior: Float32Array[], iterations = 30, maxAdapt = .5, checkpoint?: (f: number) => Promise<void> | void): Promise<NmfResult> {
  const { frames, bands } = spec; const K = prior.length; let max = 1e-12; for (const v of spec.data) if (v > max) max = v;
  const V = Float32Array.from(spec.data, (v) => v / max); const W = prior.map((w) => Float32Array.from(w));
  const H = Array.from({ length: K }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) { let e = 0; for (let b = 0; b < bands; b++) e += V[f * bands + b]; for (let k = 0; k < K; k++) H[k][f] = e / K + 1e-9; }
  const R = new Float32Array(frames * bands); const eps = 1e-12;
  for (let it = 0; it < iterations; it++) {
    const ratio = () => { for (let f = 0; f < frames; f++) for (let b = 0; b < bands; b++) { let wh = 0; for (let k = 0; k < K; k++) wh += W[k][b] * H[k][f]; R[f * bands + b] = V[f * bands + b] / (wh + eps); } };
    ratio();
    for (let k = 0; k < K; k++) { const w = W[k]; let ws = 0; for (let b = 0; b < bands; b++) ws += w[b]; for (let f = 0; f < frames; f++) { let s = 0; for (let b = 0; b < bands; b++) s += w[b] * R[f * bands + b]; H[k][f] *= s / (ws + eps); } }
    const alpha = maxAdapt * ((it + 1) / iterations) ** 4;
    if (alpha > .001) {
      ratio();
      for (let k = 0; k < K; k++) {
        let hs = 0; for (let f = 0; f < frames; f++) hs += H[k][f]; if (hs <= eps) continue;
        const upd = new Float32Array(bands); let us = 0;
        for (let b = 0; b < bands; b++) { let s = 0; for (let f = 0; f < frames; f++) s += H[k][f] * R[f * bands + b]; upd[b] = W[k][b] * s / hs; us += upd[b]; }
        let ws = 0; for (let b = 0; b < bands; b++) { W[k][b] = (1 - alpha) * prior[k][b] + alpha * upd[b] / (us + eps); ws += W[k][b]; }
        for (let b = 0; b < bands; b++) W[k][b] /= ws;
      }
    }
    if (checkpoint && it % 5 === 4) await checkpoint((it + 1) / iterations);
  }
  return { W, H };
}

interface OnsetMeasure { rise: number[]; share: number[]; peakFrame: number[]; profile: RiseProfile }

/** Counts distinct noise bursts in the first 40 ms (claps are several 5–15 ms bursts; snares one attack). */
export function countBursts(mono: Float32Array, rate: number, time: number): number {
  const block = Math.max(1, Math.round(rate * .002)); const from = Math.max(0, Math.round((time - .002) * rate)), to = Math.min(mono.length, Math.round((time + .045) * rate));
  if (to - from < block * 4) return 1;
  const env = blockEnvelope(mono.subarray(from, to), block, true); const max = Math.max(...env); if (max <= 0) return 0;
  const sm = env.map((v, i) => (v + (env[i - 1] ?? v) + (env[i + 1] ?? v)) / 3);
  let bursts = 0, lastPeak = -1, trough = Infinity;
  for (let i = 0; i < sm.length; i++) {
    const isPeak = sm[i] >= .3 * max && sm[i] >= (sm[i - 1] ?? 0) && sm[i] >= (sm[i + 1] ?? 0);
    if (lastPeak >= 0) trough = Math.min(trough, sm[i]);
    if (!isPeak) continue;
    if (lastPeak < 0) { bursts = 1; lastPeak = i; trough = Infinity; continue; }
    if (i - lastPeak >= 2 && trough <= .55 * Math.min(sm[i], sm[lastPeak])) { bursts++; lastPeak = i; trough = Infinity; }
    else if (sm[i] > sm[lastPeak]) lastPeak = i;
  }
  return bursts;
}

/** Power-rise profile of an onset in the observed spectrum: fractions per region and the log-frequency centroid. */
export interface RiseProfile { low: number; body: number; noise: number; air: number; centroid: number; total: number }
export function riseProfile(spec: BandSpectrogram, t: number): RiseProfile {
  const pre = spec.frameAt(t - .03), a = spec.frameAt(t), b = spec.frameAt(t + .035); const width = spec.centres.map((c) => c * .26);
  const rise = new Float64Array(spec.bands);
  for (let f = a; f <= b; f++) for (let k = 0; k < spec.bands; k++) { const post = spec.data[f * spec.bands + k] ** 2, before = t >= .03 ? spec.data[pre * spec.bands + k] ** 2 : 0; rise[k] = Math.max(rise[k], (post - before) * width[k]); }
  let total = 0, low = 0, body = 0, noise = 0, air = 0, lc = 0;
  spec.centres.forEach((c, k) => { const r = rise[k]; total += r; lc += r * Math.log2(c); if (c < 120) low += r; else if (c < 330) body += r; else if (c >= 800 && c < 5000) noise += r; if (c >= 5500) air += r; });
  const n = total || 1; return { low: low / n, body: body / n, noise: noise / n, air: air / n, centroid: total ? 2 ** (lc / total) : 0, total };
}

export class TemplateNmfClassifier implements DrumClassifier {
  readonly id = "template-nmf";
  readonly version = 1;
  readonly description = "Semi-adaptive NMF with kick/snare/hi-hat spectral templates + decay and burst heuristics";

  async classify(input: ClassifierInput): Promise<ClassifiedHit[]> {
    const { spec, mono, onsets } = input; if (!onsets.length) return [];
    const { W, H } = await semiAdaptiveNmf(spec, priorTemplates(spec.centres), 30, ADAPT, input.checkpoint);
    const home = homeBands(spec.centres); const fps = spec.rate / spec.hop;
    const regionWeight = COMPONENTS.map((_, region) => COMPONENTS.map((__, k) => home[COMPONENTS[region]].reduce((s, b) => s + W[k][b], 0)));
    const measures: OnsetMeasure[] = onsets.map((o) => {
      const preF = spec.frameAt(o.time - .03), postA = spec.frameAt(o.time), postB = spec.frameAt(o.time + .035);
      const rise: number[] = [], peakFrame: number[] = [];
      for (let k = 0; k < 3; k++) { let m = 0, at = postA; for (let f = postA; f <= postB; f++) if (H[k][f] > m) { m = H[k][f]; at = f; } rise.push(Math.max(0, m - (o.time >= .03 ? H[k][preF] : 0))); peakFrame.push(at); }
      const share = COMPONENTS.map((_, r) => { const total = rise.reduce((s, x, k) => s + x * regionWeight[r][k], 0); return total > 0 ? rise[r] * regionWeight[r][r] / total : 0; });
      return { rise, share, peakFrame, profile: riseProfile(spec, o.time) };
    });
    // Per-component loudness reference (for thresholds and velocity): typical rise where that component is evident.
    const evident = (m: OnsetMeasure, k: number) => (k === 0 ? m.profile.low >= .2 : k === 1 ? m.profile.noise >= .1 && !hatLike(m.profile) : hatLike(m.profile) || m.share[2] >= .5);
    const ref = COMPONENTS.map((_, k) => { const dom = measures.filter((m) => evident(m, k)).map((m) => m.rise[k]); return Math.max(1e-9, dom.length ? percentile(dom, .9) : Math.max(...measures.map((m) => m.rise[k]))); });
    const sens = Math.max(0, Math.min(1, input.sensitivity)); const rel = .2 - .16 * sens;
    const presence = measures.map((m) => presenceOf(m, ref, rel));
    const out: ClassifiedHit[] = []; const lastOf: Partial<Record<Component, { time: number; rise: number }>> = {};
    for (let i = 0; i < onsets.length; i++) {
      if (input.checkpoint && i % 200 === 199) await input.checkpoint(i / onsets.length);
      const o = onsets[i], m = measures[i]; const found: ClassifiedHit[] = [];
      for (let k = 0; k < 3; k++) {
        const evidence = presence[i][k]; if (evidence <= 0) continue; const comp = COMPONENTS[k];
        // Same instrument < 45 ms after itself: the second "hit" is its own tail seen from a nearby onset.
        const last = lastOf[comp]; if (last && o.time - last.time < .045 && m.rise[k] <= last.rise) continue;
        const level = m.rise[k] / ref[k]; const levelTerm = Math.min(1, level / (rel * 4));
        const confidence = Math.min(1, (.5 + .5 * evidence) * (.7 + .3 * levelTerm)); const strength = Math.max(0, Math.min(1, 1 + 20 * Math.log10(Math.max(1e-6, level)) / 36));
        const base = { onsetIndex: i, time: o.time, strength };
        if (comp === "kick") found.push({ ...base, lane: "kick", confidence, candidates: [{ lane: "kick", score: confidence }], review: null });
        else if (comp === "snare") found.push(this.snareOrClap(base, confidence, m.profile, countBursts(mono, spec.rate, o.time), presence[i][0] > 0));
        else {
          const next = onsets.findIndex((x, j) => j > i && presence[j][2] > 0 && x.time - o.time >= .045);
          found.push(this.hatKind(base, confidence, H[2], m.peakFrame[2], fps, next >= 0 ? spec.frameAt(onsets[next].time - .02) : spec.frames - 1));
        }
        lastOf[comp] = { time: o.time, rise: m.rise[k] };
      }
      if (found.length > 1) for (const h of found) { const k = h.lane === "kick" ? 0 : h.lane === "snare" || h.lane === "clap" ? 1 : 2; if (presence[i][k] < .35) h.review = h.review ?? "Possible overlapping hit — check"; }
      const kept: ClassifiedHit[] = found.map((h) => h.confidence >= input.minConfidence ? h : { ...h, lane: "unknown" as DrumLane, candidates: h.candidates.length ? h.candidates : [{ lane: h.lane, score: h.confidence }], review: `Low confidence: ${h.lane} ${Math.round(h.confidence * 100)}%` });
      if (!kept.length) {
        // An onset no component explains: keep it on the Unknown lane with ranked guesses.
        const p = m.profile; const ranked: DrumCandidate[] = [{ lane: "kick" as DrumLane, score: p.low }, { lane: "snare" as DrumLane, score: p.noise + p.body * .3 }, { lane: "closed-hat" as DrumLane, score: p.air }].sort((a, b) => b.score - a.score);
        kept.push({ onsetIndex: i, time: o.time, lane: "unknown", confidence: Math.min(.4, ranked[0].score * .4), strength: Math.max(0, Math.min(1, o.strength)), candidates: ranked, review: "No instrument matched confidently" });
      }
      out.push(...kept);
    }
    return out;
  }

  /** Clap vs snare: claps have little 150–330 Hz body and several noise bursts; under a kick the body can't be judged. */
  private snareOrClap(base: Pick<ClassifiedHit, "onsetIndex" | "time" | "strength">, confidence: number, p: RiseProfile, bursts: number, withKick: boolean): ClassifiedHit {
    const clapScore = withKick ? (bursts >= 3 ? .45 : 0) : (p.body < .07 ? .6 : p.body < .12 ? .3 : 0) + (bursts >= 3 ? .35 : bursts === 2 ? .2 : 0);
    if (clapScore >= .6) return { ...base, lane: "clap", confidence: Math.min(confidence, .55 + .3 * Math.min(1, (clapScore - .6) / .35)), candidates: [{ lane: "clap", score: Math.min(1, clapScore) }, { lane: "snare", score: Math.max(0, 1 - clapScore) }], review: clapScore < .75 ? "Clap or snare?" : null };
    const unsure = clapScore >= .35;
    return { ...base, lane: "snare", confidence: confidence * (unsure ? .8 : 1), candidates: [{ lane: "snare", score: 1 - clapScore }, { lane: "clap", score: clapScore }], review: unsure ? "Snare or clap?" : null };
  }

  /** Closed vs open hat vs crash from how long the hat activation takes to fall to 25 % (stopping at the next hat). */
  private hatKind(base: Pick<ClassifiedHit, "onsetIndex" | "time" | "strength">, confidence: number, h: Float32Array, peakF: number, fps: number, stop: number): ClassifiedHit {
    const peak = h[peakF]; let f = peakF; while (f < stop && h[f] > .25 * peak) f++; const decay = (f - peakF) / fps; const truncated = f >= stop && h[f] > .25 * peak;
    if (decay > .7) return { ...base, lane: "crash", confidence: Math.min(confidence, .5), candidates: [{ lane: "crash", score: .55 }, { lane: "open-hat", score: .45 }], review: "Long cymbal: crash or open hi-hat?" };
    const openness = Math.max(0, Math.min(1, (decay - .09) / .11)); const open = openness >= .5;
    const certainty = truncated && !open ? .6 : .55 + .45 * Math.abs(openness - .5) * 2;
    return { ...base, lane: open ? "open-hat" : "closed-hat", confidence: confidence * (.6 + .4 * certainty), candidates: [{ lane: open ? "open-hat" : "closed-hat", score: certainty }, { lane: open ? "closed-hat" : "open-hat", score: 1 - certainty }], review: certainty < .7 ? "Open or closed hi-hat?" : null };
  }
}

/** Mostly "air" (> 5.5 kHz), no low body, little 1–5 kHz noise relative to the air: a hat/cymbal on its own. */
export const hatLike = (p: RiseProfile): boolean => p.air >= .5 && p.body < .05 && p.low < .02 && p.noise < .45 * p.air;

/**
 * Evidence (0 = absent, else 0–1) that each component sounds at an onset. Activation rise must reach `rel` of the
 * component's track reference, AND the observed spectrum must show it in absolute terms — a kick needs real power
 * below 120 Hz, a snare/clap real 1–5 kHz noise (and not the profile of a lone hat), a hat real air that a snare
 * doesn't already explain. These absolute gates are what stop NMF cross-talk from inventing notes.
 */
function presenceOf(m: OnsetMeasure, ref: number[], rel: number): [number, number, number] {
  const p = m.profile; const loud = (k: number) => m.rise[k] >= rel * ref[k];
  const kick = loud(0) && p.low >= .08 && m.share[0] >= .3 ? Math.min(1, p.low / .25) : 0;
  const hatAlone = hatLike(p);
  const snare = loud(1) && p.noise >= .012 && !hatAlone ? Math.min(1, .35 + p.noise / .15) : 0;
  const hat = loud(2) && p.air >= .006 && (hatAlone || m.share[2] >= (snare > 0 ? .45 : .3)) ? (hatAlone ? 1 : Math.min(1, m.share[2] + .2)) : 0;
  return [kick, snare, hat];
}

export const BASELINE_CLASSIFIER: DrumClassifier = new TemplateNmfClassifier();

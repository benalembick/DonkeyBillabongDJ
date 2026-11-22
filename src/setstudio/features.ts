/**
 * Set-intelligence feature derivation (pure, deterministic, versioned).
 *
 * Runs on the *cached* worker analysis (3-band 150 fps peak envelopes, overview, sections, beat
 * confidence) — it never decodes audio. Unknown inputs produce null + an `unsupported` reason;
 * nothing is invented. Extra extractors (e.g. a future ML mood/genre classifier) plug in through
 * `registerExtractor`; absent ones are reported, not simulated.
 */
import { camelotKey } from "../analysis/discovery";
import type { TrackAnalysis } from "../analysis/analyzeTrack";
import type { SetIntel } from "./types";

export const SET_FEATURES_ALGORITHM = "dbdj-set-features";
/** v2 (2026-11-21): recalibrated on a real 292-track library — v1 saturated density/percussion on real masters. */
export const SET_FEATURES_VERSION = 2;

/**
 * Energy model: weights of each normalised term (sum 1), the raw ranges each term is normalised over
 * (absolute, not library-relative — measured on real commercial masters so typical tracks land
 * mid-scale rather than at the ceiling), and the output scale. Configurable.
 *
 *  - fullness: share of the track that is "busy" plus how filled the gaps between hits are — gated by
 *    rhythm, so a loud sustained pad without a beat doesn't count as high energy;
 *  - bass: low-band share gated by low-band movement (a bassline/kick, not a drone).
 */
export const ENERGY_MODEL = {
  weights: { loudness: 0.14, density: 0.12, percussive: 0.16, fullness: 0.26, bass: 0.1, brightness: 0.1, tempo: 0.12 },
  ranges: {
    loudnessDb: [-18, -2], onsetsPerSec: [4.5, 9], flux: [0.05, 0.14], busy: [0.35, 0.9], floor: [0.03, 0.43],
    bassShare: [0.2, 0.55], highShare: [0.1, 0.3], bpm: [80, 160],
  } as Record<string, [number, number]>,
  /** Below this mean level the cached analysis is treated as silent/corrupt rather than scored. */
  silentDb: -35,
  /** Stretch around the mid-point so typical tracks use more of the 1–10 scale (fixed, not library-fitted). */
  contrast: 1.6,
  scale: { min: 1, max: 10 },
};
const norm = (x: number, [lo, hi]: [number, number]) => clamp01((x - lo) / (hi - lo));

export type FeatureInput = Pick<TrackAnalysis, "low" | "mid" | "high" | "peaks" | "fps" | "bpm" | "confidence" | "sections" | "key">;
export interface FeatureMeta { duration: number; genreTag?: string | null; key?: string | null; bpm?: number | null; vocalPresence?: number | null }

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
function mean(a: ArrayLike<number>): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }

/** Onsets/second and mean log-domain positive flux (loudness-independent percussiveness). */
export function onsetFeatures(env: Float32Array, fps: number): { density: number; flux: number } {
  const n = env.length;
  if (n < 3) return { density: 0, flux: 0 };
  const d = new Float32Array(n);
  let prev = Math.log1p(env[0] * 100), fluxSum = 0;
  for (let i = 1; i < n; i++) { const v = Math.log1p(env[i] * 100); const x = v - prev; d[i] = x > 0 ? x : 0; fluxSum += d[i]; prev = v; }
  // Adaptive threshold: local mean over ~0.3 s plus a floor; peaks must be local maxima within ±30 ms.
  const w = Math.max(3, Math.round(fps * 0.3)), half = Math.max(1, Math.round(fps * 0.03));
  let acc = 0, onsets = 0, lastOnset = -Infinity;
  const minGap = Math.round(fps * 0.06);
  for (let i = 0; i < n; i++) {
    acc += d[i]; if (i >= w) acc -= d[i - w];
    const local = acc / Math.min(i + 1, w);
    if (d[i] < 0.25 || d[i] < local * 1.8 + 0.05) continue;
    let isMax = true;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (d[k] > d[i]) { isMax = false; break; }
    if (isMax && i - lastOnset >= minGap) { onsets++; lastOnset = i; }
  }
  return { density: onsets / (n / fps), flux: fluxSum / n };
}

export interface CoreFeatures {
  loudnessDb: number | null; loudness: number; density: number; onsetDensity: number; percussive: number;
  bassIntensity: number; brightness: number; tempo: number | null; sustain: number; variation: number;
  energy: number; energyConfidence: number; danceability: number;
}

/** The measurable part, separated so it can be unit-tested on synthetic envelopes. */
export function coreFeatures(a: Pick<FeatureInput, "low" | "mid" | "high" | "peaks" | "fps" | "confidence">, bpm: number | null, duration: number): CoreFeatures | null {
  const n = Math.min(a.low.length, a.mid.length, a.high.length);
  if (n < a.fps * 8) return null;
  const total = new Float32Array(n);
  let sl = 0, sm = 0, sh = 0;
  for (let i = 0; i < n; i++) { total[i] = a.low[i] + a.mid[i] + a.high[i]; sl += a.low[i]; sm += a.mid[i]; sh += a.high[i]; }
  const sum = sl + sm + sh;
  if (sum <= 1e-6) return null;
  const R = ENERGY_MODEL.ranges;
  const level = mean(a.peaks.length ? a.peaks : total);
  const loudnessDb = level > 0 ? 20 * Math.log10(level) : null;
  if (loudnessDb === null || loudnessDb < ENERGY_MODEL.silentDb) return null; // silent or corrupt cache: don't score it
  const loudness = norm(loudnessDb, R.loudnessDb);
  // Onsets from mid+high (hats, snares, claps) and kick/bass movement from the low band.
  const mh = new Float32Array(n); for (let i = 0; i < n; i++) mh[i] = a.mid[i] + a.high[i];
  const o = onsetFeatures(mh, a.fps), lo = onsetFeatures(a.low, a.fps);
  const onsetDensity = o.density;
  const density = norm(onsetDensity, R.onsetsPerSec);
  const percussive = norm((o.flux + lo.flux) / 2, R.flux);
  const rhythm = Math.max(density, percussive);
  const bassShare = norm(sl / sum, R.bassShare);
  const bassIntensity = bassShare * (0.4 + 0.6 * norm(lo.flux, R.flux));
  const brightness = norm(sh / sum, R.highShare);
  const tempo = bpm && bpm > 0 ? norm(bpm, R.bpm) : null;
  const sorted = Array.from(total).sort((x, y) => x - y);
  const p90 = sorted[Math.floor(n * 0.9)] || 1, p10 = sorted[Math.floor(n * 0.1)];
  let busy = 0; for (let i = 0; i < n; i++) if (total[i] > p90 * 0.45) busy++;
  const sustain = (norm(busy / n, R.busy) + norm(p10 / p90, R.floor)) / 2;
  const fullness = sustain * (0.35 + 0.65 * rhythm);
  // Bar-scale variation (used by mood rules): std of 2-second means relative to their mean.
  const win = Math.max(1, Math.round(a.fps * 2)), blocks: number[] = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let k = i; k < i + win; k++) s += total[k]; blocks.push(s / win); }
  const bm = mean(blocks), variation = bm > 0 ? Math.sqrt(mean(blocks.map((b) => (b - bm) ** 2))) / bm : 0;

  const w = ENERGY_MODEL.weights;
  const terms: [number, number | null][] = [[w.loudness, loudness], [w.density, density], [w.percussive, percussive], [w.fullness, fullness], [w.bass, bassIntensity], [w.brightness, brightness], [w.tempo, tempo]];
  let acc = 0, wsum = 0;
  for (const [weight, v] of terms) if (v !== null) { acc += weight * v; wsum += weight; }
  const raw = clamp01(0.5 + ((wsum ? acc / wsum : 0) - 0.5) * ENERGY_MODEL.contrast);
  const { min, max } = ENERGY_MODEL.scale;
  const energy = round(min + (max - min) * clamp01(raw), 1);
  const beat = clamp01(((a.confidence || 1) - 1) / 3);
  const energyConfidence = round(clamp01(0.35 + 0.35 * Math.min(1, duration / 120) + 0.2 * (tempo === null ? 0 : 1) + 0.1 * beat));
  const danceRange = bpm ? clamp01(1 - Math.max(0, Math.abs(bpm - 122) - 14) / 30) : null;
  const danceTerms: [number, number | null][] = [[0.4, beat], [0.25, danceRange], [0.35, percussive]];
  let da = 0, dw = 0; for (const [weight, v] of danceTerms) if (v !== null) { da += weight * v; dw += weight; }
  return { loudnessDb: loudnessDb === null ? null : round(loudnessDb, 1), loudness, density, onsetDensity: round(onsetDensity), percussive: round(percussive), bassIntensity: round(bassIntensity), brightness: round(brightness), tempo, sustain: round(sustain), variation: round(variation), energy, energyConfidence, danceability: round(dw ? da / dw : 0) };
}

/** Deterministic mood descriptors from measured features. Each rule is explicit and documented. */
export function moodRules(f: Pick<CoreFeatures, "energy" | "brightness" | "bassIntensity" | "percussive" | "density" | "variation" | "danceability">, key: string | null): string[] {
  const cam = camelotKey(key), minor = cam ? cam.endsWith("A") : null, major = cam ? cam.endsWith("B") : null;
  const out: string[] = [];
  if (f.brightness < 0.35 && (minor === true || f.bassIntensity > 0.6)) out.push("dark");
  if (f.brightness > 0.8) out.push("bright");
  if (major === true && f.brightness >= 0.4 && f.energy >= 6) out.push("uplifting");
  if (minor === true && f.energy < 5.5) out.push("melancholic");
  if (f.percussive > 0.6 && f.density > 0.5) out.push("driving");
  if (f.variation < 0.18 && f.percussive > 0.4) out.push("hypnotic");
  if (f.energy < 4) out.push("chill");
  if (f.energy >= 8 && major === true) out.push("euphoric");
  if (f.danceability > 0.65 && f.bassIntensity > 0.45) out.push("groovy");
  if (f.energy >= 8 && f.brightness > 0.55 && f.percussive > 0.7) out.push("aggressive");
  return out;
}

/** "House / Deep House" → genre House, sub-genre Deep House. Tags are the only genre source in Phase 1. */
export function splitGenre(tag?: string | null): { genre: string | null; subgenre: string | null } {
  const parts = (tag ?? "").split(/\s*[/;,|]\s*/).map((s) => s.trim()).filter(Boolean);
  return { genre: parts[0] ?? null, subgenre: parts[1] ?? null };
}

/** Pluggable extractors (e.g. a future versioned ML classifier). Results are merged over the baseline. */
export interface IntelExtractor { id: string; version: number; fields: (keyof SetIntel)[]; run(input: FeatureInput, meta: FeatureMeta): Partial<SetIntel> }
const extractors: IntelExtractor[] = [];
export function registerExtractor(e: IntelExtractor): () => void { extractors.push(e); return () => { const i = extractors.indexOf(e); if (i >= 0) extractors.splice(i, 1); }; }

export function computeSetFeatures(a: FeatureInput, meta: FeatureMeta, derivedFrom: number | null, now = Date.now()): SetIntel {
  const bpm = meta.bpm ?? a.bpm ?? null, key = meta.key ?? a.key ?? null;
  const core = coreFeatures(a, bpm, meta.duration);
  const unsupported: Record<string, string> = {};
  const { genre, subgenre } = splitGenre(meta.genreTag);
  if (!genre) unsupported.genre = "No genre tag; no genre classifier is installed";
  if (!subgenre) unsupported.subgenre = "No sub-genre in the genre tag; no classifier is installed";
  if (meta.vocalPresence === undefined || meta.vocalPresence === null) unsupported.vocalPresence = "Needs STEMS separation of this track";
  if (!core) {
    for (const f of ["energy", "danceability", "brightness", "bassIntensity", "percussive", "onsetDensity", "moods"]) unsupported[f] = "Track too short, silent, or its cached analysis looks corrupt — reanalyse it";
  }
  if (!bpm) unsupported.tempo = "Tempo unknown";
  const sec = (k: string) => a.sections.find((s) => s.kind === k) ?? null;
  const intro = sec("intro"), outro = [...a.sections].reverse().find((s) => s.kind === "outro") ?? null;
  const drop = sec("drop"), breakdown = sec("breakdown");
  if (!drop) unsupported.dropSec = "No clear drop detected";
  if (!breakdown) unsupported.breakdownSec = "No clear breakdown detected";
  const coverage = core ? 1 - Object.keys(unsupported).filter((k) => !["genre", "subgenre", "vocalPresence", "dropSec", "breakdownSec"].includes(k)).length / 8 : 0;
  let intel: SetIntel = {
    algorithm: SET_FEATURES_ALGORITHM, version: SET_FEATURES_VERSION, derivedFrom, computedAt: now,
    energy: core?.energy ?? null, energyConfidence: core?.energyConfidence ?? 0,
    danceability: core?.danceability ?? null, brightness: core?.brightness ?? null, bassIntensity: core?.bassIntensity ?? null,
    percussive: core?.percussive ?? null, onsetDensity: core?.onsetDensity ?? null, loudnessDb: core?.loudnessDb ?? null,
    vocalPresence: meta.vocalPresence ?? null, vocalSource: meta.vocalPresence === undefined || meta.vocalPresence === null ? null : "stems",
    introSec: intro ? round(intro.end - intro.start, 1) : null,
    outroSec: outro ? round(outro.end - outro.start, 1) : null,
    dropSec: drop ? round(drop.start, 1) : null,
    breakdownSec: breakdown ? round(breakdown.start, 1) : null,
    moods: core ? moodRules(core, key) : [], moodSource: "rules-v1",
    genre, subgenre,
    confidence: round(core ? clamp01(core.energyConfidence * 0.7 + coverage * 0.3) : 0),
    unsupported,
  };
  for (const e of extractors) {
    try { const patch = e.run(a, meta); intel = { ...intel, ...patch, unsupported: { ...intel.unsupported } }; for (const f of e.fields) delete intel.unsupported[f as string]; }
    catch (err) { intel.unsupported[`extractor:${e.id}`] = String(err); }
  }
  return intel;
}

/** True when `intel` is missing or was derived from an older analysis / algorithm version. */
export function intelStale(intel: SetIntel | undefined, analysedAt: number | null): boolean {
  return !intel || intel.version !== SET_FEATURES_VERSION || intel.algorithm !== SET_FEATURES_ALGORITHM || intel.derivedFrom !== analysedAt;
}

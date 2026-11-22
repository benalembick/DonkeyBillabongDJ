/**
 * Explainable compatibility scoring for set building (pure, deterministic).
 *
 * Five weighted parts (harmonic, BPM, energy, genre & mood, structure & duration). A part whose
 * inputs are unknown is dropped and its weight redistributed; confidence falls accordingly. BPM is
 * never the only criterion. Half/double-time relations are accepted with a small penalty.
 */
import { camelotKey } from "../analysis/discovery";
import { DEFAULT_WEIGHTS, type HardConstraints, type NextMove, type ScoreWeights, type SetTrack, type TransitionState } from "./types";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── Harmonic ────────────────────────────────────────────────────────────────
export interface KeyRelation { score: number; label: string; clash: boolean }
export function harmonic(a?: string | null, b?: string | null): KeyRelation | null {
  const x = camelotKey(a), y = camelotKey(b);
  if (!x || !y) return null;
  const n = parseInt(x), m = parseInt(y), lx = x.slice(-1), ly = y.slice(-1);
  const step = ((m - n) % 12 + 12) % 12; // clockwise steps on the wheel
  if (x === y) return { score: 1, label: "Same key", clash: false };
  if (n === m) return { score: 0.9, label: "Relative major/minor", clash: false };
  if (lx === ly && (step === 1 || step === 11)) return { score: 0.9, label: step === 1 ? "Adjacent key (+1)" : "Adjacent key (−1)", clash: false };
  if (lx === ly && step === 2) return { score: 0.62, label: "Energy boost (+2)", clash: false };
  if (lx === ly && step === 7) return { score: 0.55, label: "Semitone lift (+7)", clash: false };
  if (lx !== ly && (step === 1 || step === 11)) return { score: 0.6, label: "Diagonal mix", clash: false };
  return { score: 0.15, label: `${x} → ${y} key clash`, clash: true };
}

// ── Tempo ───────────────────────────────────────────────────────────────────
export interface BpmRelation { score: number; pct: number; delta: number; ratio: 1 | 2 | 0.5; label: string }
/** Tempo compatibility; `pct` is the gap after the best half/double interpretation. */
export function bpmRelation(a: number | null, b: number | null, allowHalfDouble = true): BpmRelation | null {
  if (!a || !b || a <= 0 || b <= 0) return null;
  const options: (1 | 2 | 0.5)[] = allowHalfDouble ? [1, 2, 0.5] : [1];
  let best: BpmRelation | null = null;
  for (const r of options) {
    const pct = (Math.abs(b * r - a) / a) * 100;
    // ≤2 % is free; 0 at 12 %. Half/double costs 12 %.
    const score = clamp01(1 - Math.max(0, pct - 2) / 10) * (r === 1 ? 1 : 0.88);
    if (!best || score > best.score) best = { score, pct, delta: b - a, ratio: r, label: "" };
  }
  const d = Math.round(best!.delta * 10) / 10;
  best!.label = best!.ratio !== 1 ? `${best!.ratio === 2 ? "Half" : "Double"}-time (${a.toFixed(0)} ↔ ${b.toFixed(0)})` : `${d > 0 ? "+" : ""}${d} BPM`;
  return best;
}

// ── Steering ────────────────────────────────────────────────────────────────
/** Energy target for a slot given the previous track, the curve target and the Next Move. */
export function moveTarget(prevEnergy: number | null, curveTarget: number | null, move: NextMove): number | null {
  const base = prevEnergy ?? curveTarget;
  if (base === null) return null;
  switch (move) {
    case "lift": return Math.min(10, (prevEnergy ?? base) + 1.5);
    case "cool": return Math.max(1, (prevEnergy ?? base) - 1.5);
    case "tension": return Math.min(10, (prevEnergy ?? base) + 0.8);
    case "keep": return prevEnergy ?? base;
    case "peak": return Math.max(8.5, curveTarget ?? base);
    default: return curveTarget ?? base;
  }
}

/** Stable per-(ref, seed) pseudo-random in [0, 1) — "Surprise Me" is reproducible. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// ── Candidate scoring ───────────────────────────────────────────────────────
export interface ScoreContext {
  prev?: SetTrack | null;
  next?: SetTrack | null;
  /** Curve target at this slot. */
  targetEnergy?: number | null;
  move?: NextMove;
  weights?: ScoreWeights;
  hard?: HardConstraints;
  moodPreferences?: string[];
  genrePreferences?: string[];
  /** Expected played length for this slot (s). */
  slotSeconds?: number | null;
  /** Tracks already in the set (excluded unless duplicates allowed). */
  exclude?: Set<string>;
  allowDuplicates?: boolean;
  /** Recently played or rejected tracks (soft penalty). */
  recent?: Set<string>;
  seed?: string;
  allowHalfDouble?: boolean;
  /** Lowest and highest energy available in the library (to explain unreachable targets). */
  energySpan?: [number, number] | null;
}
export interface PartScores { harmonic: number | null; bpm: number | null; energy: number | null; genreMood: number | null; structure: number | null }
export interface CandidateScore { track: SetTrack; score: number; confidence: number; parts: PartScores; reasons: string[]; explanation: string; target: number | null }
export interface Excluded { track: SetTrack; excluded: string }

function neighbourAvg<T>(ns: (SetTrack | null | undefined)[], f: (n: SetTrack) => T | null, pick: (v: T) => number): { avg: number | null; vals: T[] } {
  const vals = ns.filter((n): n is SetTrack => !!n).map(f).filter((v): v is T => v !== null);
  return { avg: vals.length ? vals.reduce((s, v) => s + pick(v), 0) / vals.length : null, vals };
}

function genreFamily(g: string | null): string { return (g ?? "").toLowerCase().replace(/[^a-z]/g, ""); }
export function genreSimilarity(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = genreFamily(a), y = genreFamily(b);
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const wa = new Set(a.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2)), wb = b.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  return wb.some((w) => wa.has(w)) ? 0.65 : 0.3;
}

/** Checks hard constraints; returns the reason a track is excluded, or null. */
export function violates(t: SetTrack, ctx: ScoreContext): string | null {
  const h = ctx.hard ?? {};
  if (!t.available) return "Unavailable (file missing)";
  if (!ctx.allowDuplicates && (ctx.exclude?.has(t.ref) || (t.trackId && ctx.exclude?.has(t.trackId)))) return "Already in this set";
  if (h.bpmMin != null && (!t.bpm || t.bpm < h.bpmMin)) return `BPM below ${h.bpmMin}`;
  if (h.bpmMax != null && (!t.bpm || t.bpm > h.bpmMax)) return `BPM above ${h.bpmMax}`;
  if (h.energyMin != null && (t.energy === null || t.energy < h.energyMin)) return `Energy below ${h.energyMin}`;
  if (h.energyMax != null && (t.energy === null || t.energy > h.energyMax)) return `Energy above ${h.energyMax}`;
  if (h.keys?.length && (!t.camelot || !h.keys.includes(t.camelot))) return "Key not in the allowed keys";
  if (h.maxBpmJumpPct != null && ctx.prev) {
    const r = bpmRelation(ctx.prev.bpm, t.bpm, ctx.allowHalfDouble ?? true);
    if (!r || r.pct > h.maxBpmJumpPct) return `Tempo jump over ${h.maxBpmJumpPct}%`;
  }
  if (h.harmonicOnly && ctx.prev) {
    const k = harmonic(ctx.prev.camelot ?? ctx.prev.key, t.camelot ?? t.key);
    if (!k || k.score < 0.85) return "Not harmonically compatible";
  }
  return null;
}

export function scoreCandidate(t: SetTrack, ctx: ScoreContext): CandidateScore | Excluded {
  const why = violates(t, ctx);
  if (why) return { track: t, excluded: why };
  const move = ctx.move ?? "keep", w = ctx.weights ?? DEFAULT_WEIGHTS, reasons: string[] = [];
  const ns = [ctx.prev, ctx.next];

  // Harmonic
  const k = neighbourAvg(ns, (n) => harmonic(n.camelot ?? n.key, t.camelot ?? t.key), (v) => v.score);
  if (k.vals.length) reasons.push(k.vals.some((v) => v.clash) ? "potential key clash" : k.avg! >= 0.85 ? "compatible key" : "workable key change");

  // BPM
  const b = neighbourAvg(ns, (n) => bpmRelation(n.bpm, t.bpm, ctx.allowHalfDouble ?? true), (v) => v.score);
  if (b.vals.length) { const worst = Math.max(...b.vals.map((v) => v.pct)); reasons.push(b.vals.some((v) => v.ratio !== 1) ? "half/double-time tempo" : worst <= 2 ? "close tempo" : worst <= 6 ? "small tempo change" : "large tempo change"); }

  // Energy (curve target steered by Next Move)
  const target = moveTarget(ctx.prev?.energy ?? null, ctx.targetEnergy ?? null, move);
  let energy: number | null = null;
  if (t.energy !== null && target !== null) {
    energy = clamp01(1 - Math.abs(t.energy - target) / 4);
    const prevE = ctx.prev?.energy;
    if (prevE != null) {
      const delta = t.energy - prevE;
      if (move === "lift" && delta <= 0) energy *= 0.55;
      if (move === "cool" && delta >= 0) energy *= 0.55;
      if ((move === "lift" || move === "tension") && delta > 3) energy *= 0.7; // controlled, not a jump
      reasons.push(Math.abs(t.energy - target) <= 0.8 ? (delta > 0.4 ? "ideal energy increase" : delta < -0.4 ? "ideal energy decrease" : "ideal energy") : delta > 0 ? `energy +${delta.toFixed(1)}` : `energy ${delta.toFixed(1)}`);
    } else reasons.push(Math.abs(t.energy - target) <= 0.8 ? "on the energy curve" : `energy ${t.energy.toFixed(1)} vs target ${target.toFixed(1)}`);
    if (move === "peak") energy = energy * 0.75 + 0.25 * (t.danceability ?? 0.5);
    const span = ctx.energySpan;
    if (span && target < span[0] - 0.4) reasons.push(`nothing in your library is below energy ${span[0].toFixed(1)}`);
    if (span && target > span[1] + 0.4) reasons.push(`nothing in your library is above energy ${span[1].toFixed(1)}`);
  }

  // Genre & mood (+ timbral steering)
  const gm: number[] = [];
  const g = neighbourAvg(ns, (n) => genreSimilarity(n.subgenre ?? n.genre, t.subgenre ?? t.genre), (v) => v);
  if (g.avg !== null) { gm.push(move === "surprise" ? 1 - g.avg * 0.5 : g.avg); if (g.avg >= 0.8 && move !== "surprise") reasons.push("same genre"); }
  if (ctx.genrePreferences?.length && t.genre) gm.push(ctx.genrePreferences.some((p) => genreSimilarity(p, t.subgenre ?? t.genre)! >= 0.65) ? 1 : 0.3);
  const prefMoods = ctx.moodPreferences ?? [];
  if (prefMoods.length && t.moods.length) { const hit = prefMoods.filter((m) => t.moods.includes(m)).length; gm.push(hit ? 0.6 + 0.4 * hit / prefMoods.length : 0.25); if (hit) reasons.push(`${prefMoods.filter((m) => t.moods.includes(m)).join(", ")} mood`); }
  const neighMoods = ns.filter(Boolean).flatMap((n) => n!.moods);
  if (neighMoods.length && t.moods.length) { const set = new Set(neighMoods), hit = t.moods.filter((m) => set.has(m)).length; gm.push(hit / Math.max(t.moods.length, set.size) * 0.7 + 0.3); }
  const darkMode = camelotKey(t.key)?.endsWith("A");
  if (move === "darker" || move === "tension") {
    if (t.brightness !== null) { gm.push(1 - t.brightness); if (t.brightness < 0.4) reasons.push("darker timbre"); }
    if (t.moods.includes("dark")) gm.push(1);
    if (darkMode !== undefined) gm.push(darkMode ? 0.85 : 0.4);
  }
  if (move === "brighter") {
    if (t.brightness !== null) { gm.push(t.brightness); if (t.brightness > 0.55) reasons.push("brighter timbre"); }
    if (t.moods.some((m) => m === "bright" || m === "uplifting" || m === "euphoric")) gm.push(1);
    if (darkMode !== undefined) gm.push(darkMode ? 0.4 : 0.85);
  }
  if (move === "more-vocals" || move === "less-vocals" || move === "tension") {
    if (t.vocalPresence !== null) { const v = move === "more-vocals" ? t.vocalPresence : 1 - t.vocalPresence; gm.push(v); reasons.push(move === "more-vocals" ? (t.vocalPresence > 0.35 ? "strong vocals" : "few vocals") : t.vocalPresence < 0.2 ? "mostly instrumental" : "has vocals"); }
    else if (move !== "tension") reasons.push("vocal content unknown (no STEMS)");
  }
  const genreMood = gm.length ? gm.reduce((a, x) => a + x, 0) / gm.length : null;

  // Structure & duration
  const st: number[] = [];
  if (t.durationSec && ctx.slotSeconds) st.push(clamp01(1 - (Math.abs(t.durationSec - ctx.slotSeconds) / ctx.slotSeconds) * 0.8));
  else if (t.durationSec) st.push(t.durationSec >= 150 && t.durationSec <= 600 ? 1 : 0.5);
  if (ctx.prev && t.introSec !== null) st.push(clamp01(t.introSec / 20));
  if (ctx.next && t.outroSec !== null) st.push(clamp01(t.outroSec / 20));
  const structure = st.length ? st.reduce((a, x) => a + x, 0) / st.length : null;

  const parts: PartScores = { harmonic: k.avg, bpm: b.avg, energy, genreMood, structure };
  let acc = 0, avail = 0;
  const total = w.harmonic + w.bpm + w.energy + w.genreMood + w.structure;
  (Object.keys(parts) as (keyof PartScores)[]).forEach((p) => { const v = parts[p]; if (v !== null) { acc += v * w[p]; avail += w[p]; } });
  let score = avail ? acc / avail : 0;
  let confidence = total ? avail / total : 0;
  if (!t.analysed) { confidence *= 0.7; reasons.push("not analysed yet"); }
  if (ctx.recent?.has(t.ref)) { score *= 0.9; reasons.push("recently used"); }
  if (move === "surprise") score = score * 0.85 + 0.15 * hash01(`${t.ref}|${ctx.seed ?? ""}`);
  // Few known features: pull the score toward neutral rather than trusting it fully.
  score = score * (0.6 + 0.4 * confidence) + 0.5 * (0.4 - 0.4 * confidence);
  const pct = Math.round(clamp01(score) * 100);
  return { track: t, score: pct, confidence: Math.round(confidence * 100) / 100, parts, reasons, explanation: explain(pct, reasons), target };
}

function explain(pct: number, reasons: string[]): string {
  const all = [...new Set(reasons)];
  // A library-range note always survives the cut: it explains why a score can't go higher.
  const note = all.find((x) => x.startsWith("nothing in your library"));
  const r = note ? [...all.filter((x) => x !== note).slice(0, 2), note] : all.slice(0, 3);
  if (!r.length) return `${pct}% match — little analysis available`;
  const list = r.length > 1 ? `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}` : r[0];
  return `${pct}% match — ${list}.`;
}

export const isExcluded = (x: CandidateScore | Excluded): x is Excluded => "excluded" in x;

/** Ranks a pool; excluded tracks are returned separately so the UI can explain filters. */
export function rankCandidates(pool: SetTrack[], ctx: ScoreContext, limit = 50): { ranked: CandidateScore[]; excluded: number } {
  const ranked: CandidateScore[] = [];
  let excluded = 0;
  for (const t of pool) { const s = scoreCandidate(t, ctx); if (isExcluded(s)) excluded++; else ranked.push(s); }
  ranked.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.track.ref.localeCompare(b.track.ref));
  // The same audio saved under several paths is one suggestion, not several.
  const seen = new Set<string>(), unique = ranked.filter((r) => { const k = r.track.trackId ?? r.track.ref; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ranked: unique.slice(0, limit), excluded };
}

// ── Transitions ─────────────────────────────────────────────────────────────
export interface TransitionEval { score: number | null; /** Share of the score's weight backed by known data (0..1). */ confidence: number; state: TransitionState; bpmDelta: number | null; bpmPct: number | null; keyRelation: string; energyDelta: number | null; warnings: string[]; primary: string }

export function evaluateTransition(a: SetTrack, b: SetTrack): TransitionEval {
  const k = harmonic(a.camelot ?? a.key, b.camelot ?? b.key), t = bpmRelation(a.bpm, b.bpm);
  const ed = a.energy !== null && b.energy !== null ? Math.round((b.energy - a.energy) * 10) / 10 : null;
  const parts: [number, number | null][] = [[35, k?.score ?? null], [40, t?.score ?? null], [25, ed === null ? null : clamp01(1 - Math.max(0, Math.abs(ed) - 1) / 4)]];
  let acc = 0, wsum = 0; for (const [w, v] of parts) if (v !== null) { acc += w * v; wsum += w; }
  // Missing parts lower confidence and pull the score toward neutral, so "100%" always means fully known.
  const confidence = wsum / 100;
  const score = wsum ? Math.round(((acc / wsum) * (0.6 + 0.4 * confidence) + 0.5 * 0.4 * (1 - confidence)) * 100) : null;
  const warnings: string[] = [];
  const rawDelta = a.bpm && b.bpm ? Math.round((b.bpm - a.bpm) * 10) / 10 : null;
  if (t && t.ratio === 1 && t.pct > 8) warnings.push(`${rawDelta! > 0 ? "+" : ""}${Math.round(rawDelta!)} BPM — large tempo jump`);
  else if (t && t.ratio === 1 && t.pct > 3) warnings.push(`${rawDelta! > 0 ? "+" : ""}${rawDelta} BPM — needs a tempo ride or a cut`);
  else if (t && t.ratio !== 1) warnings.push(`${t.label} — use a half/double-time blend`);
  if (k?.clash) warnings.push("Potential harmonic clash");
  if (ed !== null && ed <= -3) warnings.push(`Energy falls ${Math.abs(ed).toFixed(1)} points`);
  if (ed !== null && ed >= 3.5) warnings.push(`Energy jumps ${ed.toFixed(1)} points`);
  const unanalysed = !a.analysed || !b.analysed;
  if (!t) warnings.push(unanalysed ? "Tempo unknown — analyse both tracks" : "Tempo not detected for one track");
  if (!k) warnings.push(unanalysed ? "Key unknown — analyse both tracks" : "Key not detected for one track — check by ear");
  let state: TransitionState = "green";
  if (score === null || (t && t.ratio === 1 && t.pct > 8) || (k?.clash && t && t.pct > 4) || (score !== null && score < 45)) state = score === null ? "amber" : "red";
  else if (warnings.length || score < 70) state = "amber";
  return { score, confidence: Math.round(confidence * 100) / 100, state, bpmDelta: rawDelta, bpmPct: t ? Math.round(t.pct * 10) / 10 : null, keyRelation: k?.label ?? "Key unknown", energyDelta: ed, warnings, primary: warnings[0] ?? (state === "green" ? "Smooth blend" : "Review") };
}

/**
 * 0..1 pair compatibility used by the optimiser (no steering). Unlike the displayed score, an unknown
 * key/tempo/energy counts as a 50/50 risk rather than being left out — otherwise the optimiser would
 * prefer tracks whose key wasn't detected over tracks with a known, slightly imperfect key relation.
 */
export function pairCompat(a: SetTrack, b: SetTrack): number {
  const k = harmonic(a.camelot ?? a.key, b.camelot ?? b.key), t = bpmRelation(a.bpm, b.bpm);
  const ed = a.energy !== null && b.energy !== null ? b.energy - a.energy : null;
  const base = 0.35 * (k?.score ?? 0.5) + 0.4 * (t?.score ?? 0.5) + 0.25 * (ed === null ? 0.5 : clamp01(1 - Math.max(0, Math.abs(ed) - 1) / 4));
  const g = genreSimilarity(a.subgenre ?? a.genre, b.subgenre ?? b.genre);
  return g === null ? base : base * 0.85 + g * 0.15;
}

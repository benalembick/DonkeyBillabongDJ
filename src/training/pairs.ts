/**
 * Track choice for lessons: per-track readiness and suggested pairs that suit a lesson's
 * requirements (beat grids, tempo gap within reach, keys), each with the reasons why.
 */
import type { TrackInfo } from "../core/engine/types";
import { GRID_CONFIDENT, keyRelation } from "../transitions/planner";
import type { Lesson } from "./curriculum";

export interface Candidate {
  track: TrackInfo;
  analysed: boolean;
  bpm: number | null;
  gridConfidence: number | null;
  gridManual: boolean;
  key: string | null;
  keyConfidence: number;
  duration: number;
  energy: number | null;
}

export interface PairSuggestion {
  a: TrackInfo;
  b: TrackInfo;
  score: number;
  reasons: string[];
}

/** Problems that stop (✕) or weaken (⚠) a track for a lesson. */
export function readiness(c: Candidate, lesson: Lesson, side: "a" | "b"): { level: "ok" | "warn" | "bad"; text: string }[] {
  const out: { level: "ok" | "warn" | "bad"; text: string }[] = [];
  if (c.track.unavailableReason) return [{ level: "bad", text: `Audio unavailable: ${c.track.unavailableReason}` }];
  if (!c.analysed) return [{ level: "bad", text: "Not analysed yet" }];
  const needGrid = lesson.requirements.grids === "both" || side === "a";
  if (needGrid && c.bpm === null) out.push({ level: "bad", text: "No beat grid — this lesson needs one" });
  else if (c.bpm !== null && !c.gridManual && (c.gridConfidence ?? 0) < GRID_CONFIDENT) out.push({ level: "warn", text: `Beat grid uncertain (confidence ${(c.gridConfidence ?? 0).toFixed(1)}) — check it before relying on scores` });
  else if (c.bpm !== null) out.push({ level: "ok", text: `Beat grid ${c.bpm.toFixed(2)} BPM${c.gridManual ? " (set by hand)" : ""}` });
  if (lesson.requirements.keys) {
    if (!c.key) out.push({ level: "bad", text: "Key unknown — this lesson needs keys" });
    else if (c.keyConfidence < 0.35) out.push({ level: "warn", text: `Key ${c.key} (uncertain — low detection confidence)` });
    else out.push({ level: "ok", text: `Key ${c.key}` });
  }
  if (c.duration > 0 && c.duration < 120) out.push({ level: "warn", text: "Shorter than 2 minutes — little room to practise" });
  return out;
}

const usable = (c: Candidate, lesson: Lesson, side: "a" | "b") => readiness(c, lesson, side).every((r) => r.level !== "bad");
const gapPct = (x: number, y: number) => (Math.abs(x - y) / Math.min(x, y)) * 100;

export function suggestPairs(lesson: Lesson, all: Candidate[], max = 5): PairSuggestion[] {
  const pool = all.filter((c) => c.track.source === "local" && c.analysed && !c.track.unavailableReason).slice(0, 400);
  const out: PairSuggestion[] = [];
  for (const a of pool) {
    if (!usable(a, lesson, "a")) continue;
    for (const b of pool) {
      if (a === b || !usable(b, lesson, "b")) continue;
      const reasons: string[] = [];
      let score = 0;
      if (a.bpm !== null && b.bpm !== null) {
        const gap = gapPct(a.bpm, b.bpm);
        if (lesson.requirements.maxBpmGapPct !== null && gap > lesson.requirements.maxBpmGapPct) continue;
        score += 40 - gap * 4;
        reasons.push(`${a.bpm.toFixed(1)} → ${b.bpm.toFixed(1)} BPM (${gap.toFixed(1)}% apart${lesson.requirements.maxBpmGapPct !== null ? ", within Track B's tempo range" : ""})`);
      }
      const gq = Math.min(a.gridManual ? 3 : a.gridConfidence ?? 0, lesson.requirements.grids === "both" ? (b.gridManual ? 3 : b.gridConfidence ?? 0) : 3);
      score += Math.min(30, gq * 10);
      if (gq >= GRID_CONFIDENT) reasons.push("Confident beat grids");
      const rel = keyRelation(a.key, b.key);
      if (lesson.requirements.keys) {
        if (!rel) continue;
        score += rel.compatible ? 25 : 5;
        reasons.push(`Keys ${rel.label}${rel.compatible ? " — compatible" : ""}`);
      } else if (rel?.compatible) {
        score += 8;
        reasons.push(`Compatible keys (${rel.label})`);
      }
      if (lesson.id === "quickcut" && a.energy !== null && b.energy !== null && Math.abs(a.energy - b.energy) >= 2) {
        score += 6;
        reasons.push(`Energy ${a.energy} → ${b.energy}: a cut marks the change`);
      }
      out.push({ a: a.track, b: b.track, score, reasons });
    }
  }
  // Best first, without repeating the same Track A.
  const seen = new Set<string>();
  return out.sort((x, y) => y.score - x.score).filter((p) => (seen.has(p.a.ref) ? false : (seen.add(p.a.ref), true))).slice(0, max);
}

/** Harmonic lesson: up to 4 candidates for Track B — compatible and clashing ones mixed, in a stable order. */
export function harmonicChoices(lesson: Lesson, a: Candidate, all: Candidate[]): { c: Candidate; compatible: boolean }[] {
  const near = all.filter((c) => c !== a && c.analysed && c.key && c.bpm !== null && a.bpm !== null && gapPct(a.bpm, c.bpm) <= (lesson.requirements.maxBpmGapPct ?? 100));
  const tagged = near.map((c) => ({ c, compatible: !!keyRelation(a.key, c.key)?.compatible }));
  const good = tagged.filter((x) => x.compatible).slice(0, 2);
  const bad = tagged.filter((x) => !x.compatible).slice(0, 4 - good.length);
  const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);
  return [...good, ...bad].sort((x, y) => hash(x.c.track.ref) - hash(y.c.track.ref));
}

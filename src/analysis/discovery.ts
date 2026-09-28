import type { TrackInfo } from "../core/engine/types";
import type { TrackPreparation } from "../preparation/types";

const KEYS: Record<string, string> = {
  "g#m":"1A","abm":"1A","d#m":"2A","ebm":"2A","a#m":"3A","bbm":"3A","fm":"4A","cm":"5A","gm":"6A","dm":"7A","am":"8A","em":"9A","bm":"10A","f#m":"11A","gbm":"11A","c#m":"12A","dbm":"12A",
  "b":"1B","f#":"2B","gb":"2B","c#":"3B","db":"3B","g#":"4B","ab":"4B","d#":"5B","eb":"5B","a#":"6B","bb":"6B","f":"7B","c":"8B","g":"9B","d":"10B","a":"11B","e":"12B",
};
export function camelotKey(key?: string | null): string | null {
  const k = key?.trim().toLowerCase().replace(/♯/g,"#").replace(/♭/g,"b").replace(/\s*minor$/,"m").replace(/\s*major$/,"").replace(/\s/g,"");
  return k ? (/^(?:[1-9]|1[0-2])[ab]$/.test(k) ? k.toUpperCase() : KEYS[k] ?? null) : null;
}
function keyScore(a?: string | null, b?: string | null): { score: number; reason: string } {
  const x = camelotKey(a), y = camelotKey(b);
  if (!x || !y) return { score: 0.5, reason: "Key unknown" };
  const n = parseInt(x), m = parseInt(y), sameLetter = x.endsWith(y.slice(-1));
  if (x === y) return { score: 1, reason: `${x} → ${y}` };
  if (n === m) return { score: 0.92, reason: `${x} → ${y} relative major/minor` };
  if (sameLetter && (Math.abs(n - m) === 1 || Math.abs(n - m) === 11)) return { score: 0.9, reason: `${x} → ${y} adjacent Camelot` };
  return { score: 0.2, reason: `${x} → ${y} key clash risk` };
}
export interface Compatibility { score: number; confidence: number; reasons: string[]; mixOut?: number; mixIn?: number; bars?: number }
export function compatibility(a: TrackInfo, b: TrackInfo, pa?: TrackPreparation, pb?: TrackPreparation): Compatibility {
  const reasons: string[] = [], key = keyScore(pa?.key ?? a.key, pb?.key ?? b.key);
  let sum = key.score * 30, weight = 30, known = key.reason !== "Key unknown" ? 1 : 0.4; reasons.push(key.reason);
  const bpmA = pa?.bpm ?? a.bpm, bpmB = pb?.bpm ?? b.bpm;
  if (bpmA && bpmB) { const gap = Math.abs(bpmA - bpmB) / Math.max(bpmA, bpmB); const s = Math.max(0, 1 - gap / 0.12); sum += s * 25; weight += 25; known += 1; reasons.push(`${bpmA.toFixed(1)} → ${bpmB.toFixed(1)} BPM`); }
  const ea = pa?.energy, eb = pb?.energy;
  if (ea && eb) { const s = Math.max(0, 1 - Math.abs(ea - eb) / 5); sum += s * 20; weight += 20; known += 1; reasons.push(`Energy ${ea} → ${eb}`); }
  const ga = a.genre?.toLowerCase(), gb = b.genre?.toLowerCase();
  if (ga && gb) { const s = ga === gb || ga.includes(gb) || gb.includes(ga) ? 1 : 0.45; sum += s * 10; weight += 10; known += 1; reasons.push(s === 1 ? "Compatible genre" : `${a.genre} → ${b.genre}`); }
  const out = pa?.recommendedCues.find((c) => c.kind === "mix-out"), into = pb?.recommendedCues.find((c) => c.kind === "mix-in");
  if (out && into) { sum += Math.min(out.confidence, into.confidence) * 15; weight += 15; known += 1; reasons.push("Mix points available"); }
  return { score: Math.round(sum / weight * 100), confidence: Math.min(1, known / 5), reasons, mixOut: out?.timestamp, mixIn: into?.timestamp, bars: bpmA && bpmB ? 16 : undefined };
}

export interface Recommendation { track: TrackInfo; match: Compatibility }
export type EnergyFlow = "steady" | "warm-build-peak-wind-down";
export function recommendSequence(start: TrackInfo, candidates: TrackInfo[], prep: (t: TrackInfo) => TrackPreparation | undefined, flow: EnergyFlow = "steady"): Recommendation[] {
  const left = candidates.filter((t) => t.ref !== start.ref), result: Recommendation[] = [];
  let current = start;
  while (left.length) {
    const position = result.length / Math.max(1, candidates.length - 1);
    const target = flow === "warm-build-peak-wind-down" ? position < .65 ? 4 + position / .65 * 6 : 10 - (position - .65) / .35 * 5 : prep(current)?.energy ?? 6;
    let best = 0, bestScore = -Infinity, bestMatch!: Compatibility;
    left.forEach((t, i) => { const m = compatibility(current, t, prep(current), prep(t)); const energy = prep(t)?.energy; const flowBonus = energy ? Math.max(0, 12 - Math.abs(energy - target) * 4) : 0; const score = m.score + flowBonus; if (score > bestScore) { best = i; bestScore = score; bestMatch = { ...m, score: Math.min(100, Math.round(score)) }; } });
    const [track] = left.splice(best, 1); result.push({ track, match: bestMatch }); current = track;
  }
  return result;
}

export interface MashupSuggestion extends Recommendation { combinations: string[] }
export function mashupMatches(start: TrackInfo, candidates: TrackInfo[], prep: (t: TrackInfo) => TrackPreparation | undefined, stems: (ref: string) => boolean): MashupSuggestion[] {
  return candidates.filter((t) => t.ref !== start.ref).map((track) => {
    const match = compatibility(start, track, prep(start), prep(track));
    const combinations = stems(start.ref) && stems(track.ref)
      ? ["Vocals from reference + instrumental from match", "Reference vocal + match drums/bass", "Compatible instrumental layers"]
      : ["Full-track layering; analyse STEMS for vocal/instrumental suggestions"];
    return { track, match: { ...match, score: Math.round(match.score * (stems(start.ref) && stems(track.ref) ? 1 : .9)) }, combinations };
  }).sort((a, b) => b.match.score - a.match.score);
}

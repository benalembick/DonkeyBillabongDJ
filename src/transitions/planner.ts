/**
 * Transition Intelligence: turns two tracks' analysis into an exact, bar-accurate mix plan.
 *
 * Everything is computed from the tracks' beat grids (bar = 4 beats from the grid's first
 * beat, phrase = 8 bars from a per-track phrase offset) and the chosen playback tempo:
 *   - where the outgoing track (A) should start the transition, as a timestamp and bar.beat;
 *   - where the incoming track (B) should be cued and started;
 *   - the transition length in bars and wall-clock seconds at the target BPM;
 *   - the tempo change each deck needs;
 *   - numbered, technique-specific steps with their bar and timestamp;
 *   - warnings (vocal overlap, key clash, uncertain grids, approximate phrases).
 * Missing data is reported, never invented: no grid → no plan; unknown vocals → said so.
 */
import type { AnalysisSection, RecommendedCue } from "../analysis/analyzeTrack";
import { camelotKey } from "../analysis/discovery";

export const BEATS_PER_BAR = 4;
export const PHRASE_BARS = 8;
/** Beat-grid confidence below this (and not set by hand) is "uncertain" (same bar as Auto DJ). */
export const GRID_CONFIDENT = 1.4;

export interface Grid {
  bpm: number;
  firstBeat: number;
  confidence: number;
  manual: boolean;
}

/** What the planner knows about one track. Every field comes from real analysis or is null. */
export interface TrackFacts {
  trackId: string;
  ref: string;
  title: string;
  artist: string;
  duration: number;
  grid: Grid | null;
  key: string | null;
  keyConfidence: number;
  energy: number | null;
  sections: AnalysisSection[];
  cues: RecommendedCue[];
  /** Loudness per bar from the grid's first beat (0..1), from the waveform analysis. */
  barEnergy: number[] | null;
  /** Vocal regions [start, end] in track seconds; null = unknown (no STEMS vocal data). */
  vocals: [number, number][] | null;
  /** STEMS for this track are cached (stem techniques possible). */
  stemsCached: boolean;
  analysed: boolean;
}

export type TechniqueId = "blend" | "bass-swap" | "quick-cut" | "echo-out" | "vocal-swap" | "stem-swap";
export type Difficulty = "Easy" | "Intermediate" | "Advanced";

export interface TechniqueInfo {
  id: TechniqueId;
  name: string;
  difficulty: Difficulty;
  /** Transition lengths offered (bars). Quick cut: bars of filter build before the cut; echo-out: bars of echo tail. */
  lengths: number[];
  defaultBars: number;
  needsBeatmatch: boolean;
  needsVocals: boolean;
  needsStems: boolean;
}

export const TECHNIQUES: TechniqueInfo[] = [
  { id: "blend", name: "Phrase-aligned blend", difficulty: "Intermediate", lengths: [8, 16, 32], defaultBars: 16, needsBeatmatch: true, needsVocals: false, needsStems: false },
  { id: "bass-swap", name: "Bass swap", difficulty: "Intermediate", lengths: [8, 16, 32], defaultBars: 16, needsBeatmatch: true, needsVocals: false, needsStems: false },
  { id: "quick-cut", name: "Quick cut", difficulty: "Easy", lengths: [1, 2, 4], defaultBars: 2, needsBeatmatch: false, needsVocals: false, needsStems: false },
  { id: "echo-out", name: "Echo-out", difficulty: "Easy", lengths: [2, 4, 8], defaultBars: 4, needsBeatmatch: false, needsVocals: false, needsStems: false },
  { id: "vocal-swap", name: "Vocal-to-instrumental", difficulty: "Intermediate", lengths: [8, 16, 32], defaultBars: 16, needsBeatmatch: true, needsVocals: true, needsStems: false },
  { id: "stem-swap", name: "STEMS swap (drums → vocals)", difficulty: "Advanced", lengths: [8, 16, 32], defaultBars: 16, needsBeatmatch: true, needsVocals: false, needsStems: true },
];
export const technique = (id: TechniqueId) => TECHNIQUES.find((t) => t.id === id)!;

/** The user's choices and manual corrections (saved with the plan). */
export interface PlanSettings {
  technique: TechniqueId;
  bars: number;
  /** Playback tempo for the transition; null = the outgoing track's tempo. */
  targetBpm: number | null;
  /** Bars (0–7) by which each track's phrases are offset from its grid's first beat. */
  outPhraseOffset: number;
  inPhraseOffset: number;
  /** Manual transition points (0-based bars from each grid's first beat); null = recommended. */
  outStartBar: number | null;
  inCueBar: number | null;
}

export const DEFAULT_SETTINGS: PlanSettings = { technique: "blend", bars: 16, targetBpm: null, outPhraseOffset: 0, inPhraseOffset: 0, outStartBar: null, inCueBar: null };

export interface Step {
  n: number;
  /** Beats from the transition start (bar 1 of the transition) on Track A; negative = before; null = preparation. */
  atBeat: number | null;
  /** Track A's timestamp for the step (null for preparation). */
  aTime: number | null;
  text: string;
  kind: "prepare" | "start" | "fader" | "eq" | "fx" | "stems" | "finish";
}

export interface Warning {
  level: "warn" | "info";
  text: string;
}

export interface TransitionPlan {
  technique: TechniqueId;
  bars: number;
  targetBpm: number;
  /** Playback rates (track seconds per second) and tempo changes in percent. */
  outRate: number;
  inRate: number;
  outTempoPct: number;
  inTempoPct: number;
  /** Track B counted in half/double time against A (1 = same). */
  inMultiple: number;
  /** Transition window on Track A (0-based bars and track seconds). */
  outStartBar: number;
  outStart: number;
  outEnd: number;
  /** Where Track B is cued and the A-bar (0-based, absolute) on which it is started. */
  inCueBar: number;
  inCue: number;
  inEnd: number;
  bStartsAtBar: number;
  /** Bass exchange (blend/bass swap/vocal swap/stem swap): bars into the transition (1-based "bar 9"). */
  swapAtBar: number | null;
  seconds: number;
  approximate: boolean;
  confidence: number;
  steps: Step[];
  warnings: Warning[];
  summary: string;
  /** Short reasons for the chosen points. */
  reasons: string[];
}

export interface TechniqueOption {
  info: TechniqueInfo;
  available: boolean;
  /** Why it suits this pairing — or why it's unavailable. */
  why: string;
  confidence: number;
  score: number;
  recommended: boolean;
}

// ─────────────────────────── bar / beat maths ───────────────────────────

export const beatLength = (bpm: number) => 60 / bpm;
export const barLength = (bpm: number) => (BEATS_PER_BAR * 60) / bpm;
/** Track time of a (0-based, possibly fractional) bar from the grid's first beat. */
export const timeAtBar = (g: Grid, bar: number) => g.firstBeat + bar * barLength(g.bpm);
/** Track time of a beat (0-based) from the grid's first beat. */
export const timeAtBeat = (g: Grid, beat: number) => g.firstBeat + beat * beatLength(g.bpm);
/** Whole bars from the first beat that fit in the track. */
export const barCount = (g: Grid, duration: number) => Math.max(0, Math.floor((duration - g.firstBeat) / barLength(g.bpm) + 1e-6));

/** 1-based "bar.beat" at a track time (bar 1 = the grid's first bar). */
export function barBeatAt(g: Grid, t: number): { bar: number; beat: number } {
  const beats = Math.floor((t - g.firstBeat) / beatLength(g.bpm) + 1e-6);
  return { bar: Math.floor(beats / BEATS_PER_BAR) + 1, beat: (((beats % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR) + 1 };
}
export const barLabel = (g: Grid, t: number) => {
  const { bar, beat } = barBeatAt(g, t);
  return `bar ${bar}.${beat}`;
};

/** mm:ss.s */
export function fmtTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}
const fmtSecs = (s: number) => `${s.toFixed(1)} s`;
const pct = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;

/** Is a bar the start of a phrase (8 bars), given the phrase offset? */
export const isPhraseStart = (bar: number, offset: number) => (((bar - offset) % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS === 0;

/** Tempo match: rate for B, considering half/double time; pct = change from B's original tempo. */
export function matchTempo(target: number, inBpm: number): { multiple: number; rate: number; pct: number } {
  let best = { multiple: 1, rate: target / inBpm };
  for (const m of [2, 0.5]) {
    const rate = target / (inBpm * m);
    if (Math.abs(Math.log(rate)) < Math.abs(Math.log(best.rate)) - 1e-9) best = { multiple: m, rate };
  }
  return { ...best, pct: (best.rate - 1) * 100 };
}

/** Pitch shift from a tempo change without key lock, in semitones. */
export const semitones = (rate: number) => 12 * Math.log2(rate);

/** Per-bar loudness (0..1, by the 90th percentile) from an RMS envelope at `fps` frames per second. */
export function barEnergyFrom(rms: Float32Array, fps: number, g: Grid, duration: number): number[] {
  const n = barCount(g, duration);
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    const from = Math.max(0, Math.floor(timeAtBar(g, b) * fps));
    const to = Math.min(rms.length, Math.max(from + 1, Math.floor(timeAtBar(g, b + 1) * fps)));
    let sum = 0;
    for (let i = from; i < to; i++) sum += rms[i];
    out.push(to > from ? sum / (to - from) : 0);
  }
  const sorted = [...out].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;
  return out.map((v) => Math.min(1, v / p90));
}

/** Fraction of [a, b] (track seconds) covered by vocal regions. */
export function vocalCover(regions: [number, number][], a: number, b: number): number {
  if (b <= a) return 0;
  let covered = 0;
  for (const [s, e] of regions) covered += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return Math.min(1, covered / (b - a));
}

/** First vocal start after t (null if none). */
const nextVocal = (regions: [number, number][], t: number) => regions.filter(([s]) => s >= t).sort((x, y) => x[0] - y[0])[0]?.[0] ?? null;

/** Camelot relation of two keys (null = unknown). */
export function keyRelation(a: string | null, b: string | null): { compatible: boolean; label: string } | null {
  const x = camelotKey(a);
  const y = camelotKey(b);
  if (!x || !y) return null;
  const n = parseInt(x);
  const m = parseInt(y);
  const same = x.slice(-1) === y.slice(-1);
  if (x === y) return { compatible: true, label: `${x} → ${y} (same key)` };
  if (n === m) return { compatible: true, label: `${x} → ${y} (relative major/minor)` };
  if (same && (Math.abs(n - m) === 1 || Math.abs(n - m) === 11)) return { compatible: true, label: `${x} → ${y} (adjacent on the Camelot wheel)` };
  return { compatible: false, label: `${x} → ${y}` };
}

// ─────────────────────────── choosing the points ───────────────────────────

const sectionBar = (f: TrackFacts, kinds: string[], pick: "start" | "end", fallback: number): number => {
  const g = f.grid!;
  const s = f.sections.find((x) => kinds.includes(x.kind));
  const t = s ? (pick === "start" ? s.start : s.end) : null;
  return t === null ? fallback : Math.round((t - g.firstBeat) / barLength(g.bpm));
};

const meanEnergy = (f: TrackFacts, from: number, to: number): number | null => {
  if (!f.barEnergy?.length) return null;
  const xs = f.barEnergy.slice(Math.max(0, from), Math.max(from + 1, to));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/** Bars of A the transition occupies, and when B starts relative to the window start. */
function windowShape(t: TechniqueId, bars: number): { aBars: number; bOffsetBars: number } {
  if (t === "quick-cut") return { aBars: bars, bOffsetBars: bars }; // B starts on the cut, after the filter build
  if (t === "echo-out") return { aBars: 0, bOffsetBars: 0 }; // A cut on bar 1; echo tail rings over B
  return { aBars: bars, bOffsetBars: 0 };
}

interface Candidate {
  bar: number;
  score: number;
  reason: string;
}

function outCandidates(f: TrackFacts, t: TechniqueId, bars: number, offset: number): Candidate[] {
  const g = f.grid!;
  const n = barCount(g, f.duration);
  const { aBars } = windowShape(t, bars);
  // The transition may end exactly as Track A's last full bar ends.
  const latest = n - aBars;
  const earliest = Math.floor(n * 0.45);
  const outro = sectionBar(f, ["outro"], "start", Math.round(n * 0.85));
  const mixOut = f.cues.find((c) => c.kind === "mix-out");
  const target = mixOut ? Math.round((mixOut.timestamp - g.firstBeat) / barLength(g.bpm)) : outro;
  const picks: Candidate[] = [];
  for (let b = Math.max(0, earliest); b <= latest; b++) {
    if (!isPhraseStart(b, offset)) continue;
    let score = -Math.abs(b - target) / PHRASE_BARS + (b / Math.max(1, n)) * 0.5;
    const e = meanEnergy(f, b, b + Math.max(1, aBars));
    if (e !== null) score += (1 - e) * 0.8;
    if (f.vocals) {
      const v = vocalCover(f.vocals, timeAtBar(g, b), timeAtBar(g, b + Math.max(1, aBars)));
      score += t === "vocal-swap" ? (vocalCover(f.vocals, timeAtBar(g, b), timeAtBar(g, b + aBars / 2)) - vocalCover(f.vocals, timeAtBar(g, b + aBars / 2), timeAtBar(g, b + aBars))) * 1.5 : -v * 1.5;
    }
    const reason = Math.abs(b - target) <= 1 ? (mixOut ? "at Track A's recommended mix-out" : "at the start of Track A's outro") : b > target ? "a phrase after Track A's outro starts" : "the phrase before Track A's outro";
    picks.push({ bar: b, score, reason });
  }
  if (!picks.length && latest >= 0) picks.push({ bar: Math.max(0, latest - (((latest - offset) % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS), score: -9, reason: "the last phrase start that leaves room for the transition" });
  return picks.sort((x, y) => y.score - x.score);
}

function inCandidates(f: TrackFacts, t: TechniqueId, bars: number, offset: number): Candidate[] {
  const g = f.grid!;
  const n = barCount(g, f.duration);
  const introEnd = sectionBar(f, ["intro"], "end", Math.round(n * 0.12));
  const playBars = t === "echo-out" ? bars : t === "quick-cut" ? 0 : bars;
  const latest = Math.min(Math.floor(n * 0.4), n - playBars - 1);
  const picks: Candidate[] = [];
  for (let b = 0; b <= latest; b++) {
    if (!isPhraseStart(b, offset)) continue;
    let score = -(b / PHRASE_BARS) * 0.15;
    if (t !== "quick-cut") score -= Math.max(0, b + playBars - introEnd) / PHRASE_BARS * 0.5;
    const e = meanEnergy(f, b, b + Math.max(1, playBars));
    if (e !== null) score += t === "quick-cut" ? e * 0.6 : (1 - e) * 0.5; // a cut lands best on a full-energy phrase
    if (f.vocals && playBars) score -= vocalCover(f.vocals, timeAtBar(g, b), timeAtBar(g, b + playBars)) * 1.2;
    const reason = b === 0 ? "from Track B's first bar" : b + playBars <= introEnd ? "a phrase start inside Track B's intro" : t === "quick-cut" ? "Track B's first full-energy phrase" : "a phrase start near the end of Track B's intro";
    picks.push({ bar: b, score, reason });
  }
  return picks.sort((x, y) => y.score - x.score);
}

// ─────────────────────────── availability & recommendations ───────────────────────────

/** Why no plan can be made yet (missing analysis), or null. */
export function missingAnalysis(a: TrackFacts | null, b: TrackFacts | null): string[] {
  const out: string[] = [];
  for (const [f, name] of [[a, "Track A"], [b, "Track B"]] as const) {
    if (!f) out.push(`${name}: choose a track`);
    else if (!f.analysed) out.push(`${name}: not analysed yet`);
    else if (!f.grid) out.push(`${name}: no beat grid (analysis found no steady beat)`);
  }
  return out;
}

const gridQuality = (g: Grid) => (g.manual ? 1 : Math.min(1, g.confidence / 2));

export function techniqueOptions(a: TrackFacts, b: TrackFacts, s: Pick<PlanSettings, "targetBpm">, stemsSupported: boolean): TechniqueOption[] {
  const target = s.targetBpm ?? a.grid!.bpm;
  const m = matchTempo(target, b.grid!.bpm);
  const tempoOk = Math.abs(m.pct) <= 10;
  const tempoPossible = Math.abs(m.pct) <= 16;
  const key = keyRelation(a.key, b.key);
  const gq = Math.min(gridQuality(a.grid!), gridQuality(b.grid!));
  const vocalsKnown = !!a.vocals && !!b.vocals;
  const energyJump = a.energy !== null && b.energy !== null ? b.energy - a.energy : 0;
  const keyText = key ? (key.compatible ? `keys compatible (${key.label})` : `keys clash (${key.label})`) : "keys unknown";
  const tempoText = `tempo ${pct(m.pct)} for Track B${m.multiple !== 1 ? ` (${m.multiple === 2 ? "half" : "double"}-time)` : ""}`;
  const opts = TECHNIQUES.map((info): TechniqueOption => {
    let available = true;
    let why = "";
    let score = 0.5;
    let conf = gq * 0.6 + 0.25 + (key ? 0.15 * Math.min(1, a.keyConfidence + b.keyConfidence) / 2 : 0);
    if (info.needsBeatmatch && !tempoPossible) {
      available = false;
      why = `Tempos are ${Math.abs(m.pct).toFixed(1)}% apart — too far to beatmatch (±16% maximum).`;
    } else if (info.needsVocals && !vocalsKnown) {
      available = false;
      why = "Needs vocal activity for both tracks — detect vocals from STEMS first.";
    } else if (info.needsStems && !(stemsSupported && a.stemsCached && b.stemsCached)) {
      available = false;
      why = !stemsSupported ? "STEMS separation isn't available on this computer." : "Needs STEMS for both tracks — analyse STEMS first.";
    }
    if (available) {
      switch (info.id) {
        case "blend":
          score = (tempoOk ? 0.85 : 0.55) - (key && !key.compatible ? 0.35 : 0) - Math.abs(energyJump) * 0.04;
          why = `Long overlap works: ${tempoText}, ${keyText}${key && !key.compatible ? " — keep the overlap short or the clash will be audible" : ""}.`;
          break;
        case "bass-swap":
          score = (tempoOk ? 0.8 : 0.5) - (key && !key.compatible ? 0.2 : 0) + (energyJump > 0 ? 0.05 : 0);
          why = `Clean low end with one decisive swap on a downbeat: ${tempoText}, ${keyText}.`;
          break;
        case "quick-cut":
          score = 0.45 + (key && !key.compatible ? 0.3 : 0) + (!tempoOk ? 0.25 : 0) + (Math.abs(energyJump) >= 3 ? 0.2 : 0);
          why = `No overlap, so tempo and key don't have to match${key && !key.compatible ? " — good for this key clash" : ""}${Math.abs(energyJump) >= 3 ? `; suits the energy change (${a.energy} → ${b.energy})` : ""}. Cut on a phrase downbeat.`;
          conf = gridQuality(a.grid!) * 0.7 + 0.3;
          break;
        case "echo-out":
          score = 0.4 + (key && !key.compatible ? 0.3 : 0) + (!tempoOk ? 0.3 : 0);
          why = `Track A's echo tail covers the change${!tempoOk ? " — no beatmatching needed for this tempo gap" : ""}${key && !key.compatible ? "; hides the key clash" : ""}.`;
          conf = gridQuality(a.grid!) * 0.7 + 0.3;
          break;
        case "vocal-swap":
          score = 0.75 - (key && !key.compatible ? 0.3 : 0);
          why = `Uses the detected vocals: Track A's last vocal finishes as Track B comes in instrumental; ${keyText}.`;
          conf = conf * 0.9 + 0.1;
          break;
        case "stem-swap":
          score = 0.7 + (key && !key.compatible ? 0.1 : 0);
          why = `Both tracks have STEMS: bring B's drums and bass in under A's vocal, then swap vocals — avoids vocal clashes; ${keyText}.`;
          break;
      }
    }
    return { info, available, why, confidence: Math.max(0, Math.min(1, available ? conf : 0)), score: available ? score : -1, recommended: false };
  });
  const best = opts.filter((o) => o.available).sort((x, y) => y.score - x.score)[0];
  if (best) best.recommended = true;
  return opts;
}

// ─────────────────────────── the plan ───────────────────────────

/** Build the plan, or explain why it can't be built. */
export function buildPlan(a: TrackFacts, b: TrackFacts, s: PlanSettings, stemsSupported = true): TransitionPlan | { error: string } {
  const missing = missingAnalysis(a, b);
  if (missing.length) return { error: missing.join(" · ") };
  const ga = a.grid!;
  const gb = b.grid!;
  const info = technique(s.technique);
  const option = techniqueOptions(a, b, s, stemsSupported).find((o) => o.info.id === s.technique)!;
  if (!option.available) return { error: option.why };
  const bars = info.lengths.includes(s.bars) ? s.bars : info.defaultBars;
  const target = s.targetBpm ?? ga.bpm;
  const outRate = target / ga.bpm;
  const m = matchTempo(target, gb.bpm);
  // Beatmatched techniques always match B's tempo; a cut or echo-out only does when it's a
  // normal adjustment (±10%) — otherwise B simply plays at its own tempo.
  const inRate = info.needsBeatmatch || Math.abs(m.pct) <= 10 ? m.rate : 1;
  const { aBars, bOffsetBars } = windowShape(s.technique, bars);

  // Points: manual if set (and valid), else the best phrase-aligned candidates (A and B scored jointly for vocals).
  const nA = barCount(ga, a.duration);
  const nB = barCount(gb, b.duration);
  const reasons: string[] = [];
  const outPicks = outCandidates(a, s.technique, bars, s.outPhraseOffset);
  const inPicks = inCandidates(b, s.technique, bars, s.inPhraseOffset);
  if (!outPicks.length || !inPicks.length) return { error: "These tracks are too short for this transition length — choose fewer bars." };
  let outBar = outPicks[0].bar;
  let inBar = inPicks[0].bar;
  let outWhy = outPicks[0].reason;
  let inWhy = inPicks[0].reason;
  if (a.vocals && b.vocals && s.outStartBar === null && s.inCueBar === null) {
    let best = -Infinity;
    for (const op of outPicks.slice(0, 4))
      for (const ip of inPicks.slice(0, 4)) {
        const clash = overlapBars(a, b, op.bar, ip.bar, bars, s.technique, outRate, inRate).bars;
        const sc = op.score + ip.score - clash * 0.4;
        if (sc > best) ((best = sc), (outBar = op.bar), (inBar = ip.bar), (outWhy = op.reason), (inWhy = ip.reason));
      }
  }
  if (s.outStartBar !== null && s.outStartBar >= 0 && s.outStartBar + aBars <= nA) ((outBar = s.outStartBar), (outWhy = "set by you"));
  if (s.inCueBar !== null && s.inCueBar >= 0 && s.inCueBar < nB) ((inBar = s.inCueBar), (inWhy = "set by you"));

  const outStart = timeAtBar(ga, outBar);
  const bStartsAtBar = outBar + bOffsetBars;
  const bStartTime = timeAtBar(ga, bStartsAtBar);
  const seconds = (Math.max(1, bars) * BEATS_PER_BAR * 60) / target;
  const outEnd = timeAtBar(ga, outBar + aBars);
  const inCue = timeAtBar(gb, inBar);
  // Track B's own time advances by the wall-clock overlap × its playback rate.
  const overlapSecs = s.technique === "quick-cut" ? 0 : seconds;
  const inEnd = inCue + overlapSecs * inRate;
  if (inEnd > b.duration) return { error: "Track B ends before the transition would finish — choose fewer bars or another cue." };
  reasons.push(`Track A from ${barLabel(ga, outStart)} — ${outWhy}`, `Track B from ${barLabel(gb, inCue)} — ${inWhy}`);

  const swapAtBar = ["blend", "bass-swap", "vocal-swap", "stem-swap"].includes(s.technique) ? bars / 2 + 1 : null;
  const key = keyRelation(a.key, b.key);
  const warnings: Warning[] = [];
  const approx = !ga.manual || !gb.manual;
  for (const [f, name] of [[a, "Track A"], [b, "Track B"]] as const) {
    if (!f.grid!.manual && f.grid!.confidence < GRID_CONFIDENT) warnings.push({ level: "warn", text: `${name}'s beat grid is uncertain (confidence ${f.grid!.confidence.toFixed(1)}). Check its first downbeat with the grid controls before relying on the bar numbers.` });
  }
  warnings.push({ level: "info", text: "Phrase starts are estimated from the energy analysis (8-bar phrases from each grid's first bar) and are approximate. If a phrase starts elsewhere, move the phrase marker." });
  if (key && !key.compatible) warnings.push({ level: "warn", text: `Keys clash (${key.label}). Keep the overlap short, or use a quick cut / echo-out.` });
  if (!key) warnings.push({ level: "info", text: "Key unknown for at least one track — harmonic compatibility can't be checked." });
  if (Math.abs(m.pct) > 10 && inRate !== 1) warnings.push({ level: "warn", text: `Track B needs ${pct(m.pct)} — outside the ±10% tempo range (the deck switches to ±16%).` });
  if (Math.abs(semitones(inRate)) >= 0.25) warnings.push({ level: "info", text: `Without KEY LOCK, ${pct(m.pct)} shifts Track B's pitch by ${Math.abs(semitones(inRate)).toFixed(1)} semitones — turn KEY LOCK on for Track B.` });
  if (m.multiple !== 1) warnings.push({ level: "info", text: `Track B (${gb.bpm.toFixed(1)} BPM) is matched in ${m.multiple === 2 ? "half" : "double"} time against ${target.toFixed(1)} BPM.` });
  let nextVocalA: number | null = null;
  if (a.vocals && b.vocals) {
    const o = overlapBars(a, b, outBar, inBar, bars, s.technique, outRate, inRate);
    if (o.bars >= 0.5 && s.technique !== "stem-swap") warnings.push({ level: "warn", text: `Vocals overlap for about ${o.bars.toFixed(1)} bars (transition bars ${o.from}–${o.to}).${s.technique === "blend" || s.technique === "bass-swap" ? " Try a STEMS swap or a shorter transition." : ""}` });
    nextVocalA = nextVocal(a.vocals, outEnd);
  } else warnings.push({ level: "info", text: "Vocal activity unknown — detect vocals (from STEMS) to check for overlapping vocals." });
  if (a.energy !== null && b.energy !== null && Math.abs(b.energy - a.energy) >= 3) warnings.push({ level: "info", text: `Energy changes from ${a.energy} to ${b.energy} — a long blend may feel uneven; a cut or echo-out marks the change.` });

  const steps = buildSteps({ a: ga, b: gb, s: { ...s, bars }, outBar, bStartsAtBar, outStart, bStartTime, inCue, inEnd, outEnd, target, inRate, outRate, m, swapAtBar, aBars, keylock: Math.abs(semitones(inRate)) >= 0.25 });
  const confidence = Math.round(option.confidence * 100) / 100;
  const startClause = `When Track A reaches ${fmtTime(bStartTime)} (${barLabel(ga, bStartTime)}), start Track B from ${fmtTime(inCue)}`;
  const body =
    s.technique === "quick-cut"
      ? `. Build with A's filter for ${bars} bar${bars > 1 ? "s" : ""} from ${fmtTime(outStart)}, then cut to B on the downbeat`
      : s.technique === "echo-out"
        ? `. Echo Track A out from that downbeat and let the echo ring for ${bars} bars (${fmtSecs(seconds)}) over B`
        : `. Blend over ${bars} bars (${fmtSecs(seconds)} at ${target.toFixed(2)} BPM), exchange the bass at bar ${swapAtBar} of the blend (${fmtTime(timeAtBar(ga, outBar + (swapAtBar ?? 1) - 1))}), and finish by ${fmtTime(outEnd)}`;
  const vocalClause = nextVocalA !== null && s.technique !== "echo-out" && s.technique !== "quick-cut" ? ` — before Track A's next vocal at ${fmtTime(nextVocalA)}` : "";
  return {
    technique: s.technique,
    bars,
    targetBpm: target,
    outRate,
    inRate,
    outTempoPct: (outRate - 1) * 100,
    inTempoPct: (inRate - 1) * 100,
    inMultiple: m.multiple,
    outStartBar: outBar,
    outStart,
    outEnd: s.technique === "echo-out" ? timeAtBar(ga, outBar) : outEnd,
    inCueBar: inBar,
    inCue,
    inEnd,
    bStartsAtBar,
    swapAtBar,
    seconds,
    approximate: approx,
    confidence,
    steps,
    warnings,
    summary: `${startClause}${body}${vocalClause}.`,
    reasons,
  };
}

/** Bars of the transition where both tracks have vocals (stem swap mutes one, so it doesn't count). */
function overlapBars(a: TrackFacts, b: TrackFacts, outBar: number, inBar: number, bars: number, t: TechniqueId, outRate: number, inRate: number): { bars: number; from: number; to: number } {
  if (!a.vocals || !b.vocals || t === "quick-cut") return { bars: 0, from: 0, to: 0 };
  const ga = a.grid!;
  const gb = b.grid!;
  const { aBars, bOffsetBars } = windowShape(t, bars);
  const barSecs = (BEATS_PER_BAR * 60) / (ga.bpm * outRate);
  let count = 0;
  let from = 0;
  let to = 0;
  for (let i = bOffsetBars; i < Math.max(aBars, 1); i++) {
    const aT = timeAtBar(ga, outBar + i);
    const bT = timeAtBar(gb, inBar) + (i - bOffsetBars) * barSecs * inRate;
    const both = vocalCover(a.vocals, aT, timeAtBar(ga, outBar + i + 1)) > 0.25 && vocalCover(b.vocals, bT, bT + barSecs * inRate) > 0.25;
    if (both) {
      count++;
      if (!from) from = i + 1;
      to = i + 1;
    }
  }
  return { bars: count, from, to };
}

interface StepCtx {
  a: Grid;
  b: Grid;
  s: PlanSettings;
  outBar: number;
  bStartsAtBar: number;
  outStart: number;
  bStartTime: number;
  inCue: number;
  inEnd: number;
  outEnd: number;
  target: number;
  inRate: number;
  outRate: number;
  m: { multiple: number; pct: number };
  swapAtBar: number | null;
  aBars: number;
  keylock: boolean;
}

function buildSteps(c: StepCtx): Step[] {
  const { a, s } = c;
  const L = s.bars;
  const at = (bar: number, beat = 0): { atBeat: number; aTime: number; label: string } => {
    const beats = bar * BEATS_PER_BAR + beat;
    const t = timeAtBeat(a, c.outBar * BEATS_PER_BAR + beats);
    return { atBeat: beats, aTime: t, label: `${fmtTime(t)} (${barLabel(a, t)})` };
  };
  const prep: string[] = [];
  if (Math.abs(c.outRate - 1) > 0.0005) prep.push(`Set Track A's tempo to ${pct((c.outRate - 1) * 100)} (${c.target.toFixed(2)} BPM).`);
  if (Math.abs(c.inRate - 1) > 0.0005) prep.push(`Set Track B's tempo to ${pct((c.inRate - 1) * 100)} so it plays at ${c.target.toFixed(2)} BPM (or press SYNC).`);
  else if (Math.abs(c.m.pct) > 0.05) prep.push(`Leave Track B at its own tempo (${(c.b.bpm).toFixed(2)} BPM) — this technique doesn't overlap the beats, so no beatmatching.`);
  else prep.push(`Track B already plays at ${c.target.toFixed(2)} BPM — no tempo change needed.`);
  if (c.keylock) prep.push("Turn KEY LOCK on for Track B so the tempo change doesn't change its key.");
  prep.push(`Cue Track B at ${fmtTime(c.inCue)} (${barLabel(c.b, c.inCue)}, the first beat of a phrase).`);
  const steps: Omit<Step, "n">[] = prep.map((text) => ({ atBeat: null, aTime: null, text, kind: "prepare" as const }));
  const add = (bar: number, beat: number, kind: Step["kind"], text: (label: string) => string) => {
    const p = at(bar, beat);
    steps.push({ atBeat: p.atBeat, aTime: p.aTime, text: text(p.label), kind });
  };
  const half = L / 2;
  switch (s.technique) {
    case "blend":
    case "vocal-swap":
      steps.push({ atBeat: null, aTime: null, kind: "prepare", text: "Track B: channel fader down, LOW EQ fully cut, MID and HIGH at 12 o'clock." });
      add(0, 0, "start", (l) => `At ${l}, press PLAY on Track B — exactly on the downbeat.`);
      add(0, 0, "fader", () => `Over the next ${Math.max(1, L / 4)} bars, bring Track B's channel fader up to full (its bass stays cut).`);
      add(half, 0, "eq", (l) => `At ${l} — bar ${c.swapAtBar} of the blend — exchange the bass over one bar: Track A's LOW down while Track B's LOW comes up.`);
      add(half, 0, "eq", () => `Over the last ${half} bars, turn Track A's MID and HIGH down and pull its fader down.`);
      if (s.technique === "vocal-swap") add(0, 0, "fader", () => "Let Track A's last vocal line finish over Track B's instrumental — don't bring B's vocal in until A's has ended.");
      break;
    case "bass-swap":
      steps.push({ atBeat: null, aTime: null, kind: "prepare", text: "Track B: LOW EQ fully cut, channel fader down." });
      add(0, 0, "start", (l) => `At ${l}, press PLAY on Track B on the downbeat and bring its fader up to full within one bar.`);
      add(half, -1, "eq", (l) => `Get ready: on the next downbeat swap the bass (beat 4 of the bar before is ${l}).`);
      add(half, 0, "eq", (l) => `At ${l} — bar ${c.swapAtBar} of the transition — swap the bass in one move: Track A's LOW fully down, Track B's LOW to 12 o'clock.`);
      add(half, 0, "fader", () => `Fade Track A out over the last ${half} bars.`);
      break;
    case "quick-cut":
      steps.push({ atBeat: null, aTime: null, kind: "prepare", text: "Track B: paused at its cue, channel fader down (or crossfader on Track A)." });
      add(0, 0, "eq", (l) => `At ${l}, start turning Track A's FILTER to the right (high-pass) over ${L} bar${L > 1 ? "s" : ""} to build.`);
      add(L, 0, "start", (l) => `At ${l}, on the downbeat: press PLAY on Track B and cut Track A in the same instant (A's fader down, B's up). Return A's FILTER to centre.`);
      break;
    case "echo-out":
      steps.push({ atBeat: null, aTime: null, kind: "prepare", text: "FX1: choose ECHO at 1/2 or 3/4 beat, assign it to Track A's deck, level about 60% — leave it off. Track B paused at its cue, fader down." });
      add(0, -1, "fx", (l) => `At ${l} (beat 4 of the bar before), switch FX1 ECHO on.`);
      add(0, 0, "start", (l) => `At ${l}, on the downbeat: pull Track A's fader down (the echo keeps ringing) and press PLAY on Track B with its fader up.`);
      add(L, 0, "fx", (l) => `At ${l}, after ${L} bars of echo tail, switch FX1 off.`);
      break;
    case "stem-swap":
      steps.push({ atBeat: null, aTime: null, kind: "prepare", text: "STEMS on for both decks. Track B: VOCALS muted (pad 1), LOW EQ cut, fader down." });
      add(0, 0, "start", (l) => `At ${l}, press PLAY on Track B — its drums, bass and instruments come in under Track A's vocal; bring B's fader up over ${Math.max(1, L / 4)} bars.`);
      add(half, 0, "stems", (l) => `At ${l} — bar ${c.swapAtBar} — mute Track A's DRUMS and BASS (pads 2 and 3) as you bring Track B's LOW up: B's groove takes over under A's vocal.`);
      add(L * 0.75, 0, "stems", (l) => `At ${l}, mute Track A's VOCALS and unmute Track B's VOCALS (pad 1).`);
      break;
  }
  if (s.technique !== "echo-out" && s.technique !== "quick-cut")
    add(c.aBars, 0, "finish", (l) => `By ${l}, Track A is out: fader down, EQs (and STEMS) back to normal. Track B carries on alone, now at ${fmtTime(c.inEnd)} in its own timeline.`);
  else add(s.technique === "quick-cut" ? L : L, 0, "finish", () => `Track B carries on alone; reset Track A's EQ, filter and effects.`);
  steps.sort((x, y) => (x.atBeat ?? -1e9) - (y.atBeat ?? -1e9));
  return steps.map((st, i) => ({ ...st, n: i + 1 }));
}

// ─────────────────────────── rehearsal clock ───────────────────────────

export interface RehearsalCue {
  /** Beats from the transition start on Track A (negative = lead-in). */
  beat: number;
  /** 1-based bar of the transition (null before it starts). */
  transitionBar: number | null;
  /** Bars:beats until the next timed step. */
  countdown: { bars: number; beats: number; totalBeats: number } | null;
  current: Step | null;
  next: Step | null;
  done: boolean;
}

/**
 * Where a rehearsal is, from Track A's playback position (the audio clock): beats to the next
 * instruction, the current instruction and the transition bar.
 */
export function rehearsalCue(plan: TransitionPlan, grid: Grid, aPosition: number): RehearsalCue {
  const beat = (aPosition - timeAtBar(grid, plan.outStartBar)) / beatLength(grid.bpm);
  const timed = plan.steps.filter((s) => s.atBeat !== null);
  const eps = 1e-3;
  const next = timed.find((s) => s.atBeat! > beat + eps) ?? null;
  const current = [...timed].reverse().find((s) => s.atBeat! <= beat + eps) ?? null;
  const last = timed[timed.length - 1];
  let countdown: RehearsalCue["countdown"] = null;
  if (next) {
    const total = Math.ceil(next.atBeat! - beat - eps);
    countdown = { bars: Math.floor(total / BEATS_PER_BAR), beats: total % BEATS_PER_BAR, totalBeats: total };
  }
  return { beat, transitionBar: beat >= -eps ? Math.floor(beat / BEATS_PER_BAR + eps) + 1 : null, countdown, current, next, done: !!last && beat >= last.atBeat! + BEATS_PER_BAR };
}

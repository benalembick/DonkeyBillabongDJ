import { GRID_CONFIDENT } from "../preparation/beatGrid";
/**
 * Automatic Hot Cue generation (pure, deterministic). Phase 2 — see docs/architecture/AI_SET_STUDIO.md §5.
 *
 * Works on the cached worker analysis (150 fps low/mid/high envelopes, beat grid, sections) plus vocal
 * regions from STEMS when they exist. A moment that can't be found reliably is *omitted* with a reason —
 * nothing is placed just to fill a cue type. Bars assume 4 beats from the grid's first beat (the app has
 * no meter detection), so bar/phrase-based cues are capped in confidence and labelled as estimated.
 */
/** 2: repeated drops/builds/breakdowns (Drop 1, Drop 2…) and the outro only after the last drop. */
export const AUTOCUE_VERSION = 2;

export type CueType = "intro" | "first-beat" | "first-phrase" | "vocal-entry" | "build" | "breakdown" | "drop" | "outro" | "mix-out";
export type ReviewStatus = "suggested" | "accepted" | "modified" | "rejected";
export type QuantiseMode = "none" | "beat" | "bar" | "4bars" | "8bars" | "16bars";

export const CUE_TYPES: { id: CueType; label: string; colour: string; purpose: string }[] = [
  { id: "intro", label: "Intro", colour: "#38c8ff", purpose: "Beginning of the usable introduction" },
  { id: "first-beat", label: "First Beat", colour: "#2f7bff", purpose: "First reliable rhythmic beat" },
  { id: "first-phrase", label: "First Phrase", colour: "#8b6cff", purpose: "Beginning of the first musical phrase" },
  { id: "vocal-entry", label: "Vocal Entry", colour: "#ff4fb8", purpose: "First significant vocal entrance" },
  { id: "build", label: "Build-Up", colour: "#ff8a3d", purpose: "Beginning of an energy build" },
  { id: "breakdown", label: "Breakdown", colour: "#ffd23f", purpose: "Beginning of a lower-energy section" },
  { id: "drop", label: "Drop", colour: "#ff3b30", purpose: "Major rhythmic or energy release" },
  { id: "outro", label: "Outro", colour: "#30d158", purpose: "Beginning of the closing section" },
  { id: "mix-out", label: "Final Mix-Out", colour: "#14b8a6", purpose: "Point by which a transition out should be complete" },
];
export const cueInfo = (t: CueType) => CUE_TYPES.find((c) => c.id === t)!;
/** Suggestions at or above this are "high confidence" (Accept All); below LOW they're shown as unreliable. */
export const HIGH_CONFIDENCE = 0.7;
export const LOW_CONFIDENCE = 0.45;

export interface CueGrid { bpm: number; firstBeat: number; confidence: number; manual: boolean }
export interface CueInput {
  duration: number;
  fps: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  grid: CueGrid | null;
  /** Vocal regions [start, end] s from STEMS; null = no vocal analysis; [] = analysed, no vocals. */
  vocals: [number, number][] | null;
}

export interface GeneratedCue {
  id: string;
  cueType: CueType;
  /** 1 for the first drop/build/breakdown, 2 for the second… (other types: 1). */
  occurrence?: number;
  label: string;
  colour: string;
  detectedPosition: number;
  quantisedPosition: number;
  confidence: number;
  detectionMethod: string;
  /** Note about quantisation or estimation (e.g. "4/4 assumed"). */
  note?: string;
  analysisVersion: number | null;
  reviewStatus: ReviewStatus;
  /** Hot cue slot (0–7) once accepted onto the pads. */
  slot: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface MixRegion { kind: "in" | "out"; label: string; start: number; end: number; rationale: string; confidence: number; phraseAligned: boolean; availableSeconds: number }
export interface CueDetection { cues: Omit<GeneratedCue, "id" | "reviewStatus" | "slot" | "createdAt" | "updatedAt" | "analysisVersion" | "quantisedPosition">[]; unavailable: { cueType: CueType; reason: string }[]; mixIn: MixRegion[]; mixOut: MixRegion[]; gridReliable: boolean }
export interface CueSuggestionSet {
  version: number;
  /** analysedAt of the worker analysis these came from. */
  analysisVersion: number | null;
  generatedAt: number;
  quantise: QuantiseMode;
  cues: GeneratedCue[];
  /** The hot cue pads as they were before Auto Cue first changed them (Restore original pads). */
  padBackup?: { slot: number; timestamp: number; name: string; colour: string; source?: "analysis" | "manual"; comment?: string; confidence?: number }[];
  unavailable: { cueType: CueType; reason: string }[];
  mixIn: MixRegion[];
  mixOut: MixRegion[];
  /** The set this one replaced (Restore Previous Suggestions). */
  previous?: Omit<CueSuggestionSet, "previous">;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round2 = (x: number) => Math.round(x * 100) / 100;
function pct(a: ArrayLike<number>, p: number): number { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; }
const avg = (a: number[], from: number, to: number) => { let s = 0, n = 0; for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) { s += a[i]; n++; } return n ? s / n : 0; };

export const gridReliable = (g: CueGrid | null): g is CueGrid => !!g && g.bpm > 0 && (g.manual || g.confidence >= GRID_CONFIDENT);
export const beatLen = (g: CueGrid) => 60 / g.bpm;
export const barLen = (g: CueGrid) => 240 / g.bpm;

/** Quantisation to the existing beat grid. Never moves a cue more than 2 bars: a further boundary would change its musical meaning. */
export function quantise(t: number, grid: CueGrid | null, mode: QuantiseMode): { t: number; note?: string } {
  if (mode === "none") return { t };
  if (!gridReliable(grid)) return { t, note: "Not quantised — beat grid isn't reliable" };
  const step = mode === "beat" ? beatLen(grid) : barLen(grid) * (mode === "bar" ? 1 : mode === "4bars" ? 4 : mode === "8bars" ? 8 : 16);
  const q = grid.firstBeat + Math.round((t - grid.firstBeat) / step) * step;
  if (Math.abs(q - t) > 2 * barLen(grid) + 1e-6) {
    const b = grid.firstBeat + Math.round((t - grid.firstBeat) / barLen(grid)) * barLen(grid);
    return { t: Math.max(0, round2(b)), note: `Nearest ${mode.replace("bars", " bars")} boundary is more than 2 bars away — kept on the nearest bar` };
  }
  return { t: Math.max(0, round2(q)) };
}

/** Mean of `env` per bar (bars from the grid's first beat), normalised so the 90th percentile is 1. */
function bars(env: Float32Array, fps: number, g: CueGrid, duration: number): number[] {
  const len = barLen(g), n = Math.floor((duration - g.firstBeat) / len);
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    const f0 = Math.floor((g.firstBeat + b * len) * fps), f1 = Math.min(env.length, Math.floor((g.firstBeat + (b + 1) * len) * fps));
    let s = 0; for (let f = f0; f < f1; f++) s += env[f];
    out.push(f1 > f0 ? s / (f1 - f0) : 0);
  }
  const p90 = pct(out, 0.9) || 1;
  return out.map((v) => Math.min(1.5, v / p90));
}

export function detectCues(input: CueInput): CueDetection {
  const { duration, fps, low, mid, grid } = input;
  const cues: CueDetection["cues"] = [], unavailable: CueDetection["unavailable"] = [], mixIn: MixRegion[] = [], mixOut: MixRegion[] = [];
  const add = (cueType: CueType, t: number, confidence: number, detectionMethod: string, note?: string, occurrence = 1, of = 1) => { const i = cueInfo(cueType); cues.push({ cueType, occurrence, label: of > 1 ? `${i.label} ${occurrence}` : i.label, colour: i.colour, detectedPosition: round2(Math.max(0, Math.min(duration, t))), confidence: round2(confidence), detectionMethod, note }); };
  const miss = (cueType: CueType, reason: string) => unavailable.push({ cueType, reason });
  const n = Math.min(low.length, mid.length);
  const level = new Float32Array(n);
  for (let i = 0; i < n; i++) level[i] = low[i] + 0.6 * mid[i];
  const p95 = pct(level, 0.95);
  if (n < fps * 20 || p95 <= 1e-4) {
    for (const c of CUE_TYPES) miss(c.id, "Track too short or silent for structure analysis");
    return { cues, unavailable, mixIn, mixOut, gridReliable: false };
  }
  // ½ s smoothed level for time-based (grid-free) detection.
  const w = Math.max(1, Math.round(fps * 0.5)), sm = new Float32Array(n);
  { let acc = 0; for (let i = 0; i < n; i++) { acc += level[i]; if (i >= w) acc -= level[i - w]; sm[i] = acc / Math.min(i + 1, w); } }
  const audibleAt = (thr: number) => { for (let i = 0; i < n; i++) if (sm[i] > thr) return Math.max(0, (i - w / 2) / fps); return null; };
  const lastAudible = (thr: number) => { for (let i = n - 1; i >= 0; i--) if (sm[i] > thr) return Math.min(duration, (i + 1) / fps); return null; };

  // Intro start: where the music becomes audible (8 % of the loud level).
  const intro = audibleAt(p95 * 0.08);
  if (intro !== null) add("intro", intro, intro < 0.3 ? 0.9 : 0.85, "Level onset in the cached waveform");
  else miss("intro", "No audible start found");

  // Vocal entry: STEMS only — never from title or genre.
  if (input.vocals === null) miss("vocal-entry", "No vocal analysis for this track — separate its STEMS (Transition Guides → Detect vocals) to find vocals");
  else {
    const first = input.vocals.find(([s, e]) => e - s >= 2) ?? null;
    if (first) add("vocal-entry", first[0], 0.8, "Vocal stem envelope (STEMS)");
    else miss("vocal-entry", input.vocals.length ? "Only short vocal fragments found" : "STEMS found no vocals (instrumental)");
  }

  const reliable = gridReliable(grid);
  const barBased: CueType[] = ["first-beat", "first-phrase", "build", "breakdown", "drop"];
  if (!reliable) {
    const g0 = input.grid as CueGrid | null;
    const why = g0 ? `Beat grid isn't reliable (confidence ${g0.confidence.toFixed(1)}) — bar-based structure can't be verified` : "No beat grid — analyse the track first";
    for (const t of barBased) miss(t, why);
  }

  // Grid-free closing points (used when the grid isn't reliable).
  const endOfMusic = lastAudible(p95 * 0.3);
  if (!reliable) {
    if (endOfMusic !== null) add("mix-out", endOfMusic, 0.55, "Last loud moment in the cached waveform (no grid)");
    else miss("mix-out", "No clear end of the music found");
    miss("outro", "Outro needs a reliable beat grid to find its bar boundary");
    if (intro !== null && endOfMusic !== null) {
      mixIn.push({ kind: "in", label: "Start of the music", start: intro, end: Math.min(duration, intro + 30), rationale: "First audible moment (beat grid unreliable — not phrase-aligned)", confidence: 0.45, phraseAligned: false, availableSeconds: 30 });
      mixOut.push({ kind: "out", label: "Final 30 seconds", start: Math.max(0, endOfMusic - 30), end: endOfMusic, rationale: "Before the music ends (beat grid unreliable — not phrase-aligned)", confidence: 0.45, phraseAligned: false, availableSeconds: Math.min(30, endOfMusic) });
    }
    return { cues, unavailable, mixIn, mixOut, gridReliable: false };
  }

  const g = grid!, bl = barLen(g), bt = (b: number) => g.firstBeat + b * bl;
  const lv = bars(level, fps, g, duration), bass = bars(low, fps, g, duration), nb = lv.length;
  const capped = (c: number) => Math.min(c, g.manual ? 0.85 : 0.75); // 4/4 assumed
  const est = "4/4 assumed (no meter detection)";

  // First beat: first grid beat at/after the intro with real low/mid activity on it.
  const startT = intro ?? 0;
  let firstBeat: number | null = null;
  const medianLevel = pct(level, 0.5);
  for (let k = Math.max(0, Math.ceil((startT - g.firstBeat) / beatLen(g) - 0.25)); k < 256; k++) {
    const t = g.firstBeat + k * beatLen(g);
    if (t > duration / 2) break;
    const f = Math.round(t * fps); let peak = 0;
    for (let i = Math.max(0, f - 4); i <= Math.min(n - 1, f + 6); i++) peak = Math.max(peak, level[i]);
    if (peak >= medianLevel * 0.5) { firstBeat = t; break; }
  }
  if (firstBeat !== null) add("first-beat", firstBeat, Math.min(0.95, 0.5 + g.confidence / 6 + (g.manual ? 0.2 : 0)), "Beat grid + onset level");
  else miss("first-beat", "No beat with clear rhythmic energy in the first half");

  // Phrase offset: the bar offset (mod 8) where energy changes cluster.
  // The bar containing the first beat (a phrase can't start before the music does).
  const fb = firstBeat !== null ? Math.max(0, Math.ceil((firstBeat - g.firstBeat) / bl - 0.05)) : 0;
  const scores = Array(8).fill(0);
  for (let b = 1; b < nb; b++) scores[b % 8] += Math.abs(lv[b] - lv[b - 1]) + Math.abs(bass[b] - bass[b - 1]);
  const best = scores.indexOf(Math.max(...scores)), mean = scores.reduce((a, b) => a + b, 0) / 8;
  const contrast = mean > 0 ? scores[best] / mean : 1;
  const phraseOffset = contrast >= 1.3 ? best : fb % 8;
  let firstPhrase = fb; while ((firstPhrase - phraseOffset) % 8 !== 0) firstPhrase++;
  if (firstPhrase < nb) add("first-phrase", bt(firstPhrase), capped(contrast >= 1.3 ? clamp01(0.35 + (contrast - 1) * 0.6) : 0.4), contrast >= 1.3 ? "Phrase boundaries from where energy changes cluster (8-bar)" : "8 bars from the first beat (no clear phrase pattern)", est);
  else miss("first-phrase", "Track too short for an 8-bar phrase");
  const isPhrase = (b: number) => ((b - phraseOffset) % 8 + 8) % 8 === 0;

  // Drop: bass jumps above the previous 8 bars, stays up for 4, and is loud — after real music (a build or
  // breakdown), not just the first beats arriving after a quiet intro. At least 16 bars after the first beat.
  // Drops (up to 2): bass jumps above the previous 8 bars, stays up for 4 and is loud — after real music, not the
  // first beats arriving after a quiet intro; ≥ 16 bars after the first beat and after the previous drop.
  const drops: { bar: number; jump: number }[] = [];
  for (let b = Math.max(8, fb + 16); b < nb - 4 && drops.length < 2; b++) {
    if (drops.length && b < drops[drops.length - 1].bar + 16) continue;
    const before = avg(bass, b - 8, b), jump = bass[b] - before;
    if (jump < 0.3 || lv[b] < 0.55 || avg(bass, b, b + 4) < before + 0.2 || avg(lv, b - 8, b) < 0.2) continue;
    drops.push({ bar: b, jump });
  }
  drops.forEach((d, i) => add("drop", bt(d.bar), capped(0.5 + d.jump * 0.6), "Sustained bass + level jump (bar analysis)", est, i + 1, drops.length));
  if (!drops.length) miss("drop", "No sustained bass/energy release found");
  const drop = drops[0]?.bar ?? null;

  // Build-ups: the rising stretch before each drop, snapped to an 8/16/32-bar distance.
  const builds: { bar: number; conf: number }[] = [];
  drops.forEach((d, i) => {
    const from = Math.max(fb, i ? drops[i - 1].bar + 4 : 0, d.bar - 32);
    if (from >= d.bar) return;
    let m = from; for (let b = from; b < d.bar; b++) if (lv[b] < lv[m]) m = b;
    const gap = [8, 16, 32].reduce((a, c) => (Math.abs(c - (d.bar - m)) < Math.abs(a - (d.bar - m)) ? c : a), 8);
    const start = Math.max(from, d.bar - gap);
    if (d.bar - start >= 4 && avg(lv, d.bar - 2, d.bar) > lv[m] + 0.12) builds.push({ bar: start, conf: capped(0.45 + (avg(lv, d.bar - 2, d.bar) - lv[m])) });
  });
  builds.forEach((b, i) => add("build", bt(b.bar), b.conf, "Rising level before the drop", est, i + 1, builds.length));
  if (!builds.length) miss("build", drops.length ? "No rising section before the drop" : "No drop found, so no build-up to it");

  // Breakdowns (up to 2): ≥4 bars of low bass and level after the first 16 bars (or the first drop), before the last 16.
  const medBass = pct(bass, 0.5), medLv = pct(lv, 0.5);
  const breakdowns: number[] = [];
  for (let b = Math.max(16, (drop ?? 0) + 4); b < nb - 16 && breakdowns.length < 2; b++) {
    if (breakdowns.length && b < breakdowns[breakdowns.length - 1] + 16) continue;
    let ok = true; for (let k = 0; k < 4; k++) if (bass[b + k] >= medBass * 0.45 || lv[b + k] >= medLv * 0.75) { ok = false; break; }
    if (ok && bass[b - 1] >= medBass * 0.6) breakdowns.push(b);
  }
  breakdowns.forEach((b, i) => add("breakdown", bt(b), capped(0.5 + clamp01(medBass - avg(bass, b, b + 4)) * 0.5), "Sustained drop in bass and level (bar analysis)", est, i + 1, breakdowns.length));
  if (!breakdowns.length) miss("breakdown", "No sustained lower-energy section found");
  const breakdown = breakdowns[0] ?? null;

  // End of the music (last bar at ≥ 20 % of the loud level — a quieter outro still counts) and the outro before it.
  let lastFull = nb - 1; while (lastFull > 0 && lv[lastFull] < 0.2) lastFull--;
  const mixOutBar = Math.min(nb, lastFull + 1);
  if (lastFull > 16) add("mix-out", bt(mixOutBar), capped(0.7), "End of the full-level music (bar analysis)");
  else miss("mix-out", "No clear end of the music found");
  let outro: number | null = null;
  if (lastFull > 24) {
    // Walk back from the end while bass stays clearly under the track's typical bass: that stretch is the outro.
    // An outro can't begin before the last drop has played out (≥ 8 bars after it).
    const earliest = Math.max(16, drops.length ? drops[drops.length - 1].bar + 8 : 16);
    let b = lastFull; while (b > lastFull - 64 && b >= earliest && bass[b] < medBass * 0.7) b--;
    if (lastFull - b >= 8 && b + 1 >= earliest) outro = b + 1;
    else {
      // Or: the last phrase boundary (after the last drop) where the level steps down and stays down.
      for (let c = lastFull - 8; c > lastFull - 48 && c >= earliest; c--) if (isPhrase(c) && avg(lv, c - 8, c) - avg(lv, c, lastFull) > 0.15) { outro = c; break; }
    }
  }
  if (outro !== null) add("outro", bt(outro), capped(0.6 + clamp01(avg(lv, outro - 8, outro) - avg(lv, outro, lastFull)) * 0.5), "Lower bass/level to the end (bar analysis)", est);
  else miss("outro", "No distinct closing section found");

  // ── Mix regions ──
  const sec = (b: number) => bt(b);
  const fbT = firstBeat ?? intro ?? 0;
  const vocalStart = input.vocals?.find(([s, e]) => e - s >= 2)?.[0] ?? null;
  const introEnd = Math.min(drop ?? nb, breakdown ?? nb, firstPhrase + 16);
  if (introEnd > fb) mixIn.push({ kind: "in", label: "Intro", start: fbT, end: sec(introEnd), rationale: drop !== null && introEnd === drop ? "From the first beat to the first drop" : "From the first beat through the opening phrases", confidence: capped(0.7), phraseAligned: isPhrase(fb) || firstPhrase === fb, availableSeconds: round2(sec(introEnd) - fbT) });
  if (vocalStart !== null && vocalStart - fbT >= 8 * bl) mixIn.push({ kind: "in", label: "Instrumental intro", start: fbT, end: vocalStart, rationale: "No vocals until the vocal entry (STEMS)", confidence: 0.75, phraseAligned: true, availableSeconds: round2(vocalStart - fbT) });
  const buildCue = cues.find((c) => c.cueType === "build");
  if (buildCue && drop !== null) mixIn.push({ kind: "in", label: "Pre-drop", start: buildCue.detectedPosition, end: sec(drop), rationale: "Start the incoming build so its drop lands as the outgoing track leaves", confidence: buildCue.confidence, phraseAligned: true, availableSeconds: round2(sec(drop) - buildCue.detectedPosition) });
  if (outro !== null && mixOutBar > outro) mixOut.push({ kind: "out", label: "Outro", start: sec(outro), end: sec(mixOutBar), rationale: "Closing section with reduced bass — room to bring the next track in", confidence: capped(0.7), phraseAligned: isPhrase(outro), availableSeconds: round2(sec(mixOutBar) - sec(outro)) });
  if (mixOutBar - 16 > fb) { const s = mixOutBar - 16; mixOut.push({ kind: "out", label: "Final phrase", start: sec(s), end: sec(mixOutBar), rationale: "Last 16 bars before the music ends", confidence: capped(0.65), phraseAligned: isPhrase(s), availableSeconds: round2(16 * bl) }); }
  const lateBreakdown = [...breakdowns].reverse().find((b) => b > nb / 2) ?? null;
  if (lateBreakdown !== null) mixOut.push({ kind: "out", label: "Breakdown", start: sec(lateBreakdown), end: sec(Math.min(nb, lateBreakdown + 8)), rationale: "Lower-energy section — exit before the track rebuilds", confidence: capped(0.6), phraseAligned: isPhrase(lateBreakdown), availableSeconds: round2(8 * bl) });
  const lastVocal = input.vocals?.length ? input.vocals[input.vocals.length - 1][1] : null;
  if (lastVocal !== null && sec(mixOutBar) - lastVocal >= 8 * bl) mixOut.push({ kind: "out", label: "After the last vocal", start: lastVocal, end: sec(mixOutBar), rationale: "Instrumental from the last vocal phrase to the end (STEMS)", confidence: 0.75, phraseAligned: false, availableSeconds: round2(sec(mixOutBar) - lastVocal) });
  return { cues, unavailable, mixIn, mixOut, gridReliable: true };
}

let seq = 0;
const cueId = () => `gc_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/**
 * Builds a suggestion set from a detection, keeping the user's decisions from the previous set:
 * accepted/modified cues of a type are kept as they are; a rejected suggestion stays rejected when the
 * new detection lands within 2 s of it. The replaced set is kept as `previous` (Restore Previous).
 */
export function buildSuggestionSet(det: CueDetection, grid: CueGrid | null, mode: QuantiseMode, analysisVersion: number | null, prior: CueSuggestionSet | undefined, now = Date.now()): CueSuggestionSet {
  const cues: GeneratedCue[] = [];
  const kept = prior?.cues.filter((c) => c.reviewStatus === "accepted" || c.reviewStatus === "modified") ?? [];
  cues.push(...kept);
  for (const c of det.cues) {
    const same = (p: { cueType: CueType; occurrence?: number }) => p.cueType === c.cueType && (p.occurrence ?? 1) === (c.occurrence ?? 1);
    if (kept.some(same)) continue;
    const q = quantise(c.detectedPosition, grid, mode);
    const was = prior?.cues.find((p) => same(p) && p.reviewStatus === "rejected" && Math.abs(p.detectedPosition - c.detectedPosition) < 2);
    cues.push({ ...c, id: was?.id ?? cueId(), quantisedPosition: q.t, note: [c.note, q.note].filter(Boolean).join(" · ") || undefined, analysisVersion, reviewStatus: was ? "rejected" : "suggested", slot: null, createdAt: was?.createdAt ?? now, updatedAt: now });
  }
  const order = CUE_TYPES.map((c) => c.id);
  cues.sort((a, b) => a.quantisedPosition - b.quantisedPosition || order.indexOf(a.cueType) - order.indexOf(b.cueType));
  const prev = prior ? (({ previous: _p, ...rest }) => rest)(prior) : undefined;
  return { version: AUTOCUE_VERSION, analysisVersion, generatedAt: now, quantise: mode, cues, unavailable: det.unavailable, mixIn: det.mixIn, mixOut: det.mixOut, ...(prior?.padBackup ? { padBackup: prior.padBackup } : {}), ...(prev ? { previous: prev } : {}) };
}

/** Re-quantise the not-yet-decided suggestions with a different mode (decisions are left alone). */
export function requantise(set: CueSuggestionSet, grid: CueGrid | null, mode: QuantiseMode): CueSuggestionSet {
  return { ...set, quantise: mode, cues: set.cues.map((c) => (c.reviewStatus === "suggested" || c.reviewStatus === "rejected" ? (() => { const q = quantise(c.detectedPosition, grid, mode); return { ...c, quantisedPosition: q.t, note: q.note }; })() : c)) };
}

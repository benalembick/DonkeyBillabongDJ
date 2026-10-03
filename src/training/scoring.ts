/**
 * Lesson scoring from recorded playback and control data (never random, never "listening").
 *
 * Each metric says what was measured and how it was scored. Metrics whose data doesn't exist
 * (no beat grid, unknown keys) are marked unavailable and excluded from the total; not doing
 * the task (e.g. never cutting Track A) scores 0 instead.
 *
 * Timing: deck positions are on the audio clock, and both decks pass through the same output
 * latency, so musical alignment (B's entry against A's beats) is measured directly. Taps are
 * reactions to what was *heard*, so they're corrected by the output latency.
 */
import type { LessonId } from "./curriculum";
import { aPositionAtBEntry, beatLen, median, nearestBar, nearestPhrase, type Exercise, type Sample, type TrainingEvent } from "./measure";
import { BEATS_PER_BAR, GRID_CONFIDENT, keyRelation, type Grid } from "../transitions/planner";

export interface Metric {
  id: string;
  label: string;
  /** 0–100, or null = unavailable (excluded from the total). */
  score: number | null;
  /** What was measured, e.g. "0.04 BPM apart". */
  value: string;
  /** How the score was calculated. */
  how: string;
  weight: number;
  note?: string;
}

export interface LessonResult {
  lesson: LessonId;
  date: number;
  total: number | null;
  metrics: Metric[];
  strengths: string[];
  improvements: string[];
}

export interface AttemptData {
  lesson: LessonId;
  samples: Sample[];
  events: TrainingEvent[];
  ex: Exercise;
  /** Harmonic lesson: the chosen pair's keys. */
  keys?: { a: string | null; b: string | null; uncertain: boolean };
}

/** 100 at ≤ good, 0 at ≥ bad, linear between. */
export const lin = (x: number, good: number, bad: number) => Math.round(Math.max(0, Math.min(100, ((bad - x) / (bad - good)) * 100)));
const r1 = (x: number) => Math.round(x * 10) / 10;

const both = (s: Sample) => s.a.playing && s.b.playing;
const audibleBoth = (s: Sample) => both(s) && s.a.volume > 0.15 && s.b.volume > 0.15;

function gridNote(g: Grid | null, name: string): string | undefined {
  if (!g) return undefined;
  return !g.manual && g.confidence < GRID_CONFIDENT ? `${name}'s beat grid is uncertain (confidence ${g.confidence.toFixed(1)}) — timing scores may be off; correct the grid if the beats look wrong.` : undefined;
}

// ─────────────────────────── shared measurements ───────────────────────────

/** Exact A position when B entered (from the first sample after B's start), or null. */
function entry(d: AttemptData): { aPos: number; t: number } | null {
  const ev = d.events.find((e) => e.kind === "bStart");
  if (!ev) return null;
  const s = d.samples.find((x) => x.t >= ev.t && x.b.playing);
  return { aPos: s ? aPositionAtBEntry(s, d.ex.bCue) : ev.aPos, t: ev.t };
}

/** First moment after `from` (wall s) when A's audible level drops below 0.08 and stays there 1 s. */
function aOut(d: AttemptData, from: number): Sample | null {
  for (let i = 0; i < d.samples.length; i++) {
    const s = d.samples[i];
    if (s.t < from || s.a.volume >= 0.08) continue;
    const later = d.samples.filter((x) => x.t > s.t && x.t < s.t + 1);
    if (later.every((x) => x.a.volume < 0.08)) return s;
  }
  return null;
}

function entryMetric(d: AttemptData, target: "phrase" | "bar", weight: number): { metric: Metric; errorBeats: number | null } {
  const g = d.ex.aGrid;
  const e = entry(d);
  if (!g) return { metric: { id: "entry", label: "Entry timing", score: null, value: "—", how: "Needs Track A's beat grid.", weight }, errorBeats: null };
  if (!e) return { metric: { id: "entry", label: "Entry timing", score: 0, value: "Track B wasn't started", how: "Track B must be started during the attempt.", weight }, errorBeats: null };
  const n = target === "phrase" ? nearestPhrase(g, e.aPos, d.ex.aPhraseOffset) : nearestBar(g, e.aPos);
  const ms = n.errorBeats * beatLen(g) * 1000;
  const score = lin(Math.abs(n.errorBeats), 0.05, 2);
  return {
    metric: {
      id: "entry",
      label: target === "phrase" ? "Entry on the phrase" : "Entry on the beat",
      score,
      value: Math.abs(n.errorBeats) < 0.5 ? `${Math.abs(Math.round(ms))} ms ${ms >= 0 ? "late" : "early"}` : `${Math.abs(r1(n.errorBeats))} beats ${n.errorBeats > 0 ? "after" : "before"} the ${target}`,
      how: `Where Track A was when Track B's playhead left its cue, against the nearest ${target === "phrase" ? "phrase start (8 bars, from the phrase marker)" : "bar"}: 100 within 0.05 beat, 0 at 2 beats off.`,
      weight,
      note: gridNote(g, "Track A"),
    },
    errorBeats: n.errorBeats,
  };
}

function alignmentMetrics(samples: Sample[], ex: Exercise, weight: number, stabilityWeight: number, label = "Beat alignment"): Metric[] {
  const ph = samples.filter((s) => s.phaseMs !== null && both(s)).map((s) => Math.abs(s.phaseMs!));
  if (!ex.aGrid || !ex.bGrid) return [{ id: "align", label, score: null, value: "—", how: "Needs beat grids for both tracks.", weight }];
  if (ph.length < 5) return [{ id: "align", label, score: 0, value: "Tracks never played together", how: "Measured while both decks play.", weight }];
  const med = median(ph);
  const within = ph.filter((x) => x <= 25).length / ph.length;
  const note = gridNote(ex.aGrid, "Track A") ?? gridNote(ex.bGrid, "Track B");
  return [
    { id: "align", label, score: lin(med, 8, 80), value: `${Math.round(med)} ms apart (median)`, how: "Median beat-phase difference between the decks (from both beat grids and positions): 100 at ≤ 8 ms, 0 at ≥ 80 ms.", weight, note },
    { id: "stability", label: "Alignment stability", score: Math.round(within * 100), value: `${Math.round(within * 100)}% of the time within 25 ms`, how: "Share of measurements with the beats within 25 ms of each other.", weight: stabilityWeight, note },
  ];
}

function completionMetric(d: AttemptData, e: { aPos: number; t: number } | null, targetBars: number, weight: number): { metric: Metric; out: Sample | null } {
  const g = d.ex.aGrid;
  if (!e) return { metric: { id: "complete", label: "Transition completed", score: 0, value: "Track B never came in", how: "Track B in, then Track A faded out.", weight }, out: null };
  const out = aOut(d, e.t + 0.5);
  if (!out) return { metric: { id: "complete", label: "Transition completed", score: 0, value: "Track A was still playing", how: `Track A's fader (or crossfader side) down within ${targetBars} bars of B's entry.`, weight }, out: null };
  const bars = g ? (out.a.pos - e.aPos) / (beatLen(g) * BEATS_PER_BAR) : null;
  return {
    metric: {
      id: "complete",
      label: "Transition completed",
      score: bars === null ? 100 : bars <= targetBars + 0.5 ? 100 : lin(bars - targetBars, 0.5, targetBars * 1.5),
      value: bars === null ? "Track A out" : `Track A out after ${r1(bars)} bars`,
      how: `100 if Track A is out within ${targetBars} bars of B's entry, falling to 0 at ${Math.round(targetBars * 2.5)} bars.`,
      weight,
    },
    out,
  };
}

/** Beats both basses were up, and beats with no bass at all, while both tracks were audible. */
function bassMetrics(d: AttemptData, from: number, to: number, weight: number): Metric[] {
  const g = d.ex.aGrid;
  const win = d.samples.filter((s) => s.t >= from && s.t <= to && audibleBoth(s));
  if (!g || win.length < 3) return [{ id: "bassOverlap", label: "Bass overlap", score: null, value: "—", how: "Needs an overlap and Track A's grid.", weight }];
  let overlap = 0;
  let gap = 0;
  for (let i = 1; i < win.length; i++) {
    const dt = win[i].t - win[i - 1].t;
    if (dt > 0.5) continue;
    const s = win[i];
    // 0.5 = 12 o'clock (unity): "up" means at least 40%, "cut" at most 15%.
    if (s.a.eqLow >= 0.4 && s.b.eqLow >= 0.4) overlap += dt * s.a.rate;
    if (s.a.eqLow <= 0.15 && s.b.eqLow <= 0.15) gap += dt * s.a.rate;
  }
  const ob = overlap / beatLen(g);
  const gb = gap / beatLen(g);
  return [
    { id: "bassOverlap", label: "Bass overlap", score: lin(ob, 2, 16), value: `${r1(ob)} beats with both basses up`, how: "Beats where both LOW EQs were up (≥ 40%; 12 o'clock = 50%) while both tracks were audible: 100 up to 2 beats (the swap itself), 0 at 16 beats.", weight },
    { id: "bassGap", label: "Bass gap", score: lin(gb, 1, 8), value: `${r1(gb)} beats with no bass`, how: "Beats where both LOW EQs were nearly off (≤ 15%) while both tracks were audible: 100 up to 1 beat, 0 at 8 beats.", weight: weight * 0.6 },
  ];
}

// ─────────────────────────── per lesson ───────────────────────────

export function scoreAttempt(d: AttemptData): LessonResult {
  const metrics: Metric[] = [];
  const g = d.ex.aGrid;
  switch (d.lesson) {
    case "beatmatch": {
      const done = d.events.find((e) => e.kind === "done")?.t ?? d.samples.at(-1)?.t ?? 0;
      const win = d.samples.filter((s) => both(s) && s.t >= done - 20 && s.t <= done);
      const diffs = win.filter((s) => s.a.bpm !== null && s.b.bpm !== null).map((s) => Math.abs(s.a.bpm! - s.b.bpm!));
      metrics.push(
        diffs.length
          ? { id: "tempo", label: "Tempo match", score: lin(median(diffs), 0.03, 1), value: `${median(diffs).toFixed(2)} BPM apart`, how: "Median BPM difference over the last 20 s (grid BPM × playback rate): 100 at ≤ 0.03 BPM, 0 at ≥ 1 BPM.", weight: 1.2 }
          : { id: "tempo", label: "Tempo match", score: 0, value: "Tracks never played together", how: "Measured while both decks play.", weight: 1.2 },
      );
      metrics.push(...alignmentMetrics(win, d.ex, 1.2, 1));
      const bStart = d.events.find((e) => e.kind === "bStart");
      const lockedAt = bStart ? d.samples.find((s) => s.t > bStart.t && both(s) && s.phaseMs !== null && Math.abs(s.phaseMs) < 25 && s.a.bpm !== null && s.b.bpm !== null && Math.abs(s.a.bpm - s.b.bpm) < 0.1) : undefined;
      metrics.push(bStart && lockedAt ? { id: "speed", label: "Time to lock in", score: lin(lockedAt.t - bStart.t, 15, 60), value: `${Math.round(lockedAt.t - bStart.t)} s`, how: "From starting Track B until within 0.1 BPM and 25 ms: 100 up to 15 s, 0 at 60 s.", weight: 0.4 } : { id: "speed", label: "Time to lock in", score: bStart ? 0 : null, value: bStart ? "Never within 0.1 BPM and 25 ms" : "—", how: "From starting Track B until within 0.1 BPM and 25 ms.", weight: 0.4 });
      break;
    }
    case "phrase":
    case "harmonic": {
      if (d.lesson === "phrase") {
        const taps = d.events.filter((e) => e.kind === "tap");
        if (!g) metrics.push({ id: "phraseId", label: "Phrase recognition", score: null, value: "—", how: "Needs Track A's beat grid.", weight: 1 });
        else {
          const lat = d.ex.latencyMs / 1000;
          // Taps react to what was heard: compare with the position that was audible then.
          const hits = taps.filter((tp) => Math.abs(nearestPhrase(g, tp.aPos - lat, d.ex.aPhraseOffset).errorBeats) <= 1).length;
          const misses = taps.length - hits;
          metrics.push({ id: "phraseId", label: "Phrase recognition", score: taps.length ? Math.max(0, Math.round((Math.min(hits, 2) / 2) * 100 - misses * 25)) : 0, value: taps.length ? `${hits} of ${taps.length} taps on a phrase start` : "No phrase starts tapped", how: `Taps within 1 beat of a phrase start (8 bars, from the phrase marker), using the position you heard (output latency ${Math.round(d.ex.latencyMs)} ms corrected). Two good taps = 100; −25 per tap on a non-phrase bar.`, weight: 1 });
        }
      } else {
        const k = d.keys;
        const rel = k ? keyRelation(k.a, k.b) : null;
        metrics.push(
          rel
            ? { id: "key", label: "Key choice", score: rel.compatible ? (/same key/.test(rel.label) ? 100 : 92) : 25, value: rel.label, how: "Camelot compatibility of the chosen pair: same key 100, adjacent or relative major/minor 92, other keys 25.", weight: 1.3, note: k?.uncertain ? "At least one key was detected with low confidence — the real keys may differ." : undefined }
            : { id: "key", label: "Key choice", score: null, value: "Key unknown", how: "Needs a detected key for both tracks.", weight: 1.3 },
        );
      }
      const en = entryMetric(d, "phrase", 1.2);
      metrics.push(en.metric);
      const e = entry(d);
      const c = completionMetric(d, e, 16, 0.8);
      metrics.push(...alignmentMetrics(d.samples.filter((s) => e && s.t >= e.t && (!c.out || s.t <= c.out.t)), d.ex, 0.5, 0.3));
      metrics.push(c.metric);
      break;
    }
    case "bassswap":
    case "longblend": {
      const en = entryMetric(d, "phrase", d.lesson === "bassswap" ? 0.6 : 0.5);
      metrics.push(en.metric);
      const e = entry(d);
      const target = d.lesson === "bassswap" ? 16 : 32;
      const c = completionMetric(d, e, target, 0.7);
      const end = c.out?.t ?? d.samples.at(-1)?.t ?? 0;
      if (d.lesson === "bassswap") {
        const atEntry = e ? d.samples.find((s) => s.t >= e.t) : null;
        metrics.push(atEntry ? { id: "precut", label: "Bass cut before entry", score: lin(atEntry.b.eqLow, 0.15, 0.5), value: `Track B's LOW at ${Math.round(atEntry.b.eqLow * 100)}%`, how: "Track B's LOW EQ when it started: 100 at ≤ 15%, 0 at ≥ 50% (12 o'clock).", weight: 0.6 } : { id: "precut", label: "Bass cut before entry", score: 0, value: "Track B wasn't started", how: "Track B's LOW EQ when it started.", weight: 0.6 });
        // Swap moment: B's bass takes over (B LOW passes A LOW, above 40%).
        const swap = e ? d.samples.find((s) => s.t > e.t && s.b.eqLow > 0.4 && s.b.eqLow > s.a.eqLow) : undefined;
        if (!g || !e) metrics.push({ id: "swapTime", label: "Swap timing", score: null, value: "—", how: "Needs Track A's grid and B's entry.", weight: 1 });
        else if (!swap) metrics.push({ id: "swapTime", label: "Swap timing", score: 0, value: "The bass was never swapped", how: "When Track B's LOW passes Track A's.", weight: 1 });
        else {
          const errBeats = (swap.a.pos - (e.aPos + 8 * BEATS_PER_BAR * beatLen(g))) / beatLen(g);
          metrics.push({ id: "swapTime", label: "Swap timing", score: lin(Math.abs(errBeats), 1, 8), value: Math.abs(errBeats) < 1 ? "On bar 9" : `${Math.abs(r1(errBeats))} beats ${errBeats > 0 ? "after" : "before"} bar 9`, how: "When Track B's LOW passed Track A's (above 40%), against bar 9 of the blend: 100 within 1 beat, 0 at 8 beats.", weight: 1 });
        }
        metrics.push(...bassMetrics(d, e?.t ?? 0, end, 1));
        metrics.push(...alignmentMetrics(d.samples.filter((s) => e && s.t >= e.t && s.t <= end), d.ex, 0.4, 0.2));
      } else {
        const win = d.samples.filter((s) => e && s.t >= e.t && s.t <= end && audibleBoth(s));
        const overlapBars = g && e && win.length ? ((win.at(-1)!.a.pos - win[0].a.pos) / (beatLen(g) * BEATS_PER_BAR)) : 0;
        metrics.push(g ? { id: "length", label: "Overlap length", score: Math.min(100, Math.round((overlapBars / 32) * 100)), value: `${r1(overlapBars)} bars together`, how: "Bars with both tracks audible: 32 bars = 100.", weight: 1 } : { id: "length", label: "Overlap length", score: null, value: "—", how: "Needs Track A's grid.", weight: 1 });
        metrics.push(...alignmentMetrics(win, d.ex, 1.3, 0.9, "Alignment through the blend"));
        metrics.push(...bassMetrics(d, e?.t ?? 0, end, 0.8));
        if (win.length > 5) {
          const levels = win.map((s) => s.a.volume + s.b.volume);
          const steady = levels.filter((x) => x >= 0.7 && x <= 1.6).length / levels.length;
          const jumps = levels.slice(1).filter((x, i) => Math.abs(x - levels[i]) > 0.5).length;
          metrics.push({ id: "continuity", label: "Level continuity", score: Math.max(0, Math.round(steady * 100) - jumps * 10), value: `${Math.round(steady * 100)}% steady, ${jumps} sudden jump${jumps === 1 ? "" : "s"}`, how: "Combined fader level (A + B, with the crossfader) kept between 0.7 and 1.6 of one track; −10 per jump of more than half a fader at once. Uses fader positions, not measured loudness.", weight: 0.8 });
        } else metrics.push({ id: "continuity", label: "Level continuity", score: 0, value: "No overlap", how: "Combined fader level during the overlap.", weight: 0.8 });
      }
      metrics.push(c.metric);
      break;
    }
    case "quickcut":
    case "effects": {
      const target = d.lesson === "quickcut" ? d.ex.cutOn : "phrase";
      const en = entryMetric(d, target, 1.2);
      metrics.push(en.metric);
      const e = entry(d);
      // A's cut: the first sample where A's level falls under 0.1 from audible, near B's entry.
      const cutIdx = d.samples.findIndex((s, i) => i > 0 && d.samples[i - 1].a.volume >= 0.3 && s.a.volume < 0.1 && (!e || Math.abs(s.t - e.t) < 6));
      const cut = cutIdx >= 0 ? d.samples[cutIdx] : null;
      const boundary = g && (e || cut) ? (target === "bar" ? nearestBar(g, e?.aPos ?? cut!.a.pos) : nearestPhrase(g, e?.aPos ?? cut!.a.pos, d.ex.aPhraseOffset)).time : null;
      if (!g) metrics.push({ id: "cut", label: "Track A cut timing", score: null, value: "—", how: "Needs Track A's beat grid.", weight: 1 });
      else if (!cut || boundary === null) metrics.push({ id: "cut", label: "Track A cut timing", score: 0, value: "Track A wasn't cut", how: "Track A's audible level dropping from ≥ 30% to under 10%.", weight: 1 });
      else {
        const ms = ((cut.a.pos - boundary) / cut.a.rate) * 1000;
        metrics.push({ id: "cut", label: "Track A cut timing", score: lin(Math.abs(ms), 30, 300), value: `${Math.abs(Math.round(ms))} ms ${ms >= 0 ? "after" : "before"} the ${target}`, how: `When Track A's audible level (fader × crossfader) dropped under 10%, against the ${target} boundary: 100 within 30 ms, 0 at 300 ms. Sampled every 15 ms.`, weight: 1, note: gridNote(g, "Track A") });
      }
      if (d.lesson === "quickcut") {
        const bRise = e ? d.samples.find((s) => s.t >= e.t - 2 && s.b.playing && s.b.volume > 0.5) : null;
        if (cut && bRise) {
          const gapMs = Math.abs(bRise.t - cut.t) * 1000;
          metrics.push({ id: "clean", label: "Clean switch", score: lin(gapMs, 40, 400), value: `A out and B in ${Math.round(gapMs)} ms apart`, how: "Time between Track A dropping under 10% and Track B rising above 50%: 100 within 40 ms (a clean cut), 0 at 400 ms (gap or overlap).", weight: 1 });
        } else metrics.push({ id: "clean", label: "Clean switch", score: 0, value: "Incomplete cut", how: "Track A down and Track B up at the same moment.", weight: 1 });
      } else {
        const on = d.samples.find((s) => s.fx.some((f) => f.echoOn && f.onA));
        if (!g || boundary === null) metrics.push({ id: "fxOn", label: "Echo timing", score: null, value: "—", how: "Needs Track A's grid and a cut.", weight: 1 });
        else if (!on) metrics.push({ id: "fxOn", label: "Echo timing", score: 0, value: "ECHO on Track A was never switched on", how: "An ECHO slot on, on a unit assigned to Track A's deck.", weight: 1 });
        else {
          const errBeats = (on.a.pos - (boundary - beatLen(g))) / beatLen(g);
          metrics.push({ id: "fxOn", label: "Echo timing", score: lin(Math.abs(errBeats), 0.25, 2), value: `${Math.abs(r1(errBeats))} beats ${errBeats >= 0 ? "after" : "before"} beat 4`, how: "When ECHO (assigned to Track A) came on, against beat 4 of the bar before the boundary: 100 within ¼ beat, 0 at 2 beats.", weight: 1 });
          const off = d.samples.find((s) => s.t > on.t && !s.fx.some((f) => f.echoOn && f.onA));
          if (cut) {
            const tailBars = ((off ?? d.samples.at(-1)!).a.pos - cut.a.pos) / (beatLen(g) * BEATS_PER_BAR);
            metrics.push({ id: "tail", label: "Echo tail length", score: off ? lin(Math.abs(tailBars - 4), 0.5, 4) : 30, value: off ? `${r1(tailBars)} bars (target 4)` : "ECHO left on", how: "Bars from cutting Track A to switching ECHO off: 100 within ½ bar of 4 bars, 0 at 4 bars off.", weight: 0.8 });
          }
          const mixes = d.samples.filter((s) => s.fx.some((f) => f.echoOn && f.onA)).map((s) => s.fx.find((f) => f.echoOn && f.onA)!.mix);
          const m = median(mixes);
          const dist = m < 0.45 ? 0.45 - m : m > 0.75 ? m - 0.75 : 0;
          metrics.push({ id: "intensity", label: "Effect level", score: lin(dist, 0, 0.3), value: `${Math.round(m * 100)}% wet (target 45–75%)`, how: "Median FX level while ECHO was on: 100 inside 45–75%, falling to 0 at 30 points outside. Uses the FX knob setting, not measured loudness.", weight: 0.6 });
        }
      }
      break;
    }
  }
  const avail = metrics.filter((m) => m.score !== null);
  const wsum = avail.reduce((s, m) => s + m.weight, 0);
  const total = avail.length ? Math.round(avail.reduce((s, m) => s + m.score! * m.weight, 0) / wsum) : null;
  const strengths: string[] = [];
  const improvements: string[] = [];
  for (const m of avail) {
    if (m.score! >= 85) strengths.push(`${m.label}: ${m.value}.`);
    else if (m.score! < 60) improvements.push(advice(m));
  }
  return { lesson: d.lesson, date: Date.now(), total, metrics, strengths, improvements };
}

function advice(m: Metric): string {
  switch (m.id) {
    case "tempo": return `Tempo was ${m.value}. Listen for slow drift: if B creeps ahead, lower its tempo a touch; if it falls behind, raise it — then wait a few bars before the next change.`;
    case "align": return `Beats were ${m.value}. Use short jog nudges as soon as you hear flamming kicks — small and early beats big and late.`;
    case "stability": return `Alignment held only ${m.value}. After each nudge, check the tempo: repeated drift in one direction means the tempo isn't matched yet.`;
    case "speed": return "Get to the match faster: set the tempo first (watch for drift over 2 bars), then nudge the phase.";
    case "entry": return `Track B came in ${m.value}. Count the bars of the phrase out loud and press PLAY on the “1”.`;
    case "phraseId": return `${m.value}. Phrases are 8 bars — count 1–8 and tap on the 1 when something new starts, not on every bar.`;
    case "key": return `${m.value} is not a compatible move. Stay on the same Camelot number, move one step (±1), or switch letter on the same number.`;
    case "complete": return `${m.value}. Finish the transition: bring Track A's fader (or crossfader side) all the way down.`;
    case "precut": return `${m.value} when it started. Turn Track B's LOW fully down before it comes in.`;
    case "swapTime": return `The bass swap was ${m.value}. Count to bar 9 of the blend and swap on its first beat.`;
    case "bassOverlap": return `${m.value}. Reduce outgoing bass as you introduce incoming bass — in one move, within a bar.`;
    case "bassGap": return `${m.value}. Don't kill Track A's bass before Track B's comes up — make it one crossing move.`;
    case "length": return `${m.value}. Keep both tracks running together longer — aim for 32 bars before Track A goes.`;
    case "continuity": return `Levels: ${m.value}. Move the faders gradually and in opposite directions to keep the overall level steady.`;
    case "cut": return `Track A was cut ${m.value}. Cut on the downbeat — move the fader (or crossfader) in one fast motion.`;
    case "clean": return `${m.value}. Start B and cut A in the same instant — or use the crossfader so one move does both.`;
    case "fxOn": return `Echo came on ${m.value}. Switch it on on beat 4 of the bar before the boundary.`;
    case "tail": return `Echo tail: ${m.value}. Switch the effect off after about 4 bars.`;
    case "intensity": return `Effect level was ${m.value}. Set the FX level between 50 and 70% before you start.`;
    default: return `${m.label}: ${m.value}.`;
  }
}

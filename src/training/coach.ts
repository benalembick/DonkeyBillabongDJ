/**
 * Live coaching: which guided step is satisfied, what to highlight and what to say, from the
 * latest samples (engine state) — never from listening to the audio.
 */
import type { AssistId, LessonId } from "./curriculum";
import { aPositionAtBEntry, beatLen, nearestPhrase, nextPhrase, nearestBar, type Exercise, type Sample, type TrainingEvent } from "./measure";
import { BEATS_PER_BAR } from "../transitions/planner";

export interface CoachCtx {
  lesson: LessonId;
  s: Sample;
  /** Recent samples (oldest first) — more than 8 bars of Track A. */
  recent: Sample[];
  events: TrainingEvent[];
  ex: Exercise;
  assists: Set<AssistId>;
  /** The engine's tempo fader direction setting. */
  tempoDownIsFaster: boolean;
  /** An FX unit is assigned to Track A's deck with an ECHO slot. */
  echoReadyOnA: boolean;
  /** Set when no DJ controller is connected: keys bound to Track B's jog ring (null = unbound). */
  keyboard?: { nudgeBack: string | null; nudgeForward: string | null } | null;
}

const both = (s: Sample) => s.a.playing && s.b.playing;
const audibleBoth = (s: Sample) => both(s) && s.a.volume > 0.15 && s.b.volume > 0.15;
/** Condition held for the last `secs` seconds of samples. */
const held = (ctx: CoachCtx, secs: number, f: (s: Sample) => boolean) => {
  const since = ctx.s.t - secs;
  const win = ctx.recent.filter((x) => x.t >= since);
  return win.length > 2 && win[0].t <= since + 0.25 && win.every(f);
};
const bStart = (ctx: CoachCtx) => ctx.events.find((e) => e.kind === "bStart");
const entryAPos = (ctx: CoachCtx) => {
  const ev = bStart(ctx);
  if (!ev) return null;
  const first = ctx.recent.find((x) => x.t >= ev.t && x.b.playing);
  return first ? aPositionAtBEntry(first, ctx.ex.bCue) : ev.aPos;
};
const aOutSince = (ctx: CoachCtx) => { const ev = bStart(ctx); return !!ev && ctx.s.t > ev.t + 1 && held(ctx, 1, (x) => x.a.volume < 0.08); };
/** A phrase tap counts when it's within this many beats of a phrase start (heard position). */
const TAP_WINDOW_BEATS = 1;

/** Verdict on a "Phrase!" tap made at Track A position `aPos` (corrected for output latency). */
export function judgeTap(ex: Exercise, aPos: number): { hit: boolean; text: string } | null {
  const g = ex.aGrid;
  if (!g) return null;
  const err = nearestPhrase(g, aPos - ex.latencyMs / 1000, ex.aPhraseOffset).errorBeats;
  const late = err > 0;
  if (Math.abs(err) <= TAP_WINDOW_BEATS) {
    const ms = Math.round(Math.abs(err) * beatLen(g) * 1000);
    return { hit: true, text: ms <= 40 ? "On the phrase" : `On the phrase (${ms} ms ${late ? "late" : "early"})` };
  }
  const bars = Math.round(Math.abs(err) / BEATS_PER_BAR);
  const off = bars >= 1 ? `${bars} bar${bars > 1 ? "s" : ""}` : `${Math.round(Math.abs(err))} beats`;
  return { hit: false, text: `${off} ${late ? "after" : "before"} a phrase start — phrases are 8 bars; tap on the 1 when the counter shows bar 1` };
}

const phraseTapHits = (ctx: CoachCtx) => ctx.events.filter((e) => e.kind === "tap" && judgeTap(ctx.ex, e.aPos)?.hit).length;
const swapped = (ctx: CoachCtx) => !!bStart(ctx) && ctx.recent.some((x) => x.b.eqLow > 0.4 && x.b.eqLow > x.a.eqLow && x.a.eqLow < 0.35);
const togetherBars = (ctx: CoachCtx) => {
  const g = ctx.ex.aGrid;
  const ev = bStart(ctx);
  if (!g || !ev) return 0;
  const a0 = entryAPos(ctx) ?? ev.aPos;
  return audibleBoth(ctx.s) ? (ctx.s.a.pos - a0) / (beatLen(g) * BEATS_PER_BAR) : 0;
};

/** Is guided step `i` of the lesson done? (Steps are checked in order by the service.) */
export function stepDone(i: number, ctx: CoachCtx): boolean {
  const { s } = ctx;
  const dBpm = s.a.bpm !== null && s.b.bpm !== null ? s.b.bpm - s.a.bpm : null;
  switch (ctx.lesson) {
    case "beatmatch":
      return [
        () => s.a.playing,
        () => !!bStart(ctx),
        () => held(ctx, 3, (x) => both(x) && x.a.bpm !== null && x.b.bpm !== null && Math.abs(x.b.bpm - x.a.bpm) < 0.1),
        () => held(ctx, 4, (x) => both(x) && x.phaseMs !== null && Math.abs(x.phaseMs) < 15),
        () => !!ctx.ex.aGrid && held(ctx, 8 * BEATS_PER_BAR * beatLen(ctx.ex.aGrid) / Math.max(0.5, s.a.rate), (x) => both(x) && x.phaseMs !== null && Math.abs(x.phaseMs) < 25 && dBpm !== null && Math.abs(dBpm) < 0.1),
      ][i]?.() ?? false;
    case "phrase":
      return [() => s.a.playing, () => phraseTapHits(ctx) >= 2, () => phraseTapHits(ctx) >= 2, () => { const a = entryAPos(ctx); return a !== null && !!ctx.ex.aGrid && Math.abs(nearestPhrase(ctx.ex.aGrid, a, ctx.ex.aPhraseOffset).errorBeats) <= 0.5; }, () => aOutSince(ctx)][i]?.() ?? false;
    case "bassswap":
      return [() => s.b.eqLow <= 0.2 || !!bStart(ctx), () => s.a.playing, () => !!bStart(ctx) && s.b.volume > 0.5, () => swapped(ctx), () => aOutSince(ctx)][i]?.() ?? false;
    case "harmonic":
      return [() => true, () => s.a.playing, () => { const a = entryAPos(ctx); return a !== null && !!ctx.ex.aGrid && Math.abs(nearestPhrase(ctx.ex.aGrid, a, ctx.ex.aPhraseOffset).errorBeats) <= 0.5; }, () => aOutSince(ctx)][i]?.() ?? false;
    case "longblend":
      return [() => s.b.eqLow <= 0.2 || !!bStart(ctx), () => s.a.playing, () => !!bStart(ctx), () => togetherBars(ctx) >= 32, () => swapped(ctx), () => aOutSince(ctx)][i]?.() ?? false;
    case "quickcut":
      return [() => s.a.playing, () => true, () => !!bStart(ctx), () => !!bStart(ctx) && s.b.volume > 0.5 && s.a.volume < 0.1][i]?.() ?? false;
    case "effects":
      return [() => ctx.echoReadyOnA, () => s.a.playing, () => s.fx.some((f) => f.echoOn && f.onA), () => !!bStart(ctx) && s.a.volume < 0.1, () => !!bStart(ctx) && s.a.volume < 0.1 && !s.fx.some((f) => f.echoOn && f.onA)][i]?.() ?? false;
  }
}

/** Controls to highlight for a step (data-train ids). */
export function stepControls(lesson: LessonId, i: number): string[] {
  const m: Record<LessonId, string[][]> = {
    beatmatch: [["transport-A"], ["transport-B"], ["tempo-B"], ["jog-B"], ["jog-B", "tempo-B"]],
    phrase: [["transport-A"], [], [], ["transport-B"], ["volume-B", "volume-A", "crossfader"]],
    bassswap: [["eq-low-B"], ["transport-A"], ["transport-B", "volume-B"], ["eq-low-A", "eq-low-B"], ["volume-A"]],
    harmonic: [[], ["transport-A"], ["transport-B"], ["volume-B", "volume-A"]],
    longblend: [["eq-low-B"], ["transport-A"], ["transport-B"], ["jog-B", "volume-B", "eq-mid-A"], ["eq-low-A", "eq-low-B"], ["volume-A"]],
    quickcut: [["transport-A"], [], [], ["transport-B", "volume-A", "volume-B", "crossfader"]],
    effects: [["fx-1"], ["transport-A"], ["fx-1"], ["volume-A", "transport-B"], ["fx-1"]],
  };
  return m[lesson][i] ?? [];
}

const bars = (beats: number) => {
  const b = Math.floor(beats / BEATS_PER_BAR);
  const r = Math.ceil(beats - b * BEATS_PER_BAR);
  return `${b ? `${b} bar${b > 1 ? "s" : ""}` : ""}${b && r ? " " : ""}${r ? `${r} beat${r > 1 ? "s" : ""}` : ""}` || "now";
};

/** Contextual hints for the current moment (only shown when the Hints assist is on). */
export function hints(step: number, ctx: CoachCtx): string[] {
  const { s, ex } = ctx;
  const out: string[] = [];
  const g = ex.aGrid;
  const dBpm = s.a.bpm !== null && s.b.bpm !== null ? s.b.bpm - s.a.bpm : null;
  const slower = ctx.tempoDownIsFaster ? "up" : "down";
  const faster = ctx.tempoDownIsFaster ? "down" : "up";
  const kb = ctx.keyboard;
  const tempoHint = () => {
    if (!both(s) || dBpm === null) return;
    if (Math.abs(dBpm) >= 0.05) out.push(`Incoming track is running ${Math.abs(dBpm) < 0.5 ? "slightly " : ""}${dBpm > 0 ? "fast" : "slow"} (${dBpm > 0 ? "+" : "−"}${Math.abs(dBpm).toFixed(2)} BPM) — move Track B's tempo fader ${dBpm > 0 ? slower : faster} a little${kb ? ` (or scroll the mouse wheel ${dBpm > 0 ? slower : faster} over it for fine steps)` : ""}.`);
  };
  const phaseHint = () => {
    if (!both(s) || s.phaseMs === null || (dBpm !== null && Math.abs(dBpm) >= 0.15)) return;
    if (Math.abs(s.phaseMs) <= 15) return;
    const ms = Math.round(Math.abs(s.phaseMs));
    const ahead = s.phaseMs > 0;
    if (kb) {
      const key = ahead ? kb.nudgeBack : kb.nudgeForward;
      out.push(`Track B is ${ms} ms ${ahead ? "ahead — nudge it back" : "behind — nudge it forward"}: ${key ? `hold ${key}, or ` : ""}drag Track B's on-screen jog wheel ${ahead ? "anticlockwise" : "clockwise"} (scrolling over it works too).`);
    } else out.push(`Track B is ${ms} ms ${ahead ? "ahead — nudge it back (jog wheel anticlockwise / pitch bend −)" : "behind — nudge it forward (jog wheel clockwise / pitch bend +)"}.`);
  };
  const countIn = (label: string, target: "phrase" | "bar") => {
    if (!g || !ctx.assists.has("countIn") || !s.a.playing || bStart(ctx)) return;
    const n = target === "phrase" ? nextPhrase(g, s.a.pos, ex.aPhraseOffset) : { beatsAway: BEATS_PER_BAR - ((((s.a.pos - g.firstBeat) / beatLen(g)) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR };
    out.push(n.beatsAway > 8 ? `Wait for the next ${target} — ${bars(n.beatsAway)} to go.` : `Get ready: ${label} in ${bars(n.beatsAway)}.`);
  };
  const entryFeedback = () => {
    const a = entryAPos(ctx);
    if (a === null || !g) return;
    const n = nearestPhrase(g, a, ex.aPhraseOffset);
    const bar = nearestBar(g, a);
    if (Math.abs(n.errorBeats) > 0.5) out.push(Math.abs(bar.errorBeats) <= 0.5 ? `Track B came in on a bar, but ${Math.abs(Math.round(n.errorBeats / BEATS_PER_BAR))} bar(s) ${n.errorBeats > 0 ? "after" : "before"} the phrase start — not every bar is a phrase. Press CUE on Track B and try on the next phrase.` : "Track B came in off the beat — press CUE on Track B and try again on the next phrase.");
  };
  switch (ctx.lesson) {
    case "beatmatch":
      if (step === 0) out.push("Press PLAY on Track A to begin.");
      if (step === 1) out.push("Press PLAY on Track B right on one of Track A's kicks (beat 1 is best).");
      if (step >= 2) tempoHint();
      if (step === 2 && both(s) && dBpm !== null && Math.abs(dBpm) >= 0.15) out.push("Nudging only shifts Track B for a moment — it doesn't change its speed. Match the tempo with the fader first, then line up the beats.");
      if (step >= 3 || (dBpm !== null && Math.abs(dBpm) < 0.05)) phaseHint();
      break;
    case "phrase":
    case "harmonic":
      if (step === 0) out.push("Press PLAY on Track A.");
      if (ctx.lesson === "phrase" && step === 1 && g && s.a.playing) {
        const n = nextPhrase(g, s.a.pos, ex.aPhraseOffset);
        out.push(ctx.assists.has("phraseCounter") ? `You're in bar ${n.barInPhrase} of 8. Tap “Phrase!” on the 1 of the next phrase (${bars(n.beatsAway)} away).` : "Count the bars and tap “Phrase!” on the first beat of a new phrase.");
      }
      if (step >= 2 && !bStart(ctx)) countIn("start Track B", "phrase");
      entryFeedback();
      if (bStart(ctx) && !aOutSince(ctx)) out.push("Bring Track B's fader up and take Track A out within 16 bars.");
      break;
    case "bassswap":
    case "longblend":
      if (step === 0 && s.b.eqLow > 0.2) out.push("Cut Track B's LOW EQ (turn it fully down) before it comes in.");
      if (step <= 1 && !s.a.playing) out.push("Press PLAY on Track A.");
      if (!bStart(ctx)) countIn("start Track B", "phrase");
      entryFeedback();
      if (audibleBoth(s)) {
        if (s.a.eqLow >= 0.4 && s.b.eqLow >= 0.4) out.push("Both basses are up — reduce outgoing bass as you introduce incoming bass.");
        else if (s.a.eqLow <= 0.15 && s.b.eqLow <= 0.15) out.push("There's no bass at the moment — bring Track B's LOW up.");
        if (g && bStart(ctx)) {
          const bb = togetherBars(ctx);
          const swapAt = ctx.lesson === "bassswap" ? 8 : 16;
          if (!swapped(ctx) && bb < swapAt) out.push(`Swap the bass at bar ${swapAt + 1} of the blend — ${bars((swapAt - bb) * BEATS_PER_BAR)} to go.`);
          if (ctx.lesson === "longblend" && bb < 32) out.push(`Keep both tracks together: bar ${Math.floor(bb) + 1} of 32.`);
        }
        phaseHint();
      }
      break;
    case "quickcut":
      if (step === 0) out.push("Press PLAY on Track A. Keep Track B's fader down (or the crossfader on A).");
      if (!bStart(ctx)) countIn(`cut to Track B`, ex.cutOn);
      if (bStart(ctx) && s.a.volume > 0.3) out.push("Now cut Track A — fader down (or crossfader to B) in one fast move.");
      break;
    case "effects":
      if (step === 0) out.push(ctx.echoReadyOnA ? "Set FX1's level to 50–70%." : "Set one FX1 slot to ECHO and press FX1's deck button for Track A's deck.");
      if (step === 1 && !s.a.playing) out.push("Press PLAY on Track A.");
      if (step === 2 && g && s.a.playing) {
        const n = nextPhrase(g, s.a.pos, ex.aPhraseOffset);
        if (ctx.assists.has("countIn")) out.push(n.beatsAway > 1 ? `Switch ECHO on on beat 4 before the phrase — ${bars(n.beatsAway - 1)} to go.` : "Echo on — now!");
      }
      if (step === 3) out.push("On the phrase boundary: pull Track A's fader down and press PLAY on Track B.");
      if (step === 4) out.push("Let the echo ring for about 4 bars, then switch FX1 off.");
      break;
  }
  return out;
}

/** Bar & phrase position of Track A (the phrase counter assist). */
export function phraseCounter(ex: Exercise, s: Sample): string | null {
  const g = ex.aGrid;
  if (!g) return null;
  const n = nextPhrase(g, s.a.pos, ex.aPhraseOffset);
  const beat = Math.floor((((s.a.pos - g.firstBeat) / beatLen(g)) % BEATS_PER_BAR + BEATS_PER_BAR) % BEATS_PER_BAR) + 1;
  return `Bar ${n.barInPhrase} of 8 · beat ${beat} · next phrase in ${bars(n.beatsAway)}`;
}

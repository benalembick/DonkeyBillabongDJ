/**
 * DJ Training Curriculum: lesson content and requirements (data only — no engine access).
 * Session behaviour lives in TrainingService, live checks/hints in coach.ts, scoring in scoring.ts.
 */

export type LessonId = "beatmatch" | "phrase" | "bassswap" | "harmonic" | "longblend" | "quickcut" | "effects";
export type Level = "Beginner" | "Intermediate" | "Advanced";

/** An assist, shown as enabled/disabled in the panel. */
export type AssistId = "sync" | "bpmDisplay" | "phaseMeter" | "phraseCounter" | "hints" | "highlights" | "tempoPrematched" | "countIn";
export const ASSIST_LABELS: Record<AssistId, string> = {
  sync: "SYNC button",
  bpmDisplay: "BPM / tempo display",
  phaseMeter: "Beat-alignment meter",
  phraseCounter: "Bar & phrase counter",
  hints: "Coaching hints",
  highlights: "Control highlights",
  tempoPrematched: "Track B tempo pre-matched",
  countIn: "Count-in to the target",
};

export interface Requirements {
  /** Beat grids needed: "both", "a" (Track A only), or none. */
  grids: "both" | "a";
  /** Max BPM difference (%) for a suitable pair; null = any. */
  maxBpmGapPct: number | null;
  /** Keys needed (harmonic lesson). */
  keys: boolean;
}

export interface Lesson {
  id: LessonId;
  level: Level;
  title: string;
  summary: string;
  objective: string;
  explanation: string[];
  /** Lessons recommended first. */
  prerequisites: LessonId[];
  minutes: number;
  requirements: Requirements;
  /** Guided practice steps (checked live by coach.ts). */
  steps: string[];
  /** Assists in practice and in the assessed attempt. */
  assists: { practice: AssistId[]; assess: AssistId[] };
  /** What the assessed attempt asks for. */
  assessment: string;
  /** Controls to highlight while practising (data-train ids, deck letters substituted). */
  controls: string[];
}

const ALL_PRACTICE: AssistId[] = ["bpmDisplay", "phaseMeter", "phraseCounter", "hints", "highlights", "countIn"];

export const LESSONS: Lesson[] = [
  {
    id: "beatmatch",
    level: "Beginner",
    title: "Manual Beatmatching",
    summary: "Match Track B's tempo to Track A by ear and hand, then keep the beats aligned with nudges.",
    objective: "Get Track B to Track A's tempo and keep their beats within a few milliseconds — without SYNC.",
    explanation: [
      "Two tracks are beatmatched when they play at the same tempo (BPM) and their beats land at the same moment (phase).",
      "Use Track B's tempo fader to match the speed: if B's kicks gradually run ahead, it's too fast; if they fall behind, it's too slow.",
      "Then nudge B into place with the jog wheel (or pitch bend): a short push to catch up, a short drag to hold back. Small, early corrections work best.",
      "In this lesson Track B starts deliberately a few percent off. SYNC is locked during the assessed attempt.",
    ],
    prerequisites: [],
    minutes: 8,
    requirements: { grids: "both", maxBpmGapPct: 6, keys: false },
    steps: ["Press PLAY on Track A", "Start Track B on one of Track A's downbeats", "Match the tempo: B within 0.1 BPM of A for 3 seconds", "Align the beats with the jog wheel: within 15 ms for 4 seconds", "Hold the match for 8 bars"],
    assists: { practice: ALL_PRACTICE, assess: ["phraseCounter"] },
    assessment: "Start Track B, match it by hand and hold it locked. Press “Done — I'm matched” when you're happy (or after 75 seconds). The last 20 seconds are scored.",
    controls: ["tempo-B", "jog-B", "transport-B"],
  },
  {
    id: "phrase",
    level: "Beginner",
    title: "Phrase Mixing",
    summary: "Hear where phrases start and bring the incoming track in on a phrase boundary.",
    objective: "Tap the phrase starts you hear, then start Track B exactly on one of Track A's phrase boundaries.",
    explanation: [
      "Dance music is built from phrases — usually 8 bars (32 beats). New sounds, drops and breakdowns tend to arrive at the start of a phrase.",
      "Mixing on phrase boundaries keeps both tracks' structures lined up, so changes happen together instead of in the middle of a musical sentence.",
      "Count bars as you listen: “1-2-3-4, 2-2-3-4 …” up to 8. Every bar is a boundary, but only every 8th bar starts a phrase — the counter shows which.",
      "Phrase starts come from Track A's beat grid and phrase marker. If they don't match what you hear, correct the downbeat or phrase marker first.",
    ],
    prerequisites: ["beatmatch"],
    minutes: 7,
    requirements: { grids: "both", maxBpmGapPct: 6, keys: false },
    steps: ["Press PLAY on Track A", "Tap “Phrase!” when you hear a new phrase start (twice)", "Wait for the next phrase", "Start Track B on the phrase boundary", "Bring Track B in and Track A out within 16 bars"],
    assists: { practice: [...ALL_PRACTICE, "sync", "tempoPrematched"], assess: ["sync", "tempoPrematched", "bpmDisplay"] },
    assessment: "Tap at least two phrase starts in Track A, then start Track B on a phrase boundary and complete the mix. No count-in or phrase counter.",
    controls: ["transport-A", "transport-B", "volume-B"],
  },
  {
    id: "bassswap",
    level: "Intermediate",
    title: "Bass Swap",
    summary: "Hand the bass from one track to the other with the LOW EQs, so two basslines never clash.",
    objective: "Cut Track B's bass before it comes in, swap the bass between decks in one bar at the swap point, and finish with Track A out.",
    explanation: [
      "Two basslines playing together sound muddy and can overload the speakers. A bass swap keeps only one bass playing at a time.",
      "Bring Track B in with its LOW EQ turned down. At the swap point — the start of a bar, usually halfway through the blend — turn Track A's LOW down while turning Track B's LOW up.",
      "Do it in one bar: too slow and both basses overlap; too early or late and there's a moment with no bass at all (a ‘bass hole’).",
    ],
    prerequisites: ["beatmatch", "phrase"],
    minutes: 8,
    requirements: { grids: "both", maxBpmGapPct: 6, keys: false },
    steps: ["Turn Track B's LOW EQ fully down", "Press PLAY on Track A", "Start Track B on a phrase boundary and bring its fader up", "At bar 9 of the blend, swap the bass: A's LOW down, B's LOW up — within one bar", "Fade Track A out by bar 17"],
    assists: { practice: [...ALL_PRACTICE, "sync", "tempoPrematched"], assess: ["sync", "tempoPrematched", "bpmDisplay", "phraseCounter"] },
    assessment: "Perform a 16-bar blend with a bass swap at bar 9. Scored on bass overlap, bass gaps, swap timing and completion.",
    controls: ["eq-low-A", "eq-low-B", "volume-B", "volume-A"],
  },
  {
    id: "harmonic",
    level: "Intermediate",
    title: "Harmonic Mixing",
    summary: "Choose an incoming track whose key works with the outgoing one, then blend them.",
    objective: "Pick a harmonically compatible Track B from the choices, then blend it in on a phrase.",
    explanation: [
      "Keys that are compatible share most of their notes, so blends sound musical instead of sour. The Camelot wheel makes this easy: each key has a number (1–12) and a letter (A = minor, B = major).",
      "Compatible moves: the same key (8A → 8A), one step around the wheel (8A → 7A or 9A), or the relative major/minor (8A → 8B). Bigger jumps tend to clash during an overlap.",
      "Key detection isn't perfect. When a key's analysis confidence is low it's marked “uncertain” — trust your ears too.",
    ],
    prerequisites: ["phrase"],
    minutes: 7,
    requirements: { grids: "both", maxBpmGapPct: 6, keys: true },
    steps: ["Choose a compatible Track B from the candidates", "Press PLAY on Track A", "Start Track B on a phrase boundary", "Blend Track B in and Track A out within 16 bars"],
    assists: { practice: [...ALL_PRACTICE, "sync", "tempoPrematched"], assess: ["sync", "tempoPrematched", "bpmDisplay", "phraseCounter"] },
    assessment: "Choose Track B yourself (keys are shown, compatibility isn't), then complete a phrase-aligned blend.",
    controls: ["transport-B", "volume-B"],
  },
  {
    id: "longblend",
    level: "Advanced",
    title: "Long Blend",
    summary: "Keep two tracks aligned and balanced through an extended, 32-bar transition.",
    objective: "Run both tracks together for at least 32 bars with steady beat alignment, controlled levels and one bass at a time.",
    explanation: [
      "A long blend lets two tracks play as one for a minute or more. Small tempo or grid errors accumulate, so you keep listening and nudging throughout.",
      "Manage the EQs gradually: bring Track B's highs and mids in first, swap the bass in the middle, and take Track A's mids and highs out at the end.",
      "Keep the overall level steady — when one fader goes up, the other usually comes down a little.",
    ],
    prerequisites: ["bassswap"],
    minutes: 10,
    requirements: { grids: "both", maxBpmGapPct: 4, keys: false },
    steps: ["Turn Track B's LOW EQ down", "Press PLAY on Track A", "Start Track B on a phrase boundary", "Keep both tracks playing together for 32 bars", "Swap the bass around bar 17", "Fade Track A out after bar 32"],
    assists: { practice: [...ALL_PRACTICE, "tempoPrematched"], assess: ["tempoPrematched", "bpmDisplay", "phraseCounter"] },
    assessment: "A 32-bar blend with SYNC locked: scored on alignment over the whole overlap, overlap length, bass handover and level continuity.",
    controls: ["jog-B", "eq-low-A", "eq-low-B", "eq-mid-A", "volume-A", "volume-B"],
  },
  {
    id: "quickcut",
    level: "Beginner",
    title: "Quick Cut",
    summary: "Switch from one track to the other in an instant, exactly on a bar or phrase.",
    objective: "On the chosen boundary, start Track B and cut Track A in the same moment.",
    explanation: [
      "A quick cut has no overlap: one track stops being heard and the other starts on the same downbeat. It's great for energy changes and for tracks whose tempos or keys don't match.",
      "Prepare Track B at its cue with its fader down (or crossfader on A). On the boundary, press PLAY on B and move the faders (or slam the crossfader) together.",
      "Choose whether you're cutting on the next bar or the next phrase. Phrase cuts usually sound more natural.",
    ],
    prerequisites: [],
    minutes: 5,
    requirements: { grids: "a", maxBpmGapPct: null, keys: false },
    steps: ["Press PLAY on Track A", "Choose the target: next bar or next phrase", "Wait for the target boundary", "On it: PLAY Track B and cut Track A in one move"],
    assists: { practice: ALL_PRACTICE, assess: ["bpmDisplay", "phraseCounter"] },
    assessment: "Cut on the chosen boundary without a count-in. Scored on B's entry timing, A's cut timing and how cleanly they meet.",
    controls: ["transport-B", "volume-A", "volume-B", "crossfader"],
  },
  {
    id: "effects",
    level: "Advanced",
    title: "Effects Transition (echo-out)",
    summary: "Echo Track A out on a phrase boundary while Track B takes over.",
    objective: "Switch FX1 ECHO on one beat before the boundary, cut Track A on the boundary, start B, and let the echo ring for 4 bars at a controlled level.",
    explanation: [
      "An echo-out hides the change: Track A's last beats repeat and fade while Track B starts clean. It works even when tempos or keys don't match.",
      "Set FX1 to ECHO, assign it to Track A's deck, choose 1/2 or 3/4 beat and a level around 50–70%. Switch it on on beat 4 of the bar before the boundary, then pull Track A's fader down on the boundary — the echo keeps ringing.",
      "Turn the effect off after about 4 bars so the tail doesn't wash over Track B.",
    ],
    prerequisites: ["quickcut"],
    minutes: 8,
    requirements: { grids: "a", maxBpmGapPct: null, keys: false },
    steps: ["Set FX1 to ECHO and assign it to Track A (level 50–70%)", "Press PLAY on Track A", "On beat 4 before the phrase boundary: FX1 ECHO on", "On the boundary: cut Track A, PLAY Track B", "After 4 bars: FX1 off"],
    assists: { practice: ALL_PRACTICE, assess: ["bpmDisplay", "phraseCounter"] },
    assessment: "Echo-out on a phrase boundary: scored on effect timing, cut timing, tail length (target 4 bars), effect level and B's entry.",
    controls: ["fx-1", "volume-A", "transport-B"],
  },
];

export const lesson = (id: LessonId) => LESSONS.find((l) => l.id === id)!;
export const LEVELS: Level[] = ["Beginner", "Intermediate", "Advanced"];

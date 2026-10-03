import { beforeEach, describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import type { TrackInfo } from "../src/core/engine/types";
import { EventLog } from "../src/core/log";
import { LibraryStore } from "../src/library/LibraryStore";
import { lesson, LESSONS } from "../src/training/curriculum";
import { hints, stepDone, type CoachCtx } from "../src/training/coach";
import { aPositionAtBEntry, nearestPhrase, phaseMs, type DeckSample, type Exercise, type Sample, type TrainingEvent } from "../src/training/measure";
import { readiness, suggestPairs, type Candidate } from "../src/training/pairs";
import { scoreAttempt, type AttemptData } from "../src/training/scoring";
import { TrainingService } from "../src/training/TrainingService";
import { FakeAudioEngine } from "./fakes";

// 120 BPM: beat 0.5 s, bar 2 s, phrase (8 bars) 16 s.
const G = { bpm: 120, firstBeat: 0, confidence: 3, manual: false };
const EX: Exercise = { aGrid: G, bGrid: G, aPhraseOffset: 0, bPhraseOffset: 0, bCue: 0, latencyMs: 0, cutOn: "phrase" };
const deck = (p: Partial<DeckSample>): DeckSample => ({ playing: true, pos: 0, rate: 1, bpm: 120, volume: 1, eqLow: 0.5, eqMid: 0.5, eqHigh: 0.5, filter: 0.5, ...p });

/**
 * A synthetic attempt: A plays from aStart; B starts when A reaches `bAt` (A track time), at
 * `bRate`; `mix(t, aPos)` sets volumes/EQs/FX over time. Sampled every 15 ms like the service.
 */
function attempt(o: { lesson: AttemptData["lesson"]; bAt: number; bRate?: number; aStart?: number; duration: number; mix?: (aPos: number, s: Sample) => void; ex?: Partial<Exercise>; taps?: number[] }): AttemptData {
  const ex = { ...EX, ...o.ex };
  const samples: Sample[] = [];
  const events: TrainingEvent[] = [{ t: 0, kind: "aStart", aPos: o.aStart ?? 0 }];
  const bRate = o.bRate ?? 1;
  const aStart = o.aStart ?? 0;
  const tB = o.bAt - aStart;
  for (let t = 0; t <= o.duration; t += 0.015) {
    const aPos = aStart + t;
    const bPlaying = t >= tB;
    const s: Sample = { t, a: deck({ pos: aPos }), b: deck({ playing: bPlaying, pos: bPlaying ? ex.bCue + (t - tB) * bRate : ex.bCue, rate: bRate, bpm: 120 * bRate, volume: bPlaying ? 1 : 0 }), phaseMs: null, fx: [{ echoOn: false, anyOn: false, mix: 0.5, onA: false, onB: false }] };
    o.mix?.(aPos, s);
    if (!s.b.playing) s.b.volume = 0;
    s.phaseMs = s.a.playing && s.b.playing && ex.aGrid && ex.bGrid ? phaseMs(ex.aGrid, ex.bGrid, s.a.pos, s.b.pos, 120) : null;
    if (bPlaying && !events.some((e) => e.kind === "bStart")) events.push({ t, kind: "bStart", aPos: aPositionAtBEntry(s, ex.bCue) });
    samples.push(s);
  }
  for (const tap of o.taps ?? []) events.push({ t: tap - aStart, kind: "tap", aPos: tap });
  events.push({ t: o.duration, kind: "done", aPos: aStart + o.duration });
  return { lesson: o.lesson, samples, events, ex };
}
const metric = (r: ReturnType<typeof scoreAttempt>, id: string) => r.metrics.find((m) => m.id === id)!;

describe("training measurements", () => {
  it("knows phrase boundaries from bars — every bar is not a phrase", () => {
    expect(nearestPhrase(G, 16, 0)).toMatchObject({ index: 1, errorBeats: 0 });
    expect(nearestPhrase(G, 18, 0).errorBeats).toBeCloseTo(4); // bar 10 is 1 bar after the phrase at 16 s
    expect(nearestPhrase(G, 18, 1).errorBeats).toBeCloseTo(0); // …unless the phrase marker says phrases start there
  });
  it("finds where A was when B left its cue, exactly, from a later sample", () => {
    const s = { t: 0, a: deck({ pos: 20.3, rate: 1 }), b: deck({ pos: 0.6, rate: 1.02 }), phaseMs: null, fx: [] } as Sample;
    expect(aPositionAtBEntry(s, 0)).toBeCloseTo(20.3 - 0.6 / 1.02, 6);
  });
});

describe("lesson scoring with known timing", () => {
  it("beatmatch: perfect match scores 100s; a 1 BPM error loses tempo and alignment", () => {
    const perfect = scoreAttempt(attempt({ lesson: "beatmatch", bAt: 4, duration: 40 }));
    expect(metric(perfect, "tempo").score).toBe(100);
    expect(metric(perfect, "align").score).toBe(100);
    expect(metric(perfect, "stability").score).toBe(100);
    expect(perfect.total).toBeGreaterThanOrEqual(95);
    const off = scoreAttempt(attempt({ lesson: "beatmatch", bAt: 4, bRate: 121 / 120, duration: 40 }));
    expect(metric(off, "tempo").value).toBe("1.00 BPM apart");
    expect(metric(off, "tempo").score).toBe(0);
    expect(metric(off, "stability").score!).toBeLessThan(40); // drifts in and out
    expect(off.improvements.some((x) => /tempo/i.test(x))).toBe(true);
  });

  it("quick cut: on the phrase = 100; 100 ms late is measured as 100 ms late", () => {
    const cut = (late: number) => attempt({ lesson: "quickcut", aStart: 8, bAt: 16 + late, duration: 16, mix: (aPos, s) => { s.a.volume = aPos >= 16 + late ? 0 : 1; } });
    const on = scoreAttempt(cut(0));
    expect(metric(on, "entry").score).toBe(100);
    expect(metric(on, "cut").score).toBe(100);
    expect(metric(on, "clean").score).toBe(100);
    const late = scoreAttempt(cut(0.1));
    expect(metric(late, "entry").value).toBe("100 ms late");
    expect(metric(late, "entry").score).toBe(92); // 0.2 beat: 100 − (0.2−0.05)/(2−0.05)×100
    expect(metric(late, "cut").value).toMatch(/^1\d\d ms after the phrase$/); // ≤ one 15 ms sample of quantisation
  });

  it("phrase mixing: entering on a bar that isn't a phrase start is caught; taps use the heard position", () => {
    const r = scoreAttempt(attempt({ lesson: "phrase", aStart: 8, bAt: 18, duration: 50, taps: [16.2, 32.2], ex: { latencyMs: 200 }, mix: (aPos, s) => { s.a.volume = aPos > 40 ? 0 : 1; } }));
    expect(metric(r, "entry").value).toBe("4 beats after the phrase");
    expect(metric(r, "entry").score).toBe(0);
    expect(metric(r, "phraseId").value).toBe("2 of 2 taps on a phrase start"); // 200 ms latency corrected
    expect(metric(r, "complete").score).toBe(100);
    const noTaps = scoreAttempt(attempt({ lesson: "phrase", aStart: 8, bAt: 16, duration: 30 }));
    expect(metric(noTaps, "phraseId")).toMatchObject({ score: 0, value: "No phrase starts tapped" });
  });

  it("bass swap: a clean swap on bar 9 scores well; leaving both basses up is penalised", () => {
    const swap = (clash: boolean) =>
      attempt({
        lesson: "bassswap", aStart: 8, bAt: 16, duration: 40,
        mix: (aPos, s) => {
          const swapAt = 16 + 16; // bar 9 of the blend = 8 bars after B's entry
          s.b.eqLow = aPos < 16 ? 0 : clash ? 0.5 : aPos >= swapAt ? 0.5 : 0;
          s.a.eqLow = !clash && aPos >= swapAt ? 0 : 0.5;
          s.a.volume = aPos >= 48 ? 0 : 1;
        },
      });
    const good = scoreAttempt(swap(false));
    expect(metric(good, "precut").score).toBe(100);
    expect(metric(good, "swapTime")).toMatchObject({ score: 100, value: "On bar 9" });
    expect(metric(good, "bassOverlap").score).toBe(100);
    expect(metric(good, "bassGap").score).toBe(100);
    const bad = scoreAttempt(swap(true));
    expect(metric(bad, "bassOverlap").score).toBe(0);
    expect(bad.improvements.some((x) => /Reduce outgoing bass/.test(x))).toBe(true);
  });

  it("effects: echo on beat 4, cut on the phrase, 4-bar tail at 60% scores 100s", () => {
    const r = scoreAttempt(attempt({
      lesson: "effects", aStart: 8, bAt: 16, duration: 30,
      mix: (aPos, s) => {
        s.a.volume = aPos >= 16 ? 0 : 1;
        const on = aPos >= 15.5 && aPos < 24;
        s.fx = [{ echoOn: on, anyOn: on, mix: 0.6, onA: true, onB: false }];
      },
    }));
    expect(metric(r, "fxOn").score).toBe(100);
    expect(metric(r, "cut").score).toBe(100);
    expect(metric(r, "tail")).toMatchObject({ score: 100, value: "4 bars (target 4)" });
    expect(metric(r, "intensity").score).toBe(100);
  });

  it("unavailable metrics are marked and excluded from the total", () => {
    const r = scoreAttempt(attempt({ lesson: "beatmatch", bAt: 4, duration: 30, ex: { aGrid: null, bGrid: null } }));
    expect(metric(r, "align").score).toBeNull();
    expect(metric(r, "align").how).toMatch(/Needs beat grids/);
    const avail = r.metrics.filter((m) => m.score !== null);
    const expected = Math.round(avail.reduce((s, m) => s + m.score! * m.weight, 0) / avail.reduce((s, m) => s + m.weight, 0));
    expect(r.total).toBe(expected);
    const harmonicNoKeys = scoreAttempt({ ...attempt({ lesson: "harmonic", aStart: 8, bAt: 16, duration: 20 }), keys: { a: null, b: "8A", uncertain: false } });
    expect(metric(harmonicNoKeys, "key").score).toBeNull();
  });

  it("harmonic: compatible picks score, clashing ones don't; uncertain keys are flagged", () => {
    const run = (b: string, uncertain = false) => scoreAttempt({ ...attempt({ lesson: "harmonic", aStart: 8, bAt: 16, duration: 20 }), keys: { a: "8A", b, uncertain } });
    expect(metric(run("9A"), "key").score).toBe(92);
    expect(metric(run("8A"), "key").score).toBe(100);
    expect(metric(run("3B"), "key").score).toBe(25);
    expect(metric(run("9A", true), "key").note).toMatch(/low confidence/);
  });
});

describe("coaching", () => {
  const ctx = (s: Sample, extra: Partial<CoachCtx> = {}): CoachCtx => ({ lesson: "beatmatch", s, recent: [s], events: [{ t: 0, kind: "bStart", aPos: 0 }], ex: EX, assists: new Set(["hints", "countIn", "phraseCounter"]), tempoDownIsFaster: true, echoReadyOnA: false, ...extra });
  it("says which way to move the tempo fader and when to nudge", () => {
    const fast = { t: 10, a: deck({ pos: 10 }), b: deck({ pos: 10, bpm: 120.4 }), phaseMs: 0, fx: [] } as Sample;
    expect(hints(2, ctx(fast)).join(" ")).toMatch(/running slightly fast \(\+0\.40 BPM\) — move Track B's tempo fader up/); // tempo down = faster here
    const ahead = { t: 10, a: deck({ pos: 10 }), b: deck({ pos: 10.02 }), phaseMs: 20, fx: [] } as Sample;
    expect(hints(3, ctx(ahead)).join(" ")).toMatch(/20 ms ahead — nudge it back/);
  });
  it("tells you to wait for the next phrase and spots bar-not-phrase entries", () => {
    const s = { t: 1, a: deck({ pos: 18 }), b: deck({ playing: false, volume: 0 }), phaseMs: null, fx: [] } as Sample;
    expect(hints(2, ctx(s, { lesson: "phrase", events: [] })).join(" ")).toMatch(/Wait for the next phrase — 7 bars to go/);
    const after = { t: 2, a: deck({ pos: 18.5 }), b: deck({ pos: 0.5 }), phaseMs: 0, fx: [] } as Sample;
    expect(hints(3, ctx(after, { lesson: "phrase", events: [{ t: 1.5, kind: "bStart", aPos: 18 }], recent: [after] })).join(" ")).toMatch(/not every bar is a phrase/);
  });
  it("bass-swap hints: reduce outgoing bass when both are up", () => {
    const s = { t: 30, a: deck({ pos: 30 }), b: deck({ pos: 14 }), phaseMs: 0, fx: [] } as Sample;
    expect(hints(3, ctx(s, { lesson: "bassswap" })).join(" ")).toMatch(/reduce outgoing bass as you introduce incoming bass/);
  });
  it("\"hold the match for 8 bars\" needs 8 bars of matched samples (16 s at 120 BPM)", () => {
    const matched = (secs: number) => Array.from({ length: Math.round(secs / 0.015) }, (_, i) => ({ t: 100 - secs + i * 0.015, a: deck({ pos: i * 0.015 }), b: deck({ pos: i * 0.015 }), phaseMs: 3, fx: [] }) as Sample);
    const run = (secs: number) => { const r = matched(secs); return stepDone(4, ctx(r[r.length - 1], { recent: r })); };
    expect(run(12)).toBe(false);
    expect(run(17)).toBe(true);
  });

  it("steps complete from live state, in order", () => {
    const s = { t: 1, a: deck({ pos: 1 }), b: deck({ playing: false, volume: 0 }), phaseMs: null, fx: [] } as Sample;
    expect(stepDone(0, ctx(s, { events: [] }))).toBe(true); // A playing
    expect(stepDone(1, ctx(s, { events: [] }))).toBe(false); // B not started
  });
});

describe("track pairs for lessons", () => {
  const t = (ref: string, bpm: number | null, key: string | null, extra: Partial<Candidate> = {}): Candidate => ({ track: { ref, title: ref, artist: "", album: "", source: "local", bpm, key }, analysed: true, bpm, gridConfidence: bpm ? 3 : null, gridManual: false, key, keyConfidence: 0.6, duration: 300, energy: 6, ...extra });
  it("suggests pairs within the lesson's tempo range, with reasons", () => {
    const pool = [t("a", 124, "8A"), t("b", 126, "9A"), t("c", 140, "8A"), t("d", null, null)];
    const p = suggestPairs(lesson("beatmatch"), pool);
    expect(p.length).toBeGreaterThan(0);
    for (const x of p) expect([x.a.ref, x.b.ref].sort()).toEqual(["a", "b"]);
    expect(p[0].reasons.join(" ")).toMatch(/BPM \(1\.6% apart, within Track B's tempo range\)/);
  });
  it("harmonic needs keys; readiness explains missing analysis", () => {
    expect(suggestPairs(lesson("harmonic"), [t("a", 124, null), t("b", 125, null)])).toEqual([]);
    expect(readiness(t("x", null, null, { analysed: false }), lesson("beatmatch"), "a")).toEqual([{ level: "bad", text: "Not analysed yet" }]);
    expect(readiness(t("x", 120, "8A", { keyConfidence: 0.2 }), lesson("harmonic"), "a").some((r) => /uncertain/.test(r.text))).toBe(true);
  });
});

describe("training sessions (real engine, fake audio)", () => {
  let bus: CommandBus;
  let audio: FakeAudioEngine;
  let engine: DJEngine;
  let store: Map<string, string>;
  const tracks: TrackInfo[] = [
    { ref: "/a.mp3", title: "A", artist: "", album: "", source: "local", bpm: 120, key: "8A" },
    { ref: "/b.mp3", title: "B", artist: "", album: "", source: "local", bpm: 124, key: "9A" },
    { ref: "/c.mp3", title: "Old", artist: "", album: "", source: "local", bpm: 100, key: null },
  ];
  const make = () => {
    const library = new LibraryStore();
    library.hydrate(tracks);
    const preparation = { forRef: (ref: string) => ({ trackId: ref, analysisVersion: 1, beatGrid: { bpm: ref === "/b.mp3" ? 124 : 120, firstBeat: 0, confidence: 3 }, key: "8A", keyConfidence: 0.6, duration: 300, energy: 6 }) };
    return new TrainingService({ engine, bus, audio, library, preparation: preparation as never, analysis: {} as never, storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) } });
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  beforeEach(async () => {
    bus = new CommandBus();
    audio = new FakeAudioEngine();
    engine = new DJEngine({ bus, audio, log: new EventLog(), browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(300) });
    store = new Map();
    // A "performance session" already on the decks.
    await engine.loadTrack(0, tracks[2]);
    engine.setBeatGrid(0, { bpm: 100, firstBeat: 0, confidence: 3, source: "analysis" });
    bus.send("mixer.channel1.volume", 0.3);
    bus.send("mixer.crossfader", 0.2);
    engine.setRateDirect(0, 1.04);
  });
  const withGrids = () => {
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0, confidence: 3, source: "analysis" });
  };

  it("won't take over a playing deck; starts only on request and never presses PLAY", async () => {
    const t = make();
    t.selectLesson("beatmatch");
    t.setTrack("a", "/a.mp3");
    t.setTrack("b", "/b.mp3");
    await engine.loadTrack(1, tracks[1]);
    withGrids();
    engine.setBeatGrid(0, { bpm: 100, firstBeat: 0, confidence: 3, source: "analysis" });
    bus.send("deck1.play");
    await t.start("practice");
    expect(t.getState().blocked).toMatch(/Deck A is playing/);
    expect(t.getState().phase).toBe("setup");
    expect(engine.getState().decks[0].track?.ref).toBe("/c.mp3"); // untouched
    expect(engine.getState().decks[0].playing).toBe(true);
    // Explicit stop & start (the lesson loads its tracks; grids as analysis would give them).
    engine.on("state", (st) => { if (st.decks[0].track?.ref === "/a.mp3" && !st.decks[0].beatGrid) engine.setBeatGrid(0, { bpm: 120, firstBeat: 0, confidence: 3, source: "analysis" }); });
    await t.start("practice", true);
    expect(t.getState().phase).toBe("practice");
    expect(engine.getState().decks.every((d) => !d.playing)).toBe(true); // nothing auto-played
    expect(engine.getState().decks[0].track?.ref).toBe("/a.mp3");
    await t.exit();
  });

  it("locks SYNC during the exercise, offsets Track B for beatmatching, and restores everything on exit", async () => {
    const t = make();
    t.selectLesson("beatmatch");
    t.setTrack("a", "/a.mp3");
    t.setTrack("b", "/b.mp3");
    await engine.loadTrack(0, tracks[0]);
    await engine.loadTrack(1, tracks[1]);
    withGrids();
    // Previous session state is captured before the lesson changes anything.
    const before = { vol: engine.getState().mixer.channels[0].volume, xf: engine.getState().mixer.crossfader };
    await t.start("assess");
    expect(engine.isSyncLocked()).toBe(true);
    bus.send("deck2.sync");
    expect(engine.getState().decks[1].sync).toBe(false);
    expect(engine.getState().decks[1].rate).toBeCloseTo((120 / 124) * 1.03, 6); // first offset: +3%
    expect(engine.getState().mixer.channels[0].volume).toBe(1);
    expect(t.getState().assists).not.toContain("sync");
    await t.exit();
    expect(engine.isSyncLocked()).toBe(false);
    expect(engine.getState().mixer.channels[0].volume).toBeCloseTo(before.vol);
    expect(engine.getState().mixer.crossfader).toBeCloseTo(before.xf);
    expect(t.getState().phase).toBe("dashboard");
  });

  it("restores the deck that was loaded before training (track and tempo)", async () => {
    const t = make();
    t.selectLesson("quickcut");
    t.setTrack("a", "/a.mp3");
    t.setTrack("b", "/b.mp3");
    await t.start("practice").catch(() => undefined);
    // Deck A was "/c.mp3" at +4% before training.
    await t.exit();
    expect(engine.getState().decks[0].track?.ref).toBe("/c.mp3");
    expect(engine.getState().decks[0].rate).toBeCloseTo(1.04, 6);
  });

  it("assessed attempt → results → saved progress; retry uses the next offset; persists after reload; reset clears", async () => {
    let t = make();
    t.selectLesson("beatmatch");
    t.setTrack("a", "/a.mp3");
    t.setTrack("b", "/b.mp3");
    await engine.loadTrack(0, tracks[0]);
    await engine.loadTrack(1, tracks[1]);
    withGrids();
    await t.start("assess");
    await sleep(60);
    t.finishNow();
    expect(t.getState().phase).toBe("results");
    expect(t.getState().result!.metrics.find((m) => m.id === "tempo")!.value).toBe("Tracks never played together");
    expect(t.getState().progress.beatmatch!.attempts).toHaveLength(1);
    await t.retry();
    expect(t.getState().phase).toBe("assess");
    expect(engine.getState().decks[1].rate).toBeCloseTo((120 / 124) * (1 - 0.025), 6); // second offset
    t.finishNow();
    await t.exit();
    // "Reload": a new service with the same storage.
    t = make();
    expect(t.getState().progress.beatmatch!.attempts).toHaveLength(2);
    expect(t.suggestedNext()).toBe("beatmatch"); // not passed yet
    t.resetProgress();
    expect(make().getState().progress).toEqual({});
  });

  it("every lesson has content, steps and assists", () => {
    expect(LESSONS).toHaveLength(7);
    for (const l of LESSONS) {
      expect(l.explanation.length).toBeGreaterThan(1);
      expect(l.steps.length).toBeGreaterThan(2);
      expect(l.objective.length).toBeGreaterThan(20);
    }
    expect(lesson("beatmatch").assists.assess).not.toContain("sync");
    expect(lesson("longblend").assists.assess).not.toContain("sync");
  });
});

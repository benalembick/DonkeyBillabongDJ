import { describe, expect, it } from "vitest";
import { automaticLanes, checkPlayable, configFromPreset, findPrepared, frameAt, laneAt, MAX_CUT_DB, migrateTransition, ratesFor, snap, SYSTEM_PRESETS, type PreparedTransition, type TrackTiming } from "../src/setstudio/transitionModel";
import { AutoDJ } from "../src/autodj/AutoDJ";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import { EventLog } from "../src/core/log";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { PreparationStore } from "../src/preparation/PreparationStore";
import type { PreparationPersistence, TrackPreparation } from "../src/preparation/types";
import { DocStore, type DocPersistence } from "../src/setstudio/DocStore";
import { TransitionLabService } from "../src/setstudio/TransitionLabService";
import { migratePreset, type TransitionPreset } from "../src/setstudio/transitionModel";
import { FakeAudioEngine } from "./fakes";

const T120: TrackTiming = { bpm: 120, firstBeat: 0.5, gridReliable: true, duration: 180 };
const T124: TrackTiming = { bpm: 124, firstBeat: 0.2, gridReliable: true, duration: 180 };

describe("automation lanes", () => {
  it("interpolates smoothly between points and holds outside them", () => {
    const l = [{ t: 0.2, v: 0 }, { t: 0.6, v: -30 }];
    expect(laneAt(l, 0)).toBe(0);
    expect(laneAt(l, 0.2)).toBe(0);
    expect(laneAt(l, 0.4)).toBeCloseTo(-15);
    expect(laneAt(l, 1)).toBe(-30);
    for (let k = 0; k < 20; k++) expect(laneAt(l, (k + 1) / 20)).toBeLessThanOrEqual(laneAt(l, k / 20) + 1e-9); // monotone, no overshoot
    expect(laneAt([], 0.5, 7)).toBe(7);
  });
  it("frames clamp to the engine's cut-only range and switch off with EQ mode Off", () => {
    const c = { crossfader: [{ t: 0, v: -1 }, { t: 1, v: 2 }], eq: { out: { low: [{ t: 0, v: -99 }, { t: 1, v: 5 }], mid: [], high: [] }, in: { low: [], mid: [], high: [] } }, eqMode: "manual" as const, effects: {} };
    expect(frameAt(c, 0)).toMatchObject({ crossfader: 0, out: { low: MAX_CUT_DB } });
    expect(frameAt(c, 1)).toMatchObject({ crossfader: 1, out: { low: 0 } });
    expect(frameAt({ ...c, eqMode: "off" }, 0).out.low).toBe(0);
  });
  it("Automatic EQ lanes reuse the Auto EQ maths (bass swap mirrored)", () => {
    const a = automaticLanes();
    expect(laneAt(a.in.low, 0)).toBeLessThan(-20);
    expect(laneAt(a.out.low, 1)).toBeLessThan(-20);
    expect(laneAt(a.in.low, 1)).toBeCloseTo(0, 0);
  });
});

describe("presets and timing", () => {
  it("every system preset is a valid configuration", () => {
    for (const p of SYSTEM_PRESETS) {
      const { config } = configFromPreset(p, { out: T120, in: T124 });
      expect(config.seconds).toBeGreaterThan(0);
      for (const v of config.crossfader) { expect(v.v).toBeGreaterThanOrEqual(0); expect(v.v).toBeLessThanOrEqual(1); }
      for (const side of [config.eq.out, config.eq.in]) for (const lane of [side.low, side.mid, side.high]) for (const pt of lane) { expect(pt.v).toBeLessThanOrEqual(0); expect(pt.v).toBeGreaterThanOrEqual(MAX_CUT_DB); }
      expect(config.mixOut + config.seconds * ratesFor(config, T120, T124).outRate).toBeLessThanOrEqual(T120.duration);
    }
  });
  it("aligns to bars/phrases on the existing grid and states what it needs", () => {
    const q = configFromPreset(SYSTEM_PRESETS.find((p) => p.id === "quick")!, { out: T120, in: T124, outMixOut: 150.3, inMixIn: 3.1 }).config;
    expect(((q.mixOut - 0.5) / 16) % 1).toBeCloseTo(0, 6); // 8-bar phrase = 16 s at 120 BPM
    const drop = configFromPreset(SYSTEM_PRESETS.find((p) => p.id === "drop-swap")!, { out: T120, in: T124 });
    expect(drop.unavailable).toMatch(/Drop/);
    const ok = configFromPreset(SYSTEM_PRESETS.find((p) => p.id === "drop-swap")!, { out: T120, in: T124, inDrop: 60 }).config;
    expect(ok.mixIn + ok.seconds * ratesFor(ok, T120, T124).inRate).toBeCloseTo(60, 0); // incoming drop lands at the end of the overlap
    expect(snap(10.3, { ...T120, gridReliable: false }, "bar")).toBe(10.3);
  });
  it("matches tempo with half/double-time awareness and refuses big jumps", () => {
    const r = ratesFor({ syncMode: "beat", targetBpm: null, maxTempoPct: 10 }, T120, T124);
    expect(r.synced).toBe(true);
    expect(r.inRate).toBeCloseTo(120 / 124);
    const half = ratesFor({ syncMode: "beat", targetBpm: null, maxTempoPct: 10 }, { ...T120, bpm: 87 }, { ...T124, bpm: 174 });
    expect(half.multiple).toBe(0.5);
    expect(half.synced).toBe(true);
    const far = ratesFor({ syncMode: "beat", targetBpm: null, maxTempoPct: 6 }, T120, { ...T124, bpm: 140 });
    expect(far.synced).toBe(false);
    expect(far.warning).toMatch(/limit/);
    expect(ratesFor({ syncMode: "manual", targetBpm: 126, maxTempoPct: 10 }, T120, T124)).toMatchObject({ outRate: 1.05, synced: false });
  });
});

const prepared = (p: Partial<PreparedTransition> = {}): PreparedTransition => migrateTransition({ id: "trans_1", name: "Lab blend", outgoingTrackId: "sha256:a", incomingTrackId: "sha256:b", mixOut: 100, mixIn: 10, seconds: 10, bars: null, syncMode: "off",
  crossfader: [{ t: 0, v: 0 }, { t: 0.5, v: 0 }, { t: 0.6, v: 1 }, { t: 1, v: 1 }], eqMode: "manual", eq: { out: { low: [{ t: 0, v: 0 }, { t: 0.5, v: -30 }], mid: [], high: [] }, in: { low: [{ t: 0, v: -30 }, { t: 0.5, v: 0 }], mid: [], high: [] } }, effects: {}, ...p });

describe("playback checks and lookup", () => {
  const facts = { trackId: "sha256:a", duration: 180, bpm: 120, gridReliable: true, tempoRange: 0.1 }, inF = { ...facts, trackId: "sha256:b" };
  it("validates tracks and positions and drops what can't be honoured", () => {
    expect(checkPlayable(prepared(), facts, inF, { echo: true }).ok).toBe(true);
    expect(checkPlayable(prepared(), { ...facts, trackId: "sha256:x" }, inF, { echo: true }).reason).toMatch(/don't match/);
    expect(checkPlayable(prepared({ mixOut: 175 }), facts, inF, { echo: true }).reason).toMatch(/outside the outgoing/);
    const fast = checkPlayable(prepared({ syncMode: "beat" }), facts, { ...inF, bpm: 135, tempoRange: 0.06 }, { echo: true });
    expect(fast).toMatchObject({ ok: true, sync: false });
    expect(fast.notes.join()).toMatch(/tempo range|unsynced/);
    expect(checkPlayable(prepared({ effects: { echoOut: { start: 0, end: 1, level: 0.5 } } }), facts, inF, { echo: false }).notes.join()).toMatch(/Echo/);
  });
  it("a transition saved for one set is never used for another set", () => {
    const setA = prepared({ id: "trans_a", setId: "set_a" }), lib = prepared({ id: "trans_lib", setId: null });
    expect(findPrepared([setA, lib], "sha256:a", "sha256:b", "set_a")?.id).toBe("trans_a");
    expect(findPrepared([setA, lib], "sha256:a", "sha256:b", "set_b")?.id).toBe("trans_lib");
    expect(findPrepared([setA], "sha256:a", "sha256:b", "set_b")).toBeNull();
    expect(findPrepared([setA], "sha256:a", "sha256:b", null)).toBeNull();
  });
});

// ── Auto DJ consumes saved transitions ─────────────────────────────────────────
async function autodj(transition: PreparedTransition | null, settings: Record<string, unknown> = {}) {
  const bus = new CommandBus(), audio = new FakeAudioEngine(), library = new LibraryStore(), playlists = new PlaylistStore(null);
  library.addFiles(["a", "b", "c"].map((ref) => ({ ref, name: ref + ".wav" })));
  library.patchTracks(library.getState().tracks.map((t) => ({ ...t, trackId: `sha256:${t.ref}` })));
  const engine = new DJEngine({ bus, audio, log: new EventLog(), browser: library, loadBytes: async () => new ArrayBuffer(180) });
  const lookups: unknown[][] = [];
  const auto = new AutoDJ({ engine, bus, audio, library, playlists, analysis: { get: () => null }, settings, preparedTransitions: { find: (...a) => { lookups.push(a); return transition; } } });
  const playlist = playlists.create("Set", ["a", "b", "c"]);
  await auto.start(playlist.id);
  return { auto, engine, audio, playlist, lookups };
}

describe("Auto DJ + prepared transitions", () => {
  it("performs the saved timing, crossfader and EQ automation", async () => {
    const { auto, engine, audio, playlist, lookups } = await autodj(prepared());
    auto.tick();
    expect(lookups[0]).toEqual(["a", "b", playlist.id]);
    expect(auto.getState().plan).toMatchObject({ mixOut: 100, mixIn: 10, seconds: 10, sync: false });
    expect(auto.getState().plan?.reason).toMatch(/Prepared transition: Lab blend/);
    expect(auto.getState().prepared?.name).toBe("Lab blend");
    audio.positions[0] = 100; auto.tick();
    expect(auto.getState().status).toBe("TRANSITIONING");
    expect(audio.positions[1]).toBeCloseTo(10);
    audio.positions[1] = 12.5; auto.tick(); // 25 %
    expect(engine.getState().mixer.crossfader).toBeCloseTo(0);
    const f = frameAt(prepared(), 0.25);
    expect(engine.getState().autoEq[0].lowDb).toBeCloseTo(f.out.low);
    expect(engine.getState().autoEq[1].lowDb).toBeCloseTo(f.in.low);
    audio.positions[1] = 17; auto.tick(); // 70 %
    expect(engine.getState().mixer.crossfader).toBeCloseTo(1);
    audio.positions[1] = 20.5; auto.tick();
    expect(auto.getState()).toMatchObject({ status: "ACTIVE", current: "b", prepared: null });
    expect(engine.getState().autoEq[1].lowDb).toBe(0);
  });
  it("manual EQ moves still take a band back during a prepared transition", async () => {
    const { auto, engine, audio } = await autodj(prepared());
    auto.tick(); audio.positions[0] = 100; auto.tick();
    audio.positions[1] = 12.5; auto.tick();
    engine["state"].autoEq[1] = { ...engine.getState().autoEq[1], lowActive: false }; // as after the DJ turns Deck B's low knob
    const before = engine.getState().autoEq[1].lowDb;
    audio.positions[1] = 14; auto.tick();
    expect(engine.getState().autoEq[1].lowDb).toBe(before);
  });
  it("falls back to the standard transition when the saved one doesn't fit, or when switched off", async () => {
    const bad = await autodj(prepared({ outgoingTrackId: "sha256:zzz" }));
    bad.auto.tick();
    expect(bad.auto.getState().plan?.reason ?? "").not.toMatch(/Prepared/);
    const off = await autodj(prepared(), { preparedTransitions: false });
    off.auto.tick();
    expect(off.auto.getState().plan?.reason ?? "").not.toMatch(/Prepared/);
    const none = await autodj(null);
    none.auto.tick();
    expect(none.auto.getState().prepared).toBeNull();
  });
});

// ── Transition Lab ─────────────────────────────────────────────────────────────
function memDocs(): DocPersistence & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return { rows, list: async (k) => [...rows].filter(([key]) => key.startsWith(k + "/")).map(([, v]) => v), save: async (k, d) => void rows.set(`${k}/${d.id}`, structuredClone(d)), remove: async (k, id) => void rows.delete(`${k}/${id}`) };
}
const rec = (ref: string, bpm: number): TrackPreparation => ({ schemaVersion: 1, trackId: `sha256:${ref}`, refs: [ref], fileSize: 1, title: ref.toUpperCase(), artist: "", album: "", isrc: null, duration: 180, bpm, key: "Am", keyConfidence: 0.5, energy: 6, energyConfidence: 0.5,
  sections: [], recommendedCues: [], gain: null, analysisVersion: 1, analysedAt: 1, updatedAt: 1, beatGrid: { bpm, firstBeat: 0.5, confidence: 3, offset: 0, beatPositions: [], manuallyAdjusted: false, source: "analysis" }, cuePoint: 0, cues: [], savedLoops: [], lastLoop: null });
async function lab() {
  const bus = new CommandBus(), audio = new FakeAudioEngine(), library = new LibraryStore(), playlists = new PlaylistStore(null);
  library.addFiles(["a", "b", "c"].map((ref) => ({ ref, name: ref + ".wav" })));
  const engine = new DJEngine({ bus, audio, log: new EventLog(), browser: library, loadBytes: async () => new ArrayBuffer(180) });
  const persistence: PreparationPersistence = { list: async () => [rec("a", 120), rec("b", 124), rec("c", 128)], save: async () => undefined, loadWaveform: async () => null, saveWaveform: async () => undefined };
  const preparation = new PreparationStore(persistence); await preparation.ready;
  const docs = memDocs();
  const transitions = new DocStore<PreparedTransition>("transition", docs, migrateTransition), presets = new DocStore<TransitionPreset>("preset", docs, migratePreset);
  await transitions.load(); await presets.load();
  const autoDJ = new AutoDJ({ engine, bus, audio, library, playlists, analysis: { get: () => null } });
  let tickFn: (() => void) | null = null;
  const svc = new TransitionLabService({ engine, send: (a, v = 1) => bus.send(a, v, "system"), audioRouting: () => "stereo", autoDJ, library, preparation, transitions, presets, every: (fn) => { tickFn = fn; return () => { tickFn = null; }; } });
  return { svc, engine, audio, bus, transitions, presets, docs, autoDJ, playlists, tick: () => tickFn?.() };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("Transition Lab", () => {
  it("opens the pair with two candidates to compare", async () => {
    const { svc } = await lab();
    svc.open({ outRef: "a", inRef: "b" });
    const s = svc.getState();
    expect(s.out?.ref).toBe("a");
    expect(s.in?.ref).toBe("b");
    expect(s.out?.bpm).toBe(120);
    expect(s.candidates.map((c) => c.label)).toEqual(["A · Smooth Blend", "B · Bass Swap"]);
    expect(s.candidates[0].config.seconds).toBeCloseTo(32); // 16 bars at 120 BPM
  });

  it("saves, re-saves as a new version, and keeps set-specific transitions separate (survives a reload)", async () => {
    const { svc, transitions, docs } = await lab();
    svc.open({ outRef: "a", inRef: "b", setId: "set_x", fromSlotId: "s1", toSlotId: "s2" });
    const v1 = svc.save("Warm blend")!;
    svc.setBars(8);
    const v2 = svc.save("Warm blend")!;
    expect(v2.id).toBe(v1.id);
    expect(v2.version).toBe(2);
    expect(v2.history[0]).toMatchObject({ version: 1 });
    svc.open({ outRef: "a", inRef: "b", setId: "set_y" });
    expect(svc.getState().savedId).toBeNull();
    const other = svc.save("Other set")!;
    expect(other.id).not.toBe(v1.id);
    await transitions.flush();
    const reloaded = new DocStore<PreparedTransition>("transition", docs, migrateTransition); await reloaded.load();
    expect(reloaded.all().map((t) => [t.name, t.setId, t.version]).sort()).toEqual([["Other set", "set_y", 1], ["Warm blend", "set_x", 2]]);
  });

  it("edits are undoable and presets can be saved under a new name", async () => {
    const { svc, presets } = await lab();
    svc.open({ outRef: "a", inRef: "b" });
    const before = svc.current!.config.mixOut;
    svc.movePoint("out", before - 30, "bar");
    expect(svc.current!.config.mixOut).not.toBe(before);
    svc.undo();
    expect(svc.current!.config.mixOut).toBe(before);
    svc.redo();
    expect(svc.current!.config.mixOut).not.toBe(before);
    const p = svc.savePreset("My swap")!;
    expect(presets.get(p.id)?.name).toBe("My swap");
    expect(svc.allPresets().some((x) => x.id === p.id)).toBe(true);
  });

  it("won't take over a deck that is playing something else, or a running Auto DJ", async () => {
    const { svc, engine, bus, autoDJ, playlists } = await lab();
    svc.open({ outRef: "a", inRef: "b" });
    await engine.loadTrack(0, { ref: "c", title: "C", artist: "", album: "", source: "local", bpm: null, key: null });
    bus.send("deck1.play", 1, "system");
    await svc.play();
    expect(svc.getState().preview).toMatchObject({ status: "blocked", blockedBy: "deck" });
    expect(engine.getState().decks[0].playing).toBe(true);
    bus.send("deck1.play", 1, "system");
    const p = playlists.create("x", ["a", "b"]); await autoDJ.start(p.id);
    await svc.play({ takeOver: true });
    expect(svc.getState().preview.blockedBy).toBe("autodj");
    expect(autoDJ.getState().status).not.toBe("OFF");
  });

  it("stops Auto DJ and previews only when explicitly asked to", async () => {
    const { svc, autoDJ, playlists } = await lab();
    svc.open({ outRef: "a", inRef: "b" });
    const p = playlists.create("x", ["a", "b"]); await autoDJ.start(p.id);
    await svc.play();
    expect(svc.getState().preview.blockedBy).toBe("autodj");
    await svc.play({ stopAutoDJ: true });
    expect(autoDJ.getState().status).toBe("OFF");
    expect(svc.getState().preview.blockedBy).toBeNull();
    expect(svc.getState().preview.status).not.toBe("blocked");
    svc.stop();
  });

  it("previews on the real decks with the saved frame, then restores the mixer exactly", async () => {
    const { svc, engine, audio, bus, tick } = await lab();
    bus.send("mixer.crossfader", 0.37, "system");
    bus.send("mixer.channel1.eq.low", 0.2, "system");
    engine.setKeylock(1, true);
    svc.open({ outRef: "a", inRef: "b" });
    svc.select(1); // Bass Swap
    await svc.play();
    await settle();
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0.5, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0.5, confidence: 3, source: "analysis" });
    const s = svc.getState(), c = svc.current!.config, r = svc.rates()!;
    expect(s.preview.status).toBe("playing");
    expect(engine.getState().decks.map((d) => d.track?.ref)).toEqual(["a", "b"]);
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(engine.getState().decks[1].playing).toBe(false); // pre-roll
    audio.positions[0] = c.mixOut + 0.01; tick();
    expect(engine.getState().decks[1].playing).toBe(true);
    expect(engine.getState().decks[1].sync).toBe(true);
    audio.positions[0] = c.mixOut + (c.seconds * 0.5) * r.outRate; tick();
    const f = frameAt(c, 0.5);
    expect(engine.getState().mixer.crossfader).toBeCloseTo(f.crossfader, 2);
    expect(engine.getState().autoEq[0].lowDb).toBeCloseTo(f.out.low, 1);
    // Compare: switch to A at the same position.
    const t = svc.getState().preview.time;
    svc.select(0);
    expect(svc.getState().preview.time).toBeCloseTo(t);
    svc.stop();
    expect(engine.getState().mixer.crossfader).toBeCloseTo(0.37);
    expect(engine.getState().mixer.channels[0].eqLow).toBeCloseTo(0.2);
    expect(engine.getState().decks[1].keylock).toBe(true);
    expect(engine.getState().decks.every((d) => !d.playing)).toBe(true);
    expect(engine.getState().autoEq[0].lowDb).toBe(0);
  });

  it("stopping when nothing was previewed never touches the decks", async () => {
    const { svc, engine, bus } = await lab();
    await engine.loadTrack(0, { ref: "c", title: "C", artist: "", album: "", source: "local", bpm: null, key: null });
    bus.send("deck1.play", 1, "system");
    svc.stop();
    expect(engine.getState().decks[0].playing).toBe(true);
  });
});

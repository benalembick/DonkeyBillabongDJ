import { describe, expect, it } from "vitest";
import { AutoDJ } from "../src/autodj/AutoDJ";
import { compatibleKeys, DEFAULT_AUTO_DJ, planTransition, transitionRegion } from "../src/autodj/transition";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import { EventLog } from "../src/core/log";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { browserFileRef } from "../src/library/BrowserLibrary";
import { FakeAudioEngine } from "./fakes";

async function setup(loader: (ref: string) => Promise<ArrayBuffer> = async () => new ArrayBuffer(180), stemAvailable?: (ref: string) => boolean) {
  const bus = new CommandBus(), audio = new FakeAudioEngine(), library = new LibraryStore(), playlists = new PlaylistStore(null);
  library.addFiles(["a", "b", "c", "d"].map((ref) => ({ ref, name: ref + ".wav" })));
  const engine = new DJEngine({ bus, audio, log: new EventLog(), browser: library, loadBytes: (t) => loader(t.ref) });
  const auto = new AutoDJ({ engine, bus, audio, library, playlists, analysis: { get: () => null }, stemAvailable });
  const playlist = playlists.create("Set", ["a", "b", "c"]);
  return { bus, audio, library, playlists, engine, auto, playlist };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe("Auto DJ", () => {
  it("enables existing Sync at a compatible phrase and compensates for a small timer delay", async () => {
    const { auto, playlist, engine, audio } = await setup();
    await auto.start(playlist.id);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0.1, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0.2, confidence: 3, source: "analysis" });
    auto.tick();
    const plan = auto.getState().plan!;
    expect(plan.sync).toBe(true);
    audio.positions[0] = plan.mixOut + 0.02;
    auto.tick();
    expect(auto.getState().status).toBe("TRANSITIONING");
    expect(engine.getState().decks[1].sync).toBe(true);
    expect(engine.getState().decks[1].rate).toBeCloseTo(120 / 124);
    expect(audio.positions[1]).toBeCloseTo(plan.mixIn + 0.02 * 120 / 124);
  });

  it("phase-snaps after incoming playback starts so launch latency cannot leave beats flamming", async () => {
    const { auto, playlist, engine, audio } = await setup();
    await auto.start(playlist.id);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0.1, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0.2, confidence: 3, source: "analysis" });
    auto.tick();
    const plan = auto.getState().plan!;
    audio.positions[0] = plan.mixOut;
    const original = audio.setPlaying.bind(audio);
    audio.setPlaying = (deck, playing) => {
      original(deck, playing);
      if (deck === 1 && playing) audio.positions[0] += 0.035; // command/start latency on the outgoing deck
    };
    auto.tick();
    expect(auto.getState().status).toBe("TRANSITIONING");
    expect(engine.phaseError(1, 0)).toBeCloseTo(0, 5);
  });

  it("uses the transition type selected in Auto DJ settings", async () => {
    const { auto, playlist, engine } = await setup();
    await auto.start(playlist.id);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0, confidence: 3, source: "analysis" });
    auto.configure({ style: "beat-mix" }); auto.tick();
    expect(auto.getState().plan?.kind).toBe("beat-mix");
    auto.configure({ style: "crossfade" }); auto.tick();
    expect(auto.getState().plan?.kind).toBe("crossfade");
    auto.configure({ style: "quick-fade" }); auto.tick();
    expect(auto.getState().plan?.kind).toBe("quick-fade");
  });

  it("reports a crossfade plan when explicit Beat Mix cannot safely sync the tracks", async () => {
    const { auto, playlist } = await setup();
    auto.configure({ style: "beat-mix" }); await auto.start(playlist.id); auto.tick();
    expect(auto.getState().settings.style).toBe("beat-mix");
    expect(auto.getState().plan).toMatchObject({ kind: "crossfade", sync: false, reason: "Clean fade; no reliable compatible beat grids" });
  });

  it("uses cached STEM routing for an enabled Intelligent Mashup transition", async () => {
    const { auto, playlist, engine, audio } = await setup(undefined, () => true);
    engine.setStemsSupport(true);
    auto.configure({ intelligentMashups: true, style: "beat-mix" });
    await auto.start(playlist.id);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0, confidence: 3, source: "analysis" });
    auto.tick();
    const plan = auto.getState().plan!;
    audio.positions[0] = plan.mixOut;
    auto.tick();
    expect(auto.getState()).toMatchObject({ status: "TRANSITIONING", message: "Intelligent Mashup: vocal overlay, then instrumental handover" });
    expect(engine.getState().decks[0].stems.enabled).toBe(true);
    expect(engine.getState().decks[1].stems.muted).toEqual([false, true, true, true]);
  });

  it("fade progress follows audio even when renderer ticks are delayed", async () => {
    const { auto, playlist, audio, engine } = await setup();
    await auto.start(playlist.id); auto.skip();
    audio.positions[1] += 1.5;
    auto.tick();
    expect(engine.getState().mixer.crossfader).toBeCloseTo(0.75);
  });

  it("loads the next deck, crossfades and advances without editing the playlist", async () => {
    const { auto, audio, engine, playlist, playlists } = await setup();
    await auto.start(playlist.id);
    expect(engine.getState().decks.map((d) => [d.track?.ref, d.playing])).toEqual([["a", true], ["b", false]]);
    audio.positions[0] = 173;
    auto.tick();
    expect(auto.getState().status).toBe("TRANSITIONING");
    for (let i = 1; i <= 100; i++) { audio.positions[1] += 0.1; auto.tick(); }
    await settle();
    expect(auto.getState()).toMatchObject({ status: "ACTIVE", current: "b", deck: 1, upcoming: ["c"] });
    expect(engine.getState().mixer.crossfader).toBe(1);
    expect(engine.getState().decks[0].track?.ref).toBe("c");
    expect(playlists.get(playlist.id)?.refs).toEqual(["a", "b", "c"]);
  });
  it("manual playhead and crossfader movement leave automation switched on", async () => {
    const { auto, bus, engine, playlist, audio } = await setup();
    await auto.start(playlist.id);
    bus.send("deck1.seek", 0.5, "midi");
    auto.tick();
    expect(auto.getState().status).toBe("ACTIVE");
    expect(audio.positions[0]).toBe(90);
    audio.positions[0] = 173; auto.tick(); audio.positions[1] += 0.1; auto.tick();
    bus.send("mixer.crossfader", 0.37, "midi");
    auto.tick();
    expect(auto.getState().status).toBe("TRANSITIONING");
    expect(engine.getState().mixer.crossfader).not.toBe(0.37);
    expect(engine.getState().decks.every((d) => d.playing)).toBe(true);
  });
  it("queue edits are temporary until explicitly saved", async () => {
    const { auto, playlist, playlists } = await setup();
    await auto.start(playlist.id);
    auto.add(["d"]); auto.playNext(2); await settle(); auto.remove(1); await settle();
    expect(auto.getState().upcoming).toEqual(["d", "c"]);
    expect(playlists.get(playlist.id)?.refs).toEqual(["a", "b", "c"]);
    auto.saveToPlaylist();
    expect(playlists.get(playlist.id)?.refs).toEqual(["a", "d", "c"]);
  });
  it("starts from a selected track and refuses to overwrite a playing set", async () => {
    const { auto, playlist, engine } = await setup();
    await auto.start(playlist.id, "b");
    expect(auto.getState()).toMatchObject({ current: "b", upcoming: ["c"] });
    await auto.start(playlist.id, "a");
    expect(engine.getState().decks[0].track?.ref).toBe("b");
    expect(auto.getState().message).toContain("Pause the decks");
  });
  it("stopping during an asynchronous load cannot start playback later", async () => {
    let release!: (b: ArrayBuffer) => void;
    const { auto, playlist, engine } = await setup(() => new Promise((r) => { release = r; }));
    const starting = auto.start(playlist.id);
    auto.stop(); release(new ArrayBuffer(180)); await starting;
    expect(auto.getState().status).toBe("OFF");
    expect(engine.getState().decks[0].playing).toBe(false);
    expect(engine.getState().decks[0].status).toBe("empty");
  });
  it("manual loading cancels a pending automated preload", async () => {
    let release!: (b: ArrayBuffer) => void;
    const { auto, playlist, engine } = await setup((r) => r === "b" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(new ArrayBuffer(180)));
    const starting = auto.start(playlist.id); await settle();
    await engine.loadTrack(1, { ref: "manual", title: "Manual", artist: "", album: "", source: "local", bpm: null, key: null });
    release(new ArrayBuffer(180)); await starting;
    expect(auto.getState().status).toBe("PAUSED");
    expect(engine.getState().decks[1].track?.ref).toBe("manual");
  });
  it("missing next file pauses without stopping the current deck; recovery retries it", async () => {
    const { auto, playlist, library, engine } = await setup();
    const t = library.getByRef("b")!;
    library.patchTracks([{ ...t, unavailableReason: "Reconnect files" }]);
    await auto.start(playlist.id);
    expect(auto.getState()).toMatchObject({ status: "PAUSED", upcoming: ["b", "c"] });
    expect(engine.getState().decks[0].playing).toBe(true);
    library.patchTracks([t]); auto.resume(); await settle();
    expect(auto.getState().status).toBe("ACTIVE");
    expect(engine.getState().decks[1].track?.ref).toBe("b");
  });
  it("repeat uses the original playlist after the selected starting track", async () => {
    const { auto, playlist } = await setup();
    auto.configure({ repeat: true }); await auto.start(playlist.id, "c");
    expect(auto.getState().upcoming).toEqual(["a", "b", "c"]);
  });

  it("retries an unavailable first track after reconnecting files", async () => {
    const { auto, playlist, library, engine } = await setup();
    const t = library.getByRef("a")!;
    library.patchTracks([{ ...t, unavailableReason: "Reconnect files" }]);
    await auto.start(playlist.id);
    expect(auto.getState().status).toBe("PAUSED");
    library.patchTracks([t]); auto.resume(); await settle();
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(engine.getState().decks[1].track?.ref).toBe("b");
  });

  it("shuffle from a selected track includes the full playlist with the selected track first", async () => {
    const { auto, playlist } = await setup();
    auto.configure({ shuffle: true }); await auto.start(playlist.id, "b");
    expect(auto.getState().current).toBe("b");
    expect([...auto.getState().upcoming].sort()).toEqual(["a", "c"]);
  });

  it("stays armed without overriding a manual pause", async () => {
    const { auto, playlist, bus, engine } = await setup();
    await auto.start(playlist.id);
    bus.send("deck1.play"); auto.tick();
    expect(auto.getState()).toMatchObject({ status: "ACTIVE", message: "Deck paused; Auto DJ remains armed", nextSeconds: null });
    expect(engine.getState().decks[0].playing).toBe(false);
    expect(engine.getState().decks[1].playing).toBe(false);
    bus.send("deck1.play"); auto.tick();
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(auto.getState().status).toBe("ACTIVE");
  });
  it("finishes a one-track playlist and leaves the queue off", async () => {
    const { auto, playlist, audio } = await setup();
    await auto.start(playlist.id, "c");
    audio.fire({ type: "ended", deck: 0 }); auto.tick();
    expect(auto.getState()).toMatchObject({ status: "OFF", message: "Playlist complete" });
  });
  it("restarts the preserved queue after Stop without returning to the playlist screen", async () => {
    const { auto, playlist, engine } = await setup();
    await auto.start(playlist.id);
    auto.stop();
    expect(auto.getState()).toMatchObject({ status: "OFF", current: "a", upcoming: ["b", "c"] });
    expect(engine.getState().decks[0].playing).toBe(true);
    await auto.restart();
    expect(auto.getState()).toMatchObject({ status: "ACTIVE", current: "a", upcoming: ["b", "c"] });
    expect(engine.getState().decks[0].playing).toBe(true);
    expect(engine.getState().decks[1].track?.ref).toBe("b");
  });

  it("adds selected playlist tracks to play next in their selected order", async () => {
    const { auto, playlist } = await setup();
    await auto.start(playlist.id);
    auto.playNextRefs(["d", "c"]);
    expect(auto.getState().upcoming).toEqual(["d", "c", "b", "c"]);
  });

  it("restart recovers a session stopped during a transition to one controlled outgoing deck", async () => {
    const { auto, playlist, audio, engine } = await setup();
    await auto.start(playlist.id); auto.skip();
    expect(engine.getState().decks.every((d) => d.playing)).toBe(true);
    auto.stop(); await auto.restart();
    expect(auto.getState().status).toBe("ACTIVE");
    expect(audio.playing).toEqual([true, false]);
    expect(engine.getState().mixer.crossfader).toBe(0);
  });
});

describe("transition planning", () => {
  it("projects the exact playback plan into outgoing and incoming waveform regions", () => {
    const plan = { kind: "beat-mix" as const, mixOut: 180, mixIn: 16, seconds: 15, sync: true, reason: "test" };
    expect(transitionRegion(plan, 0, 0, 1, 240)).toEqual({ role: "out", label: "MIX OUT", start: 180, end: 195 });
    expect(transitionRegion(plan, 0, 1, 120 / 128, 240)).toEqual({ role: "in", label: "MIX IN", start: 16, end: 30.0625 });
  });
  it("uses the user-selected transition duration in the playback plan", async () => {
    const { engine, library } = await setup();
    await engine.loadTrack(0, library.getByRef("a")!); await engine.loadTrack(1, library.getByRef("b")!);
    const [a, b] = engine.getState().decks;
    expect(planTransition(a, b, { ...DEFAULT_AUTO_DJ, transitionSeconds: 15 }).seconds).toBe(15);
    expect(planTransition(a, b, { ...DEFAULT_AUTO_DJ, transitionSeconds: 30 }).seconds).toBe(30);
  });
  it("uses phrase boundaries and existing Sync for compatible grids, rejects extreme tempo changes", async () => {
    const { engine, library } = await setup();
    await engine.loadTrack(0, library.getByRef("a")!); await engine.loadTrack(1, library.getByRef("b")!);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0.1, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 124, firstBeat: 0.2, confidence: 3, source: "analysis" });
    let [a, b] = engine.getState().decks;
    const plan = planTransition(a, b, DEFAULT_AUTO_DJ);
    expect(plan.sync).toBe(true);
    expect((plan.mixOut - 0.1) / 32).toBeCloseTo(Math.round((plan.mixOut - 0.1) / 32));
    engine.setBeatGrid(1, { bpm: 170, firstBeat: 0, confidence: 3, source: "analysis" });
    [a, b] = engine.getState().decks;
    expect(planTransition(a, b, DEFAULT_AUTO_DJ)).toMatchObject({ sync: false, kind: "quick-fade" });
    expect(planTransition(a, b, { ...DEFAULT_AUTO_DJ, style: "beat-mix" }).sync).toBe(false);
  });
  it("beat-matches common 120 to 128 BPM transitions within the normal tempo range", async () => {
    const { engine, library } = await setup();
    await engine.loadTrack(0, library.getByRef("a")!); await engine.loadTrack(1, library.getByRef("b")!);
    engine.setBeatGrid(0, { bpm: 120, firstBeat: 0, confidence: 3, source: "analysis" });
    engine.setBeatGrid(1, { bpm: 128, firstBeat: 0, confidence: 3, source: "analysis" });
    expect(planTransition(engine.getState().decks[0], engine.getState().decks[1], DEFAULT_AUTO_DJ)).toMatchObject({ sync: true, kind: "beat-mix" });
  });
  it("handles Camelot, musical keys and unknown keys without inventing analysis", () => {
    expect(compatibleKeys("Am", "C major")).toBe(true);
    expect(compatibleKeys("12A", "1A")).toBe(true);
    expect(compatibleKeys("8A", "2A")).toBe(false);
    expect(compatibleKeys(null, "8A")).toBe(null);
  });
  it("keeps short-track transitions within both tracks", async () => {
    const { engine, library } = await setup(async () => new ArrayBuffer(2));
    await engine.loadTrack(0, library.getByRef("a")!); await engine.loadTrack(1, library.getByRef("b")!);
    const [a, b] = engine.getState().decks;
    const plan = planTransition(a, b, { ...DEFAULT_AUTO_DJ, bars: 32 });
    expect(plan.mixIn + plan.seconds).toBeLessThanOrEqual(2);
    expect(plan.mixOut + plan.seconds).toBeLessThanOrEqual(2);
  });
  it("browser file references survive reselection and distinguish different files", () => {
    const f = { name: "Track.wav", size: 100, lastModified: 42 };
    expect(browserFileRef(f)).toBe(browserFileRef({ ...f }));
    expect(browserFileRef(f)).not.toBe(browserFileRef({ ...f, size: 101 }));
  });
});

/**
 * Four-deck workspace (docs/architecture/four-deck-performance-engine.md §5, §6, §16, §29 "Interface"):
 * persisted 2/4 DECK mode and densities, mode switching that never touches playback, the master clip
 * guard, Auto DJ staying on its own decks, and the four-deck keyboard shortcuts.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, migrateWorkspace, mixerLayout, WORKSPACE_KEY, WorkspaceStore, workspaceDecks, type WorkspaceStorage } from "../src/workspace/WorkspaceStore";
import { DeckLayers } from "../src/controllers/layers";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import { EventLog } from "../src/core/log";
import { CLIP_KNEE, clipGuardCurve, clipGuardSample } from "../src/audio/clipGuard";
import { AutoDJ } from "../src/autodj/AutoDJ";
import { LibraryStore } from "../src/library/LibraryStore";
import { PlaylistStore } from "../src/library/PlaylistStore";
import { applyKeymapOverrides, DEFAULT_KEYMAP, REBINDABLE_ACTIONS } from "../src/input/keyboard";
import { actionCatalog } from "../src/core/actions";
import { FakeAudioEngine } from "./fakes";

const memory = (): WorkspaceStorage & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("workspace preferences", () => {
  it("default: two decks, C/D compact, C A | B D mixer order", () => {
    expect(new WorkspaceStore(memory()).get()).toEqual(DEFAULT_WORKSPACE);
    expect(DEFAULT_WORKSPACE).toMatchObject({ deckMode: 2, density: ["compact", "compact"], mixerOrder: "3-1-2-4" });
  });

  it("persists deck mode, densities, lanes and mixer order across sessions", () => {
    const storage = memory();
    const a = new WorkspaceStore(storage);
    a.setDeckMode(4);
    a.setDensity(3, "micro");
    a.setLaneCollapsed(2, true);
    a.set({ mixerOrder: "1-2-3-4" });
    a.focus(3);
    const b = new WorkspaceStore(storage); // "restart"
    expect(b.get()).toMatchObject({ deckMode: 4, density: ["compact", "micro"], laneCollapsed: [false, false, true, false], mixerOrder: "1-2-3-4", focusedDeck: 3 });
    expect(JSON.parse(storage.data[WORKSPACE_KEY]).deckMode).toBe(4);
  });

  it("tolerates missing, old or hand-edited saved prefs", () => {
    expect(migrateWorkspace(null)).toEqual(DEFAULT_WORKSPACE);
    expect(migrateWorkspace({ deckMode: 3, density: ["huge"], focusedDeck: 9 })).toEqual(DEFAULT_WORKSPACE);
    const broken = memory();
    broken.setItem(WORKSPACE_KEY, "{not json");
    expect(new WorkspaceStore(broken).get()).toEqual(DEFAULT_WORKSPACE);
  });

  it("2 DECK focus on a hidden deck falls back to its side's principal deck", () => {
    const w = new WorkspaceStore(memory());
    w.setDeckMode(4);
    w.focus(2);
    w.setDeckMode(2);
    expect(w.get().focusedDeck).toBe(0);
    w.focus(3); // not a workspace deck in 2 DECK mode
    expect(w.get().focusedDeck).toBe(0);
  });

  it("decks and mixer strips per mode", () => {
    expect(workspaceDecks({ deckMode: 2 })).toEqual([0, 1]);
    expect(workspaceDecks({ deckMode: 4 })).toEqual([0, 1, 2, 3]);
    expect(mixerLayout({ deckMode: 2, mixerOrder: "3-1-2-4" })).toEqual({ left: [0], right: [1] });
    expect(mixerLayout({ deckMode: 4, mixerOrder: "3-1-2-4" })).toEqual({ left: [2, 0], right: [1, 3] });
    expect(mixerLayout({ deckMode: 4, mixerOrder: "1-2-3-4" })).toEqual({ left: [0, 1], right: [2, 3] });
  });

  it("density changes only apply to decks C and D", () => {
    const w = new WorkspaceStore(memory());
    w.setDensity(0, "micro");
    w.setDensity(2, "full");
    expect(w.get().density).toEqual(["full", "compact"]);
    expect(w.densityOf(0)).toBe("full");
  });
});

describe("switching 2 DECK / 4 DECK never touches playback", () => {
  it("repeated switching while four decks play sends nothing to the audio engine and changes no deck or mixer state", async () => {
    const bus = new CommandBus();
    const audio = new FakeAudioEngine(4);
    const engine = new DJEngine({ bus, audio, log: new EventLog(), deckCount: 4, browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(300) });
    for (let i = 0; i < 4; i++) await engine.loadTrack(i, { ref: `t${i}`, title: `t${i}`, artist: "", album: "", source: "local", bpm: null, key: null });
    for (let d = 1; d <= 4; d++) bus.send(`deck${d}.play`, 1, "ui");
    audio.setLoop(2, { start: 1, end: 3 });
    bus.send("mixer.channel4.eq.high", 0.1, "ui");
    const workspace = new WorkspaceStore(memory());
    const layers = new DeckLayers();
    workspace.on("change", (p) => layers.setEnabled(p.deckMode === 4));
    const state = engine.getState();
    const calls = audio.calls.length;
    for (let i = 0; i < 50; i++) {
      workspace.toggleDeckMode();
      if (workspace.get().deckMode === 4) layers.set("left", 2);
    }
    expect(audio.calls.length).toBe(calls);
    expect(engine.getState()).toBe(state); // not even a new snapshot
    expect(audio.playing).toEqual([true, true, true, true]);
    expect(layers.getState()).toMatchObject({ enabled: false, left: 0, right: 1 }); // 50 toggles → back in 2 DECK
  });
});

describe("master clip protection", () => {
  it("is exactly linear below -1 dBFS and never exceeds full scale (0 dBFS) above it", () => {
    for (const x of [0, 0.001, -0.3, 0.5, -0.8, CLIP_KNEE]) expect(clipGuardSample(x)).toBe(x);
    for (const x of [0.95, 1, 1.5, 2, 4, -4]) {
      expect(Math.abs(clipGuardSample(x))).toBeLessThanOrEqual(1);
      expect(Math.abs(clipGuardSample(x))).toBeGreaterThan(CLIP_KNEE);
    }
    expect(clipGuardSample(2)).toBeGreaterThan(clipGuardSample(1.2)); // monotonic
  });

  it("the shaper curve maps zero exactly and is linear in its normal range", () => {
    const c = clipGuardCurve();
    expect(c.length % 2).toBe(1);
    expect(c[(c.length - 1) / 2]).toBe(0);
    const at = (x: number) => c[Math.round(((x / 4 + 1) / 2) * (c.length - 1))] * 4;
    expect(at(0.5)).toBeCloseTo(0.5, 6);
    expect(at(3)).toBeLessThanOrEqual(1);
  });
});

describe("Auto DJ with four decks", () => {
  async function setup() {
    const bus = new CommandBus(), audio = new FakeAudioEngine(4), library = new LibraryStore(), playlists = new PlaylistStore(null);
    library.addFiles(["a", "b", "c", "x"].map((ref) => ({ ref, name: ref + ".wav" })));
    const engine = new DJEngine({ bus, audio, log: new EventLog(), deckCount: 4, browser: library, loadBytes: async () => new ArrayBuffer(180) });
    const auto = new AutoDJ({ engine, bus, audio, library, playlists, analysis: { get: () => null } });
    const playlist = playlists.create("Set", ["a", "b", "c"]);
    return { bus, audio, library, engine, auto, playlist };
  }
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  it("a manually playing deck C neither blocks Auto DJ nor gets loaded, played or synced by it", async () => {
    const { bus, engine, auto, playlist, library } = await setup();
    await engine.loadTrack(2, library.getByRef("x")!);
    bus.send("deck3.play", 1, "ui");
    await auto.start(playlist.id);
    await settle();
    expect(auto.getState().status).toBe("ACTIVE");
    expect(engine.getState().decks.slice(0, 2).map((d) => d.track?.ref)).toEqual(["a", "b"]);
    expect(engine.getState().decks[2]).toMatchObject({ playing: true, sync: false });
    expect(engine.getState().decks[2].track?.ref).toBe("x");
  });

  it("resume continues from deck A/B, ignoring a playing deck C", async () => {
    const { bus, engine, auto, playlist, library } = await setup();
    await auto.start(playlist.id);
    await settle();
    auto.pause();
    await engine.loadTrack(2, library.getByRef("x")!);
    bus.send("deck3.play", 1, "ui");
    auto.resume();
    await settle();
    expect(auto.getState().status).toBe("ACTIVE");
    expect(auto.getState().deck).toBe(0);
  });
});

describe("four-deck keyboard shortcuts", () => {
  it("every rebindable action exists in the action catalogue and has a default", () => {
    for (const a of REBINDABLE_ACTIONS) {
      expect(actionCatalog().has(a)).toBe(true);
      expect(DEFAULT_KEYMAP.some((k) => k.action === a)).toBe(true);
    }
  });

  it("no two default shortcuts share a key combination", () => {
    const sig = (k: (typeof DEFAULT_KEYMAP)[number]) => `${k.code}|${!!k.shift}|${!!k.ctrl}|${!!k.alt}`;
    const seen = new Set<string>();
    for (const k of DEFAULT_KEYMAP) {
      expect(seen.has(sig(k)), sig(k)).toBe(false);
      seen.add(sig(k));
    }
  });

  it("rebinding replaces the action's key, frees a key it takes from another action, and null clears it", () => {
    const map = applyKeymapOverrides(DEFAULT_KEYMAP, { "workspace.deckMode.toggle": { code: "KeyC" } });
    expect(map.filter((k) => k.action === "workspace.deckMode.toggle")).toEqual([{ code: "KeyC", action: "workspace.deckMode.toggle" }]);
    expect(map.some((k) => k.code === "KeyC" && !k.shift && !k.ctrl && !k.alt && k.action === "deck1.cue")).toBe(false);
    expect(applyKeymapOverrides(DEFAULT_KEYMAP, { "browser.load.focused": null }).some((k) => k.action === "browser.load.focused")).toBe(false);
  });
});

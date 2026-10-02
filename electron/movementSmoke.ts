/**
 * DBDJ_SMOKE_MOVEMENT=/path/beat-track.wav: patches two generic moving heads, plays the
 * track on deck A through the real audio graph, switches on sound control + movement and
 * samples the DMX engine's pan/tilt output, then opens the Lighting page (screenshot).
 */
import type { BrowserWindow } from "electron";

export async function runMovementSmoke(win: BrowserWindow, file: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    const l = a.lighting;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const head = l.defs.find((d) => d.id === "generic/moving-head");
    const mode = head.modes[0];
    for (const [id, name, address] of [["mh1", "Head Left", 1], ["mh2", "Head Right", 21]])
      l.saveFixture({ id, name, defId: head.id, mode: mode.name, universe: 1, address, channelCount: mode.channels.length }, true);
    await a.engine.loadTrack(0, { ref: ${JSON.stringify(file)}, title: "beat", artist: "", album: "", source: "local", bpm: null, key: null });
    for (let i = 0; i < 100 && !a.engine.getState().decks[0].beatGrid; i++) await sleep(100);
    a.bus.send("mixer.channel1.volume", 0.25);
    a.bus.send("mixer.crossfader", 0);
    a.bus.send("deck1.play");
    l.setSound({ fixtures: ["mh1", "mh2"], source: "master" });
    a.bus.send("lighting.sound.enable");
    a.bus.send("lighting.sound.movement");
    l.setMovement({ pattern: "circle", beatsPerCycle: 4, size: 0.4, spread: 0, mirror: true });
    const pos = (out, addr) => ({ pan: +(((out[addr - 1] << 8) | out[addr]) / 65535).toFixed(3), tilt: +(((out[addr + 1] << 8) | out[addr + 2]) / 65535).toFixed(3) });
    const samples = [];
    for (let i = 0; i < 16; i++) {
      await sleep(250);
      const out = l.engine.compute(1);
      samples.push({ t: i * 0.25, left: pos(out, 1), right: pos(out, 21), dimmer: out[5] });
    }
    const meters = l.sound.meters;
    const pans = samples.map((s) => s.left.pan), tilts = samples.map((s) => s.left.tilt);
    const result = {
      beatGrid: a.engine.getState().decks[0].beatGrid,
      beatFrom: meters.beatFrom, bpm: meters.bpm, signal: meters.signal,
      panRange: [Math.min(...pans), Math.max(...pans)], tiltRange: [Math.min(...tilts), Math.max(...tilts)],
      mirrored: samples.every((s) => Math.abs(s.left.pan + s.right.pan - 1) < 0.02),
      samples: samples.filter((_, i) => i % 2 === 0),
    };
    // Movement off → pan/tilt back to the desk (0 here).
    a.bus.send("lighting.sound.movement");
    await sleep(200);
    result.afterMovementOff = pos(l.engine.compute(1), 1);
    a.bus.send("lighting.sound.movement");
    a.bus.send("deck1.play");
    a.bus.send("mixer.channel1.volume", 0);
    // Show the Lighting page with the sound-to-light panel for the screenshot.
    document.querySelector('.main-navigation button[title="Lighting"]')?.click();
    await sleep(800);
    document.querySelector(".lx-movement")?.scrollIntoView({ block: "center" });
    await sleep(300);
    return result;
  })()`);
}

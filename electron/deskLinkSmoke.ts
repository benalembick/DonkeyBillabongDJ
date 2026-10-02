/**
 * DBDJ_SMOKE_DESKLINK=/path/beat-track.wav: links DMX Desk channels to sound (a moving
 * head's gobo stepping on the beat, an unpatched channel following the highs), plays the
 * track through the real audio graph and samples the output; leaves the desk's link
 * editor open for the screenshot.
 */
import type { BrowserWindow } from "electron";

export async function runDeskLinkSmoke(win: BrowserWindow, file: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    const l = a.lighting;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const head = l.defs.find((d) => d.id === "generic/moving-head");
    l.saveFixture({ id: "mh1", name: "Head Left", defId: head.id, mode: head.modes[0].name, universe: 1, address: 1, channelCount: head.modes[0].channels.length }, true);
    // Gobo = channel 9 of the 11-channel head.
    l.setChannelLink(1, 9, { source: "beat", mode: "step", min: 0, max: 255, steps: 4, useRanges: false });
    l.setChannelLink(1, 20, { source: "high", mode: "follow", min: 0, max: 255, steps: 8, useRanges: false });
    l.setDesk(1, 20, 255); // the desk fader is overridden while linked
    await a.engine.loadTrack(0, { ref: ${JSON.stringify(file)}, title: "beat", artist: "", album: "", source: "local", bpm: null, key: null });
    for (let i = 0; i < 100 && !a.engine.getState().decks[0].beatGrid; i++) await sleep(100);
    a.bus.send("mixer.channel1.volume", 0.25);
    a.bus.send("mixer.crossfader", 0);
    a.bus.send("deck1.play");
    a.bus.send("lighting.sound.enable");
    const gobo = [], highs = [];
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const out = l.engine.compute(1);
      gobo.push(out[8]);
      highs.push(out[19]);
    }
    const changes = gobo.filter((v, i) => i > 0 && v !== gobo[i - 1]).length;
    const result = {
      bpm: l.sound.meters.bpm, beatFrom: l.sound.meters.beatFrom,
      goboValues: [...new Set(gobo)].sort((x, y) => x - y), goboChangesIn4s: changes,
      highsRange: [Math.min(...highs), Math.max(...highs)],
    };
    a.bus.send("lighting.sound.enable");
    await sleep(150);
    result.afterSoundOff = { gobo: l.engine.compute(1)[8], ch20: l.engine.compute(1)[19] };
    a.bus.send("lighting.sound.enable");
    a.bus.send("mixer.channel1.volume", 0);
    // Open the DMX Desk with the gobo's link editor for the screenshot.
    document.querySelector('.main-navigation button[title="Lighting"]')?.click();
    await sleep(600);
    [...document.querySelectorAll(".lx-tabs button")].find((b) => /DMX Desk/.test(b.textContent))?.click();
    await sleep(400);
    [...document.querySelectorAll(".lx-fader")][8]?.querySelector(".lx-link")?.click();
    await sleep(400);
    return result;
  })()`);
}

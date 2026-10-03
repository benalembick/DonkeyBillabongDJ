/**
 * DBDJ_SMOKE_LOOKS=/path/beat-track.wav: per-fixture sound setup and strobe in the app —
 * 4 PARs + a moving head, PAR 2 fixed blue on the beat, PAR 3 on the highs, PAR 4 strobing on
 * drops; plays the track, samples the DMX output, holds the manual STROBE (the mappable action),
 * and leaves the Lighting page with the per-fixture table open for the screenshot.
 */
import type { BrowserWindow } from "electron";

export async function runLooksSmoke(win: BrowserWindow, file: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj, l = a.lighting, bus = a.bus;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const par = l.defs.find((d) => d.id === "generic/rgb-par"), head = l.defs.find((d) => d.id === "generic/moving-head");
    for (let i = 0; i < 4; i++) l.saveFixture({ id: "par" + (i + 1), name: "PAR " + (i + 1), defId: par.id, mode: par.modes[0].name, universe: 1, address: 1 + i * 5, channelCount: 5 }, true);
    l.saveFixture({ id: "spider", name: "Spider", defId: head.id, mode: head.modes[1].name, universe: 1, address: 21, channelCount: 8 }, true);
    l.setSound({ fixtures: ["par1", "par2", "par3", "par4", "spider"], source: "master" });
    l.setFixtureLook("par2", { drive: "beat", colour: "#0040ff" });
    l.setFixtureLook("par3", { drive: "high" });
    l.setFixtureLook("par4", { strobeOnDrop: true });
    await a.engine.loadTrack(0, { ref: ${JSON.stringify(file)}, title: "beat", artist: "", album: "", source: "local", bpm: null, key: null });
    for (let i = 0; i < 100 && !a.engine.getState().decks[0].beatGrid; i++) await sleep(100);
    a.bus.send("mixer.channel1.volume", 0.25); a.bus.send("mixer.crossfader", 0);
    a.bus.send("deck1.play");
    bus.send("lighting.sound.enable");
    const read = () => { const o = l.engine.compute(1); return { par1: [o[0], o[1], o[2], o[3]], par2: [o[5], o[6], o[7], o[8]], par3: [o[10], o[11], o[12], o[13]], par4strobe: o[19], spider: [o[22], o[23], o[24], o[25]] }; };
    const samples = [];
    for (let i = 0; i < 12; i++) { await sleep(120); samples.push(read()); }
    const par2Blue = samples.every((s) => s.par2[0] === 0 && s.par2[1] < 80); // red off, green low → blue look
    const par2DimmerRange = [Math.min(...samples.map((s) => s.par2[3])), Math.max(...samples.map((s) => s.par2[3]))];
    // Manual STROBE: hold via the mappable action (as a controller pad would), then release.
    bus.send("lighting.strobe", 1);
    const strobing = [];
    for (let i = 0; i < 10; i++) { await sleep(40); strobing.push(read()); }
    bus.send("lighting.strobe", 0);
    await sleep(150);
    const after = read();
    const result = {
      par2Blue, par2DimmerRange, par1Sample: samples[5].par1, par3Sample: samples[5].par3,
      duringStrobe: { par1StrobeCh: strobing[3].par1 && l.engine.compute(1)[4], par1: strobing[3].par1, spiderValues: [...new Set(strobing.map((s) => s.spider[2]))] },
      strobeAfterRelease: { manual: l.sound.manualStrobe, par1StrobeCh: l.engine.compute(1)[4] },
      dropsKnown: l.sound.dropsKnown,
    };
    a.bus.send("mixer.channel1.volume", 0);
    // Lighting page, sound widget with the per-fixture table open.
    document.querySelector('.main-navigation button[title="Lighting"]')?.click();
    await sleep(800);
    document.querySelector(".lx-looks")?.setAttribute("open", "");
    document.querySelector(".lx-looks")?.scrollIntoView({ block: "start" });
    await sleep(400);
    return result;
  })()`);
}

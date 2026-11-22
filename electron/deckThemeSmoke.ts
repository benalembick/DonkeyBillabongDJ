/**
 * DBDJ_SMOKE_DECKS="/path/a.wav;/path/b.wav" (+ DBDJ_SMOKE_DECKS_SHOTS=/dir): loads one track on
 * each deck, plays both muted (channel faders at 0), and screenshots the DJ view twice — the
 * default deck colour identity with Dual-Deck Tonal waveforms, then with deck B's LOW killed
 * (EQ-reactive waveform). Reports what the deck colour CSS variables resolved to.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

export async function runDeckThemeSmoke(win: BrowserWindow, files: string, shotsDir: string): Promise<unknown> {
  const [a, b] = files.split(";");
  const shot = async (name: string) => {
    if (!shotsDir) return null;
    const p = path.join(shotsDir, name);
    await fs.writeFile(p, (await win.webContents.capturePage()).toPNG());
    return p;
  };
  const load = (file: string) => JSON.stringify({ ref: file, title: path.basename(file, path.extname(file)), artist: "smoke", album: "", source: "local", bpm: null, key: null });
  const loaded = await win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await a.engine.loadTrack(0, ${load(a)});
    await a.engine.loadTrack(1, ${load(b)});
    for (let i = 0; i < 150 && !(a.engine.getState().decks[0].beatGrid && a.engine.getState().decks[1].beatGrid); i++) await sleep(100);
    a.bus.send("mixer.channel1.volume", 0);
    a.bus.send("mixer.channel2.volume", 0);
    a.bus.send("deck1.seek", 0.27);
    a.bus.send("deck2.seek", 0.70);
    a.bus.send("deck1.play");
    await sleep(1500);
    const css = getComputedStyle(document.documentElement);
    const deckA = getComputedStyle(document.querySelector(".deck.deck-a"));
    const deckB = getComputedStyle(document.querySelector(".deck.deck-b"));
    return {
      decks: a.engine.getState().decks.map((d) => ({ status: d.status, playing: d.playing, bpm: d.beatGrid?.bpm })),
      vars: { a: css.getPropertyValue("--deck-a-primary"), b: css.getPropertyValue("--deck-b-primary"), aLow: css.getPropertyValue("--deck-a-low"), bHigh: css.getPropertyValue("--deck-b-high") },
      deckBorderTop: { a: deckA.borderTopColor, b: deckB.borderTopColor },
      playingClass: document.querySelector(".deck.deck-a").classList.contains("is-playing"),
    };
  })()`);
  const s1 = await shot("deck-theme-default.png");
  const eq = await win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    a.bus.send("deck2.play");
    a.bus.send("mixer.channel2.eq.low.kill");
    await new Promise((r) => setTimeout(r, 800));
    return { killLowB: a.engine.getState().mixer.channels[1].killLow };
  })()`);
  const s2 = await shot("deck-theme-b-low-killed.png");
  return { loaded, eq, shots: [s1, s2] };
}

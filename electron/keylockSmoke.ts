/**
 * DBDJ_SMOKE_KEYLOCK=/path/440hz.wav: plays a 440 Hz tone on deck A at +8% tempo with
 * key lock off and on, and measures the pitch at the master output (the app's own
 * analyser) and the playhead speed — the real worklet, in the real audio thread.
 */
import type { BrowserWindow } from "electron";

export async function runKeylockSmoke(win: BrowserWindow, file: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const a = window.dbdj;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await a.engine.loadTrack(0, { ref: ${JSON.stringify(file)}, title: "440", artist: "", album: "", source: "local", bpm: null, key: null });
    a.bus.send("mixer.channel1.volume", 0.3);
    a.bus.send("mixer.crossfader", 0);
    a.engine.setRateDirect?.(0, 1.08);
    const meter = a.audio.masterMeter;
    const sr = a.audio.getStatus().sampleRate;
    const buf = new Float32Array(meter.fftSize);
    // Zero-crossing pitch over many analyser frames.
    const pitch = async () => {
      let crossings = 0, samples = 0;
      for (let f = 0; f < 25; f++) {
        meter.getFloatTimeDomainData(buf);
        for (let i = 1; i < buf.length; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) crossings++;
        samples += buf.length - 1;
        await sleep(60);
      }
      return +((crossings / 2) / (samples / sr)).toFixed(1);
    };
    const speed = async () => { const p0 = a.engine.getPosition(0); await sleep(1000); return +(a.engine.getPosition(0) - p0).toFixed(3); };
    const out = { rate: a.engine.getState().decks[0].rate, fftSize: meter.fftSize };
    a.bus.send("deck1.play");
    await sleep(500);
    out.keylockOff = { pitchHz: await pitch(), speed: await speed() };
    a.bus.send("deck1.keylock");
    await sleep(300);
    out.keylockOn = { pitchHz: await pitch(), speed: await speed(), keylock: a.engine.getState().decks[0].keylock };
    a.bus.send("deck1.keylock");
    a.bus.send("deck1.play");
    a.bus.send("mixer.channel1.volume", 0);
    return out;
  })()`);
}

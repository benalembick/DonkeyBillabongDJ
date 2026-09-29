/**
 * Lighting acceptance smoke test (DBDJ_SMOKE_LIGHTING=run|verify), in the real app.
 * The main process plays the part of DMX nodes: an sACN receiver on 127.0.0.1:5568 and
 * an Art-Net receiver on 127.0.0.2:6454 — so every value is checked on the wire.
 */
import dgram from "node:dgram";
import type { BrowserWindow } from "electron";
import { parseArtDmx, parseE131 } from "../src/lighting/protocol";

interface Pkt {
  at: number;
  u: number;
  data: number[];
}

function listen(port: number, host: string, parse: (b: Uint8Array) => { u: number; data: Uint8Array } | null): Promise<{ got: Pkt[]; close: () => void; error?: string }> {
  return new Promise((resolve) => {
    const got: Pkt[] = [];
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("message", (m) => {
      const p = parse(new Uint8Array(m));
      if (p) got.push({ at: Date.now(), u: p.u, data: Array.from(p.data.subarray(0, 16)) });
    });
    s.on("error", (err) => resolve({ got, close: () => undefined, error: String(err) }));
    s.bind(port, host, () => resolve({ got, close: () => s.close() }));
  });
}

/** DBDJ_SMOKE_LIGHTING=usb: connect the real USB DMX adapter (dark frames only) and report what was detected. */
async function runUsbSmoke(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(
    `(async () => {
      const L = window.dbdj.lighting, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      L.deskClear();
      L.setIo(1, { output: "usb-pro" });
      await L.usb.connect(); // runs as a user gesture (executeJavaScript userGesture = true)
      const out = { state: L.usb.state, mode: L.usb.mode, detail: L.usb.detail, status: L.statusOf(1) };
      const f0 = L.usb.framesWritten;
      await sleep(2000);
      out.framesPerSecond = (L.usb.framesWritten - f0) / 2;
      out.stillOk = L.usb.state;
      out.allChannelsZero = Math.max(...L.engine.compute(1)) === 0;
      await L.usb.zero();
      await L.usb.disconnect();
      out.afterDisconnect = L.usb.state;
      return out;
    })()`,
    true,
  );
}

/** DBDJ_SMOKE_LIGHTING=qlc: import QLC+ files through the Fixtures page file picker (DBDJ_SMOKE_QLC_FILES = paths separated by "|"). */
async function runQlcSmoke(win: BrowserWindow): Promise<unknown> {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const files = (process.env.DBDJ_SMOKE_QLC_FILES ?? "").split("|").filter(Boolean).map((p) => ({ name: path.basename(p), text: readFileSync(p, "utf8") }));
  const tab = process.env.DBDJ_SMOKE_LIGHTING_TAB ?? "Fixtures";
  return win.webContents.executeJavaScript(`(async () => {
    const L = window.dbdj.lighting, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tabBtn = (t) => [...document.querySelectorAll(".lx-tabs button")].find((b) => b.textContent === t);
    [...document.querySelectorAll(".main-navigation button")].find((b) => (b.title || b.textContent).includes("Lighting"))?.click();
    await sleep(300);
    tabBtn("Fixtures")?.click();
    await sleep(200);
    const input = document.querySelector('.lx-qlc input[type="file"]');
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.text], f.name));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(800);
    const out = {
      report: document.querySelector(".lx-report")?.innerText,
      warning: document.querySelector(".lx-qlc .lx-warn")?.innerText,
      patch: L.getConfig().fixtures.map((f) => f.name + " @" + f.universe + ":" + f.address + "-" + (f.address + f.channelCount - 1)),
      universes: L.getConfig().universes.map((u) => u.universe),
    };
    tabBtn(${JSON.stringify(tab)})?.click();
    await sleep(400);
    if (${JSON.stringify(tab)} === "DMX Desk") out.deskLabels = [...document.querySelectorAll(".lx-fader")].slice(0, 16).map((f) => [f.querySelector(".lx-ch")?.textContent, f.querySelector(".lx-fix")?.textContent, f.querySelector(".lx-fn")?.textContent].join(" "));
    return out;
  })()`);
}

export async function runLightingSmoke(win: BrowserWindow, mode: string, track: string): Promise<unknown> {
  if (mode === "usb") return runUsbSmoke(win);
  if (mode === "qlc") return runQlcSmoke(win);
  const sacn = await listen(5568, "127.0.0.1", (b) => {
    const p = parseE131(b);
    return p ? { u: p.universe, data: p.data } : null;
  });
  const art = await listen(6454, "127.0.0.2", (b) => {
    const p = parseArtDmx(b);
    return p ? { u: p.portAddress, data: p.data } : null;
  });
  try {
    const r = (await win.webContents.executeJavaScript(`(async () => {
      const a = window.dbdj, L = a.lighting;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = {};
      const out = { mode: ${JSON.stringify(mode)} };
      // 1. Open LIGHTING from the main navigation.
      [...document.querySelectorAll(".main-navigation button")].find((b) => b.textContent.includes("Lighting"))?.click();
      await sleep(300);
      out.workspaceOpen = !!document.querySelector(".lx");
      if (${JSON.stringify(mode)} === "verify") {
        const c = L.getConfig();
        const tabWanted = ${JSON.stringify(process.env.DBDJ_SMOKE_LIGHTING_TAB ?? "")};
        if (tabWanted) { [...document.querySelectorAll(".lx-tabs button")].find((b) => b.textContent === tabWanted)?.click(); await sleep(400); }
        out.restored = { fixtures: c.fixtures.map((f) => f.name + " @U" + f.universe + ":" + f.address), universes: c.universes.map((u) => u.universe + ":" + u.output), soundFixtures: c.sound.fixtures, master: c.master };
        return out;
      }
      // 2-3. Add a fixture (through the Fixtures page form) and assign universe/address.
      [...document.querySelectorAll(".lx-tabs button")].find((b) => b.textContent === "Fixtures")?.click();
      await sleep(200);
      const nameInput = document.querySelector('.lx-form input:not([type="number"]):not([readonly])');
      const setVal = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
      setVal(nameInput, "Front PAR Left");
      await sleep(50);
      [...document.querySelectorAll(".lx-panel button")].find((b) => b.textContent === "Add fixture")?.click();
      await sleep(200);
      out.addedViaUi = L.getConfig().fixtures.map((f) => ({ name: f.name, universe: f.universe, address: f.address, channels: f.channelCount }));
      const par = L.getConfig().fixtures[0];
      const clash = L.saveFixture({ id: "smoke-clash", name: "Clash", defId: "generic/rgb-par", mode: par.mode, universe: 1, address: 3, channelCount: 5 });
      out.overlapRefused = !clash.ok && (clash.overlaps || []).map((o) => o.name);
      L.saveFixture({ id: "smoke-bar", name: "LED Bar", defId: "generic/led-bar", mode: "4-channel (dimmer + RGB)", universe: 1, address: 6, channelCount: 4 });
      // 4. Outputs: universe 1 → sACN (unicast to the test receiver), universe 2 → Art-Net.
      L.setIo(1, { output: "sacn", sacn: { universe: 1, priority: 100, host: "127.0.0.1" } });
      const u2 = L.addUniverse();
      L.setIo(u2, { output: "artnet", artnet: { host: "127.0.0.2", portAddress: 1, inputPortAddress: 1 } });
      await sleep(600);
      out.status = { u1: L.statusOf(1), u2: L.statusOf(u2) };
      // 5-7. DMX Desk: move channels; values go out on the wire.
      [...document.querySelectorAll(".lx-tabs button")].find((b) => b.textContent === "DMX Desk")?.click();
      await sleep(200);
      out.deskLabels = [...document.querySelectorAll(".lx-fader")].slice(0, 6).map((f) => [f.querySelector(".lx-ch")?.textContent, f.querySelector(".lx-fix")?.textContent, f.querySelector(".lx-fn")?.textContent].join(" "));
      const fader = document.querySelector(".lx-fader input.vfader");
      setVal(fader, "200");
      L.setDesk(u2, 10, 123);
      t.desk = Date.now();
      await sleep(400);
      out.deskOutput = { u1ch1: L.engine.compute(1)[0], u2ch10: L.engine.compute(u2)[9] };
      L.deskClear();
      await sleep(200);
      // 8-13. Virtual Console → sound control on the PAR, music playing.
      [...document.querySelectorAll(".lx-tabs button")].find((b) => b.textContent === "Virtual Console")?.click();
      await sleep(200);
      const ref = ${JSON.stringify(track)};
      if (ref) {
        await a.engine.loadTrack(0, { ref, title: "light", artist: "", album: "", source: "local", bpm: null, key: null });
        for (let i = 0; i < 80 && !a.engine.getState().decks[0].beatGrid; i++) await sleep(100);
        a.bus.send("mixer.channel1.volume", 0.25);
        a.bus.send("mixer.crossfader", 0);
        if (!a.engine.getState().decks[0].playing) a.bus.send("deck1.play");
      }
      L.setSound({ fixtures: [par.id, "smoke-bar"], source: "master" });
      document.querySelector(".lx-enable")?.click(); // ENABLE SOUND CONTROL (UI → lighting.sound.enable)
      t.soundOn = Date.now();
      const beats = [];
      const offBeat = L.sound.on("beat", (b) => beats.push(b.downbeat ? "D" : "b"));
      const samples = [];
      let ticks = 0;
      const offTick = L.sound.on("meters", () => ticks++);
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const m = L.sound.meters;
        samples.push({ low: +m.low.toFixed(2), mid: +m.mid.toFixed(2), high: +m.high.toFixed(2), beat: +m.beat.toFixed(2), out: Array.from(L.engine.compute(1).slice(0, 9)) });
      }
      offBeat();
      offTick();
      out.lightingTicksPerSecond = ticks / 4;
      const col = (k) => samples.map((s) => s.out[k]);
      const spread = (xs) => Math.max(...xs) - Math.min(...xs);
      out.sound = {
        enabled: L.getConfig().sound.enabled,
        beatFrom: L.sound.meters.beatFrom, bpm: L.sound.meters.bpm, beats: beats.join(""),
        meterMax: { low: Math.max(...samples.map((s) => s.low)), mid: Math.max(...samples.map((s) => s.mid)), high: Math.max(...samples.map((s) => s.high)), beat: Math.max(...samples.map((s) => s.beat)) },
        parRedSpread: spread(col(0)), parGreenSpread: spread(col(1)), parBlueSpread: spread(col(2)), parDimmerSpread: spread(col(3)), parStrobeMax: Math.max(...col(4)),
        barDimmerSpread: spread(col(5)), barRedSpread: spread(col(6)),
        sample: samples[samples.length - 1],
        raw: L.sound.lastRaw,
      };
      // 14. Blackout (button in the Virtual Console).
      document.querySelector(".lx-widget .lx-blackout")?.click();
      t.blackout = Date.now();
      await sleep(500);
      out.blackout = { engine: L.engine.isBlackout(), outMax: Math.max(...L.engine.compute(1)) };
      document.querySelector(".lx-widget .lx-blackout")?.click();
      t.blackoutOff = Date.now();
      await sleep(300);
      out.afterBlackoutRestored = Math.max(...L.engine.compute(1)) > 0;
      a.bus.send("mixer.channel1.volume", 0);
      if (a.engine.getState().decks[0].playing) a.bus.send("deck1.play");
      await sleep(600); // let the config save
      out.times = t;
      return out;
    })()`)) as Record<string, unknown> & { times?: Record<string, number> };
    const t = r.times ?? {};
    const between = (list: Pkt[], from: number, to: number) => list.filter((p) => p.at >= from && p.at < to);
    const wire = t.desk
      ? {
          sacnPackets: sacn.got.length,
          artnetPackets: art.got.length,
          sacnDeskCh1: between(sacn.got, t.desk + 100, t.desk + 400).map((p) => p.data[0]).slice(-1)[0],
          artnetDeskCh10: between(art.got, t.desk + 100, t.desk + 400).map((p) => p.data[9]).slice(-1)[0],
          sacnSoundValuesCh1to3: [...new Set(between(sacn.got, t.soundOn + 500, t.blackout).map((p) => p.data.slice(0, 3).join(",")))].length,
          // Judged by packet order (UDP keeps order on loopback), not arrival time: from the first
          // all-zero frame after BLACKOUT, frames must stay dark until the one lit frame run after release.
          blackoutByOrder: (() => {
            const seq = sacn.got.filter((p) => p.at >= t.blackout - 200).map((p) => Math.max(...p.data) === 0);
            const firstDark = seq.indexOf(true);
            if (firstDark < 0) return "no dark frame received";
            const relit = seq.indexOf(false, firstDark);
            const darkAgain = relit < 0 ? -1 : seq.indexOf(true, relit);
            return darkAgain < 0 ? "clean (dark until release)" : "FLICKER: lit frame inside the blackout";
          })(),
          sacnAfterBlackoutMax: Math.max(0, ...between(sacn.got, t.blackoutOff + 150, t.blackoutOff + 300).map((p) => Math.max(...p.data))),
        }
      : null;
    return { ...r, wire, listenerErrors: [sacn.error, art.error].filter(Boolean) };
  } finally {
    sacn.close();
    art.close();
  }
}

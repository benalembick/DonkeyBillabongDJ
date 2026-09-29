/**
 * Main-process lighting: network DMX (Art-Net / sACN via NetDmx), the lighting config
 * file (<userData>/lighting.json) and safe shutdown (zero the outputs before quitting,
 * unless the user chose "hold last look").
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NetDmx } from "./dmxNet";
import { defaultIo, type ExitBehaviour, type UniverseIo } from "../../src/lighting/io";

const configFile = () => path.join(app.getPath("userData"), "lighting.json");

/** Only accept well-formed universe configs from the renderer. */
function sanitize(list: unknown): UniverseIo[] {
  if (!Array.isArray(list)) return [];
  const ok = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const ip = (v: unknown) => (typeof v === "string" && /^[0-9.]{7,15}$/.test(v.trim()) ? v.trim() : "");
  return list.slice(0, 64).flatMap((raw): UniverseIo[] => {
    const r = (raw ?? {}) as Partial<UniverseIo>;
    const u = ok(r.universe, 1, 32767, 0);
    if (!u) return [];
    const d = defaultIo(u);
    return [
      {
        universe: u,
        output: r.output === "artnet" || r.output === "sacn" || r.output === "usb-pro" ? r.output : "none",
        input: r.input === "artnet" ? "artnet" : "none",
        artnet: { host: ip(r.artnet?.host) || d.artnet.host, portAddress: ok(r.artnet?.portAddress, 0, 32767, d.artnet.portAddress), inputPortAddress: ok(r.artnet?.inputPortAddress, 0, 32767, d.artnet.inputPortAddress) },
        sacn: { universe: ok(r.sacn?.universe, 1, 63999, u), priority: ok(r.sacn?.priority, 0, 200, 100), host: ip(r.sacn?.host) || undefined },
      },
    ];
  });
}

export function registerLightingIpc(): void {
  const net = new NetDmx();
  let exit: ExitBehaviour = "blackout";
  const broadcast = (channel: string, ...args: unknown[]) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  };
  net.onStatus((u, s) => broadcast("dbdj:dmx:status", u, s));
  net.onInput((u, data) => broadcast("dbdj:dmx:input", u, data));

  ipcMain.handle("dbdj:lighting:load", async () => {
    try {
      return JSON.parse(await fs.readFile(configFile(), "utf8"));
    } catch {
      return null;
    }
  });
  ipcMain.handle("dbdj:lighting:save", async (_e, cfg: unknown) => {
    const tmp = configFile() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 1));
    await fs.rename(tmp, configFile());
  });
  ipcMain.handle("dbdj:dmx:configure", async (_e, list: unknown, exitBehaviour: unknown) => {
    exit = exitBehaviour === "hold" ? "hold" : "blackout";
    const io = sanitize(list);
    await net.configure(io);
    return io.map((c) => ({ universe: c.universe, status: net.getStatus(c.universe) }));
  });
  ipcMain.on("dbdj:dmx:frame", (_e, universe: unknown, data: unknown) => {
    if (typeof universe !== "number" || !(data instanceof Uint8Array)) return;
    net.frame(universe, data);
  });

  // Safe shutdown: lights to zero before the app exits (default), or hold the last look.
  let zeroed = false;
  app.on("before-quit", (e) => {
    if (zeroed) return;
    zeroed = true;
    if (exit !== "blackout") {
      net.close();
      return;
    }
    e.preventDefault();
    void net
      .zeroAll()
      .catch(() => undefined)
      .finally(() => {
        net.close();
        app.quit();
      });
  });
}

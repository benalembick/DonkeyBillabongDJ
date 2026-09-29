/**
 * Network DMX output/input for the main process (plain Node — no Electron APIs,
 * so it can be tested with real UDP sockets).
 *
 *  - Art-Net: ArtDmx to a node IP or broadcast (port 6454). ArtPoll every 3 s;
 *    a universe is "connected" only when a node actually answers (ArtPollReply).
 *    Optional Art-Net *input*: ArtDmx received for a universe's port-address.
 *  - sACN / E1.31: multicast 239.255.x.y:5568 (or unicast to a host). sACN has no
 *    acknowledgement, so its status is "sending", never a claimed connection.
 *
 * Frames are re-sent every second when unchanged (sACN requires a keep-alive,
 * Art-Net nodes appreciate it). zeroAll() is used for safe shutdown.
 */
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import { ARTNET_PORT, SACN_PORT, artDmx, artPoll, e131Data, parseArtDmx, parseArtPollReply, sacnMulticast, DMX_SLOTS } from "../../src/lighting/protocol";
import type { UniverseIo, IoStatus } from "../../src/lighting/io";

type Listener = (u: number, s: IoStatus) => void;

export interface NetOptions {
  /** Local port Art-Net replies/input are received on (6454; tests use another). */
  artnetPort?: number;
  /** Port Art-Net packets are sent to (6454; tests use another so a fake node can listen). */
  artnetDestPort?: number;
  sacnPort?: number;
  pollIntervalMs?: number;
  keepAliveMs?: number;
  sourceName?: string;
}

interface Node {
  ip: string;
  name: string;
  seen: number;
}

export class NetDmx {
  private cfg = new Map<number, UniverseIo>();
  private last = new Map<number, Uint8Array>();
  private lastSent = new Map<number, number>();
  private seq = new Map<number, number>();
  private status = new Map<number, IoStatus>();
  private art: dgram.Socket | null = null;
  private artReady: Promise<void> | null = null;
  private artError: string | null = null;
  private sacn: dgram.Socket | null = null;
  private nodes = new Map<string, Node>();
  private timers: NodeJS.Timeout[] = [];
  private readonly cid = randomBytes(16);
  private readonly opts: Required<NetOptions>;
  private statusListener: Listener = () => undefined;
  private inputListener: (u: number, data: Uint8Array) => void = () => undefined;

  constructor(opts: NetOptions = {}) {
    this.opts = { artnetPort: ARTNET_PORT, artnetDestPort: opts.artnetPort ?? ARTNET_PORT, sacnPort: SACN_PORT, pollIntervalMs: 3000, keepAliveMs: 1000, sourceName: "DonkeyBillabongDJ", ...opts };
  }

  onStatus(l: Listener): void {
    this.statusListener = l;
  }
  onInput(l: (u: number, data: Uint8Array) => void): void {
    this.inputListener = l;
  }

  getStatus(u: number): IoStatus {
    return this.status.get(u) ?? { output: "disabled", input: "disabled", detail: "" };
  }

  /** Apply the full set of universe I/O configurations. */
  async configure(list: UniverseIo[]): Promise<void> {
    const next = new Map(list.map((c) => [c.universe, c]));
    for (const u of [...this.cfg.keys()]) if (!next.has(u)) this.cfg.delete(u);
    for (const [u, c] of next) this.cfg.set(u, c);
    const needArt = list.some((c) => c.output === "artnet" || c.input === "artnet");
    const needSacn = list.some((c) => c.output === "sacn");
    if (needArt) await this.openArt();
    if (needSacn) this.openSacn();
    this.ensureTimers(needArt);
    for (const u of this.cfg.keys()) this.refreshStatus(u);
  }

  /** A new frame for a universe (sent immediately if its output is network-based). */
  frame(u: number, data: Uint8Array): void {
    const c = this.cfg.get(u);
    const copy = new Uint8Array(DMX_SLOTS);
    copy.set(data.subarray(0, DMX_SLOTS));
    this.last.set(u, copy);
    if (c) this.send(c, copy);
  }

  /** Safe shutdown: send zeros on every network output (a few times, UDP is lossy). */
  async zeroAll(): Promise<void> {
    const zero = new Uint8Array(DMX_SLOTS);
    for (let i = 0; i < 3; i++) {
      for (const c of this.cfg.values()) this.send(c, zero);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try {
      this.art?.close();
    } catch {
      /* already closed */
    }
    try {
      this.sacn?.close();
    } catch {
      /* already closed */
    }
    this.art = this.sacn = null;
    this.artReady = null;
  }

  // ───────────────────────── internals ─────────────────────────

  private send(c: UniverseIo, data: Uint8Array): void {
    const seq = ((this.seq.get(c.universe) ?? 0) % 255) + 1;
    this.seq.set(c.universe, seq);
    this.lastSent.set(c.universe, Date.now());
    try {
      if (c.output === "artnet" && this.art && !this.artError) {
        this.art.send(artDmx(c.artnet.portAddress, data, seq), this.opts.artnetDestPort, c.artnet.host || "255.255.255.255");
      } else if (c.output === "sacn" && this.sacn) {
        const host = c.sacn.host?.trim() || sacnMulticast(c.sacn.universe);
        this.sacn.send(e131Data(c.sacn.universe, data, seq, this.cid, this.opts.sourceName, c.sacn.priority), this.opts.sacnPort, host);
      }
    } catch (err) {
      this.setStatus(c.universe, { ...this.getStatus(c.universe), output: "error", detail: String(err) });
    }
  }

  private openArt(): Promise<void> {
    if (this.artReady) return this.artReady;
    this.artError = null;
    this.artReady = new Promise<void>((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      s.on("error", (err) => {
        this.artError = `Art-Net socket: ${err.message}`;
        for (const u of this.cfg.keys()) this.refreshStatus(u);
        resolve();
      });
      s.on("message", (msg, rinfo) => this.onArt(new Uint8Array(msg), rinfo.address));
      s.bind(this.opts.artnetPort, () => {
        try {
          s.setBroadcast(true);
        } catch {
          /* ignore */
        }
        resolve();
      });
      this.art = s;
    });
    return this.artReady;
  }

  private openSacn(): void {
    if (this.sacn) return;
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("error", (err) => {
      for (const c of this.cfg.values()) if (c.output === "sacn") this.setStatus(c.universe, { ...this.getStatus(c.universe), output: "error", detail: `sACN socket: ${err.message}` });
    });
    s.bind(0, () => {
      try {
        s.setMulticastTTL(8);
      } catch {
        /* ignore */
      }
    });
    this.sacn = s;
  }

  private onArt(b: Uint8Array, from: string): void {
    const reply = parseArtPollReply(b);
    if (reply) {
      this.nodes.set(from, { ip: from, name: reply.longName || reply.shortName || from, seen: Date.now() });
      for (const u of this.cfg.keys()) this.refreshStatus(u);
      return;
    }
    const dmx = parseArtDmx(b);
    if (!dmx) return;
    for (const c of this.cfg.values()) if (c.input === "artnet" && c.artnet.inputPortAddress === dmx.portAddress) {
      this.inputListener(c.universe, dmx.data);
      const st = this.getStatus(c.universe);
      if (st.input !== "connected") this.setStatus(c.universe, { ...st, input: "connected" });
      this.lastInput.set(c.universe, Date.now());
    }
  }
  private lastInput = new Map<number, number>();

  private ensureTimers(art: boolean): void {
    if (this.timers.length) return;
    // Keep-alive: resend unchanged frames at least once a second.
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        for (const c of this.cfg.values()) {
          const last = this.last.get(c.universe);
          if (last && now - (this.lastSent.get(c.universe) ?? 0) >= this.opts.keepAliveMs) this.send(c, last);
          // Input goes quiet → disconnected.
          if (c.input === "artnet" && now - (this.lastInput.get(c.universe) ?? 0) > 3000) {
            const st = this.getStatus(c.universe);
            if (st.input === "connected") this.setStatus(c.universe, { ...st, input: "disconnected" });
          }
        }
      }, Math.max(100, Math.floor(this.opts.keepAliveMs / 2))),
    );
    // Art-Net discovery.
    const poll = () => {
      if (!this.art || this.artError) return;
      const hosts = new Set<string>(["255.255.255.255"]);
      for (const c of this.cfg.values()) if (c.output === "artnet" && c.artnet.host) hosts.add(c.artnet.host);
      for (const h of hosts) this.art.send(artPoll(), this.opts.artnetDestPort, h, () => undefined);
      const stale = Date.now() - this.opts.pollIntervalMs * 3.5;
      let changed = false;
      for (const [ip, n] of this.nodes) if (n.seen < stale) {
        this.nodes.delete(ip);
        changed = true;
      }
      if (changed) for (const u of this.cfg.keys()) this.refreshStatus(u);
    };
    if (art) {
      poll();
      this.timers.push(setInterval(poll, this.opts.pollIntervalMs));
    }
  }

  private refreshStatus(u: number): void {
    const c = this.cfg.get(u);
    if (!c) return;
    const prev = this.getStatus(u);
    let output: IoStatus["output"] = "disabled";
    let detail = "";
    if (c.output === "artnet") {
      if (this.artError) {
        output = "error";
        detail = this.artError;
      } else {
        const host = c.artnet.host?.trim() || "255.255.255.255";
        const nodes = [...this.nodes.values()];
        const target = host === "255.255.255.255" || host.endsWith(".255") ? nodes : nodes.filter((n) => n.ip === host);
        output = target.length ? "connected" : "disconnected";
        detail = target.length ? `Art-Net node: ${target.map((n) => `${n.name} (${n.ip})`).join(", ")}` : `Sending to ${host} — no Art-Net node has answered ArtPoll`;
      }
    } else if (c.output === "sacn") {
      output = "sending";
      detail = `sACN universe ${c.sacn.universe} → ${c.sacn.host?.trim() || sacnMulticast(c.sacn.universe)} (no acknowledgement in sACN)`;
    }
    const input = c.input === "artnet" ? (this.artError ? "error" : prev.input === "connected" ? "connected" : "disconnected") : "disabled";
    this.setStatus(u, { output, input, detail });
  }

  private setStatus(u: number, s: IoStatus): void {
    const prev = this.status.get(u);
    if (prev && prev.output === s.output && prev.input === s.input && prev.detail === s.detail) return;
    this.status.set(u, s);
    this.statusListener(u, s);
  }
}

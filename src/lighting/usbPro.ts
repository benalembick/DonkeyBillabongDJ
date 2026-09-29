/**
 * USB DMX output through Web Serial (no native driver module). Two kinds of interface:
 *
 *  - Enttec DMX USB Pro protocol (Enttec Pro / Pro Mk2, DMXking ultraDMX Pro, compatibles):
 *    the interface has its own processor and generates DMX itself; we send "send DMX"
 *    messages (label 6). Detected by asking for its serial number (label 10) — it answers.
 *  - Open DMX (bare FTDI FT232 + RS-485 driver, incl. Enttec Open DMX and most cheap
 *    "USB to DMX" cables): the computer generates the DMX signal — BREAK (Web Serial
 *    setSignals), then start code + 512 slots at 250 kbaud 8N2, ~35 times a second.
 *    These can't report anything back, so their status is "sending", never "connected".
 *
 * Status is only "connected" after a Pro interface actually replied.
 */
import { DMX_SLOTS, enttecProDmx } from "./protocol";
import type { LinkState } from "./io";

interface SerialPortLike {
  open(opts: { baudRate: number; dataBits?: number; stopBits?: number; parity?: "none"; flowControl?: "none"; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(s: { break?: boolean; dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  readable: ReadableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(opts?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

export type UsbDmxMode = "pro" | "open";

const serial = (): SerialLike | null => (typeof navigator !== "undefined" && "serial" in navigator ? ((navigator as unknown as { serial: SerialLike }).serial ?? null) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find an Enttec Pro reply (0x7E, label, len LSB, len MSB, data…, 0xE7) in received bytes. */
export function findProReply(bytes: Uint8Array, label: number): Uint8Array | null {
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0x7e || bytes[i + 1] !== label) continue;
    const len = bytes[i + 2] | (bytes[i + 3] << 8);
    const end = i + 4 + len;
    if (len <= 600 && end < bytes.length && bytes[end] === 0xe7) return bytes.slice(i + 4, end);
  }
  return null;
}

/** Open DMX frame: start code 0 + 512 slots. */
export function openDmxFrame(data: Uint8Array): Uint8Array {
  const f = new Uint8Array(DMX_SLOTS + 1);
  f.set(data.subarray(0, DMX_SLOTS), 1);
  return f;
}

export class UsbProOutput {
  state: LinkState = "disconnected";
  detail = "Not connected";
  mode: UsbDmxMode | null = null;
  /** Frames actually written to the adapter (diagnostics / tests). */
  framesWritten = 0;
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private busy = false;
  private pending: Uint8Array | null = null;
  private latest = openDmxFrame(new Uint8Array(DMX_SLOTS));
  private looping = false;
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    if (!serial()) {
      this.state = "unavailable";
      this.detail = "Web Serial is not available in this environment";
    }
  }

  static supported(): boolean {
    return !!serial();
  }

  /** Reconnect to a previously granted port without prompting (app start). */
  async reconnect(): Promise<boolean> {
    const s = serial();
    if (!s) return false;
    const ports = await s.getPorts().catch(() => []);
    if (!ports.length) return false;
    await this.openPort(ports[0]);
    return this.state === "connected" || this.state === "sending";
  }

  /** Ask for a USB serial port (must be called from a user action). */
  async connect(): Promise<void> {
    const s = serial();
    if (!s) return;
    try {
      const port = await s.requestPort();
      await this.openPort(port);
    } catch (err) {
      const notFound = err instanceof DOMException && err.name === "NotFoundError";
      this.set(notFound ? "disconnected" : "error", notFound ? "No USB DMX interface found (FTDI-based or DMX-named USB serial device)" : String(err));
    }
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    await this.disconnect(false);
    const info = port.getInfo();
    const id = info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}` : "serial port";
    try {
      // 1) Enttec Pro protocol? Ask for the serial number and wait for a real reply.
      await port.open({ baudRate: 57600, bufferSize: 4096 });
      const serialNo = await this.askProSerial(port);
      if (serialNo) {
        this.port = port;
        this.writer = port.writable?.getWriter() ?? null;
        if (!this.writer) throw new Error("port is not writable");
        this.mode = "pro";
        this.set("connected", `Enttec DMX USB Pro-compatible interface (serial ${serialNo}) on ${id}`);
        return;
      }
      await port.close();
      // 2) No reply → bare FTDI "Open DMX" adapter: generate DMX ourselves at 250 kbaud 8N2.
      await port.open({ baudRate: 250000, dataBits: 8, stopBits: 2, parity: "none", flowControl: "none", bufferSize: 4096 });
      await port.setSignals({ break: false });
      this.port = port;
      this.writer = port.writable?.getWriter() ?? null;
      if (!this.writer) throw new Error("port is not writable");
      this.mode = "open";
      this.set("sending", `Open DMX (FTDI) adapter on ${id} — output only, it can't confirm the lights received it`);
      void this.openLoop();
    } catch (err) {
      this.mode = null;
      try {
        await port.close();
      } catch {
        /* ignore */
      }
      this.set("error", `Could not open the USB DMX interface: ${String(err)}`);
    }
  }

  /** Label 10 (get widget serial number); a Pro interface answers within a few ms. */
  private async askProSerial(port: SerialPortLike): Promise<string | null> {
    const w = port.writable?.getWriter();
    const r = port.readable?.getReader();
    if (!w || !r) return null;
    try {
      await w.write(new Uint8Array([0x7e, 10, 0, 0, 0xe7]));
      const got: number[] = [];
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const next = await Promise.race([r.read(), sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
        if (!next || next.done) break;
        got.push(...next.value);
        const reply = findProReply(new Uint8Array(got), 10);
        if (reply && reply.length >= 4) return Array.from(reply.subarray(0, 4)).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
        if (got.length > 4096) got.splice(0, got.length - 1024);
      }
      return null;
    } finally {
      await r.cancel().catch(() => undefined);
      r.releaseLock();
      w.releaseLock();
    }
  }

  /**
   * Open DMX refresh: BREAK (>88 µs; a setSignals round trip is ~1 ms), mark-after-break,
   * then start code + 512 slots (~22.6 ms at 250 kbaud 8N2). The next BREAK waits until the
   * frame has left the adapter, so frames are never cut short.
   */
  private async openLoop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.mode === "open" && this.port && this.writer) {
        const port = this.port;
        await port.setSignals({ break: true });
        await sleep(1);
        await port.setSignals({ break: false });
        await this.writer.write(this.latest);
        this.framesWritten++;
        await sleep(24);
      }
    } catch (err) {
      if (this.mode === "open") {
        this.set("error", `USB DMX output stopped (unplugged?): ${String(err)}`);
        await this.disconnect(false);
      }
    } finally {
      this.looping = false;
    }
  }

  /** Queue a frame. Pro: written on change. Open DMX: picked up by the refresh loop. Never blocks. */
  send(data: Uint8Array): void {
    if (this.mode === "open") {
      this.latest = openDmxFrame(data);
      return;
    }
    if (!this.writer || this.mode !== "pro") return;
    this.pending = enttecProDmx(data);
    if (!this.busy) void this.flush();
  }

  private async flush(): Promise<void> {
    this.busy = true;
    try {
      while (this.pending && this.writer) {
        const p = this.pending;
        this.pending = null;
        await this.writer.write(p);
        this.framesWritten++;
      }
    } catch (err) {
      this.set("error", `USB DMX write failed (unplugged?): ${String(err)}`);
      await this.disconnect(false);
    } finally {
      this.busy = false;
    }
  }

  /** Send a last all-zero frame (safe shutdown), then keep the port open. */
  async zero(): Promise<void> {
    this.send(new Uint8Array(DMX_SLOTS));
    if (this.mode === "open") await sleep(80); // let the loop send it at least twice
  }

  async disconnect(resetState = true): Promise<void> {
    const wasActive = this.state === "connected" || this.state === "sending";
    this.mode = null;
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.writer = null;
    this.port = null;
    if (resetState && wasActive) this.set("disconnected", "Disconnected");
  }

  private set(state: LinkState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.onChange();
  }
}

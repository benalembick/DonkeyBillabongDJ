/**
 * USB DMX output through Web Serial (no native driver module): interfaces that speak the
 * Enttec DMX USB Pro protocol ("send DMX", label 6) — Enttec DMX USB Pro / Pro Mk2,
 * DMXking ultraDMX, and compatible FTDI-based "USB Pro" interfaces.
 *
 * Not supported by this provider: raw FTDI "Open DMX" dongles (they need precise
 * break timing from the host, which a companion service would have to provide —
 * see docs/LIGHTING.md). Status only says "connected" after the port really opened
 * and writes succeed.
 */
import { enttecProDmx } from "./protocol";
import type { LinkState } from "./io";

interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(opts?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

const serial = (): SerialLike | null => (typeof navigator !== "undefined" && "serial" in navigator ? ((navigator as unknown as { serial: SerialLike }).serial ?? null) : null);

export class UsbProOutput {
  state: LinkState = "disconnected";
  detail = "Not connected";
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private busy = false;
  private pending: Uint8Array | null = null;
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
    return this.state === "connected";
  }

  /** Ask for a USB serial port (must be called from a user action). */
  async connect(): Promise<void> {
    const s = serial();
    if (!s) return;
    try {
      const port = await s.requestPort();
      await this.openPort(port);
    } catch (err) {
      this.set(err instanceof DOMException && err.name === "NotFoundError" ? "disconnected" : "error", err instanceof DOMException && err.name === "NotFoundError" ? "No USB DMX interface selected / found" : String(err));
    }
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    try {
      await this.disconnect();
      await port.open({ baudRate: 57600 });
      this.port = port;
      this.writer = port.writable?.getWriter() ?? null;
      if (!this.writer) throw new Error("port is not writable");
      const info = port.getInfo();
      this.set("connected", `USB DMX Pro on ${info.usbVendorId ? `VID ${info.usbVendorId.toString(16).padStart(4, "0")}:PID ${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}` : "serial port"}`);
    } catch (err) {
      this.set("error", `Could not open the USB DMX interface: ${String(err)}`);
    }
  }

  /** Queue a frame; only the newest pending frame is written (never blocks the caller). */
  send(data: Uint8Array): void {
    if (!this.writer || this.state !== "connected") return;
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
      }
    } catch (err) {
      this.set("error", `USB DMX write failed (unplugged?): ${String(err)}`);
      await this.disconnect(false);
    } finally {
      this.busy = false;
    }
  }

  async disconnect(resetState = true): Promise<void> {
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
    if (resetState && this.state === "connected") this.set("disconnected", "Disconnected");
  }

  private set(state: LinkState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.onChange();
  }
}

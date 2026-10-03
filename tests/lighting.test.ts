import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { NetDmx } from "../electron/lighting/dmxNet";
import { DmxEngine, LAYER_DESK, LAYER_SOUND } from "../src/lighting/DmxEngine";
import { addressRange, channelMap, GENERIC_FIXTURES, nextFreeAddress, overlaps, type PatchedFixture } from "../src/lighting/fixtures";
import { defaultIo, type IoStatus } from "../src/lighting/io";
import { artDmx, artPoll, e131Data, enttecProDmx, parseArtDmx, parseArtPollReply, parseE131, sacnMulticast } from "../src/lighting/protocol";
import { DEFAULT_LOOK, DEFAULT_STROBE, linkSteps, movementOffset, SoundToLight, STROBE_MAX_HZ, strobeChannelValue, type BandReading } from "../src/lighting/SoundToLight";

const frame = (pairs: [number, number][]) => {
  const d = new Uint8Array(512);
  for (const [c, v] of pairs) d[c - 1] = v;
  return d;
};

describe("DMX protocols", () => {
  it("ArtDmx: header, port-address, length and data", () => {
    const p = artDmx(0x0123, frame([[1, 255], [512, 7]]), 42);
    expect(new TextDecoder().decode(p.subarray(0, 7))).toBe("Art-Net");
    expect(p[8] | (p[9] << 8)).toBe(0x5000);
    expect(p[11]).toBe(14); // protocol version
    expect(p[12]).toBe(42);
    expect(p[14]).toBe(0x23); // SubUni
    expect(p[15]).toBe(0x01); // Net
    expect((p[16] << 8) | p[17]).toBe(512);
    expect(p[18]).toBe(255);
    expect(p[18 + 511]).toBe(7);
    expect(parseArtDmx(p)).toMatchObject({ portAddress: 0x0123, sequence: 42 });
    expect(artPoll().length).toBe(14);
  });

  it("E1.31: layer lengths, vectors, universe, priority, start code and slots", () => {
    const cid = new Uint8Array(16).fill(9);
    const p = e131Data(7, frame([[1, 200], [3, 1]]), 5, cid, "DBDJ", 120);
    expect(p.length).toBe(638);
    const dv = new DataView(p.buffer);
    expect(dv.getUint16(16) & 0x0fff).toBe(622); // root flags+length
    expect(dv.getUint16(38) & 0x0fff).toBe(600); // framing
    expect(dv.getUint16(115) & 0x0fff).toBe(523); // DMP
    expect(dv.getUint16(123)).toBe(513);
    expect(p[125]).toBe(0);
    const d = parseE131(p)!;
    expect(d).toMatchObject({ universe: 7, priority: 120, sequence: 5, sourceName: "DBDJ" });
    expect(d.data[0]).toBe(200);
    expect(d.data[2]).toBe(1);
    expect(sacnMulticast(7)).toBe("239.255.0.7");
    expect(sacnMulticast(300)).toBe("239.255.1.44");
  });

  it("Enttec USB Pro: label 6 message framing", () => {
    const p = enttecProDmx(frame([[1, 10]]));
    expect([p[0], p[1], p[2], p[3], p[4], p[5]]).toEqual([0x7e, 6, 513 & 0xff, 513 >> 8, 0, 10]);
    expect(p[p.length - 1]).toBe(0xe7);
    expect(p.length).toBe(518);
  });
});

describe("fixtures", () => {
  const par = (id: string, address: number, universe = 1): PatchedFixture => ({ id, name: id, defId: "generic/rgb-par", mode: GENERIC_FIXTURES[0].modes[0].name, universe, address, channelCount: 5 });

  it("computes the occupied range and detects overlaps per universe", () => {
    expect(addressRange(par("a", 21))).toEqual([21, 25]);
    const rig = [par("a", 21), par("b", 26), par("c", 21, 2)];
    expect(overlaps(rig, par("x", 24))).toHaveLength(2); // hits a (21–25) and b (26–30)
    expect(overlaps(rig, par("x", 31))).toHaveLength(0);
    expect(overlaps(rig, { ...par("x", 21), universe: 3 })).toHaveLength(0);
    expect(nextFreeAddress(rig, 1, 5)).toBe(1);
    expect(nextFreeAddress([par("a", 1)], 1, 5)).toBe(6);
  });

  it("labels channels with their fixture and function", () => {
    const m = channelMap(GENERIC_FIXTURES, [par("Front PAR 1", 1)], 1);
    expect(m[1]?.fixture.name).toBe("Front PAR 1");
    expect(m[1]?.channel.name).toBe("RED");
    expect(m[4]?.channel.type).toBe("intensity");
    expect(m[6]).toBeUndefined();
  });
});

describe("DmxEngine", () => {
  it("merges layers HTP; master scales intensity channels only; blackout is non-destructive", () => {
    const e = new DmxEngine();
    e.setChannel(LAYER_DESK, 1, 1, 100);
    e.setChannel(LAYER_SOUND, 1, 1, 200);
    e.setChannel(LAYER_DESK, 1, 2, 128);
    expect(e.compute(1)[0]).toBe(200);
    const mask = new Uint8Array(512).fill(1);
    mask[1] = 0; // channel 2 = pan: not scaled by the master
    e.setMasterMask(1, mask);
    e.setMaster(0.5);
    expect(e.compute(1)[0]).toBe(100);
    expect(e.compute(1)[1]).toBe(128);
    e.setBlackout(true);
    expect(Math.max(...e.compute(1))).toBe(0);
    e.setBlackout(false);
    expect(e.compute(1)[0]).toBe(100); // programmed state restored
    expect(e.getLayerValue(LAYER_DESK, 1, 1)).toBe(100);
  });

  it("supports several universes and clamps values", () => {
    const e = new DmxEngine();
    e.addUniverse(2);
    e.setChannel(LAYER_DESK, 2, 512, 999);
    expect(e.compute(2)[511]).toBe(255);
    expect(e.compute(1)[511]).toBe(0);
  });
});

describe("sound-to-light", () => {
  const rig = () => ({
    defs: GENERIC_FIXTURES,
    fixtures: [
      { id: "p", name: "PAR", defId: "generic/rgb-par", mode: GENERIC_FIXTURES[0].modes[0].name, universe: 1, address: 1, channelCount: 5 },
      { id: "q", name: "Other", defId: "generic/rgb-par", mode: GENERIC_FIXTURES[0].modes[0].name, universe: 1, address: 11, channelCount: 5 },
    ] as PatchedFixture[],
  });

  it("maps bass/mid/high to red/green/blue on selected fixtures, flashes on grid beats, never touches strobe", () => {
    const engine = new DmxEngine();
    let reading: BandReading = { low: 1, mid: 0.05, high: 0.05, amplitude: 1 };
    let beats = 0;
    const stl = new SoundToLight({ engine, probe: { read: () => reading }, beats: { beatPosition: () => ({ beats, bpm: 128 }) }, rig });
    stl.settings = { ...stl.settings, enabled: true, fixtures: ["p"] };
    const events: string[] = [];
    stl.on("beat", (b) => events.push(b.downbeat ? "downbeat" : "beat"));
    for (let i = 0; i < 100; i++) {
      beats += 128 / 60 / 40; // 128 BPM at 40 updates/s (2.5 s ≈ 5 beats, includes a downbeat)
      stl.update(1 / 40);
    }
    const out = engine.compute(1);
    expect(out[0]).toBeGreaterThan(150); // red ← bass
    expect(out[1]).toBeLessThan(out[0] / 3); // green ← little mid
    expect(out[3]).toBeGreaterThan(0); // dimmer
    expect(out[4]).toBe(0); // strobe untouched
    expect(Math.max(...out.subarray(10, 15))).toBe(0); // unselected fixture untouched
    expect(events.filter((e) => e === "beat").length).toBeGreaterThanOrEqual(2);
    expect(events).toContain("downbeat");
    reading = { low: 0.05, mid: 1, high: 0.05, amplitude: 1 };
    for (let i = 0; i < 80; i++) stl.update(1 / 40);
    const out2 = engine.compute(1);
    expect(out2[1]).toBeGreaterThan(out2[0]); // colour follows the music
    stl.settings = { ...stl.settings, enabled: false };
    stl.update(1 / 40);
    expect(Math.max(...engine.compute(1))).toBe(0); // disabling clears the sound layer
  });

  it("reacts to quiet monitoring levels too (auto-gain), and ignores true silence", () => {
    const engine = new DmxEngine();
    let amp = 0.0003; // about -70 dBFS
    let beats = 0;
    const stl = new SoundToLight({ engine, probe: { read: () => ({ low: amp, mid: amp / 2, high: amp / 4, amplitude: amp }) }, beats: { beatPosition: () => ({ beats, bpm: 120 }) }, rig });
    stl.settings = { ...stl.settings, enabled: true, fixtures: ["p"] };
    let count = 0;
    stl.on("beat", () => count++);
    for (let i = 0; i < 160; i++) {
      beats += 2 / 40;
      stl.update(1 / 40);
    }
    expect(count).toBeGreaterThanOrEqual(7); // 4 s at 120 BPM
    expect(engine.compute(1)[0]).toBeGreaterThan(100);
    amp = 0;
    count = 0;
    for (let i = 0; i < 80; i++) {
      beats += 2 / 40;
      stl.update(1 / 40);
    }
    expect(count).toBe(0);
  });

  it("uses the editable mappings, not hard-wired colours", () => {
    const engine = new DmxEngine();
    const stl = new SoundToLight({ engine, probe: { read: () => ({ low: 1, mid: 0, high: 0, amplitude: 1 }) }, beats: { beatPosition: () => null }, rig });
    stl.settings = { ...stl.settings, enabled: true, fixtures: ["p"], mappings: [{ input: "low", output: "blue", amount: 1 }, { input: "amplitude", output: "intensity", amount: 1 }] };
    for (let i = 0; i < 40; i++) stl.update(1 / 40);
    const out = engine.compute(1);
    expect(out[0]).toBe(0); // red no longer mapped
    expect(out[2]).toBeGreaterThan(150); // bass → blue
  });
});

describe("network output (real UDP on localhost)", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
  });
  const listen = (port: number) =>
    new Promise<{ sock: dgram.Socket; got: { msg: Uint8Array; port: number }[] }>((resolve) => {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      const got: { msg: Uint8Array; port: number }[] = [];
      sock.on("message", (m, r) => got.push({ msg: new Uint8Array(m), port: r.port }));
      sock.bind(port, "127.0.0.1", () => resolve({ sock, got }));
      cleanup.push(() => sock.close());
    });
  const until = async (fn: () => boolean, ms = 3000) => {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20));
    return fn();
  };

  it("Art-Net: sends ArtDmx + ArtPoll; 'connected' only after a node answers", async () => {
    const node = await listen(26455);
    const net = new NetDmx({ artnetPort: 26454, artnetDestPort: 26455, pollIntervalMs: 200 });
    cleanup.push(() => net.close());
    const statuses: IoStatus[] = [];
    net.onStatus((_u, s) => statuses.push(s));
    await net.configure([{ ...defaultIo(1), output: "artnet", artnet: { host: "127.0.0.1", portAddress: 0, inputPortAddress: 0 } }]);
    expect(net.getStatus(1).output).toBe("disconnected"); // nobody answered yet
    net.frame(1, frame([[1, 255], [2, 128]]));
    expect(await until(() => node.got.some((g) => parseArtDmx(g.msg)))).toBe(true);
    const dmx = node.got.map((g) => parseArtDmx(g.msg)).find(Boolean)!;
    expect([dmx.data[0], dmx.data[1]]).toEqual([255, 128]);
    // Reply like a real node would.
    const poll = node.got.find((g) => g.msg[8] === 0x00 && g.msg[9] === 0x20)!;
    expect(poll).toBeTruthy();
    const reply = new Uint8Array(239);
    reply.set(new TextEncoder().encode("Art-Net\0"), 0);
    reply[8] = 0x00;
    reply[9] = 0x21;
    reply.set([127, 0, 0, 1], 10);
    reply.set(new TextEncoder().encode("Test Node"), 26);
    node.sock.send(reply, poll.port, "127.0.0.1");
    expect(await until(() => net.getStatus(1).output === "connected")).toBe(true);
    expect(net.getStatus(1).detail).toContain("Test Node");
    expect(parseArtPollReply(reply)?.ip).toBe("127.0.0.1");
    // Safe shutdown sends zeros.
    node.got.length = 0;
    await net.zeroAll();
    const zero = node.got.map((g) => parseArtDmx(g.msg)).find(Boolean)!;
    expect(Math.max(...zero.data)).toBe(0);
  });

  it("sACN: sends E1.31 packets (unicast here) and reports 'sending', not a fake connection", async () => {
    const rx = await listen(25568);
    const net = new NetDmx({ artnetPort: 26460, sacnPort: 25568 });
    cleanup.push(() => net.close());
    await net.configure([{ ...defaultIo(3), output: "sacn", sacn: { universe: 3, priority: 100, host: "127.0.0.1" } }]);
    net.frame(3, frame([[5, 77]]));
    expect(await until(() => rx.got.some((g) => parseE131(g.msg)))).toBe(true);
    const pkt = parseE131(rx.got.find((g) => parseE131(g.msg))!.msg)!;
    expect(pkt.universe).toBe(3);
    expect(pkt.data[4]).toBe(77);
    expect(net.getStatus(3).output).toBe("sending");
  });
});

describe("USB DMX detection", () => {
  it("finds a real Enttec Pro reply, even inside receive noise, and nothing in noise alone", async () => {
    const { findProReply } = await import("../src/lighting/usbPro");
    // The noise pattern the Open DMX-style FTDI adapter on the dev PC produces on its receive side.
    const noise = [0x00, 0xf0, 0xaa, 0x55, 0xa5, 0x00, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const junk = new Uint8Array(Array.from({ length: 30 }, () => noise).flat());
    expect(findProReply(junk, 10)).toBeNull();
    const reply = [0x7e, 10, 4, 0, 0x78, 0x56, 0x34, 0x12, 0xe7];
    const mixed = new Uint8Array([...junk.slice(0, 50), ...reply, ...junk.slice(0, 20)]);
    expect(Array.from(findProReply(mixed, 10)!)).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it("Open DMX frame = start code 0 + 512 slots", async () => {
    const { openDmxFrame } = await import("../src/lighting/usbPro");
    const f = openDmxFrame(frame([[1, 9], [512, 7]]));
    expect(f.length).toBe(513);
    expect([f[0], f[1], f[512]]).toEqual([0, 9, 7]);
  });
});

describe("sound-to-light movement (moving heads)", () => {
  const head = GENERIC_FIXTURES.find((d) => d.id === "generic/moving-head")!;
  const mode11 = head.modes[0].name; // pan, panFine, tilt, tiltFine, speed, dimmer, …
  const rig = (extra: PatchedFixture[] = []) => () => ({
    defs: [...GENERIC_FIXTURES, { ...head, id: "test/laser-head", laser: true }],
    fixtures: [
      { id: "h1", name: "Head L", defId: head.id, mode: mode11, universe: 1, address: 1, channelCount: 11 },
      { id: "h2", name: "Head R", defId: head.id, mode: mode11, universe: 1, address: 21, channelCount: 11 },
      ...extra,
    ] as PatchedFixture[],
  });
  /** pan/tilt (0..1, 16-bit) of a head starting at `addr`. */
  const pos = (out: Uint8Array, addr: number) => ({ pan: ((out[addr - 1] << 8) | out[addr]) / 65535, tilt: ((out[addr + 1] << 8) | out[addr + 2]) / 65535 });

  function setup(opts: { signal?: () => "kick" | "quiet" | "silent"; grid?: boolean; extra?: PatchedFixture[] } = {}) {
    const engine = new DmxEngine();
    let beats = 0;
    const loud = { low: 1, mid: 0.5, high: 0.3, amplitude: 1 };
    const stl = new SoundToLight({
      engine,
      probe: { read: () => { const s = opts.signal?.() ?? "kick"; return s === "silent" ? { low: 0, mid: 0, high: 0, amplitude: 0 } : s === "quiet" ? { low: 0.05, mid: 0.2, high: 0.1, amplitude: 0.25 } : loud; } },
      beats: { beatPosition: () => (opts.grid === false ? null : { beats, bpm: 120 }) },
      rig: rig(opts.extra),
    });
    stl.settings = { ...stl.settings, enabled: true, fixtures: ["h1", "h2", ...(opts.extra ?? []).map((f) => f.id)], movement: { ...stl.settings.movement, enabled: true, followEnergy: false, size: 0.4, spread: 0, mirror: true, pattern: "circle", beatsPerCycle: 8 } };
    const advance = (b: number, steps = 40) => { for (let i = 0; i < steps; i++) { beats += b / steps; stl.update(0.5 * b / steps); } };
    return { engine, stl, advance, beatsNow: () => beats };
  }

  it("DmxEngine: a claimed channel takes the claiming layer's value (LTP), released → HTP again", () => {
    const e = new DmxEngine();
    e.setChannel(LAYER_DESK, 1, 1, 200);
    e.setChannel(LAYER_SOUND, 1, 1, 50);
    expect(e.compute(1)[0]).toBe(200);
    e.claimChannels(LAYER_SOUND, 1, [1]);
    expect(e.compute(1)[0]).toBe(50);
    e.claimChannels(LAYER_SOUND, 1, null);
    expect(e.compute(1)[0]).toBe(200);
  });

  it("pattern shapes: circle stays on the unit circle; beat jumps hold within a beat and move on the next", () => {
    for (let p = 0; p < 1; p += 0.1) expect(Math.hypot(movementOffset("circle", p).x, movementOffset("circle", p).y)).toBeCloseTo(1);
    expect(movementOffset("sweep", 0.3).y).toBe(0);
    expect(movementOffset("nod", 0.3).x).toBe(0);
    expect(movementOffset("jump", 0.01)).toEqual(movementOffset("jump", 0.2)); // same quarter cycle
    expect(movementOffset("jump", 0.01)).not.toEqual(movementOffset("jump", 0.26));
    expect(movementOffset("jump", 0.01, 0)).not.toEqual(movementOffset("jump", 0.01, 1)); // heads differ
  });

  it("circles locked to the beat grid: one cycle per 8 beats, 16-bit, mirror pairs", () => {
    const { engine, advance } = setup();
    advance(0.001, 1);
    const start = pos(engine.compute(1), 1);
    expect(start.pan).toBeCloseTo(0.5 + 0.2, 2); // circle starts at +x; size 0.4 → reach 0.2
    expect(start.tilt).toBeCloseTo(0.5, 2);
    advance(2); // a quarter cycle
    const q = pos(engine.compute(1), 1);
    expect(q.pan).toBeCloseTo(0.5, 2);
    expect(q.tilt).toBeCloseTo(0.7, 2);
    const other = pos(engine.compute(1), 21);
    expect(other.tilt).toBeCloseTo(q.tilt, 2); // same phase (spread 0)
    advance(6); // completes the cycle
    const back = pos(engine.compute(1), 1);
    expect(back.pan).toBeCloseTo(start.pan, 2);
    expect(back.tilt).toBeCloseTo(start.tilt, 2);
    expect(pos(engine.compute(1), 21).pan).toBeCloseTo(1 - back.pan, 2); // mirrored
    // Fine channels carry the low byte: positions between coarse steps are output.
    let fineSeen = false;
    for (let i = 0; i < 20; i++) { advance(0.05, 1); if (engine.compute(1)[1] !== 0) fineSeen = true; }
    expect(fineSeen).toBe(true);
  });

  it("spread offsets heads around the cycle", () => {
    const { engine, stl, advance } = setup();
    stl.settings = { ...stl.settings, movement: { ...stl.settings.movement, spread: 1, mirror: false } };
    advance(0.001, 1);
    const a = pos(engine.compute(1), 1), b = pos(engine.compute(1), 21);
    expect(a.pan).toBeCloseTo(0.7, 2); // phase 0
    expect(b.pan).toBeCloseTo(0.3, 2); // half a cycle later (2 heads, spread 1)
  });

  it("owns pan/tilt while on (desk position ignored), hands it back when movement is switched off", () => {
    const { engine, stl, advance } = setup();
    engine.setChannel(LAYER_DESK, 1, 1, 255); // desk pan full right
    engine.setChannel(LAYER_DESK, 1, 6, 255); // desk dimmer
    advance(2);
    const out = engine.compute(1);
    expect(out[0]).toBeLessThan(200); // movement, not HTP with the desk's 255
    expect(out[5]).toBe(255); // dimmer still HTP
    stl.settings = { ...stl.settings, movement: { ...stl.settings.movement, enabled: false } };
    advance(0.1, 1);
    expect(engine.compute(1)[0]).toBe(255);
    stl.settings = { ...stl.settings, enabled: false };
    stl.update(0.02);
    expect(engine.compute(1)[0]).toBe(255);
  });

  it("follows detected kicks when there's no beat grid, and holds still in silence", () => {
    let level: "kick" | "quiet" | "silent" = "kick";
    const { engine, stl } = setup({ grid: false, signal: () => level });
    // Kicks at 120 BPM over quieter music, so beats are detected from the bass.
    const loudFor = (seconds: number) => { for (let t = 0; t < seconds; t += 0.02) { level = (t % 0.5) < 0.1 ? "kick" : "quiet"; stl.update(0.02); } };
    loudFor(6);
    const p1 = pos(engine.compute(1), 1);
    loudFor(1);
    const p2 = pos(engine.compute(1), 1);
    expect(Math.hypot(p2.pan - p1.pan, p2.tilt - p1.tilt)).toBeGreaterThan(0.01); // moving
    level = "silent";
    for (let i = 0; i < 30; i++) stl.update(0.02);
    const s1 = pos(engine.compute(1), 1);
    for (let i = 0; i < 100; i++) stl.update(0.02);
    const s2 = pos(engine.compute(1), 1);
    expect(s2).toEqual(s1); // silence: heads hold position
  });

  it("never moves lasers unless lasers are allowed", () => {
    const laser = { id: "lz", name: "Laser head", defId: "test/laser-head", mode: mode11, universe: 1, address: 41, channelCount: 11 } as PatchedFixture;
    const { engine, advance } = setup({ extra: [laser] });
    advance(3);
    expect(Math.max(...engine.compute(1).subarray(40, 51))).toBe(0);
  });
});

describe("DMX Desk channels linked to sound", () => {
  // A laser with a pattern channel whose ranges come from its definition (as a QLC+ import gives).
  const laserDef = {
    id: "test/laser", manufacturer: "Test", model: "Laser", category: "laser" as const, laser: true,
    modes: [{ name: "3ch", channels: [
      { name: "Mode", type: "laser" as const },
      { name: "Pattern", type: "laser" as const, capabilities: [{ min: 0, max: 9, name: "Circle" }, { min: 10, max: 19, name: "Line" }, { min: 20, max: 29, name: "Wave" }, { min: 30, max: 39, name: "Star" }] },
      { name: "Zoom", type: "laser" as const },
    ] }],
  };
  const rig = () => ({
    defs: [...GENERIC_FIXTURES, laserDef],
    fixtures: [
      { id: "lz", name: "Laser", defId: "test/laser", mode: "3ch", universe: 1, address: 10, channelCount: 3 },
    ] as PatchedFixture[],
  });
  function setup(reading: () => BandReading) {
    const engine = new DmxEngine();
    let beats = 0;
    const stl = new SoundToLight({ engine, probe: { read: reading }, beats: { beatPosition: () => ({ beats, bpm: 120 }) }, rig });
    stl.settings = { ...stl.settings, enabled: true, fixtures: [] };
    const beat = () => { for (let i = 0; i < 20; i++) { beats += 1 / 20; stl.update(0.5 / 20); } };
    return { engine, stl, beat };
  }

  it("linkSteps: the channel's named ranges (midpoints) within min–max, else evenly spaced steps", () => {
    const caps = laserDef.modes[0].channels[1].capabilities!;
    expect(linkSteps({ min: 0, max: 255, steps: 8, useRanges: true }, caps)).toEqual([5, 15, 25, 35]); // midpoints
    expect(linkSteps({ min: 10, max: 29, steps: 8, useRanges: true }, caps)).toEqual([15, 25]);
    expect(linkSteps({ min: 0, max: 255, steps: 4, useRanges: false }, caps)).toEqual([0, 85, 170, 255]);
    expect(linkSteps({ min: 255, max: 0, steps: 2, useRanges: true })).toEqual([0, 255]); // no ranges → even
  });

  it("Follow: a channel follows the highs between min and max and wins over the desk fader", () => {
    let high = 0.05;
    const { engine, stl, beat } = setup(() => ({ low: 0.2, mid: 0.2, high, amplitude: 0.5 }));
    engine.setChannel(LAYER_DESK, 1, 100, 255);
    stl.settings = { ...stl.settings, channelLinks: [{ universe: 1, channel: 100, source: "high", mode: "follow", min: 40, max: 200, steps: 8, useRanges: false }] };
    beat();
    const quiet = engine.compute(1)[99];
    high = 1;
    beat();
    const bright = engine.compute(1)[99];
    expect(quiet).toBeGreaterThanOrEqual(40);
    expect(quiet).toBeLessThan(120); // desk's 255 doesn't win
    expect(bright).toBeGreaterThan(quiet + 40);
    expect(bright).toBeLessThanOrEqual(200);
    stl.settings = { ...stl.settings, enabled: false };
    stl.update(0.02);
    expect(engine.compute(1)[99]).toBe(255); // sound off → the fader again
  });

  it("Step: a laser's pattern channel steps through its named shapes on every beat — only with lasers allowed", () => {
    const { engine, stl, beat } = setup(() => ({ low: 1, mid: 0.5, high: 0.5, amplitude: 1 }));
    stl.settings = { ...stl.settings, channelLinks: [{ universe: 1, channel: 11, source: "beat", mode: "step", min: 0, max: 255, steps: 8, useRanges: true }] };
    beat();
    beat();
    expect(engine.compute(1)[10]).toBe(0); // laser safety: nothing yet
    stl.settings = { ...stl.settings, allowLasers: true };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { beat(); seen.push(engine.compute(1)[10]); }
    expect(new Set(seen)).toEqual(new Set([5, 15, 25, 35]));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe([5, 15, 25, 35][([5, 15, 25, 35].indexOf(seen[i - 1]) + 1) % 4]); // in order, wrapping
  });

  it("Random: a different step on every downbeat, holding between bars", () => {
    const engine = new DmxEngine();
    let beats = 0;
    const stl = new SoundToLight({ engine, probe: { read: () => ({ low: 1, mid: 0.5, high: 0.5, amplitude: 1 }) }, beats: { beatPosition: () => ({ beats, bpm: 120 }) }, rig });
    stl.settings = { ...stl.settings, enabled: true, channelLinks: [{ universe: 1, channel: 300, source: "downbeat", mode: "random", min: 0, max: 255, steps: 6, useRanges: false }] };
    const values: number[] = [];
    for (let bar = 0; bar < 12; bar++) {
      const atBarStart: number[] = [];
      for (let i = 0; i < 80; i++) { beats += 4 / 80; stl.update(2 / 80); atBarStart.push(engine.compute(1)[299]); }
      values.push(atBarStart[atBarStart.length - 1]);
      expect(new Set(atBarStart.slice(5)).size).toBeLessThanOrEqual(2); // holds within the bar
    }
    for (let i = 1; i < values.length; i++) expect(values[i]).not.toBe(values[i - 1]);
    expect(values.every((v) => [0, 51, 102, 153, 204, 255].includes(v))).toBe(true);
  });
});

describe("sound-to-light per-fixture setup and strobe", () => {
  const par = GENERIC_FIXTURES.find((d) => d.id === "generic/rgb-par")!; // 5ch: R G B DIMMER STROBE
  const rgbw = GENERIC_FIXTURES.find((d) => d.id === "generic/rgbw-par")!; // 4ch mode: R G B W (no strobe channel)
  const fixtures = [
    { id: "p1", name: "PAR 1", defId: par.id, mode: par.modes[0].name, universe: 1, address: 1, channelCount: 5 },
    { id: "p2", name: "PAR 2", defId: par.id, mode: par.modes[0].name, universe: 1, address: 11, channelCount: 5 },
    { id: "w", name: "RGBW", defId: rgbw.id, mode: rgbw.modes[1].name, universe: 1, address: 21, channelCount: 4 },
    { id: "lz", name: "Laser", defId: "test/laser-par", mode: par.modes[0].name, universe: 1, address: 31, channelCount: 5 },
  ] as PatchedFixture[];
  const rig = () => ({ defs: [...GENERIC_FIXTURES, { ...par, id: "test/laser-par", laser: true }], fixtures });
  function setup(opts: { reading?: () => BandReading; track?: () => { deck: number; pos: number; drops: number[] | null } | null } = {}) {
    const engine = new DmxEngine();
    let beats = 0;
    const stl = new SoundToLight({ engine, probe: { read: opts.reading ?? (() => ({ low: 1, mid: 0.2, high: 0.05, amplitude: 1 })) }, beats: { beatPosition: () => ({ beats, bpm: 120 }), track: opts.track }, rig });
    stl.settings = { ...stl.settings, enabled: true, fixtures: ["p1", "p2", "w", "lz"] };
    const step = (secs: number, perStep = 1 / 40) => { for (let t = 0; t < secs; t += perStep) { beats += (perStep * 120) / 60; stl.update(perStep); } };
    return { engine, stl, step };
  }

  it("one PAR flashes to the beat in a fixed colour while another follows the highs", () => {
    const { engine, stl, step } = setup();
    stl.settings = { ...stl.settings, fixtureLooks: { p1: { ...DEFAULT_LOOK, drive: "beat", colour: "#0000ff" }, p2: { ...DEFAULT_LOOK, drive: "high" } } };
    step(2);
    const out = engine.compute(1);
    expect(out[0]).toBe(0); // p1 red off despite loud bass: fixed blue
    expect(out[2]).toBe(255); // p1 blue at full colour…
    expect(out[13]).toBeLessThan(60); // p2 dimmer follows the (quiet) highs
    expect(out[10]).toBeGreaterThan(150); // p2 keeps the mapping colours (bass → red)
    let flashes = 0;
    let prev = 0;
    for (let i = 0; i < 80; i++) { step(1 / 40); const d = engine.compute(1)[3]; if (d > 120 && prev <= 120) flashes++; prev = d; } // beat flash 70% (178), downbeat 100%
    expect(flashes).toBeGreaterThanOrEqual(3); // p1's dimmer pulses on the beats (2 s at 120 BPM ≈ 4)
  });

  it("manual strobe: the fixture's own strobe channel, or flashed in software; works with sound control off", () => {
    const { engine, stl, step } = setup();
    stl.settings = { ...stl.settings, enabled: false, strobe: { ...DEFAULT_STROBE, rateHz: 8 } };
    step(0.5);
    expect(Math.max(...engine.compute(1))).toBe(0);
    stl.setManualStrobe(true);
    step(0.1);
    const out = engine.compute(1);
    expect(out[4]).toBe(strobeChannelValue(8)); // p1 strobe channel
    expect(out[3]).toBe(255); // dimmer open while its own strobe flashes
    expect([out[0], out[1], out[2]]).toEqual([255, 255, 255]); // white
    let changes = 0;
    let last = engine.compute(1)[20];
    for (let i = 0; i < 40; i++) { step(1 / 40); const v = engine.compute(1)[20]; if (v !== last) changes++; last = v; }
    expect(changes).toBeGreaterThanOrEqual(10); // RGBW without a strobe channel flashes ~8×/s
    expect(Math.max(...engine.compute(1).subarray(30, 35))).toBe(0); // lasers never strobe unless allowed
    stl.setManualStrobe(false);
    step(0.1);
    expect(Math.max(...engine.compute(1))).toBe(0); // sound off again: dark
  });

  it("strobe on drops: only the chosen fixtures, for the chosen bars, when the track crosses an analysed drop", () => {
    let pos = 8;
    const { engine, stl, step } = setup({ track: () => ({ deck: 0, pos, drops: [10] }) });
    stl.settings = { ...stl.settings, fixtureLooks: { p2: { ...DEFAULT_LOOK, strobeOnDrop: true, manualStrobe: false } }, strobe: { ...DEFAULT_STROBE, dropBars: 2 } };
    const drops: string[] = [];
    stl.on("drop", (d) => drops.push(d.from));
    for (let i = 0; i < 40 && pos < 10.2; i++) { pos += 1 / 16; step(1 / 40); }
    expect(drops).toEqual(["analysis"]);
    expect(stl.dropStrobeLeft()).toBeGreaterThan(3); // 2 bars at 120 BPM = 4 s
    expect(engine.compute(1)[14]).toBe(strobeChannelValue(8)); // p2 strobes
    expect(engine.compute(1)[4]).toBe(0); // p1 doesn't
    step(4.5);
    expect(stl.dropStrobeLeft()).toBe(0);
    expect(engine.compute(1)[14]).toBe(0);
  });

  it("without drop analysis, a bass return after a breakdown counts as a drop", () => {
    let low = 0.05;
    const { stl, step } = setup({ reading: () => ({ low, mid: 0.5, high: 0.3, amplitude: 0.6 }), track: () => ({ deck: 0, pos: 1, drops: null }) });
    const drops: string[] = [];
    stl.on("drop", (d) => drops.push(d.from));
    step(10); // 5 bars of breakdown (quiet bass, loud mids keep the auto-gain up)
    low = 1;
    step(0.3);
    expect(drops).toEqual(["bass"]);
  });

  it("strobe channel values follow the fixture's 'strobe slow → fast' range and the rate cap", () => {
    const caps = [{ min: 0, max: 9, name: "Strobe open" }, { min: 10, max: 250, name: "Strobe slow → fast" }];
    expect(strobeChannelValue(1, caps)).toBe(10);
    expect(strobeChannelValue(STROBE_MAX_HZ, caps)).toBe(250);
    expect(strobeChannelValue(50, caps)).toBe(250); // capped
  });
});

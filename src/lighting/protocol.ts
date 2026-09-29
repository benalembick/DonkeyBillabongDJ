/**
 * DMX transport encoders/decoders (pure, no I/O) shared by the main process
 * senders, the Web Serial USB provider and the tests.
 *
 *  - Art-Net 4: ArtDmx (0x5000), ArtPoll (0x2000), ArtPollReply (0x2100) — UDP port 6454
 *  - sACN / ANSI E1.31-2016 data packet — UDP port 5568, multicast 239.255.{hi}.{lo}
 *  - Enttec DMX USB Pro "Output Only Send DMX Packet" (label 6) — also used by compatible
 *    interfaces (DMXking ultraDMX, many FTDI-based "USB Pro" clones)
 */

export const DMX_SLOTS = 512;
export const ARTNET_PORT = 6454;
export const SACN_PORT = 5568;

const ARTNET_ID = [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]; // "Art-Net\0"
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;
const PROT_VER = 14;

/** ArtDmx for a 15-bit Art-Net port-address (Net:SubNet:Universe). */
export function artDmx(portAddress: number, data: Uint8Array, sequence: number, physical = 0): Uint8Array {
  // Length must be even and 2..512.
  let len = Math.min(DMX_SLOTS, Math.max(2, data.length));
  if (len % 2) len++;
  const p = new Uint8Array(18 + len);
  p.set(ARTNET_ID, 0);
  p[8] = OP_DMX & 0xff;
  p[9] = OP_DMX >> 8;
  p[10] = 0;
  p[11] = PROT_VER;
  p[12] = sequence & 0xff;
  p[13] = physical & 0xff;
  p[14] = portAddress & 0xff; // SubUni
  p[15] = (portAddress >> 8) & 0x7f; // Net
  p[16] = len >> 8;
  p[17] = len & 0xff;
  p.set(data.subarray(0, Math.min(len, data.length)), 18);
  return p;
}

export function artPoll(): Uint8Array {
  const p = new Uint8Array(14);
  p.set(ARTNET_ID, 0);
  p[8] = OP_POLL & 0xff;
  p[9] = OP_POLL >> 8;
  p[10] = 0;
  p[11] = PROT_VER;
  p[12] = 0x02; // send ArtPollReply whenever node conditions change
  p[13] = 0; // DiagPriority
  return p;
}

function isArtNet(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== ARTNET_ID[i]) return false;
  return true;
}

const cstr = (b: Uint8Array, from: number, len: number) => {
  let s = "";
  for (let i = from; i < from + len && i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return s.trim();
};

export interface ArtPollReply {
  ip: string;
  shortName: string;
  longName: string;
}

export function parseArtPollReply(b: Uint8Array): ArtPollReply | null {
  if (!isArtNet(b) || (b[8] | (b[9] << 8)) !== OP_POLL_REPLY || b.length < 108) return null;
  return { ip: `${b[10]}.${b[11]}.${b[12]}.${b[13]}`, shortName: cstr(b, 26, 18), longName: cstr(b, 44, 64) };
}

export function parseArtDmx(b: Uint8Array): { portAddress: number; sequence: number; data: Uint8Array } | null {
  if (!isArtNet(b) || (b[8] | (b[9] << 8)) !== OP_DMX || b.length < 20) return null;
  const len = Math.min(DMX_SLOTS, (b[16] << 8) | b[17], b.length - 18);
  return { portAddress: b[14] | ((b[15] & 0x7f) << 8), sequence: b[12], data: b.slice(18, 18 + len) };
}

/** Multicast group for an sACN universe (1..63999). */
export function sacnMulticast(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/**
 * E1.31 data packet (638 bytes for 512 slots).
 * Root layer 0..37, framing layer 38..114, DMP layer 115..637.
 */
export function e131Data(universe: number, data: Uint8Array, sequence: number, cid: Uint8Array, sourceName: string, priority = 100): Uint8Array {
  const slots = Math.min(DMX_SLOTS, data.length);
  const total = 126 + slots;
  const p = new Uint8Array(total);
  const dv = new DataView(p.buffer);
  // Root layer
  dv.setUint16(0, 0x0010);
  dv.setUint16(2, 0x0000);
  p.set([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00], 4); // "ASC-E1.17"
  dv.setUint16(16, 0x7000 | (total - 16));
  dv.setUint32(18, 0x00000004); // VECTOR_ROOT_E131_DATA
  p.set(cid.subarray(0, 16), 22);
  // Framing layer
  dv.setUint16(38, 0x7000 | (total - 38));
  dv.setUint32(40, 0x00000002); // VECTOR_E131_DATA_PACKET
  const name = new TextEncoder().encode(sourceName).subarray(0, 63);
  p.set(name, 44);
  p[108] = Math.max(0, Math.min(200, priority));
  dv.setUint16(109, 0); // sync address
  p[111] = sequence & 0xff;
  p[112] = 0; // options
  dv.setUint16(113, universe);
  // DMP layer
  dv.setUint16(115, 0x7000 | (total - 115));
  p[117] = 0x02; // VECTOR_DMP_SET_PROPERTY
  p[118] = 0xa1; // address & data type
  dv.setUint16(119, 0x0000); // first property address
  dv.setUint16(121, 0x0001); // address increment
  dv.setUint16(123, slots + 1); // property value count (start code + slots)
  p[125] = 0x00; // DMX start code
  p.set(data.subarray(0, slots), 126);
  return p;
}

/** Decode an E1.31 data packet (for tests / future sACN input). */
export function parseE131(b: Uint8Array): { universe: number; priority: number; sequence: number; sourceName: string; data: Uint8Array } | null {
  if (b.length < 126) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(18) !== 4 || dv.getUint32(40) !== 2 || b[117] !== 2) return null;
  const count = dv.getUint16(123) - 1;
  return { universe: dv.getUint16(113), priority: b[108], sequence: b[111], sourceName: cstr(b, 44, 64), data: b.slice(126, 126 + count) };
}

/** Enttec DMX USB Pro "send DMX" message (label 6): 0x7E, label, len LSB/MSB, start code + slots, 0xE7. */
export function enttecProDmx(data: Uint8Array): Uint8Array {
  const slots = Math.min(DMX_SLOTS, data.length);
  const len = slots + 1;
  const p = new Uint8Array(len + 5);
  p[0] = 0x7e;
  p[1] = 6;
  p[2] = len & 0xff;
  p[3] = len >> 8;
  p[4] = 0; // DMX start code
  p.set(data.subarray(0, slots), 5);
  p[len + 4] = 0xe7;
  return p;
}

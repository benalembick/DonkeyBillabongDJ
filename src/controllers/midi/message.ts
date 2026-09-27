/** Raw MIDI message helpers (no Web MIDI dependency, fully testable). */

export type MidiMessageType = "noteon" | "noteoff" | "cc" | "pitchbend" | "aftertouch" | "program" | "sysex" | "other";

export interface MidiMessage {
  deviceId: string;
  deviceName: string;
  type: MidiMessageType;
  /** 1-16 (human numbering, as shown in the MIDI monitor). */
  channel: number;
  status: number;
  data1: number;
  data2: number;
  timestamp: number;
}

export function parseMidi(bytes: ArrayLike<number>, deviceId: string, deviceName: string, timestamp: number): MidiMessage {
  const status = bytes[0] ?? 0;
  const data1 = bytes[1] ?? 0;
  const data2 = bytes[2] ?? 0;
  const hi = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  let type: MidiMessageType;
  if (status === 0xf0) type = "sysex";
  else if (hi === 0x90) type = data2 === 0 ? "noteoff" : "noteon";
  else if (hi === 0x80) type = "noteoff";
  else if (hi === 0xb0) type = "cc";
  else if (hi === 0xe0) type = "pitchbend";
  else if (hi === 0xa0 || hi === 0xd0) type = "aftertouch";
  else if (hi === 0xc0) type = "program";
  else type = "other";
  return { deviceId, deviceName, type, channel, status, data1, data2, timestamp };
}

export function hex(n: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(2, "0");
}

export function describeMidi(m: MidiMessage): string {
  switch (m.type) {
    case "noteon":
      return `Note On  ch${m.channel} note ${m.data1} (${hex(m.data1)}) vel ${m.data2}`;
    case "noteoff":
      return `Note Off ch${m.channel} note ${m.data1} (${hex(m.data1)})`;
    case "cc":
      return `CC       ch${m.channel} cc ${m.data1} (${hex(m.data1)}) val ${m.data2}`;
    case "pitchbend":
      return `Pitch    ch${m.channel} ${(m.data2 << 7) | m.data1}`;
    default:
      return `${m.type} ${hex(m.status)} ${m.data1} ${m.data2}`;
  }
}

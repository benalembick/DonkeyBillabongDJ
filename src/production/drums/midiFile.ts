/**
 * Standard MIDI File (SMF) writer for Drum Transcriber exports.
 *
 * Format 1: track 0 is the conductor (name, time signature, tempo); each further track carries notes. Drum notes go
 * on MIDI channel 10, which is channel *index* 9 in the status byte (0x99 note-on / 0x89 note-off). Simultaneous
 * hits stay simultaneous (same tick); at equal ticks note-offs are written before note-ons so a retriggered note is
 * never cut by its own previous note-off.
 */
import { deriveNotes } from "./timing";
import { LANE_LABEL, type DrumLane, type DrumTranscription } from "./types";

export const DEFAULT_PPQ = 480;
/** 1-based MIDI channel used for drums (General MIDI). */
export const DRUM_CHANNEL = 10;

export interface SmfNote { pitch: number; tick: number; duration: number; velocity: number }
export interface SmfTrack { name: string; /** 1-based MIDI channel (1–16). */ channel: number; notes: SmfNote[] }
export interface SmfSong { name: string; bpm: number; ppq?: number; timeSignature?: [number, number]; tracks: SmfTrack[] }

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value)); const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}
const text = (s: string) => Array.from(new TextEncoder().encode(s.slice(0, 120)));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

interface Ev { tick: number; order: number; bytes: number[] }
function chunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = []; let last = 0;
  for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  body.push(0, 0xff, 0x2f, 0); // end of track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

export function writeSmf(song: SmfSong): Uint8Array {
  const ppq = song.ppq ?? DEFAULT_PPQ; const [num, den] = song.timeSignature ?? [4, 4];
  const tempo = Math.round(60_000_000 / song.bpm);
  const conductor = chunk([
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(text(song.name).length), ...text(song.name)] },
    { tick: 0, order: 1, bytes: [0xff, 0x58, 4, num, Math.round(Math.log2(den)), 24, 8] },
    { tick: 0, order: 2, bytes: [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
  ]);
  const tracks = song.tracks.map((t) => {
    const ch = Math.max(0, Math.min(15, t.channel - 1)); const events: Ev[] = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(text(t.name).length), ...text(t.name)] }];
    // Same-pitch notes never overlap: each note ends by the next start of its pitch.
    const byPitch = new Map<number, SmfNote[]>(); for (const n of t.notes) { const list = byPitch.get(n.pitch) ?? []; list.push(n); byPitch.set(n.pitch, list); }
    for (const list of byPitch.values()) {
      list.sort((a, b) => a.tick - b.tick);
      for (let i = 0; i < list.length; i++) {
        const n = list[i]; if (i > 0 && n.tick === list[i - 1].tick) continue; // exact duplicates collapse to one note
        const next = list.slice(i + 1).find((m) => m.tick > n.tick); const end = Math.max(n.tick + 1, Math.min(n.tick + Math.max(1, n.duration), next ? next.tick : Infinity));
        const vel = Math.max(1, Math.min(127, Math.round(n.velocity))); const pitch = Math.max(0, Math.min(127, n.pitch));
        events.push({ tick: n.tick, order: 2, bytes: [0x90 | ch, pitch, vel] }, { tick: end, order: 1, bytes: [0x80 | ch, pitch, 64] });
      }
    }
    return chunk(events);
  });
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(1 + tracks.length), ...u16(ppq)];
  return Uint8Array.from([...header, ...conductor, ...tracks.flat()]);
}

export interface MidiExportReport { bytes: Uint8Array; notes: number; skipped: number; skippedLanes: DrumLane[]; originSeconds: number }

/**
 * A transcription as a format-1 SMF: conductor track + one drum track (or one per lane with `split`).
 * Hits on unmapped lanes (Unknown, by default) are skipped and reported.
 */
export function transcriptionToMidi(p: DrumTranscription, options: { split?: boolean; ppq?: number } = {}): MidiExportReport {
  const ppq = options.ppq ?? DEFAULT_PPQ; const { origin, notes } = deriveNotes(p);
  const mapped = notes.filter((n) => n.pitch !== null); const skipped = notes.filter((n) => n.pitch === null);
  const toSmf = (list: typeof mapped): SmfNote[] => list.map((n) => ({ pitch: n.pitch!, tick: Math.max(0, Math.round(n.beat * ppq)), duration: Math.round(ppq / 4), velocity: n.velocity }));
  const tracks: SmfTrack[] = options.split
    ? [...new Set(mapped.map((n) => n.lane))].map((lane) => ({ name: LANE_LABEL[lane], channel: DRUM_CHANNEL, notes: toSmf(mapped.filter((n) => n.lane === lane)) }))
    : [{ name: `${p.name} (drums)`, channel: DRUM_CHANNEL, notes: toSmf(mapped) }];
  const bytes = writeSmf({ name: p.name, bpm: p.grid.bpm, ppq, timeSignature: [p.grid.beatsPerBar, 4], tracks });
  return { bytes, notes: mapped.length, skipped: skipped.length, skippedLanes: [...new Set(skipped.map((n) => n.lane))], originSeconds: origin };
}

/** Debug / integration export: the transcription plus every derived note (positions in seconds, beats and ticks). */
export function transcriptionToJson(p: DrumTranscription, ppq = DEFAULT_PPQ): string {
  const { origin, notes } = deriveNotes(p);
  return JSON.stringify({
    format: "dbdj-drum-transcription", schemaVersion: p.schemaVersion, exportedAt: new Date().toISOString(), ppq, originSeconds: origin,
    project: p,
    notes: notes.map((n) => ({ ...n, tick: Math.round(n.beat * ppq) })),
  }, null, 2);
}

/**
 * Seconds ⇄ beats, quantisation and velocity for Drum Transcriber hits. Everything here is derived from the stored
 * (unquantised) hits at read time, so changing a setting — or turning it off — never loses the original timing.
 * Quantisation reuses Production Studio's `quantizeToGrid` on `MidiNote`s, so it behaves exactly like the Sampler's.
 */
import { quantizeToGrid } from "../midi";
import type { MidiNote } from "../types";
import { QUANTIZE_GRID_BEATS, type DrumGrid, type DrumHit, type DrumLane, type DrumMapping, type DrumTranscription, type VelocitySettings } from "./types";

export const beatLength = (grid: Pick<DrumGrid, "bpm">) => 60 / grid.bpm;
export const barLength = (grid: Pick<DrumGrid, "bpm" | "beatsPerBar">) => 60 / grid.bpm * grid.beatsPerBar;

/**
 * MIDI/beat origin: the last bar line at or before both the earliest hit and the grid's first downbeat, so every
 * note has a non-negative position and bar lines in the export match the audio's bars.
 */
export function gridOrigin(grid: Pick<DrumGrid, "bpm" | "beatsPerBar" | "firstBeat">, hits: Pick<DrumHit, "time">[]): number {
  const bar = barLength(grid); const earliest = hits.reduce((m, h) => Math.min(m, h.time), grid.firstBeat);
  return grid.firstBeat - Math.ceil(Math.max(0, grid.firstBeat - earliest) / bar - 1e-9) * bar;
}

export const toBeats = (time: number, grid: Pick<DrumGrid, "bpm">, origin: number) => (time - origin) * grid.bpm / 60;
export const toSeconds = (beats: number, grid: Pick<DrumGrid, "bpm">, origin: number) => origin + beats * 60 / grid.bpm;

/** Quantised beat position of one beat value (same maths as quantizeToGrid). */
export function quantiseBeat(beat: number, gridBeats: number, strength: number): number {
  return quantizeToGrid([{ id: "", pitch: 0, start: beat, duration: 0, velocity: 0, channel: 0 }], gridBeats, strength)[0].start;
}

/** Snaps a time (seconds) to the nearest line of a grid step (beats), relative to the bar-aligned origin. */
export function snapTime(time: number, grid: Pick<DrumGrid, "bpm" | "beatsPerBar" | "firstBeat">, stepBeats: number): number {
  if (!stepBeats) return time; const origin = gridOrigin(grid, [{ time }]);
  return Math.max(0, toSeconds(Math.round(toBeats(time, grid, origin) / stepBeats) * stepBeats, grid, origin));
}

/** Velocity (1–127) of a hit: manual override, else fixed, else strength through sensitivity/compression into min…max. */
export function velocityOf(hit: Pick<DrumHit, "velocity" | "strength">, v: VelocitySettings): number {
  if (hit.velocity !== null && hit.velocity !== undefined) return Math.max(1, Math.min(127, Math.round(hit.velocity)));
  if (v.fixed) return Math.max(1, Math.min(127, Math.round(v.fixed)));
  const lo = Math.min(v.min, v.max), hi = Math.max(v.min, v.max);
  const followed = 1 - v.sensitivity * (1 - Math.max(0, Math.min(1, hit.strength)));
  const shaped = followed ** (1 / (1 + 3 * Math.max(0, Math.min(1, v.compression))));
  return Math.max(1, Math.min(127, Math.round(lo + (hi - lo) * shaped)));
}

export interface DerivedNote {
  hitId: string;
  lane: DrumLane;
  /** MIDI note number, or null when the lane is not mapped (not exported). */
  pitch: number | null;
  /** Unquantised and quantised positions (source seconds). */
  time: number;
  quantisedTime: number;
  /** Quantised position in beats from `origin`. */
  beat: number;
  velocity: number;
}

/** Every hit as a playable/exportable note, in time order. */
export function deriveNotes(p: Pick<DrumTranscription, "grid" | "hits" | "mapping" | "settings">): { origin: number; notes: DerivedNote[] } {
  const origin = gridOrigin(p.grid, p.hits); const gridBeats = QUANTIZE_GRID_BEATS[p.settings.quantize.grid];
  const raw: MidiNote[] = p.hits.map((h) => ({ id: h.id, pitch: 0, start: toBeats(h.time, p.grid, origin), duration: 0, velocity: 0, channel: 10 }));
  const quantised = quantizeToGrid(raw, gridBeats, p.settings.quantize.strength);
  // A grid line a hair before the audio starts (e.g. a downbeat at 1.995 s → bar line at −5 ms) must not pull a hit at 0 s
  // before the audio: quantised positions are clamped to the start.
  const notes = p.hits.map((h, i) => { const q = toSeconds(quantised[i].start, p.grid, origin); const t = Math.max(0, q); return { hitId: h.id, lane: h.lane, pitch: p.mapping[h.lane], time: h.time, quantisedTime: t, beat: t === q ? quantised[i].start : toBeats(t, p.grid, origin), velocity: velocityOf(h, p.settings.velocity) }; });
  return { origin, notes: notes.sort((a, b) => a.quantisedTime - b.quantisedTime) };
}

/** Converts derived notes into Production Studio `MidiNote`s (beats from origin; drums on channel 10). */
export function toMidiNotes(notes: DerivedNote[], duration = .25): MidiNote[] {
  return notes.filter((n) => n.pitch !== null).map((n) => ({ id: n.hitId, pitch: n.pitch!, start: n.beat, duration, velocity: n.velocity, channel: 10 }));
}

export const mappedLanes = (m: DrumMapping): DrumLane[] => (Object.keys(m) as DrumLane[]).filter((l) => m[l] !== null);

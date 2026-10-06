import type { MidiNote } from "./types";
export const midiFrequency = (pitch: number): number => 440 * 2 ** ((pitch - 69) / 12);
export const midiName = (pitch: number): string => `${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
export const beatsToSeconds = (beats: number, bpm: number): number => beats * 60 / bpm;
export const secondsToBeats = (seconds: number, bpm: number): number => seconds * bpm / 60;
export function quantizeNotes(notes: MidiNote[], division: number, strength = 1): MidiNote[] { const grid = 4 / division; return notes.map((note) => { const target = Math.round(note.start / grid) * grid; return { ...note, start: Math.max(0, note.start + (target - note.start) * strength) }; }); }
export function humanizeNotes(notes: MidiNote[], amount = .04): MidiNote[] { return notes.map((note, index) => ({ ...note, start: Math.max(0, note.start + Math.sin((index + 1) * 12.9898) * amount), velocity: Math.max(1, Math.min(127, note.velocity + Math.round(Math.sin((index + 1) * 7.31) * 7))) })); }
export type ScaleName = "major" | "minor" | "pentatonic" | "blues" | "dorian" | "mixolydian";
export const scalePitchClasses = (root: number, scale: ScaleName): Set<number> => { const intervals = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], pentatonic: [0, 2, 4, 7, 9], blues: [0, 3, 5, 6, 7, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10] }[scale]; return new Set(intervals.map((x) => (x + root) % 12)); };

/**
 * Moves note starts toward a grid of `gridBeats` (0 = off). Strength 1 snaps completely; lower values keep
 * part of the played timing (0.5 halves the distance to the grid line). Durations and order are kept.
 */
export function quantizeToGrid(notes: MidiNote[], gridBeats: number, strength = 1): MidiNote[] {
  if (!gridBeats || strength <= 0) return notes.map((note) => ({ ...note }));
  const amount = Math.min(1, strength);
  return notes.map((note) => { const target = Math.round(note.start / gridBeats) * gridBeats; return { ...note, start: Math.max(0, Math.round((note.start + (target - note.start) * amount) * 1e6) / 1e6) }; });
}

/**
 * Drum Transcriber → Arrangement: turns a transcription into one MIDI clip on a new Drums instrument track.
 *
 * Notes are placed by *time*, so the drums line up with the audio they came from:
 *  - source is an Arrangement clip (e.g. a Drums stem): source time t plays at clip.start + (t − clip.offset), and
 *    only hits inside that clip's region are used;
 *  - source is a file: source time 0 goes at the arrangement playhead.
 * Positions are converted to beats at the arrangement tempo — optionally set to the transcription's BPM first so the
 * notes also sit on the arrangement's bar lines. Unmapped lanes (Unknown, by default) are skipped and counted.
 */
import type { MidiNote, ProductionProject } from "../types";
import { deriveNotes } from "./timing";
import type { DrumTranscription } from "./types";

export interface PlacementAnchor { start: number; offset: number; duration: number }
export interface ArrangementClip { start: number; duration: number; notes: Omit<MidiNote, "id">[]; skipped: number; outside: number }

/** The arrangement clip the transcription's source audio sits in (first one using the same ref), if any. */
export function sourceClipIn(project: Pick<ProductionProject, "tracks">, ref: string): (PlacementAnchor & { trackName: string }) | null {
  for (const t of project.tracks) for (const c of t.clips) if (c.type === "audio" && c.ref === ref) return { start: c.start, offset: c.offset, duration: c.duration, trackName: t.name };
  return null;
}

export function arrangementClip(p: DrumTranscription, bpm: number, anchor: PlacementAnchor): ArrangementClip {
  const notes: Omit<MidiNote, "id">[] = []; let skipped = 0, outside = 0;
  for (const n of deriveNotes(p).notes) {
    if (n.pitch === null) { skipped++; continue; }
    // Quantising can nudge an edge hit a few ms outside the clip region: keep those (within 30 ms) at the edge.
    const end = anchor.offset + anchor.duration, q = n.quantisedTime; if (q < anchor.offset - .03 || q >= end + .03) { outside++; continue; }
    const t = Math.max(anchor.offset, Math.min(end - .001, q));
    notes.push({ pitch: n.pitch, start: Math.round((t - anchor.offset) * bpm / 60 * 1e4) / 1e4, duration: .25, velocity: n.velocity, channel: 10 });
  }
  return { start: anchor.start, duration: anchor.duration, notes, skipped, outside };
}

/** What sendToArrangement needs from Production Studio (ProductionStudio satisfies it). */
export interface ArrangementTarget {
  getState(): { project: Pick<ProductionProject, "tracks" | "bpm">; position: number };
  updateProject(patch: { bpm: number }): void;
  addInstrumentTrack(type: "drums", options: { name?: string }): string;
  addMidiClip(trackId: string, clip: { name: string; start: number; duration: number; notes: Omit<MidiNote, "id">[] }): string | null;
}
export interface SendReport { trackId: string; clipId: string; notes: number; skipped: number; outside: number; start: number; bpm: number; alignedTo: string | null }

export function sendToArrangement(studio: ArrangementTarget, p: DrumTranscription, options: { matchTempo: boolean }): SendReport {
  if (options.matchTempo && Math.abs(studio.getState().project.bpm - p.grid.bpm) > 1e-3) studio.updateProject({ bpm: Math.max(40, Math.min(240, p.grid.bpm)) });
  const state = studio.getState(); const bpm = state.project.bpm;
  const source = sourceClipIn(state.project, p.source.ref);
  const anchor = source ?? { start: state.position, offset: 0, duration: p.source.duration };
  const clip = arrangementClip(p, bpm, anchor);
  if (!clip.notes.length) throw new Error(clip.skipped ? "Every hit is on an unmapped lane (Unknown) — reclassify them or give the lane a MIDI note first" : "There are no notes to send yet");
  const trackId = studio.addInstrumentTrack("drums", { name: `${p.name} (MIDI)`.slice(0, 60) });
  const clipId = studio.addMidiClip(trackId, { name: `${p.name} drums`, start: clip.start, duration: clip.duration, notes: clip.notes });
  if (!clipId) throw new Error("Could not create the MIDI clip");
  return { trackId, clipId, notes: clip.notes.length, skipped: clip.skipped, outside: clip.outside, start: clip.start, bpm, alignedTo: source?.trackName ?? null };
}

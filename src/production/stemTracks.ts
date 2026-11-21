/**
 * Pure helpers for turning cached STEM PCM into Production Studio stem tracks. The stem cache holds
 * Int16 interleaved [vL vR dL dR bL bR]; "instruments" is never stored — it is the original minus the
 * other three, so the four stems always sum back to the source.
 */
import type { AudioClip } from "./types";

export type StemPart = "vocals" | "drums" | "bass" | "instruments";
export const STEM_PARTS: readonly { part: StemPart; name: string }[] = [
  { part: "vocals", name: "Vocals" },
  { part: "drums", name: "Drums" },
  { part: "bass", name: "Bass" },
  { part: "instruments", name: "Instruments" },
];
const CHANNEL: Record<Exclude<StemPart, "instruments">, number> = { vocals: 0, drums: 2, bass: 4 };
const I16 = 1 / 32768;

export interface StereoStem { left: Float32Array; right: Float32Array }

/** Frames available in a cached render (never more than the PCM actually holds). */
export function stemFrames(raw: Int16Array, total: number): number {
  return Math.min(total, Math.floor(raw.length / 6));
}

/**
 * One stem as stereo float. `original` (same rate and at least `frames` long) is only needed for
 * "instruments".
 */
export function deinterleaveStem(raw: Int16Array, frames: number, part: StemPart, original?: { left: Float32Array; right: Float32Array }): StereoStem {
  const left = new Float32Array(frames), right = new Float32Array(frames);
  if (part === "instruments") {
    if (!original) throw new Error("The original audio is needed to derive the instruments stem");
    const oL = original.left, oR = original.right;
    for (let i = 0; i < frames; i++) {
      const j = i * 6;
      left[i] = (oL[i] ?? 0) - (raw[j] + raw[j + 2] + raw[j + 4]) * I16;
      right[i] = (oR[i] ?? 0) - (raw[j + 1] + raw[j + 3] + raw[j + 5]) * I16;
    }
  } else {
    const c = CHANNEL[part];
    for (let i = 0; i < frames; i++) {
      left[i] = raw[i * 6 + c] * I16;
      right[i] = raw[i * 6 + c + 1] * I16;
    }
  }
  return { left, right };
}

/** Track/clip name for a stem of `songName`, e.g. "Song Name - Vocals". */
export function stemTrackName(songName: string, part: StemPart): string {
  return `${songName} - ${STEM_PARTS.find((p) => p.part === part)!.name}`;
}

/**
 * Placement of a stem clip: exactly where the source clip sits (start, offset, length, gain), so every stem
 * stays phase-aligned with the original and with each other. Length is clamped to the stem's own audio.
 */
export function stemClipPlacement(source: Pick<AudioClip, "start" | "offset" | "duration" | "gain">, stemDuration: number): Pick<AudioClip, "start" | "offset" | "duration" | "gain"> {
  return { start: source.start, offset: source.offset, duration: Math.min(source.duration, Math.max(0.01, stemDuration - source.offset)), gain: source.gain };
}

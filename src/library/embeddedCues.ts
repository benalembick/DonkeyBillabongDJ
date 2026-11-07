/** Hot cues read from / written to a local audio file's own metadata (shared by main process and renderer). */

export interface EmbeddedCue { slot: number; timestamp: number; name: string; colour: string }

export interface EmbeddedCueResult {
  ok: boolean;
  /** False when the file type can't carry embedded cues (MP3 and WAV today). */
  supported: boolean;
  cues: EmbeddedCue[];
  error?: string;
}

/** File extensions whose embedded hot cues this app can read/write. */
export const EMBEDDED_CUE_FORMATS = new Set(["mp3", "wav"]);

/** The extension of a local file ref, lowercased without the dot — null for non-local refs or one with no extension. */
export function fileExtension(ref: string, source: string): string | null {
  if (source !== "local") return null;
  const m = /\.([a-z0-9]+)$/i.exec(ref);
  return m ? m[1].toLowerCase() : null;
}

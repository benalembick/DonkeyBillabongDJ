import type { CueSource, DeckState, PreparationPort } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import type { EmbeddedCue, EmbeddedCueResult } from "../library/embeddedCues";
import { CUE_COLOURS, type PreparedCue } from "./types";
import { HOTCUE_COUNT } from "../core/actions";

export interface EmbeddedCueBridge {
  read(ref: string): Promise<EmbeddedCueResult>;
  write(ref: string, cues: EmbeddedCue[]): Promise<{ ok: boolean; error?: string }>;
}

export function toDeckFields(cues: EmbeddedCue[], duration: number): Pick<DeckState, "hotcues" | "cueDetails"> {
  const hotcues = Array<number | null>(HOTCUE_COUNT).fill(null);
  const cueDetails = Array<PreparedCue | null>(HOTCUE_COUNT).fill(null);
  for (const c of cues) {
    if (c.slot < 0 || c.slot >= HOTCUE_COUNT || !(c.timestamp >= 0) || c.timestamp > duration) continue;
    hotcues[c.slot] = c.timestamp;
    cueDetails[c.slot] = { slot: c.slot, type: "hotcue", name: c.name, colour: c.colour, timestamp: c.timestamp };
  }
  return { hotcues, cueDetails };
}

function fromDeckFields(hotcues: (number | null)[], cueDetails: (PreparedCue | null)[]): EmbeddedCue[] {
  const out: EmbeddedCue[] = [];
  for (let slot = 0; slot < hotcues.length; slot++) {
    const t = hotcues[slot];
    if (t === null) continue;
    const d = cueDetails[slot];
    out.push({ slot, timestamp: t, name: d?.name ?? String.fromCharCode(65 + slot), colour: d?.colour ?? CUE_COLOURS[slot % CUE_COLOURS.length] });
  }
  return out;
}

/**
 * Wraps a PreparationPort so hot cues can be switched, independently per deck,
 * between two homes: this app's own preparation database ("suggested", the
 * inner port's normal behaviour) or the track's own file tag ("embedded",
 * MP3/WAV). Everything else a PreparationPort carries (cue point, loops, beat
 * grid) always goes through the inner port untouched, regardless of mode.
 */
export class CueSourceRouter implements PreparationPort {
  constructor(
    private readonly inner: PreparationPort,
    private readonly embedded: EmbeddedCueBridge | null,
    private readonly getCueSource: (deck: number) => CueSource,
    private readonly onError: (message: string) => void,
  ) {}

  async restore(track: TrackInfo, bytes: ArrayBuffer, duration: number, deck: number): Promise<Partial<DeckState>> {
    const base = await this.inner.restore(track, bytes, duration, deck);
    if (this.getCueSource(deck) !== "embedded" || track.source !== "local" || !this.embedded) return base;
    const result = await this.embedded.read(track.ref);
    if (!result.ok) {
      this.onError(`Couldn't read embedded hot cues for "${track.title}": ${result.error ?? "unknown error"}`);
      return base;
    }
    if (!result.supported) {
      this.onError(`"${track.title}" has no embedded hot cue support (only MP3 and WAV files carry them) — showing no hot cues.`);
      return { ...base, ...toDeckFields([], duration) };
    }
    return { ...base, ...toDeckFields(result.cues, duration) };
  }

  changed(previous: DeckState, next: DeckState, patch: Partial<DeckState>): void {
    const touchesCues = "hotcues" in patch || "cueDetails" in patch;
    if (this.getCueSource(next.index) !== "embedded" || !touchesCues) {
      this.inner.changed(previous, next, patch);
      return;
    }
    // Everything but the cues themselves still saves to the suggested database as usual.
    const rest: Partial<DeckState> = { ...patch };
    delete rest.hotcues;
    delete rest.cueDetails;
    if (Object.keys(rest).length) this.inner.changed(previous, next, rest);
    const track = next.track;
    if (!track || track.source !== "local" || !this.embedded) return;
    void this.embedded.write(track.ref, fromDeckFields(next.hotcues, next.cueDetails)).then((r) => {
      if (!r.ok) this.onError(`Couldn't save hot cues into "${track.title}": ${r.error ?? "unknown error"}`);
    });
  }
}

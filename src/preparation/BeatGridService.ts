/**
 * Beat grid editing — the single path every grid edit goes through (deck Beat grid editor, waveform
 * dragging, Transition Guides' nudges).
 *
 * Each edit is saved to the track's preparation record as "set by hand" (analysis never overwrites a
 * hand-set grid), pushed to any deck that has the track loaded, and recorded for Undo. Auto DJ,
 * Transition Lab, Auto Cue and DJ Training all read that record / deck grid, so they pick it up at once.
 * "Reset to analysed" restores the detected grid from the cached analysis — no re-analysis, nothing else
 * about the track changes.
 */
import type { BeatGrid } from "../core/engine/DJEngine";
import { Emitter } from "../core/events";
import type { PreparationStore } from "./PreparationStore";
import type { PreparedGrid } from "./types";
import { alignedToOnsets, doubled, downbeatNear, halved, nudged, onsetEnvelope, shifted, snapToOnset, validBpm, withBpm, withDownbeat, type GridPoint } from "./beatGrid";

export interface BeatGridDeps {
  preparation: Pick<PreparationStore, "get" | "setGrid" | "waveform">;
  engine: { refreshPreparation(trackId: string, fields: { beatGrid: BeatGrid }): void };
  log?: (level: "info" | "warn", message: string) => void;
}

export type GridResult = { ok: true } | { ok: false; reason: string };
const OK: GridResult = { ok: true };
const fail = (reason: string): GridResult => ({ ok: false, reason });
const HISTORY = 30;

export class BeatGridService extends Emitter<{ change: { trackId: string } }> {
  private history = new Map<string, PreparedGrid[]>();
  private onsets = new Map<string, { env: Float32Array; fps: number }>();
  constructor(private d: BeatGridDeps) { super(); }

  grid(trackId: string): PreparedGrid | null { return this.d.preparation.get(trackId)?.beatGrid ?? null; }
  canUndo(trackId: string): boolean { return (this.history.get(trackId)?.length ?? 0) > 0; }

  /** Type a BPM (or use a tapped one). `anchor`: a time that stays on a downbeat — the playhead's bar. */
  setBpm(trackId: string, bpm: number, anchor?: number): GridResult {
    if (!validBpm(bpm)) return fail("Enter a BPM between 40 and 300");
    const g = this.grid(trackId);
    return this.write(trackId, g ? withBpm(g, bpm, anchor === undefined ? g.firstBeat : downbeatNear(g, anchor)) : { bpm, firstBeat: Math.max(0, anchor ?? 0) });
  }
  /** ×2 / ÷2: fix a half- or double-time detection, keeping the bar under `anchor` in place. */
  double(trackId: string, anchor?: number): GridResult { return this.scale(trackId, "double", anchor); }
  halve(trackId: string, anchor?: number): GridResult { return this.scale(trackId, "halve", anchor); }
  /** Make the beat at `t` bar 1 — optionally snapped to the nearest kick/snare onset first. */
  async setDownbeat(trackId: string, t: number, snap = true): Promise<GridResult> {
    const g = this.grid(trackId);
    if (!g) return fail("This track has no beat grid yet — type or tap its BPM first");
    const env = snap ? await this.onsetsFor(trackId) : null;
    return this.write(trackId, withDownbeat(g, env ? snapToOnset(env.env, env.fps, t) : t));
  }
  nudge(trackId: string, by: { beats?: number; ms?: number; bpm?: number }): GridResult {
    const g = this.grid(trackId);
    return g ? this.write(trackId, nudged(g, by)) : fail("No beat grid to nudge");
  }
  /** Slide the grid by `seconds` (dragging it on the waveform). */
  shift(trackId: string, seconds: number): GridResult {
    const g = this.grid(trackId);
    if (!g) return fail("No beat grid to move");
    return Math.abs(seconds) < 1e-4 ? OK : this.write(trackId, shifted(g, seconds));
  }
  /** Keep the BPM; move the grid onto where the kicks/snares actually fall across the track. */
  async alignToBeats(trackId: string): Promise<GridResult> {
    const g = this.grid(trackId);
    if (!g) return fail("No beat grid to align");
    const env = await this.onsetsFor(trackId);
    if (!env) return fail("No cached analysis for this track — analyse it first");
    const next = alignedToOnsets(g, env.env, env.fps);
    return next ? this.write(trackId, next) : fail("Couldn't find a steady beat to align to — set the downbeat by hand");
  }
  /** "Grid looks right ✓": trust it as it is (no change to BPM or downbeat). */
  confirm(trackId: string): GridResult {
    const g = this.grid(trackId);
    return g ? this.write(trackId, g) : fail("No beat grid to confirm");
  }
  /** Mark where an 8-bar phrase starts (snapped to the nearest downbeat), or clear it with null. */
  setPhraseStart(trackId: string, t: number | null): GridResult {
    const g = this.grid(trackId);
    if (!g) return fail("Set the beat grid before marking phrases");
    return this.write(trackId, g, { phraseAnchor: t === null ? null : Math.max(0, downbeatNear(g, t)) });
  }
  /** Restore the detected grid from the cached analysis (cues, key, energy and everything else stay). */
  async resetToAnalysed(trackId: string): Promise<GridResult> {
    const a = await this.d.preparation.waveform(trackId);
    if (!a || !a.bpm || a.firstBeat === null) return fail("No analysed grid is cached for this track — use Reanalyse in the track menu");
    return this.write(trackId, { bpm: a.bpm, firstBeat: a.firstBeat }, { manual: false, confidence: a.confidence, source: a.bpmSource });
  }
  undo(trackId: string): GridResult {
    const prev = this.history.get(trackId)?.pop();
    if (!prev) return fail("Nothing to undo");
    return this.write(trackId, prev, { manual: prev.manuallyAdjusted, confidence: prev.confidence, source: prev.source, phraseAnchor: prev.phraseAnchor ?? null, record: false });
  }

  private scale(trackId: string, how: "double" | "halve", anchor?: number): GridResult {
    const g = this.grid(trackId);
    if (!g) return fail("No beat grid to change");
    const a = anchor === undefined ? undefined : downbeatNear(g, anchor);
    const next = how === "double" ? doubled(g, a) : halved(g, a);
    return validBpm(next.bpm) ? this.write(trackId, next) : fail(`${next.bpm.toFixed(1)} BPM is outside 40–300`);
  }

  private write(trackId: string, next: GridPoint, o: { manual?: boolean; confidence?: number; source?: BeatGrid["source"]; phraseAnchor?: number | null; record?: boolean } = {}): GridResult {
    const before = this.grid(trackId);
    const phraseAnchor = o.phraseAnchor !== undefined ? o.phraseAnchor : before?.phraseAnchor ?? null;
    const r = this.d.preparation.setGrid(trackId, {
      bpm: next.bpm, firstBeat: next.firstBeat, confidence: o.confidence ?? before?.confidence ?? 0, source: o.source ?? before?.source ?? "metadata", phraseAnchor,
    }, o.manual ?? true);
    if (!r?.beatGrid) return fail("Couldn't save the grid (track not found or BPM out of range)");
    if (o.record !== false && before) {
      const h = this.history.get(trackId) ?? [];
      h.push(before); if (h.length > HISTORY) h.shift();
      this.history.set(trackId, h);
    }
    this.d.engine.refreshPreparation(trackId, { beatGrid: r.beatGrid });
    this.emit("change", { trackId });
    return OK;
  }

  private async onsetsFor(trackId: string): Promise<{ env: Float32Array; fps: number } | null> {
    const hit = this.onsets.get(trackId);
    if (hit) return hit;
    const a = await this.d.preparation.waveform(trackId);
    if (!a || !a.low?.length) return null;
    const v = { env: onsetEnvelope(a.low, a.mid), fps: a.fps };
    if (this.onsets.size > 6) this.onsets.delete(this.onsets.keys().next().value!);
    this.onsets.set(trackId, v);
    return v;
  }
}

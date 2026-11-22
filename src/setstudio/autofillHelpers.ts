import { bpmRelation, harmonic } from "./scoring";
import type { HardConstraints, SetTrack } from "./types";

/** Hard constraints for the optimiser: per-track filters, and (with `prev`) per-transition ones. */
export function hardOk(prev: SetTrack | null, t: SetTrack, h?: HardConstraints): boolean {
  if (!h) return true;
  if (!prev) {
    if (h.bpmMin != null && (!t.bpm || t.bpm < h.bpmMin)) return false;
    if (h.bpmMax != null && (!t.bpm || t.bpm > h.bpmMax)) return false;
    if (h.energyMin != null && (t.energy === null || t.energy < h.energyMin)) return false;
    if (h.energyMax != null && (t.energy === null || t.energy > h.energyMax)) return false;
    if (h.keys?.length && (!t.camelot || !h.keys.includes(t.camelot))) return false;
    return true;
  }
  if (h.maxBpmJumpPct != null) { const r = bpmRelation(prev.bpm, t.bpm); if (!r || r.pct > h.maxBpmJumpPct) return false; }
  if (h.harmonicOnly) { const k = harmonic(prev.camelot ?? prev.key, t.camelot ?? t.key); if (!k || k.score < 0.85) return false; }
  return true;
}

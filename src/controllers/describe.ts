import { actionCatalog } from "../core/actions";
import type { EngineState } from "../core/engine/DJEngine";
import type { Translation } from "./mapping/MappingRuntime";

/**
 * Human-readable description of a translated controller event for the live
 * feed, e.g. "PLAY A", "JOG A +4", "TEMPO A +1.7%", "EQ HIGH A 64", "PAD A1 · Hot cue 1 A".
 * Returns null for events not worth a line (button releases).
 */
export function friendlyEvent(t: Translation, state: EngineState): string | null {
  const meta = actionCatalog().get(t.action);
  const kind = t.control?.kind;
  let label = t.control?.short ?? meta?.label.toUpperCase() ?? t.action;
  if (t.binding.modifier && meta) label = `${t.binding.modifier.toUpperCase()}+${label} · ${meta.label}`;

  if (t.action.startsWith("modifier.")) return `${label} ${t.value > 0 ? "DOWN" : "UP"}`;
  if (kind === "jog-touch") return `${label} ${t.value > 0 ? "ON" : "OFF"}`;

  switch (meta?.valueType) {
    case "button": {
      if (t.value <= 0) return null;
      if (kind === "pad" || t.binding.note) return `${label} · ${meta.label}`;
      return label;
    }
    case "relative": {
      const v = Math.round(t.value);
      const suffix = t.action.endsWith(".jog.ring") ? " (side)" : t.action.endsWith(".jog.search") ? " (search)" : "";
      return `${label} ${v > 0 ? "+" : ""}${v}${suffix}`;
    }
    case "absolute": {
      const tempo = /^deck(\d+)\.tempo$/.exec(t.action);
      if (tempo) {
        const d = state.decks[Number(tempo[1]) - 1];
        if (d) {
          const pct = (d.rate - 1) * 100;
          return `${label} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
        }
      }
      return `${label} ${Math.round(t.value * 127)}`;
    }
    default:
      return `${label} ${t.value}`;
  }
}

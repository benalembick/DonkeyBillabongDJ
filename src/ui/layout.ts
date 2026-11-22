/**
 * UI layout preferences (presentation only — switching never touches the
 * engine, loaded tracks, cue points or analysis). Persisted in localStorage.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_WAVE_STYLE, WAVE_STYLES, type WaveStyle } from "./waveStyle";

export type LayoutMode = "horizontal" | "vertical" | "classic";

export interface LayoutPrefs {
  mode: LayoutMode;
  /** Library height in px per layout (user-resizable). */
  libraryHeight: Record<LayoutMode, number>;
  /** Seconds of audio visible across a scrolling waveform. */
  zoomSeconds: number;
  /** Scrolling waveform colouring: frequency bands or separated STEMS lanes. */
  waveMode: "standard" | "stems";
  /** Waveform colouring: tonal (Dual-Deck Tonal, default) / simple / filtered / rgb / rgbLR / hsv. */
  waveStyle: WaveStyle;
  /** Waveforms follow each deck's EQ (a cut band fades from the picture). Display only. */
  waveEqReactive: boolean;
  /** Which one-off default changes have been applied to saved prefs (see load()). */
  defaultsVersion: number;
}

const KEY = "dbdj.ui.layout.v1";
const vh = typeof window !== "undefined" ? window.innerHeight : 1000;
const DEFAULTS: LayoutPrefs = {
  mode: "horizontal",
  // Proportional to the screen so 1080p laptops and 1440p+ monitors both start sensibly.
  libraryHeight: { horizontal: Math.round(vh * 0.32), vertical: Math.round(vh * 0.3), classic: Math.round(vh * 0.45) },
  zoomSeconds: 10,
  waveMode: "standard",
  waveStyle: DEFAULT_WAVE_STYLE,
  waveEqReactive: true,
  defaultsVersion: 1,
};
export const ZOOM_STEPS = [2, 4, 6, 8, 10, 14, 20, 30];

function load(): LayoutPrefs {
  try {
    return migratePrefs(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutPrefs>);
  } catch {
    return DEFAULTS;
  }
}

/**
 * Saved prefs → current prefs. Version 1: Dual-Deck Tonal became the default waveform style,
 * so prefs saved with the previous default ("rgb") switch to it once; any other saved choice
 * is kept, and picking RGB again afterwards sticks.
 */
export function migratePrefs(raw: Partial<LayoutPrefs>): LayoutPrefs {
  let waveStyle = WAVE_STYLES.some((s) => s.id === raw.waveStyle) ? raw.waveStyle! : DEFAULTS.waveStyle;
  if ((raw.defaultsVersion ?? 0) < 1 && waveStyle === "rgb") waveStyle = DEFAULT_WAVE_STYLE;
  return {
    ...DEFAULTS,
    ...raw,
    waveStyle,
    waveEqReactive: raw.waveEqReactive !== false,
    defaultsVersion: DEFAULTS.defaultsVersion,
    libraryHeight: { ...DEFAULTS.libraryHeight, ...raw.libraryHeight },
  };
}

let prefs = load();
const listeners = new Set<() => void>();

export function getLayout(): LayoutPrefs {
  return prefs;
}

export function setLayout(patch: Partial<LayoutPrefs>): void {
  prefs = { ...prefs, ...patch, libraryHeight: { ...prefs.libraryHeight, ...patch.libraryHeight } };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* best effort */
  }
  for (const l of listeners) l();
}

export function zoom(direction: 1 | -1): void {
  const i = ZOOM_STEPS.findIndex((z) => z >= prefs.zoomSeconds);
  const j = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? ZOOM_STEPS.length - 1 : i) + direction));
  setLayout({ zoomSeconds: ZOOM_STEPS[j] });
}

export function useLayout(): LayoutPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => prefs,
  );
}

/** Hot cue colours (also used on the pads). Functional per-cue identity: never recoloured by deck. */
export const HOTCUE_COLORS = ["#ff3b6b", "#ff9f1c", "#ffd60a", "#2ee59d", "#00c2ff", "#4f7dff", "#b36bff", "#ff6bd6"];

/** STEM colours (deck strip, waveform lanes). Stem identity, separate from the waveform's frequency-band colours. */
export const STEM_COLORS: Record<string, string> = { vocals: "#ff4fa3", drums: "#ffcc33", bass: "#3fa9ff", instruments: "#5ee07a" };

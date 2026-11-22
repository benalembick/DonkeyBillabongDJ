/**
 * Deck colour identity — the single source of truth for every deck-specific colour.
 *
 * Deck A is electric blue, deck B warm amber. The same definitions feed:
 *  - the canvas waveform renderers (scrolling + overview), via `deckWavePalette()`;
 *  - all CSS (deck panels, BPM ring, FX units, mixer channels, crossfader, library
 *    load buttons), via CSS custom properties written onto :root by `installDeckThemeCss()`.
 *
 * Colours belong to the deck, never to the track: a track loaded on deck A is drawn blue,
 * the same track on deck B amber, from the same cached analysis (no re-analysis).
 *
 * Adding a theme later (blue/red, cyan/magenta, user-defined…) = another `DeckThemeSet`
 * and a call to `setDeckThemeSet()`; nothing else hardcodes deck colours.
 */

export interface DeckTheme {
  /** Ownership accent: borders, badges, BPM ring, active controls. */
  primary: string;
  /** Darker accent (pressed states, low-band waveform core). */
  deep: string;
  /** Light accent (focus rings, tempo marker, high-band waveform detail). */
  highlight: string;
  /** Subtle panel undertone (mixed into the dark panel background, never used full-strength). */
  background: string;
  /** Glow colour for active controls (used at low alpha). */
  glow: string;
  /** Text colour that reads on a `primary` fill. */
  ink: string;
  /** Three-band tonal waveform ramp. */
  waveform: { low: string; mid: string; high: string };
}

export type DeckThemeSet = readonly [DeckTheme, DeckTheme];

export const DECK_A_BLUE: DeckTheme = {
  primary: "#0EA5E9", // Electric Blue
  deep: "#1D4ED8", // Royal Blue
  highlight: "#BAE6FD", // Ice Cyan
  background: "#071827", // Dark Navy
  glow: "#0EA5E9",
  ink: "#03121c",
  waveform: { low: "#1D4ED8", mid: "#0EA5E9", high: "#BAE6FD" },
};

export const DECK_B_AMBER: DeckTheme = {
  primary: "#F59E0B", // Warm Gold/Orange
  deep: "#B45309", // Burnt Amber
  highlight: "#FEF08A", // Pale Cream/Yellow
  background: "#211608", // Dark Brown
  glow: "#F59E0B",
  ink: "#1a1003",
  waveform: { low: "#B45309", mid: "#F59E0B", high: "#FEF08A" },
};

/** The default dual-deck identity: blue / amber. */
export const BLUE_AMBER: DeckThemeSet = [DECK_A_BLUE, DECK_B_AMBER];

let active: DeckThemeSet = BLUE_AMBER;
let version = 0;

/** Theme for a deck index (0 = A, 1 = B; further indices alternate A/B). */
export function deckTheme(deck: number): DeckTheme {
  return active[((deck % 2) + 2) % 2];
}

/** Changes the active theme set (future custom palettes) and re-applies the CSS variables. */
export function setDeckThemeSet(set: DeckThemeSet): void {
  active = set;
  version++;
  wavePalettes = [toWavePalette(set[0]), toWavePalette(set[1])];
  if (typeof document !== "undefined") installDeckThemeCss(document.documentElement);
}

/** Bumped whenever the theme set changes — part of waveform cache keys so tiles redraw. */
export function deckThemeVersion(): number {
  return version;
}

// ── waveform palette (packed 0xRRGGBB for the pixel renderer) ──

export interface WavePalette {
  low: number;
  mid: number;
  high: number;
}

export const hexToPacked = (hex: string): number => parseInt(hex.replace("#", "").slice(0, 6), 16);

function toWavePalette(t: DeckTheme): WavePalette {
  return { low: hexToPacked(t.waveform.low), mid: hexToPacked(t.waveform.mid), high: hexToPacked(t.waveform.high) };
}

let wavePalettes: [WavePalette, WavePalette] = [toWavePalette(BLUE_AMBER[0]), toWavePalette(BLUE_AMBER[1])];

/** Packed three-band waveform palette for a deck (precomputed; safe to call every frame). */
export function deckWavePalette(deck: number): WavePalette {
  return wavePalettes[((deck % 2) + 2) % 2];
}

// ── CSS custom properties ──

/** CSS variables for one deck, e.g. `--deck-a-primary`. */
export function deckCssVars(letter: "a" | "b", t: DeckTheme): Record<string, string> {
  const p = `--deck-${letter}`;
  return {
    [`${p}-primary`]: t.primary,
    [`${p}-deep`]: t.deep,
    [`${p}-highlight`]: t.highlight,
    [`${p}-bg`]: t.background,
    [`${p}-glow`]: t.glow,
    [`${p}-ink`]: t.ink,
    [`${p}-low`]: t.waveform.low,
    [`${p}-mid`]: t.waveform.mid,
    [`${p}-high`]: t.waveform.high,
  };
}

/** Every deck CSS variable for the active theme set. */
export function allDeckCssVars(): Record<string, string> {
  return { ...deckCssVars("a", active[0]), ...deckCssVars("b", active[1]) };
}

/** Writes the deck CSS variables onto an element (the document root at startup). */
export function installDeckThemeCss(el: { style: { setProperty(name: string, value: string): void } }): void {
  for (const [k, v] of Object.entries(allDeckCssVars())) el.style.setProperty(k, v);
}

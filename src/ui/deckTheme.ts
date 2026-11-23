/**
 * Deck colour identity — the single source of truth for every deck-specific colour.
 *
 * Deck A is blue, deck B orange, deck C green and deck D purple (the four-deck identity,
 * docs/architecture/four-deck-performance-engine.md §7). The same definitions feed:
 *  - the canvas waveform renderers (scrolling + overview), via `deckWavePalette()`;
 *  - all CSS (deck panels, BPM ring, FX units, mixer channels, crossfader, library
 *    load buttons, hardware focus borders), via CSS custom properties written onto :root by
 *    `installDeckThemeCss()`.
 *
 * Colours belong to the deck, never to the track: a track loaded on deck A is drawn blue,
 * the same track on deck C green, from the same cached analysis (no re-analysis).
 *
 * Colour is never the only identity cue: every deck also carries its letter, and the deck
 * badges use a different shape per deck (see styles.css `.deck-letter`).
 *
 * Adding a theme later (user-defined palettes…) = another `DeckThemeSet` and a call to
 * `setDeckThemeSet()`; nothing else hardcodes deck colours.
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

/** One theme per deck, in deck order (A, B, C, D). */
export type DeckThemeSet = readonly DeckTheme[];

export const DECK_LETTERS = ["a", "b", "c", "d"] as const;
export type DeckLetter = (typeof DECK_LETTERS)[number];

export const DECK_A_BLUE: DeckTheme = {
  primary: "#38A4FF", // Blue
  deep: "#1E5FD0", // Royal blue (low-band core)
  highlight: "#BFE3FF", // Ice
  background: "#0A1828", // Dark navy
  glow: "#38A4FF",
  ink: "#04121F",
  waveform: { low: "#1E5FD0", mid: "#38A4FF", high: "#BFE3FF" },
};

export const DECK_B_ORANGE: DeckTheme = {
  primary: "#FF7956", // Orange
  deep: "#C2412A", // Burnt orange
  highlight: "#FFD3C4", // Peach cream
  background: "#24120D", // Dark rust
  glow: "#FF7956",
  ink: "#1F0B05",
  waveform: { low: "#C2412A", mid: "#FF7956", high: "#FFD3C4" },
};

export const DECK_C_GREEN: DeckTheme = {
  primary: "#48D69A", // Green
  deep: "#1C8C5E", // Forest
  highlight: "#C6F5DE", // Mint
  background: "#0B1F17", // Dark green
  glow: "#48D69A",
  ink: "#04170F",
  waveform: { low: "#1C8C5E", mid: "#48D69A", high: "#C6F5DE" },
};

export const DECK_D_PURPLE: DeckTheme = {
  primary: "#B38AFF", // Purple
  deep: "#6B3FD1", // Violet
  highlight: "#E4D6FF", // Lavender
  background: "#18112A", // Dark plum
  glow: "#B38AFF",
  ink: "#120A24",
  waveform: { low: "#6B3FD1", mid: "#B38AFF", high: "#E4D6FF" },
};

/** The default four-deck identity: blue / orange / green / purple. */
export const FOUR_DECK_THEME: DeckThemeSet = [DECK_A_BLUE, DECK_B_ORANGE, DECK_C_GREEN, DECK_D_PURPLE];

let active: DeckThemeSet = FOUR_DECK_THEME;
let version = 0;

const wrap = (deck: number, n: number) => ((deck % n) + n) % n;

/** Theme for a deck index (0 = A … 3 = D; further indices wrap). */
export function deckTheme(deck: number): DeckTheme {
  return active[wrap(deck, active.length)];
}

/** CSS letter for a deck index ("a" … "d"). */
export function deckCssLetter(deck: number): DeckLetter {
  return DECK_LETTERS[wrap(deck, DECK_LETTERS.length)];
}

/** Changes the active theme set (future custom palettes) and re-applies the CSS variables. */
export function setDeckThemeSet(set: DeckThemeSet): void {
  if (!set.length) return;
  active = set;
  version++;
  wavePalettes = set.map(toWavePalette);
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

let wavePalettes: WavePalette[] = FOUR_DECK_THEME.map(toWavePalette);

/** Packed three-band waveform palette for a deck (precomputed; safe to call every frame). */
export function deckWavePalette(deck: number): WavePalette {
  return wavePalettes[wrap(deck, wavePalettes.length)];
}

// ── CSS custom properties ──

/** CSS variables for one deck, e.g. `--deck-a-primary`. */
export function deckCssVars(letter: DeckLetter, t: DeckTheme): Record<string, string> {
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

/** Every deck CSS variable for the active theme set (always all four decks). */
export function allDeckCssVars(): Record<string, string> {
  return Object.assign({}, ...DECK_LETTERS.map((l, i) => deckCssVars(l, deckTheme(i))));
}

/** Writes the deck CSS variables onto an element (the document root at startup). */
export function installDeckThemeCss(el: { style: { setProperty(name: string, value: string): void } }): void {
  for (const [k, v] of Object.entries(allDeckCssVars())) el.style.setProperty(k, v);
}

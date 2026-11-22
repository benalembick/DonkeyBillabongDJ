# Deck colour identity and Dual-Deck Tonal waveforms

Deck A is **electric blue** and deck B is **warm amber**, everywhere a control or display belongs to one deck. The waveforms use the same identity: by default each deck is drawn in a three-band tonal ramp of its own colour, built from the real low/mid/high analysis.

Colours follow the **deck**, not the track. A track on deck A is blue; the same track on deck B is amber, drawn from the same cached analysis without re-analysis. When Auto DJ alternates decks, crossfades or runs Auto EQ, deck A stays blue and deck B amber. Colours never swap to follow whichever deck is louder.

## The palette

| | Deck A — Electric Blue | Deck B — Warm Amber |
|---|---|---|
| Primary accent | `#0EA5E9` | `#F59E0B` |
| Deep accent | `#1D4ED8` | `#B45309` |
| Highlight | `#BAE6FD` | `#FEF08A` |
| Panel undertone | `#071827` | `#211608` |
| Active glow | `#0EA5E9` | `#F59E0B` |
| Waveform lows (kick, bass) | `#1D4ED8` deep royal blue | `#B45309` burnt amber |
| Waveform mids (vocals, synths) | `#0EA5E9` electric blue | `#F59E0B` warm gold |
| Waveform highs (hats, cymbals) | `#BAE6FD` ice cyan | `#FEF08A` pale cream |

## One source of truth

`src/ui/deckTheme.ts` holds every deck colour:

- `deckTheme(deck)` returns the theme for a deck index (0 = A, 1 = B; further indices alternate).
- `deckWavePalette(deck)` returns the waveform ramp as packed `0xRRGGBB`, precomputed and cheap to call every frame. The scrolling and overview renderers use it.
- `installDeckThemeCss(document.documentElement)` runs once at startup in `src/main.tsx`. It writes `--deck-a-primary`, `--deck-a-deep`, `--deck-a-highlight`, `--deck-a-bg`, `--deck-a-glow`, `--deck-a-ink`, `--deck-a-low`, `--deck-a-mid` and `--deck-a-high` onto `:root`, plus the same set for deck B.

In `styles.css`, the older short names (`--deck-a`, `--deck-a-strong`, `--deck-b`, `--deck-b-strong`) are now aliases of those variables, so no hex value is defined twice. Deck scopes then give each component generic names (`--deck-color`, `--deck-color-strong`, `--deck-deep`, `--deck-tint`, `--deck-glow`, `--deck-ink`):

| Scope class | Used by |
|---|---|
| `.deck-a` / `.deck-b` | Deck panels, scrolling waveform lanes |
| `.deck-scope-a` / `.deck-scope-b` | FX units (FX1 = deck A side, FX2 = deck B side, as on the DDJ-SB), crossfader ends |
| `.strip.channel-a` / `.strip.channel-b` | Mixer channel strips |

A component written against `--deck-color` works for either deck. `tests/deckTheme.test.ts` checks two things: every `--deck-a-*`/`--deck-b-*` variable the stylesheet uses is defined by the theme, and `:root` hardcodes no deck colour.

## Where the deck colour is used, and where it is not

The deck colour marks **ownership, selection and active state**:

- **Deck panel:** thin border, faint undertone, brighter border and soft glow while playing, deck badge.
- **BPM ring:** ring colour, tempo marker, pitch range label, tempo fader.
- **Transport:** a deck-coloured ring around CUE and PLAY.
- **Deck controls:** lit buttons (SYNC, KEY LOCK, VINYL, loop AUTO/IN/EXIT), the Suggested/Embedded cue-source selection, hover and keyboard focus.
- **Sections:** the edges of the hot cue and STEMS sections, and the STEMS switch and progress.
- **Waveforms:** the waveform lanes and their bar counters.
- **FX units:** active slots, lit FX buttons, knob arcs and A/B assign buttons.
- **Mixer channels:** channel names, EQ/trim/filter knob arcs, channel faders and the crossfader ends.
- **Library:** load buttons. A button is filled and marked "●" when its deck holds that track; if the same track is on both decks, both buttons are filled.

These keep their **functional** colours:

- **Hot cue pads.** The eight per-pad colours in `HOTCUE_COLORS` are not recoloured, and cue data is not touched.
- **STEM colours.** Vocals pink, drums yellow, bass blue, instruments green. These are stem identity, which is separate from the waveform's frequency bands.
- **Transport states.** CUE yellow, PLAY green, MASTER amber.
- **Loop state.** Loops are green: the loop-size readout and the loop regions on the waveform.
- **Jog states.** Touch (warn) and loop-out adjust (green) on the jog ring.
- **Warnings and metering.** Kill and clip red, Auto EQ green, meter green/amber/red, error and warning text.
- **Waveform markers.** The red playhead (now with a dark outline so it reads on amber), the white beat grid (bars brighter than beats), cue and hot-cue markers, and the Auto DJ in/out regions.

The MASTER mixer strip stays neutral. Navigation, the library table and the general UI accent are unchanged.

Selected and active states never rely on colour alone. Lit buttons are filled and bold, deck B's badge and crossfader end are round where deck A's are square, and loaded library buttons switch from "→" to "●".

## Dual-Deck Tonal waveform rendering

The pipeline is **analysis → band data → palette mapping → rendering**.

1. **Analysis** (unchanged). `analyzeTrack` stores per-channel full-band, low, mid and high peaks 150 times a second. The crossovers are the channel EQ's own (220 Hz, 3.5 kHz; `EQ_LOW_HZ`/`EQ_HIGH_HZ` in `mixerMath.ts`). The data is cached with the waveform and is independent of any colour.
2. **Band data.** `waveData()` derives normalisers once per analysis, memoised per analysis object. One of them is new: `bandNorm`, the 99.5th-percentile peak of each band.
3. **Palette mapping.** `tonalShares()` turns a column's low/mid/high values into shares that sum to 1. It divides each band by its own track-level peak first, so a bass-heavy track does not paint every column as bass. That boost is capped: no band is normalised by less than 30 % of the loudest band's peak. A track with almost no high end therefore keeps almost no highs, and nothing is invented.
4. **Rendering.** In `drawColumn()`, style `"tonal"`, each column keeps the **true amplitude**: the full-band peak, the same height as the RGB style. The column is then split into non-overlapping segments, symmetrical about the centre:
   - **Low core** in the deck's deep colour. Its size grows with the low share, so kicks and bass read as a heavy core.
   - **Mid body**: the weighted blend of the three colours by share. For vocals and synths this is the deck's main colour.
   - **High edges** in the pale colour, at the outer tips. Their thickness grows with the high share, so hats and cymbals read as bright transient detail.

   Brightness runs from 50 % for near-silence to 100 % at the track's loud level, which keeps quiet passages subdued. Silence draws nothing.

The segments don't overlap, so a tonal column writes the same number of pixels as one RGB bar. It goes through the same `PixelSink` (direct `ImageData` writes) and the same cached 1024-px tiles. Timing, zoom, scrolling, scratching, seeking and every marker are unchanged.

`tonalPacked()` / `tonalColor()` return the composite colour on its own, for any view that draws one colour per column.

### Overview and scrolling waveform agree

Both views call `drawColumn()` with the same style and `deckWavePalette(deck)`. The overview is coarser (one column spans more frames), but the colour logic is identical. The overview still darkens the played part, and shows the cue, hot cues, loop, Auto DJ region and playhead as before.

### EQ-reactive rendering

Before mapping, the column's bands are multiplied by the deck's current EQ display gains (`deckEq` → `eqVisualGain`, the same knob → dB curve as the audio EQ). The amplitude follows the change in band energy. The effect on each band:

| Cut | Deck A | Deck B |
|---|---|---|
| LOW | the royal-blue core shrinks or disappears | the burnt-amber core shrinks or disappears |
| MID | the electric-blue body thins and re-blends | the gold body thins and re-blends |
| HIGH | the ice-cyan edges disappear | the pale-cream edges disappear |

Auto EQ writes the same mixer state, so its transitions show the same way. The analysis is never modified or re-run, and the audio path is not involved; this is an approximation from the EQ curve, not a measurement of the output. Settings → Waveform → **Waveforms follow the deck EQ** turns it off (layout pref `waveEqReactive`). Off passes neutral gains, so the picture is exactly the analysed one.

## Caching and compatibility

- **Analysis caches are unchanged.** No migration and no re-analysis are needed. Tracks cached before per-channel display bands existed still render from their mono bands, as for every style.
- **Tile caches.** Scrolling tile keys and the overview raster key include the style, the deck and `deckThemeVersion()`, so changing the theme set redraws the tiles. EQ changes redraw tiles in place, as before.
- **Preferences.** `dbdj.ui.layout.v1` in localStorage gains `waveEqReactive` and `defaultsVersion`. Prefs saved with the old default (`rgb`) move to `tonal` once (defaultsVersion 0 → 1). Every other style choice is kept.

## Performance

- No extra analysis or decoding. `bandNorm` costs three sampled percentile passes, once per analysis.
- Per column: a few multiplications plus three precomputed colours. No allocation (scratch buffers), and the same pixel writes as the existing styles.
- The CSS changes are static. The only per-state class is `.is-playing` on the deck panel, which re-renders on engine state changes anyway.

## Verifying

- **Unit tests.** `tests/deckTheme.test.ts` covers the palettes, CSS/renderer consistency, band → colour mapping, blending, amplitude, silence, normalisation, EQ reactivity and the preference migration.
- **Visual smoke.** Run `npm run build`, then `DBDJ_SMOKE_TEST=1 DBDJ_SMOKE_DECKS="a.wav;b.wav" DBDJ_SMOKE_DECKS_SHOTS=<dir> npm start` (`electron/deckThemeSmoke.ts`). It loads a track on each deck and plays them muted. It screenshots the DJ view, kills deck B's LOW, and screenshots again.

## Future themes

Other pairs (blue/red, purple/green, cyan/magenta, user-defined) need only a new `DeckThemeSet` passed to `setDeckThemeSet()`. That call updates the CSS variables and the packed waveform palettes, and bumps the version that waveform caches are keyed on. No component hardcodes a deck colour. There is no theme picker yet.

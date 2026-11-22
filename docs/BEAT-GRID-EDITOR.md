# Beat grid editor

A beat grid is a BPM plus a first downbeat (bar 1); every fourth beat is a bar line. Auto DJ's Beat Mix, Transition Lab sync, Auto Cue's bar and phrase cues and DJ Training's timing scores all depend on it. The analyser fits each grid to the whole track and marks it **unreliable** when its confidence is below 1.4 (see [Automatic grid fitting](#automatic-grid-fitting)). This editor lets you check a grid and correct it by hand.

## Opening it

- **On a deck:** click the BPM readout. It shows **⚠ GRID** when the grid is unreliable and **✎** when it was set by hand.
- **From any grid warning:** a **Fix grid…** link appears in each of these places:
  - Transition Lab's track cards
  - the Auto DJ queue ("Beat Mix needs a trusted beat grid…")
  - Learn → Transition Guides
  - AI Set Studio → Auto Cue
  - DJ Training's track checks
- **From the track menu:** right-click a track and choose **Edit beat grid…**.

**Fix grid…** first brings the decks into view (it leaves an expanded pane or Production Studio). It then uses the deck that already has the track. If no deck has it, the track loads onto an empty or paused deck. It never loads over a playing deck or while Auto DJ is running; it says why instead.

## Tools

The editor is a panel that doesn't block the deck, so you can play, scrub and drag the waveform while it's open.

| Tool | What it does |
|---|---|
| **BPM**, **×2**, **÷2** | Sets the tempo. The bar under the playhead stays in place. |
| **TAP** | Tap along with the beat: click TAP, or press **T** anywhere while the editor is open, or **Space** / **Enter** while TAP is selected. A stray extra tap or a missed tap is ignored. **Use ###** applies the result. Space is normally Deck A's play/pause shortcut; on the selected TAP button it only taps, so tapping never starts or stops the deck that's playing out. |
| **Set downbeat here** | Makes the beat at the playhead bar 1. With *snap to kick* ticked, it first moves to the nearest kick or snare onset within 70 ms. |
| **Auto-align** | Keeps the BPM and moves the grid onto where the onsets fall across the whole track. |
| **◀ beat / beat ▶ / ±10 ms / ±.01** | Fine nudges. These are the same ones Transition Guides uses. |
| **Drag the scrolling waveform** | While the editor is open, dragging that deck's waveform slides the grid instead of scratching. Yellow lines mark phrase starts. |
| **Phrase start: Set here** | Marks the bar under the playhead as the start of an 8-bar phrase. Transition Lab snaps to phrases from it. |
| **Grid looks right ✓** | Trusts the grid as it is. |
| **Undo** | Steps back through edits made this session. |
| **Reset to analysed** | Restores the detected grid from the cached analysis. Nothing else about the track changes. |

## Saving

Every edit goes through one service, `BeatGridService` in `src/preparation/BeatGridService.ts`. The service:

- saves the grid to the track's preparation record as *set by hand*,
- pushes it to any deck with the track loaded, so Auto DJ, Transition Lab, Auto Cue and DJ Training pick it up immediately,
- keeps an undo history.

Re-analysis keeps a hand-set grid. **Reset to analysed** clears the *set by hand* flag, so the next analysis can update the grid again.

The rule for whether a grid is trusted lives in `src/preparation/beatGrid.ts` (`gridReliable`): set by hand, or confidence 1.4 or higher. Every feature uses this one function. Auto DJ's own transition planner previously ignored hand-set grids; it now follows this rule.

## Automatic grid fitting

Most grids should never need the editor. After the first-pass tempo detector, `fitGrid` in `src/analysis/gridFit.ts` checks the grid against every 16-beat window of the whole track. In each window it finds the strongest beat within a quarter beat of where the grid puts it. It then:

1. **Chooses the stream.** It keeps the first pass's phase unless a quarter, half or three-quarter beat shift carries a clearly stronger beat. The first pass sometimes locks onto a 16th-note hat, a rolling bassline or the off-beat instead of the kick.
2. **Corrects the BPM.** A fine scan (±0.4 %) and a line fit through the per-window offsets remove drift, so the grid still holds in the outro, where Auto DJ mixes out.
3. **Prefers a whole BPM** when it fits as well.
4. **Corrects 4:3 tempo errors.** Pop, hip-hop, reggaeton and dancehall often accent every 1½ beats (a 3-3-2 rhythm). The first pass can lock onto that and double it, which lands at 4:3 of the real tempo, for example 104 BPM read as 138.67. Those grids show beats a third and two thirds of the way through each grid beat. For them, the fit tries ¾ and 3⁄2 of the tempo and switches only when that is strongly confirmed.
5. **Decides trust from the evidence** (`gridTrusted`):
   - far more windows land on the grid (within ±25 ms) than chance would allow: at least 4 standard deviations;
   - at least half the track's beat (by loudness) is on it, or at least half of the intro's and outro's;
   - the grid is confirmed in both the first and last 30 % of the track. With a constant tempo, holding at both ends means it holds in between.

   Beatless breakdowns don't count for or against a grid. Windows that miss are usually other strong hits (snares, vocals, off-beat bass) being louder than the beat there, not the grid drifting.

A fit that isn't confirmed **leaves the grid as it was** and only lowers its confidence below 1.4, so Beat Mix falls back to a fade instead of mixing on a doubtful grid. A grid set by hand is never changed.

Confidence keeps its old scale: trusted fits score 1.4–2.0 by strength of evidence, unconfirmed ones below 1.4. Tracks with too little steady beat to judge (about 45 seconds of beat at 128 BPM) keep the first pass's confidence.

**Older analyses** are upgraded without decoding the audio. The fit runs on the cached analysis bands, so the result is identical to a fresh analysis. This happens:

- once in the background, about 10 seconds after startup (`AnalysisService.refitLibrary`; Diagnostics reports how many were re-fitted);
- immediately for any track loaded onto a deck or reached by library analysis before then.

The version applied is stored as `gridFitVersion` on the cached analysis and the track's preparation record. Bump `GRID_FIT_VERSION` when the fit changes, and every analysed track is re-fitted again.

**Measured on a real 287-track library** (cached analyses, before and after):

| | Before | After |
|---|---|---|
| Trusted grids | 217 | 214 |
| Corrected from a 4:3 tempo error | — | 13 (for example *Espresso* 138.67 → 104, *Believer* 166.66 → 125) |
| BPM refined | — | 119 |

The 13 corrected tracks were all trusted before at the wrong tempo, so Beat Mix would have mixed them at the wrong speed. Tracks that lost trust had weak whole-track evidence: live drummers, a DJ mix with changing tempos, or outros that don't hold the grid.

## Limits and next phases

One BPM and one downbeat can't fit a track whose tempo drifts, such as live drums without a click track. The automatic fit leaves those untrusted. If the lines still drift with the right BPM, use short or unsynced transitions. Octave choice (for example 87 vs 174 BPM) is not changed automatically. Planned:

- variable-tempo grids with several anchors
- a metronome click for checking a grid by ear
- draggable individual grid markers

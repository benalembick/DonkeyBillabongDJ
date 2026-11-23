# Four-Deck Performance Engine

DonkeyBillabongDJ grows from a two-deck DJ application into a four-deck performance platform. Users switch between the familiar two-deck workspace and a four-deck workspace at any time, without interrupting audio.

This document covers:

- what the codebase looked like before the change and what limited it to two decks (§2);
- the Phase 1 architecture as built (§3–§16);
- how Phase 1 was verified and what is still unverified (§17–§18);
- the design for Phases 2–5 (§19–§23);
- risks (§24).

**Status (2026-11-22):** Phase 1 is implemented and covered by automated tests and a real-audio Electron soak test. It has not been tested on DDJ-SB hardware (§18). Phases 2–5 are designed here and not implemented.

Deck naming: the app's existing deck identity is lettered, so decks 1–4 are shown as **A, B, C, D** (deck 1 = A … deck 4 = D). Action ids keep their numbers (`deck3.play`, `mixer.channel3.volume`).

---

## 1. Objectives

- Four independently addressable decks, with the same features each deck had before: transport, tempo, key lock, grids, sync, eight hot cues, loops, EQ, filter, FX, headphone cue and STEMS.
- A **2 DECK | 4 DECK** switch that never touches playback, mixer values, grids, cues or loops.
- An adaptive workspace: full decks A/B, and decks C/D at **full**, **compact** or **micro** density.
- A four-channel mixer with **A | THRU | B** crossfader assignment per channel.
- DDJ-SB deck layers: left side controls A or C, right side controls B or D. Soft takeover protects every absolute control when layers change.
- A shared master clock, with a defined policy for handing the master from one deck to another.
- No regressions to two-deck mixing, Auto DJ, AI Set Studio, Transition Lab, Production Studio or the library.

---

## 2. What was there before (inspection findings)

| Area | Where | Finding |
|---|---|---|
| DJ engine | `src/core/engine/DJEngine.ts` | Already collection-based: `deckCount` option, per-deck arrays (`decks`, `mixer.channels`, `autoEq`, `tempoLeadInActive`), and handlers registered per deck in a loop. **Assumptions:** created with `deckCount: 2`. Phase lock refused half/double-time pairs. No master handover beyond eject. `captureManualMashupSetup` covers decks A/B only (intended). |
| Audio engine | `src/audio/WebAudioEngine.ts` | Collection-based: one AudioWorklet deck node per deck, each with its own trim → EQ → filter → FX → fader → meter chain, plus a PFL send to a shared cue bus. **Assumptions:** created with `2`. No master clip protection, which matters once four channels sum. |
| Action catalogue | `src/core/actions.ts` | Already builds `deck1…deck4` / `mixer.channel1…4` (`MAX_DECKS = 4`). |
| Controller mapping | `src/controllers/**` | The DDJ-SB mapping binds side 1 to `deck1`/`mixer.channel1` and side 2 to `deck2`/`channel2`. No concept of layers or soft takeover. SHIFT + KEY LOCK (note 0x60) was mapped to tempo range; Mixxx uses it as its 4-deck toggle. |
| Deck colours | `src/ui/deckTheme.ts` | Exactly two themes; any further deck alternated `deck % 2`. |
| UI | `App.tsx`, `Mixer.tsx`, `Waveforms.tsx`, library panels | Hard-coded decks `0` and `1`: the stage, the mixer (`strip(0)`, `strip(1)`), the waveform stack (`[0, 1]`) and library load buttons (`deck === 0 ? "deck-a-btn" : "deck-b-btn"`). |
| Auto DJ | `src/autodj/AutoDJ.ts` | Works on decks 0/1 with `other = 1 - deck`. **Bugs with four decks:** `start()` refused when *any* deck played. `resume()` took the playing deck from *all* decks, so a playing deck C gave `deck = 2` and `1 - 2 = -1`. |
| Transition Lab | `src/setstudio/TransitionLabService.ts` | Previews on decks A/B and restores A/B channels. Already asks before stopping any playing deck, C/D included. Unchanged. |
| Live Mashup, Training, Practice | `src/mashup`, `src/training`, `src/practice` | Explicitly decks A/B (intended two-deck features). Unchanged. |
| Analysis / STEMS | `AnalysisService`, `StemService` | Per-deck arrays sized on demand: work with four decks. The STEMS worker runs one job at a time, with deck jobs ahead of library jobs (existing workload management). Background library jobs never yielded to live playback. |
| Library | `LibraryPanel`, `TrackMenu`, `PlaylistPanel`, `AudiusPane`, `SpotifyLocalPanel` | Load buttons generated from all engine decks, but coloured as A/B. |

The two-deck limit was concentrated in the composition root (`createApp.ts`) and the UI, not the engines. Phase 1 therefore raises the engines to four decks and adds the workspace, layer, takeover and ownership layers around them. It does not rebuild working code.

---

## 3. Deck collection and state

Engine and audio graph always run **four decks** (`DECK_COUNT = 4` in `createApp.ts`). 2 DECK mode is a view: decks C/D still exist, keep their state, and keep playing if they were playing.

**Stable identifiers:** deck index 0–3, action prefix `deckN` / `mixer.channelN` (N = 1–4), letter A–D, CSS scope `deck-a…deck-d`.

**Track metadata vs runtime state.** `TrackInfo` and the preparation record (grid, cues, analysis) are track-level and shared. `DeckState` and `ChannelState` are per deck: playhead, play state, tempo, loop, sync, EQ and volume. The same track on two decks shares one cached analysis. It decodes into two independent worklet buffers, so playheads, EQ and play state never interfere (`tests/fourDeckEngine.test.ts` → "the same track on two decks…"). Hot-cue edits are track-level: they persist to the preparation record and refresh every deck holding that track, which was already the behaviour.

New engine state and settings:

```ts
type CrossfaderAssign = "left" | "right" | "thru";      // A | B | THRU
EngineSettings.crossfaderAssign: CrossfaderAssign[];     // default ["left","right","left","right"]
type DeckReservation = "automation" | "manual";
EngineState.reservations: DeckReservation[];             // default ["automation","automation","manual","manual"]
```

New engine API:

- `setCrossfaderAssign(deck, assign)`: emits the event `settingsChanged`, and the app persists it.
- `channelRouting(deck)`: crossfader side, crossfader gain and linear output gain.
- `getActionValue(action)`: the software value of an absolute control, for soft takeover.
- `setDeckReservation(deck, r)`.
- `syncMultiple(f, m)`.
- `getLoadStats()`.

New actions:

- `mixer.channelN.xfader.{a,thru,b,cycle}`
- `controller.layer.{left,right}.{toggle,deckN}`
- `workspace.deckMode.{toggle,2,4}`
- `workspace.focus.deckN`
- `browser.load.focused`

---

## 4. Four-channel audio engine

```
deck worklet ─ trim ─ EQ low/mid/high ─ HPF ─ LPF ─┬─ dry ─┐
   (×4)                                             └─ FX slots ─┴─ post ─┬─ fader × crossfader × mute ─ meter ─┐
                                                                         └─ PFL send ─────────────── cue bus  │
master bus (Σ of the four channels) ─ master gain ─┬─ meter (unprotected peak)                                  │
                                                   ├─ clip guard ─ speakers (outputs 1/2)                       │
                                                   └─ headphone master feed ─┐                                  │
cue bus ─ headphone cue ─────────────────────────────────────── headphone level ─ outputs 3/4 (4-channel routing)
```

The existing per-channel order is kept unchanged: EQ → filter → FX → fader, with key lock and pitch inside the deck worklet.

- **Independent gain staging and meters:** each channel has its own trim, fader and post-fader peak meter, plus a master peak meter.
- **Summing and headroom:** channels sum on the master bus without automatic normalisation. Starting more decks never changes anyone's channel volume. Four channels at unity can reach about +12 dBFS, and headroom management stays with the DJ.
- **Clipping protection** (`src/audio/clipGuard.ts`): a zero-latency WaveShaper soft clipper between master gain and the output. It is bit-transparent below −1 dBFS and soft-limits above it to at most 0 dBFS, instead of letting the output hard-clip.
  - It never changes channel levels, and the meters still show the unprotected peak.
  - Diagnostics counts every time the master peak reaches it.
  - It can be switched off in Settings → Four decks (on by default).
- **Smooth, click-free changes:** every gain, EQ and filter change goes through `setTargetAtTime` (8 ms) and transport through the worklet's own fades, as before.
- **Independent cue routing:** every channel has its own PFL send. Any number can be on, and the cue never affects the master send or crossfader side.
- **Resources:** decks are built and rebuilt with the graph. Unloading a deck releases its buffer. Level reads are cached per frame, because many meters and badges in one frame would otherwise read every analyser several times.
- Real-audio verification of summing, routing and channel isolation is in §17.

---

## 5. Two-deck and four-deck modes

`src/workspace/WorkspaceStore.ts` holds the presentation preferences, persisted in `localStorage` under `dbdj.workspace.v1`:

```ts
interface WorkspacePrefs {
  deckMode: 2 | 4;
  density: [DeckDensity, DeckDensity];   // decks C, D: "full" | "compact" | "micro"
  laneCollapsed: [boolean, boolean, boolean, boolean];
  mixerOrder: "3-1-2-4" | "1-2-3-4";
  focusedDeck: number;
  version: 1;
}
```

- The **2 DECK | 4 DECK** segmented control sits in the workspace toolbar. The default shortcut is **Ctrl+Shift+D** (Cmd on macOS), rebindable in Settings.
- Switching only changes what is shown. The engine, mixer, grids, cues, loops and the audio graph are not touched (`tests/fourDeckWorkspace.test.ts`: 50 toggles with four decks playing send nothing to the audio engine). The soak test toggles 200 times while four decks play and checks that the playheads keep advancing in real time.
- **No silently hidden playing deck:** in 2 DECK mode a playing deck C/D shows as a dashed *micro* indicator under its side's deck. The indicator has PLAYING, title, BPM, play/pause, progress/seek, channel volume, headphone cue and ON AIR, plus **4 DECK ⤢**, which brings the workspace back.
- Leaving 4 DECK mode puts both controller sides back on A/B, and their absolute controls then wait for pickup.
- On restart the mode and layout are restored and nothing resumes playing. No playback auto-resume existed before, and none was added.

---

## 6. Adaptive deck layout

- Each side of the deck area is a column: the principal deck (A left, B right) above its controller-side partner (C left, D right).
- The mixer sits between the columns, and the waveform lanes are above, or in the centre for the Vertical view. A slim **four-deck bar** holds the controller sides, master clock and pickup guidance.
- Existing panel resizing and the library expand/splitter are unchanged.

| Density | Content |
|---|---|
| **Full** | The existing deck: track info and artwork, BPM/grid editor access, overview, STEMS strip, hot cues, loops, transport, jog display and tempo. In 4 DECK mode a one-line status row is added. |
| **Compact** | Badge, title/artist, BPM, time remaining, status chips, seekable mini-overview, phase meter, CUE/PLAY/SYNC, eight hot cues and headphone cue. About 64 px tall. |
| **Micro** | One row: badge, title, BPM, play/pause, progress/seek, ON AIR and expand. About 28 px. |

- C/D start at *compact*, and the **▴ / ▾** buttons change density without affecting playback.
- Decks A/B follow the existing deck view (Horizontal or Vertical = full, Classic = compact).
- Below 1500 px wide in 4 DECK mode, the full decks hide the jog display (BPM and pitch stay in the header and tempo fader) so all four decks and four mixer channels fit. The app's minimum window is 1024×640; screenshots are in §17.

---

## 7. Deck identity and status

The palette lives in `src/ui/deckTheme.ts`, which is still the single source for CSS variables and waveform palettes:

| Deck | Primary | Badge shape |
|---|---|---|
| A | Blue `#38A4FF` | square |
| B | Orange `#FF7956` | circle |
| C | Green `#48D69A` | hexagon |
| D | Purple `#B38AFF` | tab |

Decks A and B take the specified hex values, close to the previous blue and amber. Each deck derives a deep tone, a highlight and a three-band tonal waveform ramp from its primary.

- Deck colour marks the deck badge, waveforms and their lane labels, progress, mixer channel labels, the hardware focus outline, library load buttons, the context menu "Load to Deck" entries, the crossfader A/THRU/B selection and lit deck controls.
- The frequency/RGB/STEM waveform styles keep their meaningful colours.
- The letter and badge shape mean identity never relies on colour alone.

**Status chips** are text with colour as a second cue:

| Chip | Meaning |
|---|---|
| EMPTY / LOADING / READY / ▶ PLAYING / ❚❚ PAUSED / ERROR | Load and play state |
| LOOP | Loop active |
| SYNC / MASTER | Sync state |
| 🎧 CUE | Headphone cue on |
| ◀ CTRL L / CTRL R ▶ | Hardware focus; full decks show the larger "◀ LEFT CONTROLLER" tag |
| ⌨ FOCUS | Keyboard focus |
| ON AIR / ON AIR · TAIL / OFF AIR | Audibility |

Inactive decks are dimmed slightly in 4 DECK mode and return to full brightness on hover or hardware focus.

**ON AIR** (`src/core/engine/audibility.ts`) is derived from:

- routing: trim × fader × crossfader side × mute × master level, above −40 dB;
- playback state;
- the channel's post-fader signal, which catches FX tails after pause.

A deck playing with its fader closed, its crossfader side cut, or muted shows **OFF AIR**, not ON AIR.

---

## 8. Four-channel mixer

- Strips: in 4 DECK mode **C A | MASTER | B D** (default, following the controller sides) or **A B | MASTER | C D**. In 2 DECK mode the original **A | MASTER | B**.
- Each strip: TRIM, HI, MID, LOW, FILTER (with kills), CUE, fader, meter, and an **A | THRU | B** crossfader selector.
  - In 2 DECK mode the selector appears only when it differs from the default, so the original look is kept.
  - THRU bypasses the crossfader only: the channel fader and master still apply.
- The default assignment is A→A, B→B, C→A, D→B. Saved settings from older versions are padded with these defaults (`normaliseEngineSettings`).
- The crossfader curve options are unchanged.
- **Auto EQ** only ever drives the decks Auto DJ is mixing (A/B), so manual decks are never touched. When Auto DJ is running and deck C/D is assigned to side A/B, its strip shows **XF ⚠**: Auto DJ's crossfader moves will affect it, and THRU makes it independent.
- **Channel ordering:** two orders are selectable now (VIEW menu and Settings). Free drag-to-reorder is Phase 2 (§19), because the strip order is coupled to the controller-side layout and training highlights.

---

## 9. DDJ-SB hardware layers

**What the hardware offers.** The DDJ-SB is a two-channel controller with no dedicated deck 3/4 buttons.

- Mixxx's 4-deck DDJ-SB mapping uses `PioneerDDJSB.deckToggleButton` on note **0x60** (status 0x90 left / 0x91 right) to toggle deck 1↔3 and 2↔4. On the unit this is SHIFT + KEY LOCK, printed **TEMPO RANGE**.
- The same script lights LED 0x60 while deck 3/4 is selected.
- This mapping already had that message as tempo range, so no hardware capability is invented here.

**Mapping** (`src/controllers/profiles/pioneer-ddj-sb.ts`): the 0x60 binding gains `fourDeckAction: controller.layer.{left,right}.toggle`. Bindings with a `fourDeckAction` use it in 4 DECK mode when "layer button" is on (Settings), and keep their normal action in 2 DECK mode. In 2 DECK mode SHIFT + KEY LOCK is still TEMPO RANGE. A new output drives LED 0x60 from `controller.layer.{side}.alt`.

**Routing** (`src/controllers/layers.ts`): mappings keep describing hardware, and the router rewrites:

| Physical side | Routed to |
|---|---|
| `deck1.*`, `mixer.channel1.*`, `browser.load.deck1` | The left side's deck (A or C) |
| `deck2.*`, `mixer.channel2.*`, `browser.load.deck2` | The right side's deck (B or D) |

This covers jog, play, cue, sync, tempo, volume, EQ, filter/gain, headphone cue, loops, hot cues, beat loops, STEMS pads and LOAD. LED feedback keys are rewritten the same way, so every LED shows the selected deck and refreshes on a layer change.

Global controls never move with the layer: crossfader, headphone mix, browse, both FX units (FX1 left / FX2 right, with their deck assign) and the sampler. FX units are side units with their own deck assignment, so they are not deck-specific controls.

**Independence of layers and pad banks:** the DDJ-SB's hot cue banks (pads 1–4 vs 5–8, SHIFT = clear) are distinct MIDI notes chosen in hardware. Changing layer never changes bank, and a bank press never changes layer (tested).

**Held buttons:** a release goes to the deck its press went to. Changing layer while CUE, a hot cue or jog touch is held can't leave the old deck stuck previewing or scratching.

**Configurable control:** each side can be toggled or selected by:

- the DDJ-SB button;
- the on-screen selectors in the four-deck bar ("◀ LEFT CONTROLLER [DECK A][DECK C]");
- keyboard (Ctrl+Shift+1 / Ctrl+Shift+2, rebindable);
- any mapping, through `controller.layer.left.deck3` and similar actions.

**Feedback:**

- the four-deck bar shows each side's deck;
- the deck it drives gets an outline in its colour, a "◀ LEFT CONTROLLER" tag and a brief flash on change;
- the mixer strip shows ◀ / ▶ and an outline;
- LEDs refresh.

**Follow Hardware Layer** (on by default) also opens a deck that was collapsed to micro. **Controller follows deck focus** (off by default) is the only way focusing a deck on screen can move the hardware.

---

## 10. Soft takeover

The implementation is `src/controllers/softTakeover.ts`, wired in `ControllerManager.dispatchMapped`. It applies to every absolute control: volume, trim, EQ, filter, tempo slider, crossfader, headphone mix, FX knobs and stem volumes. It never applies to relative encoders (jog, browse) or buttons.

- **When a control waits for pickup:**
  - after a layer switch (both the deck it left and the deck it now drives);
  - after the software value changed from elsewhere (mouse, keyboard, Auto DJ, Transition Lab restore, mashup restore), detected by comparing with the value the control last set;
  - after a controller reconnect (all controls, and earlier physical positions are forgotten).
- On first connection the hardware drives values from where they are, as before, unless something changed them first.
- **Pickup:** the control takes over within the tolerance (default 3%, adjustable 1–10%) or when it moves across the software value (crossing detection).
- **Jitter:**
  - a crossing must come from consecutive messages less than half the travel apart;
  - jitter far from the target never engages;
  - once engaged, a control is not disengaged by its own values.
- **Guidance:**
  - waiting knobs show an amber ring, a ghost needle at the hardware position and ↻/↺;
  - faders show a ghost ▲/▼ at the hardware position;
  - the crossfader shows a ghost ◀/▶;
  - the four-deck bar lists waiting controls as "C VOLUME ▼ 20%" (deck, control, direction, target).
- **Modes:** Pickup (default), **Relative scaling** (waiting moves change the value proportionally to the travel left in that direction, so hardware and software meet at the end stop) and Off.

---

## 11. Master tempo and synchronisation

The existing sync model is kept: it is deck-referenced, uses each deck's own beat grid, keeps tempo matching and phase lock separate, and makes phase corrections of at most 3% speed. It is extended as follows:

- **Any eligible deck can be master:** MASTER on full decks, the master clock's deck buttons, or `deckN.master`.
- **Master clock** (four-deck bar): master deck, BPM, beat-in-bar dots (downbeat highlighted), playing/stopped and the number of synced decks.
- **Automatic handover policy:**
  1. An explicit MASTER press always wins.
  2. SYNC with no eligible master makes the pressing deck master, as before.
  3. While the master isn't playing (paused, ended, ejected or being reloaded) and another synced deck is, that deck becomes master. An audible one is preferred, then the lowest deck. Its tempo is already matched, so nothing jumps.
  4. With no synced deck playing, the master stays where it is.
  5. Loading onto a non-master deck never changes the master.
  6. Loading onto the master deck hands the master on first (rule 3, or no master), so the new track's BPM can't retempo the synced decks.
- **Half/double time:** a follower at ½× or 2× the master's tempo now phase-locks too. Double time puts two beats per master beat. Half time lands on every other master beat, and either parity counts as aligned.
- **Grids:** phase is always computed from each deck's own grid, so a hand-corrected grid is what counts. The beat grid editor is unchanged and works on every deck.
- **Seek and loops:** after a seek the follower is pulled back gradually and never jumped (unchanged). Loops are beat-aligned, so a looping follower stays on the grid.
- An **internal master clock** (a virtual tempo source with no deck) is **not** in Phase 1. It needs a shared audio-time phase reference that the backend-neutral `AudioEngine` contract doesn't expose yet. It is planned with Ableton Link / MIDI clock in Phase 5 (§23).

---

## 12. Stacked waveforms

- 4 DECK mode stacks lanes A, B, C, D (or four columns in the Vertical view).
- Each lane has its deck's letter badge, deck-coloured edge and a **MASTER / SYNC / FREE** tag.
- Lanes keep beat and bar markers, downbeats, phrase markers in the grid editor, hot cues, loops, the playhead, the Auto DJ regions, all waveform styles (including the STEM view) and drag-to-scratch.
- Every lane uses the same listening-time scale at its deck's real tempo, so synced decks line up and unsynced decks visibly don't. Nothing implies alignment that isn't there.
- Clicking a lane's letter collapses it, and empty C/D lanes stay slim until a track is loaded.
- Rendering is unchanged: each lane blits cached tiles on its own canvas every animation frame, and React never re-renders per frame. Draw time is reported in Diagnostics, with soak figures in §17.

---

## 13. Headphone cue

- Each channel has an independent PFL: the CUE button on the strip, 🎧 on compact and micro decks, and the DDJ-SB HP CUE, which follows the layer.
- Several channels can cue at once. They sum on the cue bus with the existing HP MIX and HP LEVEL.
- Cueing never changes the master send, the crossfader side or another deck.
- Headphone cueing needs an output with 4 channels and **4-channel routing**. On a stereo output the CUE buttons say so in their tooltip, and the app logs the existing guidance the first time CUE is pressed.

---

## 14. Library

- Load to Deck A–D are in the library and playlist rows, the right-click menu, Audius and Spotify → Local rows. The four-deck destinations appear in 4 DECK mode.
- **Load to focused deck:** right-click menu or **Shift+L**. Focus a deck by clicking it or with Alt+1…4.
- Drag and drop works onto any deck at any density.
- Tracks loaded on any deck are marked ●X in that deck's colour. In 2 DECK mode a hidden deck C/D still shows its ●C if it holds the track.
- The same track can be loaded onto several decks independently, with no duplicate library records.
- The existing protection against loading onto a playing deck is unchanged and applies to every deck.

---

## 15. Performance and stability

- **Decoding and analysis:** decoding is asynchronous through the existing `decodeAudioData`. Analysis runs in the existing worker. Analysis is shared and cached per track, and the same track on two decks is analysed once.
- **Live playback first:** while 3+ decks play (Settings: always / 2+ / 3+ / 4), these wait:
  - the automatic background analysis queue;
  - bulk "reanalyse library" jobs;
  - STEMS library pre-analysis.

  Analysis of a track loaded onto a deck, and an explicit "Analyse selected", are never deferred.
- **STEMS workload:** the worker separates one job at a time, with deck jobs ahead of library jobs and the playhead first (existing). Four decks with STEMS on queue up and don't run in parallel.
  - In Automatic mode, a track loaded onto a deck where STEMS is **not** switched on is no longer separated while 3+ decks play.
  - A separation already running for such a deck **pauses** when the third deck starts. Its finished regions stay in the cache, and it resumes from there when fewer decks play or STEMS is switched on for that deck.
  - Decks with STEMS switched on are never held back.
  - This came out of the soak test (§17.1): continuous automatic separation alongside four playing decks was the main source of underruns on the test laptop.
- **Real-time thread:** the AudioWorklet code is unchanged, with no allocations, file I/O or UI work in the render callbacks. Level reads are cached per frame.
- **Diagnostics** (Diagnostics → Four-deck performance):
  - decks playing, and ON AIR and peak per deck;
  - AudioContext render load and underruns where the runtime exposes them (`renderCapacity`, `playbackStats`);
  - an audio-clock stall estimate in every runtime (windows where rendering fell 30 ms+ behind the wall clock);
  - clip guard activity;
  - track load latency (last, average, max);
  - waveform draw time, JS heap, the background analysis queue and deferral, and the STEMS queue.
- Nothing silently reduces audio quality: no automatic resampling, quality switching or disabling of features under load.

---

## 16. Backwards compatibility, ownership and migration

- **Two-deck workflows:** layout, mixer, waveforms and library buttons are unchanged in 2 DECK mode. Mappings and the DDJ-SB behave as before in 2 DECK mode, including SHIFT + KEY LOCK = tempo range. Keyboard shortcuts are unchanged, with additions only.
- **Auto DJ** still uses A/B only:
  - It checks only A/B to start or resume, which fixes the deck −1 bug.
  - A/B are reserved for automation and C/D for manual use; the engine refuses an `auto-dj` load onto a manual deck.
  - It never loads, plays, syncs or EQs C/D.
  - Its crossfader moves affect C/D only through their crossfader side, flagged with XF ⚠.
- **Transition Lab, Live Mashup, Training and Practice:** unchanged two-deck features. Transition Lab already asks before stopping any playing deck, C/D included, and restores only A/B.
- **AI Set Studio, Auto Cue, Blend Groups and Production Studio:** unchanged.
- **Hot cues** (Suggested/Embedded), manual beat grids and preparation data are track-level and unchanged. Each deck's Suggested/Embedded choice already supported four decks.
- **Persistence and migration:** there is **no database migration**. New preferences are additive `localStorage` keys with defaults and validation:
  - `dbdj.workspace.v1`
  - `dbdj.controllerLayers.v1`
  - `dbdj.performance.v1`
  - `dbdj.keymap.overrides.v1`

  Saved engine settings from two-deck versions are normalised on load. `crossfaderAssign` and `cueSource` are padded to four decks, and a legacy string `cueSource` applies to all decks. No library or preparation schema changed, and development testing never used the real library: tests use fakes, and the Electron soak uses generated audio in a throwaway profile.

---

## 17. Phase 1 verification

### Automated tests (vitest)

| File | Covers |
|---|---|
| `tests/fourDeckEngine.test.ts` | Four decks play simultaneously and independently. Load/eject touches nothing else. Same track on two decks. Per-deck key lock, tempo, loops and hot cues. Per-channel DSP isolation. Default A/C–B/D assignment. A/THRU/B routing. Assignment persistence event. No auto-normalisation. Independent PFL. ON AIR vs routing. Takeover read-back. Settings migration. Four decks following one master. Manual reassignment with no seeks. Handover on stop and on reloading the master. Unsynced loads never change the master. Half- and double-time phase lock. Manual grids respected. Gradual correction after seeking, and loops. Deck reservation. Load stats. |
| `tests/deckLayers.test.ts` | SHIFT + KEY LOCK toggles left A↔C and right B↔D; 2 DECK mode keeps tempo range. Transport, jog and hot cues reach the selected deck. Pad banks are independent of layers. Releases follow presses. LEDs follow the layer, and the layer LED lights. MIDI monitor routing. Leaving 4 DECK mode. Globals stay global. Soft takeover across layers for volume, EQ and tempo, with jog never held. Returning to a deck requires pickup. |
| `tests/softTakeover.test.ts` | Priming. The spec's 80%/20% example. Tolerance. Crossing. Glitch jumps. Jitter. Automation changes. Reconnect reset. Relative scaling. Off mode. Unreadable controls. |
| `tests/fourDeckWorkspace.test.ts` | Defaults. Persistence across restart. Tolerant migration. Focus fallback. Mixer layout. Density limits. 50 mode switches with four decks playing produce zero audio calls and no state change. Clip guard linear below −1 dBFS and ≤ 0 dBFS above. Auto DJ with a manually playing deck C (start and resume). Shortcut defaults, uniqueness and rebinding. |
| `tests/analysisDeferral.test.ts`, `tests/stemPlaybackDeferral.test.ts` | Background analysis waits while decks play and resumes. Explicit analysis is never held back. Automatic STEMS separation waits, pauses mid-run when the third deck starts, and resumes; decks with STEMS on are never held. |
| `tests/deckTheme.test.ts` (updated) | Four palettes, CSS variables for A–D, waveform palettes and tonal colours per deck. |

### Real-audio Electron test

`scripts/four-deck-soak.mjs` runs against the built app with generated audio in a throwaway profile. It covers summing, routing, isolation, sync, mode-switch stress, screenshots, STEMS, background deferral and a timed soak, and `--baseline --decks 2` gives a comparison run that also works against older builds. Measured results are in §17.1.

### 17.1 Measured results

Measured on 2026-11-22 with `scripts/four-deck-soak.mjs`.

### Test environment

- **Machine:** Intel Core Ultra 7 165U (15 W laptop CPU, 14 logical cores), 31 GB RAM, Windows 11 (10.0.26200).
- **Runtime:** Electron 44.4.5 / Chromium 152.
- **Audio output:** the default stereo output at 48 kHz, latency "interactive" (base 10 ms, output 40 ms), master at −40 dB.
- **Test material:** generated 6-minute 44.1 kHz stereo WAV beat tracks (63 MB each) at 122–128 BPM, and 40-second sine tracks for the summing measurement.
- **No DJ controller attached.**
- **Underrun source:** Chromium's `AudioContext.playbackStats`, available in this runtime; `renderCapacity` is not. The figures below use `playbackStats`.
- **Other load:** your own copy of the app was running in the background throughout, which adds noise.

### Real-audio functional checks (four-deck build, all passed)

| Check | Result |
|---|---|
| Four tracks loaded at once | All four 63 MB tracks ready in 2.5–4.6 s (four runs) |
| Master-bus summing of 1–4 uncorrelated sine decks | RMS ratio 1 : 1.417 : 1.706 : 1.993 (ideal 1 : √2 : √3 : 2). Single-deck RMS 0.001771 vs predicted 0.001768. |
| Crossfader hard A | 1.406 × one deck (ideal √2: decks A + C) |
| Deck D on THRU at hard A | 1.729 (ideal √3) |
| Channel isolation | −6 dB trim on deck C: C peak 0.250 → 0.125; A, B and D unchanged (0.250 → 0.250) |
| Four-deck sync | Grids 124/126/122/128 BPM synced to deck A: all 124.00 BPM, phase error −0.0010 / +0.0006 / −0.0019 beat |
| 200 mode switches while four decks played | All kept playing; playheads advanced at 1.002× real time; mixer, hot cues and grids unchanged |
| Background library analysis with 4 decks playing | Deferred ("4 decks playing") and resumed afterwards |
| STEMS on four playing decks | All four kept playing. Automatic separation for decks without STEMS on waited ("STEMS analysis waits while 4 decks playing") and paused when the third deck started. Switching STEMS on for deck C resumed it within about 10 s. Pausing two decks resumed the others. |

### Audio health (underruns)

| Run | Length | Underrun events | Underrun time |
|---|---|---|---|
| Original code (v0.1.39), 2 decks, playback only | 5 min | 6 | 60 ms |
| A/B pair 1: original, 2 decks | 3 min | 3 | 30 ms |
| A/B pair 1: four-deck build, 2 DECK mode | 3 min | 0 | 0 ms |
| A/B pair 2: original, 2 decks | 3 min | 0 | 0 ms |
| A/B pair 2: four-deck build, 2 DECK mode | 3 min | 5 | 50 ms |
| Four-deck build, **4 decks playing**, playback + reload every minute | 5 min | 4 | 40 ms |
| Four-deck build, 4 decks, **STEMS on for all four** (CPU, separating continuously), 63 MB reload every minute, mode switch pair every 30 s | 10 min | 60 | 584 ms |
| Four-deck build, 4 decks, STEMS in default Automatic mode, same reloads and switches | 6 min | 56 | 566 ms |

- **Two decks:** no measurable regression. The four-deck build in 2 DECK mode and the original are within run-to-run noise. A single earlier 5-minute run of the new build showed 99 events while the background app was busy, but alternating runs under the same conditions did not reproduce it.
- **Four decks of playback:** about the same as two.
- **STEMS separation:** heavy, CPU-bound and slower than real time on this CPU (0.5–1 s of compute per second of audio). Alongside four decks it adds a few underruns per minute, and most of them fall in windows where a 63 MB track is also being decoded. That is why automatic separation for decks without STEMS on now waits or pauses while 3+ decks play.

### Excluded runs: GPU hang in fresh test profiles

The first 30-minute soak (1,369 events) and two automatic-STEMS runs (1,132 and 14,611 events) were excluded as measurements.

- In each, the throwaway profile let the STEMS worker try DirectML first, and the integrated GPU hung (`DXGI 0x887A0006`, "The GPU will not respond to more commands") before separation fell back to the CPU.
- The underrun storms followed the hang, and in one run continued after separation had stopped. That points to a system-level GPU reset, not audio work.
- Your real profile already records `gpuFailed: true` and runs STEMS on the CPU, so this does not happen in normal use.
- This is existing STEMS behaviour on this machine, not four-deck code. The driver's `--stems-gpu-failed` option reproduces the real configuration.
- Every functional check in those runs still passed, including 30 minutes and 28 reloads without a deck stopping.

### Resources over the 30-minute soak

| Measure | Result |
|---|---|
| Renderer JS heap | 595 → 561 MB over 28 reloads (no growth) |
| All app processes | 7.9–8.6 GB, flat over the run; dominated by the ONNX STEMS worker and four decoded 6-minute WAVs, which the deck worklets hold as their own copies |
| Track loads (request → ready, 63 MB WAV) | Typically 1.4–4 s; up to 20 s while STEMS separation saturated the CPU (Chromium decodes the WAV and the preparation store hashes it). Reported in Diagnostics. |
| Waveform drawing | 0.2–2.6 ms per lane frame |
| Audio-clock stall estimate | Matched `playbackStats` in direction; it is an estimate |

### Not verified

- **DDJ-SB:** no hardware attached. See §18 and HARDWARE-TEST-PLAN §G.
- **Other machines:** results are for this one laptop.
- **macOS:** not tested.
- **Long sessions with real compressed music:** MP3/AAC decode far smaller files, so load times and memory will be lower than with these WAVs, but that is not measured.

---

## 18. Known limitations and outstanding hardware verification

- **DDJ-SB hardware not tested.** The SHIFT + KEY LOCK layer toggle and LED 0x60 come from the existing mapping and Mixxx's 4-deck DDJ-SB script, and were verified by simulating the exact MIDI bytes through the real mapping and controller code. They still need a pass on the unit, added to `docs/HARDWARE-TEST-PLAN.md` §G:
  - LED behaviour;
  - SHIFT-held edge cases;
  - soft-takeover feel on the physical faders and knobs;
  - the TEMPO RANGE label behaviour.
- **Underrun counts depend on the runtime.** Web Audio exposes underruns only through Chromium's `playbackStats` / `renderCapacity` where enabled; the clock-stall figure is an estimate.
- **No internal master clock** (see §11). The master is always a deck.
- **Mixer ordering** offers two presets; free reordering is Phase 2.
- **Headphone cue** needs a 4-output device with 4-channel routing. This limitation is the same as before.
- **Decks C/D have no default keyboard transport shortcuts.** Use the UI, the controller layers, or add bindings.
- **The same track on two decks decodes twice:** independent worklet buffers, shared analysis. Shared decoded PCM needs SharedArrayBuffer (cross-origin isolation) and is deferred to Phase 5.

---

## 19. Phase 2 — Advanced performance workspace (design)

**Scope**

- Waveform arrangements: four stacked; split (A/C left, B/D right); focused two-deck (any pair); compact overviews only; expanded performance (taller lanes, overview strip per deck).
- Hide deck overviews and inactive lanes individually.
- A **Performance View** that hides the library and analysis panels, expands waveforms and mixer, prioritises live decks and gives quick access to secondary decks. It has save/restore for named custom layouts and a one-click "restore previous view".
- Free mixer channel ordering by drag.
- Advanced headphone monitoring, subject to the device:
  - Split Cue (master left, cue right);
  - mono cue summing;
  - master/cue blend (existing);
  - per-deck cue mix levels;
  - cue-only deck monitoring;
  - separate output devices for master and headphones.

**Design**

- `WorkspacePrefs` becomes `WorkspaceLayout`: arrangement enum, per-lane visibility and height weights, overview visibility, library/analysis visibility, mixer order as a permutation, and a named-layouts map. `migrateWorkspace` v1→v2 maps the existing fields.
- The waveform stack reads a lane list `{deck, height, visible}` instead of the deck list, and the split arrangement becomes two stacks side by side.
- Split Cue adds a `ChannelSplitter` + `ChannelMerger` stage in the headphone path. `MasterDsp` gains `cueMode: "stereo" | "split" | "mono"` and per-channel `cueLevel`.
- A separate headphone device needs a second AudioContext (or `setSinkId` per `MediaStreamAudioDestinationNode`) with clock-drift compensation.

**Dependencies:** none on Phases 3–5. The second-device path depends on Electron's Web Audio sink support, which must be verified per OS.

**Migration:** `dbdj.workspace.v1` → v2, adding fields only.

**Risks:**

- a second audio device brings clock drift and latency mismatch;
- Split Cue on a 2-channel device halves the master monitoring;
- layout complexity.

**Acceptance criteria:**

- every arrangement renders all its lanes with correct markers;
- switching arrangement or view never touches playback;
- custom layouts survive a restart;
- Split Cue puts master in one ear and cue in the other, verified with a 4-channel device and on a stereo device with an explicit warning;
- no frame-time regression.

---

## 20. Phase 3 — Creative performance decks (design)

**Scope.** Decks C/D get a **deck mode**:

| Mode | What it does |
|---|---|
| Track | Today's behaviour |
| Stem | Per-stem faders, mutes and solos up front, per-stem FX send, and STEM waveform by default; reuses `StemService` |
| Loop | Quantised launch of loop slots; lengths ¼–64 beats; follows master sync |
| Remix | A 16-pad grid with one-shots and loop slots, quantised triggering, banks, per-slot volume and pitch, replace sample, and kits saved and loaded |
| Acapella | Vocal isolation via STEMS, key shift, beat and phrase alignment, and vocal EQ/FX presets |

**Production Studio integration:** load Sampler pads, Live Looper loops, Vocal Studio takes, Arrangement clips and Drum Transcriber MIDI renders straight into a creative deck. Assets and metadata are reused by reference, with no export/import step.

**Design**

- `DeckState.mode`, plus a per-mode state slice (`remix: { banks, slots }`, `loop: { slots, active }`).
- Loop and Remix playback reuses the deck worklet for one sample stream. Additional one-shot voices go through a small voice pool in the same worklet, with sample-accurate quantised start times from the master grid.
- Kits persist as `setstudio_docs` kind `"kit"`, reusing `DocStore` versioning.
- A mode change is refused (with a message) while the deck is ON AIR, so an audible deck is never interrupted.

**Dependencies:** Phase 1 decks and sync. The STEMS model is needed for Stem/Acapella.

**Migration:** additive state; the default mode is Track.

**Risks:**

- worklet CPU with many voices (needs a voice cap and diagnostics);
- STEMS latency for Acapella (separation must finish before the vocal is usable);
- licensing for exported samples.

**Acceptance criteria:**

- each mode plays in sync with the master;
- a quantised trigger lands within one render quantum of the grid;
- a mode change never interrupts an ON AIR deck;
- kits round-trip;
- a Production Studio asset loads into a deck in one action.

---

## 21. Phase 4 — AI-assisted four-deck performance (design)

**Scope**

- Auto DJ modes, all opt-in: classic two-deck (default), four-deck transitions, background loop layering, acapella mixing, stem-assisted, creative mashup.
- **AI Set Studio** plans multi-deck arrangements. It considers BPM, key, phrase alignment, grid reliability, energy, vocal clashes (STEMS vocal regions), bass conflicts, arrangement, available decks and user-reserved decks.
- **Transition Lab** grows to up to four lanes:
  - start and exit positions;
  - beat alignment;
  - volume, crossfader, EQ, filter, FX, stem and loop automation;
  - preview, edit, save and rehearsal.
- Blend Steering Groups are extended, not replaced.
- **Intelligent Auto EQ** across all audible channels: bass-conflict cuts, acapella space, lead-vocal overlap prevention, percussion density, and headroom. It is optional and respects manual takeover.

**Design**

- `PreparedTransition` becomes v2 with `lanes: TransitionLane[]` (deck role + automation curves). v1 transitions migrate to two lanes. `frameAt()` returns per-lane frames, which Auto DJ and the Lab both use.
- The deck reservation in Phase 1 becomes the ownership API: automation claims decks per transition and releases them after, and never claims a manual deck.
- Auto EQ generalises from (out, in) pairs to an N-channel optimiser over band energy, with per-band manual takeover per deck (the existing takeover model).

**Dependencies:** Phases 1 and 3 (loop/stem decks). STEMS for vocal and bass data.

**Migration:** `setstudio_docs` transition v1 → v2, done on read with the original kept.

**Risks:**

- automation fighting the DJ (mitigated by ownership and takeover);
- planner complexity;
- CPU for STEMS on four decks (the queue is serial, so it must be planned ahead).

**Acceptance criteria:**

- classic mode is unchanged (existing tests);
- every creative behaviour is off until enabled;
- a four-lane transition plays identically in preview and Auto DJ;
- a manual deck is never touched;
- Auto EQ never boosts and yields per band on manual input.

---

## 22. Phase 5 — Hardware and external integration (design)

**Scope**

- Native four-channel controllers, external MIDI mixers and several MIDI controllers at once.
- Controller profiles with per-device layers and **MIDI learn**.
- External audio interfaces and per-deck external outputs (**external mixer mode**: each deck on its own output pair, with no internal summing).
- **Ableton Link / MIDI clock**, which brings the internal master clock.
- **Performance recording:** master recording; per-deck stems; capture of audio and the automation/command-bus event log; replay; multi-track session export; Production Studio arrangement export, all sample-aligned.
- **Learn & Practice:** a Four-Deck Performance module with eight lessons:
  1. Introduction
  2. Controller layers
  3. Soft takeover
  4. Three-track blending
  5. Acapella layering
  6. Percussion loops
  7. Four-deck mashups
  8. Advanced EQ

  Practice Mode gains assessment of beatmatching, phrase alignment, multi-deck EQ balance, clipping/headroom, vocal overlap, transition quality and deck management, using the existing training and scoring architecture.

**Design**

- The controller layer is already device-agnostic: mappings describe hardware, and layers and takeover live in `ControllerManager`. Multiple controllers need per-device `DeckLayers` instances, with the router keyed by port.
- MIDI learn writes `InputBinding`s with `confidence: "manual"`.
- External mixer mode is a `routing: "per-deck"` `AudioConfig`. The master bus is bypassed and each channel's `post` goes to its own merger inputs. This needs a device with 8+ output channels, or a native backend.
- The internal clock is a `MasterClock` source (deck | internal | link | midi) with a phase reference in AudioContext time, exposed through the `AudioEngine` contract.
- Recording taps the master and channel `post` nodes with an AudioWorklet writer to disk via IPC, plus the command-bus event log with audio-time stamps.

**Dependencies:** native backend work (TECHNICAL-FINDINGS.md) for multi-device and low-latency external routing.

**Migration:** mapping schema v1 stays readable; profiles gain optional `layers` metadata.

**Risks:** device and driver variability, clock domains across devices, and disk I/O during performance.

**Acceptance criteria:**

- two controllers drive four decks independently;
- MIDI learn round-trips;
- external mixer mode outputs each deck on its own pair, measured;
- Link tempo stays in sync with another Link peer;
- recordings are sample-aligned with the event log;
- the lessons run in Practice with scores.

---

## 23. Learn and Practice integration (planned)

Covered under Phase 5 above, including the lesson list and the Practice assessment additions. It reuses `src/training` (curriculum, coach, scoring) and `src/practice`.

---

## 24. Risks

| Risk | Mitigation (Phase 1) |
|---|---|
| Four summed channels clip | Clip guard (linear below −1 dBFS), unprotected meters, no auto-normalisation |
| Hardware jumps when layers change | Soft takeover on every absolute control; release-follows-press for buttons |
| Automation overrides a manual deck | Deck reservation; Auto DJ limited to A/B; XF ⚠ indicator |
| CPU/memory with four decks + STEMS + analysis | Serial STEMS worker, background deferral, per-frame level cache, diagnostics, soak test |
| UI clutter at small windows | Densities, slim lanes, jog hidden below 1500 px in 4 DECK mode, screenshots at 1024×640 |
| Unverified DDJ-SB behaviour | Behaviour taken from the existing mapping and Mixxx's script; simulated end to end; hardware checklist §18 |

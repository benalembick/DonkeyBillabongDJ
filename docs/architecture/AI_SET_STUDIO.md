# AI Set Studio — Architecture & Roadmap

Status: **Phase 1 and Phase 2 implemented** (2026-11-21). Phases 3–5 are design only — nothing in them is built.

AI Set Studio is a primary module of Donkey Billabong DJ for library intelligence, energy-driven set
planning, explainable track recommendations and set improvement. It is a native extension of the
existing app: it reads the same library, the same content-addressed preparation records and cached
analysis, writes into the same playlists, and plays through the same decks, headphone preview and Auto DJ.

**Principle: analyse once, reuse everywhere.** The worker analysis (BPM, beatgrid, key, sections,
3-band envelopes) runs once per audio content hash. Set intelligence is *derived* from that cache — it
never decodes audio a second time — and is stored on the same preparation record.

---

## 1. Repository assessment (Step A)

| Area | Existing implementation | Reused by AI Set Studio |
|---|---|---|
| Stack | Electron 44 + React 19 + TypeScript, Vite, Web Audio / AudioWorklet, vitest (node env) | Same |
| State | Plain TS services extending `Emitter`, React reads via `useFrameStore`/`useSyncExternalStore`-style hooks | Same pattern (`SetStudioService`, `LibraryIntelligence`) |
| Persistence | SQLite (`node:sqlite`, `electron/library/db.ts`) behind a narrow IPC surface; JSON-document tables (`track_preparation`, `mashup_recipes`, `import_jobs`); browser fallbacks in IndexedDB/localStorage | New `dj_sets` JSON-document table + localStorage fallback; set intelligence stored **inside** `track_preparation` records |
| Track identity | `TrackPreparation.trackId = sha256(file bytes)`; `refs[]` = every path the content has been seen at | `SetTrackRef` stores `trackId` + last `ref` + title/artist snapshot; resolves moved files by content hash |
| Analysis | `AnalysisService` (worker queue, cache hits, cancel, crash guard, long-file guard) → `analyzeTrack` (BPM/phase comb, Krumhansl key, structure sections, hot-cue suggestions, 3-band 150 fps envelopes) | Phase A of *Analyse Library* calls `AnalysisService.analyseTracks` — no second analysis engine |
| Energy | `analyseStructure` — 1–10 from per-track-normalised RMS (mostly "how sustained is the loudness") | Kept as the legacy value; a new multi-feature energy (§4.2) is stored beside it |
| Harmonic | `camelotKey()` in `src/analysis/discovery.ts` | Reused for every key comparison |
| Compatibility | `discovery.compatibility()` (single score for DJMix / mashups) | Left untouched; Set Studio has its own explainable, weight-configurable scorer because it needs neighbour-pair context, energy targets and steering |
| Vocals | `transitions/vocals.ts` — vocal regions from separated STEMS only | Vocal presence = vocal-region fraction from STEMS when complete; otherwise **unsupported**, never guessed |
| Playlists | `PlaylistStore` (ordered refs, SQLite) | *Load into playlist*, *Improve a Set* source (read-only) |
| Auto DJ | `AutoDJ.start(playlistId)`, `playNextRefs`, `add` | *Open in Auto DJ*, *Queue next* |
| Playback | `DJEngine.loadTrack(deck, track)` (refuses playing decks), `HeadphonePreview.toggle` (headphones only, 4-ch routing) | *Send to Deck A/B*, *Preview*; no player inside the module |
| UI | React, single dark `styles.css` token set (`--bg`, `--panel*`, `--line`, `--accent`…), nav tiles, lower-pane workspaces (Lighting, Training) | Lower-pane workspace that auto-expands; `setstudio.css` uses only the existing tokens plus the energy gradient |
| About | `src/about/features.ts` catalogue (architecture rule: update with every feature change) | Updated |

**Build new:** feature derivation, curve engine, scorer, optimiser, set document store, editor
history, export, Library Intelligence job, UI.

---

## 2. Module layout

```
src/setstudio/
  types.ts               entities (DJSet, DJSetSlot, DJSetTransition, DJSetGroup, RecommendationProfile, SetIntel…)
  features.ts            deterministic, versioned set-feature extractor + pluggable extractor registry
  curves.ts              templates, monotone-cubic interpolation, anchor curves, slot targets, track-count estimate
  scoring.ts             harmonic/BPM/energy/genre-mood/structure scoring, Next Move steering, transitions
  autofill.ts            beam-search optimiser (Auto Fill, resequencing)
  editor.ts              pure set edit operations + undo/redo history
  SetStore.ts            persistence, CRUD, migration
  exporters.ts           M3U8 + native .dbdjset.json
  LibraryIntelligence.ts Analyse Library job (reuses AnalysisService), incremental derivation, overrides
  SetStudioService.ts    façade: profiles, resolution, recommendations, playlist/deck/Auto DJ integration
  autocue.ts, AutoCueService.ts            Phase 2 Auto Cue (detection, staging, accept/reject)
  transitionModel.ts, TransitionLabService.ts, echoFx.ts   Phase 2 Transition Lab + the shared frame executor
  BlendGroups.ts, DocStore.ts              Phase 2 reusable groups, journeys; document store
src/ui/setstudio/        SetStudioWorkspace + Home, Wizard, Builder, ArcMap, TrackDock, Intelligence, Improve panels
electron/library/db.ts   dj_sets table (additive migration)
```

Dependency direction: `setstudio/*` pure modules depend only on `core` types and `analysis/discovery`
(`camelotKey`). `SetStudioService` depends on Library/Preparation/Playlist/AutoDJ/DJEngine/HeadphonePreview
through their public APIs. UI depends on the service through `App`.

---

## 3. Data model

Adapted to the existing schema rather than adding parallel track tables.

### 3.1 TrackAnalysis (set intelligence) — extends `TrackPreparation`

Stored as two optional fields on the existing `track_preparation` JSON row (schema stays 1; older
builds ignore unknown fields; `saveAnalysis` spreads the record so they survive re-analysis):

```ts
TrackPreparation.intel?: SetIntel          // derived, versioned
TrackPreparation.setOverrides?: TrackOverrides   // user-entered; never overwritten by analysis
```

| Spec field | Source |
|---|---|
| trackId | `TrackPreparation.trackId` (content hash) |
| analysisVersion | `intel.version` (+ `intel.algorithm`, `intel.derivedFrom` = the worker analysis' `analysedAt`) |
| bpm / beatgrid | existing `beatGrid` / `bpm` (manual grid edits respected) |
| musicalKey / camelotKey | existing `key` → `camelotKey()` |
| energy | `intel.energy` (1–10, multi-feature); original legacy `energy` kept; `setOverrides.energy` wins when set |
| genre / subgenre | file tags (split on `/ ; ,` for a sub-genre); `setOverrides` wins; no classifier shipped → marked unsupported |
| moodTags | `intel.moods` — rule-based from measured features (labelled "estimated", `moodSource: "rules-v1"`); `setOverrides.moods` wins |
| danceability, brightness, bassIntensity, percussive, onsetDensity, loudnessDb | `intel.*` from the cached band envelopes |
| vocalPresence | `intel.vocalPresence` from STEMS vocal regions when separation is complete; `null` + reason otherwise |
| structuralMarkers | `intel.introSec/outroSec/dropSec/breakdownSec` from existing `sections` |
| confidence | `intel.confidence` (+ per-field `unsupported` reasons) |
| analysedAt | `intel.computedAt` |
| userOverrides | `setOverrides` |

### 3.2 Set documents — `dj_sets` table

One versioned JSON document per set (same pattern as `mashup_recipes`, `import_jobs`): atomic writes,
no cross-table orphans. Logical entities live inside it:

```ts
DJSet { schemaVersion: 1, id, name, mode: "curve"|"anchors"|"groups"|"improve",
        createdAt, updatedAt, version, parentId,
        durationTargetSec, energyMin, energyMax, overlapSec,
        curveTemplate, curveControlPoints[], slots: DJSetSlot[], transitions: DJSetTransition[],
        groups: DJSetGroup[], profile: RecommendationProfile, origin?: ImproveOrigin }
DJSetSlot { id, position, track: SetTrackRef|null, targetEnergy, actualEnergy, isAnchor, isLocked, flexible, notes }
DJSetTransition { id, fromSlotId, toSlotId, compatibilityScore, state, warnings[], transitionConfiguration|null }
DJSetGroup { id, name, energyMin, energyMax, moodPreferences[], genrePreferences[], tracks: SetTrackRef[] }
RecommendationProfile { weights, hardConstraints, energyDirection (Next Move), moodPreferences, filters, allowDuplicates }
SetTrackRef { trackId|null, ref, title, artist, durationSec }
```

- **Referential integrity:** slot ids are unique per set; transitions are recomputed from slots on every
  save (never trusted from disk); `DJSetGroup.tracks` and slots reference tracks by `SetTrackRef`, resolved at
  load: `ref` in library → ok; else any path of the same `trackId` in the library → *moved* (healed
  silently); else *missing* (kept, shown with a title/artist relink suggestion). Nothing is deleted.
- **Versioning:** `schemaVersion` checked by `migrateSet()`; unknown future versions are kept read-only in
  storage and reported rather than overwritten. `version`/`parentId` track "Save as new version" lineage.
- **Migration:** `CREATE TABLE IF NOT EXISTS dj_sets (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`
  is additive; preloads from older builds fall back to localStorage (`dbdj.djsets.v1`).

---

## 4. Phase 1 — Working MVP (implemented)

### 4.1 Navigation
Top-bar **AI Set Studio** button (lower-pane workspace that auto-expands; *Show decks* restores the
decks). Landing page: **Create a Set**, **Improve a Set**, **Your Sets** (search, sort by modified / name /
tracks / duration; Open, Duplicate, Rename, Delete, Export; status chip), **Library Intelligence**.

### 4.2 Library analysis
*Analyse Library* runs a two-phase background job:

- **A — audio analysis** for tracks with no cached analysis: `AnalysisService.analyseTracks` (existing worker,
  cancel, crash guard, long-file guard). Cached tracks are skipped.
- **B — set intelligence** for analysed tracks whose `intel` is missing or stale (`version` or
  `derivedFrom` changed): loads the cached waveform record and runs `computeSetFeatures` (pure, ~ms).
  Yields to the event loop between tracks so playback and UI stay responsive.

Per-track status (queued / analysing / deriving / done / up to date / skipped / failed), cancel, resume
after restart (pending refs persisted), retry failed (forces re-analysis). Newly analysed tracks are
derived incrementally (preparation `record` events; idempotent check prevents loops). Cues, beatgrids
and tags are never written by this job.

**Energy (deterministic baseline, `dbdj-set-features` v2)** — weighted, configurable (`ENERGY_MODEL`):
loudness 0.14, onset density 0.12, percussive flux 0.16, rhythm-gated fullness 0.26 (busy share + gap
floor), movement-gated bass 0.10, brightness 0.10, tempo 0.12; each normalised over fixed absolute ranges,
a fixed 1.6× contrast stretch, mapped to 1–10. Loudness is one of seven terms and fullness only counts with
a beat, so a loud sustained pad scores below a busy percussive track (unit-tested). Unknown tempo → its
weight is redistributed. A cached analysis below −35 dBFS is treated as corrupt ("reanalyse") rather than scored.
Users can override energy, moods, genre and sub-genre; the original value is kept.

*Calibration history:* v1 was tuned on synthetic audio and saturated onset density/percussion on real
masters (a real 292-track pop/hip-hop/country/dance library came out 7.9–8.9, "driving" on 97%). v2
ranges were measured on that library (read-only): it now spans 1.7–8.7, median 6.3, with ballads low and
hip-hop/mainstage high. Still unvalidated on other genres (techno, ambient, DnB-heavy libraries).

### 4.3 Wizard
Step 1 *Predefined Curve / Anchor Points / Groups* → Step 2 duration (30m, 1h, 2h, 3h, 5h, custom)
and energy range (sliders + numeric inputs) with a track-count estimate from real library durations
minus a configurable overlap → Step 3 six templates drawn as gradient graphs (Slow Burn, Peak & Valley,
Man in Hole, The Opener, The Closer, Freehand) or anchor picking / group naming → Step 4 create and open.

### 4.4 Builder
- **Energy Arc Map**: target curve (monotone cubic through control points, drag to reshape, double-click
  to add, right-click to delete in Freehand), actual track energies as a separate line with dots,
  target-vs-actual gap shading, cumulative time axis from real durations, zoom (1×–4×) for long sets.
- **Timeline**: slots with number, artwork, title/artist, BPM, key (Camelot), energy vs target, duration,
  anchor/lock, flexible flag, notes; drag-and-drop reorder; transition badge between every pair.
- **Actions**: add/remove slot, replace, lock/unlock anchor, flexible, notes, preview (headphones),
  Deck A/B, queue next, undo/redo (Ctrl+Z / Ctrl+Y), autosave.
- **Track Dock**: Library tab (search + filters: genre, sub-genre, BPM range, key, energy range, mood,
  recently added, analysed/unanalysed, vocal/instrumental where known) and Recommendations for the
  selected slot with **Next Move** steering and explanations; reject hides a suggestion for that slot.

### 4.5 Recommendation engine (`scoring.ts`)
Weights (configurable): harmonic 20, BPM 20, energy 25, genre & mood 20, structure & duration 15.
Both neighbours are scored when present. Half/double-time is accepted with a small penalty. Missing
features drop out and their weight is redistributed; **confidence** = available weight ÷ total weight
(× 0.7 for unanalysed tracks). Hard constraints (BPM range, max BPM jump, harmonic-only, energy range,
keys) filter; Next Move adds soft preferences:

| Next Move | Effect |
|---|---|
| Lift the Floor | target = prev + 1…2, penalise drops |
| Keep the Groove | target ≈ prev ±0.5, favour same genre/BPM |
| Cool It Down | target = prev − 1…2, keep BPM/key flow |
| Build Tension | +0.5…1, favour darker/less vocal, rising |
| Go Darker / Go Brighter | brightness + "dark"/"bright" mood tags + minor/major mode — not BPM |
| More / Less Vocals | STEMS vocal presence (no effect where unknown, stated in the explanation) |
| Peak Time | target ≥ 8, danceability |
| Surprise Me | deterministic per-slot novelty (hash), genre change bonus; hard constraints still apply |

The Recommended and Library tabs share one scoring context (`SetStudioService.scoreContext`), so a track
shows the same score in both. Identical audio saved under several paths (same content hash) is one track for
duplicate avoidance and is listed once. When the slot target is outside the library's energy span the
explanation says so, and the wizard/builder offer "Fit range to my library".

Every result carries part scores and a sentence, e.g. *"92% match — compatible key, close tempo and ideal energy increase."*

**Auto Fill Empty Slots** (`autofill.ts`): beam search (width 16, top-40 pre-filter per slot) left→right
over the whole sequence maximising Σ pair compatibility + Σ energy fit − duration overshoot, with every
filled slot (locked anchors included) fixed, unknown key/tempo counted as a 50/50 risk (not a free pass —
otherwise tracks with undetected keys win), lookahead into a fixed next slot, no duplicates unless
allowed, deterministic tie-breaks. Returns a proposal shown as a preview; nothing changes until *Apply*.

### 4.6 Transitions
Every adjacent pair: score, BPM delta, key relation, energy change and the primary warning, coloured
green (≥ 70, no flags) / amber / red (> 8 % tempo jump without a half/double relation, a clash plus a
tempo gap, or score < 45). Click to inspect. Advisory only.

### 4.7 Improve a Set
Pick a playlist (or saved set) → a new set (mode *improve*) with the original order, its actual energy
curve as the target, and a frozen **origin** snapshot (refs, energies, transition scores). The panel lists
problem transitions with replacement suggestions, an optional resequence preview (beam search over
unlocked tracks, anchors stay put), and a before/after comparison (energy lines + mean/min transition
score + red count). *Save as new version* duplicates with `version+1`. The source playlist is only
rewritten after an explicit confirmation dialog.

### 4.8 Integration & export
*Load into playlist* (new playlist; never silently overwrites), *Open in Auto DJ* (playlist + `AutoDJ.start`,
which still refuses while a deck is playing), *Deck A/B* (`DJEngine.loadTrack`), *Queue next*
(`AutoDJ.playNextRefs`/`add`), *Preview* (`HeadphonePreview`). Export **M3U8** (order, `#EXTINF` duration,
artist – title, path — nothing else is claimed) and native **.dbdjset.json** (full set document); import
of the native file.

### 4.9 Phase 1 acceptance criteria → evidence
| # | Criterion | Evidence |
|---|---|---|
| 1 | Navigation | Top-bar AI Set Studio button |
| 2 | Analyse library | Library Intelligence → Analyse Library |
| 3 | Persist after restart | `intel` on `track_preparation`; sets in `dj_sets` (tests: persistence round trip) |
| 4 | Curve / anchors / groups | Wizard (tests: curve + anchor generation) |
| 5 | Duration + energy range | Wizard step 2, builder header |
| 6 | Graph reacts | Arc map recomputes on reorder / control-point drag (tests: slot targets) |
| 7 | Search + add | Track Dock |
| 8 | Real ranked suggestions | `rankCandidates` (tests) |
| 9 | Adjacent compatibility | `evaluateTransition` (tests) |
| 10 | Anchors + auto fill | `autoFill` (tests: anchors kept, no duplicates, deterministic) |
| 11 | Improve without destroying | Improve flow (tests: playlist untouched) |
| 12 | Save / reopen / duplicate / delete | `SetStore` (tests) |
| 13 | Playlist + Auto DJ | Builder toolbar |
| 14 | Export | M3U8 + native (tests) |
| 15 | Existing features intact | Full vitest suite + typecheck |
| 16 | Tests | `tests/setstudio-*.test.ts` |
| 17 | About | `src/about/features.ts` |

### 4.10 Known Phase 1 limitations
- Genre/sub-genre come from tags or user overrides only; mood tags are rule-based estimates, not a trained model.
- Vocal presence needs completed STEMS separation for the track.
- Preview is headphone-only (existing `HeadphonePreview` rule: 4-channel routing). Without it the builder offers Deck A/B instead.
- Auto Fill is a heuristic optimiser (beam search), not globally optimal.
- M3U8 export carries order/duration/title/path only (no cues, grids, energy).
- Verified in a real Electron session (2026-11-21) only with a small synthetic library: Analyse Library, wizard, builder, Auto Fill, transition inspector, Improve/resequence, Groups and persistence across an app restart. Not yet tried on a large real library, and energy calibration has not been checked against real music.

---

## 5. Phase 2 — Advanced preparation (implemented 2026-11-21)

### 5.0 Stage 1 assessment: what Phase 2 builds on

| Need | Existing piece reused | Change made |
|---|---|---|
| Structure analysis | Cached 150 fps low/mid/high envelopes, beat grid, `sections` (no re-decode) | — |
| Bars, phrases, tempo matching | `transitions/planner.ts` (`matchTempo` half/double-time) | — |
| Vocal entry | `TransitionService` vocal regions (STEMS) | public `vocalRegionsFor(ref)`: cache, or computed from *already separated* STEMS; never starts a separation |
| Hot cue storage | `TrackPreparation.cues` + per-deck Suggested/Embedded `CueSourceRouter` | `PreparationStore.setHotcue(id, slot, cue)` (one slot, nothing else); the cue-source setup is unchanged |
| Cue audition | `HeadphonePreview` | optional start `offset` |
| Transition execution | Real decks + `DJEngine.setAutoEq` (cut-only, manual takeover, smooth decay), Auto DJ's fade loop | Auto DJ `preparedTransitions` hook; `DJEngine.setFxUnit` for Echo Out |
| Mixer snapshot | `captureManualMashupSetup` / `restoreManualMashupSetup` | — |
| Automatic EQ | `autoEqCurve` maths | sampled into editable lanes |
| Groups | Phase 1 `DJSetGroup` (Groups sets) | optional `blendGroupId` link; new reusable documents |
| Scoring | Phase 1 `scoreCandidate` / `rankCandidates` / `evaluateTransition` | — (no second scorer) |

Phase 1.5: there is no separate `docs/validation/AI_SET_STUDIO_PHASE_1_5.md`. The 1.5 work (real-library
energy recalibration to `dbdj-set-features` v2, content-hash duplicates, one shared scoring context,
unknown-key risk in the optimiser) is described in §4 and was done before Phase 2.

### 5.1 Architecture: one executor

```
Transition Lab (edit, compare)          Auto DJ (play a set)
        │  TransitionConfig                     │  PreparedTransition (validated: checkPlayable)
        ▼                                       ▼
   frameAt(config, progress) ── crossfader · EQ cuts per deck · echo level ──┐
        │                                                                    │
        └─► bus "mixer.crossfader" · DJEngine.setAutoEq · EchoFx(FX unit) ◄──┘
```

`frameAt` (`src/setstudio/transitionModel.ts`) is the only definition of what the mixer does during a
prepared transition. The Lab preview and Auto DJ both call it, so an audition is exactly what Auto DJ performs.

### 5.2 Automatic hot cues (`src/setstudio/autocue.ts`, `AutoCueService.ts`)

| Cue | Detection method | Without reliable data |
|---|---|---|
| Intro | first ½ s-smoothed level above 8 % of the loud level | — |
| First Beat | first grid beat at/after the intro with real low/mid energy on it | grid unreliable → omitted |
| First Phrase | bar offset (mod 8) where energy/bass changes cluster; first such bar from the first beat | weak pattern → "8 bars from the first beat", confidence 0.4 |
| Vocal Entry | first vocal region ≥ 2 s from STEMS | no STEMS analysis → omitted ("separate STEMS"); no vocals → "instrumental" |
| Build-Up 1/2 | quietest bar ≤ 32 bars before each drop, snapped to 8/16/32 bars, must rise into the drop | no drop → omitted |
| Breakdown 1/2 | ≥ 4 bars of bass < 45 % and level < 75 % of typical, after bar 16 / the drop | omitted |
| Drop 1/2 | bass jumps ≥ 0.3 over the previous 8 bars, stays up 4 bars, loud, **after real music**, ≥ 16 bars after the first beat and the previous drop | omitted |
| Outro | trailing stretch (≥ 8 bars) of reduced bass, or the last phrase where the level steps down — never before the last drop (+ 8 bars) | omitted |
| Final Mix-Out | end of the last bar at ≥ 20 % level (not the last possible moment) | no grid → last loud moment, confidence 0.55 |

- Bars assume 4 beats from the grid's first beat, because the app has no meter detection. Bar-based cues are capped at 0.75 confidence (0.85 with a hand-adjusted grid) and labelled "4/4 assumed".
- Confidence thresholds: ≥ 0.70 counts as high (used by Accept All); < 0.45 is shown as low confidence.
- Quantisation: none, beat, bar, 4, 8 or 16 bars on the existing grid. The detected position is kept alongside the quantised one. A boundary more than 2 bars away falls back to the nearest bar, with a note.
- Statuses: suggested, accepted, modified or rejected. On regeneration, accepted and modified cues are kept, and a rejection survives if the new detection lands within 2 s of it. The replaced set is kept for **Restore Previous**.
- **Hearing a cue or track** (all Set Studio ▶ buttons, `SetStudioService.audition`):
  - With 4-channel routing it uses the headphone preview, which never reaches the master.
  - Without it, when no deck is playing, the track loads on Deck A (Deck B if A's fader or crossfader side is down), seeks and plays through the speakers. The same ▶ stops it.
  - While a deck is playing, it only cues the track, paused, on the free deck, so a live mix is never disturbed.
- **Hot cue pads in Auto Cue are press-and-hold** (`SetStudioService.holdStart/holdEnd`). While held, the track plays from the cue; on release it returns to the cue, paused.
  - With headphones, the headphone preview is used.
  - Otherwise a deck is used, and only when no other deck is playing. When the deck's own pad holds the same cue (Suggested cue source), the deck's real hot cue press/release is sent, so it is the engine's own CDJ-style behaviour.
  - A tap released while the track is still loading just cues it.
- **Live playhead:** the Auto Cue waveform shows the headphone preview position, or the position on whichever deck has the track loaded, updated every frame.
- Mix regions: mix-in covers Intro, Instrumental intro (STEMS) and Pre-drop; mix-out covers Outro, Final phrase, Breakdown and After the last vocal. Each has start/end, rationale, confidence, phrase alignment and available seconds.
- **Accept All:**
  - Cues less than a beat apart share **one pad**, named for both ("Intro + First Beat"). A moment that already has a pad isn't doubled, and a single Accept on such a moment asks first.
  - When there are more moments than free pads, the most useful win (drops, builds, breakdowns, intro, outro…).
  - The chosen pads are laid out **in time order**. With "replace auto-suggested pads", those pads are cleared *before* coverage is checked.
- **Restore original pads:**
  - The pad bank is backed up (`autoCues.padBackup`) before Auto Cue first changes it, and restored exactly. Slots the user changed since then are kept.
  - Without a backup (pads changed by an earlier build), Auto Cue's pads are removed and the deck's ↻ analysis re-suggestion refills the empty pads.
  - "Previous suggestions" restores the suggestion *list* only.
- **Recommended pad layout** (`planLayout` / `applyLayout`): a card under the pad bank shows which suggestion goes on which pad A–H, and a one-click **Apply recommended layout** applies it.
  - Each pad is badged keep / new / replace *X* / move / yours / clear, with the confidence and detection method. Suggestions that don't get a pad are listed with the reason ("already on your pad C", "no pad left").
  - The user's own pads stay where they are. Every other slot is planned.
  - Cues on the same moment share one pad. The most useful moments win the pads, in this order: drops, builds, breakdowns, intro, outro, mix-out, vocal entry, first phrase, first beat.
  - An older auto pad whose moment the new suggestions didn't find still competes for a pad, so it isn't silently lost. On a reliable grid it is snapped onto the nearest bar line (only nudged, less than a quarter bar).
  - An older auto pad less than a beat from a suggestion is the same moment and gives way to it. The deck's analysis suggestions (`suggestHotCues`) count bars from 0:00 rather than from the first beat, so on a track whose first beat is at 0.23 s every one of them sits 0.23 s early.
  - Restore puts back every pad that isn't the user's own, including older pads the layout moved or snapped.
  - The chosen pads are laid out in time order across the free slots.
  - Applying backs up the pads first, so **Restore original pads** undoes it. Applying again changes nothing.
  - **Auto Cue's own pads:** a pad written by Auto Cue (comment "Auto Cue: …") that still sits on a suggested moment counts as Auto Cue's (`SlotInfo.autoCue`), even when regeneration has broken its link to a suggestion. Such a pad can be rearranged. Once the user moves it somewhere else, it is theirs.
  - Suggestion sets carry `AUTOCUE_VERSION` (now 2: repeated drops/builds/breakdowns, outro only after the last drop). Older sets show a "Regenerate" notice.
- **Protection:** suggestions live in `TrackPreparation.autoCues`, staged separately from `cues`.
  - Accept fills the first free pad. An occupied pad, or replacing older analysis suggestions, always asks first.
  - Accepted cues are written with `source: "manual"`, so the older ↻ Regenerate never removes them.
  - If you re-placed a cue on the deck, Auto Cue never overwrites it.
  - Decks using the **Suggested** cue source refresh; **Embedded** decks are left alone (→ File still copies cues into the file).

### 5.3 Transition Lab (`TransitionLabService.ts`, `ui/setstudio/TransitionLab.tsx`)

- **Entry points:**
  - set builder transition popup (set and slot context)
  - track context menu ("Transition Lab from this track…")
  - Auto DJ queue ("now → next")
  - the Lab's own pair picker, with incoming tracks ranked by the Phase 1 scorer
- **Timeline:**
  - Both waveforms are laid out on the transition's wall clock using the actual playback rates, with beats, 8-bar phrases (offset from Auto Cue's first phrase) and hot cues.
  - Drag A to move the mix-out point and B to move the mix-in point; drag the end handle to change the bar count. Alt disables snapping.
- **Tempo:** Off, Beat, Beat + Phrase, or Manual target BPM; a maximum change (default ±10 %); half/double-time handled by `matchTempo`; key lock through the deck time-stretch. Beat sync engages the engine's Sync only when both grids are reliable. Otherwise the rates still match, with a "beats may drift" warning.
- **EQ:** Off, Automatic (sampled from `autoEqCurve`), Manual curve, or Saved preset. Lanes run from 0 to −30 dB cuts, matching the engine's cut-only model, and are clamped. Lanes interpolate with smoothstep (no zipper steps); the engine's own parameter smoothing and decay still apply.
- **Echo Out:** the outgoing deck's FX unit is switched to a single Echo for the chosen window, then restored exactly.
- **Presets:**
  - Smooth Blend, Bass Swap, High/Mid Blend, Long Blend, Quick Mix
  - Breakdown Transition (needs the outgoing Auto Cue breakdown)
  - Drop Swap (needs the incoming Auto Cue drop)
  - Echo Out, plus your own saved presets
  - A missing requirement is stated; it is never invented.
- **Compare:** two or more candidates with a settings table. Switching while previewing seeks the new candidate to the same position. Undo/redo covers edits, and a drag counts as one undo step.
- **Preview:**
  - It runs on the real decks. If a deck is playing something else, or Auto DJ is running, preview is **blocked** until you explicitly choose "Stop the decks and preview".
  - The mixer, decks, key lock and FX are snapshotted and restored on Stop. The preview tracks stay loaded on the decks.
  - Pre-roll and post-roll, loop, seek, restart and pause are supported.
  - Headphones-only mode (master to 0, CUE on both channels) is only available with 4-channel routing.
- **Save:** a `PreparedTransition` keyed by set plus slots, or by track pair when no set is involved.
  - Re-saving bumps `version` and keeps the last 10 versions in `history` (restorable as a new candidate).
  - A transition saved for one set never overwrites another set's.

### 5.4 Auto DJ integration (`autodj/AutoDJ.ts`)

`AutoDJ` receives `preparedTransitions.find(outRef, inRef, playlistId)`.

- **Lookup:** the composition root maps the playlist to the set it was created from (`DJSet.playlistIds`). It returns that set's transition, else a set-independent one, never another set's. It returns nothing when the set or the global Auto DJ setting turns prepared transitions off.
- **Checks:** before use, `checkPlayable` confirms the loaded track IDs, that the positions fit both tracks, and that sync fits within the incoming deck's tempo range (otherwise sync is dropped, with a note). If echo is unavailable, it's skipped.
- **Performing it:** mix-out, mix-in and length come from the saved transition. Key lock is applied, and a manual target tempo applies to the incoming deck only (the playing track is never jolted). Each tick, `frameAt` drives the crossfader, EQ cuts and echo.
- **Fallback:** a transition that doesn't fit falls back to Auto DJ's normal plan. Manual EQ moves still take a band back, and Skip and Pause behave as before.

### 5.5 Blend Steering Groups (`BlendGroups.ts`, `ui/setstudio/BlendGroupsPanel.tsx`)

- **Group properties:** name, description, colour, energy and BPM range, Camelot keys, genres, sub-genres, moods, vocal preference (STEMS-known only), ordering (flexible, ordered or suggested), membership lock, members (position, anchor, notes) and dates.
- **Membership:** duplicates are rejected by path and by audio content. Deleting a group never deletes tracks. Sets drop their links to it (keeping a copy of its tracks) and their sections for it; journeys drop it.
- **Suggestions:** Find Similar, Expand, Lower/Higher Energy, Genre Bridges and Forgotten tracks, all from `scoreCandidate`/`rankCandidates`, averaged over seed tracks. Steering into a group from the current track uses the destination group's energy and Next Move. Bridges between two groups score outside tracks against one group's exit and the next group's entry.
- **Statistics:** energy, BPM histogram, keys, moods and pair states (pair-specific, never "everything mixes").
- **Journeys:** an ordered list of groups, shown as an energy journey with bridges. "Create a set from this journey" makes a curve set with one section per group.
- **Set builder:** `DJSet.groupSections` (fractions of the planned time) shows as bands and headers that can be collapsed.
  - Auto Fill draws section slots only from that group's members.
  - "Auto Fill from <group>" fills only that section, placing the group's anchors first.
  - The dock has an "only from this group" toggle.
  - Groups sets can link a group to a reusable one (⛓, live membership) or turn a local group into a reusable one.

### 5.6 Persistence and migrations

| Data | Where | Migration |
|---|---|---|
| `GeneratedCue` set + mix regions | `TrackPreparation.autoCues` (existing `track_preparation` JSON) | optional field, schema unchanged |
| `PreparedTransition`, `TransitionPreset`, `BlendGroup`, `GroupJourney` | new `setstudio_docs (kind, id, data, updated_at)`, kinds whitelisted in the main process | `CREATE TABLE IF NOT EXISTS`; localStorage fallback (`dbdj.setstudio.docs.*`) for the browser and older preloads |
| Set sections, playlist links, per-set switch | `DJSet.groupSections`, `playlistIds`, `preparedTransitions` | optional fields carried by `migrateSet` |
| Global switch | `AutoDJSettings.preparedTransitions` (default on) | merged with defaults on load |

The spec's `DJSetGroupReference` is `DJSet.groupSections`, and `BlendGroupTrack` lives inside `BlendGroup.tracks`. There are no join tables: each set or group is one atomic document, and references are checked when read (missing groups and tracks are shown as such).

### 5.7 Phase 2 acceptance

| # | Criterion | Evidence |
|---|---|---|
| 1–2 | Cue suggestions; all nine types, unavailable ones explained | `tests/setstudio-autocue.test.ts`; Electron run on a real track |
| 3–4 | Review/move/accept/reject; manual cues protected | service tests (occupied slot, full bank, re-placed pad, accept-all replace) |
| 5 | Mix-in/out regions | detection tests; Auto Cue panel |
| 6–9 | Audition on the real engine; timing/alignment; sync + key lock; EQ lanes | `tests/setstudio-transitions.test.ts` (preview drives decks, frame values, exact restore); Electron preview on a real pair |
| 10–11 | Compare; presets applied and saved | Lab tests |
| 12 | Persist after restart | DocStore reload test; Electron restart |
| 13 | Auto DJ consumes saved transitions | Auto DJ + prepared tests (timing, crossfader, EQ, takeover, fallback, off switch) |
| 14–17 | Groups created/reused; suggestions; sections; group Auto Fill | `tests/setstudio-groups.test.ts`; Electron run |
| 18–19 | Existing features intact; tests and build | full vitest suite, typecheck, production build |
| 20 | Docs and About | this section; `src/about/features.ts` |

### 5.8 Phase 2 limitations

- No meter or downbeat detection in the app: bars and phrases assume 4/4 from the grid's first beat, which is labelled and confidence-capped.
- Vocal Entry needs STEMS separation for the track. The Lab does not start separations.
- Preview takes over Deck A/B (with consent) and leaves the preview tracks loaded. Without 4-channel routing it plays through the master.
- EQ automation is cut-only (no boosts), the same as Auto EQ.
- Echo Out uses the deck's FX unit, so it temporarily changes that unit (restored afterwards).
- Prepared transitions apply when Auto DJ plays a playlist created from the set (Load into playlist / Open in Auto DJ), or for set-independent transitions.
- Detection is verified on synthetic structures and one real track. It needs wider listening tests (hip-hop/pop give fewer clear builds and drops than dance music).

## 6. Phase 3 — AI music discovery (planned)


**15. Music Galaxy.** Feature vectors from `SetIntel` (energy, brightness, bass, percussive, density,
danceability, tempo on a log/octave-folded scale, Camelot on a circle, mode, vocal presence when known,
genre one-hot) → standardise → PCA to 2D (deterministic) with optional UMAP-style refinement in a worker;
3D via the third component. Canvas 2D renderer with quadtree hit-testing as the default (low-power
fallback), WebGL optional. Similar-track highlight = k-NN in feature space (the same vectors, so
placement reflects real similarity). Add-to-set uses the Track Dock path.

**16. AI Crate Digger.** Local query planner: structured filters + similarity search + "forgotten" signal
(not played in Auto DJ history / not in any set / old `addedAt` / low play count once play history exists).
Natural-language parsing via an **optional** provider (Claude API; user-supplied key; only metadata and
feature numbers sent — never audio, and only after consent). External catalogue results are a separate,
clearly labelled list that can't be loaded to decks.

Acceptance: galaxy positions are reproducible from features; crate digger works fully offline without a provider.

## 7. Phase 4 — Live performance integration (planned)

**17. Live Mixing Assist.** A compact deck-side panel subscribing to `DJEngine` state: current track
(the deck that is audible by crossfader/fader), live BPM (rate-adjusted), key (with key-lock state),
energy, remaining time, the set's next planned slots and current target energy. Recommendations reuse
`rankCandidates` with the playing track as `prev`; steering choices map to Next Move (+ *Return to Planned
Set* = target from the curve at the elapsed position). Never loads or plays automatically unless the user
enables it.

**18. Auto DJ + planned sets.** `AutoDJ.startSet(setId, mode)`: **Strict** plays the slot order exactly;
**Adaptive** may substitute/reorder unlocked slots using `rankCandidates` against the curve target at the
current elapsed time, respecting locks and hard constraints; uses saved transition configurations; Beat
Sync/Auto EQ as configured; every adaptive decision logged and reversible (*Revert to plan*). Any manual
deck/mixer action keeps priority (existing Auto DJ rule).

**19. Performance feedback.** Record a `PerformanceLog` (actual order, times, deck, tempo, transitions
performed, skips/substitutions) and compare to the plan: order diff, target vs actual energy, transition
outcomes, duration drift. Explicitly no audience-reaction claims without audience data.

## 8. Phase 5 — Interoperability (planned)

**20. Adapters** behind `SetExporter`/`SetImporter` interfaces, each declaring the fields it can carry and
producing a validation report of dropped/partial data:

| Target | Format | Order | BPM | Key | Hot cues | Beatgrid | Notes |
|---|---|---|---|---|---|---|---|
| Generic | M3U8 (Phase 1) | ✓ | – | – | – | – | `#EXTINF` only |
| Mixxx | M3U/CSV playlist; library via its SQLite schema (read-only import) | ✓ | import | import | import | import | Documented schema; write-back avoided |
| rekordbox | `rekordbox.xml` (DJ_PLAYLISTS) | ✓ | ✓ | ✓ | ✓ (POSITION_MARK) | ✓ (TEMPO) | Officially documented XML |
| Traktor | `collection.nml` / playlist NML | ✓ | ✓ | ✓ (MUSICAL_KEY) | ✓ (CUE_V2) | ✓ | Format is stable but undocumented → read/write tested against fixtures |
| Serato | Crates (`.crate`), GEOB tags in files | ✓ | partial | partial | via file tags | via file tags | Writing file tags only with explicit consent |

Native DBDJ metadata (energy, intel, curves, notes) is always kept in the `.dbdjset.json` sidecar.

---

## 9. Technical decisions

1. **Derive, don't re-analyse.** Set features run on the cached band envelopes → a full library pass is
   I/O-bound (one JSON read per track), not decode-bound.
2. **Store intel on the preparation record**, not a new table: one identity, one record, and it already
   follows the file across moves.
3. **Document-per-set** storage: atomic, versioned, matches existing patterns; transitions recomputed on save.
4. **Own scorer** rather than changing `discovery.compatibility`, which DJMix and mashups depend on.
5. **Beam search** for Auto Fill/resequencing: deterministic, testable, good quality, bounded cost.
6. **No external AI dependency** in Phase 1; anything ML-shaped is behind the extractor registry and is
   marked *unsupported* when absent.
7. **Lower-pane workspace** so the decks stay one click away for preview/load.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Energy calibration differs by genre | Weights in `ENERGY_MODEL`; user overrides; confidence shown |
| Rule-based moods mistaken for ML | Labelled "estimated" in UI and docs; overridable |
| Large libraries (20k+) | Profiles memoised per revision; pre-filter before beam search; derivation yields between tracks |
| Moved/renamed files | Content-hash resolution; missing tracks kept with relink suggestion |
| Preview needs 4-ch routing | Clear message; Deck A/B fallback |
| Schema drift | `schemaVersion` + `migrateSet`; additive SQL migration; old preload fallback |
| Feedback loop on preparation events | Idempotent staleness check before every intel write |

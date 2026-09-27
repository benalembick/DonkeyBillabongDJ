# Controller Mappings

## Pipeline

```
Mixxx *.midi.xml ──► MixxxImporter ──┐
Built-in TS profile ─────────────────┼──► ControllerMapping (dbdj.controller-mapping/1, JSON)
Mapping editor (Phase 4) / JSON file ┘                │
                                                      ▼
Web MIDI message ──► MappingRuntime ──► CommandBus (deck1.play …) ──► DJ Engine
                          ▲                                              │
                          └────────── LED feedback (getFeedback) ◄───────┘
```

## Normalised format (`src/controllers/mapping/schema.ts`)

```jsonc
{
  "schema": "dbdj.controller-mapping/1",
  "id": "pioneer-ddj-sb",
  "name": "Pioneer DDJ-SB",
  "match": { "portNamePatterns": ["DDJ[- ]?SB(?![0-9])"] },     // regex vs MIDI port name
  "provenance": { "source": "...", "license": "...", "authors": [...] },
  "controls": [ { "id": "deckA.play", "label": "Play/Pause A", "kind": "button", "section": "deckA", "short": "PLAY A" } ],
  "inputs": [
    { "control": "deckA.play", "midi": { "type": "note", "channel": 1, "note": 11 }, "action": "deck1.play" },
    { "control": "deckA.tempo", "midi": { "type": "cc14", "channel": 1, "msb": 0, "lsb": 32 }, "action": "deck1.tempo", "encoding": "absolute" },
    { "control": "deckA.jog", "midi": { "type": "cc", "channel": 1, "cc": 33 }, "action": "deck1.jog.ring", "encoding": "relative-offset64" },
    { "control": "deckA.filter", "midi": { "type": "cc14", "channel": 7, "msb": 23, "lsb": 55 }, "action": "mixer.channel1.gain", "modifier": "shift" }
  ],
  "outputs": [ { "feedback": "deck1.playing", "midi": { "type": "note", "channel": 1, "number": 11 }, "on": 127, "off": 0 } ],
  "hints": { "jogTicksPerRevolution": 720 }
}
```

- MIDI channels are **1-based**.
- `encoding`:
  - `button` (default for notes);
  - `absolute` (default for CC, CC14 and pitchbend; scaled to 0..1);
  - `relative-offset64` (value − 64, used by Pioneer jogs);
  - `relative-twos-complement` (browse encoders);
  - `relative-signed-bit`.
- Optional per-binding fields: `invert`, and `scale` for relative encodings.
- `modifier`: bindings carrying a modifier win while it is held; otherwise only modifier-less bindings apply. The mapping itself defines the modifier via an input bound to `modifier.shift`.
- 14-bit values are dispatched when the LSB arrives. Pioneer always sends the MSB first.

## Pioneer DDJ-SB

Source: `src/controllers/profiles/pioneer-ddj-sb.ts`. Export it as JSON from Settings → "Export mapping".

**Provenance:** the MIDI numbers, LED scheme and layers come from Mixxx's `Pioneer-DDJ-SB.midi.xml` and `Pioneer-DDJ-SB-scripts.js`. Their authors are Joan Ardiaca Jové, building on wingcom and Hilton Rudham, and the script header declares the **MIT licence**. We don't copy or run Mixxx code. The behaviour (jog, cue, shift) is implemented independently in our engine, and the mapping is our own data file with attribution.

| Area | MIDI layout (channel is 1-based) |
|---|---|
| Deck A / B buttons | Notes on ch 1 / 2: PLAY 0x0B, CUE 0x0C, SYNC 0x58, KEY LOCK 0x1A, VINYL 0x17, SHIFT 0x3F, HP CUE 0x54. Shifted variants: 0x47, 0x48, 0x5C, 0x60 (tempo range), 0x4E, 0x68 |
| Tempo, EQ, fader | 14-bit CC on ch 1 / 2: tempo 0x00/0x20, HI 0x07/0x27, MID 0x0B/0x2B, LOW 0x0F/0x2F, fader 0x13/0x33 |
| Jog | CC on ch 1 / 2, relative, centre 0x40: ring 0x21, platter 0x22/0x23, SHIFT ring 0x26, SHIFT platter 0x1F. Touch notes 0x36 / 0x35 / 0x67 |
| Global (ch 7) | Crossfader CC14 0x1F/0x3F; HP mix 0x05/0x25; FILTER A/B 0x17/0x37 and 0x18/0x38 (SHIFT gives gain, since there is no trim knob); browse CC 0x40 (two's complement), SHIFT browse 0x64; push 0x41 / 0x42; LOAD A/B notes 0x46 / 0x47 |
| Pads (ch 8 = A, ch 9 = B) | Mode chosen in hardware. HOT CUE 0x00–0x03 (5–8: 0x40–0x43), SHIFT adds 0x08 (clear). AUTO LOOP 0x10–0x13 / 0x18–0x1A, rolls 0x50–0x5B. MANUAL LOOP 0x20–0x23, 0x28 / 0x29 / 0x2B, kills and mute 0x60–0x63. SAMPLER mode drives **STEMS**: 0x30–0x33 = vocals / drums / bass / instruments mute, SHIFT (0x38–0x3B) = solo, LEDs lit while the stem is audible; 0x70–0x7B (sampler load/eject) not implemented |
| FX (ch 5 / 6) | Buttons 0x47–0x49 (SHIFT 0x63–0x65), knob CC14 0x06/0x26, SHIFT knob 0x00/0x20 |
| LEDs | Send the same note back: 0x7F on, 0x00 off. Pad LEDs are on ch 8 / 9 at the pad's note |

**Needs hardware confirmation** (tracked in the test matrix):

- whether deck B's SHIFT is `0x91 0x3F`;
- which of the 0x35 and 0x36 touch notes fires;
- jog ticks per revolution;
- tempo slider direction;
- whether the controller's 4 output channels are visible to Chromium.

## Mixxx import (compatibility layer)

Use Settings → Controllers → "Import Mixxx mapping (.xml)". The importer:

1. parses `<controls>` and `<outputs>` (with fast-xml-parser);
2. translates exact `(group, key)` pairs through `mixxxControlMap.ts`. This covers `[ChannelN]`, `[Master]`, `[Playlist]`, `[Library]`, `[SamplerN]`, `[EffectRack1_EffectUnitN]`, `[QuickEffectRack1_[ChannelN]]` super1 and `[EqualizerRack1_[ChannelN]_Effect1]` parameter1–3;
3. handles `<script-binding/>` controls by inferring from the function name (e.g. `jogRingTick` → `jog.ring`, `hotCueButtons` → `hotcue.N` numbered by MIDI order, `…MSB`/`…LSB` pairs → `cc14`). Each is marked `confidence: "heuristic"`;
4. applies `<fourteen-bit-msb/lsb>`, `<selectknob/>`, `<spread64/>`, `<invert/>` and `<button/>`;
5. reports every control it could not translate, and warns about script-only LED feedback.

Scripts are never executed. The DDJ-SB result is 183/220 controls translated, all matching the built-in mapping. Imported mappings take priority for matching ports and can be downloaded as dbdj JSON.

## Adding a controller

1. Plug it in and open **MIDI monitor**. Unmapped devices still appear there.
2. Either import its Mixxx mapping, or copy `pioneer-ddj-sb.ts` into a new profile and register it in `createApp.ts` (`mappings: [...]`).
3. Add a `match.portNamePatterns` regex from the port name shown in Diagnostics.
4. Run `npm test`. The integrity tests apply to all built-in profiles once they're added to `tests/mapping.test.ts`.
5. Use the **Controller test** tab to verify every control, then copy the report.

## Debugging MIDI

- **MIDI monitor**: device, type, channel, control number (dec/hex), value, and the command triggered, e.g. `CC 34 → deck1.jog.platter`.
- **Live controller events**: friendly lines such as `PLAY A`, `JOG A +4`, `TEMPO A +1.7%`, `EQ HIGH A 64`, `PAD A1 · Hot cue 1 A`. Messages with no binding show as **UNMAPPED** with their raw bytes.
- **Diagnostics**: MIDI availability, messages per second, device list, mapping in use, and whether an output (LED) port was found.
- In devtools, `window.dbdj` exposes the service graph, e.g. `dbdj.bus.send("deck1.play")`.

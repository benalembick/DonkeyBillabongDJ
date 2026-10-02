# DMX Lighting (MVP)

DonkeyBillabongDJ can drive DMX lighting directly, with no separate lighting software. The workflow follows QLC+: a fixture patch, universes with inputs and outputs, a simple desk, and a Virtual Console. It's all built around one DMX engine, so scenes, chases, MIDI control and DJ-aware (Auto DJ) lighting can be added later without rebuilding anything.

Open it from **Lighting** in the main navigation. It replaces the library area, so the decks stay visible, and it has four tabs: **Virtual Console | DMX Desk | Fixtures | Inputs / Outputs**. The **MASTER** fader and **BLACKOUT** button sit in the Lighting bar on every tab.

## Architecture

```
Control sources                          DmxEngine (src/lighting/DmxEngine.ts)
  DMX Desk ─────────── layer "desk"  ──►  universe → channel (1–512) → value (0–255)
  Sound-to-Light ───── layer "sound" ──►  · output = HTP merge of all layers
  Art-Net input ────── layer "input" ──►  · grand master scales light-output channels only
  later: scenes, chases, MIDI,           · blackout zeroes the output, layers untouched
  Auto DJ lighting → more layers                     │ compute() at 40 Hz
                                                     ▼
Fixture patch (fixtures.ts)            Output providers (one per universe)
  JSON fixture definitions,              Art-Net · sACN/E1.31  → main process UDP (electron/lighting/dmxNet.ts)
  modes, channel types, address map      USB DMX (Enttec Pro)  → Web Serial (src/lighting/usbPro.ts)
                                         None
```

- **One state.** The desk, the Virtual Console and sound-to-light never own DMX values; they write layers in the engine. The desk shows the engine live, so values set by sound or input appear on its faders' output bars.
- **Channel types, not channel numbers.** Fixture definitions describe each channel's function (red, dimmer, pan…). The grand master, sound mappings and Full On all work from these types. Position, strobe and effect channels are never scaled by the master or driven by sound.
- **Protocols are pure encoders** in `src/lighting/protocol.ts` (ArtDmx/ArtPoll/ArtPollReply, the E1.31 data packet, the Enttec USB Pro message). They're shared by the main process, the Web Serial provider and the tests.
- **Stable control IDs.** Lighting controls are command-bus actions, so the DDJ-SB or any MIDI controller can be mapped to them later through the normal mapping system:
  - `lighting.blackout`, `lighting.master`, `lighting.desk.clear`
  - `lighting.sound.enable`, `lighting.sound.beatFlash`, `lighting.sound.downbeatAccent`
  - `lighting.sound.brightness`, `lighting.sound.sensitivity`, `lighting.sound.speed`

## Inputs / Outputs

| Output | How | Status shown |
|---|---|---|
| Art-Net | UDP from the desktop app to a node IP or broadcast, port 6454. ArtPoll every 3 s | **Connected** only when a node answers ArtPoll; otherwise **Disconnected** ("no node answered") |
| sACN / E1.31 | UDP multicast 239.255.x.y:5568, or unicast to a host. Per-universe priority | **Sending**. sACN has no acknowledgement, so it never claims a connection |
| USB DMX: Enttec Pro protocol | Web Serial, "send DMX" label-6 messages: Enttec DMX USB Pro / Mk2, DMXking ultraDMX Pro and compatibles. Detected by asking the interface for its serial number | **Connected** (the interface answered); **Error** on write failure (e.g. unplugged) |
| USB DMX: Open DMX | Bare FTDI FT232 + RS-485 cables (Enttec Open DMX, most cheap "USB to DMX" cables). The app generates DMX: BREAK via Web Serial `setSignals`, then start code + 512 slots at 250 kbaud 8N2, ~35 frames/s | **Sending**: the cable can't report back, so it never claims a connection |
| None | — | Disabled |

- **Input:** Art-Net. Received ArtDmx for a chosen port-address feeds the universe's input layer.
- **Refresh:** frames go out when values change, with a keep-alive at least once a second.
- **Exit behaviour** (default **DMX output → 0**): on quit, network outputs are zeroed three times before the app exits, and USB gets a zero frame. The alternative is **Hold last look**.
- **Browser version:** browsers can't send UDP, so Art-Net and sACN show as unavailable there and need the desktop app.
- **USB port choice:** the app picks the interface automatically, and only FTDI-based or DMX-named USB serial ports; it never opens an arbitrary COM port. There's no port-picker yet if several interfaces are connected.

**Detection:** on **Connect** the app first asks for a Pro serial number (label 10, 57,600 baud). If a valid reply arrives within 500 ms it uses the Pro protocol; otherwise it reopens the port at 250 kbaud 8N2 in Open DMX mode. Break length is set by the `setSignals` round trip (about 1 ms, well above the 88 µs minimum), and the next break waits for the previous frame to leave the adapter. USB-DMX chips other than FTDI, or interfaces with their own vendor protocol (e.g. uDMX), would need a **companion service** behind the same `send(universe, frame)` provider contract.

## Fixtures

- **Library:** built-in generic fixtures:
  - RGB PAR (5ch / 3ch)
  - RGBW PAR
  - RGBWAUV PAR
  - Moving Head (11ch spot / 8ch wash)
  - LED Bar (4ch / 12ch segments)
  - Strobe
  - Dimmer
  - Generic single channel
- **Definition format:** `FixtureDef` (manufacturer, model, modes, typed channels), a JSON-friendly schema in the spirit of QLC+ / Open Fixture Library, so real fixture definitions can be added or imported later.
- **Patching:**
  - Pick a fixture, mode, name, universe and start address; the next free address is suggested.
  - The occupied range is shown (start 21 with 5 channels → 21–25).
  - **Overlaps are refused** and the clashing fixtures are named, unless you press **Overlap anyway**.
  - The **address map** shows all 512 channels of a universe, coloured per fixture, with overlaps hatched red.

## Importing from QLC+

**Fixtures → Import from QLC+** accepts several files at once:

- **Fixture list (`.qxfl`) or workspace (`.qxw`):**
  - Recreates the patch: names, universes and start addresses, converted from QLC+'s 0-based numbers.
  - Imports **Invert**/**Linear** channel modifiers (e.g. a mirrored head's pan). Other QLC+ curves, such as "Exponential Deep", are listed in the report and output linearly.
  - Skips MIDI controllers that QLC+ lists as fixtures for button feedback (e.g. a Novation Launchpad).
- **Fixture definitions (`.qxf`):**
  - Give every channel its real function, from QLC+ presets (`IntensityRed`, `PositionPan`…) or groups (Intensity + colour, Pan, Tilt, Speed, Shutter, Colour, Gobo, Effect, Maintenance…), plus value ranges shown on the desk ("Now: Strobe slow → fast").
  - Can be imported before, with, or after the list; patched fixtures link to them by manufacturer and model.
- **Where your own QLC+ definitions live:** `%USERPROFILE%QLC+Fixtures` (Windows), `~/Library/Application Support/QLC+/Fixtures` (Mac), `~/.qlcplus/fixtures` (Linux). Definitions that ship with QLC+ are in its install folder under `Fixtures`.

**Safety:**
- **Fixtures without a definition** are patched with **unknown** channels ("CH 1…n", with a NEEDS DEFINITION badge). The desk can set them, but sound-to-light, FULL ON and the grand master never touch them.
- **Lasers** (a definition of type Laser, or "laser" in the model or channel names) are **never driven by sound-to-light** unless **Allow lasers** is switched on with a confirmation, and are always excluded from FULL ON.

## DMX Desk

- **Faders:** 32 channel faders per page, labelled with channel number, fixture and function (e.g. `001 Front PAR Left RED`).
- **Live output:** the bar behind each fader and the small number underneath show the **actual output** after merge, master and blackout, so you see sound-to-light or input changing values in real time.
- **Groups:** click channel numbers to select; Ctrl/Shift-click to build a group, and a moved fader then moves the whole group.
- **Buttons:**
  - **Universe** selector.
  - **FULL ON:** light-output channels only, never pan/tilt/strobe.
  - **RESET:** clears the desk layer.
  - Master and **BLACKOUT** are in the Lighting bar.

## Virtual Console and Sound Activated Light Control

The Virtual Console is a list of widgets (`VcWidget`, with a type registry). The MVP ships one widget type, **Sound Activated Light Control**. Buttons, faders, XY pads, scenes, chases, colour and group widgets are new entries in `VC_WIDGET_TYPES`.

**Audio sources.** These reuse the app's own audio graph:
- **Master:** the DJ mix, after the master level.
- **Deck A / Deck B:** after EQ/filter/FX and before the channel fader, so a deck can drive the lights even when faded out.
- **Microphone:** `getUserMedia`, for music not playing through the app.

**Analysis.** It reads an `AnalyserNode` tap on the source, 40 times a second:
- **Bands:** split at the **same crossovers as the channel EQ and the EQ-reactive waveforms** (LOW < 220 Hz, MID 220 Hz–3.5 kHz, HIGH > 3.5 kHz).
- **Levels:** one **shared** auto-gain across the three bands (so their balance is kept), plus sensitivity and attack/release set by Speed.
- **Beats from the beat grid:** when the source deck is playing and has a grid, beats come from it (exact tempo, with a downbeat every 4 beats). For Master, that's the tempo-master deck or the loudest playing deck.
- **Beats without a grid:** with no grid (e.g. the microphone), beats come from kick detection on the bass band, and BPM from the median beat interval.
- **Events:** `beat`, `downbeat`, `bar`, `bassHit`, `midHit`, `highHit` (for future effects).

**Mappings** are editable data, not code. The defaults are:
- Bass → Red, Mid → Green, High → Blue (+ a little White).
- Overall level → Dimmer.
- Beat → Dimmer flash (downbeats flash stronger with Downbeat Accent).
- Fixtures without a dimmer carry the flash in their colour channels.
- Strobe and effect channels are never driven by sound; pan/tilt only by **Movement** (below).

**Controls:**
- Enable, source, Sensitivity, Master Brightness, Speed (Slow ↔ Fast), and Bass/Mid/High Response.
- Beat Flash and Downbeat Accent toggles, and BLACKOUT.
- Live **BASS / MID / HIGH / BEAT** meters, with BPM and where the beats come from.
- **Controlled fixtures** checklist with Select all / Clear.
- Sound control never switches itself on at startup.

**Movement (moving heads follow the music).** Part of sound control, for the controlled fixtures that have pan/tilt:
- **Patterns:** Circle, Figure 8, Pan sweep, Tilt nod, and Beat jumps (a new pseudo-random spot four times per cycle, stable per head).
- **Locked to the beat:** one cycle every 1 beat … 4 bars. The clock is the deck's beat grid when there is one; otherwise the detected tempo, pulled back into phase on each detected kick. With no signal the heads hold still.
- **Shape:** Size, Pan/Tilt centre, Spread (heads offset around the cycle, unison → wave) and Mirror pairs (every other head reverses pan).
- **Follow energy:** moves grow with the loudness (drops) and shrink in breakdowns.
- **Output:** 16-bit through PAN FINE / TILT FINE where the fixture has them; inverted-pan modifiers still apply.
- **Position is LTP, not HTP.** While Movement is on, the sound layer *claims* those pan/tilt channels (`DmxEngine.claimChannels`), so the result is the movement — never "the higher of two positions". Switching Movement (or sound control) off releases them and the desk position returns.
- Lasers are never moved unless **Allow lasers** is on.
- MIDI-mappable: `lighting.sound.movement` (on/off) and `lighting.sound.movement.size`.

**Desk channels linked to sound.** On the DMX Desk, any channel's **♪** button allocates it to part of the music (`SoundSettings.channelLinks`) — e.g. a laser's pattern channel changing shape on every beat, or a gobo following the highs:
- **Follows:** Bass, Mids, Highs, Overall level, Beat, or Downbeat (each bar).
- **Follow the level:** the value moves between Min and Max with that level (Beat/Downbeat: their flash).
- **Next step / Random step on each hit:** on each bass/mid/high hit, beat or bar, the channel moves to the next (or a random, never the same) value. The values are the channel's **named ranges** from its fixture definition (e.g. a QLC+ laser's pattern list, midpoint of each range within Min–Max), or N evenly spaced steps.
- Linked channels are owned by sound control (LTP claim) while it's on; the desk fader takes over again when it's off. Laser fixtures only follow once **Allow lasers** is on.

## Persistence

The whole setup is saved to `<userData>/lighting.json` (desktop) or localStorage (browser) and restored at start:
- fixtures, modes and addresses;
- universes and input/output settings;
- exit behaviour and master;
- Virtual Console widgets;
- sound settings, mappings, movement and controlled fixtures.

## Verified

Unit tests (`tests/lighting.test.ts`) cover:
- ArtDmx / ArtPoll / ArtPollReply, the E1.31 layout, and Enttec framing;
- address ranges, overlaps and channel labels;
- HTP merge, master mask, and non-destructive blackout;
- sound mappings, grid beats, quiet signals, and editable mappings;
- movement: pattern shapes, one cycle per N grid beats, mirror/spread, 16-bit output, LTP ownership of pan/tilt and its release, kick-locked movement without a grid, holding still in silence, lasers never moved;
- **real UDP on localhost**: Art-Net frames and ArtPoll, "connected" only after a node's ArtPollReply, sACN packets, and zeroing on shutdown.

End-to-end in the desktop app (`DBDJ_SMOKE_LIGHTING=run`, then `=verify` after a restart), with the main process acting as an sACN receiver and an Art-Net node:
- Lighting opened, and a fixture was added through the Fixtures form.
- An overlapping fixture was refused.
- sACN on universe 1 and Art-Net on universe 2.
- A desk fader reached the wire (200 on sACN, 123 on Art-Net).
- Sound-to-light on a real track: beats from the grid at 128.04 BPM (`DbbbDbbbD`), and 146 distinct colour frames on sACN with the strobe at 0.
- Blackout: dark frames until release, then the look returned.
- After a restart, fixtures, universes and controlled fixtures were all restored.

Movement in the app (`DBDJ_SMOKE_MOVEMENT=track.wav`): two generic moving heads circled once per bar locked to the track's 123.98 BPM grid (pan and tilt 0.34–0.66 around the centre, the second head an exact mirror), and switching Movement off returned pan/tilt to the desk.

Not tested with real hardware here: a physical Art-Net/sACN node and a USB DMX Pro interface.

## Next steps

**Scenes, Chases and BPM Sync** fit straight into this design:
- A scene is a stored layer.
- A chase steps scenes on `beat`/`bar` events from the deck's grid, e.g. a 4-colour chase locked to 128 BPM.
- Auto DJ can later pick scenes from the track's analysed sections (build-ups, drops, breakdowns) and phrase boundaries, and prepare the next deck's lighting before the transition.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importMixxxMapping } from "../src/controllers/mixxx/MixxxImporter";

/** Synthetic Mixxx-format mapping written for these tests (not taken from Mixxx). */
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<MixxxControllerPreset mixxxVersion="2.3.0+" schemaVersion="1">
  <info><name>Acme DJ-100</name><author>Test</author></info>
  <controller id="ACME">
    <scriptfiles><file functionprefix="AcmeDJ" filename="Acme-DJ-100.js"/></scriptfiles>
    <controls>
      <control><group>[Channel1]</group><key>play</key><status>0x90</status><midino>0x0B</midino><options><normal/></options></control>
      <control><group>[Channel2]</group><key>cue_default</key><status>0x91</status><midino>0x0C</midino><options><normal/></options></control>
      <control><group>[Master]</group><key>crossfader</key><status>0xB6</status><midino>0x1F</midino><options><fourteen-bit-msb/></options></control>
      <control><group>[Master]</group><key>crossfader</key><status>0xB6</status><midino>0x3F</midino><options><fourteen-bit-lsb/></options></control>
      <control><group>[EqualizerRack1_[Channel1]_Effect1]</group><key>parameter3</key><status>0xB0</status><midino>0x07</midino><options><normal/></options></control>
      <control><group>[QuickEffectRack1_[Channel2]]</group><key>super1</key><status>0xB1</status><midino>0x17</midino><options><normal/></options></control>
      <control><group>[Playlist]</group><key>SelectTrackKnob</key><status>0xB6</status><midino>0x40</midino><options><selectknob/></options></control>
      <control><group>[Channel1]</group><key>hotcue_3_activate</key><status>0x97</status><midino>0x02</midino><options><normal/></options></control>
      <control><group>[Channel1]</group><key>beatloop_4_toggle</key><status>0x97</status><midino>0x12</midino><options><normal/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.jogTouch</key><status>0x90</status><midino>0x36</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.jogRingTick</key><status>0xB0</status><midino>0x21</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.tempoSliderMSB</key><status>0xB0</status><midino>0x00</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.tempoSliderLSB</key><status>0xB0</status><midino>0x20</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.hotCueButtons</key><status>0x97</status><midino>0x40</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.hotCueButtons</key><status>0x97</status><midino>0x41</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.rotarySelectorClick</key><status>0x96</status><midino>0x41</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ.mysteryButton</key><status>0x90</status><midino>0x70</midino><options><script-binding/></options></control>
      <control><group>[Skin]</group><key>show_maximized_library</key><status>0x96</status><midino>0x65</midino><options><normal/></options></control>
    </controls>
    <outputs>
      <output><group>[Channel1]</group><key>play_indicator</key><status>0x90</status><midino>0x0B</midino><on>0x7F</on><off>0x00</off><minimum>0.5</minimum></output>
      <output><group>[Channel1]</group><key>hotcue_1_enabled</key><status>0x97</status><midino>0x00</midino><minimum>0.5</minimum></output>
      <output><group>[Channel1]</group><key>beat_active</key><status>0x90</status><midino>0x58</midino></output>
    </outputs>
  </controller>
</MixxxControllerPreset>`;

describe("Mixxx importer", () => {
  const { mapping, report } = importMixxxMapping(FIXTURE, { fileName: "Acme-DJ-100.midi.xml" });
  const find = (action: string) => mapping.inputs.find((b) => b.action === action);

  it("reads metadata and flags script files", () => {
    expect(report.controllerName).toBe("Acme DJ-100");
    expect(report.scriptFiles).toEqual(["Acme-DJ-100.js"]);
    expect(report.warnings.some((w) => /script/.test(w))).toBe(true);
    expect(new RegExp(mapping.match.portNamePatterns[0], "i").test("ACME DJ-100")).toBe(true);
  });

  it("translates exact controls", () => {
    expect(find("deck1.play")?.midi).toEqual({ type: "note", channel: 1, note: 0x0b });
    expect(find("deck2.cue")?.confidence).toBe("exact");
    expect(find("mixer.channel1.eq.high")?.midi).toEqual({ type: "cc", channel: 1, cc: 7 });
    expect(find("mixer.channel2.filter")).toBeDefined();
    expect(find("deck1.hotcue.3")).toBeDefined();
    expect(find("deck1.beatloop.4")).toBeDefined();
  });

  it("pairs fourteen-bit halves into cc14", () => {
    expect(find("mixer.crossfader")?.midi).toEqual({ type: "cc14", channel: 7, msb: 0x1f, lsb: 0x3f });
  });

  it("maps selectknob to a relative encoding", () => {
    expect(find("browser.scroll")?.encoding).toBe("relative-twos-complement");
  });

  it("infers script bindings and marks them heuristic", () => {
    expect(find("deck1.jog.touch")?.confidence).toBe("heuristic");
    expect(find("deck1.jog.ring")?.encoding).toBe("relative-offset64");
    expect(find("deck1.tempo")?.midi).toEqual({ type: "cc14", channel: 1, msb: 0, lsb: 0x20 });
    expect(find("browser.select")).toBeDefined();
    // indexed functions get consecutive indices by MIDI order
    expect(mapping.inputs.filter((b) => /^deck1\.hotcue\.[12]$/.test(b.action)).map((b) => b.action).sort()).toEqual(["deck1.hotcue.1", "deck1.hotcue.2"]);
  });

  it("reports what it cannot translate", () => {
    const keys = report.unresolved.map((u) => u.key);
    expect(keys).toContain("AcmeDJ.mysteryButton");
    expect(keys).toContain("show_maximized_library");
    expect(keys).toContain("beat_active");
  });

  it("translates LED outputs", () => {
    expect(mapping.outputs).toContainEqual({ feedback: "deck1.playing", midi: { type: "note", channel: 1, number: 0x0b }, on: 0x7f, off: 0 });
    expect(mapping.outputs.find((o) => o.feedback === "deck1.hotcue.1")).toBeDefined();
  });

  it("rejects non-Mixxx XML", () => {
    expect(() => importMixxxMapping("<foo/>")).toThrow(/Mixxx/);
  });
});

// Optional: run against a real Mixxx mapping on this machine, e.g.
//   MIXXX_MAPPING=/path/to/Pioneer-DDJ-SB.midi.xml npm test
const realPath = process.env.MIXXX_MAPPING;
describe.skipIf(!realPath || !existsSync(realPath))("real Mixxx mapping", () => {
  it("imports without unexpected failures", () => {
    const { mapping, report } = importMixxxMapping(readFileSync(realPath!, "utf8"), { fileName: realPath });
    console.log(
      `${report.controllerName}: ${report.totalControls} controls → ${report.exact} exact, ${report.heuristic} inferred, ${report.unresolved.length} unresolved; ${mapping.inputs.length} bindings`,
    );
    expect(mapping.inputs.length).toBeGreaterThan(0);
  });
});

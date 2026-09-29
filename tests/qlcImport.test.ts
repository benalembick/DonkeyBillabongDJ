import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandBus } from "../src/core/commands";
import { DJEngine } from "../src/core/engine/DJEngine";
import { EventLog } from "../src/core/log";
import { LightingService } from "../src/lighting/LightingService";
import { LAYER_DESK } from "../src/lighting/DmxEngine";
import { parseQlcDefinition, parseQlcFixtureList, qlcFileKind } from "../src/lighting/qlcImport";
import { FakeAudioEngine } from "./fakes";

const dir = path.join(__dirname, "fixtures", "qlc");
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
const qxfl = read("Universe1-Fixtures.qxfl");
const lm70 = read("Betopper-LM70.qxf");

const LASER_QXF = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE FixtureDefinition>
<FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition">
 <Manufacturer>PES Intelligence Tech</Manufacturer>
 <Model>PES000-RG</Model>
 <Type>Laser</Type>
 <Channel Name="Mode"><Group Byte="0">Effect</Group><Capability Min="0" Max="255">Mode</Capability></Channel>
 <Channel Name="Pattern"><Group Byte="0">Gobo</Group></Channel>
 <Mode Name="9"><Channel Number="0">Mode</Channel><Channel Number="1">Pattern</Channel></Mode>
</FixtureDefinition>`;

function service() {
  const bus = new CommandBus();
  const log = new EventLog();
  const dj = new DJEngine({ bus, audio: new FakeAudioEngine(), log, browser: { moveSelection: () => {}, getSelected: () => null }, loadBytes: async () => new ArrayBuffer(1) });
  return new LightingService({ bus, log, dj, audio: { getAnalysisTap: () => null, getLevels: () => ({ channels: [], master: 0 }) }, bridge: null });
}

describe("QLC+ import", () => {
  it("recognises file kinds", () => {
    expect(qlcFileKind(qxfl)).toBe("fixtureList");
    expect(qlcFileKind(lm70)).toBe("definition");
    expect(qlcFileKind("<html/>")).toBeNull();
  });

  it("reads the user's fixture list: 1-based addresses/universes, modifiers, controllers skipped", () => {
    const l = parseQlcFixtureList(qxfl);
    expect(l.fixtures.map((f) => `${f.name}@${f.universe}:${f.address}+${f.channels}`)).toEqual([
      "Spider Light - LM30A@1:1+13",
      "MP001 #1@1:14+7",
      "MP001 #2@1:21+7",
      "MP001 #3@1:28+7",
      "MP001 #4@1:35+7",
      "Bee Eye Six Arms Small + Laser@1:42+24",
      "Laser - PES000-RG@1:66+9",
      "Mini Gobo Moving head #1@1:75+11",
      "Mini Gobo Moving head #2@1:86+11",
      "Mini Gobo Moving head #3 (!!!HOLD!!)@1:97+11",
    ]);
    expect(l.skipped[0].name).toBe("Launchpad Pro");
    const mh2 = l.fixtures.find((f) => f.name === "Mini Gobo Moving head #2")!;
    expect(mh2.modifiers).toEqual([
      { channel: 0, curve: "invert" },
      { channel: 2, curve: "linear" },
    ]);
    expect(l.fixtures.find((f) => f.name === "Mini Gobo Moving head #1")!.unsupportedModifiers).toHaveLength(2);
  });

  it("maps QLC+ channel presets/groups to functions, with capabilities", () => {
    const d = parseQlcDefinition(lm70, "Betopper-LM70.qxf");
    expect(d.id).toBe("qlc/betopper/lm70");
    const m14 = d.modes.find((m) => m.name === "14 Channel")!;
    expect(m14.channels.map((c) => c.type)).toEqual(["pan", "panFine", "tilt", "tiltFine", "speed", "macro", "red", "green", "blue", "white", "colorWheel", "speed", "macro", "macro"]);
    expect(m14.channels[5].capabilities?.find((c) => c.min === 135)?.name).toMatch(/Strobe/);
    expect(d.laser).toBeUndefined();
    expect(parseQlcDefinition(LASER_QXF).laser).toBe(true);
  });

  it("imports the rig: placeholders stay inert until the definition arrives; lasers excluded from sound and FULL ON", () => {
    const l = service();
    const r = l.importQlc([{ name: "Universe1-Fixtures.qxfl", text: qxfl }], { replaceFixtures: true });
    expect(r.fixtures).toBe(10);
    expect(r.needDefinition).toHaveLength(10);
    expect(r.skipped).toHaveLength(1);
    expect(r.notes.join(" ")).toContain("Exponential Deep");
    const cfg = l.getConfig();
    expect(cfg.fixtures).toHaveLength(10);
    // Unknown channels are never lit by FULL ON (nothing is known about them yet).
    l.deskFullOn(1);
    const out = Array.from(l.engine.compute(1).subarray(0, 107));
    out[85] = 0; // moving head #2 pan is inverted (0 → 255 by design, like QLC+) — checked below
    expect(Math.max(...out)).toBe(0);
    // Inverted pan on moving head #2 (DMX 86): desk 0 → output 255, desk 255 → 0.
    expect(l.engine.compute(1)[85]).toBe(255);
    l.setDesk(1, 86, 255);
    expect(l.engine.compute(1)[85]).toBe(0);
    l.engine.clearLayer(LAYER_DESK);

    // The laser's definition arrives later: it links to the patched fixture and is flagged.
    const r2 = l.importQlc([{ name: "PES000-RG.qxf", text: LASER_QXF }], { replaceFixtures: false });
    expect(r2.definitions[0]).toContain("laser");
    expect(r2.withDefinition.join()).toContain("Laser - PES000-RG");
    const laser = l.getConfig().fixtures.find((f) => f.name === "Laser - PES000-RG")!;
    l.setSound({ enabled: true, fixtures: [laser.id] });
    for (let i = 0; i < 20; i++) l.sound.update(1 / 40);
    expect(Math.max(...l.engine.compute(1).subarray(65, 74))).toBe(0); // sound never drives the laser
  });
});

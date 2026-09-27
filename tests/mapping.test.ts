import { describe, expect, it } from "vitest";
import { actionCatalog } from "../src/core/actions";
import { MappingRuntime, decodeRelative } from "../src/controllers/mapping/MappingRuntime";
import { MAPPING_SCHEMA, describeSelector, type ControllerMapping } from "../src/controllers/mapping/schema";
import { parseMidi } from "../src/controllers/midi/message";
import { buildDdjSbMapping } from "../src/controllers/profiles/pioneer-ddj-sb";

const msg = (...bytes: number[]) => parseMidi(bytes, "dev", "PIONEER DDJ-SB", 0);

describe("MIDI parsing", () => {
  it("classifies messages and 1-based channels", () => {
    expect(msg(0x90, 0x0b, 0x7f)).toMatchObject({ type: "noteon", channel: 1, data1: 0x0b });
    expect(msg(0x91, 0x0b, 0x00)).toMatchObject({ type: "noteoff", channel: 2 });
    expect(msg(0xb6, 0x1f, 0x40)).toMatchObject({ type: "cc", channel: 7 });
  });
  it("decodes relative encodings", () => {
    expect(decodeRelative("relative-offset64", 0x44)).toBe(4);
    expect(decodeRelative("relative-offset64", 0x3e)).toBe(-2);
    expect(decodeRelative("relative-twos-complement", 1)).toBe(1);
    expect(decodeRelative("relative-twos-complement", 127)).toBe(-1);
    expect(decodeRelative("relative-signed-bit", 65)).toBe(-1);
  });
});

function runtimeFor(mapping: ControllerMapping) {
  const dispatched: [string, number][] = [];
  const sent: number[][] = [];
  const feedback: Record<string, number> = {};
  const rt = new MappingRuntime(mapping, (a, v) => dispatched.push([a, v]), (b) => sent.push(b), (k) => feedback[k] ?? 0);
  return { rt, dispatched, sent, feedback };
}

describe("MappingRuntime with the DDJ-SB mapping", () => {
  it("PLAY A press/release", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0x90, 0x0b, 0x7f));
    rt.handle(msg(0x90, 0x0b, 0x00));
    expect(dispatched).toEqual([["deck1.play", 1], ["deck1.play", 0]]);
  });

  it("14-bit tempo slider dispatches on LSB with full resolution", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0xb1, 0x00, 0x40)); // MSB deck B
    expect(dispatched).toHaveLength(0);
    rt.handle(msg(0xb1, 0x20, 0x00)); // LSB
    expect(dispatched[0][0]).toBe("deck2.tempo");
    expect(dispatched[0][1]).toBeCloseTo(0x2000 / 16383, 5);
  });

  it("jog wheel relative ticks", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0xb0, 0x21, 0x44));
    rt.handle(msg(0xb0, 0x22, 0x3c));
    expect(dispatched).toEqual([["deck1.jog.ring", 4], ["deck1.jog.platter", -4]]);
  });

  it("browse encoder is two's complement", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0xb6, 0x40, 0x7f));
    expect(dispatched).toEqual([["browser.scroll", -1]]);
  });

  it("SHIFT + FILTER becomes gain (modifier layer)", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0xb6, 0x17, 0x7f));
    rt.handle(msg(0xb6, 0x37, 0x7f));
    rt.handle(msg(0x90, 0x3f, 0x7f)); // shift down
    rt.handle(msg(0xb6, 0x17, 0x00));
    rt.handle(msg(0xb6, 0x37, 0x00));
    rt.handle(msg(0x90, 0x3f, 0x00)); // shift up
    expect(dispatched.map((d) => d[0])).toEqual(["mixer.channel1.filter", "mixer.channel1.gain"]);
  });

  it("pads: hot cue, alternate bank and clear", () => {
    const { rt, dispatched } = runtimeFor(buildDdjSbMapping());
    rt.handle(msg(0x97, 0x02, 0x7f));
    rt.handle(msg(0x98, 0x41, 0x7f));
    rt.handle(msg(0x97, 0x08, 0x7f));
    expect(dispatched).toEqual([["deck1.hotcue.3", 1], ["deck2.hotcue.6", 1], ["deck1.hotcue.1.clear", 1]]);
  });

  it("sends LED changes only when state changes", () => {
    const { rt, sent, feedback } = runtimeFor(buildDdjSbMapping());
    rt.refreshOutputs(true);
    const initial = sent.length;
    expect(initial).toBe(buildDdjSbMapping().outputs.length);
    rt.refreshOutputs();
    expect(sent.length).toBe(initial);
    feedback["deck1.playing"] = 1;
    rt.refreshOutputs();
    expect(sent.slice(initial)).toEqual([[0x90, 0x0b, 0x7f], [0x90, 0x47, 0x7f]]);
  });
});

describe("DDJ-SB mapping integrity", () => {
  const m = buildDdjSbMapping();
  const catalog = actionCatalog();

  it("uses the normalised schema and matches DDJ-SB but not SB2/SB3", () => {
    expect(m.schema).toBe(MAPPING_SCHEMA);
    const re = new RegExp(m.match.portNamePatterns[0], "i");
    expect(re.test("PIONEER DDJ-SB")).toBe(true);
    expect(re.test("2- PIONEER DDJ-SB")).toBe(true);
    expect(re.test("PIONEER DDJ-SB2")).toBe(false);
    expect(re.test("DDJ-SB3")).toBe(false);
  });

  it("every action exists in the catalogue", () => {
    for (const b of m.inputs) expect(catalog.has(b.action) || b.action === "modifier.shift", b.action).toBe(true);
  });

  it("every binding references a declared physical control", () => {
    const ids = new Set(m.controls.map((c) => c.id));
    for (const b of m.inputs) expect(ids.has(b.control), b.control).toBe(true);
    for (const o of m.outputs) expect(!o.control || ids.has(o.control), o.control).toBe(true);
  });

  it("no MIDI message is bound to two different actions in the same layer", () => {
    const seen = new Map<string, string>();
    for (const b of m.inputs) {
      const k = `${describeSelector(b.midi)}|${b.modifier ?? ""}`;
      const prev = seen.get(k);
      if (prev) expect(prev, k).toBe(b.action);
      seen.set(k, b.action);
    }
  });

  it("LED addresses are unique", () => {
    const addrs = m.outputs.map((o) => `${o.midi.type}:${o.midi.channel}:${o.midi.number}`);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it("covers the Phase 1 hardware spike controls", () => {
    const actions = new Set(m.inputs.map((b) => b.action));
    for (const a of ["deck1.play", "deck1.cue", "deck1.jog.platter", "deck1.jog.ring", "deck1.jog.touch", "deck1.tempo", "mixer.channel1.volume", "mixer.crossfader", "deck2.play", "deck2.tempo", "browser.load.deck1", "browser.scroll"]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});

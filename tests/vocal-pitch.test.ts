import { describe, expect, it } from "vitest";
import { correctionCurve, correctedPitch, noteTarget, PITCH_PRESETS } from "../src/production/vocal/pitchCorrect";
import { hzToMidi, midiToHz, segmentNotes, trackPitch, type PitchTrack, type VocalNote } from "../src/production/vocal/pitchTrack";
import { activeRms, psolaShift } from "../src/production/vocal/psola";
import { chromaFromAudio, chromaFromNotes, detectKey, keyFit, nearestInScale, scaleMask } from "../src/production/vocal/scales";

const RATE = 48_000;
/** A "sung" phrase: harmonic voice-like tones (pitch in MIDI, optional vibrato / drift), 40 ms gaps. */
function sing(notes: { midi: number; dur: number; vibratoCents?: number; driftCents?: number }[]): { data: Float32Array; starts: number[] } {
  const total = notes.reduce((s, n) => s + n.dur + .04, 0); const data = new Float32Array(Math.ceil(total * RATE)); const starts: number[] = []; let at = 0;
  for (const n of notes) {
    starts.push(at); let phase = 0; const len = Math.round(n.dur * RATE);
    for (let i = 0; i < len; i++) {
      const t = i / RATE; const cents = (n.vibratoCents ?? 0) * Math.sin(2 * Math.PI * 5.5 * t) + (n.driftCents ?? 0) * (t / n.dur - .5);
      phase += 2 * Math.PI * midiToHz(n.midi + cents / 100) / RATE; const env = Math.min(1, i / 480, (len - i) / 480);
      data[Math.round(at * RATE) + i] = env * .3 * (Math.sin(phase) + .6 * Math.sin(2 * phase) + .35 * Math.sin(3 * phase) + .2 * Math.sin(4 * phase));
    }
    at += n.dur + .04;
  }
  return { data, starts };
}
const medianIn = (track: PitchTrack, a: number, b: number) => { const v: number[] = []; for (let i = Math.ceil(a / track.hop); i < Math.floor(b / track.hop); i++) if (track.f0[i]) v.push(track.f0[i]); v.sort((x, y) => x - y); return v[v.length >> 1]; };

describe("scales and keys", () => {
  it("builds scale masks and snaps to the nearest scale note", () => {
    const cMajor = scaleMask(0, "major"); expect(cMajor.filter(Boolean)).toHaveLength(7); expect(cMajor[1]).toBe(false);
    expect(nearestInScale(60.4, cMajor)).toBe(60); expect(nearestInScale(61.2, cMajor)).toBe(62); expect(nearestInScale(61.6, cMajor)).toBe(62); expect(nearestInScale(63.5, scaleMask(9, "minor"))).toBe(64);
    expect(scaleMask(2, "custom", [true, false, false, false, false, false, false, true]).filter(Boolean)).toHaveLength(2);
  });
  it("detects the key from notes and from audio", () => {
    const aMinor = [57, 59, 60, 62, 64, 65, 67, 69, 72, 69, 64, 57, 60, 64].map((pitch) => ({ pitch, duration: 1 })); aMinor.push({ pitch: 57, duration: 4 }, { pitch: 64, duration: 2 });
    expect(detectKey(chromaFromNotes(aMinor))).toMatchObject({ root: 9, scale: "minor" });
    const { data } = sing([60, 64, 67, 72, 67, 64, 60, 65, 69, 67, 60].map((midi) => ({ midi, dur: .35 })));
    expect(detectKey(chromaFromAudio(data, RATE))).toMatchObject({ root: 0, scale: "major" });
    expect(keyFit(aMinor, scaleMask(9, "minor"))).toBe(1);
  });
});

describe("pitch tracking and notes", () => {
  it("tracks a sung phrase within a few cents and finds the notes", async () => {
    const plan = [{ midi: 57, dur: .5 }, { midi: 60.3, dur: .4 }, { midi: 64, dur: .6, vibratoCents: 40 }, { midi: 62, dur: .3 }]; const { data, starts } = sing(plan);
    const track = await trackPitch(data, RATE); const notes = segmentNotes(track);
    expect(notes).toHaveLength(4);
    // steady notes within 6 cents; the vibrato note's median within 12 cents (partial vibrato cycles bias the median)
    notes.forEach((n, i) => { expect(Math.abs(n.detected - plan[i].midi)).toBeLessThan(plan[i].vibratoCents ? .12 : .06); expect(Math.abs(n.start - starts[i])).toBeLessThan(.03); });
    expect(notes[2].vibrato?.rateHz).toBeGreaterThan(4.5); expect(notes[2].vibrato?.depthCents).toBeGreaterThan(25);
  });
  it("measures drift in a sagging note", async () => {
    const { data } = sing([{ midi: 60, dur: 1, driftCents: -60 }]); const notes = segmentNotes(await trackPitch(data, RATE));
    expect(notes).toHaveLength(1); expect(notes[0].driftCents).toBeLessThan(-40);
  });
});

describe("correction + TD-PSOLA", () => {
  const cMajor = scaleMask(0, "major");
  const run = async (plan: Parameters<typeof sing>[0], params = PITCH_PRESETS.hard.params, edit?: (n: VocalNote[]) => void) => {
    const { data } = sing(plan); const track = await trackPitch(data, RATE); const notes = segmentNotes(track); edit?.(notes);
    const cents = correctionCurve(track, notes, cMajor, params); const out = psolaShift(data, RATE, track, cents); const after = await trackPitch(out, RATE);
    return { data, out, notes, track, after, cents };
  };
  it("hard tune pulls flat and sharp notes onto the scale (±5 cents)", async () => {
    const { notes, after, data, out } = await run([{ midi: 59.65, dur: .6 }, { midi: 64.35, dur: .6 }, { midi: 66.7, dur: .6 }]); // B −35¢, E +35¢, G −30¢
    const targets = notes.map((n) => noteTarget(n, cMajor)); expect(targets).toEqual([60, 64, 67]);
    notes.forEach((n, i) => expect(Math.abs(medianIn(after, n.start + .1, n.end - .1) - targets[i]!) * 100).toBeLessThan(5));
    expect(Math.abs(activeRms(out) / activeRms(data) - 1)).toBeLessThan(.12); // level kept
    expect(out.length).toBe(data.length); // timing kept
  });
  it("strength scales the move; bypass and manual targets are respected", async () => {
    const half = await run([{ midi: 59.6, dur: .7 }], { ...PITCH_PRESETS.hard.params, strength: .5 });
    expect(Math.abs(medianIn(half.after, .15, .6) - 59.8) * 100).toBeLessThan(6);
    const manual = await run([{ midi: 59.6, dur: .7 }, { midi: 64.3, dur: .7 }], PITCH_PRESETS.hard.params, (n) => { n[0].target = 62; n[1].bypass = true; });
    expect(Math.abs(medianIn(manual.after, .15, .6) - 62) * 100).toBeLessThan(6);
    expect(Math.abs(medianIn(manual.after, manual.notes[1].start + .1, manual.notes[1].end - .1) - 64.3) * 100).toBeLessThan(6);
  });
  it("preserve expression keeps vibrato; hard tune removes it", async () => {
    const depth = (track: PitchTrack, a: number, b: number) => { const v: number[] = []; for (let i = Math.ceil(a / track.hop); i < Math.floor(b / track.hop); i++) if (track.f0[i]) v.push(track.f0[i]); const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) * 100 * Math.SQRT2; };
    const plan = [{ midi: 64.3, dur: 1.2, vibratoCents: 50 }];
    const natural = await run(plan, { ...PITCH_PRESETS.natural.params, strength: 1, humanize: 0 }); const hard = await run(plan);
    expect(depth(natural.after, .2, 1)).toBeGreaterThan(30); expect(depth(hard.after, .2, 1)).toBeLessThan(15);
    expect(Math.abs(medianIn(natural.after, .2, 1) - 64) * 100).toBeLessThan(8);
  });
  it("retune speed: hard tune reaches the target within 20 ms, natural takes longer", async () => {
    const plan = [{ midi: 59.5, dur: .8 }]; const hard = await run(plan); const slow = await run(plan, { ...PITCH_PRESETS.hard.params, retuneMs: 200 });
    const reach = (r: Awaited<ReturnType<typeof run>>) => { const pitch = correctedPitch(r.track, r.cents); const start = Math.ceil(r.notes[0].start / r.track.hop); for (let i = start; i < pitch.length; i++) if (Math.abs(pitch[i] - 60) < .1) return (i - start) * r.track.hop; return Infinity; };
    expect(reach(hard)).toBeLessThan(.02); expect(reach(slow)).toBeGreaterThan(.2);
  });
  it("formant preserve off resamples grains (still lands on pitch)", async () => {
    const { data } = sing([{ midi: 60.4, dur: .7 }]); const track = await trackPitch(data, RATE); const notes = segmentNotes(track);
    const out = psolaShift(data, RATE, track, correctionCurve(track, notes, cMajor, PITCH_PRESETS.hard.params), { formant: false }); const after = await trackPitch(out, RATE);
    expect(Math.abs(medianIn(after, .15, .6) - 60) * 100).toBeLessThan(6);
  });
  it("hz/midi helpers", () => { expect(hzToMidi(440)).toBe(69); expect(midiToHz(60)).toBeCloseTo(261.63, 1); });
});

describe("bypass", () => {
  it("a bypassed note right after a corrected one is not dragged by the previous correction", async () => {
    const { data } = sing([{ midi: 59.6, dur: .5 }, { midi: 64.35, dur: .5 }]); const track = await trackPitch(data, RATE); const notes = segmentNotes(track); notes[1].bypass = true;
    const cents = correctionCurve(track, notes, scaleMask(0, "major"), PITCH_PRESETS.hard.params);
    const i = Math.ceil((notes[1].start + .02) / track.hop); expect(Math.abs(cents[i])).toBeLessThan(1);
  });
});

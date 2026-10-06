/**
 * Teach Me: Live Looping — pads and backing sounds. Everything is synthesised at runtime with plain Web Audio
 * (oscillators and noise), the same technique LiveLooper already uses for its metronome click — nothing is
 * downloaded or bundled as a file, so there is no license to track and the lesson works fully offline once the
 * page has loaded. `SOUND_MANIFEST` documents each sound's role and musical metadata as the spec asks for, even
 * though "source" is "generated" rather than a shipped asset.
 */
export type PadId = "kick" | "snare" | "bass" | "chime";
export interface PadDef { id: PadId; label: string; key: string; role: string; durationS: number; note?: { midi: number; name: string } }
export const PADS: PadDef[] = [
  { id: "kick", label: "KICK", key: "A", role: "low drum", durationS: .35 },
  { id: "snare", label: "SNARE", key: "S", role: "mid/high drum", durationS: .2 },
  { id: "bass", label: "BASS", key: "D", role: "bass note", durationS: .5, note: { midi: 33, name: "A1" } },
  { id: "chime", label: "CHIME", key: "F", role: "melodic chime", durationS: .9, note: { midi: 81, name: "A5" } },
];
/** Module 2 (Layering & Frequency Management): the suggested add-order, each tagged with where it mostly sits in the spectrum. */
export type LayerRole = "drums" | "bass" | "melody" | "vocalPerc";
export interface LayerDef { role: LayerRole; label: string; frequencyProfile: "sub" | "low" | "mid" | "high"; note: string }
export const LAYERS: LayerDef[] = [
  { role: "drums", label: "Drums", frequencyProfile: "low", note: "kick + snare — foundation, always on" },
  { role: "bass", label: "Bass", frequencyProfile: "sub", note: "deliberately shares the kick's range — the clash this module teaches you to hear and fix" },
  { role: "melody", label: "Melody", frequencyProfile: "mid", note: "a higher register synth line — out of the bass/kick's way by design" },
  { role: "vocalPerc", label: "Vocal/Percussion", frequencyProfile: "high", note: "short vocal-ish percussive chops — top end, rarely competes down low" },
];

export interface SoundManifestEntry { id: string; role: string; source: "generated"; license: string; bpm: number | null; key: string | null; durationS: number | null; loopPoints: { start: number; end: number } | null }
export const SOUND_MANIFEST: SoundManifestEntry[] = [
  ...PADS.map((p): SoundManifestEntry => ({ id: p.id, role: p.role, source: "generated", license: "Original — synthesised at runtime (Web Audio oscillators/noise); no external asset, no license required.", bpm: null, key: p.note?.name ?? null, durationS: p.durationS, loopPoints: null })),
  { id: "ghost-drums", role: "protected backing — one-bar kick/snare pattern", source: "generated", license: "Original — synthesised at runtime.", bpm: null, key: null, durationS: null, loopPoints: { start: 0, end: 1 } },
  { id: "ghost-synth", role: "compatible synth phrase for Progressive Sandbox Level 1", source: "generated", license: "Original — synthesised at runtime.", bpm: null, key: "A minor", durationS: null, loopPoints: { start: 0, end: 1 } },
  ...LAYERS.map((l): SoundManifestEntry => ({ id: `layer-${l.role}`, role: `Module 2 layer — ${l.note}`, source: "generated", license: "Original — synthesised at runtime.", bpm: null, key: l.role === "bass" ? "A minor" : l.role === "melody" ? "A minor (higher register)" : null, durationS: null, loopPoints: { start: 0, end: 1 } })),
];

export const midiToFrequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

function render(sampleRate: number, durationS: number, build: (ctx: OfflineAudioContext) => void): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(durationS * sampleRate)), sampleRate);
  build(ctx);
  return ctx.startRendering();
}
function noiseBurst(ctx: OfflineAudioContext, sampleRate: number, t: number, lengthS: number, peak: number): void {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(lengthS * sampleRate)), sampleRate);
  const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 900;
  const g = ctx.createGain(); g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(.001, t + lengthS);
  src.connect(hp).connect(g).connect(ctx.destination); src.start(t); src.stop(t + lengthS);
}
function kickHit(ctx: OfflineAudioContext, t: number, lengthS: number, peak: number): void {
  const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.type = "sine";
  osc.frequency.setValueAtTime(150, t); osc.frequency.exponentialRampToValueAtTime(45, t + .12);
  g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(.001, t + lengthS);
  osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + lengthS);
}

/** One-shot pad sound (kick/snare/bass/chime). */
export async function synthesizePad(sampleRate: number, id: PadId): Promise<AudioBuffer> {
  const def = PADS.find((p) => p.id === id)!;
  return render(sampleRate, def.durationS, (ctx) => {
    if (id === "kick") kickHit(ctx, 0, def.durationS, .9);
    else if (id === "snare") noiseBurst(ctx, sampleRate, 0, def.durationS, .7);
    else if (id === "bass") {
      const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.type = "triangle"; osc.frequency.value = midiToFrequency(def.note!.midi);
      g.gain.setValueAtTime(.0001, 0); g.gain.linearRampToValueAtTime(.8, .01); g.gain.exponentialRampToValueAtTime(.001, def.durationS);
      osc.connect(g).connect(ctx.destination); osc.start(0); osc.stop(def.durationS);
    } else { // chime: a few harmonics of the fundamental, fast attack, slow decay
      const freq = midiToFrequency(def.note!.midi); const g = ctx.createGain();
      g.gain.setValueAtTime(.0001, 0); g.gain.linearRampToValueAtTime(.5, .01); g.gain.exponentialRampToValueAtTime(.001, def.durationS);
      g.connect(ctx.destination);
      [1, 2.76, 5.4].forEach((ratio, i) => { const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = freq * ratio; const og = ctx.createGain(); og.gain.value = i === 0 ? 1 : .3 / ratio; osc.connect(og).connect(g); osc.start(0); osc.stop(def.durationS); });
    }
  });
}

/** The protected ghost backing loop: one bar of kick-on-1-and-3, snare-on-2-and-4 at the lesson's BPM. */
export async function synthesizeGhostDrums(sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  const beat = 60 / bpm; const duration = beat * beatsPerBar;
  return render(sampleRate, duration, (ctx) => {
    for (let b = 0; b < beatsPerBar; b++) { const t = b * beat; if (b % 2 === 0) kickHit(ctx, t, .3, .9); else noiseBurst(ctx, sampleRate, t, .18, .7); }
  });
}

/** A short A-minor arpeggio (A2–C3–E3–A3), one bar at the lesson's BPM — the compatible synth phrase for Sandbox Level 1. */
export async function synthesizeGhostSynth(sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  const beat = 60 / bpm; const notes = [45, 48, 52, 57];
  return render(sampleRate, beat * beatsPerBar, (ctx) => {
    notes.forEach((midi, i) => { const t = i * beat; const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.type = "triangle"; osc.frequency.value = midiToFrequency(midi);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.5, t + .02); g.gain.exponentialRampToValueAtTime(.001, t + beat * .9);
      osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + beat); });
  });
}

/** Module 2's bass layer: root notes on 1 and 3 (A1/A1), deliberately in the kick's own range — the clash to hear and fix. */
export async function synthesizeBassLayer(sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  const beat = 60 / bpm; const duration = beat * beatsPerBar; const freq = midiToFrequency(33); // A1, ~55 Hz — shares the kick's fundamental range
  return render(sampleRate, duration, (ctx) => {
    for (let b = 0; b < beatsPerBar; b += 2) { const t = b * beat; const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.type = "triangle"; osc.frequency.value = freq;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.85, t + .015); g.gain.exponentialRampToValueAtTime(.001, t + beat * 1.8);
      osc.connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + beat * 1.9); }
  });
}
/** Module 2's melody layer: a higher-register (4th/5th octave) arpeggio — out of the bass/kick's way by design. */
export async function synthesizeMelodyLayer(sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  const beat = 60 / bpm; const notes = [69, 72, 76, 79]; // A4 C5 E5 G5
  return render(sampleRate, beat * beatsPerBar, (ctx) => {
    notes.forEach((midi, i) => { const t = i * beat; const osc = ctx.createOscillator(); const g = ctx.createGain(); osc.type = "sawtooth"; osc.frequency.value = midiToFrequency(midi);
      const lpf = ctx.createBiquadFilter(); lpf.type = "lowpass"; lpf.frequency.value = 3200;
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.35, t + .02); g.gain.exponentialRampToValueAtTime(.001, t + beat * .85);
      osc.connect(lpf).connect(g).connect(ctx.destination); osc.start(t); osc.stop(t + beat); });
  });
}
/** Module 2's vocal/percussion layer: short bandpassed noise chops on the off-beats — top end, rarely competes down low. */
export async function synthesizeVocalPercLayer(sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  const beat = 60 / bpm; const duration = beat * beatsPerBar; const hits = [.5, 1.5, 2.75, 3.5];
  return render(sampleRate, duration, (ctx) => {
    for (const h of hits) { const t = h * beat; const len = .12;
      const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(len * sampleRate)), sampleRate); const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buffer;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 1.4;
      const g = ctx.createGain(); g.gain.setValueAtTime(.5, t); g.gain.exponentialRampToValueAtTime(.001, t + len);
      src.connect(bp).connect(g).connect(ctx.destination); src.start(t); src.stop(t + len); }
  });
}
export function synthesizeLayer(role: LayerRole, sampleRate: number, bpm: number, beatsPerBar = 4): Promise<AudioBuffer> {
  if (role === "drums") return synthesizeGhostDrums(sampleRate, bpm, beatsPerBar);
  if (role === "bass") return synthesizeBassLayer(sampleRate, bpm, beatsPerBar);
  if (role === "melody") return synthesizeMelodyLayer(sampleRate, bpm, beatsPerBar);
  return synthesizeVocalPercLayer(sampleRate, bpm, beatsPerBar);
}

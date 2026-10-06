import type { SynthSettings } from "./types";

/** Built-in sounds for the subtractive synth (Production Browser → PRESETS). */
export interface SynthPreset { name: string; description: string; synth: SynthSettings }

export const SYNTH_PRESETS: SynthPreset[] = [
  { name: "Sub Bass", description: "Clean sine low end", synth: { oscillator: "sine", attack: .005, decay: .2, sustain: .9, release: .12, cutoff: 900, resonance: .5, detune: 0, glide: 0, volume: .85 } },
  { name: "Acid Bass", description: "Squelchy resonant saw", synth: { oscillator: "sawtooth", attack: .003, decay: .18, sustain: .35, release: .08, cutoff: 1400, resonance: 9, detune: 0, glide: .06, volume: .7 } },
  { name: "Reese Bass", description: "Detuned saw, dark", synth: { oscillator: "sawtooth", attack: .01, decay: .3, sustain: .8, release: .2, cutoff: 1800, resonance: 1.5, detune: 18, glide: 0, volume: .65 } },
  { name: "Soft Pad", description: "Slow attack, wide release", synth: { oscillator: "sawtooth", attack: .6, decay: .8, sustain: .8, release: 1.2, cutoff: 2600, resonance: .7, detune: 9, glide: 0, volume: .55 } },
  { name: "Pluck", description: "Short bright pluck", synth: { oscillator: "triangle", attack: .002, decay: .22, sustain: 0, release: .15, cutoff: 5200, resonance: 1.2, detune: 0, glide: 0, volume: .75 } },
  { name: "Lead", description: "Square lead with a little glide", synth: { oscillator: "square", attack: .01, decay: .1, sustain: .75, release: .2, cutoff: 7000, resonance: 2, detune: 6, glide: .03, volume: .6 } },
  { name: "Keys", description: "Soft electric-piano style", synth: { oscillator: "triangle", attack: .005, decay: .45, sustain: .4, release: .35, cutoff: 4200, resonance: .8, detune: 3, glide: 0, volume: .65 } },
  { name: "Chip Arp", description: "8-bit style square stab", synth: { oscillator: "square", attack: .001, decay: .08, sustain: .3, release: .05, cutoff: 12000, resonance: .5, detune: 0, glide: 0, volume: .5 } },
];

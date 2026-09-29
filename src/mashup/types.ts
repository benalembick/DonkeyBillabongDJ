export interface MashupBlock {
  id: string; startBar: number; bars: 8 | 16 | 32;
  aSelected: boolean[]; bSelected: boolean[]; aLevels: number[]; bLevels: number[];
}
export interface ManualMashupSetup {
  decks: { rate: number; tempoRange: number; keylock: boolean; vinyl: boolean; sync: boolean; stems: { enabled: boolean; muted: boolean[]; volume: number[] } }[];
  channels: { gain: number; eqHigh: number; eqMid: number; eqLow: number; killHigh: boolean; killMid: boolean; killLow: boolean; filter: number; volume: number; pfl: boolean; mute: boolean }[];
  mixer: { crossfader: number; masterLevel: number; headMix: number; headLevel: number };
  fx: { target: "deck" | "vocals" | "drums" | "bass" | "instruments"; slots: { type: "echo" | "delay" | "reverb" | "flanger" | "phaser" | "filter" | "bitcrusher" | "distortion" | "gate" | "roll"; on: boolean; param: number }[]; mix: number; beats: number; decks: boolean[] }[];
  masterDeck: number | null;
}
export interface MashupRecipe {
  version: 2; id: string; name: string; createdAt: number; updatedAt: number;
  aRef: string; bRef: string; aEntry: number; bEntry: number;
  aSelected: boolean[]; bSelected: boolean[]; aLevels: number[]; bLevels: number[];
  targetBpm: number | null; targetKey: string | null; phraseBars: 8 | 16 | 32;
  vocalSemitones: number; blocks: MashupBlock[];
  /** Present when this is a snapshot of the main two-deck performance view. */
  manual?: ManualMashupSetup;
}
export interface MashupPersistence { list(): Promise<MashupRecipe[]>; save(recipe: MashupRecipe): Promise<void>; remove(id: string): Promise<void> }

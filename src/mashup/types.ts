export interface MashupBlock {
  id: string; startBar: number; bars: 8 | 16 | 32;
  aSelected: boolean[]; bSelected: boolean[]; aLevels: number[]; bLevels: number[];
}
export interface MashupRecipe {
  version: 2; id: string; name: string; createdAt: number; updatedAt: number;
  aRef: string; bRef: string; aEntry: number; bEntry: number;
  aSelected: boolean[]; bSelected: boolean[]; aLevels: number[]; bLevels: number[];
  targetBpm: number | null; targetKey: string | null; phraseBars: 8 | 16 | 32;
  vocalSemitones: number; blocks: MashupBlock[];
}
export interface MashupPersistence { list(): Promise<MashupRecipe[]>; save(recipe: MashupRecipe): Promise<void>; remove(id: string): Promise<void> }

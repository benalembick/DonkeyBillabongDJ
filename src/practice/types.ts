export type PracticeDifficulty = "beginner" | "intermediate" | "advanced" | "custom";
export interface PracticeAssists { showBpm: boolean; showKey: boolean; showBeatgrid: boolean; allowSync: boolean }
export interface PracticeEvent { at: number; kind: string; label: string; detail?: string }
export interface PracticeScores { overall: number; beatMatching: number; timing: number; transition: number; eqBalance: number; phraseAlignment: number; harmonicCompatibility: number; gainControl: number; trackSelection: number }
export interface PracticeResult { id: string; date: number; trackARef: string; trackATitle: string; trackBRef: string; trackBTitle: string; scores: PracticeScores; events: PracticeEvent[]; strengths: string[]; improvements: string[]; helpPenalty?: number }
export interface PracticeSample { at: number; posA: number; posB: number; bpmA: number | null; bpmB: number | null; phaseMs: number | null; volumeA: number; volumeB: number; crossfader: number; eqLowA: number; eqLowB: number; filterA: number; filterB: number; clipping: boolean }

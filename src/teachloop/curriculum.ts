/**
 * Teach Me: Live Looping — curriculum data (pure, no engine access). Modules 1 and 2 (and Module 1's two standalone
 * companion activities) are built; modules 3–5 are "planned" cards shown locked, with no active lesson controls.
 * Full later-phase design: docs/TEACH-ME-LIVE-LOOPING.md.
 */
export type ActivityId = "perfect-loop" | "fix-my-timing" | "sandbox-1" | "layering" | "dead-space-mic" | "song-structure" | "advanced-practice";
export interface Activity { id: ActivityId; title: string; summary: string; minutes: number; kind: "module" | "exercise" | "sandbox"; planned?: boolean; prerequisites?: ActivityId[] }

export const ACTIVITIES: Activity[] = [
  { id: "perfect-loop", kind: "module", title: "Module 1 — The Perfect Loop", summary: "Begin and end a loop exactly on the beat: beat-one taps, then a full loop capture.", minutes: 6 },
  { id: "fix-my-timing", kind: "exercise", title: "Fix My Timing", summary: "Hear a misaligned loop, inspect the boundary, and correct it.", minutes: 3, prerequisites: ["perfect-loop"] },
  { id: "sandbox-1", kind: "sandbox", title: "Progressive Sandbox · Level 1", summary: "Record pad layers over a protected drum backing loop — overdub, undo, mute, retry.", minutes: 5, prerequisites: ["perfect-loop"] },
  { id: "layering", kind: "module", title: "Module 2 — Layering & Frequency Management", summary: "Add bass, melody and vocal/percussion layers in order, hear which ones compete for the same low end, and fix it.", minutes: 10, prerequisites: ["perfect-loop"] },
  { id: "dead-space-mic", kind: "module", title: "Module 3 — Dead Space & Microphone Progression", summary: "Keep the performance flowing while building your first layer, then move to a real microphone.", minutes: 12, planned: true },
  { id: "song-structure", kind: "module", title: "Module 4 — Song Structure & Performance", summary: "Verse, chorus and outro: arranging sections live with quantised transitions.", minutes: 15, planned: true },
  { id: "advanced-practice", kind: "module", title: "Module 5 — Advanced Practice", summary: "Adaptive difficulty, alternative tempos/meters, external clock and hands-free control.", minutes: 15, planned: true },
];
export const activity = (id: ActivityId): Activity | undefined => ACTIVITIES.find((a) => a.id === id);

export const DEFAULT_BPM = 90;
export const DEFAULT_BEATS_PER_BAR = 4;
/** Module 1 starts with a one-bar loop, then introduces this four-bar challenge for Drill B. */
export const CHALLENGE_BARS = 4;
export const BEAT_ONE_ATTEMPTS = 4;

export type TeachLoopMode = "strict" | "sandbox";

export const MILESTONES = {
  foundDownbeat: "Found the Downbeat",
  firstLoop: "Completed My First Loop",
  fixedBoundary: "Fixed a Loop Boundary",
  firstLayer: "Built My First Layer",
  balancedLowEnd: "Balanced the Low End",
} as const;
export type MilestoneId = keyof typeof MILESTONES;

/**
 * Prepared transitions (Transition Lab + Auto DJ), pure. Phase 2 — docs/architecture/AI_SET_STUDIO.md §6–7.
 *
 * One transition = when each track plays (mix-out on the outgoing track, mix-in on the incoming one),
 * how long the overlap lasts, how tempo is matched, and automation lanes over the overlap
 * (t = 0..1): crossfader (0 = all outgoing, 1 = all incoming) and per-deck low/mid/high EQ *cuts*
 * in dB (0 … −30). Cuts are applied through DJEngine.setAutoEq — the same cut-only, manually
 * overridable, smoothly decaying path Auto EQ already uses — so preview and Auto DJ play it identically.
 */
import { autoEqCurve, DEFAULT_AUTO_EQ } from "../autodj/autoEq";
import { matchTempo } from "../transitions/planner";

export type SyncMode = "off" | "beat" | "beat-phrase" | "manual";
export type EqMode = "off" | "automatic" | "manual" | "preset";
export interface AutomationPoint { t: number; v: number }
export interface EqLanes { low: AutomationPoint[]; mid: AutomationPoint[]; high: AutomationPoint[] }
export type Band = keyof EqLanes;
export interface EchoOut { start: number; end: number; level: number }

/** Deepest EQ cut a lane can ask for (matches the engine's kill depth used by Auto EQ lows). */
export const MAX_CUT_DB = -30;

export interface TransitionConfig {
  presetId: string;
  /** Outgoing track position (s) where the overlap starts. */
  mixOut: number;
  /** Incoming track position (s) it starts from. */
  mixIn: number;
  /** Overlap length in bars of the outgoing track (null when no reliable grid) and in wall-clock seconds. */
  bars: number | null;
  seconds: number;
  syncMode: SyncMode;
  /** Manual mode: tempo both decks play at during the transition. */
  targetBpm: number | null;
  keyLock: boolean;
  phraseAlign: boolean;
  /** Largest incoming tempo change (%) allowed before beat sync is refused. */
  maxTempoPct: number;
  eqMode: EqMode;
  crossfader: AutomationPoint[];
  eq: { out: EqLanes; in: EqLanes };
  effects: { echoOut?: EchoOut };
}

export interface PreparedTransition extends TransitionConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  setId: string | null;
  fromSlotId: string | null;
  toSlotId: string | null;
  outgoingTrackId: string;
  incomingTrackId: string;
  outRef: string;
  inRef: string;
  outTitle: string;
  inTitle: string;
  notes: string;
  version: number;
  /** Previous saved versions (newest first, at most 10). */
  history: { version: number; savedAt: number; config: TransitionConfig }[];
  analysisVersion: { out: number | null; in: number | null };
  createdAt: number;
  updatedAt: number;
}

export interface TransitionPreset { id: string; name: string; description: string; isSystemPreset: boolean; config: Partial<TransitionConfig> & { bars: number }; requires?: string; createdAt: number; updatedAt: number }

// ── Automation ──────────────────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Value of a lane at t (0..1): smoothstep between points (no corners → no zipper steps), flat outside. */
export function laneAt(points: AutomationPoint[], t: number, fallback = 0): number {
  if (!points.length) return fallback;
  const p = [...points].sort((a, b) => a.t - b.t), x = clamp(t, 0, 1);
  if (x <= p[0].t) return p[0].v;
  if (x >= p[p.length - 1].t) return p[p.length - 1].v;
  let i = 0; while (i < p.length - 2 && x > p[i + 1].t) i++;
  const a = p[i], b = p[i + 1], u = b.t > a.t ? (x - a.t) / (b.t - a.t) : 1;
  return a.v + (b.v - a.v) * smooth(u);
}
export const flat = (v = 0): AutomationPoint[] => [{ t: 0, v }, { t: 1, v }];
export const neutralLanes = (): EqLanes => ({ low: flat(), mid: flat(), high: flat() });
const pts = (...xy: number[]) => { const o: AutomationPoint[] = []; for (let i = 0; i < xy.length; i += 2) o.push({ t: xy[i], v: xy[i + 1] }); return o; };

/** Lanes sampled from the existing Auto EQ maths (autodj/autoEq.ts) — "Automatic" EQ mode. */
export function automaticLanes(): { out: EqLanes; in: EqLanes } {
  const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1], d = 10, swap = 5;
  const lane = (role: "in" | "out", band: "lowDb" | "midDb" | "highDb") => steps.map((t) => ({ t, v: Math.round(autoEqCurve(role, t * d, d, swap, { ...DEFAULT_AUTO_EQ, enabled: true })[band] * 10) / 10 }));
  return { out: { low: lane("out", "lowDb"), mid: lane("out", "midDb"), high: lane("out", "highDb") }, in: { low: lane("in", "lowDb"), mid: lane("in", "midDb"), high: lane("in", "highDb") } };
}

export interface Frame { crossfader: number; out: { low: number; mid: number; high: number }; in: { low: number; mid: number; high: number }; echo: number }
/** The single source of truth for what the mixer does at progress p — used by Transition Lab preview and Auto DJ. */
export function frameAt(c: Pick<TransitionConfig, "crossfader" | "eq" | "eqMode" | "effects">, p: number): Frame {
  const eqOn = c.eqMode !== "off";
  const band = (l: EqLanes, b: Band) => (eqOn ? clamp(laneAt(l[b], p, 0), MAX_CUT_DB, 0) : 0);
  const e = c.effects.echoOut;
  return {
    crossfader: clamp(laneAt(c.crossfader, p, p), 0, 1),
    out: { low: band(c.eq.out, "low"), mid: band(c.eq.out, "mid"), high: band(c.eq.out, "high") },
    in: { low: band(c.eq.in, "low"), mid: band(c.eq.in, "mid"), high: band(c.eq.in, "high") },
    echo: e && p >= e.start && p <= e.end ? e.level : 0,
  };
}

// ── Presets ─────────────────────────────────────────────────────────────────
const P = (id: string, name: string, description: string, config: TransitionPreset["config"], requires?: string): TransitionPreset => ({ id, name, description, isSystemPreset: true, config, requires, createdAt: 0, updatedAt: 0 });
export const SYSTEM_PRESETS: TransitionPreset[] = [
  P("smooth", "Smooth Blend", "Gradual crossfade over 16 bars, beat-synced when possible.", { bars: 16, syncMode: "beat", eqMode: "off", crossfader: pts(0, 0, 1, 1), eq: { out: neutralLanes(), in: neutralLanes() }, effects: {} }),
  P("bass-swap", "Bass Swap", "Both play full, then the low end changes hands in the middle.", { bars: 16, syncMode: "beat", eqMode: "preset", crossfader: pts(0, 0, 0.15, 0.5, 0.85, 0.5, 1, 1),
    eq: { out: { low: pts(0, 0, 0.45, 0, 0.55, -30, 1, -30), mid: flat(), high: flat() }, in: { low: pts(0, -30, 0.45, -30, 0.55, 0, 1, 0), mid: flat(), high: flat() } }, effects: {} }),
  P("high-mid", "High/Mid Blend", "Incoming highs, then mids arrive before its bass; the outgoing track gives way band by band.", { bars: 16, syncMode: "beat", eqMode: "preset", crossfader: pts(0, 0, 0.2, 0.5, 0.8, 0.5, 1, 1),
    eq: { out: { low: pts(0, 0, 0.6, 0, 0.75, -30, 1, -30), mid: pts(0, 0, 0.45, 0, 0.7, -15, 1, -15), high: pts(0, 0, 0.3, -10, 1, -10) },
      in: { low: pts(0, -30, 0.6, -30, 0.75, 0, 1, 0), mid: pts(0, -15, 0.3, -15, 0.55, 0, 1, 0), high: pts(0, -10, 0.3, 0, 1, 0) } }, effects: {} }),
  P("long", "Long Blend", "32-bar overlap with the automatic EQ blend (Auto EQ maths).", { bars: 32, syncMode: "beat-phrase", eqMode: "automatic", crossfader: pts(0, 0, 0.25, 0.5, 0.75, 0.5, 1, 1), ...{ eq: automaticLanes() }, effects: {} }),
  P("quick", "Quick Mix", "Short, phrase-aligned 4-bar change.", { bars: 4, syncMode: "beat-phrase", eqMode: "off", phraseAlign: true, crossfader: pts(0, 0, 0.3, 0.1, 0.7, 0.9, 1, 1), eq: { out: neutralLanes(), in: neutralLanes() }, effects: {} }),
  P("breakdown", "Breakdown Transition", "Leave through the outgoing breakdown: its bass goes early, the incoming track builds under it.", { bars: 16, syncMode: "beat", eqMode: "preset", crossfader: pts(0, 0, 0.6, 0.5, 1, 1),
    eq: { out: { low: pts(0, 0, 0.15, -30, 1, -30), mid: flat(), high: flat() }, in: { low: pts(0, -30, 0.7, -30, 0.85, 0, 1, 0), mid: flat(), high: flat() } }, effects: {} }, "the outgoing track's Breakdown (Auto Cue)"),
  P("drop-swap", "Drop Swap", "Line the incoming drop up with the end of the overlap; bass swaps right on it.", { bars: 16, syncMode: "beat-phrase", eqMode: "preset", crossfader: pts(0, 0, 0.1, 0.5, 0.94, 0.5, 1, 1),
    eq: { out: { low: pts(0, 0, 0.93, 0, 0.99, -30, 1, -30), mid: flat(), high: flat() }, in: { low: pts(0, -30, 0.93, -30, 0.99, 0, 1, 0), mid: flat(), high: flat() } }, effects: {} }, "the incoming track's Drop (Auto Cue)"),
  P("echo-out", "Echo Out", "Echo the outgoing track and cut to the incoming one (uses the FX unit's Echo).", { bars: 4, syncMode: "off", eqMode: "off", crossfader: pts(0, 0, 0.45, 0, 0.5, 1, 1, 1), eq: { out: neutralLanes(), in: neutralLanes() }, effects: { echoOut: { start: 0.1, end: 0.6, level: 0.7 } } }),
];

// ── Timing and tempo ────────────────────────────────────────────────────────
export interface TrackTiming { bpm: number | null; firstBeat: number | null; gridReliable: boolean; duration: number; phraseOffset?: number }
export const barSec = (bpm: number) => 240 / bpm;

/** Snap a position to the track's grid: bar or 8-bar phrase (+offset). Unreliable grid → unchanged. */
export function snap(t: number, g: TrackTiming, to: "beat" | "bar" | "phrase"): number {
  if (!g.gridReliable || !g.bpm || g.firstBeat === null) return t;
  const step = to === "beat" ? 60 / g.bpm : to === "bar" ? barSec(g.bpm) : 8 * barSec(g.bpm);
  const origin = g.firstBeat + (to === "phrase" ? (g.phraseOffset ?? 0) * barSec(g.bpm) : 0);
  return Math.max(0, origin + Math.round((t - origin) / step) * step);
}

export interface Rates { outRate: number; inRate: number; multiple: number; inTempoPct: number; synced: boolean; warning: string | null }
/** Playback rates for a configuration. Beat sync matches incoming to outgoing (half/double-time aware). */
export function ratesFor(c: Pick<TransitionConfig, "syncMode" | "targetBpm" | "maxTempoPct">, out: TrackTiming, inc: TrackTiming): Rates {
  if (c.syncMode === "off") return { outRate: 1, inRate: 1, multiple: 1, inTempoPct: 0, synced: false, warning: null };
  if (!out.bpm || !inc.bpm) return { outRate: 1, inRate: 1, multiple: 1, inTempoPct: 0, synced: false, warning: "Tempo unknown for one track — playing at original speed, no beat sync" };
  const target = c.syncMode === "manual" && c.targetBpm ? c.targetBpm : out.bpm;
  const outRate = target / out.bpm;
  const m = matchTempo(target, inc.bpm);
  const pct = Math.round(m.pct * 10) / 10;
  if (Math.abs(pct) > c.maxTempoPct) return { outRate: c.syncMode === "manual" ? outRate : 1, inRate: 1, multiple: m.multiple, inTempoPct: 0, synced: false, warning: `Needs ${pct > 0 ? "+" : ""}${pct}% on the incoming track — more than the ±${c.maxTempoPct}% limit, so it plays unsynced` };
  const gridsOk = out.gridReliable && inc.gridReliable;
  const warning = Math.abs(pct) > 8 ? `Large tempo change (${pct > 0 ? "+" : ""}${pct}%) — consider key lock` : !gridsOk && c.syncMode !== "manual" ? "Beat grid isn't reliable on one track — tempo matched, beats may drift" : m.multiple !== 1 ? `Half/double-time match (×${m.multiple})` : null;
  return { outRate, inRate: m.rate, multiple: m.multiple, inTempoPct: pct, synced: c.syncMode !== "manual" && gridsOk, warning };
}

export function presetById(id: string, user: TransitionPreset[] = []): TransitionPreset | undefined { return [...SYSTEM_PRESETS, ...user].find((p) => p.id === id); }

export interface DefaultInputs { out: TrackTiming; in: TrackTiming; outMixOut?: number | null; inMixIn?: number | null; outBreakdown?: number | null; inDrop?: number | null }
/**
 * A full configuration from a preset for a track pair. Positions come from Auto Cue mix regions when
 * present, else conservative defaults (16 bars before the outgoing end; the incoming first beat);
 * then snapped to phrase/bar where the grid allows. Returns `unavailable` when the preset's musical
 * requirement (e.g. an incoming drop) isn't known — rather than inventing it.
 */
export function configFromPreset(preset: TransitionPreset, x: DefaultInputs, prev?: Partial<TransitionConfig>): { config: TransitionConfig; unavailable: string | null } {
  const bars = preset.config.bars;
  const syncMode = preset.config.syncMode ?? prev?.syncMode ?? "beat";
  const base: TransitionConfig = {
    presetId: preset.id, mixOut: 0, mixIn: 0, bars, seconds: 0, syncMode, targetBpm: prev?.targetBpm ?? null, keyLock: prev?.keyLock ?? false,
    phraseAlign: preset.config.phraseAlign ?? syncMode === "beat-phrase", maxTempoPct: prev?.maxTempoPct ?? 10, eqMode: preset.config.eqMode ?? "off",
    crossfader: (preset.config.crossfader ?? pts(0, 0, 1, 1)).map((p) => ({ ...p })), eq: structuredClone(preset.config.eq ?? { out: neutralLanes(), in: neutralLanes() }), effects: structuredClone(preset.config.effects ?? {}),
  };
  const r = ratesFor(base, x.out, x.in);
  const outBar = x.out.bpm ? barSec(x.out.bpm) : null;
  base.seconds = outBar ? (bars * outBar) / r.outRate : bars * 2;
  const outLen = base.seconds * r.outRate, inLen = base.seconds * r.inRate;
  let unavailable: string | null = null;
  let mixOut = x.outMixOut ?? x.out.duration - outLen - (outBar ?? 2) * 2;
  let mixIn = x.inMixIn ?? x.in.firstBeat ?? 0;
  if (preset.id === "breakdown") { if (x.outBreakdown != null) mixOut = x.outBreakdown; else unavailable = `Needs ${preset.requires} — run Auto Cue on the outgoing track`; }
  if (preset.id === "drop-swap") { if (x.inDrop != null) mixIn = x.inDrop - inLen; else unavailable = `Needs ${preset.requires} — run Auto Cue on the incoming track`; }
  const unit = base.phraseAlign ? "phrase" : "bar";
  mixOut = snap(mixOut, x.out, unit);
  mixIn = snap(mixIn, x.in, preset.id === "drop-swap" ? "bar" : unit);
  base.mixOut = clamp(mixOut, 0, Math.max(0, x.out.duration - outLen));
  base.mixIn = clamp(mixIn, 0, Math.max(0, x.in.duration - inLen));
  return { config: base, unavailable };
}

/** Recompute seconds from bars after tempo/bars changes. */
export function withBars(c: TransitionConfig, bars: number, out: TrackTiming, inc: TrackTiming): TransitionConfig {
  const r = ratesFor(c, out, inc);
  return { ...c, bars, seconds: out.bpm ? (bars * barSec(out.bpm)) / r.outRate : Math.max(1, bars * 2) };
}

/** Loads a stored transition (fills defaults for fields added later; rejects foreign documents). */
export function migrateTransition(raw: unknown): PreparedTransition {
  const r = raw as Partial<PreparedTransition> | null;
  if (!r || typeof r.id !== "string" || typeof r.outgoingTrackId !== "string" || typeof r.incomingTrackId !== "string" || !Array.isArray(r.crossfader)) throw new Error("Not a prepared transition");
  return { schemaVersion: 1, name: "Transition", setId: null, fromSlotId: null, toSlotId: null, outRef: "", inRef: "", outTitle: "", inTitle: "", notes: "", version: 1, history: [], analysisVersion: { out: null, in: null },
    presetId: "custom", bars: null, seconds: 8, syncMode: "beat", targetBpm: null, keyLock: false, phraseAlign: false, maxTempoPct: 10, eqMode: "off", eq: { out: neutralLanes(), in: neutralLanes() }, effects: {}, mixOut: 0, mixIn: 0,
    createdAt: Date.now(), updatedAt: Date.now(), ...r } as PreparedTransition;
}
export function migratePreset(raw: unknown): TransitionPreset {
  const r = raw as Partial<TransitionPreset> | null;
  if (!r || typeof r.id !== "string" || !r.config) throw new Error("Not a transition preset");
  return { name: "Preset", description: "", createdAt: Date.now(), updatedAt: Date.now(), ...r, isSystemPreset: false } as TransitionPreset;
}

/** Auto DJ lookup: the playing set's transition for this pair, else a set-independent one — never another set's. */
export function findPrepared(all: PreparedTransition[], outId: string | null, inId: string | null, setId: string | null): PreparedTransition | null {
  if (!outId || !inId) return null;
  const pair = all.filter((t) => t.outgoingTrackId === outId && t.incomingTrackId === inId);
  return (setId ? pair.find((t) => t.setId === setId) : null) ?? pair.find((t) => t.setId === null) ?? null;
}

// ── Validation for playback (Auto DJ / preview) ─────────────────────────────
export interface DeckFacts { trackId: string | null; duration: number; bpm: number | null; gridReliable: boolean; tempoRange: number }
export interface PlaybackCheck { ok: boolean; reason: string | null; sync: boolean; notes: string[] }
/** Can this saved transition be performed on these loaded tracks? What has to be dropped? */
export function checkPlayable(t: PreparedTransition, out: DeckFacts, inc: DeckFacts, fx: { echo: boolean }): PlaybackCheck {
  const notes: string[] = [];
  if (out.trackId !== t.outgoingTrackId || inc.trackId !== t.incomingTrackId) return { ok: false, reason: "Loaded tracks don't match the saved transition", sync: false, notes };
  if (!(t.seconds > 0)) return { ok: false, reason: "Saved transition has no length", sync: false, notes };
  const r = ratesFor(t, { bpm: out.bpm, firstBeat: 0, gridReliable: out.gridReliable, duration: out.duration }, { bpm: inc.bpm, firstBeat: 0, gridReliable: inc.gridReliable, duration: inc.duration });
  if (t.mixOut < 0 || t.mixOut + t.seconds * r.outRate > out.duration + 0.5) return { ok: false, reason: "Mix-out point is outside the outgoing track", sync: false, notes };
  if (t.mixIn < 0 || t.mixIn + t.seconds * r.inRate > inc.duration + 0.5) return { ok: false, reason: "Mix-in point is outside the incoming track", sync: false, notes };
  let sync = r.synced && (t.syncMode === "beat" || t.syncMode === "beat-phrase");
  if (sync && Math.abs(r.inRate - 1) > inc.tempoRange + 1e-6) { sync = false; notes.push(`Beat sync skipped: needs ${r.inTempoPct}% but the deck's tempo range is ±${Math.round(inc.tempoRange * 100)}%`); }
  if (!r.synced && (t.syncMode === "beat" || t.syncMode === "beat-phrase") && r.warning) notes.push(r.warning);
  if (t.effects.echoOut && !fx.echo) notes.push("Echo unavailable — echo-out skipped");
  return { ok: true, reason: null, sync, notes };
}

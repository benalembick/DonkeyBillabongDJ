/**
 * AUTO ENHANCE VOCAL (Phase 3): turns a take's analysis into a cleanup chain + pitch preset, and explains every
 * decision. Genre presets shape tone and dynamics; measurements (noise floor, sibilance, level spread, spectrum,
 * resonances, breaths) decide what is actually needed. Space / width / saturation / doubling belong to Phase 5,
 * so presets that are mostly about those (Wide, Dreamy) are not offered yet.
 */
import { defaultChain, type CleanupChain, type VocalAnalysis } from "./cleanup";
import type { PitchPresetId } from "./pitchCorrect";

export type EnhancePresetId = "natural" | "clean-studio" | "pop" | "edm" | "rock" | "warm" | "hard-tune";
interface PresetShape { label: string; hint: string; pitch: PitchPresetId; level: CleanupChain["level"]["mode"]; ratio: number; attackMs: number; multiband: boolean; presence: number; air: number; warmth: number; deess: number; breath: CleanupChain["breath"]["mode"]; gateRange: number }
export const ENHANCE_PRESETS: Record<EnhancePresetId, PresetShape> = {
  natural: { label: "Natural", hint: "Clean-up and gentle control; sounds like you, only better", pitch: "natural", level: "natural", ratio: 2, attackMs: 15, multiband: false, presence: 0, air: 0, warmth: 0, deess: .8, breath: "keep", gateRange: 10 },
  "clean-studio": { label: "Clean Studio", hint: "Polished, even and clear", pitch: "studio", level: "balanced", ratio: 3, attackMs: 10, multiband: false, presence: 1.5, air: 1.5, warmth: 0, deess: 1, breath: "reduce", gateRange: 18 },
  pop: { label: "Pop", hint: "Bright, upfront and consistent", pitch: "studio", level: "balanced", ratio: 4, attackMs: 6, multiband: true, presence: 2.5, air: 3, warmth: 0, deess: 1.2, breath: "reduce", gateRange: 20 },
  edm: { label: "EDM", hint: "Tight, bright, heavily controlled", pitch: "strong", level: "aggressive", ratio: 6, attackMs: 3, multiband: true, presence: 3, air: 4, warmth: 0, deess: 1.3, breath: "strong", gateRange: 24 },
  rock: { label: "Rock", hint: "Punchy midrange, energy kept", pitch: "natural", level: "balanced", ratio: 4, attackMs: 4, multiband: false, presence: 3, air: 1, warmth: 1.5, deess: 1, breath: "keep", gateRange: 14 },
  warm: { label: "Warm", hint: "Full and smooth, softer top", pitch: "natural", level: "natural", ratio: 2.5, attackMs: 20, multiband: false, presence: .5, air: -1, warmth: 2.5, deess: 1.3, breath: "reduce", gateRange: 12 },
  "hard-tune": { label: "Hard Tune", hint: "The robotic tuned effect with a modern polished chain", pitch: "hard", level: "balanced", ratio: 4, attackMs: 6, multiband: true, presence: 2, air: 2, warmth: 0, deess: 1, breath: "reduce", gateRange: 20 },
};

const round = (v: number, step = .5) => Math.round(v / step) * step;

/** Chain + pitch preset + a plain-language report of exactly what was applied and why. */
export function buildEnhance(a: VocalAnalysis, presetId: EnhancePresetId): { chain: CleanupChain; pitch: PitchPresetId; report: string[] } {
  const p = ENHANCE_PRESETS[presetId]; const c = defaultChain(); const report: string[] = [];
  // Gate: only when there is audible noise between phrases.
  const gap = a.singDb - a.noiseFloorDb;
  if (a.noiseFloorDb > -70 && gap > 15) {
    const threshold = round(Math.min(a.noiseFloorDb + 8, a.singDb - 18)); // expander ratio steep enough that the noise floor itself gets the full range
    c.gate = { ...c.gate, on: true, threshold, range: p.gateRange, ratio: round(Math.max(2, Math.min(6, 1 + p.gateRange / Math.max(4, threshold - a.noiseFloorDb)))) };
    report.push(`Gate/Expander: threshold ${c.gate.threshold} dB, range ${c.gate.range} dB, ratio ${c.gate.ratio}:1 — background noise at ${a.noiseFloorDb.toFixed(0)} dB between phrases`);
  }
  else report.push(`Gate: off — the background is already quiet (${a.noiseFloorDb.toFixed(0)} dB)`);
  // Breaths
  if (a.breaths > 0 && p.breath !== "keep") { c.breath = { on: true, mode: p.breath }; report.push(`Breath Control: ${p.breath === "strong" ? "Strong Reduce (−20 dB)" : "Reduce (−9 dB)"} — ${a.breaths} breath${a.breaths === 1 ? "" : "s"} found (kept, just quieter)`); }
  else if (a.breaths > 0) report.push(`Breath Control: Keep — ${a.breaths} breath${a.breaths === 1 ? "" : "s"} left natural`);
  // De-esser
  // De-esser: the threshold sits `cut` dB under the measured "s" peaks (the band is held at the threshold), so loud
  // sibilance comes down a lot and mild sibilance only a little; voiced frames are protected by the dominance test.
  if (a.sibilanceDb > -12) { const cut = Math.max(3, Math.min(12, round((a.sibilanceDb + 8) * p.deess))); c.deesser = { ...c.deesser, on: true, threshold: round(a.singDb + a.sibilanceDb - cut), maxReduction: Math.min(14, cut + 3) }; report.push(`De-esser: ${c.deesser.freq / 1000} kHz, threshold ${c.deesser.threshold} dB (≈ ${cut} dB off the "s" peaks, up to ${c.deesser.maxReduction} dB) — sharp "s" sounds at ${a.sibilanceDb >= 0 ? "+" : ""}${a.sibilanceDb.toFixed(0)} dB vs the voice`); }
  else report.push("De-esser: off — no harsh sibilance measured");
  // EQ
  c.eq.on = true; c.eq.hpf = Math.round(Math.max(60, Math.min(120, a.lowestHz * .7)));
  // Mud: 200–500 Hz normally sits ~3 dB above 500–1000 Hz in a sung voice; much more than that is boominess / proximity effect.
  const mudExcess = a.bands.mud - a.bands.body - 6; if (mudExcess > 0) c.eq.mud.gain = -Math.min(5, round(mudExcess));
  const presenceDeficit = (a.bands.mid - 6) - a.bands.presence; c.eq.presence.gain = round(Math.max(-2, Math.min(5, (presenceDeficit > 0 ? Math.min(3, presenceDeficit) : 0) + p.presence)));
  const airDeficit = (a.bands.presence - 10) - a.bands.air; c.eq.air.gain = round(Math.max(-3, Math.min(5, (airDeficit > 0 ? Math.min(3, airDeficit) : 0) + p.air)));
  c.eq.lowShelf.gain = round(p.warmth); c.eq.resonances = a.resonances.slice(0, 3);
  report.push(`EQ: high-pass ${c.eq.hpf} Hz${c.eq.mud.gain ? `, mud ${c.eq.mud.gain} dB at ${c.eq.mud.freq} Hz` : ""}${c.eq.lowShelf.gain ? `, warmth ${c.eq.lowShelf.gain > 0 ? "+" : ""}${c.eq.lowShelf.gain} dB` : ""}${c.eq.presence.gain ? `, presence ${c.eq.presence.gain > 0 ? "+" : ""}${c.eq.presence.gain} dB` : ""}${c.eq.air.gain ? `, air ${c.eq.air.gain > 0 ? "+" : ""}${c.eq.air.gain} dB` : ""}${c.eq.resonances.length ? `, ${c.eq.resonances.length} resonance cut${c.eq.resonances.length === 1 ? "" : "s"} (${c.eq.resonances.map((r) => `${r.freq} Hz ${r.gain} dB`).join(", ")})` : ""}`);
  // Auto Level: stronger when the level swings more (poor mic technique).
  const mode = a.spreadDb > 14 ? (p.level === "natural" ? "balanced" : "aggressive") : a.spreadDb > 9 ? (p.level === "aggressive" ? "aggressive" : "balanced") : p.level;
  c.level = { on: true, mode, target: null }; report.push(`Auto Level: ${mode[0].toUpperCase()}${mode.slice(1)} — the singing level swings ${a.spreadDb.toFixed(0)} dB`);
  // Compressor (after the rider, so it only shapes the dynamics left).
  c.comp = { ...c.comp, on: true, ratio: p.ratio, attackMs: p.attackMs, threshold: round(a.singDb - 6), makeup: round(Math.min(6, (6 * (1 - 1 / p.ratio)) / 2)) };
  report.push(`Compressor: ${p.ratio}:1, threshold ${c.comp.threshold} dB, attack ${p.attackMs} ms, makeup +${c.comp.makeup} dB`);
  if (p.multiband) { c.multiband = { ...c.multiband, on: true, bands: [{ threshold: round(a.singDb - 4), ratio: 2.5 }, { threshold: round(a.singDb - 2), ratio: 2 }, { threshold: round(a.singDb - 6), ratio: 3 }] }; report.push(`Multiband Compressor: ${c.multiband.lowFreq} Hz / ${c.multiband.highFreq / 1000} kHz splits — holds the low end and harsh top steady`); }
  c.limiter = { on: true, ceiling: -1, releaseMs: 60 }; report.push("Limiter: −1 dBFS ceiling (look-ahead)");
  report.push(`Pitch correction: ${({ natural: "Natural Correction", studio: "Studio Vocal", strong: "Strong Correction", hard: "Hard Tune" } as const)[p.pitch]}`);
  return { chain: c, pitch: p.pitch, report };
}

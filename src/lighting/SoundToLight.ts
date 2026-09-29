/**
 * Sound-to-light: turns the DJ mix (or a deck, or a microphone) into DMX values
 * for the selected fixtures.
 *
 *   audio probe (live band levels) ─┐
 *   beat source (deck beat grid) ───┼→ normalise + envelopes → events (beat, downbeat, bar, bass/mid/high hits)
 *                                   └→ mappings (editable: bass→red, beat→dimmer…) → sound layer of the DMX engine
 *
 * Bands use the same crossovers as the channel EQ and the EQ-reactive waveform
 * (220 Hz / 3.5 kHz). When the playing deck has a beat grid, beats come from it
 * (exact, including downbeats every 4 beats); otherwise from bass onsets.
 */
import { Emitter } from "../core/events";
import { DmxEngine, LAYER_SOUND } from "./DmxEngine";
import { DMX_SLOTS } from "./protocol";
import { findDef, modeOf, type ChannelType, type FixtureDef, type PatchedFixture } from "./fixtures";

export type SoundSource = "master" | "deckA" | "deckB" | "mic";
export type SoundInput = "low" | "mid" | "high" | "amplitude" | "beat";

/** One editable sound → fixture-attribute rule. */
export interface SoundMapping {
  input: SoundInput;
  output: ChannelType;
  /** 0..1 */
  amount: number;
}

export const DEFAULT_MAPPINGS: SoundMapping[] = [
  { input: "low", output: "red", amount: 1 },
  { input: "mid", output: "green", amount: 1 },
  { input: "high", output: "blue", amount: 1 },
  { input: "high", output: "white", amount: 0.4 },
  { input: "amplitude", output: "intensity", amount: 0.55 },
  { input: "beat", output: "intensity", amount: 1 },
  { input: "amplitude", output: "generic", amount: 0.6 },
  { input: "beat", output: "generic", amount: 1 },
];

export interface SoundSettings {
  enabled: boolean;
  source: SoundSource;
  /** 0..1 */
  sensitivity: number;
  brightness: number;
  /** 0 = slow, 1 = fast */
  speed: number;
  bassResponse: number;
  midResponse: number;
  highResponse: number;
  beatFlash: boolean;
  downbeatAccent: boolean;
  /** Patched fixture ids under sound control. */
  fixtures: string[];
  mappings: SoundMapping[];
  /** Lasers are never driven by sound unless this is switched on deliberately. */
  allowLasers: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: false,
  source: "master",
  sensitivity: 0.6,
  brightness: 1,
  speed: 0.5,
  bassResponse: 1,
  midResponse: 1,
  highResponse: 1,
  beatFlash: true,
  downbeatAccent: true,
  fixtures: [],
  mappings: DEFAULT_MAPPINGS,
  allowLasers: false,
};

/** Raw band magnitudes from the audio graph (any scale; normalised here). */
export interface BandReading {
  low: number;
  mid: number;
  high: number;
  amplitude: number;
}

export interface AudioProbe {
  /** Current band levels for a source, or null when it has no signal path (e.g. mic not granted). */
  read(source: SoundSource): BandReading | null;
}

/** Beat grid position of the deck feeding a source (null = no grid → onset detection). */
export interface BeatSource {
  beatPosition(source: SoundSource): { beats: number; bpm: number } | null;
}

export interface SoundMeters {
  low: number;
  mid: number;
  high: number;
  amplitude: number;
  beat: number;
  bpm: number | null;
  beatFrom: "grid" | "onsets" | "none";
  signal: boolean;
}

export type SoundEvents = {
  beat: { index: number; downbeat: boolean };
  downbeat: { index: number };
  bar: { index: number };
  bassHit: void;
  midHit: void;
  highHit: void;
  meters: SoundMeters;
};

/**
 * Per-band weights before the shared auto-gain (a hook for offsetting spectral tilt).
 * Equal for now: on a real dance track through the master tap the shared auto-gain
 * already gave usable balance (peak meters bass 0.95 / mid 0.84 / high 0.59); the
 * Bass/Mid/High Response sliders tune it per venue. See docs/LIGHTING.md.
 */
export const BAND_WEIGHTS = { low: 1, mid: 1, high: 1 };

/** Sensitivity + attack/release + onset detection for one band (input already normalised 0..1). */
class BandFollower {
  level = 0;
  private prev = 0;
  private lastHit = -1;
  /** Returns true on an onset ("hit"). */
  step(norm: number, dt: number, sensitivity: number, speed: number, now: number): boolean {
    const gamma = 2.6 - 2.2 * sensitivity; // higher sensitivity → brighter response
    const target = Math.pow(norm, gamma);
    const attack = 0.012;
    const release = 0.7 - 0.62 * speed; // slow 0.7 s ↔ fast 0.08 s
    const tau = target > this.level ? attack : release;
    this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    const hit = target - this.prev > 0.28 && target > 0.55 && now - this.lastHit > 0.12;
    if (hit) this.lastHit = now;
    this.prev += (target - this.prev) * (1 - Math.exp(-dt / 0.05));
    return hit;
  }
}

export class SoundToLight extends Emitter<SoundEvents> {
  settings: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };
  private readonly engine: DmxEngine;
  private readonly probe: AudioProbe;
  private readonly beats: BeatSource;
  private readonly rig: () => { defs: FixtureDef[]; fixtures: PatchedFixture[] };
  private low = new BandFollower();
  private mid = new BandFollower();
  private high = new BandFollower();
  private amp = new BandFollower();
  private beatEnv = 0;
  private lastBeatIndex: number | null = null;
  private onsetTimes: number[] = [];
  private onsetCount = 0;
  private time = 0;
  private wasEnabled = false;
  meters: SoundMeters = { low: 0, mid: 0, high: 0, amplitude: 0, beat: 0, bpm: null, beatFrom: "none", signal: false };

  constructor(opts: { engine: DmxEngine; probe: AudioProbe; beats: BeatSource; rig: () => { defs: FixtureDef[]; fixtures: PatchedFixture[] } }) {
    super();
    this.engine = opts.engine;
    this.probe = opts.probe;
    this.beats = opts.beats;
    this.rig = opts.rig;
  }

  /** Advance by dt seconds: analyse, fire events, write the sound layer. */
  update(dt: number): void {
    const s = this.settings;
    this.time += dt;
    const now = this.time;
    const r = s.enabled ? this.probe.read(s.source) : null;
    this.lastRaw = r;
    // Any real signal counts (auto-gain handles level): only true silence (< −120 dBFS) is "no signal".
    const signal = !!r && r.amplitude > 1e-6;
    const rd = r ?? { low: 0, mid: 0, high: 0, amplitude: 0 };
    // One shared auto-gain for the three bands keeps their balance (a faint band stays faint);
    // it decays over ~8 s so quiet and loud mixes both use the full range.
    const wl = rd.low * BAND_WEIGHTS.low;
    const wm = rd.mid * BAND_WEIGHTS.mid;
    const wh = rd.high * BAND_WEIGHTS.high;
    this.bandPeak = Math.max(wl, wm, wh, this.bandPeak * Math.exp(-dt / 8), 1e-6);
    this.ampPeak = Math.max(rd.amplitude, this.ampPeak * Math.exp(-dt / 8), 1e-6);
    const bassHit = this.low.step(Math.min(1, wl / this.bandPeak), dt, s.sensitivity, s.speed, now) && signal;
    if (bassHit) this.emit("bassHit", undefined);
    if (this.mid.step(Math.min(1, wm / this.bandPeak), dt, s.sensitivity, s.speed, now) && signal) this.emit("midHit", undefined);
    if (this.high.step(Math.min(1, wh / this.bandPeak), dt, s.sensitivity, s.speed, now) && signal) this.emit("highHit", undefined);
    this.amp.step(Math.min(1, rd.amplitude / this.ampPeak), dt, s.sensitivity, s.speed, now);

    // Beats: from the deck's beat grid when there is one, else from bass onsets.
    let beatFrom: SoundMeters["beatFrom"] = "none";
    let bpm: number | null = null;
    const grid = s.enabled ? this.beats.beatPosition(s.source) : null;
    let fired: { index: number; downbeat: boolean } | null = null;
    if (grid) {
      beatFrom = "grid";
      bpm = grid.bpm;
      const idx = Math.floor(grid.beats + 1e-6);
      if (this.lastBeatIndex !== null && idx !== this.lastBeatIndex && idx >= 0) fired = { index: idx, downbeat: ((idx % 4) + 4) % 4 === 0 };
      this.lastBeatIndex = idx;
    } else {
      this.lastBeatIndex = null;
      if (signal) {
        beatFrom = "onsets";
        // Kick drums: a bass hit at least ~0.28 s after the previous beat (≤ 214 BPM).
        if (bassHit && now - this.lastOnsetBeat > 0.28) {
          this.lastOnsetBeat = now;
          this.onsetTimes.push(now);
          if (this.onsetTimes.length > 9) this.onsetTimes.shift();
          this.onsetCount++;
          fired = { index: this.onsetCount, downbeat: this.onsetCount % 4 === 0 };
        }
        bpm = this.estimatedBpm();
      }
    }
    if (fired && signal) {
      this.emit("beat", fired);
      if (fired.downbeat) {
        this.emit("downbeat", { index: fired.index });
        this.emit("bar", { index: Math.floor(fired.index / 4) });
      }
      if (s.beatFlash) this.beatEnv = Math.max(this.beatEnv, fired.downbeat && s.downbeatAccent ? 1 : 0.7);
    }
    // Flash decay: quicker at fast response.
    this.beatEnv *= Math.exp(-dt / (0.32 - 0.22 * s.speed));
    if (!s.beatFlash) this.beatEnv = 0;

    const low = this.low.level * s.bassResponse;
    const mid = this.mid.level * s.midResponse;
    const high = this.high.level * s.highResponse;
    this.meters = { low, mid, high, amplitude: this.amp.level, beat: this.beatEnv, bpm, beatFrom, signal };
    this.emit("meters", this.meters);
    this.writeLayer({ low, mid, high, amplitude: signal ? this.amp.level : 0, beat: signal ? this.beatEnv : 0 });
  }

  private lastOnsetBeat = -1;
  private bandPeak = 1e-6;
  private ampPeak = 1e-6;
  /** Latest raw (unnormalised) reading — for calibration and diagnostics. */
  lastRaw: BandReading | null = null;

  private estimatedBpm(): number | null {
    if (this.onsetTimes.length < 5) return null;
    const iv: number[] = [];
    for (let i = 1; i < this.onsetTimes.length; i++) iv.push(this.onsetTimes[i] - this.onsetTimes[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    let bpm = 60 / med;
    while (bpm < 80) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm * 10) / 10;
  }

  private frames = new Map<number, Uint8Array>();

  /** Apply the mappings to the selected fixtures and write the sound layer (clearing it when disabled). */
  private writeLayer(inputs: Record<SoundInput, number>): void {
    const s = this.settings;
    const { defs, fixtures } = this.rig();
    if (!s.enabled) {
      if (this.wasEnabled) for (const u of this.engine.getUniverses()) this.engine.clearLayer(LAYER_SOUND, u);
      this.wasEnabled = false;
      return;
    }
    this.wasEnabled = true;
    for (const f of this.frames.values()) f.fill(0);
    const selected = new Set(s.fixtures);
    for (const fx of fixtures) {
      if (!selected.has(fx.id)) continue;
      if (findDef(defs, fx.defId)?.laser && !s.allowLasers) continue; // laser safety
      const mode = modeOf(defs, fx);
      if (!mode) continue;
      let frame = this.frames.get(fx.universe);
      if (!frame) this.frames.set(fx.universe, (frame = new Uint8Array(DMX_SLOTS)));
      const types = mode.channels.map((c) => c.type);
      const hasDimmer = types.includes("intensity");
      const dim = this.valueFor("intensity", inputs);
      // Without a dimmer channel, the colour channels carry the intensity (beat flash etc.).
      const colourScale = hasDimmer ? s.brightness : s.brightness * dim;
      for (let i = 0; i < types.length && i < fx.channelCount; i++) {
        const a = fx.address + i;
        if (a < 1 || a > DMX_SLOTS) continue;
        const t = types[i];
        let v = 0;
        if (t === "intensity") v = dim * s.brightness;
        else if (t === "generic") v = this.valueFor("generic", inputs) * s.brightness;
        else if (t === "red" || t === "green" || t === "blue" || t === "white" || t === "amber" || t === "uv") v = this.valueFor(t, inputs) * colourScale;
        // Strobe, position and effect channels are left alone (0) — never strobe automatically.
        if (v > 0) frame[a - 1] = Math.max(frame[a - 1], Math.round(Math.min(1, v) * 255));
      }
    }
    for (const u of this.engine.getUniverses()) this.engine.writeLayer(LAYER_SOUND, u, this.frames.get(u) ?? new Uint8Array(DMX_SLOTS));
  }

  /** Highest mapped input for a channel type (mappings are editable data, not code). */
  private valueFor(type: ChannelType, inputs: Record<SoundInput, number>): number {
    let v = 0;
    for (const m of this.settings.mappings) if (m.output === type) v = Math.max(v, inputs[m.input] * m.amount);
    return v;
  }
}

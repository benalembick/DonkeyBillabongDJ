/**
 * Live audio for sound-to-light, from the app's own audio graph:
 *  - Master: the DJ mix after the master level (what the audience hears)
 *  - Deck A / Deck B: each deck after EQ/filter/FX, before its fader (drive lights from a deck even while it's faded out)
 *  - Microphone: getUserMedia, for music that isn't playing through DonkeyBillabongDJ
 *
 * Band split = the channel EQ crossovers (220 Hz / 3.5 kHz), like the EQ-reactive waveforms.
 * Beats come from the playing deck's beat grid via the DJ engine.
 */
import type { DJEngine } from "../core/engine/DJEngine";
import { EQ_HIGH_HZ, EQ_LOW_HZ } from "../core/engine/mixerMath";
import type { AudioProbe, BandReading, BeatSource, SoundSource } from "./SoundToLight";

export interface AnalysisTapProvider {
  getAnalysisTap(source: "master" | number): AnalyserNode | null;
  getLevels(): { channels: number[]; master: number };
}

const scratch = new WeakMap<AnalyserNode, { freq: Float32Array<ArrayBuffer>; time: Float32Array<ArrayBuffer> }>();

/** Band magnitudes (√ of summed FFT power) and RMS of one analyser. */
export function readBands(an: AnalyserNode): BandReading {
  let s = scratch.get(an);
  if (!s) scratch.set(an, (s = { freq: new Float32Array(an.frequencyBinCount), time: new Float32Array(an.fftSize) }));
  an.getFloatFrequencyData(s.freq);
  an.getFloatTimeDomainData(s.time);
  const binHz = an.context.sampleRate / an.fftSize;
  let lo = 0;
  let md = 0;
  let hi = 0;
  for (let i = 1; i < s.freq.length; i++) {
    const f = i * binHz;
    const db = s.freq[i];
    if (!Number.isFinite(db) || f < 30 || f > 16000) continue;
    const p = Math.pow(10, db / 10);
    if (f < EQ_LOW_HZ) lo += p;
    else if (f < EQ_HIGH_HZ) md += p;
    else hi += p;
  }
  let sq = 0;
  for (let i = 0; i < s.time.length; i++) sq += s.time[i] * s.time[i];
  return { low: Math.sqrt(lo), mid: Math.sqrt(md), high: Math.sqrt(hi), amplitude: Math.sqrt(sq / s.time.length) };
}

export type MicState = "off" | "starting" | "on" | "denied" | "error";

/** Microphone input (opened only while the mic is the selected, enabled source). */
export class MicInput {
  state: MicState = "off";
  message = "";
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  analyser: AnalyserNode | null = null;

  async start(): Promise<void> {
    if (this.state === "on" || this.state === "starting") return;
    this.state = "starting";
    try {
      // Desktop: the app only gets microphone access when it's asked for here (one system prompt on macOS).
      const access = await window.dbdjDesktop?.requestMicrophone?.();
      if (access && !access.granted) {
        this.state = "denied";
        this.message = access.status === "denied" || access.status === "restricted"
          ? "Microphone access is off for Donkey Billabong DJ — allow it in System Settings → Privacy & Security → Microphone, then choose the microphone again."
          : "Microphone access was not allowed";
        return;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      src.connect(this.analyser);
      this.state = "on";
      this.message = "";
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      this.state = denied ? "denied" : "error";
      this.message = denied ? "Microphone access was denied" : `Microphone unavailable: ${String(err)}`;
      this.stop(false);
    }
  }

  stop(resetState = true): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => undefined);
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    if (resetState) {
      this.state = "off";
      this.message = "";
    }
  }
}

/** The deck that feeds a source: A/B directly; master = the tempo master if playing, else the loudest playing deck. */
export function deckForSource(engine: DJEngine, levels: number[], source: SoundSource): number | null {
  if (source === "deckA") return 0;
  if (source === "deckB") return 1;
  if (source === "mic") return null;
  const s = engine.getState();
  const m = s.masterDeck;
  if (m !== null && s.decks[m]?.playing) return m;
  let best: number | null = null;
  s.decks.forEach((d, i) => {
    if (d.playing && (best === null || (levels[i] ?? 0) > (levels[best] ?? 0))) best = i;
  });
  return best;
}

export function makeProbe(audio: AnalysisTapProvider, mic: MicInput): AudioProbe {
  return {
    read(source: SoundSource): BandReading | null {
      const an = source === "mic" ? mic.analyser : audio.getAnalysisTap(source === "master" ? "master" : source === "deckA" ? 0 : 1);
      return an ? readBands(an) : null;
    },
  };
}

export function makeBeatSource(engine: DJEngine, audio: AnalysisTapProvider): BeatSource {
  return {
    beatPosition(source: SoundSource) {
      const deck = deckForSource(engine, audio.getLevels().channels, source);
      if (deck === null) return null;
      const d = engine.getState().decks[deck];
      const g = d?.beatGrid;
      if (!d?.playing || !g) return null;
      return { beats: (engine.getPosition(deck) - g.firstBeat) / (60 / g.bpm), bpm: engine.getBpm(deck) ?? g.bpm };
    },
  };
}

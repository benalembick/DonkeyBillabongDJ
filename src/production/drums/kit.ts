/**
 * Drum Transcriber preview kit: sampled kick / snare / clap / hats (bundled one-shots, see src/assets/drumkit/README.md)
 * and synthesised toms, cymbals, other percussion and an Unknown-lane click. Inlined as data URLs so the kit loads
 * without file/network access (works in Electron's file:// renderer and the browser build alike).
 */
import clapUrl from "../../assets/drumkit/clap.mp3?inline";
import closedHatUrl from "../../assets/drumkit/closed-hat.mp3?inline";
import kickUrl from "../../assets/drumkit/kick.mp3?inline";
import openHatUrl from "../../assets/drumkit/open-hat.mp3?inline";
import snareUrl from "../../assets/drumkit/snare.mp3?inline";
import type { DrumLane } from "./types";

const SAMPLED: Partial<Record<DrumLane, string>> = { kick: kickUrl, snare: snareUrl, clap: clapUrl, "closed-hat": closedHatUrl, "open-hat": openHatUrl };

function dataUrlBytes(url: string): ArrayBuffer {
  const b64 = url.slice(url.indexOf(",") + 1); const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer;
}

export class DrumKit {
  private buffers = new Map<DrumLane, AudioBuffer>();
  private noise: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;
  private context: BaseAudioContext | null = null;

  /** Decodes the sampled voices once per context (failures fall back to synthesis). */
  load(context: BaseAudioContext): Promise<void> {
    if (this.context === context && this.loading) return this.loading;
    this.context = context; this.buffers.clear();
    const n = context.createBuffer(1, Math.round(context.sampleRate * 1.6), context.sampleRate); const d = n.getChannelData(0); let seed = 12345;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; d[i] = seed / 2147483648 - 1; }
    this.noise = n;
    this.loading = Promise.all(Object.entries(SAMPLED).map(async ([lane, url]) => {
      try { this.buffers.set(lane as DrumLane, await context.decodeAudioData(dataUrlBytes(url!))); } catch { /* synthesised fallback */ }
    })).then(() => undefined);
    return this.loading;
  }

  /** Schedules one hit; returns the source nodes so a transport can stop them. */
  trigger(context: BaseAudioContext, output: AudioNode, lane: DrumLane, velocity: number, when: number): AudioScheduledSourceNode[] {
    const gain = context.createGain(); gain.connect(output); const level = (velocity / 127) ** 1.6; const sample = this.buffers.get(lane);
    if (sample) { const src = context.createBufferSource(); src.buffer = sample; src.connect(gain); gain.gain.value = level; src.start(when); return [src]; }
    if (lane === "kick" || lane.endsWith("tom")) {
      const [hi, lo, len] = lane === "kick" ? [150, 45, .35] : lane === "low-tom" ? [160, 90, .45] : lane === "mid-tom" ? [210, 120, .4] : [280, 160, .35];
      const osc = context.createOscillator(); osc.frequency.setValueAtTime(hi, when); osc.frequency.exponentialRampToValueAtTime(lo, when + len * .5);
      gain.gain.setValueAtTime(level * .9, when); gain.gain.exponentialRampToValueAtTime(.001, when + len); osc.connect(gain); osc.start(when); osc.stop(when + len + .02); return [osc];
    }
    const src = context.createBufferSource(); src.buffer = this.noise; const filter = context.createBiquadFilter(); src.connect(filter).connect(gain);
    const voice: Record<string, [BiquadFilterType, number, number, number]> = { // filter, frequency, decay, level
      snare: ["bandpass", 1800, .18, .7], clap: ["bandpass", 1400, .22, .7], "closed-hat": ["highpass", 7500, .05, .45], "open-hat": ["highpass", 7000, .4, .4],
      crash: ["highpass", 4500, 1.4, .45], ride: ["bandpass", 6500, .9, .35], perc: ["bandpass", 900, .12, .6], unknown: ["bandpass", 3000, .04, .5],
    };
    const [type, freq, decay, lvl] = voice[lane] ?? voice.unknown; filter.type = type; filter.frequency.value = freq; filter.Q.value = type === "bandpass" ? 1.2 : .7;
    gain.gain.setValueAtTime(level * lvl, when); gain.gain.exponentialRampToValueAtTime(.001, when + decay); src.start(when); src.stop(when + decay + .02);
    const nodes: AudioScheduledSourceNode[] = [src];
    if (lane === "ride" || lane === "perc") { const bell = context.createOscillator(); const g = context.createGain(); bell.frequency.value = lane === "ride" ? 3200 : 820; g.gain.setValueAtTime(level * .12, when); g.gain.exponentialRampToValueAtTime(.001, when + decay * .7); bell.connect(g).connect(output); bell.start(when); bell.stop(when + decay); nodes.push(bell); }
    return nodes;
  }
}

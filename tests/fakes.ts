import type { AudioEngine, AudioEngineEvent, AudioStatus, ChannelDsp, DecodedAudio, FxDsp, MasterDsp } from "../src/core/engine/types";

/** In-memory AudioEngine that records calls and simulates a playhead. */
export class FakeAudioEngine implements AudioEngine {
  readonly deckCount = 2;
  calls: { fn: string; deck?: number; args: unknown[] }[] = [];
  positions = [0, 0];
  playing = [false, false];
  rates = [1, 1];
  scratching = [false, false];
  channels: ChannelDsp[] = [];
  master: MasterDsp | null = null;
  private listeners = new Set<(e: AudioEngineEvent) => void>();

  private rec(fn: string, deck: number | undefined, ...args: unknown[]) {
    this.calls.push({ fn, deck, args });
  }
  async start() {}
  async reconfigure() {}
  getStatus(): AudioStatus {
    return { backend: "fake", state: "running", sampleRate: 48000, baseLatency: 0, outputLatency: 0, maxOutputChannels: 2, routing: "stereo", outputDeviceId: "default" };
  }
  async listOutputDevices() {
    return [];
  }
  async decode(bytes: ArrayBuffer): Promise<DecodedAudio> {
    return { duration: bytes.byteLength, sampleRate: 48000, channels: 2, handle: null };
  }
  loadDeck(deck: number) {
    this.positions[deck] = 0;
    this.rec("loadDeck", deck);
  }
  unloadDeck(deck: number) {
    this.rec("unloadDeck", deck);
  }
  setPlaying(deck: number, playing: boolean) {
    this.playing[deck] = playing;
    this.rec("setPlaying", deck, playing);
  }
  seek(deck: number, seconds: number) {
    this.positions[deck] = seconds;
    this.rec("seek", deck, seconds);
  }
  setRate(deck: number, rate: number) {
    this.rates[deck] = rate;
    this.rec("setRate", deck, rate);
  }
  nudge(deck: number, off: number) {
    this.rec("nudge", deck, off);
  }
  setScratching(deck: number, active: boolean) {
    this.scratching[deck] = active;
    this.rec("setScratching", deck, active);
  }
  scratchMove(deck: number, seconds: number) {
    this.rec("scratchMove", deck, seconds);
  }
  setChannel(deck: number, dsp: ChannelDsp) {
    this.channels[deck] = dsp;
  }
  setMaster(dsp: MasterDsp) {
    this.master = dsp;
  }
  fx: FxDsp[] = [];
  setFx(unit: number, dsp: FxDsp) {
    this.fx[unit] = dsp;
  }
  getPosition(deck: number) {
    return this.positions[deck];
  }
  getLevels() {
    return { channels: [0, 0], master: 0 };
  }
  on(l: (e: AudioEngineEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  fire(e: AudioEngineEvent) {
    for (const l of this.listeners) l(e);
  }
  last(fn: string) {
    return [...this.calls].reverse().find((c) => c.fn === fn);
  }
}

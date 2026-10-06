/**
 * Input capture AudioWorklet (Vocal Studio recording).
 *
 * Copies one input channel (or a mono mix) into fixed-size blocks and posts each block with
 * the audio-clock frame of its first sample, so the main thread can place a take on the
 * arrangement timeline sample-accurately (MediaRecorder gives no such timing and re-encodes).
 * The node must be pulled by the graph: connect its output to a silent gain.
 *
 * Rules for this file: no imports, no logging. One allocation per posted block (the transferred
 * buffer), never per render quantum.
 */

interface CaptureScope {
  sampleRate: number;
  currentFrame: number;
  registerProcessor(name: string, ctor: unknown): void;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
}
const captureScope = globalThis as unknown as CaptureScope;

type CaptureMsg = { type: "start" } | { type: "stop" } | { type: "channel"; channel: number };

const BLOCK = 2048; // ~43 ms at 48 kHz: smooth live waveform, few messages

class CaptureProcessor extends captureScope.AudioWorkletProcessor {
  private recording = false;
  private channel = 0; // 0, 1, or -1 for a mono mix
  private block = new Float32Array(BLOCK);
  private fill = 0;
  private blockFrame = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<CaptureMsg>) => {
      const m = e.data;
      if (m.type === "start") { this.recording = true; this.fill = 0; }
      else if (m.type === "stop") { this.flush(); this.recording = false; this.port.postMessage({ type: "stopped" }); }
      else if (m.type === "channel") this.channel = m.channel;
    };
  }

  private flush(): void {
    if (!this.fill) return;
    const data = this.block.slice(0, this.fill);
    this.port.postMessage({ type: "chunk", frame: this.blockFrame, data }, [data.buffer]);
    this.fill = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;
    const input = inputs[0];
    const frames = input?.[0]?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      if (this.fill === 0) this.blockFrame = captureScope.currentFrame + i;
      let v = 0;
      if (input && input.length) {
        if (this.channel < 0) { for (let c = 0; c < input.length; c++) v += input[c][i]; v /= input.length; }
        else v = (input[Math.min(this.channel, input.length - 1)] ?? input[0])[i];
      }
      this.block[this.fill++] = v;
      if (this.fill === BLOCK) this.flush();
    }
    return true;
  }
}

captureScope.registerProcessor("dbdj-capture", CaptureProcessor);

/**
 * Teach Me: Live Looping — records straight off the lesson's own pad bus instead of a microphone, so Module 1
 * never needs mic permission. Implements `LooperInputSource` by reusing the exact same `dbdj-capture`
 * AudioWorklet Vocal Studio records with (src/audio/capture-processor.ts): the worklet doesn't care what's
 * connected to its input. Because the whole path (pad source → bus → capture) stays inside one AudioContext with
 * no real-world I/O, there is no round-trip latency to compensate — `latency` is always 0.
 */
import captureUrl from "../audio/capture-processor.ts?worker&url";

const loaded = new WeakSet<AudioContext>();

export class PadCapture {
  private node: AudioWorkletNode | null = null;
  private onChunk: ((c: { frame: number; data: Float32Array }) => void) | null = null;
  private onStopped: (() => void) | null = null;

  /** `bus` resolves to the shared AudioContext and the GainNode pad hits are already being played into. */
  constructor(private bus: () => Promise<{ context: AudioContext; node: GainNode }>) {}

  async beginCapture(onChunk?: (data: Float32Array, frame: number) => void): Promise<{ context: AudioContext; latency: number; stop(): Promise<{ data: Float32Array; start: number; rate: number }> }> {
    const { context: ctx, node: padBus } = await this.bus();
    if (!loaded.has(ctx)) { await ctx.audioWorklet.addModule(captureUrl); loaded.add(ctx); }
    if (!this.node || this.node.context !== ctx) {
      const capture = new AudioWorkletNode(ctx, "dbdj-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const sink = ctx.createGain(); sink.gain.value = 0; // must be pulled by the graph; never reaches the speakers
      padBus.connect(capture).connect(sink).connect(ctx.destination);
      capture.port.onmessage = (e: MessageEvent<{ type: string; frame?: number; data?: Float32Array }>) => {
        if (e.data.type === "chunk" && e.data.data) this.onChunk?.({ frame: e.data.frame!, data: e.data.data });
        else if (e.data.type === "stopped") this.onStopped?.();
      };
      this.node = capture;
    }
    const chunks: { frame: number; data: Float32Array }[] = [];
    let resolveStopped!: () => void; const stopped = new Promise<void>((r) => { resolveStopped = r; });
    this.onChunk = (c) => { chunks.push(c); onChunk?.(c.data, c.frame); };
    this.onStopped = resolveStopped;
    this.node.port.postMessage({ type: "start" });
    let done = false;
    return {
      context: ctx, latency: 0,
      stop: async () => {
        if (!done) { done = true; this.node!.port.postMessage({ type: "stop" }); await Promise.race([stopped, new Promise((r) => setTimeout(r, 500))]); this.onChunk = null; this.onStopped = null; }
        return { ...assemble(chunks, ctx.sampleRate), rate: ctx.sampleRate };
      },
    };
  }
  /** Pads have no live-monitor toggle to mute (they're always just played, never "input" in the mic sense). */
  setSettings(): void { /* no-op: satisfies LooperInputSource */ }
}

function assemble(chunks: { frame: number; data: Float32Array }[], rate: number): { data: Float32Array; start: number } {
  if (!chunks.length) return { data: new Float32Array(0), start: 0 };
  const total = chunks.reduce((n, c) => n + c.data.length, 0); const data = new Float32Array(total); let at = 0;
  for (const c of chunks) { data.set(c.data, at); at += c.data.length; }
  return { data, start: chunks[0].frame / rate };
}

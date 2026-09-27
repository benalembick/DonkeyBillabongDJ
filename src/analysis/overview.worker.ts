/**
 * Track analysis worker (off the UI and audio threads): 3-band waveform,
 * overview and tempo/beat-phase estimation. See analyzeTrack.ts.
 */
import { analyzeTrack } from "./analyzeTrack";

interface AnalysisRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  buckets: number;
  metaBpm: number | null;
}

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, channels, sampleRate, buckets, metaBpm } = e.data;
  const a = analyzeTrack(channels, sampleRate, buckets, metaBpm);
  (self as unknown as Worker).postMessage({ id, ...a }, [a.peaks.buffer, a.rms.buffer, a.low.buffer, a.mid.buffer, a.high.buffer]);
};

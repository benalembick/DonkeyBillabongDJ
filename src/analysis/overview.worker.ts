/**
 * Track analysis worker (off the UI and audio threads): 3-band waveform,
 * overview and tempo/beat-phase estimation. See analyzeTrack.ts.
 *
 * Also re-fits the beat grid of an already analysed track from its cached bands
 * (`refit` requests), so older analyses get the whole-track grid fit without
 * decoding the audio again. See gridFit.ts.
 */
import { analyzeTrack, DISPLAY_KEYS, refineBeats, type TrackAnalysis } from "./analyzeTrack";

interface AnalysisRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  buckets: number;
  metaBpm: number | null;
}
interface RefitRequest {
  id: number;
  refit: { low: Float32Array; mid: Float32Array; fps: number } & Pick<TrackAnalysis, "bpm" | "firstBeat" | "confidence" | "bpmSource">;
}

self.onmessage = (e: MessageEvent<AnalysisRequest | RefitRequest>) => {
  const { id } = e.data;
  try {
    if ("refit" in e.data) {
      const { low, mid, fps, bpm, firstBeat, confidence, bpmSource } = e.data.refit;
      (self as unknown as Worker).postMessage({ id, grid: refineBeats({ bpm, firstBeat, confidence, bpmSource }, low, mid, fps) });
      return;
    }
    const { channels, sampleRate, buckets, metaBpm } = e.data;
    const a = analyzeTrack(channels, sampleRate, buckets, metaBpm);
    const band = a.bands ? DISPLAY_KEYS.map((k) => a.bands![k].buffer) : [];
    (self as unknown as Worker).postMessage({ id, ...a }, [a.peaks.buffer, a.rms.buffer, a.low.buffer, a.mid.buffer, a.high.buffer, ...band]);
  } catch (error) { (self as unknown as Worker).postMessage({ id, error: String(error) }); }
};

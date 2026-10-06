/** Pitch tracking off the UI thread (Vocal Studio Phase 2). */
import { trackPitch } from "./pitchTrack";

self.onmessage = async (e: MessageEvent<{ id: number; data: Float32Array; rate: number }>) => {
  const { id, data, rate } = e.data;
  const track = await trackPitch(data, rate, { onProgress: (p) => (self as unknown as Worker).postMessage({ id, progress: p }) });
  (self as unknown as Worker).postMessage({ id, track }, [track.f0.buffer, track.clarity.buffer, track.levelDb.buffer]);
};

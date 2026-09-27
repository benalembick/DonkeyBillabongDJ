/**
 * Track analysis worker (off the UI and audio threads).
 * Phase 1: overview waveform peaks. Phase 2 adds BPM / beat grid / key here.
 */
interface OverviewRequest {
  id: number;
  channels: Float32Array[];
  buckets: number;
}

self.onmessage = (e: MessageEvent<OverviewRequest>) => {
  const { id, channels, buckets } = e.data;
  const len = channels[0]?.length ?? 0;
  const peaks = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  if (len > 0) {
    const per = len / buckets;
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(len, Math.floor((b + 1) * per));
      let p = 0;
      let s = 0;
      for (const ch of channels) {
        for (let i = start; i < end; i++) {
          const v = ch[i];
          const a = v < 0 ? -v : v;
          if (a > p) p = a;
          s += v * v;
        }
      }
      peaks[b] = p;
      rms[b] = Math.sqrt(s / Math.max(1, (end - start) * channels.length));
    }
  }
  (self as unknown as Worker).postMessage({ id, peaks, rms }, [peaks.buffer, rms.buffer]);
};

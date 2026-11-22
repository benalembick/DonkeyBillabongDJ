import type { TrackAnalysis } from "../src/analysis/analyzeTrack";
import type { SetTrack } from "../src/setstudio/types";

/** Synthetic cached-analysis envelopes (150 fps), like the worker produces. */
export function synth(o: { seconds?: number; kickEvery?: number; hatEvery?: number; pad?: number; kick?: number; hat?: number; high?: number; floor?: number; bpm?: number | null; key?: string | null }): TrackAnalysis {
  const fps = 150, n = Math.round((o.seconds ?? 120) * fps);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  const floor = o.floor ?? 0.02;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    let l = floor + (o.pad ?? 0) * 0.6, m = floor + (o.pad ?? 0) * 0.5, h = (o.high ?? 0.01) + (o.pad ?? 0) * 0.05;
    if (o.kickEvery) { const ph = t % o.kickEvery; l += (o.kick ?? 0.5) * Math.exp(-ph / 0.06); }
    if (o.hatEvery) { const ph = t % o.hatEvery; const v = (o.hat ?? 0.15) * Math.exp(-ph / 0.02); m += v; h += v * 0.8; }
    low[i] = l; mid[i] = m; high[i] = h;
  }
  const buckets = 600, peaks = new Float32Array(buckets), rms = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) { let p = 0; for (let k = Math.floor((b * n) / buckets); k < Math.floor(((b + 1) * n) / buckets); k++) p = Math.max(p, low[k], mid[k], high[k]); peaks[b] = p; rms[b] = p * 0.7; }
  return { peaks, rms, low, mid, high, fps, bpm: o.bpm === undefined ? 124 : o.bpm, firstBeat: 0, confidence: o.kickEvery ? 2.4 : 1.1, bpmSource: "analysis", key: o.key ?? null, keyConfidence: 0.5, energy: 5, energyConfidence: 0.5, gainDb: 0, peak: 1,
    sections: [{ kind: "intro", start: 0, end: 16, confidence: 0.6, energy: 3 }, { kind: "drop", start: 32, end: 60, confidence: 0.7, energy: 8 }, { kind: "outro", start: (o.seconds ?? 120) - 20, end: o.seconds ?? 120, confidence: 0.6, energy: 3 }],
    recommendedCues: [], hotCueSuggestions: [] };
}

let n = 0;
export function track(p: Partial<SetTrack> & { ref?: string } = {}): SetTrack {
  const ref = p.ref ?? `t${++n}.mp3`;
  return { ref, trackId: `sha256:${ref}`, title: ref, artist: "A", durationSec: 360, bpm: 124, key: null, camelot: "8A", energy: 6, energySource: "intel", genre: "House", subgenre: null, moods: [], brightness: 0.5, bassIntensity: 0.5, vocalPresence: null, danceability: 0.7, introSec: 16, outroSec: 16, analysed: true, available: true, ...p };
}

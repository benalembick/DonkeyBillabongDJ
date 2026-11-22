/**
 * Static colour waveform of a time window of one track, drawn from the cached analysis with the app's
 * own waveform colouring (waveStyle: low/mid/high → RGB). Re-rendered only when the window or size changes.
 */
import { useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import type { TrackAnalysis } from "../../analysis/analyzeTrack";
import { column, newColumn, rgbColor, waveData } from "../waveStyle";

/** Cached analysis of a track (loaded once per trackId). */
export function useWaveform(trackId: string | null | undefined): TrackAnalysis | null {
  const app = useApp();
  const [w, setW] = useState<{ id: string; a: TrackAnalysis | null } | null>(null);
  useEffect(() => {
    if (!trackId) return;
    let live = true;
    void app.preparation.waveform(trackId).then((a) => { if (live) setW({ id: trackId, a }); }).catch(() => { if (live) setW({ id: trackId, a: null }); });
    return () => { live = false; };
  }, [app.preparation, trackId]);
  return w && w.id === trackId ? w.a : null;
}

export function WaveCanvas({ analysis, from, to, height, mirror = true, dim = false }: { analysis: TrackAnalysis | null; from: number; to: number; height: number; mirror?: boolean; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current?.parentElement; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(50, Math.floor(el.clientWidth))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(width * dpr); c.height = Math.floor(height * dpr);
    const g = c.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, height);
    if (!analysis) { g.fillStyle = "#1a2029"; g.fillRect(0, height / 2 - 0.5, width, 1); return; }
    const d = waveData(analysis), col = newColumn(), span = Math.max(0.001, to - from), mid = mirror ? height / 2 : height;
    g.globalAlpha = dim ? 0.45 : 1;
    for (let x = 0; x < width; x++) {
      const t0 = from + (x / width) * span, t1 = from + ((x + 1) / width) * span;
      if (t1 < 0) continue;
      column(d, Math.floor(t0 * d.fps), Math.max(Math.floor(t0 * d.fps) + 1, Math.ceil(t1 * d.fps)), col);
      const a = Math.max(col.L[0], col.R[0]) / (d.normAll || 1);
      if (a <= 0) continue;
      const h = Math.min(1, a) * (mirror ? height / 2 - 1 : height - 1);
      g.fillStyle = rgbColor(Math.max(col.L[1], col.R[1]), Math.max(col.L[2], col.R[2]), Math.max(col.L[3], col.R[3]));
      g.fillRect(x, mid - h, 1, mirror ? h * 2 : h);
    }
  }, [analysis, from, to, width, height, mirror, dim]);
  return <canvas ref={ref} className="ss-wave" style={{ width: "100%", height }} />;
}

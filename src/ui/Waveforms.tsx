/**
 * Waveform views, all drawn on canvas every animation frame straight from the
 * engine (no React re-renders while playing):
 *  - ScrollingWaveform: 3-band colour waveform around the playhead with beat
 *    grid (beats + bars), cue / hot-cue markers; horizontal or vertical.
 *  - OverviewWaveform: whole track, played region, markers, click-to-seek.
 * Colours: low = blue, mid = orange, high = white (frequency, not deck).
 */
import { useEffect, useRef, useState } from "react";
import type { Overview } from "../analysis/AnalysisService";
import { deckLetter } from "../core/actions";
import { useApp, useSend } from "./context";
import { useAnimationFrame } from "./hooks";
import { HOTCUE_COLORS, useLayout, zoom } from "./layout";

const LOW = "#2f6dff";
const MID = "#ff9c1a";
const HIGH = "#ffffff";

/** Draw-time stats for diagnostics (ms per waveform frame). */
export const waveStats = {
  samples: [] as number[],
  record(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > 240) this.samples.shift();
  },
  avg(): number {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  },
};
(globalThis as unknown as { __waveStats: typeof waveStats }).__waveStats = waveStats;

function useOverview(deck: number): Overview | null {
  const { analysis } = useApp();
  const [ov, setOv] = useState<Overview | null>(analysis.get(deck));
  useEffect(() => {
    setOv(analysis.get(deck));
    return analysis.on("overview", (e) => {
      if (e.deck === deck) setOv(e.overview);
    });
  }, [analysis, deck]);
  return ov;
}

/** Normalisation: 99.5th percentile of the loudest band, so one spike doesn't flatten the view. */
function normFor(ov: Overview): number {
  const n = ov.low.length;
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) sample.push(Math.max(ov.low[i], ov.mid[i], ov.high[i]));
  sample.sort((a, b) => a - b);
  return sample[Math.floor(sample.length * 0.995)] || 1;
}

const TILE_PX = 1024;

/** Render one waveform tile (TILE_PX along the time axis) starting at `startSec`. */
function renderTile(ov: Overview, startSec: number, secPerPx: number, cross: number, vertical: boolean, scale: number, mid: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = vertical ? cross : TILE_PX;
  c.height = vertical ? TILE_PX : cross;
  const g = c.getContext("2d")!;
  const fps = ov.fps;
  const n = ov.low.length;
  const e = new Float32Array(TILE_PX * 3);
  for (let p = 0; p < TILE_PX; p++) {
    const ta = startSec + p * secPerPx;
    let i0 = Math.floor(ta * fps);
    let i1 = Math.max(i0 + 1, Math.floor((ta + secPerPx) * fps));
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    let lo = 0;
    let md = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      if (ov.low[i] > lo) lo = ov.low[i];
      if (ov.mid[i] > md) md = ov.mid[i];
      if (ov.high[i] > hi) hi = ov.high[i];
    }
    e[p] = Math.min(mid, (lo + md * 0.5) * scale);
    e[TILE_PX + p] = Math.min(mid, md * scale * 0.9);
    e[2 * TILE_PX + p] = Math.min(mid, hi * scale * 0.75);
  }
  const band = (offset: number, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    for (let p = 0; p <= TILE_PX; p++) {
      const h = e[offset + Math.min(p, TILE_PX - 1)];
      if (vertical) g.lineTo(mid - h, p);
      else g.lineTo(p, mid - h);
    }
    for (let p = TILE_PX; p >= 0; p--) {
      const h = e[offset + Math.min(p, TILE_PX - 1)];
      if (vertical) g.lineTo(mid + h, p);
      else g.lineTo(p, mid + h);
    }
    g.closePath();
    g.fill();
  };
  band(0, LOW);
  band(TILE_PX, MID);
  band(2 * TILE_PX, HIGH);
  return c;
}

function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return { w, h, dpr };
}

export function ScrollingWaveform({ deck, orientation }: { deck: number; orientation: "horizontal" | "vertical" }) {
  const { engine } = useApp();
  const ov = useOverview(deck);
  const { zoomSeconds } = useLayout();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const norm = useRef(1);
  const drag = useRef<{ start: number; pos: number } | null>(null);
  const tiles = useRef<{ key: string; ov: Overview | null; map: Map<number, HTMLCanvasElement> }>({ key: "", ov: null, map: new Map() });
  const send = useSend();
  useEffect(() => {
    norm.current = ov ? normFor(ov) : 1;
  }, [ov]);

  useAnimationFrame(() => {
    const c = canvasRef.current;
    if (!c) return;
    const tStart = performance.now();
    try {
      drawFrame(c);
    } finally {
      waveStats.record(performance.now() - tStart);
    }
  });

  const drawFrame = (c: HTMLCanvasElement) => {
    const g = c.getContext("2d")!;
    const { w, h, dpr } = fitCanvas(c);
    const vertical = orientation === "vertical";
    const len = vertical ? h : w; // time axis length (px)
    const cross = vertical ? w : h; // amplitude axis
    g.clearRect(0, 0, w, h);
    const d = engine.getState().decks[deck];
    if (!d || d.status !== "ready") {
      g.fillStyle = "#5b6473";
      g.font = `${11 * dpr}px system-ui`;
      g.fillText(d?.status === "loading" ? "Loading…" : `Deck ${deckLetter(deck)} — empty`, 8 * dpr, 16 * dpr);
      return;
    }
    const pos = engine.getPosition(deck);
    const secPerPx = zoomSeconds / len;
    const playheadPx = len * 0.5;
    const t0 = pos - playheadPx * secPerPx;
    const mid = cross / 2;
    const scale = (mid * 0.95) / norm.current;

    // Waveform: pre-rendered tiles (cached per zoom/size/track) blitted each frame —
    // two cheap image copies per lane instead of re-rasterising the waveform every frame.
    if (ov) {
      const cacheKey = `${orientation}|${secPerPx.toFixed(7)}|${cross}|${ov.low.length}`;
      if (tiles.current.key !== cacheKey || tiles.current.ov !== ov) tiles.current = { key: cacheKey, ov, map: new Map() };
      const tileSec = TILE_PX * secPerPx;
      const first = Math.floor(t0 / tileSec);
      const last = Math.floor((t0 + len * secPerPx) / tileSec);
      for (let ti = first; ti <= last; ti++) {
        if (ti < 0 || ti * tileSec > d.duration) continue;
        let tile = tiles.current.map.get(ti);
        if (!tile) {
          tile = renderTile(ov, ti * tileSec, secPerPx, cross, vertical, scale, mid);
          tiles.current.map.set(ti, tile);
          if (tiles.current.map.size > 24) tiles.current.map.delete(tiles.current.map.keys().next().value!);
        }
        const at = Math.round((ti * tileSec - t0) / secPerPx);
        if (vertical) g.drawImage(tile, 0, at);
        else g.drawImage(tile, at, 0);
      }
    }

    // Beat grid: thin beat lines, stronger bar lines (every 4 beats from the first beat).
    const grid = d.beatGrid;
    if (grid) {
      const period = 60 / grid.bpm;
      let k = Math.ceil((t0 - grid.firstBeat) / period);
      for (let t = grid.firstBeat + k * period; t < t0 + len * secPerPx; t += period, k++) {
        const p = (t - t0) / secPerPx;
        const isBar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = isBar ? "rgba(255,70,70,0.85)" : "rgba(255,255,255,0.22)";
        const thick = isBar ? 2 * dpr : 1;
        if (vertical) g.fillRect(0, p, isBar ? cross : cross * 0.12, thick);
        else g.fillRect(p, 0, thick, isBar ? cross : cross * 0.12);
        if (isBar && !vertical) g.fillRect(p, cross - cross * 0.12, thick, cross * 0.12);
      }
    }

    // Cue + hot cue markers.
    const marker = (t: number, color: string, label: string) => {
      const p = (t - t0) / secPerPx;
      if (p < -20 || p > len + 20) return;
      g.fillStyle = color;
      if (vertical) {
        g.fillRect(0, p - dpr, cross, 2 * dpr);
        g.fillRect(0, p - 6 * dpr, 12 * dpr, 12 * dpr);
      } else {
        g.fillRect(p - dpr, 0, 2 * dpr, cross);
        g.beginPath();
        g.moveTo(p - 6 * dpr, 0);
        g.lineTo(p + 6 * dpr, 0);
        g.lineTo(p, 8 * dpr);
        g.fill();
      }
      if (label) {
        g.fillStyle = "#000";
        g.font = `bold ${9 * dpr}px system-ui`;
        if (vertical) g.fillText(label, 3 * dpr, p + 3 * dpr);
        else g.fillText(label, p + 3 * dpr, 17 * dpr);
      }
    };
    marker(d.cuePoint, "#ffd166", "");
    d.hotcues.forEach((hc, i) => hc != null && marker(hc, HOTCUE_COLORS[i], String(i + 1)));

    // Playhead.
    g.fillStyle = "#ff2d2d";
    if (vertical) g.fillRect(0, playheadPx - dpr, cross, 2 * dpr);
    else g.fillRect(playheadPx - dpr, 0, 2 * dpr, cross);
  };

  return (
    <canvas
      ref={canvasRef}
      className={`scroll-wave ${orientation}`}
      title="Scroll to zoom · drag to move the track while paused"
      onWheel={(e) => zoom(e.deltaY > 0 ? 1 : -1)}
      onPointerDown={(e) => {
        const d = engine.getState().decks[deck];
        if (!d || d.status !== "ready" || d.playing) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { start: orientation === "vertical" ? e.clientY : e.clientX, pos: engine.getPosition(deck) };
      }}
      onPointerMove={(e) => {
        const dr = drag.current;
        const c = canvasRef.current;
        if (!dr || !c) return;
        const len = orientation === "vertical" ? c.clientHeight : c.clientWidth;
        const delta = ((orientation === "vertical" ? e.clientY : e.clientX) - dr.start) * (zoomSeconds / len);
        const d = engine.getState().decks[deck];
        const target = Math.max(0, Math.min(d.duration, dr.pos - delta));
        send(`deck${deck + 1}.seek`, target / d.duration);
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

export function OverviewWaveform({ deck }: { deck: number }) {
  const { engine } = useApp();
  const ov = useOverview(deck);
  const send = useSend();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const baseKey = useRef("");

  useAnimationFrame(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext("2d")!;
    // Static colour waveform is cached per (track analysis, size).
    const key = `${w}x${h}:${ov ? ov.low.length : 0}`;
    if (baseKey.current !== key) {
      baseKey.current = key;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const og = off.getContext("2d")!;
      if (ov) {
        const n = ov.low.length;
        const norm = normFor(ov);
        const base = h * 0.92;
        for (let x = 0; x < w; x++) {
          const i0 = Math.floor((x / w) * n);
          const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
          let lo = 0;
          let md = 0;
          let hi = 0;
          for (let i = i0; i < i1; i++) {
            if (ov.low[i] > lo) lo = ov.low[i];
            if (ov.mid[i] > md) md = ov.mid[i];
            if (ov.high[i] > hi) hi = ov.high[i];
          }
          const s = base / norm;
          og.fillStyle = LOW;
          og.fillRect(x, base - Math.min(base, (lo + md * 0.5) * s), 1, Math.min(base, (lo + md * 0.5) * s));
          og.fillStyle = MID;
          og.fillRect(x, base - Math.min(base, md * s * 0.9), 1, Math.min(base, md * s * 0.9));
          og.fillStyle = HIGH;
          og.fillRect(x, base - Math.min(base, hi * s * 0.7), 1, Math.min(base, hi * s * 0.7));
        }
      }
      baseRef.current = off;
    }
    g.clearRect(0, 0, w, h);
    if (baseRef.current) g.drawImage(baseRef.current, 0, 0);
    const d = engine.getState().decks[deck];
    if (!d || d.duration <= 0) return;
    const x = (t: number) => (t / d.duration) * w;
    const pos = engine.getPosition(deck);
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(0, 0, x(pos), h);
    g.fillStyle = "#ffd166";
    g.fillRect(x(d.cuePoint), 0, 2 * dpr, h);
    d.hotcues.forEach((hc, i) => {
      if (hc == null) return;
      g.fillStyle = HOTCUE_COLORS[i];
      g.fillRect(x(hc) - dpr, 0, 2 * dpr, h);
    });
    g.fillStyle = "#ff2d2d";
    g.fillRect(x(pos) - dpr, 0, 2 * dpr, h);
  });

  return (
    <canvas
      ref={canvasRef}
      className="overview"
      title="Click to jump (when paused)"
      onPointerDown={(e) => {
        const d = engine.getState().decks[deck];
        if (!d || d.duration <= 0 || d.playing) return; // safety: no accidental jumps while playing
        const r = (e.target as HTMLElement).getBoundingClientRect();
        send(`deck${deck + 1}.seek`, (e.clientX - r.left) / r.width);
      }}
    />
  );
}

/** Two decks' scrolling waveforms, aligned on the same playhead (for beat-matching by eye). */
export function WaveformStack({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const labels = [0, 1];
  return (
    <div className={`wave-stack ${orientation}`}>
      {labels.map((deck) => (
        <div key={deck} className={`wave-lane deck-${deckLetter(deck).toLowerCase()}`}>
          <span className="wave-label">{deckLetter(deck)}</span>
          <ScrollingWaveform deck={deck} orientation={orientation} />
          <BarCounter deck={deck} />
        </div>
      ))}
    </div>
  );
}

/** "12.3 Bars" readout like hardware players: bars+beats since the first beat. */
function BarCounter({ deck }: { deck: number }) {
  const { engine } = useApp();
  const ref = useRef<HTMLSpanElement>(null);
  useAnimationFrame(() => {
    const d = engine.getState().decks[deck];
    if (!ref.current) return;
    if (!d?.beatGrid) {
      ref.current.textContent = "";
      return;
    }
    const beats = (engine.getPosition(deck) - d.beatGrid.firstBeat) / (60 / d.beatGrid.bpm);
    const bar = Math.floor(beats / 4) + 1;
    const beat = Math.floor(((beats % 4) + 4) % 4) + 1;
    ref.current.textContent = `${bar}.${beat} Bars`;
  });
  return <span ref={ref} className="bar-counter" />;
}

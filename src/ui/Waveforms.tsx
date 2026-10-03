/**
 * Waveform views, all drawn on canvas every animation frame straight from the
 * engine (no React re-renders while playing):
 *  - ScrollingWaveform: styled waveform around the playhead with beat
 *    grid (beats + bars), cue / hot-cue markers; horizontal or vertical.
 *  - OverviewWaveform: whole track, played region, markers, click-to-seek.
 * Colours come from the selected waveform style (see waveStyle.ts): Simple,
 * Filtered, RGB, RGB L/R or HSV — the same renderer for every view.
 */
import { useEffect, useRef, useState } from "react";
import type { Overview } from "../analysis/AnalysisService";
import { deckLetter } from "../core/actions";
import { useApp, useSend } from "./context";
import { useAnimationFrame } from "./hooks";
import { HOTCUE_COLORS, STEM_COLORS, setLayout, useLayout, zoom } from "./layout";
import { column, deckEq, drawColumn, EqSmoother, newColumn, PixelSink, waveData, type EqGains, type WaveData, type WaveStyle } from "./waveStyle";
import type { StemEnvelopes } from "../stems/StemService";
import { transitionRegion } from "../autodj/transition";


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

const TILE_PX = 1024;

/** Render one waveform tile (TILE_PX along the time axis) starting at `startSec`, in the chosen style. */
interface Tile {
  canvas: HTMLCanvasElement;
  /** Pixel buffer kept with the tile so EQ changes redraw in place (no new canvas per frame). */
  sink?: PixelSink;
  eqKey: string;
}

function renderTile(wd: WaveData, style: WaveStyle, startSec: number, secPerPx: number, cross: number, vertical: boolean, eq: EqGains, reuse?: Tile): Tile {
  let c = reuse?.canvas;
  let sink = reuse?.sink;
  if (!c || !sink) {
    c = document.createElement("canvas");
    c.width = vertical ? cross : TILE_PX;
    c.height = vertical ? TILE_PX : cross;
    sink = new PixelSink(c.width, c.height);
  } else sink.clear();
  const g = c.getContext("2d")!;
  const col = newColumn();
  const mid = cross / 2;
  for (let p = 0; p < TILE_PX; p++) {
    const ta = startSec + p * secPerPx;
    const i0 = Math.floor(ta * wd.fps);
    const i1 = Math.max(i0 + 1, Math.floor((ta + secPerPx) * wd.fps));
    if (i1 <= 0 || i0 >= wd.n) continue;
    drawColumn(sink, style, column(wd, i0, i1, col), wd, p, mid, mid, vertical, eq);
  }
  g.putImageData(sink.img, 0, 0);
  return { canvas: c, sink, eqKey: "" };
}

const STEM_KEYS = ["vocals", "drums", "bass", "instruments"] as const;

/** Per-stem normalisation (98th percentile of analysed frames). */
function stemNorms(env: StemEnvelopes): number[] {
  return STEM_KEYS.map((k) => {
    const a = env[k];
    const s: number[] = [];
    const step = Math.max(1, Math.floor(a.length / 3000));
    for (let i = 0; i < a.length; i += step) if (a[i] > 0) s.push(a[i]);
    if (!s.length) return 1;
    s.sort((x, y) => x - y);
    return s[Math.floor(s.length * 0.98)] || 1;
  });
}

/** STEM view tile: four lanes (vocals, drums, bass, instruments); muted stems drawn dim. */
function renderStemTile(env: StemEnvelopes, norms: number[], muted: boolean[], startSec: number, secPerPx: number, cross: number, vertical: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = vertical ? cross : TILE_PX;
  c.height = vertical ? TILE_PX : cross;
  const g = c.getContext("2d")!;
  const fps = 1 / env.hop;
  const laneW = cross / 4;
  STEM_KEYS.forEach((k, lane) => {
    const a = env[k];
    const n = a.length;
    const mid = laneW * lane + laneW / 2;
    const s = (laneW * 0.48) / norms[lane];
    g.fillStyle = STEM_COLORS[k];
    g.globalAlpha = muted[lane] ? 0.18 : 0.95;
    g.beginPath();
    const hs = new Float32Array(TILE_PX + 1);
    for (let p = 0; p <= TILE_PX; p++) {
      const ta = startSec + p * secPerPx;
      let i0 = Math.floor(ta * fps);
      let i1 = Math.max(i0 + 1, Math.floor((ta + secPerPx) * fps));
      if (i0 < 0) i0 = 0;
      if (i1 > n) i1 = n;
      let m = 0;
      for (let i = i0; i < i1; i++) if (a[i] > m) m = a[i];
      hs[p] = Math.min(laneW * 0.49, m * s);
    }
    for (let p = 0; p <= TILE_PX; p++) (vertical ? g.lineTo(mid - hs[p], p) : g.lineTo(p, mid - hs[p]));
    for (let p = TILE_PX; p >= 0; p--) (vertical ? g.lineTo(mid + hs[p], p) : g.lineTo(p, mid + hs[p]));
    g.closePath();
    g.fill();
  });
  g.globalAlpha = 1;
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
  const eqSmooth = useRef(new EqSmoother());
  const tileEq = useRef<EqGains>([1, 1, 1]);
  const { engine, stems, autoDJ, transitions } = useApp();
  const ov = useOverview(deck);
  const { zoomSeconds, waveMode, waveStyle } = useLayout();
  const stemNorm = useRef<{ env: StemEnvelopes | null; version: number; norms: number[] }>({ env: null, version: -1, norms: [1, 1, 1, 1] });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number; last: number } | null>(null);
  const endScratch = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    engine.endScratch(deck);
  };
  const tiles = useRef<{ key: string; ov: Overview | null; env: StemEnvelopes | null; map: Map<number, Tile> }>({ key: "", ov: null, env: null, map: new Map() });

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
    // zoomSeconds describes output/listening time. Convert it to source-track
    // time with the live deck rate so waveform features and beat spacing both
    // contract when tempo rises and expand when tempo falls.
    const secPerPx = (zoomSeconds * Math.max(0.01, d.rate)) / len;
    const playheadPx = len * 0.5;
    const t0 = pos - playheadPx * secPerPx;
    const auto = autoDJ.getState();
    const planned = auto.status !== "OFF" && auto.plan && (deck === auto.deck || deck === 1 - auto.deck)
      ? transitionRegion(auto.plan, auto.deck, deck, d.rate, d.duration)
      : null;

    // Waveform: pre-rendered tiles (cached per zoom/size/track) blitted each frame —
    // two cheap image copies per lane instead of re-rasterising the waveform every frame.
    // STEM view: lanes per stem once separation data exists (tiles re-render as regions arrive).
    const env = waveMode === "stems" ? stems.envelopes(deck) : null;
    if (env) {
      const sn = stemNorm.current;
      if (sn.env !== env || sn.version !== env.version) stemNorm.current = { env, version: env.version, norms: stemNorms(env) };
    }
    const muted = d.stems.muted.map((m, k) => d.stems.enabled && (m || d.stems.volume[k] === 0));
    if (ov || env) {
      const trackKey = d.track?.trackId ?? d.track?.ref ?? `deck-${deck}`;
      const eq = eqSmooth.current.step(deckEq(engine.getState(), deck), performance.now());
      // EQ is not part of the cache key: tiles are redrawn in place when it changes (see below).
      const cacheKey = `${trackKey}|${orientation}|${secPerPx.toFixed(7)}|${cross}|${ov?.low.length ?? 0}|${ov?.bands ? "b" : "m"}|${env ? `stems:${env.version}:${muted.join()}` : waveStyle}`;
      const eqKey = env ? "" : eq.key;
      tileEq.current = eq.gains;
      if (tiles.current.key !== cacheKey || tiles.current.ov !== ov || tiles.current.env !== env) tiles.current = { key: cacheKey, ov, env, map: new Map() };
      const tileSec = TILE_PX * secPerPx;
      const first = Math.floor(t0 / tileSec);
      const last = Math.floor((t0 + len * secPerPx) / tileSec);
      for (let ti = first; ti <= last; ti++) {
        if (ti < 0 || ti * tileSec > d.duration) continue;
        let tile = tiles.current.map.get(ti);
        if (!tile || tile.eqKey !== eqKey) {
          tile = env
            ? { canvas: renderStemTile(env, stemNorm.current.norms, muted, ti * tileSec, secPerPx, cross, vertical), eqKey }
            : { ...renderTile(waveData(ov!), waveStyle, ti * tileSec, secPerPx, cross, vertical, tileEq.current, tile), eqKey };
          tiles.current.map.set(ti, tile);
          if (tiles.current.map.size > 24) tiles.current.map.delete(tiles.current.map.keys().next().value!);
        }
        const at = Math.round((ti * tileSec - t0) / secPerPx);
        if (vertical) g.drawImage(tile.canvas, 0, at);
        else g.drawImage(tile.canvas, at, 0);
      }
    }

    // The shaded interval uses the exact plan and deck playback rate used by Auto DJ.
    if (planned) {
      const a = (planned.start - t0) / secPerPx;
      const b = (planned.end - t0) / secPerPx;
      g.fillStyle = planned.role === "out" ? "rgba(255,159,67,.24)" : "rgba(46,229,157,.22)";
      if (vertical) g.fillRect(0, a, cross, b - a); else g.fillRect(a, 0, b - a, cross);
    }

    // Beat grid: full-span high-contrast lines so both decks can be aligned by
    // eye. Bar/downbeat boundaries are brighter and thicker than other beats.
    const grid = d.beatGrid;
    if (grid && !document.documentElement.classList.contains("practice-hide-grid")) {
      const period = 60 / grid.bpm;
      let k = Math.ceil((t0 - grid.firstBeat) / period);
      for (let t = grid.firstBeat + k * period; t < t0 + len * secPerPx; t += period, k++) {
        const p = (t - t0) / secPerPx;
        const isBar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = isBar ? "rgba(255,255,255,0.98)" : "rgba(255,255,255,0.68)";
        const thick = isBar ? Math.max(2, 2 * dpr) : Math.max(1, dpr);
        if (vertical) g.fillRect(0, Math.round(p - thick / 2), cross, thick);
        else g.fillRect(Math.round(p - thick / 2), 0, thick, cross);
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
    ov?.recommendedCues.forEach((cue) => marker(cue.timestamp, cue.kind === "mix-in" ? "#2ee59d" : cue.kind === "mix-out" ? "#ff9f43" : "#bf5af2", cue.label.replace("Recommended ", "")));
    if (planned) marker(planned.start, planned.role === "out" ? "#ff9f43" : "#2ee59d", planned.label);
    marker(d.cuePoint, "#ffd166", "");
    d.hotcues.forEach((hc, i) => hc != null && marker(hc, HOTCUE_COLORS[i], String(i + 1)));
    // The open Transitions plan: where B starts, the bass swap, where A is out (labels, not just colour).
    for (const m of transitions.markersFor(d.track?.trackId)) marker(m.t, m.colour, m.label);

    // Loop region (green when active, grey when stored for RELOOP).
    if (d.loop) {
      const a = (d.loop.start - t0) / secPerPx;
      const b = (d.loop.end - t0) / secPerPx;
      g.fillStyle = d.loop.active ? "rgba(46,229,157,0.22)" : "rgba(160,170,180,0.14)";
      if (vertical) g.fillRect(0, a, cross, b - a);
      else g.fillRect(a, 0, b - a, cross);
      g.fillStyle = d.loop.active ? "#2ee59d" : "#8a93a4";
      for (const p of [a, b]) {
        if (vertical) g.fillRect(0, p - dpr, cross, 2 * dpr);
        else g.fillRect(p - dpr, 0, 2 * dpr, cross);
      }
    }

    // Playhead.
    g.fillStyle = "#ff2d2d";
    if (vertical) g.fillRect(0, playheadPx - dpr, cross, 2 * dpr);
    else g.fillRect(playheadPx - dpr, 0, 2 * dpr, cross);
  };

  return (
    <canvas
      ref={canvasRef}
      className={`scroll-wave ${orientation}`}
      title="Drag to scratch (like a hand on the record) · scroll to zoom"
      onWheel={(e) => zoom(e.deltaY > 0 ? 1 : -1)}
      // Scratch: the waveform under the pointer moves with it, like the record under your hand.
      // Holding still stops the sound; letting go carries on playing (or stays paused).
      onPointerDown={(e) => {
        if (e.button !== 0 || !engine.beginScratch(deck)) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, last: orientation === "vertical" ? e.clientY : e.clientX };
      }}
      onPointerMove={(e) => {
        const dr = drag.current;
        const c = canvasRef.current;
        if (!dr || dr.id !== e.pointerId || !c) return;
        const at = orientation === "vertical" ? e.clientY : e.clientX;
        const len = orientation === "vertical" ? c.clientHeight : c.clientWidth;
        const d = engine.getState().decks[deck];
        // Same scale as the drawing: dragging right/down pulls earlier audio under the playhead.
        engine.scratchBy(deck, -(at - dr.last) * ((zoomSeconds * Math.max(0.01, d.rate)) / Math.max(1, len)));
        dr.last = at;
      }}
      onPointerUp={endScratch}
      onPointerCancel={endScratch}
      onLostPointerCapture={endScratch}
    />
  );
}

export function OverviewWaveform({ deck }: { deck: number }) {
  const eqSmooth = useRef(new EqSmoother());
  const baseSink = useRef<PixelSink | null>(null);
  const { engine, autoDJ } = useApp();
  const { waveStyle } = useLayout();
  const ov = useOverview(deck);
  const send = useSend();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrubbing = useRef(false);
  const lastSeek = useRef({ at: 0, frac: -1 });
  /** Seek to the pointer position; play state is untouched (playing keeps playing). */
  const seekAt = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const now = performance.now();
    // Scrubbing: at most ~30 seeks/s, and only when the position really moved.
    if (e.type === "pointermove" && (now - lastSeek.current.at < 33 || Math.abs(frac - lastSeek.current.frac) < 0.0005)) return;
    lastSeek.current = { at: now, frac };
    send(`deck${deck + 1}.seek`, frac);
  };
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const baseKey = useRef("");
  useEffect(() => {
    // A new track can have the same duration/frame count as the previous one.
    // Discard the raster rather than mistaking equal array lengths for equal audio.
    baseKey.current = "";
    baseRef.current = null;
  }, [ov]);

  useAnimationFrame(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext("2d")!;
    const d = engine.getState().decks[deck];
    const trackKey = d?.track?.trackId ?? d?.track?.ref ?? "empty";
    // Static colour waveform is cached per track, analysis and size. Array
    // length alone is not unique: similarly sized songs often have equal frames.
    const eq = eqSmooth.current.step(deckEq(engine.getState(), deck), performance.now());
    const key = `${deck}:${trackKey}:${w}x${h}:${ov ? `${ov.low.length}:${ov.fps}:${ov.bands ? "b" : "m"}` : "none"}:${waveStyle}:${eq.key}`;
    if (baseKey.current !== key) {
      baseKey.current = key;
      let off = baseRef.current;
      if (!off || off.width !== w || off.height !== h) {
        off = document.createElement("canvas");
        off.width = w;
        off.height = h;
        baseSink.current = null;
      }
      const og = off.getContext("2d")!;
      og.clearRect(0, 0, w, h);
      if (ov) {
        // Same style renderer as the scrolling waveform, so both always match.
        const wd = waveData(ov);
        const col = newColumn();
        const sink = baseSink.current ?? new PixelSink(w, h);
        baseSink.current = sink;
        sink.clear();
        const centre = h * 0.5;
        for (let x = 0; x < w; x++) {
          const i0 = Math.floor((x / w) * wd.n);
          const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * wd.n));
          drawColumn(sink, waveStyle, column(wd, i0, i1, col), wd, x, centre, centre, false, eq.gains);
        }
        og.putImageData(sink.img, 0, 0);
      }
      baseRef.current = off;
    }
    g.clearRect(0, 0, w, h);
    if (baseRef.current) g.drawImage(baseRef.current, 0, 0);
    if (!d || d.duration <= 0) return;
    const x = (t: number) => (t / d.duration) * w;
    const pos = engine.getPosition(deck);
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(0, 0, x(pos), h);
    if (d.loop) {
      g.fillStyle = d.loop.active ? "rgba(46,229,157,0.35)" : "rgba(160,170,180,0.25)";
      g.fillRect(x(d.loop.start), 0, Math.max(2 * dpr, x(d.loop.end) - x(d.loop.start)), h);
    }
    const auto = autoDJ.getState();
    if (auto.status !== "OFF" && auto.plan && (deck === auto.deck || deck === 1 - auto.deck)) {
      const region = transitionRegion(auto.plan, auto.deck, deck, d.rate, d.duration);
      g.fillStyle = region.role === "out" ? "rgba(255,159,67,.3)" : "rgba(46,229,157,.28)";
      g.fillRect(x(region.start), 0, Math.max(2 * dpr, x(region.end) - x(region.start)), h);
      g.fillStyle = region.role === "out" ? "#ff9f43" : "#2ee59d";
      g.fillRect(x(region.start) - dpr, 0, 2 * dpr, h);
      g.font = `bold ${8 * dpr}px system-ui`; g.fillText(region.label, Math.min(w - 42 * dpr, x(region.start) + 3 * dpr), 9 * dpr);
    }
    if (ov) {
      for (const section of ov.sections) {
        const xa = x(section.start), xb = x(section.end);
        g.fillStyle = section.kind === "drop" || section.kind === "chorus" ? "rgba(255,90,40,.12)" : section.kind === "breakdown" ? "rgba(80,140,255,.12)" : "rgba(255,255,255,.035)";
        g.fillRect(xa, 0, Math.max(1, xb - xa), h);
      }
      for (const cue of ov.recommendedCues) {
        g.fillStyle = cue.kind === "mix-in" ? "#2ee59d" : cue.kind === "mix-out" ? "#ff9f43" : "#bf5af2";
        g.fillRect(x(cue.timestamp) - dpr, 0, 2 * dpr, h * .55);
      }
    }
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
      title="Click to jump · drag to scrub (keeps playing if playing)"
      onPointerDown={(e) => {
        const d = engine.getState().decks[deck];
        if (!d || d.status !== "ready" || d.duration <= 0) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        scrubbing.current = true;
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (scrubbing.current) seekAt(e);
      }}
      onPointerUp={() => (scrubbing.current = false)}
      onPointerCancel={() => (scrubbing.current = false)}
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
          <WaveModeToggle />
          <ScrollingWaveform deck={deck} orientation={orientation} />
          <BarCounter deck={deck} />
        </div>
      ))}
    </div>
  );
}

/** Standard (frequency colours) ⇄ STEM (vocals / drums / bass / instruments lanes). */
function WaveModeToggle() {
  const { waveMode } = useLayout();
  return (
    <button
      className={`tiny wave-mode ${waveMode === "stems" ? "lit" : ""}`}
      onClick={() => setLayout({ waveMode: waveMode === "stems" ? "standard" : "stems" })}
      title="Waveform: Standard (frequency) or STEM lanes (vocals, drums, bass, instruments)"
    >
      {waveMode === "stems" ? "STEM" : "STD"}
    </button>
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

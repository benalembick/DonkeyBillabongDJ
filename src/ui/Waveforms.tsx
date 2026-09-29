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
import { HOTCUE_COLORS, STEM_COLORS, setLayout, useLayout, zoom } from "./layout";
import type { StemEnvelopes } from "../stems/StemService";
import { transitionRegion } from "../autodj/transition";

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
  // One envelope per track, coloured by its real spectral balance. Painting
  // three opaque shapes on top of each other made the white high band hide
  // most track-specific detail, especially for beat-matched dance music.
  for (let p = 0; p < TILE_PX; p++) {
    const lo=e[p],md=e[TILE_PX+p],hi=e[2*TILE_PX+p];
    const height=Math.min(mid,Math.sqrt(lo*lo+md*md+hi*hi));
    const sum=lo+md+hi||1,lr=lo/sum,mr=md/sum,hr=hi/sum;
    const red=Math.round(35+210*mr+220*hr),green=Math.round(70+105*mr+185*hr),blue=Math.round(75+180*lr+170*hr);
    g.fillStyle=`rgb(${Math.min(255,red)},${Math.min(255,green)},${Math.min(255,blue)})`;
    if(vertical)g.fillRect(mid-height,p,Math.max(1,height*2),1);else g.fillRect(p,mid-height,1,Math.max(1,height*2));
  }
  return c;
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
  const { engine, stems, autoDJ } = useApp();
  const ov = useOverview(deck);
  const { zoomSeconds, waveMode } = useLayout();
  const stemNorm = useRef<{ env: StemEnvelopes | null; version: number; norms: number[] }>({ env: null, version: -1, norms: [1, 1, 1, 1] });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const norm = useRef(1);
  const drag = useRef<{ start: number; pos: number } | null>(null);
  const tiles = useRef<{ key: string; ov: Overview | null; env: StemEnvelopes | null; map: Map<number, HTMLCanvasElement> }>({ key: "", ov: null, env: null, map: new Map() });
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
    // zoomSeconds describes output/listening time. Convert it to source-track
    // time with the live deck rate so waveform features and beat spacing both
    // contract when tempo rises and expand when tempo falls.
    const secPerPx = (zoomSeconds * Math.max(0.01, d.rate)) / len;
    const playheadPx = len * 0.5;
    const t0 = pos - playheadPx * secPerPx;
    const mid = cross / 2;
    const scale = (mid * 0.95) / norm.current;
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
      const cacheKey = `${trackKey}|${orientation}|${secPerPx.toFixed(7)}|${cross}|${ov?.low.length ?? 0}|${env ? `stems:${env.version}:${muted.join()}` : "std"}`;
      if (tiles.current.key !== cacheKey || tiles.current.ov !== ov || tiles.current.env !== env) tiles.current = { key: cacheKey, ov, env, map: new Map() };
      const tileSec = TILE_PX * secPerPx;
      const first = Math.floor(t0 / tileSec);
      const last = Math.floor((t0 + len * secPerPx) / tileSec);
      for (let ti = first; ti <= last; ti++) {
        if (ti < 0 || ti * tileSec > d.duration) continue;
        let tile = tiles.current.map.get(ti);
        if (!tile) {
          tile = env ? renderStemTile(env, stemNorm.current.norms, muted, ti * tileSec, secPerPx, cross, vertical) : renderTile(ov!, ti * tileSec, secPerPx, cross, vertical, scale, mid);
          tiles.current.map.set(ti, tile);
          if (tiles.current.map.size > 24) tiles.current.map.delete(tiles.current.map.keys().next().value!);
        }
        const at = Math.round((ti * tileSec - t0) / secPerPx);
        if (vertical) g.drawImage(tile, 0, at);
        else g.drawImage(tile, at, 0);
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
    if (grid) {
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
        const d = engine.getState().decks[deck];
        const delta = ((orientation === "vertical" ? e.clientY : e.clientX) - dr.start) * ((zoomSeconds * Math.max(0.01, d.rate)) / len);
        const target = Math.max(0, Math.min(d.duration, dr.pos - delta));
        send(`deck${deck + 1}.seek`, target / d.duration);
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

export function OverviewWaveform({ deck }: { deck: number }) {
  const { engine, autoDJ } = useApp();
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
    const key = `${deck}:${trackKey}:${w}x${h}:${ov ? `${ov.low.length}:${ov.fps}` : "none"}`;
    if (baseKey.current !== key) {
      baseKey.current = key;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const og = off.getContext("2d")!;
      if (ov) {
        const n = ov.low.length;
        const norm = normFor(ov);
        const centre = h * 0.5;
        const scale = (centre * 0.94) / norm;
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
          // Draw a conventional centred waveform. Keeping the bands within
          // the available half-height preserves each track's dynamics instead
          // of flattening loud masters into a similar bottom-filled silhouette.
          const lowHeight = Math.min(centre * .96, (lo + md * .35) * scale);
          const midHeight = Math.min(centre * .9, md * scale * .78);
          const highHeight = Math.min(centre * .76, hi * scale * .58);
          og.fillStyle = LOW;
          og.fillRect(x, centre - lowHeight, 1, lowHeight * 2);
          og.fillStyle = MID;
          og.fillRect(x, centre - midHeight, 1, midHeight * 2);
          og.fillStyle = HIGH;
          og.fillRect(x, centre - highHeight, 1, highHeight * 2);
        }
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

/**
 * Energy Arc Map: target curve (draggable control points) vs actual track energies over set time.
 * Dashed/filled target, solid actual line with dots; vertical gap markers where they differ.
 */
import { useEffect, useId, useRef, useState } from "react";
import { curveAt, energyColour, fromEnergy, toEnergy } from "../../setstudio/curves";
import type { SetView } from "../../setstudio/SetStudioService";
import type { CurvePoint } from "../../setstudio/types";
import { fmtLong, GradientDefs } from "./shared";

const H = 150, PAD_L = 28, PAD_R = 10, PAD_T = 10, PAD_B = 20;

export function ArcMap({ view, selected, onSelect, onCurve, onGesture, compareEnergies }: {
  view: SetView; selected: number | null; onSelect: (i: number) => void;
  onCurve: (points: CurvePoint[]) => void; onGesture: (phase: "start" | "end") => void;
  /** Improve a Set: the original order's energies, drawn faintly for before/after. */
  compareEnergies?: (number | null)[];
}) {
  const uid = useId().replace(/:/g, "");
  const wrap = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800), [zoom, setZoom] = useState(1), [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const { set } = view, W = width * zoom, iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
  const span = Math.max(set.durationTargetSec, view.totalSec, 60);
  const X = (t: number) => PAD_L + (t / span) * iw, Y = (e: number) => PAD_T + (1 - (e - 1) / 9) * ih;
  const xToT = (x: number) => Math.max(0, Math.min(1, (x - PAD_L) / iw));
  const yToNorm = (y: number) => { const e = 1 + (1 - (y - PAD_T) / ih) * 9; return fromEnergy(Math.max(set.energyMin, Math.min(set.energyMax, e)), set.energyMin, set.energyMax); };
  const pts = set.curveControlPoints;
  let target = "";
  for (let i = 0; i <= 160; i++) { const x = i / 160; target += `${i ? "L" : "M"}${X(x * span).toFixed(1)},${Y(toEnergy(curveAt(pts, x), set.energyMin, set.energyMax)).toFixed(1)}`; }
  const area = `${target}L${X(span)},${PAD_T + ih}L${X(0)},${PAD_T + ih}Z`;
  const actual = view.slots.map((s) => (s.track?.energy != null ? { x: X((s.start + s.end) / 2), y: Y(s.track.energy), e: s.track.energy, i: s.index, gap: s.target !== null ? s.track.energy - s.target : 0 } : null));
  const line = actual.filter(Boolean).map((p, k) => `${k ? "L" : "M"}${p!.x.toFixed(1)},${p!.y.toFixed(1)}`).join("");
  const compare = compareEnergies?.map((e, i) => (e === null ? null : { x: X(((i + 0.5) / compareEnergies.length) * span), y: Y(e) })).filter(Boolean) ?? [];
  const local = (e: { clientX: number; clientY: number }) => { const r = svg.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const tickStep = span > 4 * 3600 ? 3600 : span > 2 * 3600 ? 1800 : span > 3600 ? 900 : 600;

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const p = local(e), next = pts.map((q, i) => (i === drag ? { x: i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.max(pts[i - 1].x + 0.01, Math.min(pts[i + 1].x - 0.01, xToT(p.x))), y: yToNorm(p.y) } : q));
    onCurve(next);
  };
  return (
    <div className="ss-arc">
      <div className="ss-arc-head">
        <span className="ss-label">ENERGY ARC MAP</span><span className="hint">drag points to reshape · double-click to add · right-click a point to remove</span>
        <span className="ss-legend"><i className="tgt" /> target <i className="act" /> actual{compareEnergies && <><i className="cmp" /> original</>}</span>
        <span className="ss-zoom"><button className="tiny" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} aria-label="Zoom out">－</button><output>{zoom.toFixed(1)}×</output><button className="tiny" onClick={() => setZoom((z) => Math.min(4, z * 1.5))} disabled={zoom >= 4} aria-label="Zoom in">＋</button></span>
      </div>
      <div className="ss-arc-scroll" ref={wrap}>
        <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Energy arc: ${view.slots.length} slots over ${fmtLong(span)}`}
          onPointerMove={move} onPointerUp={() => { if (drag !== null) { setDrag(null); onGesture("end"); } }} onPointerLeave={() => { if (drag !== null) { setDrag(null); onGesture("end"); } }}
          onDoubleClick={(e) => { const p = local(e); onGesture("start"); onCurve([...pts, { x: xToT(p.x), y: yToNorm(p.y) }]); onGesture("end"); }}>
          <defs><GradientDefs id={`a${uid}`} vertical /><linearGradient id={`f${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff4fb8" stopOpacity="0.22" /><stop offset="100%" stopColor="#38c8ff" stopOpacity="0.02" /></linearGradient></defs>
          {[2, 4, 6, 8, 10].map((e) => <g key={e}><line x1={PAD_L} x2={W - PAD_R} y1={Y(e)} y2={Y(e)} className="ss-grid" /><text x={4} y={Y(e) + 3} className="ss-axis">{e}</text></g>)}
          {Array.from({ length: Math.floor(span / tickStep) + 1 }, (_, k) => k * tickStep).map((t) => <text key={t} x={X(t)} y={H - 5} className="ss-axis" textAnchor="middle">{fmtLong(t) || "0"}</text>)}
          <rect x={PAD_L} y={PAD_T} width={iw * Math.min(1, set.durationTargetSec / span)} height={ih} className="ss-plan" />
          {view.slots.map((s) => <rect key={s.slot.id} x={X(s.start)} y={PAD_T} width={Math.max(1, X(s.end) - X(s.start) - 1)} height={ih} className={`ss-slotband${selected === s.index ? " sel" : ""}`} onClick={() => onSelect(s.index)} />)}
          <path d={area} fill={`url(#f${uid})`} pointerEvents="none" />
          <path d={target} fill="none" stroke={`url(#a${uid})`} strokeWidth={2} strokeDasharray="6 4" pointerEvents="none" />
          {compare.length > 1 && <path d={compare.map((p, k) => `${k ? "L" : "M"}${p!.x},${p!.y}`).join("")} className="ss-compare" />}
          {actual.map((p) => p && Math.abs(p.gap) >= 1 && <line key={`g${p.i}`} x1={p.x} x2={p.x} y1={p.y} y2={Y(p.e - p.gap)} className={`ss-gap${Math.abs(p.gap) >= 2 ? " big" : ""}`} />)}
          {line && <path d={line} fill="none" stroke="#e8ebf1" strokeWidth={1.6} strokeOpacity={0.85} pointerEvents="none" />}
          {actual.map((p) => p && <circle key={`a${p.i}`} cx={p.x} cy={p.y} r={selected === p.i ? 5.5 : 4} fill={energyColour(p.e)} stroke="#0a0b0e" strokeWidth={1.5} onClick={() => onSelect(p.i)}><title>{`Slot ${p.i + 1}: energy ${p.e.toFixed(1)}${p.gap ? ` (${p.gap > 0 ? "+" : ""}${p.gap.toFixed(1)} vs target)` : ""}`}</title></circle>)}
          {pts.map((q, i) => (
            <circle key={`c${i}`} cx={X(q.x * span)} cy={Y(toEnergy(q.y, set.energyMin, set.energyMax))} r={drag === i ? 7 : 5.5} className="ss-ctrl" tabIndex={0} role="slider" aria-label={`Curve point ${i + 1}`} aria-valuenow={toEnergy(q.y, set.energyMin, set.energyMax)} aria-valuemin={set.energyMin} aria-valuemax={set.energyMax}
              onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); onGesture("start"); setDrag(i); }}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => { e.preventDefault(); if (pts.length > 2 && i > 0 && i < pts.length - 1) { onGesture("start"); onCurve(pts.filter((_, k) => k !== i)); onGesture("end"); } }}
              onKeyDown={(e) => { const d = e.key === "ArrowUp" ? 0.05 : e.key === "ArrowDown" ? -0.05 : 0; if (d) { e.preventDefault(); onGesture("start"); onCurve(pts.map((p, k) => (k === i ? { ...p, y: Math.max(0, Math.min(1, p.y + d)) } : p))); onGesture("end"); } }} />
          ))}
          <line x1={X(set.durationTargetSec)} x2={X(set.durationTargetSec)} y1={PAD_T} y2={PAD_T + ih} className="ss-endline" />
        </svg>
      </div>
      <div className="ss-arc-foot"><span>Planned <b>{fmtLong(set.durationTargetSec)}</b></span><span>Tracks so far <b>{fmtLong(view.summary.durationSec)}</b></span><span>Energy range <b>{set.energyMin}–{set.energyMax}</b></span></div>
    </div>
  );
}

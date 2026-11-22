/** Shared AI Set Studio UI pieces: store hooks, energy gradient graphs, formatting. */
import { useCallback, useId } from "react";
import { useApp, useEngineState } from "../context";
import { useFrameStore } from "../hooks";
import { curveAt, curvePath, ENERGY_STOPS, energyColour } from "../../setstudio/curves";
import type { CurvePoint } from "../../setstudio/types";
import type { TransitionEval } from "../../setstudio/scoring";

export function useStudio() {
  const app = useApp();
  return useFrameStore(useCallback((cb) => app.setStudio.on("change", cb), [app.setStudio]), () => app.setStudio.getState());
}
export function useSets() {
  const app = useApp();
  return useFrameStore(useCallback((cb) => app.sets.on("change", cb), [app.sets]), () => app.sets.getState());
}
export function useIntel() {
  const app = useApp();
  return useFrameStore(useCallback((cb) => app.libraryIntel.on("change", cb), [app.libraryIntel]), () => app.libraryIntel.getState());
}
export function usePreview() {
  const app = useApp();
  return useFrameStore(useCallback((cb) => app.preview.on("change", cb), [app.preview]), () => app.preview.state);
}

/** Ref currently audible from a Set Studio ▶ (headphone preview, or the deck it started when there are no headphones). */
export function useAuditionRef(): string | null {
  const preview = usePreview(), studio = useStudio(), engine = useEngineState();
  if (preview.ref) return preview.ref;
  const a = studio.audition;
  return a?.where === "deck" && a.deck !== undefined && engine.decks[a.deck]?.playing && engine.decks[a.deck]?.track?.ref === a.ref ? a.ref : null;
}
export const PREVIEW_TIP = "Preview — headphones with 4-channel routing; otherwise plays on Deck A when nothing else is playing (press again to stop)";

export const fmtDur = (s: number | null | undefined) => {
  if (!s || !Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
};
export const fmtLong = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`; };
export const fmtE = (e: number | null | undefined) => (e === null || e === undefined ? "—" : e.toFixed(1));
export const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function GradientDefs({ id, vertical = false }: { id: string; vertical?: boolean }) {
  return (
    <linearGradient id={id} x1="0" y1={vertical ? "1" : "0"} x2={vertical ? "0" : "1"} y2="0">
      {ENERGY_STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
    </linearGradient>
  );
}

/** Small decorative curve (templates, set list thumbnails). Colour follows height = energy. */
export function CurveThumb({ points, width = 280, height = 110, dashed = false, energies }: { points: CurvePoint[]; width?: number; height?: number; dashed?: boolean; energies?: (number | null)[] }) {
  const uid = useId().replace(/:/g, "");
  const pad = 6, path = curvePath(points, width, height, 80, pad);
  const area = `${path}L${width - pad},${height - pad}L${pad},${height - pad}Z`;
  return (
    <svg className="ss-thumb" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <defs><GradientDefs id={`g${uid}`} vertical /><linearGradient id={`f${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff4fb8" stopOpacity="0.28" /><stop offset="100%" stopColor="#38c8ff" stopOpacity="0" /></linearGradient></defs>
      {!dashed && <path d={area} fill={`url(#f${uid})`} />}
      <path d={path} fill="none" stroke={dashed ? "#4fb6d8" : `url(#g${uid})`} strokeWidth={dashed ? 1.6 : 2.4} strokeDasharray={dashed ? "5 5" : undefined} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      {energies?.map((e, i) => e === null ? null : <circle key={i} cx={pad + ((i + 0.5) / energies.length) * (width - 2 * pad)} cy={pad + (1 - (e - 1) / 9) * (height - 2 * pad)} r={2.2} fill={energyColour(e)} />)}
    </svg>
  );
}

export function EnergyPill({ value, target }: { value: number | null; target?: number | null }) {
  const off = value !== null && target != null ? value - target : null;
  return (
    <span className="ss-energy" style={{ ["--ec" as string]: energyColour(value) }} title={target != null ? `Energy ${fmtE(value)} · target ${fmtE(target)}` : `Energy ${fmtE(value)}`}>
      <i />{fmtE(value)}{off !== null && Math.abs(off) >= 1 && <small className={off > 0 ? "up" : "down"}>{off > 0 ? "▲" : "▼"}{Math.abs(off).toFixed(1)}</small>}
    </span>
  );
}

export function TransitionChip({ t, onClick, active }: { t: TransitionEval | null; onClick?: () => void; active?: boolean }) {
  if (!t) return <button className="ss-tr empty" disabled title="Empty slot on one side">· · ·</button>;
  return (
    <button className={`ss-tr ${t.state}${active ? " active" : ""}`} onClick={onClick} title={`${t.score ?? "?"}% · ${t.keyRelation} · ${t.bpmDelta === null ? "tempo ?" : `${t.bpmDelta > 0 ? "+" : ""}${t.bpmDelta} BPM`} · energy ${t.energyDelta === null ? "?" : `${t.energyDelta > 0 ? "+" : ""}${t.energyDelta}`}`} aria-label={`Transition ${t.state}: ${t.primary}. Click for details`}>
      <span className="dot" />{t.confidence < 1 ? "~" : ""}{t.score ?? "?"}%<em>{t.primary}</em>
    </button>
  );
}

export { curveAt, energyColour };

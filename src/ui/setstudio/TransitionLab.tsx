/**
 * Transition Lab: two aligned waveforms over the transition timeline, A/B candidates, timing/tempo/EQ
 * controls, automation lanes, preview on the real decks and saving. Everything shown is computed from
 * the same configuration the preview and Auto DJ play.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { useFrameStore } from "../hooks";
import { ArtTile } from "../ArtTile";
import { EnergyPill } from "./shared";
import { rankCandidates } from "../../setstudio/scoring";
import { useWaveform, WaveCanvas } from "./WaveCanvas";
import { laneAt, MAX_CUT_DB, ratesFor, type AutomationPoint, type Band, type EqMode, type SyncMode, type TransitionConfig } from "../../setstudio/transitionModel";
import type { LabTrack } from "../../setstudio/TransitionLabService";
import { fixGridFor } from "../gridEditorStore";

const BARS = [4, 8, 16, 32];
const SYNC: [SyncMode, string][] = [["off", "Sync off"], ["beat", "Beat sync"], ["beat-phrase", "Beat + phrase sync"], ["manual", "Manual tempo"]];
const EQM: [EqMode, string][] = [["off", "EQ off"], ["automatic", "Automatic (Auto EQ)"], ["manual", "Manual curve"], ["preset", "Saved preset"]];
const fmt = (s: number) => `${s < 0 ? "−" : ""}${Math.floor(Math.abs(s) / 60)}:${(Math.abs(s) % 60).toFixed(1).padStart(4, "0")}`;

function useLab() {
  const app = useApp();
  return useFrameStore(useCallback((cb) => app.transitionLab.on("change", cb), [app.transitionLab]), () => app.transitionLab.getState());
}

export function TransitionLab({ request }: { request: { outRef?: string; inRef?: string; setId?: string | null; fromSlotId?: string | null; toSlotId?: string | null } | null }) {
  const app = useApp(), lab = app.transitionLab, s = useLab();
  useEffect(() => { if (request?.outRef && request.inRef) lab.open({ outRef: request.outRef, inRef: request.inRef, setId: request.setId, fromSlotId: request.fromSlotId, toSlotId: request.toSlotId }); }, [lab, request]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? lab.redo() : lab.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); lab.redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lab]);
  const c = lab.current;
  if (!s.out || !s.in || !c) return <PairPicker message={s.message} initialOut={request?.outRef ?? s.out?.ref ?? null} />;
  const r = ratesFor(c.config, s.out.timing, s.in.timing);
  return (
    <div className="ss-lab">
      <div className="ss-lab-head">
        <h2><span className="ss-bar" />TRANSITION LAB</h2>
        {s.setId && <span className="ss-chip">SET TRANSITION</span>}
        <span className="hint">Audition, compare and save how these two tracks blend. Preview and Auto DJ play exactly what you see.</span>
        <span className="ss-tb-group right">
          <button onClick={() => lab.undo()} disabled={!s.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
          <button onClick={() => lab.redo()} disabled={!s.canRedo} aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
          <button onClick={() => lab.swap()} title="Swap outgoing and incoming">⇄ Swap</button>
          <button onClick={() => lab.close()} title="Pick another pair">Change pair</button>
        </span>
      </div>
      {s.message && <div className="ss-msg" role="status">{s.message}</div>}
      <div className="ss-lab-decks">
        <DeckCard t={s.out} side="A · OUTGOING" rate={r.outRate} />
        <TempoBadge r={r} />
        <DeckCard t={s.in} side="B · INCOMING" rate={r.inRate} />
      </div>
      <Candidates />
      {c.unavailable && <p className="ss-msg warn">This preset needs {c.unavailable.replace(/^Needs /, "")}. Its timing fell back to the default positions.</p>}
      <AlignedWaves out={s.out} inc={s.in} config={c.config} outRate={r.outRate} inRate={r.inRate} time={s.preview.status === "idle" ? null : s.preview.time} />
      <div className="ss-lab-grid">
        <Controls config={c.config} out={s.out} inc={s.in} />
        <Lanes config={c.config} />
      </div>
      <PreviewBar />
      <SavePanel />
    </div>
  );
}

function PairPicker({ message, initialOut }: { message: string; initialOut: string | null }) {
  const app = useApp();
  const [out, setOut] = useState<string | null>(initialOut), [q, setQ] = useState("");
  const pool = useMemo(() => { const s = q.trim().toLowerCase(); return app.setStudio.pool().filter((t) => t.analysed && t.available && (!s || `${t.title} ${t.artist}`.toLowerCase().includes(s))); }, [app.setStudio, q]);
  const outT = out ? app.setStudio.profile(out) : null;
  // Incoming candidates ranked by the Phase 1 scorer against the outgoing track.
  const ranked = useMemo(() => (outT ? rankCandidates(pool.filter((t) => t.ref !== outT.ref), { prev: outT }, 200).ranked : []), [pool, outT]);
  return (
    <div className="ss-lab">
      <div className="ss-lab-head"><h2><span className="ss-bar" />TRANSITION LAB</h2><span className="hint">Choose the outgoing track, then the incoming one. From a set, use the transition chip between two slots.</span></div>
      {message && <p className="ss-msg warn">{message}</p>}
      <input className="ss-search wide" placeholder="Search analysed tracks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tracks" />
      <p className="ss-dock-ctx">{outT ? <>Outgoing: <b>{outT.title}</b> — now pick the incoming track <button className="tiny" onClick={() => setOut(null)}>change</button></> : "Pick the outgoing track"}</p>
      <div className="ss-mini-list tall">
        {(outT ? ranked.map((x) => x.track) : pool).slice(0, 120).map((t, i) => (
          <button key={t.ref} className="ss-mini-track" onClick={() => (outT ? app.transitionLab.open({ outRef: outT.ref, inRef: t.ref }) : setOut(t.ref))}>
            <ArtTile track={{ title: t.title, artist: t.artist, album: "", artworkUrl: t.artworkUrl }} size={26} /><span><b>{t.title}</b><small>{t.artist}</small></span><small>{t.bpm?.toFixed(0) ?? "—"} · {t.camelot ?? "—"}</small><EnergyPill value={t.energy} />{outT && <span className="ss-score mid">{ranked[i]?.score}%</span>}
          </button>))}
      </div>
    </div>
  );
}

function DeckCard({ t, side, rate }: { t: LabTrack; side: string; rate: number }) {
  const app = useApp();
  return (
    <div className="ss-lab-deck">
      <ArtTile track={{ title: t.title, artist: t.artist, album: "", artworkUrl: t.artworkUrl }} size={44} />
      <div><small className="ss-label">{side}</small><b>{t.title}</b><small>{t.artist}</small>
        <span className="ss-lab-facts"><span className="mono">{t.bpm?.toFixed(1) ?? "?"} BPM{Math.abs(rate - 1) > 0.0005 ? ` → ${((t.bpm ?? 0) * rate).toFixed(1)}` : ""}</span><span className="ss-key">{t.camelot ?? "—"}</span><EnergyPill value={t.energy} />{!t.timing.gridReliable && <button className="tiny ss-fix-grid" title="Beat sync needs a trusted grid. Opens the Beat grid editor on a deck to check and correct it." onClick={() => fixGridFor(app, t.ref)}>⚠ grid unreliable — Fix grid…</button>}{!t.autoCues && <span className="hint">no Auto Cue</span>}</span>
      </div>
    </div>
  );
}
function TempoBadge({ r }: { r: ReturnType<typeof ratesFor> }) {
  return <div className={`ss-lab-tempo${r.warning ? " warn" : ""}`}><b>{r.synced ? "⟷ SYNCED" : "UNSYNCED"}</b><small>B {r.inTempoPct > 0 ? "+" : ""}{r.inTempoPct}%{r.multiple !== 1 ? ` (×${r.multiple})` : ""}</small>{r.warning && <small>{r.warning}</small>}</div>;
}

function Candidates() {
  const app = useApp(), lab = app.transitionLab, s = useLab();
  const [cmp, setCmp] = useState(false);
  return (
    <div className="ss-cands">
      <div className="ss-cand-tabs" role="tablist" aria-label="Transition candidates">
        {s.candidates.map((c, i) => <button key={c.id} role="tab" aria-selected={i === s.selected} className={i === s.selected ? "on" : ""} onClick={() => lab.select(i)}>{c.label}{s.candidates.length > 1 && <span className="x" role="button" aria-label={`Remove ${c.label}`} onClick={(e) => { e.stopPropagation(); lab.removeCandidate(i); }}>×</span>}</button>)}
        <select value="" onChange={(e) => e.target.value && lab.addCandidate(e.target.value)} aria-label="Add candidate from preset"><option value="">＋ Add option…</option>{lab.allPresets().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button onClick={() => lab.duplicateCandidate()}>⧉ Duplicate</button>
        <button className={cmp ? "on" : ""} onClick={() => setCmp((v) => !v)}>Compare settings</button>
        <span className="ss-tb-group right"><label className="ss-inline">Preset <select value={lab.current?.config.presetId} onChange={(e) => lab.applyPreset(e.target.value)} aria-label="Apply preset">{lab.allPresets().map((p) => <option key={p.id} value={p.id} title={p.description}>{p.name}</option>)}{lab.current?.config.presetId === "custom" && <option value="custom">Custom (edited)</option>}</select></label></span>
      </div>
      {cmp && <table className="ss-cmp"><thead><tr><th />{s.candidates.map((c) => <th key={c.id}>{c.label}</th>)}</tr></thead><tbody>
        {([["Length", (x: TransitionConfig) => `${x.bars ?? "–"} bars · ${x.seconds.toFixed(1)} s`], ["Sync", (x: TransitionConfig) => x.syncMode], ["Key lock", (x: TransitionConfig) => (x.keyLock ? "on" : "off")], ["EQ", (x: TransitionConfig) => x.eqMode], ["Mix out", (x: TransitionConfig) => fmt(x.mixOut)], ["Mix in", (x: TransitionConfig) => fmt(x.mixIn)], ["Echo out", (x: TransitionConfig) => (x.effects.echoOut ? "yes" : "—")]] as const).map(([k, f]) => <tr key={k}><td>{k}</td>{s.candidates.map((c) => <td key={c.id}>{f(c.config)}</td>)}</tr>)}
      </tbody></table>}
      {cmp && <p className="hint">Scores don't decide which sounds better — preview each (switching keeps the playhead) and save the one you prefer.</p>}
    </div>
  );
}

/** Both tracks laid out on the transition's own clock: each pixel column = the same wall-clock moment. */
function AlignedWaves({ out, inc, config, outRate, inRate, time }: { out: LabTrack; inc: LabTrack; config: TransitionConfig; outRate: number; inRate: number; time: number | null }) {
  const app = useApp(), lab = app.transitionLab;
  const wa = useWaveform(out.trackId), wb = useWaveform(inc.trackId);
  const pre = Math.max(8, config.seconds * 0.4), post = Math.max(8, config.seconds * 0.4);
  const t0 = -pre, t1 = config.seconds + post, span = t1 - t0;
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ side: "out" | "in" | "end"; x0: number; v0: number } | null>(null);
  const X = (t: number) => `${((t - t0) / span) * 100}%`;
  const secPerPx = () => span / (box.current?.getBoundingClientRect().width || 1);
  const marks = (tr: LabTrack, start: number, rate: number) => {
    const out: { t: number; kind: "bar" | "phrase" | "cue"; label?: string; colour?: string }[] = [];
    const g = tr.timing; if (g.bpm && g.firstBeat !== null) { const bar = 240 / g.bpm, off = (g.phraseOffset ?? 0); for (let b = Math.ceil((start + t0 * rate - g.firstBeat) / bar); ; b++) { const pos = g.firstBeat + b * bar, tt = (pos - start) / rate; if (tt > t1) break; if (tt >= t0) out.push({ t: tt, kind: ((b - off) % 8 + 8) % 8 === 0 ? "phrase" : "bar" }); } }
    for (const h of tr.hotcues) { const tt = (h.t - start) / rate; if (tt >= t0 && tt <= t1) out.push({ t: tt, kind: "cue", label: String.fromCharCode(65 + h.slot), colour: h.colour }); }
    return out;
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dt = (e.clientX - drag.x0) * secPerPx();
    if (drag.side === "out") lab.movePoint("out", drag.v0 + dt * outRate, e.altKey ? "none" : config.syncMode === "off" ? "beat" : "bar");
    else if (drag.side === "in") lab.movePoint("in", drag.v0 - dt * inRate, e.altKey ? "none" : "beat");
    else if (out.bpm) lab.setBars(Math.max(1, Math.round((drag.v0 + dt) * outRate / (240 / out.bpm))));
  };
  const begin = (side: "out" | "in" | "end", e: React.PointerEvent, v0: number) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); lab.beginGesture(); setDrag({ side, x0: e.clientX, v0 }); };
  return (
    <div className="ss-aligned" ref={box} onPointerMove={move} onPointerUp={() => { if (drag) { setDrag(null); lab.endGesture(); } }}>
      <div className="ss-aligned-axis">{Array.from({ length: Math.floor(span / 4) + 1 }, (_, k) => Math.ceil(t0 / 4) * 4 + k * 4).filter((t) => t <= t1).map((t) => <small key={t} style={{ left: X(t) }}>{t === 0 ? "start" : `${t > 0 ? "+" : ""}${t}s`}</small>)}</div>
      <div className="ss-overlap" style={{ left: X(0), width: `${(config.seconds / span) * 100}%` }}><span>{config.bars ? `${config.bars} bars · ` : ""}{config.seconds.toFixed(1)} s overlap</span></div>
      {([["out", out, config.mixOut, outRate, wa], ["in", inc, config.mixIn, inRate, wb]] as const).map(([side, tr, start, rate, w]) => (
        <div key={side} className={`ss-aligned-row ${side}`} onPointerDown={(e) => begin(side, e, start)} title={side === "out" ? "Drag to move the mix-out point (Alt: no snapping)" : "Drag to move where the incoming track starts (Alt: no snapping)"}>
          <WaveCanvas analysis={w} from={start + t0 * rate} to={start + t1 * rate} height={64} dim={false} />
          {marks(tr, start, rate).map((m, i) => <i key={i} className={`ss-mark ${m.kind}`} style={{ left: X(m.t), ["--pc" as string]: m.colour }}>{m.label && <b>{m.label}</b>}</i>)}
          <span className="ss-row-label">{side === "out" ? `A  mix-out ${fmt(start)}` : `B  mix-in ${fmt(start)}`}</span>
        </div>
      ))}
      <div className="ss-end-handle" style={{ left: X(config.seconds) }} onPointerDown={(e) => begin("end", e, config.seconds)} title="Drag to change the transition length (bars)" />
      {time !== null && <i className="ss-playhead" style={{ left: X(Math.max(t0, Math.min(t1, time))) }} />}
    </div>
  );
}

function Controls({ config, out, inc }: { config: TransitionConfig; out: LabTrack; inc: LabTrack }) {
  const app = useApp(), lab = app.transitionLab;
  const echo = config.effects.echoOut;
  return (
    <div className="ss-lab-controls">
      <label>Length <span className="ss-seg">{BARS.map((b) => <button key={b} className={config.bars === b ? "on" : ""} onClick={() => lab.setBars(b)}>{b}</button>)}</span><input type="number" min={1} max={64} value={config.bars ?? ""} onChange={(e) => lab.setBars(Math.max(1, Number(e.target.value) || 16))} aria-label="Bars" /> bars · {config.seconds.toFixed(1)} s</label>
      <label>Start (A) <input type="number" step={0.1} value={config.mixOut.toFixed(2)} onChange={(e) => lab.movePoint("out", Number(e.target.value), "none")} aria-label="Mix-out seconds" /> s <button className="tiny" onClick={() => lab.movePoint("out", config.mixOut, "bar")}>snap bar</button><button className="tiny" onClick={() => lab.movePoint("out", config.mixOut, "phrase")}>snap phrase</button></label>
      <label>Mix-in (B) <input type="number" step={0.1} value={config.mixIn.toFixed(2)} onChange={(e) => lab.movePoint("in", Number(e.target.value), "none")} aria-label="Mix-in seconds" /> s <button className="tiny" onClick={() => lab.movePoint("in", config.mixIn, "beat")}>snap beat</button>{inc.autoCues?.mixIn.map((m) => <button key={m.label} className="tiny" onClick={() => lab.movePoint("in", m.start, "beat")} title={m.rationale}>{m.label}</button>)}</label>
      {out.autoCues && <label>Mix-out ideas {out.autoCues.mixOut.map((m) => <button key={m.label} className="tiny" onClick={() => lab.movePoint("out", m.start, "bar")} title={m.rationale}>{m.label}</button>)}</label>}
      <label>Tempo <select value={config.syncMode} onChange={(e) => lab.update({ syncMode: e.target.value as SyncMode })} aria-label="Tempo matching">{SYNC.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {config.syncMode === "manual" && <><input type="number" step={0.1} value={config.targetBpm ?? out.bpm ?? 120} onChange={(e) => lab.update({ targetBpm: Number(e.target.value) || null })} aria-label="Target BPM" /> BPM</>}
        <span className="hint">max ±</span><input type="number" min={1} max={50} value={config.maxTempoPct} onChange={(e) => lab.update({ maxTempoPct: Math.max(1, Number(e.target.value) || 10) })} aria-label="Max tempo change percent" />%</label>
      <label><input type="checkbox" checked={config.keyLock} onChange={(e) => lab.update({ keyLock: e.target.checked })} /> Key lock (keeps pitch when the tempo changes — deck time-stretch)</label>
      <label><input type="checkbox" checked={config.phraseAlign} onChange={(e) => lab.update({ phraseAlign: e.target.checked })} /> Phrase-align points when dragging</label>
      <label>EQ <select value={config.eqMode} onChange={(e) => lab.update({ eqMode: e.target.value as EqMode, ...(e.target.value === "automatic" ? { eq: (lab.allPresets().find((p) => p.id === "long")!.config.eq)! } : {}) })} aria-label="EQ automation mode">{EQM.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><span className="hint">cuts only, 0 to {MAX_CUT_DB} dB — moving a deck's EQ knob takes that band back</span></label>
      <label><input type="checkbox" checked={!!echo} onChange={(e) => lab.update({ effects: e.target.checked ? { echoOut: { start: 0.1, end: 0.6, level: 0.7 } } : {} })} /> Echo out (FX unit Echo on the outgoing deck; your FX settings are restored after)</label>
      {echo && <label>Echo <input type="range" min={0} max={1} step={0.05} value={echo.start} onChange={(e) => lab.update({ effects: { echoOut: { ...echo, start: Math.min(Number(e.target.value), echo.end - 0.05) } } })} aria-label="Echo start" /> to <input type="range" min={0} max={1} step={0.05} value={echo.end} onChange={(e) => lab.update({ effects: { echoOut: { ...echo, end: Math.max(Number(e.target.value), echo.start + 0.05) } } })} aria-label="Echo end" /> level <input type="range" min={0.1} max={1} step={0.05} value={echo.level} onChange={(e) => lab.update({ effects: { echoOut: { ...echo, level: Number(e.target.value) } } })} aria-label="Echo level" /></label>}
    </div>
  );
}

type LanePath = { kind: "xf" } | { kind: "eq"; deck: "out" | "in"; band: Band };
/** Crossfader + six EQ lanes with draggable points (double-click adds, right-click removes). */
function Lanes({ config }: { config: TransitionConfig }) {
  const app = useApp(), lab = app.transitionLab;
  const lanes: { path: LanePath; label: string; pts: AutomationPoint[]; min: number; max: number; colour: string }[] = [
    { path: { kind: "xf" }, label: "Crossfader (A → B)", pts: config.crossfader, min: 0, max: 1, colour: "#e8ebf1" },
    ...(["out", "in"] as const).flatMap((deck) => (["high", "mid", "low"] as const).map((band) => ({ path: { kind: "eq", deck, band } as LanePath, label: `${deck === "out" ? "A" : "B"} ${band.toUpperCase()}`, pts: config.eq[deck][band], min: MAX_CUT_DB, max: 0, colour: band === "low" ? "#ff3b30" : band === "mid" ? "#30d158" : "#2f7bff" }))),
  ];
  const write = (p: LanePath, pts: AutomationPoint[]) => {
    const sorted = [...pts].sort((a, b) => a.t - b.t);
    if (p.kind === "xf") lab.update({ crossfader: sorted });
    else lab.update({ eq: { ...config.eq, [p.deck]: { ...config.eq[p.deck], [p.band]: sorted } }, eqMode: config.eqMode === "off" || config.eqMode === "automatic" || config.eqMode === "preset" ? "manual" : config.eqMode });
  };
  return (
    <div className={`ss-lanes${config.eqMode === "off" ? " eq-off" : ""}`}>
      <div className="ss-lanes-head"><span className="ss-label">AUTOMATION</span><span className="hint">drag points · double-click to add · right-click to remove{config.eqMode === "off" ? " · EQ lanes are inactive while EQ is off" : ""}</span></div>
      {lanes.map((l) => <Lane key={l.label} {...l} onChange={(pts, commit) => { if (!commit) lab.beginGesture(); write(l.path, pts); }} onEnd={() => lab.endGesture()} onReset={l.path.kind === "eq" ? () => write(l.path, [{ t: 0, v: 0 }, { t: 1, v: 0 }]) : undefined} />)}
    </div>
  );
}
function Lane({ label, pts, min, max, colour, onChange, onEnd, onReset }: { label: string; pts: AutomationPoint[]; min: number; max: number; colour: string; onChange: (p: AutomationPoint[], commit: boolean) => void; onEnd: () => void; onReset?: () => void }) {
  const W = 400, H = 34, svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const X = (t: number) => t * W, Y = (v: number) => H - 3 - ((v - min) / (max - min)) * (H - 6);
  const at = (e: { clientX: number; clientY: number }) => { const r = svg.current!.getBoundingClientRect(); return { t: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v: Math.round((min + (1 - (e.clientY - r.top - 3) / (r.height - 6)) * (max - min)) * 100) / 100 }; };
  let d = ""; for (let i = 0; i <= 80; i++) { const t = i / 80; d += `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(laneAt(pts, t, max)).toFixed(1)}`; }
  return (
    <div className="ss-lane">
      <span className="ss-lane-label" style={{ color: colour }}>{label}</span>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="group" aria-label={`${label} automation`}
        onPointerMove={(e) => { if (drag === null) return; const p = at(e); onChange(pts.map((q, i) => (i === drag ? { t: p.t, v: Math.max(min, Math.min(max, p.v)) } : q)), true); }}
        onPointerUp={() => { if (drag !== null) { setDrag(null); onEnd(); } }}
        onDoubleClick={(e) => { const p = at(e); onChange([...pts, { t: p.t, v: Math.max(min, Math.min(max, p.v)) }], false); onEnd(); }}>
        <rect x={0} y={0} width={W} height={H} className="ss-lane-bg" />
        <path d={d} fill="none" stroke={colour} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {pts.map((q, i) => <circle key={i} cx={X(q.t)} cy={Y(q.v)} r={4} className="ss-lane-pt" style={{ stroke: colour }} tabIndex={0} aria-label={`${label} point ${i + 1}: ${q.v} at ${Math.round(q.t * 100)}%`}
          onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); onChange(pts, false); setDrag(i); }}
          onContextMenu={(e) => { e.preventDefault(); if (pts.length > 1) { onChange(pts.filter((_, k) => k !== i), false); onEnd(); } }}
          onKeyDown={(e) => { const dv = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0, dt = e.key === "ArrowRight" ? 0.02 : e.key === "ArrowLeft" ? -0.02 : 0; if (dv || dt) { e.preventDefault(); onChange(pts.map((p, k) => (k === i ? { t: Math.max(0, Math.min(1, p.t + dt)), v: Math.max(min, Math.min(max, p.v + dv * (max - min) / 20)) } : p)), false); onEnd(); } }} />)}
      </svg>
      {onReset ? <button className="tiny" onClick={onReset} title="Reset this band (no cut)">⟲</button> : <span />}
    </div>
  );
}

function PreviewBar() {
  const app = useApp(), lab = app.transitionLab, s = useLab(), p = s.preview, c = lab.current;
  if (!c) return null;
  const secs = c.config.seconds, live = p.status === "playing" || p.status === "paused";
  return (
    <div className="ss-preview">
      <span className="ss-tb-group">
        {p.status === "playing" ? <button onClick={() => lab.pause()}>❚❚ Pause</button> : <button className="ss-primary" disabled={p.status === "loading"} onClick={() => void lab.play()}>{p.status === "loading" ? "Loading…" : p.status === "paused" ? "▶ Resume" : "▶ Play Preview"}</button>}
        <button onClick={() => lab.stop()} disabled={!live}>■ Stop</button>
        <button onClick={() => lab.restart()}>⟲ Restart Transition</button>
        <label className="ss-inline"><input type="checkbox" checked={p.loop} onChange={(e) => lab.setLoop(e.target.checked)} /> Loop</label>
        <label className="ss-inline" title={lab.headphonesAvailable() ? "Master muted for the preview; both decks in the headphones" : "Needs 4-channel routing (Settings → Audio → Routing → 4 channels)"}><input type="checkbox" checked={p.headphonesOnly} disabled={!lab.headphonesAvailable()} onChange={(e) => lab.setHeadphonesOnly(e.target.checked)} /> Headphones only</label>
      </span>
      <input className="ss-seek" type="range" min={-8} max={secs + 4} step={0.05} value={Math.max(-8, Math.min(secs + 4, p.time))} disabled={!live} onChange={(e) => lab.seek(Number(e.target.value))} aria-label="Seek within the transition" />
      <span className="mono">{fmt(p.time)} / {fmt(secs)}</span>
      {p.status === "blocked" && <div className="ss-blocked" role="alert"><span>⚠ {p.message}</span>{p.blockedBy === "deck" && <button className="danger" onClick={() => void lab.play({ takeOver: true })}>Stop the decks and preview</button>}{p.blockedBy === "autodj" && <button className="danger" title="Switches Auto DJ off and stops the decks, then plays the preview on Deck A and B. Your queue is kept — start Auto DJ again from the queue afterwards." onClick={() => void lab.play({ stopAutoDJ: true })}>Stop Auto DJ and preview</button>}<button onClick={() => lab.dismissBlock()}>Cancel</button></div>}
      {p.message && p.status !== "blocked" && <span className="hint">{p.message}</span>}
      <span className="hint ss-preview-note">Preview loads both tracks onto Deck A and B and drives the real mixer; your mixer, tempo, key lock and FX are put back when it stops.{!p.headphonesOnly ? " It plays through the master output." : ""}</span>
    </div>
  );
}

function SavePanel() {
  const app = useApp(), lab = app.transitionLab, s = useLab();
  const saved = s.savedId ? app.preparedTransitions.get(s.savedId) : undefined;
  const [name, setName] = useState(saved?.name ?? ""), [notes, setNotes] = useState(saved?.notes ?? ""), [preset, setPreset] = useState("");
  useEffect(() => { setName(saved?.name ?? lab.current?.label.split(" · ")[1] ?? ""); setNotes(saved?.notes ?? ""); }, [saved?.id, s.selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = lab.savedForPair().filter((t) => t.id !== s.savedId);
  return (
    <div className="ss-save">
      <div className="ss-save-row">
        <input className="ss-text" placeholder="Transition name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Transition name" />
        <input className="ss-text grow" placeholder="Notes (e.g. ride the filter on B)" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
        <button className="ss-primary" onClick={() => lab.save(name, notes)}>💾 Save {lab.current?.label.split(" · ")[0]} as the {s.setId ? "set's" : ""} transition{s.dirty ? " •" : ""}</button>
      </div>
      <div className="ss-save-row">
        <input className="ss-text" placeholder="New preset name" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Preset name" />
        <button disabled={!preset.trim()} onClick={() => { lab.savePreset(preset); setPreset(""); }}>Save automation as preset</button>
        {saved && <span className="hint">Saved v{saved.version} · {new Date(saved.updatedAt).toLocaleString()}</span>}
        {saved?.history.length ? <select value="" onChange={(e) => e.target.value && lab.restoreVersion(Number(e.target.value))} aria-label="Restore an earlier version"><option value="">Earlier versions…</option>{saved.history.map((h) => <option key={h.version} value={h.version}>v{h.version} · {new Date(h.savedAt).toLocaleDateString()}</option>)}</select> : null}
      </div>
      {others.length > 0 && <p className="hint">This pair also has {others.length} other saved transition{others.length > 1 ? "s" : ""} ({others.map((t) => `${t.name}${t.setId ? " — another set" : " — any set"}`).join(", ")}). Each set keeps its own.</p>}
    </div>
  );
}

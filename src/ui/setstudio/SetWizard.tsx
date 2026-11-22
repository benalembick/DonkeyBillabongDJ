/** Create a Set: how to build → duration & energy range → curve / anchors / groups → open the builder. */
import { useMemo, useState } from "react";
import { useApp } from "../context";
import { ArtTile } from "../ArtTile";
import { CurveThumb, EnergyPill, fmtDur, useStudio } from "./shared";
import { CURVE_TEMPLATES, curveFromAnchors, templatePoints } from "../../setstudio/curves";
import { DEFAULT_GROUPS } from "../../setstudio/editor";
import type { CurveTemplateId, SetMode, SetTrack } from "../../setstudio/types";

const DURATIONS: [string, number][] = [["30m", 1800], ["1h", 3600], ["2h", 7200], ["3h", 10800], ["5h", 18000]];

interface Anchor { role: "opener" | "peak" | "closer"; track: SetTrack; at: number }

export function SetWizard({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const app = useApp();
  useStudio();
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<SetMode>("curve");
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(3600), [custom, setCustom] = useState(false);
  const [eMin, setEMin] = useState(1), [eMax, setEMax] = useState(10), [overlap, setOverlap] = useState(30);
  const [template, setTemplate] = useState<CurveTemplateId>("slow-burn");
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [groups, setGroups] = useState<string[]>(DEFAULT_GROUPS.map((g) => g[0]));
  const est = app.setStudio.estimate(duration, overlap, eMin, eMax);
  const lo = Math.min(eMin, eMax), hi = Math.max(eMin, eMax);

  const create = () => {
    const count = est.count;
    const anchorList = mode === "anchors" ? anchors.map((a) => ({ index: a.role === "opener" ? 0 : a.role === "closer" ? count - 1 : Math.round(a.at * (count - 1)), track: app.setStudio.toRef(a.track), energy: a.track.energy })) : undefined;
    const points = mode === "anchors" ? curveFromAnchors(anchors.filter((a) => a.track.energy !== null).map((a) => ({ x: a.role === "opener" ? 0 : a.role === "closer" ? 1 : a.at, energy: a.track.energy! })), lo, hi) : mode === "groups" ? templatePoints("freehand") : templatePoints(template);
    const fallbackName = mode === "groups" ? "Groups set" : mode === "anchors" ? "Anchored set" : CURVE_TEMPLATES.find((t) => t.id === template)?.name ?? "New set";
    app.setStudio.create({ name: name || `${fallbackName} · ${DURATIONS.find((d) => d[1] === duration)?.[0] ?? `${Math.round(duration / 60)}m`}`, mode, durationTargetSec: duration, energyMin: lo, energyMax: hi, overlapSec: overlap,
      curveTemplate: mode === "anchors" ? "anchors" : mode === "groups" ? "freehand" : template, curveControlPoints: points, slotCount: count, groups, anchors: anchorList });
    onCreated();
  };

  return (
    <div className="ss-wizard">
      <button className="ss-back" onClick={() => (step === 1 ? onCancel() : setStep(step - 1))}>‹ Back</button>
      <ol className="ss-steps" aria-label="Steps">{["How to build", "Duration & energy", mode === "anchors" ? "Anchors" : mode === "groups" ? "Groups" : "Curve"].map((s, i) => <li key={s} className={step === i + 1 ? "on" : step > i + 1 ? "done" : ""}>{i + 1}. {s}</li>)}</ol>

      {step === 1 && <>
        <h2>How do you want to build?</h2>
        <p className="ss-sub">Choose your starting point. You can always reshape the curve on the canvas.</p>
        <div className="ss-modes">
          {([["curve", "Predefined Curve", "Pick a narrative shape — slow burn, peak & valley… — and fill slots with compatible songs.", "Choose a shape"], ["anchors", "Anchor Points", "Pick your opener, peak tracks and closer. The energy curve is generated between them.", "Pick your anchors"], ["groups", "Groups", "Organise songs into flexible pools — Intro, Warm-Up, Build, Peak, Closing. No fixed order; you decide live.", "Set up groups"]] as const).map(([id, t, d, cta]) => (
            <button key={id} className={`ss-mode ${mode === id ? "on" : ""}`} onClick={() => { setMode(id); setStep(2); }}>
              <span className={`ss-mode-icon ${id}`} aria-hidden>{id === "curve" ? "∿" : id === "anchors" ? "⟡" : "⁘"}</span><b>{t}</b><span>{d}</span><em>{cta} ›</em>
            </button>
          ))}
        </div>
      </>}

      {step === 2 && <>
        <h2>Set length and energy range</h2>
        <p className="ss-sub">The track count is estimated from your library's real track lengths minus the transition overlap.</p>
        <div className="ss-controls">
          <div className="ss-ctl"><label>Set duration</label>
            <div className="ss-seg">{DURATIONS.map(([l, s]) => <button key={l} className={!custom && duration === s ? "on" : ""} onClick={() => { setCustom(false); setDuration(s); }}>{l}</button>)}<button className={custom ? "on" : ""} onClick={() => setCustom(true)}>Custom</button></div>
            {custom && <label className="ss-inline">Minutes <input type="number" min={5} max={720} value={Math.round(duration / 60)} onChange={(e) => setDuration(Math.max(5, Math.min(720, Number(e.target.value) || 60)) * 60)} /></label>}
          </div>
          <div className="ss-ctl"><label>Energy range</label>
            <div className="ss-range">
              <input type="number" min={1} max={10} step={0.5} value={eMin} aria-label="Minimum energy" onChange={(e) => setEMin(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
              <div className="ss-dual"><div className="ss-dual-track" /><input type="range" min={1} max={10} step={0.5} value={eMin} aria-label="Minimum energy slider" onChange={(e) => setEMin(Math.min(Number(e.target.value), eMax))} /><input type="range" min={1} max={10} step={0.5} value={eMax} aria-label="Maximum energy slider" onChange={(e) => setEMax(Math.max(Number(e.target.value), eMin))} /></div>
              <input type="number" min={1} max={10} step={0.5} value={eMax} aria-label="Maximum energy" onChange={(e) => setEMax(Math.max(1, Math.min(10, Number(e.target.value) || 10)))} />
            </div>
          </div>
          <div className="ss-ctl"><label>Transition overlap</label><label className="ss-inline"><input type="number" min={0} max={120} value={overlap} onChange={(e) => setOverlap(Math.max(0, Math.min(120, Number(e.target.value) || 0)))} /> seconds per mix</label></div>
          <div className="ss-ctl"><label>Name (optional)</label><input className="ss-text" value={name} placeholder="e.g. Friday warm-up" onChange={(e) => setName(e.target.value)} /></div>
        </div>
        <LibraryRange onFit={(lo2, hi2) => { setEMin(lo2); setEMax(hi2); }} lo={lo} hi={hi} />
        <div className="ss-estimate"><b>≈ {est.count} tracks</b><span>{est.basis ? `average ${fmtDur(est.avgPlayedSec)} heard per track, from ${est.basis} track lengths in your library` : "No track lengths known yet — using a 6-minute average"}</span></div>
        <div className="ss-actions"><button className="primary" onClick={() => setStep(3)}>Next ›</button></div>
      </>}

      {step === 3 && mode === "curve" && <>
        <h2>What shape is your set?</h2>
        <p className="ss-sub">Every great set tells a story. Choose the arc, then fill it with songs.</p>
        <div className="ss-templates">
          {CURVE_TEMPLATES.map((t) => (
            <button key={t.id} className={`ss-template ${template === t.id ? "on" : ""}`} onClick={() => setTemplate(t.id)} onDoubleClick={create} aria-pressed={template === t.id}>
              <CurveThumb points={t.points} dashed={t.id === "freehand"} />
              <b>{t.name}</b><span>{t.description}</span>
            </button>
          ))}
        </div>
        <div className="ss-actions"><button className="primary" onClick={create}>Create set & open builder ›</button></div>
      </>}

      {step === 3 && mode === "anchors" && <AnchorStep anchors={anchors} setAnchors={setAnchors} lo={lo} hi={hi} onCreate={create} />}

      {step === 3 && mode === "groups" && <>
        <h2>Set up your groups</h2>
        <p className="ss-sub">Groups are pools of tracks for a phase of the night. They have an energy range but no fixed order.</p>
        <div className="ss-grouplist">
          {groups.map((g, i) => <div key={i} className="ss-groupedit"><input value={g} aria-label={`Group ${i + 1} name`} onChange={(e) => setGroups(groups.map((x, k) => (k === i ? e.target.value : x)))} /><button onClick={() => setGroups(groups.filter((_, k) => k !== i))} aria-label={`Remove ${g}`}>×</button></div>)}
          <button onClick={() => setGroups([...groups, `Group ${groups.length + 1}`])}>＋ Add group</button>
        </div>
        <div className="ss-actions"><button className="primary" disabled={!groups.some((g) => g.trim())} onClick={create}>Create set & open builder ›</button></div>
      </>}
    </div>
  );
}

/** What energies the library can actually deliver, a one-click fit, and a nudge to derive set features. */
export function LibraryRange({ lo, hi, onFit }: { lo: number; hi: number; onFit: (lo: number, hi: number) => void }) {
  const app = useApp();
  const span = app.setStudio.energySpan(), legacy = app.setStudio.legacyEnergyCount();
  const fitLo = span ? Math.max(1, Math.floor(span[0] * 2) / 2) : null, fitHi = span ? Math.min(10, Math.ceil(span[1] * 2) / 2) : null;
  const outside = span && (lo < span[0] - 0.5 || hi > span[1] + 0.5);
  return (
    <div className="ss-librange">
      {span ? <span>Your library's energy runs <b>{span[0].toFixed(1)}–{span[1].toFixed(1)}</b>.{outside ? " Parts of this range can't be matched by any track." : ""}</span> : <span>No track energies yet.</span>}
      {span && outside && <button onClick={() => onFit(fitLo!, fitHi!)}>Fit range to my library ({fitLo}–{fitHi})</button>}
      {legacy > 0 && <span className="warn">{legacy} track{legacy === 1 ? " uses" : "s use"} the older energy estimate. <button className="tiny" onClick={() => void app.libraryIntel.analyse()}>Run Library Intelligence</button> for better energy, mood and recommendations.</span>}
    </div>
  );
}

function AnchorStep({ anchors, setAnchors, lo, hi, onCreate }: { anchors: Anchor[]; setAnchors: (a: Anchor[]) => void; lo: number; hi: number; onCreate: () => void }) {
  const app = useApp();
  const [role, setRole] = useState<Anchor["role"]>("opener"), [q, setQ] = useState("");
  const pool = useMemo(() => app.setStudio.pool(), [app.setStudio]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return pool.filter((t) => t.available && (!s || `${t.title} ${t.artist}`.toLowerCase().includes(s))).sort((a, b) => (role === "peak" ? (b.energy ?? 0) - (a.energy ?? 0) : role === "opener" ? (a.energy ?? 11) - (b.energy ?? 11) : 0)).slice(0, 60);
  }, [pool, q, role]);
  const add = (t: SetTrack) => {
    const rest = anchors.filter((a) => a.track.ref !== t.ref && (role === "peak" || a.role !== role));
    const peaks = rest.filter((a) => a.role === "peak").length;
    setAnchors([...rest, { role, track: t, at: role === "peak" ? Math.min(0.9, 0.5 + peaks * 0.15) : role === "opener" ? 0 : 1 }]);
  };
  const preview = curveFromAnchors(anchors.filter((a) => a.track.energy !== null).map((a) => ({ x: a.at, energy: a.track.energy! })), lo, hi);
  return <>
    <h2>Pick your anchors</h2>
    <p className="ss-sub">Opener, peak-time tracks and closer are locked in place. The energy curve is generated through their energies; Auto Fill completes the rest.</p>
    <div className="ss-anchor-layout">
      <div className="ss-anchor-pick">
        <div className="ss-seg">{(["opener", "peak", "closer"] as const).map((r) => <button key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>{r === "opener" ? "Opener" : r === "peak" ? "Peak tracks" : "Closer"}</button>)}</div>
        <input className="ss-search wide" placeholder="Search your library…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search library for anchors" />
        <div className="ss-mini-list">
          {list.map((t) => <button key={t.ref} className="ss-mini-track" onClick={() => add(t)}><ArtTile track={{ title: t.title, artist: t.artist, album: "", artworkUrl: t.artworkUrl }} size={26} /><span><b>{t.title}</b><small>{t.artist}</small></span><small>{t.bpm?.toFixed(0) ?? "—"} · {t.camelot ?? "—"}</small><EnergyPill value={t.energy} /></button>)}
          {!list.length && <div className="ss-empty">No tracks found.</div>}
        </div>
      </div>
      <div className="ss-anchor-plan">
        <CurveThumb points={preview} energies={undefined} height={120} />
        {[...anchors].sort((a, b) => a.at - b.at).map((a) => (
          <div key={a.track.ref} className="ss-anchor-row">
            <span className={`ss-chip ${a.role}`}>{a.role.toUpperCase()}</span><b>{a.track.title}</b><EnergyPill value={a.track.energy} />
            {a.role === "peak" && <label className="ss-inline">at <input type="range" min={0.1} max={0.95} step={0.05} value={a.at} onChange={(e) => setAnchors(anchors.map((x) => (x === a ? { ...x, at: Number(e.target.value) } : x)))} /> {Math.round(a.at * 100)}%</label>}
            <button onClick={() => setAnchors(anchors.filter((x) => x !== a))} aria-label={`Remove ${a.track.title}`}>×</button>
          </div>
        ))}
        {!anchors.length && <div className="ss-empty">Pick at least one anchor.</div>}
        {anchors.some((a) => a.track.energy === null) && <p className="hint warn">Some anchors aren't analysed yet, so they don't shape the curve. Run Library Intelligence first for the best result.</p>}
      </div>
    </div>
    <div className="ss-actions"><button className="primary" disabled={!anchors.length} onClick={onCreate}>Create set & open builder ›</button></div>
  </>;
}

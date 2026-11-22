/** Library Intelligence: Analyse Library job, per-track status, derived features and user overrides. */
import { useMemo, useState } from "react";
import { useApp } from "../context";
import { EnergyPill, fmtE, useIntel, useStudio } from "./shared";
import { MOOD_TAGS, type SetTrack } from "../../setstudio/types";
import { openStudio } from "./nav";
import type { IntelStatus } from "../../setstudio/LibraryIntelligence";

const STATUS_LABEL: Record<IntelStatus, string> = { queued: "Queued", analysing: "Analysing audio", deriving: "Deriving", done: "Done", cached: "Up to date", skipped: "Skipped", failed: "Failed", cancelled: "Cancelled" };

export function LibraryIntelligencePanel({ onBack }: { onBack: () => void }) {
  const app = useApp(), job = useIntel(), studio = useStudio(), intel = app.libraryIntel;
  const cov = useMemo(() => intel.coverage(), [intel, studio.revision, job]);
  const [tab, setTab] = useState<"tracks" | "job">(job.running || job.items.length ? "job" : "tracks");
  const [q, setQ] = useState(""), [statusFilter, setStatusFilter] = useState<IntelStatus | "">("");
  const [editing, setEditing] = useState<string | null>(null);
  const pool = useMemo(() => app.setStudio.pool(), [app.setStudio, studio.revision]);
  const tracks = useMemo(() => { const s = q.trim().toLowerCase(); return pool.filter((t) => !s || `${t.title} ${t.artist} ${t.genre ?? ""}`.toLowerCase().includes(s)).slice(0, 400); }, [pool, q]);
  const items = job.items.filter((i) => !statusFilter || i.status === statusFilter);
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const failed = job.items.filter((i) => i.status === "failed").length;
  return (
    <div className="ss-intel">
      <button className="ss-back" onClick={onBack}>‹ Back</button>
      <header className="ss-title"><h2><span className="ss-bar" />LIBRARY INTELLIGENCE</h2><span className="hint">Analyse once, reuse everywhere: audio is analysed by the same engine the decks use; set features are derived from that cached analysis without decoding again.</span></header>
      <div className="ss-intel-stats">
        <div><b>{cov.local}</b><small>local tracks</small></div>
        <div><b>{cov.analysed}</b><small>audio analysed</small></div>
        <div><b>{cov.intel}</b><small>set features up to date</small></div>
        <div><b>{cov.stale}</b><small>need deriving</small></div>
        <div><b>{cov.overrides}</b><small>with your overrides</small></div>
        {cov.unavailable > 0 && <div className="warn"><b>{cov.unavailable}</b><small>files to reconnect</small></div>}
      </div>
      <div className="ss-intel-actions">
        {!job.running && <button className="ss-primary" onClick={() => { setTab("job"); void intel.analyse(); }} disabled={!cov.local}>✦ Analyse Library</button>}
        {job.running && <button onClick={() => intel.cancel()}>■ Cancel</button>}
        {!job.running && job.resumable > 0 && <button onClick={() => { setTab("job"); void intel.resume(); }}>▶ Resume ({job.resumable} left)</button>}
        {!job.running && failed > 0 && <button onClick={() => { setTab("job"); void intel.retryFailed(); }}>↻ Retry {failed} failed</button>}
        <span className="hint">Skips tracks whose analysis is already cached and current. Never changes your tags, cue points or beat grids. Playback keeps priority.</span>
      </div>
      {(job.running || job.total > 0) && <div className="ss-progress" aria-live="polite">
        <div className="ss-meter big"><i style={{ width: `${pct}%` }} /></div>
        <span>{job.running ? `${job.phase === "audio" ? "Phase A · audio analysis" : "Phase B · set features"} — ${job.current}` : job.lastRun ? `Last run: ${job.lastRun.done} derived · ${job.lastRun.cached} up to date · ${job.lastRun.failed} failed · ${job.lastRun.skipped} skipped${job.lastRun.cancelled ? " · cancelled" : ""}` : ""}</span>
        <b>{job.done}/{job.total}</b>
      </div>}
      <div className="ss-dock-tabs"><button className={tab === "tracks" ? "on" : ""} onClick={() => setTab("tracks")}>Tracks & overrides</button><button className={tab === "job" ? "on" : ""} onClick={() => setTab("job")}>Job status{job.items.length ? ` (${job.items.length})` : ""}</button></div>
      {tab === "job" && <>
        <div className="ss-dock-search"><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IntelStatus | "")} aria-label="Filter by status"><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="ss-intel-table" role="table">
          {items.slice(0, 500).map((i) => <div key={i.ref} className="ss-intel-row" role="row"><span className={`ss-st ${i.status}`}>{STATUS_LABEL[i.status]}</span><b>{i.title}</b><small>{i.artist}</small><small className="ss-msgtext">{i.message ?? ""}</small></div>)}
          {!items.length && <p className="ss-empty">No job yet — press Analyse Library.</p>}
        </div>
      </>}
      {tab === "tracks" && <>
        <div className="ss-dock-search"><input className="ss-search wide" placeholder="Search tracks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tracks" /></div>
        <div className="ss-intel-table" role="table">
          <div className="ss-intel-row head" role="row"><span>Track</span><span>BPM</span><span>Key</span><span>Energy</span><span>Moods (estimated)</span><span>Genre</span><span>Bright · Bass · Vocals</span><span /></div>
          {tracks.map((t) => <TrackIntelRow key={t.ref} t={t} open={editing === t.ref} onToggle={() => setEditing(editing === t.ref ? null : t.ref)} />)}
        </div>
      </>}
    </div>
  );
}

function TrackIntelRow({ t, open, onToggle }: { t: SetTrack; open: boolean; onToggle: () => void }) {
  const app = useApp();
  const rec = t.trackId ? app.preparation.get(t.trackId) : undefined, intel = rec?.intel, ov = rec?.setOverrides;
  const unsupported = intel ? Object.entries(intel.unsupported).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  const [energy, setEnergy] = useState(ov?.energy?.toString() ?? ""), [moods, setMoods] = useState<string[]>(ov?.moods ?? intel?.moods ?? []), [genre, setGenre] = useState(ov?.genre ?? ""), [sub, setSub] = useState(ov?.subgenre ?? "");
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}`);
  return (
    <>
      <div className={`ss-intel-row${!t.analysed ? " dim" : ""}`} role="row">
        <span className="ss-intel-title"><b>{t.title}</b><small>{t.artist}</small></span>
        <span className="mono">{t.bpm?.toFixed(1) ?? "—"}</span>
        <span className="ss-key">{t.camelot ?? "—"}</span>
        <span title={intel ? `Set energy ${fmtE(intel.energy)} (confidence ${pct(intel.energyConfidence)}%) · original estimate ${fmtE(rec?.energy)}${ov?.energy !== undefined ? ` · your override ${ov.energy}` : ""}` : t.analysed ? "Set features not derived yet" : "Not analysed"}><EnergyPill value={t.energy} />{t.energySource === "override" && <small className="ss-ov">yours</small>}{t.energySource === "legacy" && <small className="hint"> old</small>}</span>
        <span className="ss-moods">{t.moods.map((m) => <i key={m}>{m}</i>)}{ov?.moods && <small className="ss-ov">yours</small>}</span>
        <span>{t.subgenre ? `${t.genre} / ${t.subgenre}` : t.genre ?? "—"}</span>
        <span className="mono" title={unsupported || undefined}>{pct(intel?.brightness)} · {pct(intel?.bassIntensity)} · {intel?.vocalPresence === null || !intel ? <span title="Needs STEMS separation">n/a</span> : pct(intel.vocalPresence)}</span>
        <span><button className="tiny" onClick={onToggle} disabled={!t.trackId} title={t.trackId ? "Edit energy, moods and genre" : "Analyse this track first"}>✎</button><button className="tiny" disabled={!t.analysed} onClick={() => openStudio({ tab: "autocue", ref: t.ref })} title="Auto Cue: suggested hot cues">✦</button></span>
      </div>
      {open && t.trackId && <div className="ss-override" role="row">
        <label>Energy <input type="number" min={1} max={10} step={0.1} value={energy} placeholder={fmtE(intel?.energy ?? rec?.energy)} onChange={(e) => setEnergy(e.target.value)} /></label>
        <label>Genre <input value={genre} placeholder={t.genre ?? ""} onChange={(e) => setGenre(e.target.value)} /></label>
        <label>Sub-genre <input value={sub} placeholder={t.subgenre ?? ""} onChange={(e) => setSub(e.target.value)} /></label>
        <span className="ss-mood-pick">{MOOD_TAGS.map((m) => <button key={m} className={`tiny${moods.includes(m) ? " on" : ""}`} onClick={() => setMoods(moods.includes(m) ? moods.filter((x) => x !== m) : [...moods, m])}>{m}</button>)}</span>
        <button className="primary" onClick={() => { app.libraryIntel.setOverrides(t.trackId!, { energy: energy ? Math.max(1, Math.min(10, Number(energy))) : undefined, moods: ov?.moods || moods.join() !== (intel?.moods ?? []).join() ? moods : undefined, genre: genre.trim() || undefined, subgenre: sub.trim() || undefined }); onToggle(); }}>Save</button>
        {ov && <button onClick={() => { app.libraryIntel.setOverrides(t.trackId!, null); onToggle(); }}>Revert to analysis</button>}
        <span className="hint">The analysed values are kept; your values take priority everywhere energy is shown.</span>
      </div>}
    </>
  );
}

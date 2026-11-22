/** AI Set Studio: landing page (Create / Improve / Your Sets / Library Intelligence) and routing. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../context";
import { useFrameStore } from "../hooks";
import { CurveThumb, fmtDate, fmtLong, useIntel, useSets, useStudio } from "./shared";
import { SetWizard } from "./SetWizard";
import { SetBuilder } from "./SetBuilder";
import { LibraryIntelligencePanel } from "./LibraryIntelligencePanel";
import { curveFromEnergies } from "../../setstudio/curves";
import type { DJSet } from "../../setstudio/types";
import { AutoCuePanel } from "./AutoCuePanel";
import { TransitionLab } from "./TransitionLab";
import { BlendGroupsPanel } from "./BlendGroupsPanel";
import { takePending, type StudioRequest, type StudioTab } from "./nav";
import "./setstudio.css";
import "./setstudio-phase2.css";

type Screen = { kind: "home" } | { kind: "wizard" } | { kind: "improve" } | { kind: "builder" } | { kind: "intel" };
type SortKey = "updated" | "name" | "tracks" | "duration";

const TABS: [StudioTab, string][] = [["sets", "Set Builder"], ["autocue", "Auto Cue"], ["lab", "Transition Lab"], ["groups", "Blend Groups"], ["intel", "Library Intelligence"]];
/** Sub-menu icons (drawn in the label colour; each tab's own colour is its underline bar). */
const TAB_ICONS: Record<StudioTab, ReactNode> = {
  sets: <><path d="M9 4v16M15 4v16M4 9h16M4 15h16" /></>,
  autocue: <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" /></>,
  lab: <><path d="M4 8h14m0 0-3-3m3 3-3 3" /><path d="M20 16H6m0 0 3-3m-3 3 3 3" /></>,
  groups: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12.5 9 5 9-5" /><path d="m3 16.5 9 5 9-5" /></>,
  intel: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
};

export function SetStudioWorkspace() {
  const app = useApp(), studio = useStudio();
  const [screen, setScreen] = useState<Screen>(() => (app.setStudio.current() ? { kind: "builder" } : { kind: "home" }));
  const [tab, setTab] = useState<StudioTab>("sets");
  const [req, setReq] = useState<StudioRequest | null>(null);
  useEffect(() => { if (!studio.openId && screen.kind === "builder") setScreen({ kind: "home" }); }, [studio.openId, screen.kind]);
  // Requests from elsewhere (track menu, Auto DJ queue, set builder): read one left before mounting, then listen.
  useEffect(() => {
    const apply = (r: StudioRequest | null) => { if (!r) return; setTab(r.tab); setReq(r); if (r.tab === "sets" && app.setStudio.current()) setScreen({ kind: "builder" }); };
    apply(takePending());
    const on = () => apply(takePending());
    window.addEventListener("dbdj:setstudio", on);
    return () => window.removeEventListener("dbdj:setstudio", on);
  }, [app.setStudio]);
  const openSet = (id: string) => { if (app.setStudio.open(id)) setScreen({ kind: "builder" }); };
  return (
    <div className="ss-root">
      <nav className="ss-tabs" aria-label="AI Set Studio">
        {TABS.map(([id, label]) => <button key={id} className={`ss-tab-${id}${tab === id ? " on" : ""}`} aria-current={tab === id ? "page" : undefined} title={label} onClick={() => { setTab(id); setReq(null); if (id === "sets" && app.setStudio.current()) setScreen({ kind: "builder" }); }}>
          <svg className="ss-tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TAB_ICONS[id]}</svg>
          <span className="ss-tab-label">{label}{id === "lab" && app.transitionLab.getState().preview.status === "playing" ? " ●" : ""}</span>
        </button>)}
      </nav>
      {tab === "sets" && <>
        {screen.kind === "home" && <Home onCreate={() => setScreen({ kind: "wizard" })} onImprove={() => setScreen({ kind: "improve" })} onOpen={openSet} onIntel={() => setTab("intel")} />}
        {screen.kind === "wizard" && <SetWizard onCancel={() => setScreen({ kind: "home" })} onCreated={() => setScreen({ kind: "builder" })} />}
        {screen.kind === "improve" && <ImprovePicker onCancel={() => setScreen({ kind: "home" })} onOpened={() => setScreen({ kind: "builder" })} />}
        {screen.kind === "builder" && <SetBuilder onClose={() => { app.setStudio.close(); setScreen({ kind: "home" }); }} />}
        {screen.kind === "intel" && <LibraryIntelligencePanel onBack={() => setScreen({ kind: "home" })} />}
      </>}
      {tab === "intel" && <LibraryIntelligencePanel onBack={() => setTab("sets")} />}
      {tab === "autocue" && <AutoCuePanel key={req?.ref ?? "none"} initialRef={req?.tab === "autocue" ? req.ref ?? null : null} />}
      {tab === "lab" && <TransitionLab request={req?.tab === "lab" ? req : null} />}
      {tab === "groups" && <BlendGroupsPanel />}
    </div>
  );
}

function Home({ onCreate, onImprove, onOpen, onIntel }: { onCreate: () => void; onImprove: () => void; onOpen: (id: string) => void; onIntel: () => void }) {
  const app = useApp(), sets = useSets(), intel = useIntel();
  useStudio();
  const [q, setQ] = useState(""), [sort, setSort] = useState<SortKey>("updated");
  const [renaming, setRenaming] = useState<string | null>(null), [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const cov = app.libraryIntel.coverage();
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = sets.sets.filter((x) => !s || x.name.toLowerCase().includes(s) || x.slots.some((sl) => `${sl.track?.title} ${sl.track?.artist}`.toLowerCase().includes(s)));
    return list.map((set) => ({ set, view: app.setStudio.view(set) })).sort((a, b) =>
      sort === "name" ? a.set.name.localeCompare(b.set.name) : sort === "tracks" ? b.view.summary.tracks - a.view.summary.tracks : sort === "duration" ? b.view.summary.durationSec - a.view.summary.durationSec : b.set.updatedAt - a.set.updatedAt);
  }, [sets, q, sort, app.setStudio]);
  return (
    <div className="ss-home">
      <header className="ss-title"><h2><span className="ss-bar" />AI SET STUDIO</h2><span className="hint">Plan sets from your own analysed library — energy curves, explained recommendations and transition checks.</span>
        <button className="ss-ghost" onClick={() => void app.setStudio.importSet().then((s) => s && onOpen(s.id))} title="Import a .dbdjset.json file">⇪ Import set file</button>
      </header>
      <div className="ss-entry">
        <button className="ss-entry-card create" onClick={onCreate}>
          <b>Create a Set</b><span>Start from an energy curve, anchor tracks or flexible groups, then build track by track.</span>
          <CurveThumb points={[{ x: 0, y: 0.12 }, { x: 0.4, y: 0.42 }, { x: 0.6, y: 0.3 }, { x: 1, y: 0.62 }]} height={60} dashed />
        </button>
        <button className="ss-entry-card improve" onClick={onImprove}>
          <b>Improve a Set</b><span>Load a playlist or saved set, see its real energy curve and fix rough transitions. The original stays untouched.</span>
          <CurveThumb points={[{ x: 0, y: 0.25 }, { x: 0.3, y: 0.55 }, { x: 0.65, y: 0.25 }, { x: 1, y: 0.5 }]} height={60} />
        </button>
        <button className="ss-entry-card intel" onClick={onIntel}>
          <b>Library Intelligence</b>
          <span>{cov.local ? `${cov.intel} of ${cov.local} tracks have set features · ${cov.analysed - cov.intel > 0 ? `${cov.analysed - cov.intel} need deriving · ` : ""}${cov.local - cov.analysed} unanalysed` : "Add music to your collection to analyse it"}</span>
          <div className="ss-meter" aria-label="Library coverage"><i style={{ width: `${cov.local ? (cov.intel / cov.local) * 100 : 0}%` }} /></div>
          {intel.running && <small className="ss-live">● {intel.current || "Analysing…"} ({intel.done}/{intel.total})</small>}
          {!intel.running && intel.resumable > 0 && <small className="ss-live warn">Paused job: {intel.resumable} tracks left — open to resume</small>}
        </button>
      </div>
      <div className="ss-section-head"><span>YOUR SETS</span><b>{String(sets.sets.length).padStart(2, "0")}</b><i />
        <select aria-label="Sort sets" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}><option value="updated">Last modified</option><option value="name">Name</option><option value="tracks">Tracks</option><option value="duration">Duration</option></select>
        <input className="ss-search" placeholder="Search your sets…" aria-label="Search your sets" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {sets.unreadable > 0 && <p className="hint warn">{sets.unreadable} saved set(s) were made by a newer version and are kept untouched.</p>}
      {!rows.length && <div className="ss-empty">{sets.sets.length ? "No sets match your search." : "No sets yet — create one or improve a playlist you already play."}</div>}
      <div className="ss-setlist">
        {rows.map(({ set, view }) => (
          <div key={set.id} className="ss-setrow" role="button" tabIndex={0} onDoubleClick={() => onOpen(set.id)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(set.id)}>
            <div className="ss-setrow-thumb"><CurveThumb points={set.mode === "groups" ? curveFromEnergies(set.groups.map((g) => (g.energyMin + g.energyMax) / 2), 1, 10) : set.curveControlPoints} width={120} height={40} energies={set.mode === "groups" ? undefined : view.slots.map((s) => s.track?.energy ?? null)} /></div>
            {renaming === set.id
              ? <input className="ss-rename" autoFocus defaultValue={set.name} aria-label="Set name" onBlur={(e) => { app.sets.rename(set.id, e.target.value); setRenaming(null); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }} />
              : <b className="ss-setname" onClick={() => onOpen(set.id)}>{set.name}</b>}
            <span className="ss-chip">{set.mode === "improve" ? "IMPROVED" : set.mode === "anchors" ? "ANCHORS" : set.mode === "groups" ? "GROUPS" : set.curveTemplate.replace("-", " ").toUpperCase()}</span>
            {set.version > 1 && <span className="ss-chip">v{set.version}</span>}
            <span className={`ss-status ${view.summary.ready ? "ok" : view.summary.tracks ? "warn" : ""}`}>{view.summary.label}</span>
            <span className="ss-meta">♫ {set.mode === "groups" ? `${view.summary.tracks} in ${set.groups.length} groups` : `${view.summary.tracks}/${set.slots.length} slots`}</span>
            <span className="ss-meta">◷ ~{fmtLong(view.summary.durationSec || set.durationTargetSec)}</span>
            <span className="ss-meta">▦ {fmtDate(set.updatedAt)}</span>
            <span className="ss-row-actions">
              <button className="primary" onClick={() => onOpen(set.id)}>Open</button>
              <button onClick={() => app.sets.duplicate(set.id)} title="Duplicate">⧉</button>
              <button onClick={() => setRenaming(set.id)} title="Rename">✎</button>
              <button onClick={() => void app.setStudio.exportSet(set, "m3u8")} title="Export M3U8 playlist">M3U8</button>
              <button onClick={() => void app.setStudio.exportSet(set, "native")} title="Export full set file (.dbdjset.json)">⇩</button>
              {confirmDelete === set.id
                ? <><button className="danger" onClick={() => { void app.sets.remove(set.id); setConfirmDelete(null); }}>Delete?</button><button onClick={() => setConfirmDelete(null)}>Keep</button></>
                : <button onClick={() => setConfirmDelete(set.id)} title="Delete" aria-label={`Delete ${set.name}`}>✕</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImprovePicker({ onCancel, onOpened }: { onCancel: () => void; onOpened: () => void }) {
  const app = useApp(), sets = useSets();
  const playlists = useFrameStore((cb) => app.playlists.on("change", cb), () => app.playlists.getState());
  const [q, setQ] = useState("");
  const match = (n: string) => !q.trim() || n.toLowerCase().includes(q.trim().toLowerCase());
  const lists = playlists.playlists.filter((p) => p.refs.length > 1 && match(p.name));
  const savedSets = sets.sets.filter((s: DJSet) => s.mode !== "groups" && s.slots.some((x) => x.track) && match(s.name));
  return (
    <div className="ss-wizard">
      <button className="ss-back" onClick={onCancel}>‹ Back</button>
      <h2>Improve a Set</h2>
      <p className="ss-sub">Choose a playlist or a saved set. AI Set Studio makes a new set from it — the original is never changed unless you confirm it later.</p>
      <input className="ss-search wide" placeholder="Search playlists and sets…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search playlists and sets" />
      <div className="ss-section-head"><span>PLAYLISTS</span><b>{lists.length}</b><i /></div>
      <div className="ss-pick-grid">
        {lists.map((p) => <button key={p.id} className="ss-pick" onClick={() => { if (app.setStudio.importPlaylist(p.id)) onOpened(); }}><b>{p.name}</b><span>{p.refs.length} tracks</span><CurveThumb points={curveFromEnergies(p.refs.map((r) => app.setStudio.profile(r)?.energy ?? null), 1, 10)} width={200} height={44} energies={p.refs.map((r) => app.setStudio.profile(r)?.energy ?? null)} /></button>)}
        {!lists.length && <div className="ss-empty">No playlists with two or more tracks.</div>}
      </div>
      <div className="ss-section-head"><span>SAVED SETS</span><b>{savedSets.length}</b><i /></div>
      <div className="ss-pick-grid">
        {savedSets.map((s) => <button key={s.id} className="ss-pick" onClick={() => { if (app.setStudio.improveSet(s.id)) onOpened(); }}><b>{s.name}</b><span>{s.slots.filter((x) => x.track).length} tracks · saves as v{s.version + 1}</span></button>)}
        {!savedSets.length && <div className="ss-empty">No saved sets with tracks yet.</div>}
      </div>
    </div>
  );
}

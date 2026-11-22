/** Blend Steering Groups: reusable pools of tracks, suggestions, steering between groups and journeys. */
import { useCallback, useMemo, useState } from "react";
import { useApp, useEngineState } from "../context";
import { useFrameStore } from "../hooks";
import { ArtTile } from "../ArtTile";
import { CurveThumb, EnergyPill, PREVIEW_TIP, useAuditionRef } from "./shared";
import { GROUP_COLOURS, GROUP_TEMPLATES, SUGGEST_ACTIONS, type BlendGroup, type SuggestAction } from "../../setstudio/BlendGroups";
import { MOOD_TAGS, NEXT_MOVES, type NextMove, type SetTrack } from "../../setstudio/types";
import { curveFromEnergies, fromEnergy } from "../../setstudio/curves";
import type { CandidateScore } from "../../setstudio/scoring";
import { openStudio } from "./nav";

function useGroups() {
  const app = useApp();
  const rev = useFrameStore(useCallback((cb) => { const a = app.blendGroups.on("change", cb), b = app.setStudio.on("change", cb); return () => { a(); b(); }; }, [app]), () => `${app.blendGroups.all().length}:${app.blendGroups.all()[0]?.updatedAt ?? 0}:${app.setStudio.getState().revision}:${app.blendGroups.journeys().map((j) => j.updatedAt).join()}`);
  return rev;
}

export function BlendGroupsPanel() {
  const app = useApp(), svc = app.blendGroups;
  useGroups();
  const groups = svc.all();
  const [sel, setSel] = useState<string | null>(groups[0]?.id ?? null);
  const [view, setView] = useState<"group" | "journeys">("group");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const g = sel ? svc.get(sel) : undefined;
  return (
    <div className="ss-groups-page">
      <aside className="ss-glist">
        <div className="ss-dock-tabs"><button className={view === "group" ? "on" : ""} onClick={() => setView("group")}>Groups ({groups.length})</button><button className={view === "journeys" ? "on" : ""} onClick={() => setView("journeys")}>Journeys</button></div>
        <div className="ss-gnew">
          <select value="" onChange={(e) => { if (!e.target.value) return; const n = svc.create(e.target.value); setSel(n.id); setView("group"); }} aria-label="New group from a template"><option value="">＋ New group…</option><option value="New group">Blank group</option>{GROUP_TEMPLATES.map(([n]) => <option key={n} value={n}>{n}</option>)}</select>
        </div>
        {groups.map((x) => (
          <button key={x.id} className={`ss-gitem${x.id === sel ? " on" : ""}`} onClick={() => { setSel(x.id); setView("group"); }} style={{ ["--gc" as string]: x.colour }}>
            <i /><span><b>{x.name}</b><small>{x.tracks.length} tracks · energy {x.energyMin}–{x.energyMax}{x.locked ? " · 🔒" : ""}</small></span>
          </button>
        ))}
        {!groups.length && <p className="ss-empty">No groups yet. Groups are reusable pools of tracks for a style, mood or energy level — no fixed order.</p>}
      </aside>
      <section className="ss-gmain">
        {view === "journeys" ? <Journeys /> : !g ? <p className="ss-empty">Create or select a group.</p> : <>
          <GroupEditor g={g} onDelete={() => setConfirmDel(g.id)} />
          <Members g={g} />
          <Stats g={g} />
          <Suggestions g={g} />
          <Steer g={g} />
        </>}
      </section>
      {confirmDel && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Delete group">
        <div className="modal ss-confirm"><h3>Delete “{svc.get(confirmDel)?.name}”?</h3><p>Only the group is deleted — its tracks, files and library records stay. Sets using it keep a copy of its tracks; curve sections assigned to it are removed.</p>
          <div className="ss-actions"><button onClick={() => setConfirmDel(null)}>Cancel</button><button className="danger" onClick={() => { void svc.remove(confirmDel); setConfirmDel(null); setSel(null); }}>Delete group</button></div></div>
      </div>}
    </div>
  );
}

function GroupEditor({ g, onDelete }: { g: BlendGroup; onDelete: () => void }) {
  const app = useApp(), svc = app.blendGroups;
  const up = (p: Partial<BlendGroup>) => svc.update(g.id, p);
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="ss-gedit" style={{ ["--gc" as string]: g.colour }}>
      <div className="ss-gedit-row">
        <input className="ss-gname" value={g.name} onChange={(e) => up({ name: e.target.value })} aria-label="Group name" />
        <span className="ss-colours">{GROUP_COLOURS.map((c) => <button key={c} className={g.colour === c ? "on" : ""} style={{ background: c }} onClick={() => up({ colour: c })} aria-label={`Colour ${c}`} />)}</span>
        <span className="ss-tb-group right">
          <label className="ss-inline" title="Locked: membership can't change (properties still can)"><input type="checkbox" checked={g.locked} onChange={(e) => up({ locked: e.target.checked })} /> Lock membership</label>
          <button onClick={() => svc.duplicate(g.id)}>⧉ Duplicate</button>
          <button onClick={onDelete}>✕ Delete</button>
        </span>
      </div>
      <input className="ss-text wide" placeholder="Description" value={g.description} onChange={(e) => up({ description: e.target.value })} aria-label="Description" />
      <div className="ss-gprops">
        <label>Energy <input type="number" min={1} max={10} step={0.5} value={g.energyMin} onChange={(e) => up({ energyMin: Number(e.target.value) || 1 })} aria-label="Minimum energy" />–<input type="number" min={1} max={10} step={0.5} value={g.energyMax} onChange={(e) => up({ energyMax: Number(e.target.value) || 10 })} aria-label="Maximum energy" /></label>
        <label>BPM <input type="number" placeholder="min" value={g.bpmMin ?? ""} onChange={(e) => up({ bpmMin: e.target.value ? Number(e.target.value) : null })} aria-label="Minimum BPM" />–<input type="number" placeholder="max" value={g.bpmMax ?? ""} onChange={(e) => up({ bpmMax: e.target.value ? Number(e.target.value) : null })} aria-label="Maximum BPM" /></label>
        <label>Keys <input placeholder="e.g. 8A, 9A" defaultValue={g.keys.join(", ")} onBlur={(e) => up({ keys: list(e.target.value).map((k) => k.toUpperCase()) })} aria-label="Preferred Camelot keys" /></label>
        <label>Genres <input placeholder="e.g. House" defaultValue={g.genres.join(", ")} onBlur={(e) => up({ genres: list(e.target.value) })} aria-label="Genres" /></label>
        <label>Sub-genres <input placeholder="e.g. Deep House" defaultValue={g.subgenres.join(", ")} onBlur={(e) => up({ subgenres: list(e.target.value) })} aria-label="Sub-genres" /></label>
        <label>Vocals <select value={g.vocal} onChange={(e) => up({ vocal: e.target.value as BlendGroup["vocal"] })} aria-label="Vocal preference"><option value="any">Any</option><option value="vocal">Vocal (STEMS known)</option><option value="instrumental">Instrumental (STEMS known)</option></select></label>
        <label>Order <select value={g.orderingMode} onChange={(e) => up({ orderingMode: e.target.value as BlendGroup["orderingMode"] })} aria-label="Ordering"><option value="flexible">Flexible — pick live</option><option value="ordered">Ordered sequence</option><option value="suggested">Suggested order (you decide)</option></select></label>
      </div>
      <div className="ss-mood-pick">{MOOD_TAGS.map((m) => <button key={m} className={`tiny${g.moods.includes(m) ? " on" : ""}`} onClick={() => up({ moods: g.moods.includes(m) ? g.moods.filter((x) => x !== m) : [...g.moods, m] })}>{m}</button>)}</div>
    </div>
  );
}

function Members({ g }: { g: BlendGroup }) {
  const app = useApp(), svc = app.blendGroups, hearing = useAuditionRef();
  const [q, setQ] = useState("");
  const members = svc.members(g);
  const tracks = [...g.tracks].sort((a, b) => a.position - b.position);
  const results = useMemo(() => { const s = q.trim().toLowerCase(); return s.length < 2 ? [] : app.setStudio.pool().filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(s)).slice(0, 12); }, [q, app.setStudio]);
  const suggested = g.orderingMode === "suggested" ? svc.suggestedOrder(g.id) : null;
  return (
    <div className="ss-gsection">
      <div className="ss-section-head"><span>TRACKS</span><b>{tracks.length}</b><i />
        <input className="ss-search" placeholder={g.locked ? "Membership locked" : "Add tracks — search…"} disabled={g.locked} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Add tracks" />
      </div>
      {results.length > 0 && <div className="ss-gresults">{results.map((t) => <button key={t.ref} className="tiny" onClick={() => svc.addTracks(g.id, [t])}>＋ {t.title} — {t.artist}</button>)}</div>}
      {suggested && suggested.length > 1 && <p className="hint">Suggested order: {suggested.map((r) => app.setStudio.profile(r)?.title).join(" → ")} <button className="tiny" onClick={() => svc.applyOrder(g.id, suggested)}>Use this order</button></p>}
      <div className="ss-gmembers">
        {tracks.map((m, i) => { const t = members[i]; return (
          <div key={m.ref.ref} className={`ss-gmember${t ? "" : " missing"}`}>
            {g.orderingMode !== "flexible" && <span className="ss-num">{String(i + 1).padStart(2, "0")}</span>}
            <ArtTile track={{ title: m.ref.title, artist: m.ref.artist, album: "", artworkUrl: t?.artworkUrl }} size={26} />
            <span className="ss-gm-main"><b>{m.ref.title}</b><small>{m.ref.artist}{t ? "" : " · file missing"}</small></span>
            <span className="mono">{t?.bpm?.toFixed(0) ?? "—"}</span><span className="ss-key">{t?.camelot ?? "—"}</span><EnergyPill value={t?.energy ?? null} />
            <button className={`tiny${m.isAnchor ? " on" : ""}`} onClick={() => svc.setTrack(g.id, m.ref.ref, { isAnchor: !m.isAnchor })} title="Anchor: placed first when Auto Filling from this group">⚓</button>
            {t && <button className={`tiny${hearing === t.ref ? " on" : ""}`} onClick={() => void app.setStudio.previewToggle(t.ref)} title={PREVIEW_TIP}>{hearing === t.ref ? "■" : "▶"}</button>}
            {g.orderingMode !== "flexible" && <><button className="tiny" disabled={i === 0} onClick={() => svc.moveTrack(g.id, i, i - 1)} aria-label="Move up">↑</button><button className="tiny" disabled={i === tracks.length - 1} onClick={() => svc.moveTrack(g.id, i, i + 1)} aria-label="Move down">↓</button></>}
            <button className="tiny" disabled={g.locked} onClick={() => svc.removeTrack(g.id, m.ref.ref)} aria-label={`Remove ${m.ref.title}`}>×</button>
          </div>); })}
        {!tracks.length && <p className="ss-empty">No tracks yet — search above, or use Suggestions below.</p>}
      </div>
    </div>
  );
}

function Stats({ g }: { g: BlendGroup }) {
  const app = useApp(), st = app.blendGroups.stats(g.id);
  if (!st || !st.count) return null;
  const maxB = Math.max(...st.bpmBuckets.map((b) => b.n), 1);
  return (
    <div className="ss-gsection ss-gstats">
      <div><small>Energy (members)</small><b>{st.energy ? `${st.energy[0].toFixed(1)}–${st.energy[1].toFixed(1)}` : "—"}</b><small>target {g.energyMin}–{g.energyMax}{st.outsideConstraints ? ` · ${st.outsideConstraints} outside the group's rules` : ""}</small></div>
      <div><small>BPM</small><span className="ss-hist">{st.bpmBuckets.map((b) => <i key={b.from} style={{ height: `${(b.n / maxB) * 100}%` }} title={`${b.from}–${b.from + 4}: ${b.n}`} />)}</span><small>{st.bpmBuckets[0]?.from}–{(st.bpmBuckets[st.bpmBuckets.length - 1]?.from ?? 0) + 4}</small></div>
      <div><small>Keys</small><span>{st.keys.slice(0, 6).map((k) => <span key={k.key} className="ss-key">{k.key}·{k.n}</span>)}</span></div>
      <div><small>Moods (estimated)</small><span className="ss-moods">{st.moods.slice(0, 5).map((m) => <i key={m.mood}>{m.mood} {m.n}</i>)}</span></div>
      <div><small>Pairs that blend directly</small><b>{st.pairs.total ? Math.round((st.pairs.green / st.pairs.total) * 100) : 0}% green</b><small>{st.pairs.amber} review · {st.pairs.red} conflict{st.pairs.sampled ? " (first 40 tracks)" : ""} — compatibility is pair-specific</small></div>
    </div>
  );
}

function Suggestions({ g }: { g: BlendGroup }) {
  const app = useApp(), svc = app.blendGroups;
  const [action, setAction] = useState<SuggestAction>("similar"), [move, setMove] = useState<NextMove>("keep"), [seeds, setSeeds] = useState<string[]>([]);
  const results = useMemo(() => svc.suggest(g.id, action, seeds, move), [svc, g, action, seeds, move]);
  return (
    <div className="ss-gsection">
      <div className="ss-section-head"><span>SUGGESTIONS</span><i />
        <select value={action} onChange={(e) => setAction(e.target.value as SuggestAction)} aria-label="Suggestion type">{SUGGEST_ACTIONS.map((a) => <option key={a.id} value={a.id} title={a.hint}>{a.label}</option>)}</select>
        {(action === "similar" || action === "expand") && <select value={move} onChange={(e) => setMove(e.target.value as NextMove)} aria-label="Steering">{NEXT_MOVES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>}
        <select value="" onChange={(e) => e.target.value && setSeeds((s) => (s.includes(e.target.value) ? s : [...s, e.target.value]))} aria-label="Add a seed track"><option value="">Seeds: {seeds.length ? `${seeds.length} selected` : g.tracks.some((t) => t.isAnchor) ? "anchors" : "whole group"}</option>{g.tracks.map((t) => <option key={t.ref.ref} value={t.ref.ref}>{t.ref.title}</option>)}</select>
        {seeds.length > 0 && <button className="tiny" onClick={() => setSeeds([])}>clear seeds</button>}
      </div>
      <p className="hint">{SUGGEST_ACTIONS.find((a) => a.id === action)?.hint}. Scored by the same engine as the set builder.</p>
      <SuggestionList items={results} onAdd={g.locked ? undefined : (t) => svc.addTracks(g.id, [t])} />
    </div>
  );
}

function SuggestionList({ items, onAdd }: { items: CandidateScore[]; onAdd?: (t: SetTrack) => void }) {
  const app = useApp(), hearing = useAuditionRef();
  if (!items.length) return <p className="ss-empty">Nothing compatible found.</p>;
  return <div className="ss-gsuggest">{items.slice(0, 20).map((r) => (
    <div key={r.track.ref} className="ss-dock-item">
      <ArtTile track={{ title: r.track.title, artist: r.track.artist, album: "", artworkUrl: r.track.artworkUrl }} size={28} />
      <div className="ss-dock-main"><b>{r.track.title}</b><small>{r.track.artist}{r.track.genre ? ` · ${r.track.subgenre ?? r.track.genre}` : ""}</small><span className="ss-why">{r.explanation}</span></div>
      <div className="ss-dock-stats"><span className="mono">{r.track.bpm?.toFixed(0) ?? "—"}</span><span className="ss-key">{r.track.camelot ?? "—"}</span><EnergyPill value={r.track.energy} /></div>
      <span className={`ss-score ${r.score >= 75 ? "hi" : r.score >= 55 ? "mid" : "lo"}`}>{r.score}%</span>
      <div className="ss-dock-actions">{onAdd && <button className="tiny primary" onClick={() => onAdd(r.track)} title="Add to the group">＋</button>}<button className={`tiny${hearing === r.track.ref ? " on" : ""}`} onClick={() => void app.setStudio.previewToggle(r.track.ref)} title={PREVIEW_TIP}>{hearing === r.track.ref ? "■" : "▶"}</button></div>
    </div>))}</div>;
}

/** Group steering: from the track that's playing (or any track) into this group. */
function Steer({ g }: { g: BlendGroup }) {
  const app = useApp(), engine = useEngineState();
  const playing = engine.decks.find((d) => d.playing && d.track)?.track?.ref ?? null;
  const [from, setFrom] = useState<string | null>(null), [move, setMove] = useState<NextMove>("keep");
  const cur = from ?? playing;
  const items = useMemo(() => (cur ? app.blendGroups.steerInto(cur, g.id, move) : []), [app.blendGroups, cur, g, move]);
  const pool = app.setStudio.pool();
  return (
    <div className="ss-gsection">
      <div className="ss-section-head"><span>STEER INTO THIS GROUP</span><i />
        <select value={cur ?? ""} onChange={(e) => setFrom(e.target.value || null)} aria-label="Current track"><option value="">{playing ? "Playing track" : "Choose the current track…"}</option>{pool.slice(0, 400).map((t) => <option key={t.ref} value={t.ref}>{t.title} — {t.artist}</option>)}</select>
        <select value={move} onChange={(e) => setMove(e.target.value as NextMove)} aria-label="Steering">{NEXT_MOVES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
      </div>
      {cur ? <SuggestionList items={items} /> : <p className="hint">Pick the current track (or play one on a deck) to see which members of this group follow it best. Nothing is loaded or played automatically.</p>}
    </div>
  );
}

function Journeys() {
  const app = useApp(), svc = app.blendGroups;
  const [sel, setSel] = useState<string | null>(svc.journeys()[0]?.id ?? null), [minutes, setMinutes] = useState(120);
  const j = sel ? svc.journeys().find((x) => x.id === sel) : undefined;
  const steps = j ? svc.energyJourney(j) : [];
  const create = () => { const n = svc.saveJourney({ id: `journey_${Date.now().toString(36)}`, name: "New journey", groupIds: svc.all().slice(0, 3).map((g) => g.id) }); setSel(n.id); };
  const toSet = () => {
    if (!j || !steps.length) return;
    const span = 1 / steps.length;
    const set = app.setStudio.create({ name: j.name, mode: "curve", durationTargetSec: minutes * 60, energyMin: Math.min(...steps.map((s) => s.min)), energyMax: Math.max(...steps.map((s) => s.max)), curveTemplate: "freehand",
      curveControlPoints: curveFromEnergies(steps.map((s) => s.mid), Math.min(...steps.map((s) => s.min)), Math.max(...steps.map((s) => s.max))), slotCount: app.setStudio.estimate(minutes * 60, 30).count });
    app.setStudio.edit((s) => steps.reduce((acc, st, i) => ({ ...acc, groupSections: [...(acc.groupSections ?? []), { id: `sec_${i}_${Date.now().toString(36)}`, groupId: st.group.id, start: i * span, end: (i + 1) * span }] }), s));
    openStudio({ tab: "sets" });
    return set;
  };
  return (
    <div className="ss-journeys">
      <div className="ss-section-head"><span>JOURNEYS</span><i /><button onClick={create}>＋ New journey</button></div>
      <p className="hint">Plan movement between groups, e.g. Warm-Up → Disco Groove → Vocal House → Peak Time → Closing. Bridges are tracks outside both groups that connect them.</p>
      <div className="ss-jlist">{svc.journeys().map((x) => <button key={x.id} className={x.id === sel ? "on" : ""} onClick={() => setSel(x.id)}>{x.name}</button>)}</div>
      {j && <>
        <div className="ss-gedit-row"><input className="ss-gname" value={j.name} onChange={(e) => svc.saveJourney({ ...j, name: e.target.value })} aria-label="Journey name" /><button onClick={() => { void svc.removeJourney(j.id); setSel(null); }}>✕ Delete journey</button></div>
        <div className="ss-jsteps">
          {j.groupIds.map((id, i) => { const g = svc.get(id); return g && <span key={id + i} className="ss-jstep" style={{ ["--gc" as string]: g.colour }}><b>{g.name}</b><small>{g.energyMin}–{g.energyMax}</small>
            <button className="tiny" disabled={i === 0} onClick={() => { const ids = [...j.groupIds]; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; svc.saveJourney({ ...j, groupIds: ids }); }} aria-label="Earlier">←</button>
            <button className="tiny" onClick={() => svc.saveJourney({ ...j, groupIds: j.groupIds.filter((_, k) => k !== i) })} aria-label="Remove">×</button></span>; })}
          <select value="" onChange={(e) => e.target.value && svc.saveJourney({ ...j, groupIds: [...j.groupIds, e.target.value] })} aria-label="Add a group"><option value="">＋ Add group</option>{svc.all().map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        </div>
        {steps.length > 0 && <div className="ss-jcurve"><CurveThumb points={steps.length > 1 ? steps.map((s, i) => ({ x: i / (steps.length - 1), y: fromEnergy(s.mid, 1, 10) })) : [{ x: 0, y: fromEnergy(steps[0].mid, 1, 10) }, { x: 1, y: fromEnergy(steps[0].mid, 1, 10) }]} height={70} /></div>}
        {steps.slice(0, -1).map((s, i) => <Bridge key={s.group.id + i} fromId={s.group.id} toId={steps[i + 1].group.id} />)}
        <div className="ss-actions"><label className="ss-inline">Set length <input type="number" min={15} max={600} value={minutes} onChange={(e) => setMinutes(Math.max(15, Number(e.target.value) || 120))} /> min</label><button className="ss-primary" disabled={!steps.length} onClick={toSet}>Create a set from this journey</button></div>
      </>}
    </div>
  );
}
function Bridge({ fromId, toId }: { fromId: string; toId: string }) {
  const app = useApp(), a = app.blendGroups.get(fromId), b = app.blendGroups.get(toId);
  const [open, setOpen] = useState(false);
  const items = useMemo(() => (open ? app.blendGroups.bridges(fromId, toId) : []), [app.blendGroups, fromId, toId, open]);
  return <div className="ss-bridge"><button className="tiny" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} Bridges: {a?.name} → {b?.name}</button>{open && <SuggestionList items={items} />}</div>;
}

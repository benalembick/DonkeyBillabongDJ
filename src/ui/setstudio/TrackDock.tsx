/**
 * Intelligent Track Dock: recommendations for the selected slot (with Next Move steering and
 * explanations) and a filterable library search. Items can be dragged onto timeline slots.
 */
import { useMemo, useState } from "react";
import { useApp } from "../context";
import { ArtTile } from "../ArtTile";
import { EnergyPill, fmtDur, PREVIEW_TIP, useAuditionRef, usePreview } from "./shared";
import { scoreCandidate, isExcluded, type CandidateScore } from "../../setstudio/scoring";
import { MOOD_TAGS, NEXT_MOVES, type DJSet, type HardConstraints, type NextMove, type SetTrack } from "../../setstudio/types";
import type { SetView } from "../../setstudio/SetStudioService";

export const DND_TYPE = "application/x-dbdj-set-track";

interface Filters { genre: string; subgenre: string; bpmMin: string; bpmMax: string; key: string; eMin: string; eMax: string; mood: string; recent: boolean; analysed: "any" | "yes" | "no"; vocals: "any" | "vocal" | "instrumental" }
const NO_FILTERS: Filters = { genre: "", subgenre: "", bpmMin: "", bpmMax: "", key: "", eMin: "", eMax: "", mood: "", recent: false, analysed: "any", vocals: "any" };
const CAMELOT = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

export function TrackDock({ set, view, slotIndex, onPick, groupId }: { set: DJSet; view: SetView; slotIndex: number | null; onPick: (t: SetTrack) => void; groupId?: string | null }) {
  const app = useApp();
  const [tab, setTab] = useState<"rec" | "lib">("rec");
  const [groupOnly, setGroupOnly] = useState(true);
  const section = !groupId && slotIndex !== null ? app.setStudio.sectionAt(set, slotIndex) : null;
  const sectionGroup = section ? app.blendGroups.get(section.groupId) : undefined;
  const [query, setQuery] = useState(""), [f, setF] = useState<Filters>(NO_FILTERS), [showFilters, setShowFilters] = useState(false), [showHard, setShowHard] = useState(false);
  const move = set.profile.energyDirection;
  const setMove = (m: NextMove) => app.setStudio.edit((s) => ({ ...s, profile: { ...s.profile, energyDirection: m } }), false);
  const setHard = (patch: Partial<HardConstraints>) => app.setStudio.edit((s) => ({ ...s, profile: { ...s.profile, hardConstraints: { ...s.profile.hardConstraints, ...patch } } }));
  const hard = set.profile.hardConstraints;

  const rec = useMemo(() => {
    if (groupId) return { ranked: app.setStudio.recommendForGroup(set, groupId), excluded: 0 };
    return slotIndex === null ? { ranked: [] as CandidateScore[], excluded: 0 } : app.setStudio.recommend(set, slotIndex, { move, groupOnly: !!section && groupOnly });
  }, [app.setStudio, set, slotIndex, move, groupId, view, section, groupOnly]);

  const pool = useMemo(() => app.setStudio.pool(), [app.setStudio, view]);
  const genres = useMemo(() => [...new Set(pool.map((t) => t.genre).filter(Boolean) as string[])].sort(), [pool]);
  const subgenres = useMemo(() => [...new Set(pool.map((t) => t.subgenre).filter(Boolean) as string[])].sort(), [pool]);
  const lib = useMemo(() => {
    const q = query.trim().toLowerCase(), monthAgo = Date.now() - 30 * 86400_000, n = (s: string) => (s === "" ? null : Number(s));
    const list = pool.filter((t) =>
      (!q || `${t.title} ${t.artist} ${t.genre ?? ""} ${t.subgenre ?? ""}`.toLowerCase().includes(q)) &&
      (!f.genre || t.genre === f.genre) && (!f.subgenre || t.subgenre === f.subgenre) &&
      (n(f.bpmMin) === null || (t.bpm ?? -1) >= n(f.bpmMin)!) && (n(f.bpmMax) === null || (t.bpm ?? Infinity) <= n(f.bpmMax)!) &&
      (!f.key || t.camelot === f.key) && (n(f.eMin) === null || (t.energy ?? -1) >= n(f.eMin)!) && (n(f.eMax) === null || (t.energy ?? Infinity) <= n(f.eMax)!) &&
      (!f.mood || t.moods.includes(f.mood)) && (!f.recent || (t.addedAt ?? 0) >= monthAgo) &&
      (f.analysed === "any" || (f.analysed === "yes") === t.analysed) &&
      (f.vocals === "any" || (t.vocalPresence !== null && (f.vocals === "vocal" ? t.vocalPresence >= 0.2 : t.vocalPresence < 0.2))));
    // With a slot selected, "Mixable, best fit first"; otherwise alphabetical.
    if (slotIndex === null || groupId) return list.slice(0, 300).map((t) => ({ t, s: null as CandidateScore | null }));
    // Same context as the Recommended tab, so a track shows the same score in both.
    const ctx = app.setStudio.scoreContext(set, slotIndex, move);
    return list.map((t) => { const s = ctx ? scoreCandidate(t, ctx) : null; return { t, s: s && !isExcluded(s) ? s : null }; })
      .sort((a, b) => (b.s?.score ?? -1) - (a.s?.score ?? -1)).slice(0, 300);
  }, [app.setStudio, set, pool, query, f, slotIndex, groupId, view, move]);
  const activeFilters = Object.entries(f).filter(([k, v]) => v !== NO_FILTERS[k as keyof Filters]).length;
  const target = slotIndex !== null ? view.slots[slotIndex]?.target : null;

  return (
    <aside className="ss-dock" aria-label="Track dock">
      <div className="ss-dock-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "rec"} className={tab === "rec" ? "on" : ""} onClick={() => setTab("rec")}>✦ Recommended</button>
        <button role="tab" aria-selected={tab === "lib"} className={tab === "lib" ? "on" : ""} onClick={() => setTab("lib")}>☰ Library</button>
      </div>
      {!groupId && <div className="ss-move">
        <label htmlFor="ss-move">NEXT MOVE</label>
        <select id="ss-move" value={move} onChange={(e) => setMove(e.target.value as NextMove)} title={NEXT_MOVES.find((m) => m.id === move)?.hint}>{NEXT_MOVES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
        <button className={`tiny${showHard ? " on" : ""}`} onClick={() => setShowHard((v) => !v)} title="Hard constraints">⚑ Rules{Object.values(hard).some((v) => v !== null && v !== undefined && v !== false && !(Array.isArray(v) && !v.length)) ? " •" : ""}</button>
      </div>}
      {showHard && !groupId && <div className="ss-hard">
        <span className="hint">Hard rules filter tracks out; Next Move only re-ranks.</span>
        <label>BPM <input type="number" placeholder="min" value={hard.bpmMin ?? ""} onChange={(e) => setHard({ bpmMin: e.target.value ? Number(e.target.value) : null })} /> – <input type="number" placeholder="max" value={hard.bpmMax ?? ""} onChange={(e) => setHard({ bpmMax: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Max tempo jump <input type="number" placeholder="%" value={hard.maxBpmJumpPct ?? ""} onChange={(e) => setHard({ maxBpmJumpPct: e.target.value ? Number(e.target.value) : null })} /> %</label>
        <label><input type="checkbox" checked={!!hard.harmonicOnly} onChange={(e) => setHard({ harmonicOnly: e.target.checked })} /> Harmonic mixing only</label>
        <label><input type="checkbox" checked={set.profile.allowDuplicates} onChange={(e) => app.setStudio.edit((s) => ({ ...s, profile: { ...s.profile, allowDuplicates: e.target.checked } }))} /> Allow repeats in this set</label>
      </div>}

      {tab === "rec" && <div className="ss-dock-list">
        {groupId ? <p className="ss-dock-ctx">Tracks that fit this group's energy range and preferences</p>
          : slotIndex === null ? <p className="ss-empty">Select a slot on the timeline to see ranked recommendations for it.</p>
          : <p className="ss-dock-ctx" title="The % is how well a track fits this slot, from 0 to 100: key and tempo against its neighbours, energy against the target, genre/mood and length. 100% means it's right on every check. Checks that can't be made (no neighbours yet, unknown key) are left out and lower the confidence, which pulls the score toward 50%. The list is already sorted, so the top track is the best fit in your library.">Slot {slotIndex + 1} · target energy {target?.toFixed(1) ?? "—"} · {NEXT_MOVES.find((m) => m.id === move)?.label}{rec.excluded ? ` · ${rec.excluded} excluded (already in the set, unavailable or by your rules)` : ""} <span className="ss-info">ⓘ what does % mean?</span></p>}
        {sectionGroup && <label className="ss-dock-ctx ss-inline"><input type="checkbox" checked={groupOnly} onChange={(e) => setGroupOnly(e.target.checked)} /> Only from <b style={{ color: sectionGroup.colour }}>{sectionGroup.name}</b> (this part of the curve)</label>}
        {rec.ranked.map((r) => <DockItem key={r.track.ref} t={r.track} score={r} onPick={onPick} onReject={!groupId && slotIndex !== null ? () => app.setStudio.reject(view.slots[slotIndex].slot.id, r.track.ref) : undefined} />)}
        {(slotIndex !== null || groupId) && !rec.ranked.length && <p className="ss-empty">No compatible tracks — loosen the rules or analyse more of your library.</p>}
      </div>}

      {tab === "lib" && <>
        <div className="ss-dock-search">
          <input className="ss-search wide" placeholder="Search your library…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search your library" />
          <button className={`tiny${showFilters ? " on" : ""}`} onClick={() => setShowFilters((v) => !v)}>⚲ Filters{activeFilters ? ` (${activeFilters})` : ""}</button>
        </div>
        {showFilters && <div className="ss-filters">
          <select value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })} aria-label="Genre"><option value="">Any genre</option>{genres.map((g) => <option key={g}>{g}</option>)}</select>
          <select value={f.subgenre} onChange={(e) => setF({ ...f, subgenre: e.target.value })} aria-label="Sub-genre"><option value="">Any sub-genre</option>{subgenres.map((g) => <option key={g}>{g}</option>)}</select>
          <span>BPM <input type="number" value={f.bpmMin} placeholder="min" onChange={(e) => setF({ ...f, bpmMin: e.target.value })} aria-label="BPM min" />–<input type="number" value={f.bpmMax} placeholder="max" onChange={(e) => setF({ ...f, bpmMax: e.target.value })} aria-label="BPM max" /></span>
          <span>Energy <input type="number" value={f.eMin} placeholder="min" onChange={(e) => setF({ ...f, eMin: e.target.value })} aria-label="Energy min" />–<input type="number" value={f.eMax} placeholder="max" onChange={(e) => setF({ ...f, eMax: e.target.value })} aria-label="Energy max" /></span>
          <select value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} aria-label="Key"><option value="">Any key</option>{CAMELOT.map((k) => <option key={k}>{k}</option>)}</select>
          <select value={f.mood} onChange={(e) => setF({ ...f, mood: e.target.value })} aria-label="Mood"><option value="">Any mood</option>{MOOD_TAGS.map((m) => <option key={m}>{m}</option>)}</select>
          <select value={f.analysed} onChange={(e) => setF({ ...f, analysed: e.target.value as Filters["analysed"] })} aria-label="Analysis"><option value="any">Analysed or not</option><option value="yes">Analysed</option><option value="no">Unanalysed</option></select>
          <select value={f.vocals} onChange={(e) => setF({ ...f, vocals: e.target.value as Filters["vocals"] })} aria-label="Vocals" title="Only tracks with STEMS separation have known vocal content"><option value="any">Vocals: any</option><option value="vocal">Vocal (known)</option><option value="instrumental">Instrumental (known)</option></select>
          <label><input type="checkbox" checked={f.recent} onChange={(e) => setF({ ...f, recent: e.target.checked })} /> Added in the last 30 days</label>
          {activeFilters > 0 && <button className="tiny" onClick={() => setF(NO_FILTERS)}>Clear</button>}
        </div>}
        <p className="ss-dock-ctx">{lib.length}{lib.length === 300 ? "+" : ""} tracks{slotIndex !== null && !groupId ? " · best fit for this slot first (tracks already in the set show no score)" : ""}</p>
        <div className="ss-dock-list">
          {lib.map(({ t, s }) => <DockItem key={t.ref} t={t} score={s} onPick={onPick} compact />)}
          {!lib.length && <p className="ss-empty">{pool.length ? "No tracks match." : "Your collection is empty — add music first."}</p>}
        </div>
      </>}
    </aside>
  );
}

function DockItem({ t, score, onPick, onReject, compact }: { t: SetTrack; score: CandidateScore | null; onPick: (t: SetTrack) => void; onReject?: () => void; compact?: boolean }) {
  const app = useApp(), preview = usePreview(), hearing = useAuditionRef();
  const playing = hearing === t.ref;
  return (
    <div className={`ss-dock-item${t.available ? "" : " missing"}`} draggable={t.available} onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE, t.ref); e.dataTransfer.effectAllowed = "copy"; }} onDoubleClick={() => t.available && onPick(t)}>
      <ArtTile track={{ title: t.title, artist: t.artist, album: "", artworkUrl: t.artworkUrl }} size={30} />
      <div className="ss-dock-main">
        <b title={t.title}>{t.title}</b><small>{t.artist}{t.genre ? ` · ${t.subgenre ?? t.genre}` : ""}</small>
        {!compact && score && <span className="ss-why">{score.explanation}{score.confidence < 0.7 ? ` (confidence ${Math.round(score.confidence * 100)}%)` : ""}</span>}
        {t.moods.length > 0 && !compact && <span className="ss-moods">{t.moods.slice(0, 3).map((m) => <i key={m}>{m}</i>)}</span>}
      </div>
      <div className="ss-dock-stats"><span className="mono">{t.bpm?.toFixed(0) ?? "—"}<small> BPM</small></span><span className="ss-key">{t.camelot ?? "—"}</span><EnergyPill value={t.energy} /><small>{fmtDur(t.durationSec)}</small></div>
      {score && <span className={`ss-score ${score.score >= 75 ? "hi" : score.score >= 55 ? "mid" : "lo"}`} title={compact ? score.explanation : `Harmonic ${pct(score.parts.harmonic)} · BPM ${pct(score.parts.bpm)} · Energy ${pct(score.parts.energy)} · Genre/mood ${pct(score.parts.genreMood)} · Structure ${pct(score.parts.structure)}`}>{score.score}%</span>}
      <div className="ss-dock-actions">
        <button className="tiny primary" disabled={!t.available} onClick={() => onPick(t)} title="Add to the selected slot (or the next empty slot)">＋</button>
        <button className={`tiny${playing ? " on" : ""}`} disabled={!t.available} onClick={() => void app.setStudio.previewToggle(t.ref)} title={PREVIEW_TIP}>{playing ? (preview.status === "loading" ? "…" : "■") : "▶"}</button>
        {onReject && <button className="tiny" onClick={onReject} title="Not for this slot" aria-label={`Reject ${t.title}`}>×</button>}
      </div>
    </div>
  );
}
const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

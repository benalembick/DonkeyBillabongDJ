/** Visual Set Builder: Energy Arc Map, slot timeline with transitions, Track Dock, Improve panel, Groups board. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { ArtTile } from "../ArtTile";
import { ArcMap } from "./ArcMap";
import { DND_TYPE, TrackDock } from "./TrackDock";
import { LibraryRange } from "./SetWizard";
import { openStudio } from "./nav";
import { findPrepared } from "../../setstudio/transitionModel";
import { CurveThumb, EnergyPill, fmtDur, fmtLong, TransitionChip, PREVIEW_TIP, useAuditionRef, useStudio } from "./shared";
import { ops } from "../../setstudio/editor";
import { CURVE_TEMPLATES, templatePoints } from "../../setstudio/curves";
import { sequenceScore, type FillResult } from "../../setstudio/autofill";
import type { SetView, SlotView } from "../../setstudio/SetStudioService";
import type { CurveTemplateId, DJSet, SetTrack } from "../../setstudio/types";

export function SetBuilder({ onClose }: { onClose: () => void }) {
  const app = useApp(), studio = useStudio(), svc = app.setStudio;
  const set = svc.current();
  const [selected, setSelected] = useState<number | null>(null);
  const [inspect, setInspect] = useState<number | null>(null);
  const [proposal, setProposal] = useState<{ kind: "fill" | "reseq"; result: FillResult } | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const view = useMemo(() => (set ? svc.view(set) : null), [svc, set, studio.revision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? svc.redo() : svc.undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); svc.redo(); }
      else if (view && selected !== null && view.slots[selected]) {
        const s = view.slots[selected].slot;
        if (e.key === "ArrowDown" && !e.altKey) { e.preventDefault(); setSelected(Math.min(view.slots.length - 1, selected + 1)); }
        else if (e.key === "ArrowUp" && !e.altKey) { e.preventDefault(); setSelected(Math.max(0, selected - 1)); }
        else if (e.altKey && e.key === "ArrowUp" && selected > 0) { e.preventDefault(); svc.edit((x) => ops.moveSlot(x, selected, selected - 1)); setSelected(selected - 1); }
        else if (e.altKey && e.key === "ArrowDown" && selected < view.slots.length - 1) { e.preventDefault(); svc.edit((x) => ops.moveSlot(x, selected, selected + 2)); setSelected(selected + 1); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); svc.edit((x) => ops.assign(x, s.id, null)); }
        else if (e.key.toLowerCase() === "l") svc.edit((x) => ops.toggleLock(x, s.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [svc, view, selected]);

  if (!set || !view) return null;
  const pick = (t: SetTrack) => {
    if (set.mode === "groups") { const g = set.groups.find((x) => x.id === (group ?? set.groups[0]?.id)); if (g?.blendGroupId) app.blendGroups.addTracks(g.blendGroupId, [t]); else if (g) svc.edit((s) => ops.addToGroup(s, g.id, svc.toRef(t))); return; }
    const slot = selected !== null ? view.slots[selected]?.slot : null;
    if (slot && !slot.isLocked) svc.edit((s) => ops.assign(s, slot.id, svc.toRef(t), t.energy));
    else svc.edit((s) => ops.place(s, svc.toRef(t), t.energy, (selected ?? -1) + 1));
    if (selected !== null) { const next = view.slots.findIndex((s, i) => i > selected && !s.slot.track && !s.slot.flexible); if (next >= 0) setSelected(next); }
  };
  const origin = set.origin;

  return (
    <div className="ss-builder" ref={root}>
      <Toolbar set={set} view={view} onClose={onClose} onProposal={setProposal} onWriteBack={() => setConfirmWrite(true)} />
      {studio.message && <div className="ss-msg" role="status">{studio.message}</div>}
      {set.mode !== "groups" && <div className="ss-librange-bar"><LibraryRange lo={set.energyMin} hi={set.energyMax} onFit={(lo, hi) => svc.edit((s) => ops.setRange(s, lo, hi))} /></div>}
      <div className="ss-builder-body">
        <div className="ss-canvas">
          {set.mode === "groups" ? <GroupsBoard set={set} active={group} setActive={setGroup} /> : <>
            <ArcMap view={view} selected={selected} onSelect={setSelected} compareEnergies={origin?.energies}
              onCurve={(points) => svc.edit((s) => ops.setCurve(s, points), false)} onGesture={(p) => (p === "start" ? svc.beginGesture() : svc.endGesture())} />
            <GroupSections set={set} view={view} onProposal={setProposal} />
            {origin && <ImprovePanel set={set} view={view} onSelect={setSelected} onProposal={setProposal} />}
            <Timeline set={set} view={view} selected={selected} setSelected={setSelected} inspect={inspect} setInspect={setInspect} />
          </>}
        </div>
        <TrackDock set={set} view={view} slotIndex={set.mode === "groups" ? null : selected} groupId={set.mode === "groups" ? group ?? set.groups[0]?.id ?? null : null} onPick={pick} />
      </div>
      {proposal && <ProposalDialog set={set} view={view} proposal={proposal} onClose={() => setProposal(null)} />}
      {confirmWrite && origin?.kind === "playlist" && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Replace playlist order">
          <div className="modal ss-confirm">
            <h3>Replace "{origin.sourceName}"?</h3>
            <p>This rewrites the original playlist with this set's {svc.orderedRefs(set).length} tracks in the new order. It can't be undone from here. You can instead keep the original and use <b>Load into playlist</b> to save a new one.</p>
            <div className="ss-actions"><button onClick={() => setConfirmWrite(false)}>Cancel</button><button className="danger" onClick={() => { svc.writeBackToPlaylist(true); setConfirmWrite(false); }}>Replace playlist order</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toolbar({ set, view, onClose, onProposal, onWriteBack }: { set: DJSet; view: SetView; onClose: () => void; onProposal: (p: { kind: "fill" | "reseq"; result: FillResult }) => void; onWriteBack: () => void }) {
  const app = useApp(), studio = useStudio(), svc = app.setStudio;
  const [menu, setMenu] = useState<null | "export" | "shape">(null);
  const empty = view.slots.filter((s) => !s.slot.track && !s.slot.flexible).length;
  return (
    <div className="ss-toolbar">
      <button className="ss-back" onClick={onClose} title="Back to Your Sets">‹ Sets</button>
      <input className="ss-setname-input" value={set.name} aria-label="Set name" onChange={(e) => svc.edit((s) => ({ ...s, name: e.target.value }), false)} onBlur={(e) => svc.edit((s) => ops.rename(s, e.target.value || "Untitled set"))} />
      <span className={`ss-status ${view.summary.ready ? "ok" : view.summary.tracks ? "warn" : ""}`}>{view.summary.label}</span>
      <span className="ss-tb-group">
        <button onClick={() => svc.undo()} disabled={!studio.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button onClick={() => svc.redo()} disabled={!studio.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
      </span>
      {set.mode !== "groups" && <span className="ss-tb-group">
        <label className="ss-inline" title="Planned set length">◷ <input type="number" min={5} max={720} value={Math.round(set.durationTargetSec / 60)} onChange={(e) => svc.edit((s) => ops.setDuration(s, (Number(e.target.value) || 60) * 60))} aria-label="Planned minutes" />m</label>
        <label className="ss-inline" title="Energy range">E <input type="number" min={1} max={10} step={0.5} value={set.energyMin} onChange={(e) => svc.edit((s) => ops.setRange(s, Number(e.target.value) || 1, s.energyMax))} aria-label="Minimum energy" />–<input type="number" min={1} max={10} step={0.5} value={set.energyMax} onChange={(e) => svc.edit((s) => ops.setRange(s, s.energyMin, Number(e.target.value) || 10))} aria-label="Maximum energy" /></label>
        <span className="ss-menu-wrap"><button onClick={() => setMenu(menu === "shape" ? null : "shape")}>∿ Shape</button>
          {menu === "shape" && <div className="ss-menu ss-shape-menu">{CURVE_TEMPLATES.map((t) => <button key={t.id} onClick={() => { svc.edit((s) => ops.setCurve(s, templatePoints(t.id), t.id as CurveTemplateId)); setMenu(null); }}><CurveThumb points={t.points} width={90} height={28} dashed={t.id === "freehand"} /><span>{t.name}</span></button>)}</div>}
        </span>
        <button className="ss-primary" disabled={!empty} title={empty ? `Fill ${empty} empty slot(s) — anchors and placed tracks stay put; you'll see a preview first` : "No empty slots"} onClick={() => onProposal({ kind: "fill", result: svc.autoFillPreview(set) })}>✦ Auto Fill Empty Slots</button>
      </span>}
      <span className="ss-tb-group right">
        {set.origin?.kind === "playlist" && <button onClick={onWriteBack} title="Rewrite the original playlist with this order (asks first)">↺ Update original…</button>}
        <button onClick={() => { svc.flushSave(); const v = app.sets.duplicate(set.id, true); if (v) svc.open(v.id); }} title="Keep this version and continue in a copy (version +1)">⎘ Save as new version</button>
        <button onClick={() => svc.loadToPlaylist(set)} title="Create a new playlist with this order">≡ Load into playlist</button>
        <button onClick={() => void svc.openInAutoDJ(set)} title="Create a playlist and start Auto DJ with it">↝ Open in Auto DJ</button>
        <label className="ss-inline" title="When Auto DJ plays this set, use the transitions saved in Transition Lab"><input type="checkbox" checked={set.preparedTransitions !== false} onChange={(e) => svc.edit((s) => ({ ...s, preparedTransitions: e.target.checked }))} /> Prepared transitions</label>
        <span className="ss-menu-wrap"><button onClick={() => setMenu(menu === "export" ? null : "export")}>⇩ Export</button>
          {menu === "export" && <div className="ss-menu">
            <button onClick={() => { void svc.exportSet(set, "m3u8"); setMenu(null); }}><b>M3U8 playlist</b><small>Order, duration, title, file path — no cues or analysis</small></button>
            <button onClick={() => { void svc.exportSet(set, "native"); setMenu(null); }}><b>DonkeyBillabong set (.dbdjset.json)</b><small>Everything: curve, slots, anchors, notes, rules</small></button>
          </div>}
        </span>
      </span>
    </div>
  );
}

function Timeline({ set, view, selected, setSelected, inspect, setInspect }: { set: DJSet; view: SetView; selected: number | null; setSelected: (i: number | null) => void; inspect: number | null; setInspect: (i: number | null) => void }) {
  const app = useApp(), svc = app.setStudio;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const prepared = app.preparedTransitions.all();
  const sectionOf = view.slots.map((_, i) => svc.sectionAt(set, i));
  const [dragFrom, setDragFrom] = useState<number | null>(null), [over, setOver] = useState<number | null>(null);
  const drop = (e: React.DragEvent, index: number, slotId: string, intoSlot: boolean) => {
    e.preventDefault(); setOver(null);
    const ref = e.dataTransfer.getData(DND_TYPE);
    if (ref) { const t = svc.profile(ref); if (t) svc.edit((s) => (intoSlot ? ops.assign(s, slotId, svc.toRef(t), t.energy) : ops.place(s, svc.toRef(t), t.energy, index))); setSelected(index); return; }
    if (dragFrom !== null) { svc.edit((s) => ops.moveSlot(s, dragFrom, index)); setSelected(index > dragFrom ? index - 1 : index); }
    setDragFrom(null);
  };
  return (
    <div className="ss-timeline" role="list" aria-label="Set timeline">
      {view.slots.map((sv, i) => {
        const sec = sectionOf[i], g = sec ? app.blendGroups.get(sec.groupId) : undefined, first = sec && sectionOf[i - 1]?.id !== sec.id;
        const header = first && g ? <button key={"h" + sec!.id} className="ss-sec-head" style={{ ["--gc" as string]: g.colour }} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(sec!.id)) n.delete(sec!.id); else n.add(sec!.id); return n; })}>{collapsed.has(sec!.id) ? "▸" : "▾"} {g.name} <small>{sectionOf.filter((x) => x?.id === sec!.id).length} slots · group section</small></button> : null;
        if (sec && collapsed.has(sec.id)) return header;
        const a = sv.track, b = view.slots[i + 1]?.track;
        const saved = a && b ? findPrepared(prepared, a.trackId, b.trackId, set.id) : null;
        return <div key={sv.slot.id} role="listitem">
          {header}
          <SlotRow sv={sv} groupColour={g?.colour} selected={selected === i} dragOver={over === i}
            onSelect={() => setSelected(selected === i ? null : i)}
            onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
            onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => drop(e, i, sv.slot.id, !!e.dataTransfer.getData(DND_TYPE) && !sv.slot.isLocked)} />
          {i < view.slots.length - 1 && <div className="ss-tr-row">
            <TransitionChip t={view.transitions[i]} active={inspect === i} onClick={() => setInspect(inspect === i ? null : i)} />
            {saved && <span className="ss-prepared" title={`Saved in Transition Lab: ${saved.name} (v${saved.version})${saved.setId ? "" : " — for any set"}`}>★ {saved.name}</span>}
            {inspect === i && view.transitions[i] && <TransitionDetail t={view.transitions[i]!} a={sv.track!} b={view.slots[i + 1].track!} onClose={() => setInspect(null)}
              onLab={() => openStudio({ tab: "lab", outRef: sv.track!.ref, inRef: view.slots[i + 1].track!.ref, setId: set.id, fromSlotId: sv.slot.id, toSlotId: view.slots[i + 1].slot.id })} saved={saved?.name ?? null} />}
          </div>}
        </div>;
      })}
      <button className="ss-addslot" onClick={() => { svc.edit((s) => ops.addSlot(s)); setSelected(view.slots.length); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, view.slots.length, "", false)}>＋ Add slot</button>
    </div>
  );
}

function SlotRow({ sv, groupColour, selected, dragOver, onSelect, onDragStart, onDragOver, onDragLeave, onDrop }: { sv: SlotView; groupColour?: string; selected: boolean; dragOver: boolean; onSelect: () => void; onDragStart: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent) => void }) {
  const app = useApp(), svc = app.setStudio, hearing = useAuditionRef();
  const { slot, track } = sv;
  const [notes, setNotes] = useState(false);
  const ref = track?.ref ?? slot.track?.ref;
  const title = track?.title ?? slot.track?.title, artist = track?.artist ?? slot.track?.artist;
  return (
    <div className={`ss-slot${selected ? " sel" : ""}${dragOver ? " over" : ""}${slot.isLocked ? " locked" : ""}${slot.flexible ? " flex" : ""}${sv.status === "missing" ? " missing" : ""}`}
      draggable onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={onSelect} tabIndex={0} aria-selected={selected}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onSelect(); }} style={groupColour ? { ["--gc" as string]: groupColour } : undefined}>
      <span className={`ss-num${groupColour ? " grouped" : ""}`}>{String(sv.index + 1).padStart(2, "0")}</span>
      {slot.track ? <>
        <ArtTile track={{ title: title ?? "", artist: artist ?? "", album: "", artworkUrl: track?.artworkUrl }} size={32} />
        <div className="ss-slot-main"><b>{title}</b><small>{artist}{track?.genre ? ` · ${track.subgenre ?? track.genre}` : ""}{sv.status === "moved" ? " · relinked (file moved)" : ""}</small>
          {sv.status === "missing" && <small className="warn">File missing{sv.suggestion ? <> — <button className="tiny" onClick={(e) => { e.stopPropagation(); svc.edit((s) => ops.assign(s, slot.id, svc.toRef(sv.suggestion!), sv.suggestion!.energy)); }}>relink to “{sv.suggestion.title}”</button></> : " — reconnect it in the library"}</small>}
          {slot.notes && !notes && <small className="ss-note">✎ {slot.notes}</small>}
        </div>
        <span className="ss-key">{track?.camelot ?? "—"}</span>
        <span className="mono ss-bpm">{track?.bpm?.toFixed(0) ?? "—"}<small>BPM</small></span>
        <EnergyPill value={track?.energy ?? slot.actualEnergy} target={sv.target} />
        <span className="ss-dur">{fmtDur(track?.durationSec ?? slot.track.durationSec)}</span>
      </> : <div className="ss-slot-main empty"><b>{slot.flexible ? "Flexible — decide live" : "Empty slot"}</b><small>Target energy {sv.target?.toFixed(1) ?? "—"} · {slot.flexible ? "Auto Fill leaves this open" : "pick from the dock or drag a track here"}</small></div>}
      <span className="ss-time">{fmtLong(sv.start)}</span>
      <span className="ss-slot-actions" onClick={(e) => e.stopPropagation()}>
        {slot.track && <button className={`tiny${slot.isLocked ? " on" : ""}`} onClick={() => svc.edit((s) => ops.toggleLock(s, slot.id))} title={slot.isLocked ? "Unlock anchor" : "Lock as anchor (Auto Fill won't move it)"} aria-label={slot.isLocked ? "Unlock anchor" : "Lock as anchor"}>{slot.isLocked ? "🔒" : "🔓"}</button>}
        {!slot.track && <button className={`tiny${slot.flexible ? " on" : ""}`} onClick={() => svc.edit((s) => ops.toggleFlexible(s, slot.id))} title="Mark as intentionally flexible">⋯</button>}
        {ref && track && <>
          <button className={`tiny${hearing === ref ? " on" : ""}`} onClick={() => void svc.previewToggle(ref)} title={PREVIEW_TIP}>{hearing === ref ? "■" : "▶"}</button>
          <button className="tiny" onClick={() => void svc.sendToDeck(ref, 0)} title="Load on Deck A">A</button>
          <button className="tiny" onClick={() => void svc.sendToDeck(ref, 1)} title="Load on Deck B">B</button>
          <button className="tiny" onClick={() => svc.queueNext(ref)} title="Queue next in Auto DJ">⇥</button>
          <button className="tiny" onClick={() => openStudio({ tab: "autocue", ref })} title="Auto Cue: review suggested hot cues for this track">✦</button>
        </>}
        <button className={`tiny${slot.notes ? " on" : ""}`} onClick={() => setNotes((v) => !v)} title="Notes">✎</button>
        {slot.track && !slot.isLocked && <button className="tiny" onClick={() => svc.edit((s) => ops.assign(s, slot.id, null))} title="Clear track (keep slot)">⌫</button>}
        <button className="tiny" onClick={() => svc.edit((s) => ops.removeSlot(s, slot.id))} title="Remove slot" aria-label="Remove slot">✕</button>
      </span>
      {notes && <textarea className="ss-notes" autoFocus defaultValue={slot.notes} placeholder="Notes for this slot (mix ideas, cue points, crowd reminders…)" onClick={(e) => e.stopPropagation()} onBlur={(e) => { svc.edit((s) => ops.setNotes(s, slot.id, e.target.value)); setNotes(false); }} />}
    </div>
  );
}

function TransitionDetail({ t, a, b, onClose, onLab, saved }: { t: NonNullable<SetView["transitions"][number]>; a: SetTrack; b: SetTrack; onClose: () => void; onLab: () => void; saved: string | null }) {
  return (
    <div className={`ss-tr-detail ${t.state}`} role="dialog" aria-label="Transition details">
      <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      <b>{a.title} → {b.title}</b>
      <dl>
        <dt>Compatibility</dt><dd>{t.score ?? "?"}% · {t.state === "green" ? "Compatible" : t.state === "amber" ? "Review" : "Conflict"}{t.confidence < 1 ? ` · based on ${Math.round(t.confidence * 100)}% of the checks (some data unknown)` : ""}</dd>
        <dt>Tempo</dt><dd>{a.bpm?.toFixed(1) ?? "?"} → {b.bpm?.toFixed(1) ?? "?"} BPM{t.bpmDelta !== null ? ` (${t.bpmDelta > 0 ? "+" : ""}${t.bpmDelta}, ${t.bpmPct}% after half/double check)` : ""}</dd>
        <dt>Key</dt><dd>{a.camelot ?? "?"} → {b.camelot ?? "?"} · {t.keyRelation}</dd>
        <dt>Energy</dt><dd>{a.energy?.toFixed(1) ?? "?"} → {b.energy?.toFixed(1) ?? "?"}{t.energyDelta !== null ? ` (${t.energyDelta > 0 ? "+" : ""}${t.energyDelta})` : ""}</dd>
      </dl>
      {t.warnings.length ? <ul>{t.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : <p>Good harmonic, tempo and energy alignment.</p>}
      <p className="hint">Advisory only — unconventional transitions are your call.</p>
      <button className="ss-primary" onClick={onLab}>⇄ {saved ? `Edit “${saved}” in Transition Lab` : "Open in Transition Lab"}</button>
    </div>
  );
}

function ImprovePanel({ set, view, onSelect, onProposal }: { set: DJSet; view: SetView; onSelect: (i: number) => void; onProposal: (p: { kind: "fill" | "reseq"; result: FillResult }) => void }) {
  const app = useApp(), svc = app.setStudio, o = set.origin!;
  const before = o.transitionScores.filter((x): x is number => x !== null), after = view.transitions.map((t) => t?.score ?? null).filter((x): x is number => x !== null);
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const redBefore = o.transitionStates ? o.transitionStates.filter((s) => s === "red").length : o.refs.slice(0, -1).filter((_, i) => (o.transitionScores[i] ?? 100) < 45).length;
  const problems = view.transitions.map((t, i) => ({ t, i })).filter(({ t }) => t && t.state !== "green").sort((a, b) => (a.t!.score ?? 0) - (b.t!.score ?? 0));
  const seq = sequenceScore(view.slots.map((s) => s.track), view.slots.map((s) => s.target));
  return (
    <div className="ss-improve">
      <div className="ss-improve-head"><b>IMPROVE · from {o.kind === "playlist" ? "playlist" : "set"} “{o.sourceName}”</b><span className="hint">The original is unchanged. Lock tracks you want to keep in place, then try a resequence or replace weak links.</span></div>
      <div className="ss-compare-stats">
        <div><small>Mean transition</small><b>{avg(before) ?? "—"}% → <span className={(avg(after) ?? 0) >= (avg(before) ?? 0) ? "up" : "down"}>{avg(after) ?? "—"}%</span></b></div>
        <div><small>Weakest transition</small><b>{before.length ? Math.min(...before) : "—"}% → {after.length ? Math.min(...after) : "—"}%</b></div>
        <div><small>Conflicts</small><b>{redBefore} → {view.summary.red}</b></div>
        <div><small>Flow score</small><b>{seq.pairMean !== null ? Math.round(seq.pairMean * 100) : "—"}</b></div>
        <button onClick={() => onProposal({ kind: "reseq", result: svc.resequencePreview(set) })} title="Suggest a better order of the unlocked tracks (preview first)">⇅ Suggest resequence</button>
      </div>
      {problems.length > 0 && <div className="ss-problems">
        {problems.slice(0, 6).map(({ t, i }) => {
          const fix = !view.slots[i + 1].slot.isLocked ? i + 1 : !view.slots[i].slot.isLocked ? i : null;
          return <div key={i} className={`ss-problem ${t!.state}`}><span>{i + 1}→{i + 2}</span><b>{t!.primary}</b><small>{t!.score}%</small>{fix !== null ? <button className="tiny" onClick={() => onSelect(fix)}>Find replacement for #{fix + 1}</button> : <small>both locked</small>}</div>;
        })}
      </div>}
    </div>
  );
}

function ProposalDialog({ set, view, proposal, onClose }: { set: DJSet; view: SetView; proposal: { kind: "fill" | "reseq"; result: FillResult }; onClose: () => void }) {
  const app = useApp(), svc = app.setStudio, r = proposal.result;
  const changes = r.refs.map((ref, i) => ({ i, ref, before: view.slots[i]?.track?.ref ?? null })).filter((c) => c.ref !== c.before);
  const tracks = r.refs.map((ref) => (ref ? svc.profile(ref) : null));
  const after = sequenceScore(tracks, view.slots.map((s) => s.target)), before = sequenceScore(view.slots.map((s) => s.track), view.slots.map((s) => s.target));
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Preview changes">
      <div className="modal ss-proposal">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h3>{proposal.kind === "fill" ? "Auto Fill preview" : "Resequence preview"}</h3>
        <p className="hint">{proposal.kind === "fill" ? `${r.filled} slot(s) filled${r.unfilled ? `, ${r.unfilled} left empty (no compatible track)` : ""}. Locked anchors and placed tracks are unchanged.` : "Unlocked tracks reordered for smoother flow; locked tracks stay in place."} Planned ≈ {fmtLong(r.durationSec)} of {fmtLong(set.durationTargetSec)}.</p>
        <p className="hint">Flow {before.pairMean !== null ? Math.round(before.pairMean * 100) : "—"} → <b>{after.pairMean !== null ? Math.round(after.pairMean * 100) : "—"}</b> · energy fit {before.energyMean !== null ? Math.round(before.energyMean * 100) : "—"} → <b>{after.energyMean !== null ? Math.round(after.energyMean * 100) : "—"}</b></p>
        <div className="ss-proposal-list">
          {changes.length ? changes.map((c) => { const t = c.ref ? svc.profile(c.ref) : null; return (
            <div key={c.i} className="ss-proposal-row"><span className="ss-num">{String(c.i + 1).padStart(2, "0")}</span><b>{t ? `${t.artist ? `${t.artist} – ` : ""}${t.title}` : "— empty —"}</b><span className="ss-key">{t?.camelot ?? "—"}</span><span className="mono">{t?.bpm?.toFixed(0) ?? "—"}</span><EnergyPill value={t?.energy ?? null} target={view.slots[c.i]?.target} /></div>); })
            : <p className="ss-empty">No changes suggested — the current order already scores best.</p>}
        </div>
        <div className="ss-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!changes.length} onClick={() => { svc.applyRefs(r.refs, proposal.kind === "fill" ? `Auto Fill placed ${changes.length} track(s)` : `Resequenced ${changes.length} slot(s)`); onClose(); }}>Apply {changes.length} change{changes.length === 1 ? "" : "s"}</button></div>
      </div>
    </div>
  );
}

function GroupsBoard({ set, active, setActive }: { set: DJSet; active: string | null; setActive: (id: string) => void }) {
  const app = useApp(), svc = app.setStudio, hearing = useAuditionRef();
  const current = active ?? set.groups[0]?.id ?? null;
  const [name, setName] = useState("");
  const bg = app.blendGroups;
  /** Add a track to a set group — or, when it is linked, to the reusable group behind it. */
  const add = (g: DJSet["groups"][number], t: SetTrack) => { if (g.blendGroupId) { if (!bg.addTracks(g.blendGroupId, [t])) svc.edit((s) => s, false); } else svc.edit((s) => ops.addToGroup(s, g.id, svc.toRef(t))); };
  const remove = (g: DJSet["groups"][number], ref: string) => { if (g.blendGroupId) bg.removeTrack(g.blendGroupId, ref); else svc.edit((s) => ops.removeFromGroup(s, g.id, ref)); };
  const makeReusable = (g: DJSet["groups"][number]) => {
    const n = bg.create(g.name, { energyMin: g.energyMin, energyMax: g.energyMax, moods: g.moodPreferences, genres: g.genrePreferences });
    bg.addTracks(n.id, g.tracks.map((r) => svc.resolve(r).track).filter((x): x is SetTrack => !!x));
    svc.edit((s) => ops.linkGroup(s, g.id, n.id));
  };
  return (
    <div className="ss-groups">
      <p className="hint">Groups are flexible pools — no fixed order. Select a group, then add tracks from the dock. Load into playlist concatenates groups in this order. A group linked to a reusable Blend Group (⛓) shares its tracks with every set that uses it.</p>
      <div className="ss-gnew"><select value="" onChange={(e) => { if (!e.target.value) return; const r = bg.get(e.target.value); if (!r) return; svc.edit((s) => { const n = ops.addGroup(s, r.name); return ops.linkGroup(ops.updateGroup(n, n.groups[n.groups.length - 1].id, { energyMin: r.energyMin, energyMax: r.energyMax }), n.groups[n.groups.length - 1].id, r.id); }); }} aria-label="Add a reusable group"><option value="">＋ Add a reusable Blend Group…</option>{bg.all().map((r) => <option key={r.id} value={r.id}>{r.name} ({r.tracks.length})</option>)}</select></div>
      <div className="ss-group-cols">
        {set.groups.map((g) => (
          <div key={g.id} className={`ss-group${current === g.id ? " on" : ""}`} onClick={() => setActive(g.id)}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const ref = e.dataTransfer.getData(DND_TYPE); const t = ref ? svc.profile(ref) : null; if (t) add(g, t); }}>
            <header>{g.blendGroupId && <span className="ss-link" title="Linked to a reusable Blend Group — edits to its tracks apply everywhere it is used">⛓</span>}<input value={g.name} aria-label="Group name" onChange={(e) => svc.edit((s) => ops.updateGroup(s, g.id, { name: e.target.value }), false)} onBlur={() => svc.edit((s) => s)} />
              {g.blendGroupId ? <button className="tiny" onClick={(e) => { e.stopPropagation(); svc.edit((s) => ops.updateGroup(ops.linkGroup(s, g.id, null), g.id, { tracks: svc.groupTracks(g) })); }} title="Unlink: keep a copy of the tracks in this set only">unlink</button>
                : <button className="tiny" onClick={(e) => { e.stopPropagation(); makeReusable(g); }} title="Save as a reusable Blend Group (usable in other sets)">⛓ reuse</button>}
              <button className="tiny" onClick={(e) => { e.stopPropagation(); svc.edit((s) => ops.removeGroup(s, g.id)); }} aria-label={`Remove group ${g.name}`}>×</button></header>
            <label className="ss-inline">Energy <input type="number" min={1} max={10} step={0.5} value={g.energyMin} onChange={(e) => svc.edit((s) => ops.updateGroup(s, g.id, { energyMin: Number(e.target.value) || 1 }))} />–<input type="number" min={1} max={10} step={0.5} value={g.energyMax} onChange={(e) => svc.edit((s) => ops.updateGroup(s, g.id, { energyMax: Number(e.target.value) || 10 }))} /></label>
            <div className="ss-group-tracks">
              {svc.groupTracks(g).map((t) => { const r = svc.resolve(t); return (
                <div key={t.ref} className={`ss-group-track${r.status === "missing" ? " missing" : ""}`}>
                  <span><b>{t.title}</b><small>{t.artist}</small></span><EnergyPill value={r.track?.energy ?? null} /><span className="ss-key">{r.track?.camelot ?? "—"}</span>
                  {r.track && <button className={`tiny${hearing === r.track.ref ? " on" : ""}`} onClick={(e) => { e.stopPropagation(); void svc.previewToggle(r.track!.ref); }} title={PREVIEW_TIP}>{hearing === r.track.ref ? "■" : "▶"}</button>}
                  {r.track && <button className="tiny" onClick={(e) => { e.stopPropagation(); void svc.sendToDeck(r.track!.ref, 0); }} title="Deck A">A</button>}
                  {r.track && <button className="tiny" onClick={(e) => { e.stopPropagation(); void svc.sendToDeck(r.track!.ref, 1); }} title="Deck B">B</button>}
                  <button className="tiny" onClick={(e) => { e.stopPropagation(); remove(g, t.ref); }} aria-label={`Remove ${t.title}`}>×</button>
                </div>); })}
              {!svc.groupTracks(g).length && <p className="ss-empty">Drop tracks here</p>}
            </div>
          </div>
        ))}
        <div className="ss-group add"><input placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { svc.edit((s) => ops.addGroup(s, name)); setName(""); } }} /><button disabled={!name.trim()} onClick={() => { svc.edit((s) => ops.addGroup(s, name)); setName(""); }}>＋ Add group</button></div>
      </div>
    </div>
  );
}

/** Reusable groups assigned to parts of the energy curve (Phase 2). */
function GroupSections({ set, view, onProposal }: { set: DJSet; view: SetView; onProposal: (p: { kind: "fill" | "reseq"; result: FillResult }) => void }) {
  const app = useApp(), svc = app.setStudio, bg = app.blendGroups;
  const sections = set.groupSections ?? [], mins = set.durationTargetSec / 60;
  const m = (x: number) => Math.round(x * mins);
  if (!bg.all().length && !sections.length) return <p className="hint ss-sections-empty">Tip: create reusable groups in <button className="tiny" onClick={() => openStudio({ tab: "groups" })}>Blend Groups</button> and assign them to parts of this curve.</p>;
  return (
    <div className="ss-sections">
      <div className="ss-sections-bar">{sections.map((s) => { const g = bg.get(s.groupId); return g && <span key={s.id} className="ss-sec-band" style={{ left: `${s.start * 100}%`, width: `${(s.end - s.start) * 100}%`, ["--gc" as string]: g.colour }} title={`${g.name}: ${m(s.start)}–${m(s.end)} min`}>{g.name}</span>; })}</div>
      {sections.map((s) => { const g = bg.get(s.groupId); const slots = view.slots.filter((_, i) => svc.sectionAt(set, i)?.id === s.id); const empty = slots.filter((x) => !x.slot.track && !x.slot.flexible).length; return (
        <div key={s.id} className="ss-sec-row" style={{ ["--gc" as string]: g?.colour }}>
          <i />
          <select value={s.groupId} onChange={(e) => svc.edit((x) => ops.updateSection(x, s.id, { groupId: e.target.value }))} aria-label="Group">{bg.all().map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <label className="ss-inline"><input type="number" min={0} max={mins} value={m(s.start)} onChange={(e) => svc.edit((x) => ops.updateSection(x, s.id, { start: (Number(e.target.value) || 0) / mins }))} aria-label="Section start minutes" />–<input type="number" min={0} max={mins} value={m(s.end)} onChange={(e) => svc.edit((x) => ops.updateSection(x, s.id, { end: (Number(e.target.value) || 0) / mins }))} aria-label="Section end minutes" /> min</label>
          <small>{slots.length} slots · {g?.tracks.length ?? 0} tracks in group</small>
          <button disabled={!empty} onClick={() => onProposal({ kind: "fill", result: svc.autoFillPreview(set, { sectionId: s.id }) })} title="Fill this section's empty slots from the group (anchors first) — preview first">✦ Auto Fill from {g?.name ?? "group"}</button>
          <button className="tiny" onClick={() => svc.edit((x) => ops.removeSection(x, s.id))} aria-label="Remove section">✕</button>
        </div>); })}
      <select value="" onChange={(e) => { if (!e.target.value) return; const last = sections.reduce((a, s) => Math.max(a, s.end), 0); svc.edit((x) => ops.addSection(x, e.target.value, last >= 1 ? 0 : last, last >= 1 ? 0.25 : Math.min(1, last + 0.25))); }} aria-label="Assign a group to a section"><option value="">＋ Assign a Blend Group to part of the curve…</option>{bg.all().map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <span className="hint"> Slots in a section draw only from that group when Auto Filling; you can still place any track by hand.</span>
    </div>
  );
}

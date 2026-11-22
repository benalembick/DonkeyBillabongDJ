/**
 * Auto Cue review: generated hot cue suggestions over the track's waveform, beat grid, phrases, existing
 * hot cues and mix regions. Suggestions are staged; only Accept puts one on a pad (asking before any
 * occupied slot is replaced). Works on the app's cue database — the deck's "Suggested" cue source.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { useAnimationFrame, useFrameStore } from "../hooks";
import { ArtTile } from "../ArtTile";
import { usePreview, useStudio } from "./shared";
import { useEngineState } from "../context";
import { useWaveform, WaveCanvas } from "./WaveCanvas";
import { AUTOCUE_VERSION, CUE_TYPES, HIGH_CONFIDENCE, LOW_CONFIDENCE, type CueType, type GeneratedCue, type QuantiseMode } from "../../setstudio/autocue";
import { AutoCueService, type PadPlan, type SlotInfo } from "../../setstudio/AutoCueService";
import { gridReliable as gridTrusted } from "../../preparation/beatGrid";
import { fixGridFor } from "../gridEditorStore";

const QMODES: [QuantiseMode, string][] = [["none", "No quantise"], ["beat", "Nearest beat"], ["bar", "Nearest bar"], ["4bars", "Nearest 4 bars"], ["8bars", "Nearest 8 bars"], ["16bars", "Nearest 16 bars"]];
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const SLOT = (n: number) => String.fromCharCode(65 + n);

export function AutoCuePanel({ initialRef }: { initialRef?: string | null }) {
  const app = useApp(), svc = app.autoCue;
  const [ref, setRef] = useState<string | null>(initialRef ?? null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ cue: GeneratedCue; slot: number; occupied: SlotInfo } | null>(null);
  const [slotPick, setSlotPick] = useState<GeneratedCue | null>(null);
  const [note, setNote] = useState<string | null>(null), [confirmAll, setConfirmAll] = useState(false);
  const [dupe, setDupe] = useState<{ cue: GeneratedCue; slot?: number; occupied: SlotInfo } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false), [restoring, setRestoring] = useState(false);
  const rev = useFrameStore(useCallback((cb) => { const a = svc.on("change", cb), b = app.preparation.on("record", cb); return () => { a(); b(); }; }, [svc, app.preparation]), () => app.preparation.getState().revision);
  const rec = ref ? app.preparation.forRef(ref) : undefined;
  const set = rec?.autoCues;
  const slots = useMemo(() => (rec ? svc.slots(rec.trackId) : []), [svc, rec, rev]);
  const plan = useMemo(() => (rec?.autoCues ? svc.planLayout(rec.trackId) : null), [svc, rec, rev]);
  const planned = useMemo(() => { const m = new Map<string, string>(); for (const p of plan?.pads ?? []) p.cueIds.forEach((id, i) => m.set(id, i ? `shares pad ${SLOT(p.slot)}` : `pad ${SLOT(p.slot)}`)); for (const s of plan?.skipped ?? []) if (!m.has(s.id)) m.set(s.id, "not on a pad"); return m; }, [plan]);
  const track = ref ? app.setStudio.profile(ref) : null;
  const pool = useMemo(() => { const s = q.trim().toLowerCase(); return app.setStudio.pool().filter((t) => t.analysed && (!s || `${t.title} ${t.artist}`.toLowerCase().includes(s))).slice(0, 80); }, [app.setStudio, q, rev]);

  const generate = async () => { if (!ref) return; setBusy(true); setErr(null); try { await svc.generate(ref); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const accept = (c: GeneratedCue, slot?: number) => {
    if (!rec) return;
    const r = svc.accept(rec.trackId, c.id, slot);
    if (r.ok) return;
    if (r.reason === "occupied" && r.occupied) setConfirm({ cue: c, slot: r.occupied.slot, occupied: r.occupied });
    if (r.reason === "no-free-slot") setSlotPick(c);
    if (r.reason === "duplicate" && r.occupied) setDupe({ cue: c, slot, occupied: r.occupied });
  };
  const summary = (r: { accepted: number; merged: number; staged: number }) =>
    `${r.accepted} pad${r.accepted === 1 ? "" : "s"} set in time order${r.merged ? ` · ${r.merged} cue${r.merged === 1 ? "" : "s"} shared a pad with another at the same moment` : ""}${r.staged ? ` · ${r.staged} still staged — no free pads` : ""}`;
  const restorePads = async () => {
    if (!rec) return;
    setRestoring(true); setConfirmRestore(false);
    try { const r = await svc.restoreOriginalPads(rec.trackId); setNote(r === "restored" ? "Pads restored to how they were before Auto Cue" : r === "resuggested" ? "Auto Cue pads removed and the original analysis suggestions re-run into the empty pads" : "Nothing to restore"); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setRestoring(false); }
  };
  if (!ref || !rec || !track) {
    return (
      <div className="ss-autocue">
        <header className="ss-title"><h2><span className="ss-bar" />AUTO CUE</h2><span className="hint">Pick an analysed track. Suggestions come from its cached analysis; nothing goes on your pads until you accept it.</span></header>
        <input className="ss-search wide" placeholder="Search analysed tracks…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search analysed tracks" />
        <div className="ss-mini-list tall">
          {pool.map((t) => <button key={t.ref} className="ss-mini-track" onClick={() => setRef(t.ref)}><ArtTile track={{ title: t.title, artist: t.artist, album: "", artworkUrl: t.artworkUrl }} size={26} /><span><b>{t.title}</b><small>{t.artist}</small></span><small>{t.bpm?.toFixed(0) ?? "—"} BPM</small><small>{app.preparation.forRef(t.ref)?.autoCues ? "✓ cues" : ""}</small></button>)}
          {!pool.length && <p className="ss-empty">No analysed tracks — run Library Intelligence first.</p>}
        </div>
      </div>
    );
  }
  const counts = set ? { high: set.cues.filter((c) => c.reviewStatus === "suggested" && c.confidence >= HIGH_CONFIDENCE && c.slot === null && !svc.coveredBy(rec.trackId, c.id)).length } : { high: 0 };
  return (
    <div className="ss-autocue">
      <div className="ss-ac-head">
        <button className="ss-back" onClick={() => setRef(null)}>‹ Tracks</button>
        <ArtTile track={{ title: track.title, artist: track.artist, album: "", artworkUrl: track.artworkUrl }} size={34} />
        <div className="ss-ac-title"><b>{track.title}</b><small>{track.artist} · {track.bpm?.toFixed(1) ?? "?"} BPM · {track.camelot ?? "key ?"} · grid {rec.beatGrid ? `${rec.beatGrid.confidence.toFixed(1)}${rec.beatGrid.manuallyAdjusted ? " (manual)" : ""}` : "none"}</small></div>{!gridTrusted(AutoCueService.gridOf(rec)) && <button className="tiny ss-fix-grid" onClick={() => fixGridFor(app, ref)} title="Bar- and phrase-based cues need a trusted beat grid. Opens the Beat grid editor on a deck.">⚠ Fix grid…</button>}
        <span className="ss-tb-group right">
          <button className="ss-primary" disabled={busy || svc.isBusy(rec.trackId)} onClick={() => void generate()}>{busy ? "Analysing…" : set ? "↻ Regenerate Suggestions" : "✦ Generate Suggestions"}</button>
          {set && <select value={set.quantise} onChange={(e) => svc.requantise(rec.trackId, e.target.value as QuantiseMode)} aria-label="Quantise">{QMODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>}
          {set && <button disabled={!counts.high} onClick={() => { if (svc.autoSuggestedPads(rec.trackId).length && !slots.some((s) => !s.cue)) { setConfirmAll(true); return; } const r = svc.acceptAllHigh(rec.trackId); if (r.staged && svc.autoSuggestedPads(rec.trackId).length) setConfirmAll(true); setNote(summary(r)); }} title={`Put every suggestion with ≥${Math.round(HIGH_CONFIDENCE * 100)}% confidence on free pads, in time order; cues at the same moment share one pad`}>✓ Accept All High-Confidence ({counts.high})</button>}
          {set?.previous && <button onClick={() => svc.restorePrevious(rec.trackId)} title="Bring back the suggestion list from before the last regeneration (pads are not changed)">⟲ Previous suggestions</button>}
          {(svc.canRestorePads(rec.trackId) || restoring) && <button disabled={restoring} onClick={() => setConfirmRestore(true)} title="Put the hot cue pads back as they were before Auto Cue changed them">{restoring ? "Restoring…" : "⟲ Restore original pads"}</button>}
        </span>
      </div>
      {err && <p className="ss-msg warn">{err}</p>}
      {set && (set.version ?? 1) < AUTOCUE_VERSION && <p className="ss-msg warn">These suggestions came from an older Auto Cue (before repeated drops and the outro-after-last-drop rule). Press <b>↻ Regenerate Suggestions</b> for a better pad layout — your accept/reject decisions are kept.</p>}
      {note && <p className="ss-msg" role="status">{note}</p>}
      <p className="hint ss-ac-note">Accepted cues go into this app's cue database — what decks show with the <b>Suggested</b> cue source (Embedded decks are unchanged; use <b>→ File</b> on a deck to copy them into the file). Your own cues are never replaced without asking.</p>
      <CueWaveform trackId={rec.trackId} refPath={ref} duration={rec.duration} grid={AutoCueService.gridOf(rec)} cues={set?.cues ?? []} slots={slots} mixIn={set?.mixIn ?? []} mixOut={set?.mixOut ?? []} onMove={(id, t) => svc.move(rec.trackId, id, t)} />
      <HotcueBank slots={slots} refPath={ref} />
      {plan && <LayoutCard plan={plan} slots={slots} onApply={() => { const r = svc.applyLayout(rec.trackId); setNote(r.changed ? `Recommended layout applied — ${r.changed} pad${r.changed === 1 ? "" : "s"} changed. The previous pads are saved: ⟲ Restore original pads brings them back.` : "The pads already match the recommended layout"); }} />}
      {!set ? <p className="ss-empty">No suggestions yet — press Generate Suggestions.</p> : <>
        <div className="ss-ac-table" role="table" aria-label="Cue suggestions">
          <div className="ss-ac-row head" role="row"><span /><span>Cue</span><span>Type</span><span>Detected → Cue</span><span>Confidence</span><span>Status</span><span /></div>
          {set.cues.map((c) => <CueRow key={c.id} c={c} trackId={rec.trackId} refPath={ref} planned={planned.get(c.id)} onAccept={(slot) => accept(c, slot)} />)}
        </div>
        {set.unavailable.length > 0 && <div className="ss-ac-missing"><b>Not suggested</b>{set.unavailable.map((u) => <span key={u.cueType}><i style={{ background: CUE_TYPES.find((x) => x.id === u.cueType)?.colour }} />{CUE_TYPES.find((x) => x.id === u.cueType)?.label}: {u.reason}</span>)}</div>}
        <div className="ss-ac-regions">
          {(["in", "out"] as const).map((k) => <div key={k}><b>{k === "in" ? "Mix-in regions" : "Mix-out regions"}</b>
            {(k === "in" ? set.mixIn : set.mixOut).map((m) => <div key={m.label} className="ss-region"><span className="ss-chip">{m.label}</span><span className="mono">{fmt(m.start)} → {fmt(m.end)}</span><small>{Math.round(m.availableSeconds)} s · {Math.round(m.confidence * 100)}%{m.phraseAligned ? " · phrase-aligned" : ""}</small><small className="hint">{m.rationale}</small></div>)}
            {!(k === "in" ? set.mixIn : set.mixOut).length && <p className="hint">None found.</p>}
          </div>)}
        </div>
      </>}
      {confirm && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Replace hot cue">
        <div className="modal ss-confirm">
          <h3>Replace hot cue {SLOT(confirm.slot)}?</h3>
          <p>Slot {SLOT(confirm.slot)} holds <b>{confirm.occupied.cue?.name}</b> at {fmt(confirm.occupied.cue?.timestamp ?? 0)}{confirm.occupied.manual ? " — a cue you placed" : ""}. Replace it with <b>{confirm.cue.label}</b> at {fmt(confirm.cue.quantisedPosition)}?</p>
          <div className="ss-actions"><button onClick={() => setConfirm(null)}>Keep my cue</button><button className="danger" onClick={() => { svc.accept(rec.trackId, confirm.cue.id, confirm.slot, { replace: true }); setConfirm(null); }}>Replace</button></div>
        </div>
      </div>}
      {confirmAll && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Replace auto-suggested pads">
        <div className="modal ss-confirm">
          <h3>Replace the older auto-suggested pads?</h3>
          <p>These pads hold cues the analysis suggested automatically (not ones you placed): <b>{svc.autoSuggestedPads(rec.trackId).map((s) => `${SLOT(s.slot)} ${s.cue?.name}`).join(", ")}</b>. Replace them with the high-confidence Auto Cue suggestions, laid out in time order? The current pads are saved first, so <b>Restore original pads</b> can bring them back. Cues you placed or edited are never touched.</p>
          <div className="ss-actions"><button onClick={() => setConfirmAll(false)}>Keep them</button><button className="danger" onClick={() => { const r = svc.acceptAllHigh(rec.trackId, { replaceAutoSuggested: true }); setNote(summary(r) + " · the previous pads are saved — Restore original pads brings them back"); setConfirmAll(false); }}>Replace auto-suggested pads</button></div>
        </div>
      </div>}
      {dupe && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Same moment">
        <div className="modal ss-confirm">
          <h3>Pad {SLOT(dupe.occupied.slot)} is already at {fmt(dupe.occupied.cue?.timestamp ?? 0)}</h3>
          <p><b>{dupe.cue.label}</b> lands on the same moment as pad {SLOT(dupe.occupied.slot)} (<b>{dupe.occupied.cue?.name}</b>). A second pad there would just duplicate it. Add it anyway?</p>
          <div className="ss-actions"><button onClick={() => setDupe(null)}>Don't duplicate</button><button onClick={() => { const r = svc.accept(rec.trackId, dupe.cue.id, dupe.slot, { allowDuplicate: true }); setDupe(null); if (!r.ok && r.reason === "occupied" && r.occupied) setConfirm({ cue: dupe.cue, slot: r.occupied.slot, occupied: r.occupied }); if (!r.ok && r.reason === "no-free-slot") setSlotPick(dupe.cue); }}>Add a second pad</button></div>
        </div>
      </div>}
      {confirmRestore && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Restore original pads">
        <div className="modal ss-confirm">
          <h3>Restore the original pads?</h3>
          <p>{set?.padBackup ? "The pads go back to exactly how they were before Auto Cue changed them. A pad you changed yourself since then is kept." : "These pads were changed before backups existed, so Auto Cue's pads are taken off and the original analysis suggestions (Intro, Build, Drop, Outro…) are re-run into the empty pads — the same as ↻ on the deck. Cues you placed yourself are kept."} The Auto Cue suggestions stay in the list.</p>
          <div className="ss-actions"><button onClick={() => setConfirmRestore(false)}>Cancel</button><button className="danger" onClick={() => void restorePads()}>Restore original pads</button></div>
        </div>
      </div>}
      {slotPick && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Choose a slot">
        <div className="modal ss-confirm">
          <h3>All 8 hot cue slots are in use</h3>
          <p>{slotPick.label} stays in the suggestions list. To use it now, pick a slot to replace:</p>
          <div className="ss-slotpick">{slots.map((s) => <button key={s.slot} onClick={() => { setSlotPick(null); accept(slotPick, s.slot); }}><b>{SLOT(s.slot)}</b><small>{s.cue?.name ?? "empty"}{s.manual ? " (yours)" : ""}</small></button>)}</div>
          <div className="ss-actions"><button onClick={() => setSlotPick(null)}>Keep it staged</button></div>
        </div>
      </div>}
    </div>
  );
}

function CueRow({ c, trackId, refPath, planned, onAccept }: { c: GeneratedCue; trackId: string; refPath: string; planned?: string; onAccept: (slot?: number) => void }) {
  const app = useApp(), svc = app.autoCue, preview = usePreview();
  useStudio(); useEngineState(); // re-render when an audition starts/stops
  const [name, setName] = useState(c.label);
  const low = c.confidence < LOW_CONFIDENCE;
  const from = Math.max(0, c.quantisedPosition - 2);
  const aud = app.setStudio.getState().audition;
  const hearing = !!aud && aud.ref === refPath && Math.abs(aud.at - from) < 0.05 && (aud.where === "headphones" ? preview.ref === refPath : app.engine.getState().decks[aud.deck ?? 0]?.playing);
  const listen = () => void app.setStudio.audition(refPath, from);
  const covered = c.slot === null && c.reviewStatus !== "rejected" ? svc.coveredBy(trackId, c.id) : null;
  return (
    <div className={`ss-ac-row ${c.reviewStatus}${low ? " low" : ""}`} role="row">
      <span className="ss-ac-swatch" style={{ background: c.colour }} />
      <span><input className="ss-ac-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== c.label && svc.rename(trackId, c.id, name)} aria-label="Cue name" /><small className="hint">{c.detectionMethod}{c.note ? ` · ${c.note}` : ""}</small></span>
      <select value={c.cueType} onChange={(e) => svc.changeType(trackId, c.id, e.target.value as CueType)} aria-label="Cue type">{CUE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      <span className="mono">{fmt(c.detectedPosition)} → <b>{fmt(c.quantisedPosition)}</b></span>
      <span className="ss-conf" title={low ? "Low confidence — treat as a rough guide" : undefined}><i style={{ width: `${Math.round(c.confidence * 100)}%` }} />{Math.round(c.confidence * 100)}%</span>
      <span className={`ss-ac-status ${c.reviewStatus}${covered ? " covered" : ""}`}>{covered ? `same moment as pad ${SLOT(covered.slot)}` : c.reviewStatus}{c.slot !== null ? ` · pad ${SLOT(c.slot)}` : ""}{planned && c.slot === null && (!covered || planned !== `pad ${SLOT(covered.slot)}`) ? <em className="ss-ac-plan" title="Where the recommended layout puts it">★ {planned}</em> : null}</span>
      <span className="ss-ac-actions">
        <button className={`tiny${hearing ? " on" : ""}`} onClick={listen} aria-label={hearing ? "Stop preview" : "Preview from 2 s before the cue"} title={preview.available ? "Preview from 2 s before the cue (headphones)" : "Play from 2 s before the cue on Deck A (no headphone output; only when nothing else is playing) — press again to stop"}>{hearing ? "■" : "▶"}</button>
        {c.reviewStatus !== "rejected" && c.slot === null && <button className="tiny primary" onClick={() => onAccept()} title="Put on the first free hot cue pad">Accept</button>}
        {c.slot !== null && <button className="tiny" onClick={() => svc.removeFromPads(trackId, c.id)} title="Take off the pad (back to suggestions)">Off pad</button>}
        {c.reviewStatus !== "rejected" ? <button className="tiny" onClick={() => svc.reject(trackId, c.id)}>Reject</button> : <button className="tiny" onClick={() => svc.restore(trackId, c.id)}>Restore</button>}
      </span>
    </div>
  );
}

/** The 8 hot cue pads: press and hold to play from the cue (like the deck pads), release to return to it. */
function HotcueBank({ slots, refPath }: { slots: SlotInfo[]; refPath: string }) {
  const app = useApp(), svc = app.setStudio;
  const [held, setHeld] = useState<number | null>(null);
  // The current hold lives in a ref so a release is never missed or misattributed by a re-render.
  const holding = useRef<{ slot: number; off: () => void } | null>(null);
  const up = useCallback(() => { const h = holding.current; if (!h) return; holding.current = null; h.off(); setHeld(null); svc.holdEnd(); }, [svc]);
  const down = (s: SlotInfo, via: "pointer" | "key") => {
    if (!s.cue || holding.current) return;
    // Release = the pointer/key actually going up anywhere, or the window losing focus. Moving focus between pads isn't a release.
    const release = (e: Event) => { if (via === "key" && e.type === "keyup" && !((e as KeyboardEvent).key === " " || (e as KeyboardEvent).key === "Enter")) return; up(); };
    const types = via === "pointer" ? ["pointerup", "pointercancel"] : ["keyup"];
    for (const t of types) window.addEventListener(t, release, true);
    window.addEventListener("blur", release);
    holding.current = { slot: s.slot, off: () => { for (const t of types) window.removeEventListener(t, release, true); window.removeEventListener("blur", release); } };
    setHeld(s.slot);
    void svc.holdStart(refPath, s.slot, s.cue.timestamp);
  };
  useEffect(() => up, [up]); // leaving the screen releases a held pad
  return (
    <div className="ss-bank" aria-label="Hot cue pads — press and hold to play from a cue">
      {slots.map((s) => (
        <button key={s.slot} type="button" disabled={!s.cue} className={`ss-pad${s.cue ? " on" : ""}${s.manual ? " manual" : ""}${s.generatedId ? " gen" : ""}${held === s.slot ? " held" : ""}`} style={s.cue ? { ["--pc" as string]: s.cue.colour } : undefined}
          title={s.cue ? `${s.cue.name} at ${fmt(s.cue.timestamp)}${s.manual ? " — your cue (protected)" : s.generatedId ? " — accepted Auto Cue" : s.autoCue ? " — placed by Auto Cue (can be rearranged)" : " — auto-suggested by analysis"}. Hold to play from here; release to return.` : "Empty"}
          onPointerDown={(e) => { if (e.button === 0) down(s, "pointer"); }}
          onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); down(s, "key"); } }}
          onContextMenu={(e) => e.preventDefault()}
          aria-pressed={held === s.slot}><b>{SLOT(s.slot)}{s.cue && <span className="mono"> {fmt(s.cue.timestamp)}</span>}</b><small>{s.cue?.name ?? "—"}</small></button>
      ))}
    </div>
  );
}

const ACTION: Record<string, string> = { "keep-yours": "yours", keep: "keep", move: "move", new: "new", replace: "replace", empty: "clear" };
/** The recommended 8 pads (which suggestion goes where, and why) with one-click apply. */
function LayoutCard({ plan, slots, onApply }: { plan: PadPlan; slots: SlotInfo[]; onApply: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="ss-layout" aria-label="Recommended pad layout">
      <header>
        <button className="ss-layout-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "▾" : "▸"} <b>Recommended pad layout</b></button>
        <span className="hint">{plan.changes ? `${plan.changes} pad${plan.changes === 1 ? "" : "s"} would change · your own cues stay put · pads follow the track A → H` : "Your pads already match the recommendation"}</span>
        <button className="ss-primary" disabled={!plan.changes} onClick={onApply} title="Put the recommended cues on the pads. The current pads are saved first — ⟲ Restore original pads undoes it.">✓ Apply recommended layout</button>
      </header>
      {open && <>
        <div className="ss-layout-grid">
          {plan.pads.map((p) => (
            <div key={p.slot} className={`ss-layout-pad ${p.action}`} style={p.time !== null ? { ["--pc" as string]: p.colour } : undefined} title={p.why}>
              <span className="ss-layout-slot">{SLOT(p.slot)}</span>
              {p.time !== null && p.action !== "empty" ? <><b>{p.name}</b><span className="mono">{fmt(p.time)}</span></> : <b className="hint">—</b>}
              <small className={`ss-layout-badge ${p.action}`}>{ACTION[p.action]}{p.action === "replace" && p.replaces ? ` ${p.replaces}` : ""}{p.action === "empty" && slots[p.slot]?.cue ? ` ${slots[p.slot].cue!.name}` : ""}</small>
              {p.why && <small className="hint">{p.why}</small>}
            </div>
          ))}
        </div>
        {plan.skipped.length > 0 && <div className="ss-layout-skip"><b>Left off the pads</b>{plan.skipped.map((s) => <span key={s.id}><span className="mono">{fmt(s.time)}</span> {s.label} — {s.reason}</span>)}</div>}
      </>}
    </section>
  );
}

/** Waveform with grid, phrases, mix regions, existing hot cues (solid) and suggestions (dashed, draggable). */
function CueWaveform({ trackId, refPath, duration, grid, cues, slots, mixIn, mixOut, onMove }: { trackId: string; refPath: string; duration: number; grid: ReturnType<typeof AutoCueService.gridOf>; cues: GeneratedCue[]; slots: SlotInfo[]; mixIn: { start: number; end: number; label: string }[]; mixOut: { start: number; end: number; label: string }[]; onMove: (id: string, t: number) => void }) {
  const app = useApp(), wave = useWaveform(trackId);
  const head = useRef<HTMLDivElement>(null), headLabel = useRef<HTMLSpanElement>(null);
  const [zoom, setZoom] = useState(1), [offset, setOffset] = useState(0), [drag, setDrag] = useState<{ id: string; t: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const span = duration / zoom, from = Math.max(0, Math.min(duration - span, offset)), to = from + span;
  const X = (t: number) => `${((t - from) / span) * 100}%`;
  const tAt = (clientX: number) => { const r = box.current!.getBoundingClientRect(); return from + ((clientX - r.left) / r.width) * span; };
  // Live playhead: the headphone preview of this track, else a deck it is loaded on (updated every frame, no re-render).
  useAnimationFrame(() => {
    const el = head.current; if (!el) return;
    let pos: number | null = null, where = "";
    if (app.preview.state.ref === refPath) { pos = app.preview.position(); where = "🎧"; }
    if (pos === null) { const d = app.engine.getState().decks.find((x) => x.track?.ref === refPath && x.status === "ready"); if (d) { pos = app.engine.getPosition(d.index); where = `${String.fromCharCode(65 + d.index)}${d.playing ? " ▶" : ""}`; } }
    if (pos === null || pos < from || pos > to) { el.style.display = "none"; return; }
    el.style.display = "block"; el.style.left = `${((pos - from) / span) * 100}%`;
    if (headLabel.current) headLabel.current.textContent = `${where} ${fmt(pos)}`;
  });
  const snapBeat = (t: number) => (grid ? grid.firstBeat + Math.round((t - grid.firstBeat) / (60 / grid.bpm)) * (60 / grid.bpm) : t);
  const bar = grid ? 240 / grid.bpm : 0;
  const lines: { t: number; phrase: boolean }[] = [];
  if (grid && span / bar < 400) for (let b = Math.max(0, Math.floor((from - grid.firstBeat) / bar)); grid.firstBeat + b * bar < to; b++) lines.push({ t: grid.firstBeat + b * bar, phrase: b % 8 === 0 });
  return (
    <div className="ss-cuewave">
      <div className="ss-cuewave-tools">
        <span className="ss-label">WAVEFORM</span><span className="hint">drag a dashed suggestion to move it (snaps to beats; hold Alt for free) · click to hear from there</span>
        <span className="ss-zoom"><button className="tiny" onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1} aria-label="Zoom out">－</button><output>{zoom}×</output><button className="tiny" onClick={() => setZoom((z) => Math.min(32, z * 2))} aria-label="Zoom in">＋</button></span>
        {zoom > 1 && <input type="range" min={0} max={Math.max(0, duration - span)} step={0.1} value={from} onChange={(e) => setOffset(Number(e.target.value))} aria-label="Scroll waveform" />}
      </div>
      <div className="ss-cuewave-box" ref={box}
        onPointerMove={(e) => { if (drag) setDrag({ id: drag.id, t: Math.max(0, Math.min(duration, e.altKey ? tAt(e.clientX) : snapBeat(tAt(e.clientX)))) }); }}
        onPointerUp={() => { if (drag) { onMove(drag.id, drag.t); setDrag(null); } }}
        onClick={(e) => { if (!drag && e.target === e.currentTarget) void app.setStudio.previewAt(refPath, tAt(e.clientX)); }}
        onWheel={(e) => { if (zoom > 1) setOffset((o) => Math.max(0, Math.min(duration - span, o + (e.deltaY / 400) * span))); }}>
        <WaveCanvas analysis={wave} from={from} to={to} height={120} />
        <div ref={head} className="ss-cue-playhead" style={{ display: "none" }}><span ref={headLabel} /></div>
        {[...mixIn.map((m) => ({ ...m, k: "in" })), ...mixOut.map((m) => ({ ...m, k: "out" }))].map((m) => m.end > from && m.start < to && <div key={m.k + m.label} className={`ss-region-band ${m.k}`} style={{ left: X(Math.max(from, m.start)), width: `${((Math.min(to, m.end) - Math.max(from, m.start)) / span) * 100}%` }} title={`${m.k === "in" ? "Mix-in" : "Mix-out"}: ${m.label}`}><small>{m.label}</small></div>)}
        {lines.map((l) => <i key={l.t} className={`ss-gridline${l.phrase ? " phrase" : ""}`} style={{ left: X(l.t) }} />)}
        {slots.filter((s) => s.cue && !s.generatedId && s.cue.timestamp >= from && s.cue.timestamp <= to).map((s) => <div key={`h${s.slot}`} className="ss-hotmark" style={{ left: X(s.cue!.timestamp), ["--pc" as string]: s.cue!.colour }} title={`Hot cue ${SLOT(s.slot)}: ${s.cue!.name}${s.manual ? " (yours)" : ""}`}><b>{SLOT(s.slot)}</b></div>)}
        {cues.filter((c) => c.reviewStatus !== "rejected").map((c) => { const t = drag?.id === c.id ? drag.t : c.quantisedPosition; return t >= from && t <= to && (
          <div key={c.id} className={`ss-sugmark ${c.reviewStatus}${c.slot !== null ? " placed" : ""}`} style={{ left: X(t), ["--pc" as string]: c.colour }} title={`${c.label} — ${Math.round(c.confidence * 100)}% (${c.reviewStatus})`}
            onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ id: c.id, t: c.quantisedPosition }); }}>
            <span>{c.slot !== null ? SLOT(c.slot) + " · " : ""}{c.label}</span>
          </div>); })}
      </div>
    </div>
  );
}

/**
 * Production Studio → Drum Transcriber. Audio → onsets → drum classes → editable MIDI drum lanes → .mid.
 *
 * Layout: toolbar (source, mode, analyse, project) · transport (A/B monitor, grid, quantise) · editor (ruler, source
 * waveform, one lane per drum, velocity lane — one horizontal scroll, sticky lane headers) · settings panels · status.
 * Notes are drawn at their quantised position; a thin tick marks the original onset when quantisation moved it.
 * Every edit goes through `DrumTranscriber`, which owns undo/redo and persistence.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TrackInfo } from "../core/engine/types";
import type { DrumTranscriber } from "../production/drums/DrumTranscriber";
import { barLength, beatLength, deriveNotes, gridOrigin, snapTime } from "../production/drums/timing";
import { DRUM_LANES, DRUM_QUANTIZE_OPTIONS, LANE_LABEL, QUANTIZE_GRID_BEATS, type DrumHit, type DrumLane, type DrumQuantize, type DrumTranscription } from "../production/drums/types";
import { midiName } from "../production/midi";
import { sendToArrangement, sourceClipIn, type SendReport } from "../production/drums/toArrangement";
import { useApp } from "./context";
import { TRACK_MIME } from "./productionDnd";

const ROW = 24, HEAD = 156, WAVE_H = 64, VEL_H = 64;
export const LANE_COLOR: Record<DrumLane, string> = {
  kick: "#ff5b6b", snare: "#ffb347", clap: "#ffd84d", "closed-hat": "#5ad8ff", "open-hat": "#3d9bff", "low-tom": "#b48cff", "mid-tom": "#9f7bff",
  "high-tom": "#cfa8ff", crash: "#36d8bd", ride: "#2fbf8f", perc: "#ff8ad8", unknown: "#8a94a6",
};
const GRID_LABEL: Record<DrumTranscription["grid"]["source"], string> = { "library-manual": "LIBRARY GRID (SET BY HAND)", library: "LIBRARY GRID", detected: "DETECTED", loop: "DETECTED (LOOP LENGTH)", manual: "SET BY HAND", default: "NOT DETECTED — 120 BPM" };
const STAGE: Record<string, string> = { preparing: "Preparing", spectrum: "Spectrum", onsets: "Onsets", classifying: "Classifying", tempo: "Tempo" };
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(SELECT|TEXTAREA)$/.test(t.tagName) || (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(t.type)));

type Drag =
  | { kind: "move"; ids: string[]; anchor: DrumHit; x0: number; y0: number; moved: boolean; free: boolean }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: "velocity"; ids: string[] };

/** Peak waveform path for the source, one point per 2 px. */
function wavePath(peaks: Float32Array, rate: number, zoom: number, width: number): string {
  const step = 2; let top = "", bottom = ""; const mid = WAVE_H / 2;
  for (let x = 0; x <= width; x += step) {
    const a = Math.floor(x / zoom * rate), b = Math.max(a + 1, Math.floor((x + step) / zoom * rate)); let m = 0;
    for (let i = a; i < Math.min(b, peaks.length); i++) if (peaks[i] > m) m = peaks[i];
    const h = Math.max(.4, m * (mid - 2)); top += `${x === 0 ? "M" : "L"}${x} ${(mid - h).toFixed(1)}`; bottom = `L${x} ${(mid + h).toFixed(1)}` + bottom;
  }
  return `${top}${bottom}Z`;
}

function Slider({ label, value, min, max, step, onChange, onCommit, format, title }: { label: string; value: number; min: number; max: number; step: number; onChange(v: number): void; onCommit(): void; format?: (v: number) => string; title?: string }) {
  return <label className="dt-slider" title={title}><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} onPointerUp={onCommit} onKeyUp={onCommit} /><b>{format ? format(value) : value}</b></label>;
}

function EmptyState({ drums, onError }: { drums: DrumTranscriber; onError(e: unknown): void }) {
  const app = useApp(); const studio = useSyncExternalStore(app.production.subscribe, app.production.getState, app.production.getState);
  const clips = useMemo(() => { const seen = new Set<string>(); const out: { ref: string; name: string; drums: boolean }[] = []; for (const t of studio.project.tracks) for (const c of t.clips) if (c.type === "audio" && !seen.has(c.ref)) { seen.add(c.ref); out.push({ ref: c.ref, name: c.name, drums: t.stem?.part === "drums" }); } return out.sort((a, b) => Number(b.drums) - Number(a.drums)); }, [studio.project.tracks]);
  const saved = drums.savedProjects();
  return <div className="dt-empty">
    <div className="dt-empty-card">
      <h2>DRUM TRANSCRIBER</h2>
      <p>Turn a drum recording into editable MIDI drums. Import a drum loop, a drum break or a <b>Drums stem</b>, press <b>ANALYSE</b>, then fix any hits and export a standard MIDI file.</p>
      <div className="dt-empty-actions">
        <button className="primary" onClick={() => void drums.importFile().catch(onError)}>⤓ IMPORT AUDIO…</button>
        <span>or drop a WAV / MP3 / FLAC / AIFF file here</span>
      </div>
      {clips.length > 0 && <label className="dt-empty-source">From the Arrangement <select value="" onChange={(e) => { const c = clips.find((x) => x.ref === e.target.value); if (c) void drums.importRef(c.ref, c.name, "arrangement").catch(onError); }}><option value="">Choose a clip…</option>{clips.map((c) => <option key={c.ref} value={c.ref}>{c.drums ? "◆ Drums stem — " : ""}{c.name}</option>)}</select></label>}
      <small>Full songs: separate them first (Arrangement → ✦ SEPARATE INTO TRACKS) and transcribe the Drums stem. Built-in full-song mode arrives in Phase 2.</small>
    </div>
    {saved.length > 0 && <div className="dt-empty-card dt-saved"><h3>SAVED TRANSCRIPTIONS</h3>{saved.slice(0, 12).map((p) => <div key={p.id} className="dt-saved-row"><button onClick={() => void drums.open(p.id).catch(onError)}><b>{p.name}</b><small>{p.hits.length} hits · {p.grid.bpm} BPM · {new Date(p.updatedAt).toLocaleDateString()}</small></button><button className="dt-x" title="Delete this transcription" onClick={() => { if (window.confirm(`Delete “${p.name}”? The audio file is not touched.`)) void drums.deleteSaved(p.id); }}>×</button></div>)}</div>}
  </div>;
}

/** "→ ARRANGEMENT": choose the tempo, then a new Drums track gets one MIDI clip lined up with the source audio. */
function SendDialog({ project, onClose, onSent }: { project: DrumTranscription; onClose(): void; onSent(r: SendReport): void }) {
  const app = useApp(); const studio = app.production; const ps = studio.getState(); const projectBpm = ps.project.bpm; const differs = Math.abs(projectBpm - project.grid.bpm) > .01;
  const source = sourceClipIn(ps.project, project.source.ref); const [error, setError] = useState("");
  const unmapped = project.hits.filter((h) => project.mapping[h.lane] === null).length;
  const send = (matchTempo: boolean) => { try { onSent(sendToArrangement(studio, project, { matchTempo })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  return <div className="dt-dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="dt-dialog" role="dialog" aria-label="Send to Arrangement">
    <h3>SEND TO ARRANGEMENT</h3>
    <p>Creates a new <b>Drums</b> track with one MIDI clip of {project.hits.length - unmapped} notes{project.settings.quantize.grid !== "off" ? ` (quantised ${project.settings.quantize.grid} at ${Math.round(project.settings.quantize.strength * 100)}%)` : ""}.</p>
    <p>{source ? <>Lined up under the source clip on <b>{source.trackName}</b>, so the MIDI plays with the audio it came from.</> : <>Placed with the start of the audio at the arrangement playhead ({ps.position.toFixed(2)} s).</>}</p>
    {unmapped > 0 && <p className="dt-dialog-warn">{unmapped} hit{unmapped === 1 ? " is" : "s are"} on unmapped lanes (Unknown Perc) and will be left out — reclassify them or give the lane a note in DRUM MAP first.</p>}
    <p className="dt-dialog-note">It plays on the Arrangement's built-in drum kit. To use your own sounds, export MIDI to another instrument.</p>
    {error && <p className="dt-dialog-warn">{error}</p>}
    <div className="dt-dialog-buttons">
      {differs ? <><button className="primary" onClick={() => send(true)} title="Changes the arrangement tempo; audio clips keep their timing">Set arrangement to {project.grid.bpm} BPM &amp; send</button>
        <button onClick={() => send(false)} title="Notes still play at the right times but won't sit on the arrangement's bar lines">Keep {projectBpm} BPM &amp; send</button></>
        : <button className="primary" onClick={() => send(false)}>Send ({projectBpm} BPM)</button>}
      <button onClick={onClose}>Cancel</button>
    </div>
    {differs && <small className="dt-dialog-note">The transcription is {project.grid.bpm} BPM and the arrangement is {projectBpm} BPM. Matching the tempo makes the bars line up; other MIDI clips in the arrangement will follow the new tempo.</small>}
  </div></div>;
}

export function DrumTranscriberWorkspace({ onOpenArrangement }: { onOpenArrangement?(clipId: string): void } = {}) {
  const app = useApp(); const drums = app.drums;
  const s = useSyncExternalStore(drums.subscribe, drums.getState, drums.getState); const p = s.project;
  const [zoom, setZoom] = useState(160); const [selected, setSelected] = useState<Set<string>>(new Set()); const [box, setBox] = useState<Extract<Drag, { kind: "box" }> | null>(null);
  const [sendOpen, setSendOpen] = useState(false); const [sent, setSent] = useState<SendReport | null>(null);
  const [follow, setFollow] = useState(true); const [presetName, setPresetName] = useState(""); const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null); const gridRef = useRef<HTMLDivElement>(null); const velRef = useRef<HTMLDivElement>(null); const playheadRef = useRef<HTMLElement>(null); const drag = useRef<Drag | null>(null);
  const fail = useCallback((e: unknown) => drums.reportError(e), [drums]);
  // Saved projects list / presets change outside the state object: refresh on store changes.
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 2000); return () => clearInterval(t); }, []);

  const duration = p ? drums.duration() : 0; const width = Math.max(1, Math.ceil(duration * zoom));
  const derived = useMemo(() => (p ? deriveNotes(p) : { origin: 0, notes: [] }), [p]);
  const noteOf = useMemo(() => new Map(derived.notes.map((n) => [n.hitId, n])), [derived]);
  const wave = drums.waveform(); const waveD = useMemo(() => (wave ? wavePath(wave.peaks, wave.rate, zoom, width) : ""), [wave, zoom, width]);
  const counts = useMemo(() => { const c = Object.fromEntries(DRUM_LANES.map((l) => [l, 0])) as Record<DrumLane, number>; for (const h of p?.hits ?? []) c[h.lane]++; return c; }, [p?.hits]);
  const reviewCount = useMemo(() => (p?.hits ?? []).filter((h) => h.review || h.lane === "unknown").length, [p?.hits]);
  const editedCount = useMemo(() => (p?.hits ?? []).filter((h) => h.edited).length, [p?.hits]);
  const selHits = useMemo(() => (p?.hits ?? []).filter((h) => selected.has(h.id)), [p?.hits, selected]);
  const projectId = p?.id;

  // Fit the zoom to the window when a transcription opens.
  useEffect(() => { if (!projectId) return; setSelected(new Set()); const w = (scrollRef.current?.clientWidth ?? 900) - HEAD - 20; const d = drums.duration(); if (d > 0) setZoom(Math.max(30, Math.min(600, Math.round(w / Math.min(d, 16))))); }, [projectId, drums, s.source]);
  // Drop selections of hits that no longer exist (undo, delete, re-analysis).
  useEffect(() => { if (!p) return; const ids = new Set(p.hits.map((h) => h.id)); setSelected((sel) => { const next = new Set([...sel].filter((id) => ids.has(id))); return next.size === sel.size ? sel : next; }); }, [p]);
  // Playhead: moved by rAF (no React re-render per frame); follows playback when it leaves the view.
  useEffect(() => {
    let raf = 0; const loop = () => { const x = drums.position() * zoom; if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEAD + x}px)`; const sc = scrollRef.current; if (sc && follow && drums.getState().playing && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - HEAD - 40)) sc.scrollLeft = Math.max(0, x - 40); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf);
  }, [drums, zoom, follow]);

  const timeAt = (clientX: number) => { const r = gridRef.current!.getBoundingClientRect(); return Math.max(0, Math.min(duration, (clientX - r.left) / zoom)); };
  const laneAt = (clientY: number) => DRUM_LANES[Math.max(0, Math.min(DRUM_LANES.length - 1, Math.floor((clientY - gridRef.current!.getBoundingClientRect().top) / ROW)))];
  const quantStep = p ? QUANTIZE_GRID_BEATS[p.settings.quantize.grid] : 0;
  const reveal = (h: DrumHit) => { const sc = scrollRef.current; if (!sc) return; const x = (noteOf.get(h.id)?.quantisedTime ?? h.time) * zoom; if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - HEAD - 40) sc.scrollLeft = Math.max(0, x - 120); };

  // Keyboard: Space play/pause, Delete, Ctrl+C/V/A/Z/Y, Escape. Capture phase so the arrangement / DJ keys never also fire.
  const keyState = useRef({ selected, p }); keyState.current = { selected, p };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e.target)) return; const { selected: sel, p: proj } = keyState.current; if (!proj) return;
      const consume = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }; const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
      if (e.code === "Space" && !mod) { consume(); if (!e.repeat) drums.toggle(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { consume(); drums.deleteHits([...sel]); setSelected(new Set()); return; }
      if (mod && k === "c" && sel.size) { consume(); drums.copy([...sel]); return; }
      if (mod && k === "x" && sel.size) { consume(); drums.copy([...sel]); drums.deleteHits([...sel]); setSelected(new Set()); return; }
      if (mod && k === "v") { consume(); const ids = drums.paste(drums.snap(drums.position(), !QUANTIZE_GRID_BEATS[proj.settings.quantize.grid])); setSelected(new Set(ids)); return; }
      if (mod && k === "a") { consume(); setSelected(new Set(proj.hits.map((h) => h.id))); return; }
      if (mod && (k === "y" || (k === "z" && e.shiftKey))) { consume(); drums.redo(); return; }
      if (mod && k === "z") { consume(); drums.undo(); return; }
      if (e.key === "Escape" && sel.size) { consume(); setSelected(new Set()); }
    };
    const up = (e: KeyboardEvent) => { if (!typing(e.target) && e.code === "Space" && keyState.current.p) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };
    window.addEventListener("keydown", key, true); window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", up, true); };
  }, [drums]);
  useEffect(() => () => drums.pause(), [drums]);

  // ── pointer interactions on the grid ──
  const onNoteDown = (e: React.PointerEvent, h: DrumHit) => {
    e.stopPropagation(); if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    let sel = selected; if (e.shiftKey || e.ctrlKey || e.metaKey) { sel = new Set(selected); if (sel.has(h.id)) sel.delete(h.id); else sel.add(h.id); } else if (!selected.has(h.id)) sel = new Set([h.id]);
    setSelected(sel); if (!sel.has(h.id)) return;
    drag.current = { kind: "move", ids: [...sel], anchor: h, x0: e.clientX, y0: e.clientY, moved: false, free: e.altKey };
  };
  const onNoteMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.kind !== "move" || !p) return; const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; d.moved = true;
    const raw = d.anchor.time + dx / zoom; const target = quantStep && !(e.altKey || d.free) ? snapTime(raw, p.grid, quantStep) : raw;
    drums.moveHits(d.ids, target - d.anchor.time, Math.round(dy / ROW), true);
  };
  const onNoteUp = () => { const d = drag.current; drag.current = null; if (d?.kind === "move" && d.moved) drums.endGesture(`Moved ${d.ids.length} hit${d.ids.length === 1 ? "" : "s"}`); };

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect();
    drag.current = { kind: "box", x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, add: e.shiftKey || e.ctrlKey || e.metaKey };
  };
  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => { const d = drag.current; if (d?.kind !== "box") return; const r = e.currentTarget.getBoundingClientRect(); d.x1 = e.clientX - r.left; d.y1 = e.clientY - r.top; if (Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3) setBox({ ...d }); };
  const onGridUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; drag.current = null; setBox(null); if (d?.kind !== "box" || !p) return;
    if (Math.abs(d.x1 - d.x0) <= 3 && Math.abs(d.y1 - d.y0) <= 3) { if (!d.add) setSelected(new Set()); drums.seek(timeAt(e.clientX)); return; }
    const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)], [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
    const hits = p.hits.filter((h) => { const x = (noteOf.get(h.id)?.quantisedTime ?? h.time) * zoom, y = DRUM_LANES.indexOf(h.lane) * ROW; return x + 8 >= x0 && x <= x1 && y + ROW > y0 && y < y1; });
    setSelected((sel) => new Set([...(d.add ? sel : []), ...hits.map((h) => h.id)]));
  };
  const onGridDouble = (e: React.MouseEvent<HTMLDivElement>) => { if (!p || e.target !== e.currentTarget) return; const id = drums.addHit(laneAt(e.clientY), drums.snap(timeAt(e.clientX), e.altKey)); if (id) setSelected(new Set([id])); };

  const onVelDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!p || e.button !== 0) return; const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const near = derived.notes.filter((n) => Math.abs(n.quantisedTime * zoom - x) <= 5).sort((a, b) => Number(selected.has(b.hitId)) - Number(selected.has(a.hitId)))[0]; if (!near) return;
    e.currentTarget.setPointerCapture(e.pointerId); const ids = selected.has(near.hitId) ? [...selected] : [near.hitId]; if (!selected.has(near.hitId)) setSelected(new Set(ids));
    drag.current = { kind: "velocity", ids }; onVelMove(e);
  };
  const onVelMove = (e: React.PointerEvent<HTMLDivElement>) => { const d = drag.current; if (d?.kind !== "velocity") return; const r = velRef.current!.getBoundingClientRect(); drums.setVelocity(d.ids, Math.round((1 - (e.clientY - r.top) / r.height) * 127), true); };
  const onVelUp = () => { const d = drag.current; drag.current = null; if (d?.kind === "velocity") drums.endGesture("Velocity"); };

  const nextReview = () => {
    if (!p) return; const from = selHits.length ? Math.max(...selHits.map((h) => h.time)) + 1e-4 : drums.position();
    const list = p.hits.filter((h) => h.review || h.lane === "unknown"); const next = list.find((h) => h.time > from) ?? list[0]; if (!next) return;
    setSelected(new Set([next.id])); drums.seek(Math.max(0, next.time - .25)); reveal(next);
  };
  const analyse = () => { if (!p) return; if (editedCount && !window.confirm(`Re-analysing replaces all hits, including ${editedCount} you edited. You can undo it. Continue?`)) return; void drums.analyse(); };
  const relink = async () => {
    const file = (await app.platform.pickAudioFiles())[0]; if (!file) return;
    const r = await drums.relink(false, file); if (r === "mismatch" && window.confirm("This file's audio is different from the one that was transcribed — note timings may not line up. Use it anyway?")) await drums.relink(true, file);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); const raw = e.dataTransfer.getData(TRACK_MIME);
    if (raw) { const t = JSON.parse(raw) as TrackInfo; void drums.importRef(t.ref, t.title || t.ref, "file"); return; }
    if (e.dataTransfer.files.length) void (async () => { const refs = await app.platform.refsFromDrop([...e.dataTransfer.files]); if (refs[0]) await drums.importRef(refs[0].ref, refs[0].name, "file"); })().catch(fail);
  };

  if (!p) return <section className="drum-transcriber" aria-label="Drum Transcriber" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
    {s.error && <div className="dt-error" role="alert" onClick={() => drums.clearError()}>⚠ {s.error} ×</div>}
    {s.source === "loading" ? <div className="dt-empty"><div className="dt-empty-card"><span className="ps-spinner"/> {s.message}</div></div> : <EmptyState drums={drums} onError={fail} />}
  </section>;

  const g = p.grid; const bar = barLength(g), beat = beatLength(g); const origin = gridOrigin(g, p.hits);
  const sub = quantStep || .25; const firstBar = Math.ceil(-origin / bar - 1e-9); const bars = Math.max(0, Math.ceil((duration - origin) / bar) - firstBar);
  const gridBg: React.CSSProperties = { width, backgroundImage: `linear-gradient(90deg, #4a5a70 1px, transparent 1px), linear-gradient(90deg, #2a3442 1px, transparent 1px)${sub * beat * zoom >= 6 ? ", linear-gradient(90deg, #1a212b 1px, transparent 1px)" : ""}`, backgroundSize: `${bar * zoom}px 100%, ${beat * zoom}px 100%${sub * beat * zoom >= 6 ? `, ${sub * beat * zoom}px 100%` : ""}`, backgroundPositionX: `${origin * zoom}px` };
  const sameVel = selHits.length && selHits.every((h) => h.velocity === selHits[0].velocity) ? selHits[0].velocity : undefined;
  const analysedWith = p.analysis?.settings; const stale = !!analysedWith && (analysedWith.sensitivity !== p.settings.sensitivity || analysedWith.minConfidence !== p.settings.minConfidence);
  const vs = p.settings.velocity;

  return <section className="drum-transcriber" aria-label="Drum Transcriber" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
    <header className="dt-top">
      <div className="dt-title"><input value={p.name} aria-label="Transcription name" onChange={(e) => drums.rename(e.target.value)} /><small title={p.source.ref}>{p.source.origin === "arrangement" ? "ARRANGEMENT · " : ""}{p.source.name} · {p.source.duration.toFixed(2)} s · {Math.round(p.source.sampleRate / 100) / 10} kHz</small></div>
      <button onClick={() => void drums.importFile().catch(fail)} title="Start a new transcription from an audio file">⤓ IMPORT</button>
      <label className="dt-mode" title="Transcription mode">MODE <select value={p.settings.mode} onChange={(e) => drums.setSettings({ mode: e.target.value as "loop" | "song" })}><option value="loop">Isolated drums (loop / break / stem)</option><option value="song" disabled>Full song — AI drum separation (Phase 2)</option></select></label>
      {s.analysis ? <div className="dt-progress" role="status"><span className="ps-spinner" /><b>{STAGE[s.analysis.stage]}</b><div className="dt-bar"><i style={{ width: `${Math.round(s.analysis.progress * 100)}%` }} /></div><em>{Math.round(s.analysis.progress * 100)}%</em><button onClick={() => drums.cancelAnalysis()}>CANCEL</button></div>
        : <button className={`primary${p.analysis ? "" : " pulse"}`} disabled={s.source !== "ready"} title={s.source !== "ready" ? "The source audio must be loaded to analyse" : "Detect drum hits and classify them (runs in the background)"} onClick={analyse}>✦ {p.analysis ? "RE-ANALYSE" : "ANALYSE"}</button>}
      <span className="dt-spacer" />
      <button disabled={!s.undoAvailable} onClick={() => drums.undo()} title="Undo (Ctrl+Z)">↶</button><button disabled={!s.redoAvailable} onClick={() => drums.redo()} title="Redo (Ctrl+Shift+Z)">↷</button>
      <select className="dt-open" value="" title="Open a saved transcription" onChange={(e) => e.target.value && void drums.open(e.target.value)}><option value="">OPEN…</option>{drums.savedProjects().map((x) => <option key={x.id} value={x.id}>{x.name} · {x.hits.length} hits</option>)}</select>
      <button onClick={() => drums.save()} title={s.saved ? "Saved — edits save automatically" : "Save this transcription (then edits save automatically)"}>{s.saved ? "✓ SAVED" : "SAVE"}</button>
      <button onClick={() => drums.close()} title="Close this transcription (it stays in OPEN…)">NEW</button>
      <button className="dt-export" disabled={!p.hits.length} onClick={() => drums.exportMidi(false)} title="Standard MIDI file (format 1): tempo track + drum track on channel 10">⤒ EXPORT MIDI</button>
      <button disabled={!p.hits.length} onClick={() => drums.exportMidi(true)} title="One MIDI track per drum lane">PER LANE</button>
      <button className="dt-send" disabled={!p.hits.length} onClick={() => { setSent(null); setSendOpen(true); }} title="Put these drums on a new Drums track in the Arrangement">→ ARRANGEMENT</button>
      <button onClick={() => void drums.exportJson()} title="Transcription event list (JSON) for debugging and integrations">JSON</button>
    </header>

    <div className="dt-transport">
      <button className={s.playing ? "active" : ""} onClick={() => drums.toggle()} title="Play / pause (Space)">{s.playing ? "❚❚" : "▶"}</button>
      <button onClick={() => { drums.stop(); drums.seek(0); }} title="Stop">■</button>
      <button className={s.loop ? "active" : ""} onClick={() => drums.setLoop(!s.loop)} title="Loop playback">⟲ LOOP</button>
      <div className="dt-monitor" role="group" aria-label="Monitor">{(["original", "both", "midi"] as const).map((m) => <button key={m} className={s.monitor === m ? "active" : ""} onClick={() => drums.setMonitor(m)} title={m === "both" ? "Original audio and MIDI drums together" : m === "original" ? "Original audio only (A)" : "Reconstructed MIDI drums only (B)"}>{m === "original" ? "A · ORIGINAL" : m === "midi" ? "B · MIDI" : "A+B"}</button>)}<button className="dt-ab" onClick={() => drums.setMonitor(s.monitor === "original" ? "midi" : "original")} title="Flip between original and MIDI while playing">A/B ⇄</button></div>
      <label className="dt-vol" title="Original audio level">AUDIO <input type="range" min="0" max="1.5" step=".01" value={s.originalVolume} onChange={(e) => drums.setVolume("original", +e.target.value)} /></label>
      <label className="dt-vol" title="MIDI preview kit level">MIDI <input type="range" min="0" max="1.5" step=".01" value={s.midiVolume} onChange={(e) => drums.setVolume("midi", +e.target.value)} /></label>
      <span className="dt-sep" />
      <label className="dt-bpm" title="Tempo of the beat grid (edits mark the grid as set by hand)">BPM <input type="number" min="40" max="300" step=".01" value={g.bpm} onChange={(e) => drums.setGrid({ bpm: +e.target.value })} /></label>
      <button onClick={() => drums.setGrid({ bpm: g.bpm / 2 })} title="Halve the tempo">÷2</button><button onClick={() => drums.setGrid({ bpm: g.bpm * 2 })} title="Double the tempo">×2</button>
      <label className="dt-offset" title="Grid offset: a downbeat (bar 1) position in the audio, seconds">OFFSET <input type="number" step=".001" value={g.firstBeat} onChange={(e) => drums.setGrid({ firstBeat: +e.target.value })} /></label>
      <button onClick={() => drums.setDownbeat(drums.position())} title="Make the playhead position a downbeat">⇥ DOWNBEAT HERE</button>
      <span className={`dt-grid-src ${g.source}`} title={`Confidence ${g.confidence.toFixed(2)}`}>{GRID_LABEL[g.source]}</span>
      {(g.source === "manual") && <button onClick={() => drums.resetGrid()} title="Back to the library grid or the detected one">RESET GRID</button>}
      <span className="dt-sep" />
      <label className="dt-quant" title="Quantise (non-destructive: original timing is kept)">QUANTISE <select value={p.settings.quantize.grid} onChange={(e) => drums.setSettings({ quantize: { grid: e.target.value as DrumQuantize } })}>{DRUM_QUANTIZE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
      <Slider label="STRENGTH" value={Math.round(p.settings.quantize.strength * 100)} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => drums.setSettings({ quantize: { strength: v / 100 } }, true)} onCommit={() => drums.endGesture("Quantise strength")} title="0% keeps the played timing; 100% snaps to the grid" />
      <span className="dt-spacer" />
      <div className="dt-zoom"><button onClick={() => setZoom((z) => Math.max(20, Math.round(z / 1.4)))} title="Zoom out">−</button><b>{zoom}px/s</b><button onClick={() => setZoom((z) => Math.min(1200, Math.round(z * 1.4)))} title="Zoom in">+</button></div>
      <label className="dt-follow" title="Scroll with the playhead"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />FOLLOW</label>
    </div>

    {s.error && <div className="dt-error" role="alert" onClick={() => drums.clearError()}>⚠ {s.error} ×</div>}
    {sent && <div className="dt-sent" role="status">✓ Added {sent.notes} notes to a new Drums track{sent.alignedTo ? `, lined up under ${sent.alignedTo}` : ` at ${sent.start.toFixed(2)} s`} ({sent.bpm} BPM){sent.skipped ? ` · ${sent.skipped} unmapped left out` : ""}{sent.outside ? ` · ${sent.outside} outside the clip left out` : ""}. {onOpenArrangement && <button onClick={() => onOpenArrangement(sent.clipId)}>OPEN IN ARRANGEMENT</button>}<button className="dt-x" onClick={() => setSent(null)}>×</button></div>}
    {sendOpen && <SendDialog project={p} onClose={() => setSendOpen(false)} onSent={(r) => { setSendOpen(false); setSent(r); }} />}
    {s.sourceError && <div className={`dt-warning${s.source === "missing" ? " missing" : ""}`}>{s.sourceError} <button onClick={() => void relink().catch(fail)}>RELINK…</button>{s.source === "ready" && <button onClick={analyse}>RE-ANALYSE</button>}</div>}
    {!p.analysis && !s.analysis && <div className="dt-hint">Press <b>✦ ANALYSE</b> to detect hits. You can also draw notes by double-clicking a lane.</div>}

    <div className="dt-scroll" ref={scrollRef}>
      <div className="dt-canvas" style={{ width: HEAD + width }}>
        <div className="dt-row dt-ruler-row">
          <div className="dt-head dt-corner">BAR · {clock(drums.position())}</div>
          <div className="dt-ruler" style={{ width }} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drums.seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom); }}>
            {Array.from({ length: Math.min(bars + 1, 2000) }, (_, i) => { const t = origin + (firstBar + i) * bar; return t <= duration ? <span key={i} style={{ left: t * zoom }}>{firstBar + i + 1}</span> : null; })}
          </div>
        </div>
        <div className="dt-row dt-wave-row">
          <div className="dt-head">AUDIO <small>{s.source === "missing" ? "missing" : s.source === "loading" ? "loading…" : ""}</small></div>
          <div className="dt-wave" style={{ width, ...gridBg }} onPointerDown={(e) => drums.seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom)}>
            {waveD && <svg width={width} height={WAVE_H} viewBox={`0 0 ${width} ${WAVE_H}`} aria-hidden><path d={waveD} /></svg>}
            {p.analysis?.onsets.map((t, i) => <i key={i} className="dt-onset" style={{ left: t * zoom }} />)}
          </div>
        </div>
        <div className="dt-row dt-lanes-row">
          <div className="dt-head dt-lane-heads">{DRUM_LANES.map((lane) => <div key={lane} className={`dt-lane-head${lane === "unknown" ? " unknown" : ""}`} style={{ height: ROW, "--lane": LANE_COLOR[lane] } as React.CSSProperties}>
            <button className="dt-audition" title={`Audition ${LANE_LABEL[lane]}`} onClick={() => void drums.audition(lane)}>▶</button>
            <span title={LANE_LABEL[lane]}>{LANE_LABEL[lane]}</span><small>{p.mapping[lane] === null ? "—" : p.mapping[lane]}</small><em>{counts[lane] || ""}</em>
          </div>)}</div>
          <div className="dt-grid" ref={gridRef} style={{ height: DRUM_LANES.length * ROW, ...gridBg }} onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp} onDoubleClick={onGridDouble}>
            {DRUM_LANES.map((lane, i) => <i key={lane} className={`dt-lane-bg${i % 2 ? " odd" : ""}`} style={{ top: i * ROW, height: ROW }} />)}
            {p.hits.map((h) => {
              const n = noteOf.get(h.id); if (!n) return null; const row = DRUM_LANES.indexOf(h.lane); const x = n.quantisedTime * zoom; const moved = Math.abs(n.quantisedTime - h.time) > .002;
              const tip = `${LANE_LABEL[h.lane]} · ${n.quantisedTime.toFixed(3)} s${moved ? ` (played ${h.time.toFixed(3)} s)` : ""} · velocity ${n.velocity}${h.velocity === null ? "" : " (set by hand)"} · ${h.onset === null ? "added by hand" : `detected ${h.detected ? LANE_LABEL[h.detected] : "?"} ${Math.round(h.confidence * 100)}%`}${h.candidates?.length && h.lane === "unknown" ? ` · guesses: ${h.candidates.map((c) => `${LANE_LABEL[c.lane]} ${Math.round(c.score * 100)}%`).join(", ")}` : ""}${h.review ? ` · ⚑ ${h.review}` : ""}`;
              return <span key={h.id}>{moved && <i className="dt-ghost" style={{ left: h.time * zoom, top: row * ROW + 4, height: ROW - 8 }} />}
                <button className={`dt-note${selected.has(h.id) ? " selected" : ""}${h.review ? " review" : ""}${h.lane === "unknown" ? " unknown" : ""}${h.confidence < .6 ? " low" : ""}`} style={{ left: x, top: row * ROW + 3, height: ROW - 6, "--lane": LANE_COLOR[h.lane], opacity: .45 + n.velocity / 231 } as React.CSSProperties}
                  title={tip} aria-label={tip} onPointerDown={(e) => onNoteDown(e, h)} onPointerMove={onNoteMove} onPointerUp={onNoteUp} onDoubleClick={(e) => { e.stopPropagation(); drums.deleteHits([h.id]); }}>{h.lane === "unknown" ? "?" : ""}</button></span>;
            })}
            {box && <i className="dt-box" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          </div>
        </div>
        <div className="dt-row dt-vel-row">
          <div className="dt-head">VELOCITY <small>drag bars</small></div>
          <div className="dt-vel" ref={velRef} style={{ width, height: VEL_H, ...gridBg }} onPointerDown={onVelDown} onPointerMove={onVelMove} onPointerUp={onVelUp}>
            {derived.notes.map((n) => <i key={n.hitId} className={selected.has(n.hitId) ? "selected" : ""} style={{ left: n.quantisedTime * zoom, height: `${n.velocity / 127 * 100}%`, "--lane": LANE_COLOR[n.lane] } as React.CSSProperties} title={`${LANE_LABEL[n.lane]} velocity ${n.velocity}`} />)}
          </div>
        </div>
        <i className="dt-playhead" ref={playheadRef} aria-hidden />
      </div>
    </div>

    <footer className="dt-panels">
      <section className="dt-panel"><h4>SELECTION <small>{selHits.length ? `${selHits.length} hit${selHits.length === 1 ? "" : "s"}` : "click, Shift+click or drag a box"}</small></h4>
        {selHits.length ? <>
          <label>Lane <select value={selHits.every((h) => h.lane === selHits[0].lane) ? selHits[0].lane : ""} onChange={(e) => e.target.value && drums.reclassify([...selected], e.target.value as DrumLane)}><option value="" disabled>Mixed</option>{DRUM_LANES.map((l) => <option key={l} value={l}>{LANE_LABEL[l]}</option>)}</select></label>
          <label>Velocity <input type="number" min="1" max="127" value={sameVel ?? ""} placeholder={sameVel === null ? "auto" : "mixed"} onChange={(e) => drums.setVelocity([...selected], +e.target.value || 1)} /><button title="Velocity follows the audio again" onClick={() => drums.setVelocity([...selected], null)}>AUTO</button></label>
          <div className="dt-row-buttons"><button onClick={() => drums.acceptHits([...selected])} title="Mark as checked (clears the review flag)">✓ ACCEPT</button><button onClick={() => drums.copy([...selected])}>COPY</button><button onClick={() => { drums.deleteHits([...selected]); setSelected(new Set()); }}>DELETE</button></div>
          {selHits.length === 1 && <small className="dt-detail">{selHits[0].onset === null ? "Added by hand" : `Onset ${selHits[0].onset.toFixed(3)} s · detected ${selHits[0].detected ? LANE_LABEL[selHits[0].detected] : "?"} (${Math.round(selHits[0].confidence * 100)}%)`}{selHits[0].review ? ` · ⚑ ${selHits[0].review}` : ""}</small>}
        </> : <p>Double-click a lane to add a hit · drag to move (Alt: off-grid) · drag up/down to change lane · Delete removes · Ctrl+C/V copies to the playhead · Ctrl+Z undoes.</p>}
        <button className="dt-review" disabled={!reviewCount} onClick={nextReview} title="Select the next Unknown or flagged hit">⚑ NEXT TO REVIEW ({reviewCount})</button>
      </section>
      <section className="dt-panel"><h4>VELOCITY</h4>
        <Slider label="Sensitivity" value={vs.sensitivity} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => drums.setSettings({ velocity: { sensitivity: v } }, true)} onCommit={() => drums.endGesture("Velocity sensitivity")} title="How much velocity follows the measured hit strength" />
        <Slider label="Minimum" value={vs.min} min={1} max={127} step={1} onChange={(v) => drums.setSettings({ velocity: { min: v } }, true)} onCommit={() => drums.endGesture("Velocity minimum")} />
        <Slider label="Maximum" value={vs.max} min={1} max={127} step={1} onChange={(v) => drums.setSettings({ velocity: { max: v } }, true)} onCommit={() => drums.endGesture("Velocity maximum")} />
        <Slider label="Compression" value={vs.compression} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => drums.setSettings({ velocity: { compression: v } }, true)} onCommit={() => drums.endGesture("Velocity compression")} title="Lifts quiet hits towards the maximum" />
        <label className="dt-fixed"><input type="checkbox" checked={vs.fixed !== null} onChange={(e) => drums.setSettings({ velocity: { fixed: e.target.checked ? 100 : null } })} />Fixed {vs.fixed !== null && <input type="number" min="1" max="127" value={vs.fixed} onChange={(e) => drums.setSettings({ velocity: { fixed: Math.max(1, Math.min(127, +e.target.value || 1)) } })} />}</label>
        <small className="dt-note-text">Strength is measured from the audio and normalised per instrument — it is an estimate, not the drummer's real velocity.</small>
      </section>
      <section className="dt-panel"><h4>DETECTION {stale && <em className="dt-stale">RE-ANALYSE TO APPLY</em>}</h4>
        <Slider label="Sensitivity" value={p.settings.sensitivity} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => drums.setSettings({ sensitivity: v }, true)} onCommit={() => drums.endGesture("Detection sensitivity")} title="Higher finds quieter hits (and more false ones)" />
        <Slider label="Min confidence" value={p.settings.minConfidence} min={0} max={.95} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => drums.setSettings({ minConfidence: v }, true)} onCommit={() => drums.endGesture("Minimum confidence")} title="Labels less certain than this go to Unknown Perc for you to check" />
        <small className="dt-note-text">Phase 1 recognises kick, snare, clap, closed/open hi-hat and (tentatively) crash. Toms, ride and other percussion are entered by hand. A hi-hat struck exactly with a snare is usually masked.</small>
        {p.analysis && <small className="dt-detail">{p.analysis.onsets.length} onsets · {p.analysis.classifier} · {(p.analysis.elapsedMs / 1000).toFixed(1)} s · analysed at {(p.analysis.analysisRate / 1000).toFixed(2)} kHz</small>}
      </section>
      <section className="dt-panel dt-map"><h4>DRUM MAP <small>MIDI note per lane · channel 10</small></h4>
        <div className="dt-map-grid">{DRUM_LANES.map((lane) => <label key={lane} style={{ "--lane": LANE_COLOR[lane] } as React.CSSProperties} title={p.mapping[lane] === null ? "Not exported" : midiName(p.mapping[lane]!)}><i />{LANE_LABEL[lane]}<input type="number" min="0" max="127" placeholder="off" value={p.mapping[lane] ?? ""} onChange={(e) => drums.setMapping(lane, e.target.value === "" ? null : Math.max(0, Math.min(127, Math.round(+e.target.value))))} /></label>)}</div>
        <div className="dt-row-buttons">
          <select value={p.mappingPresetId ?? ""} onChange={(e) => (e.target.value === "gm" ? drums.resetMapping() : e.target.value && drums.applyPreset(e.target.value))}><option value="">Preset…</option><option value="gm">General MIDI</option>{drums.presets().map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <input value={presetName} placeholder="Preset name" onChange={(e) => setPresetName(e.target.value)} /><button disabled={!presetName.trim()} onClick={() => { drums.savePreset(presetName); setPresetName(""); }}>SAVE MAP</button>
          {p.mappingPresetId && <button title="Delete this preset" onClick={() => void drums.deletePreset(p.mappingPresetId!)}>×</button>}
        </div>
      </section>
    </footer>
    <div className="dt-status" role="status">{s.message} · {p.hits.length} hits{counts.unknown ? ` · ${counts.unknown} unknown` : ""} · {clock(drums.position())} / {clock(duration)} · grid {g.bpm} BPM · Space play · Del delete · Ctrl+C/V/Z</div>
  </section>;
}

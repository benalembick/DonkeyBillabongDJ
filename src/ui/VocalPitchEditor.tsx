/**
 * Vocal Studio — PITCH tab (Phase 2): key/scale, presets, correction controls, ORIGINAL | TUNED A/B, live tuned
 * monitoring, and the graphical pitch editor (detected notes as blobs, targets, cents, pitch curves).
 * Every edit is non-destructive: it changes settings / note data; the tuned audio is a cached render.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { midiName } from "../production/midi";
import { correctionCurve, correctedPitch, noteTarget, PITCH_PRESETS, type PitchPresetId } from "../production/vocal/pitchCorrect";
import type { PitchTrack, VocalNote } from "../production/vocal/pitchTrack";
import { KEY_NAMES, nearestInScale, SCALE_LABELS, type ScaleName } from "../production/vocal/scales";
import type { AudioClip, ProductionTrack, VocalTake } from "../production/types";
import { useApp } from "./context";
import { useTick } from "./hooks";

const ROW = 20, HEAD = 46;
/** RETUNE SPEED slider: 0 = Natural (400 ms) … 1 = Hard Tune (0 ms). */
const retuneFromSlider = (x: number) => Math.round(400 * (1 - x) ** 2);
const sliderFromRetune = (ms: number) => 1 - Math.sqrt(Math.min(400, ms) / 400);
const cents = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : "±"}${Math.abs(Math.round(c))}¢`;

function Knob({ label, value, min, max, step, format, onChange, title }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange(v: number): void; title?: string }) {
  return <label className="vp-knob" title={title}><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)}/><output>{format(value)}</output></label>;
}

export function VocalPitchEditor({ track }: { track: ProductionTrack }) {
  const app = useApp(); const pitch = app.pitch; const vocal = app.vocal; const studio = app.production;
  const pst = useSyncExternalStore(pitch.subscribe, pitch.getState, pitch.getState); const vs = useSyncExternalStore(vocal.subscribe, vocal.getState, vocal.getState); const ps = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState);
  useTick(80);
  const takes = track.vocal?.takes ?? []; const [takeId, setTakeId] = useState<string | null>(null);
  const take: VocalTake | undefined = takes.find((t) => t.id === takeId) ?? takes.find((t) => t.id === track.vocal?.activeTakeId) ?? takes[takes.length - 1];
  const s = pitch.settings(track); const mask = useMemo(() => pitch.mask(s), [pitch, s]);
  const [f0, setF0] = useState<PitchTrack | null>(null); const [px, setPx] = useState(200); const [selected, setSelected] = useState<string[]>([]); const [drag, setDrag] = useState<{ id: string; pitch: number } | null>(null); const [band, setBand] = useState<{ a: number; b: number } | null>(null); const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setF0(null); if (take?.pitch) void pitch.pitchTrackOf(take).then(setF0).catch(() => undefined); }, [pitch, take?.ref, take?.pitch?.analysedAt]);
  // Keep live tuned monitoring in step with the key and correction settings.
  useEffect(() => { if (vs.tunedMonitor) vocal.setTunedMonitor({ enabled: true, mask, retuneMs: s.retuneMs, strength: s.strength }); }, [vs.tunedMonitor, mask, s.retuneMs, s.strength, vocal]);
  const run = (work: () => unknown) => { try { const r = work(); if (r instanceof Promise) r.catch((x) => setError(x instanceof Error ? x.message : String(x))); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } };
  const set = (patch: Parameters<typeof pitch.updateSettings>[1], undoable = true) => pitch.updateSettings(track.id, patch, "Pitch correction updated", undoable);

  const notes = useMemo(() => take?.pitch?.notes ?? [], [take?.pitch?.notes]); const analysing = take ? pst.analysing[take.id] : undefined;
  const from = take?.offset ?? 0, to = (take?.offset ?? 0) + (take?.duration ?? 1); const width = Math.max(600, (to - from) * px);
  const pitches = notes.flatMap((n) => [n.detected, noteTarget(n, mask) ?? n.detected]); const lo = Math.floor(Math.min(...pitches, 60)) - 3, hi = Math.max(Math.ceil(Math.max(...pitches, 60)) + 3, lo + 14);
  const y = (m: number) => (hi - m) * ROW + ROW / 2; const xOf = (t: number) => (t - from) * px; const height = (hi - lo + 1) * ROW;
  const curves = useMemo(() => {
    if (!f0) return { detected: "", corrected: "" };
    const c = s.enabled ? correctionCurve(f0, notes, mask, s) : new Float32Array(f0.f0.length); const out = correctedPitch(f0, c);
    const path = (arr: Float32Array) => { let d = ""; let pen = false; const a = Math.max(0, Math.floor(from / f0.hop)), b = Math.min(arr.length, Math.ceil(to / f0.hop)); for (let i = a; i < b; i++) { if (!arr[i]) { pen = false; continue; } d += `${pen ? "L" : "M"}${(xOf(i * f0.hop)).toFixed(1)} ${y(arr[i]).toFixed(1)}`; pen = true; } return d; };
    return { detected: path(f0.f0), corrected: s.enabled ? path(out) : "" };
  }, [f0, notes, mask, s, px, lo, hi, from, to]);
  if (!take) return <div className="vp-empty">Record a take in the RECORD tab first — every take is analysed for pitch automatically.</div>;
  const clip = track.clips.find((c): c is AudioClip => c.type === "audio" && c.takeId === take.id); const filePos = clip ? ps.position - clip.start + clip.offset : -1;
  const fit = pitch.fit(track, take); const sel = notes.filter((n) => selected.includes(n.id));
  const editSelected = (fn: (n: VocalNote) => void, message: string) => pitch.updateNotes(track.id, take.id, (list) => { for (const n of list) if (selected.includes(n.id)) fn(n); }, message);

  const pointerTime = (clientX: number) => { const el = scrollRef.current!; return from + (clientX - el.getBoundingClientRect().left + el.scrollLeft - HEAD) / px; };
  const startNoteDrag = (note: VocalNote) => (e: React.PointerEvent) => {
    e.stopPropagation(); if (e.button !== 0) return; if (e.shiftKey) { setSelected((x) => (x.includes(note.id) ? x.filter((i) => i !== note.id) : [...x, note.id])); return; }
    if (!selected.includes(note.id)) setSelected([note.id]); const target = e.currentTarget as HTMLElement; target.setPointerCapture(e.pointerId); const y0 = e.clientY; const base = noteTarget(note, mask) ?? note.detected; let current = base;
    const move = (ev: PointerEvent) => { const raw = base - (ev.clientY - y0) / ROW; current = ev.altKey ? Math.round(raw * 100) / 100 : nearestInScale(raw, mask); setDrag({ id: note.id, pitch: current }); };
    const up = () => { target.removeEventListener("pointermove", move); setDrag(null); if (Math.abs(current - base) > 1e-3) pitch.updateNotes(track.id, take.id, (list) => { const n = list.find((x) => x.id === note.id); if (n) { n.target = current; n.bypass = false; } }, `Note → ${midiName(Math.round(current))}${Number.isInteger(current) ? "" : ` ${cents((current - Math.round(current)) * 100)}`}`); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up, { once: true });
  };
  const startBand = (e: React.PointerEvent) => {
    if (e.button !== 0) return; const target = e.currentTarget as HTMLElement; target.setPointerCapture(e.pointerId); const a = pointerTime(e.clientX); setBand({ a, b: a });
    const move = (ev: PointerEvent) => setBand({ a, b: pointerTime(ev.clientX) });
    const up = (ev: PointerEvent) => { target.removeEventListener("pointermove", move); const b = pointerTime(ev.clientX); setBand(null); const [l, r] = [Math.min(a, b), Math.max(a, b)]; setSelected(r - l < .01 ? [] : notes.filter((n) => n.end > l && n.start < r).map((n) => n.id)); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up, { once: true });
  };

  return <div className="vocal-pitch">
    {error && <button className="sampler-error" onClick={() => setError("")}>⚠ {error} · dismiss</button>}
    <div className="vp-controls">
      <div className="vp-ab" role="group" aria-label="A/B"><button className={track.vocal?.listen === "original" ? "active" : ""} aria-pressed={track.vocal?.listen === "original"} onClick={() => pitch.setListen(track.id, "original")}>ORIGINAL</button><button className={track.vocal?.listen !== "original" ? "active" : ""} aria-pressed={track.vocal?.listen !== "original"} onClick={() => pitch.setListen(track.id, "processed")}>ENHANCED</button></div>
      <label className="vp-check" title="Pitch correction on/off (the cleanup chain in ENHANCE is separate)"><input type="checkbox" checked={s.enabled} disabled={!notes.length} onChange={(e) => set({ enabled: e.target.checked }, false)}/> PITCH CORRECTION</label>
      <button className="vp-play" onClick={() => (ps.playing ? studio.pause() : run(() => vocal.playTake(track.id, take.start)))}>{ps.playing ? "■ STOP" : "▶ PLAY"}</button>
      <label>TAKE <select value={take.id} onChange={(e) => setTakeId(e.target.value)}>{takes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === track.vocal?.activeTakeId ? " ★" : ""}</option>)}</select></label>
      <label>KEY <select value={s.key} onChange={(e) => set({ key: +e.target.value })}>{KEY_NAMES.map((k, i) => <option key={k} value={i}>{k}</option>)}</select></label>
      <label>SCALE <select value={s.scale} onChange={(e) => set({ scale: e.target.value as ScaleName })}>{(Object.keys(SCALE_LABELS) as ScaleName[]).map((sc) => <option key={sc} value={sc}>{SCALE_LABELS[sc]}</option>)}</select></label>
      {s.scale === "custom" && <div className="vp-custom" role="group" aria-label="Custom scale notes">{s.custom.map((on, i) => <button key={i} className={on ? "on" : ""} aria-pressed={on} onClick={() => set({ custom: s.custom.map((x, j) => (j === i ? !x : x)) })}>{KEY_NAMES[(s.key + i) % 12]}</button>)}</div>}
      <button onClick={() => run(() => pitch.detectSongKey())} title="Key of the song from the vocal notes, MIDI parts and audio backing">DETECT SONG KEY</button>
      {pst.detectedKey && <span className="vp-detected">{KEY_NAMES[pst.detectedKey.root]} {pst.detectedKey.scale} <small>{Math.round(pst.detectedKey.confidence * 100)}%</small> <button onClick={() => set({ key: pst.detectedKey!.root, scale: pst.detectedKey!.scale })}>USE</button></span>}
      {ps.project.key ? <button onClick={() => set({ key: ps.project.key!.root, scale: ps.project.key!.scale })} title="Use the project's key">USE PROJECT KEY ({KEY_NAMES[ps.project.key.root]} {SCALE_LABELS[ps.project.key.scale]})</button> : null}
      <button onClick={() => pitch.setProjectKey(s.key, s.scale)} title="Save this key as the project key">SET AS PROJECT KEY</button>
      {take.pitch && <span className={`vp-fit${fit < .8 ? " low" : ""}`} title="Share of sung note time already in this key">{Math.round(fit * 100)}% in key</span>}
    </div>
    <div className="vp-controls vp-dsp">
      <div className="vp-presets" role="group" aria-label="Presets">{(Object.keys(PITCH_PRESETS) as PitchPresetId[]).map((id) => <button key={id} className={s.preset === id ? "active" : ""} title={PITCH_PRESETS[id].hint} onClick={() => pitch.applyPreset(track.id, id)}>{PITCH_PRESETS[id].label}</button>)}</div>
      <Knob label="RETUNE SPEED" title="Natural (slow, keeps movement) ←→ Hard Tune (instant)" value={sliderFromRetune(s.retuneMs)} min={0} max={1} step={.01} format={() => (s.retuneMs === 0 ? "HARD" : `${s.retuneMs} ms`)} onChange={(v) => set({ retuneMs: retuneFromSlider(v) })}/>
      <Knob label="STRENGTH" value={s.strength} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ strength: v })}/>
      <Knob label="HUMANIZE" title="Leaves short passing notes more natural" value={s.humanize} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ humanize: v })}/>
      <Knob label="TRANSITION" title="Glide kept between connected notes" value={s.transitionMs} min={0} max={250} step={5} format={(v) => `${v} ms`} onChange={(v) => set({ transitionMs: v })}/>
      <Knob label="DRIFT CORRECT" title="Straightens notes that sag or creep" value={s.drift} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ drift: v })}/>
      <Knob label="PRESERVE EXPRESSION" title="Keeps vibrato and scoops" value={s.preserve} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ preserve: v })}/>
      <label className="vp-check" title="TD-PSOLA keeps the voice's formants (character) when retuning"><input type="checkbox" checked={s.formant} onChange={(e) => set({ formant: e.target.checked })}/> FORMANT PRESERVE</label>
      <button className="primary vp-auto" disabled={!notes.length} onClick={() => pitch.autoCorrectAll(track.id, take.id)}>✦ AUTO CORRECT ALL</button>
      <label className="vp-check" title={`Hear your voice tuned to the key while recording (+${Math.round(vocal.tunedMonitorLatencyMs || 21)} ms). The recording stays dry.`}><input type="checkbox" checked={vs.tunedMonitor} disabled={!vs.input.open} onChange={(e) => vocal.setTunedMonitor({ enabled: e.target.checked, mask, retuneMs: s.retuneMs, strength: s.strength })}/> TUNED MONITOR</label>
    </div>
    <div className="vp-controls vp-selection">
      <b>{sel.length ? `${sel.length} note${sel.length === 1 ? "" : "s"} selected` : notes.length ? "Click a note, shift-click to add, drag across empty space to select a section" : ""}</b>
      {sel.length > 0 && <>
        <button onClick={() => editSelected((n) => { n.target = n.target ?? nearestInScale(n.detected, mask); n.target = nearestInScale(n.target, mask); n.bypass = false; }, "Snapped to scale")}>SNAP TO SCALE</button>
        <button onClick={() => editSelected((n) => { n.target = (noteTarget(n, mask) ?? n.detected) + .1; n.bypass = false; }, "+10 cents")}>+10¢</button>
        <button onClick={() => editSelected((n) => { n.target = (noteTarget(n, mask) ?? n.detected) - .1; n.bypass = false; }, "−10 cents")}>−10¢</button>
        <button className={sel.every((n) => n.bypass) ? "active" : ""} onClick={() => { const all = sel.every((n) => n.bypass); editSelected((n) => { n.bypass = !all; }, all ? "Correction restored" : "Correction bypassed"); }}>BYPASS</button>
        <button onClick={() => editSelected((n) => { n.target = null; n.bypass = false; n.transitionMs = null; }, "Notes reset")}>RESET</button>
        <button disabled={sel.length < 2} onClick={() => { pitch.joinNotes(track.id, take.id, selected); setSelected([]); }}>JOIN</button>
        <label>TRANSITION <input type="number" min={0} max={300} step={5} value={sel[0].transitionMs ?? s.transitionMs} onChange={(e) => editSelected((n) => { n.transitionMs = Math.max(0, +e.target.value); }, "Transition set")}/> ms</label>
        <button className="primary" onClick={() => { editSelected((n) => { n.target = nearestInScale(n.detected, mask); n.bypass = false; }, "Section corrected"); if (!s.enabled) set({ enabled: true }, false); }}>CORRECT SECTION</button>
      </>}
      <span className="vp-grow"/>
      {pst.renderingRef && <span className="vp-busy">Rendering…</span>}
      <label>ZOOM <input type="range" min={40} max={400} value={px} onChange={(e) => setPx(+e.target.value)}/></label>
    </div>
    <div className="vp-editor" ref={scrollRef}>
      {!take.pitch ? <div className="vp-empty">{analysing !== undefined ? `Analysing pitch… ${Math.round(analysing * 100)}%` : <button className="primary" onClick={() => void pitch.analyseTake(take.id)}>ANALYSE PITCH</button>}</div> :
        <div className="vp-canvas" style={{ width: width + HEAD, height }}>
          <div className="vp-keys" style={{ height }}>{Array.from({ length: hi - lo + 1 }, (_, i) => { const m = hi - i; const pc = ((m % 12) + 12) % 12; return <div key={m} className={`${mask[pc] ? "in" : "out"}${pc === s.key % 12 ? " root" : ""}${[1, 3, 6, 8, 10].includes(pc) ? " black" : ""}`} style={{ top: i * ROW, height: ROW }}>{midiName(m)}</div>; })}</div>
          <svg className="vp-grid" width={width} height={height} style={{ left: HEAD }} onPointerDown={startBand} onDoubleClick={(e) => { const t = pointerTime(e.clientX); const n = notes.find((x) => t > x.start && t < x.end); if (n) pitch.splitNote(track.id, take.id, n.id, t); }}>
            {Array.from({ length: hi - lo + 1 }, (_, i) => { const m = hi - i; const pc = ((m % 12) + 12) % 12; return <rect key={m} x={0} y={i * ROW} width={width} height={ROW} className={`${mask[pc] ? "in" : "out"}${pc === s.key % 12 ? " root" : ""}`}/>; })}
            {Array.from({ length: Math.ceil(to - from) + 1 }, (_, i) => <line key={i} x1={xOf(from + i)} x2={xOf(from + i)} y1={0} y2={height} className="sec"/>)}
            {band && <rect className="vp-band" x={Math.min(xOf(band.a), xOf(band.b))} y={0} width={Math.abs(xOf(band.b) - xOf(band.a))} height={height}/>}
            <path d={curves.detected} className="vp-curve detected"/>
            {curves.corrected && <path d={curves.corrected} className="vp-curve corrected"/>}
            {notes.map((n) => { const target = drag?.id === n.id ? drag.pitch : noteTarget(n, mask); const x = xOf(n.start), w = Math.max(3, (n.end - n.start) * px); const isSel = selected.includes(n.id); const dev = target === null ? 0 : (n.detected - target) * 100;
              return <g key={n.id} className={`vp-note${isSel ? " selected" : ""}${n.bypass ? " bypass" : ""}${n.target !== null ? " manual" : ""}`} onPointerDown={startNoteDrag(n)}>
                <rect className="detected" x={x} y={y(n.detected) - ROW / 2 + 1} width={w} height={ROW - 2} rx={4}/>
                {target !== null && <rect className="target" x={x} y={y(target) - ROW / 2 + 2} width={w} height={ROW - 4} rx={4}/>}
                <text x={x + 3} y={(target !== null ? y(target) : y(n.detected)) - ROW / 2 - 2} className="label">{n.bypass ? "BYPASS" : `${midiName(Math.round(target ?? n.detected))} ${cents(dev)}`}{n.vibrato ? " ∿" : ""}</text>
                <title>{`Detected ${midiName(Math.round(n.detected))} ${cents((n.detected - Math.round(n.detected)) * 100)} · target ${target === null ? "bypassed" : midiName(Math.round(target))} · ${Math.round((n.end - n.start) * 1000)} ms · drift ${n.driftCents}¢/s${n.vibrato ? ` · vibrato ${n.vibrato.rateHz} Hz ±${n.vibrato.depthCents}¢` : ""}\nDrag: move to a scale note (Alt = free) · double-click: split · shift-click: select`}</title>
              </g>; })}
            {filePos >= from && filePos <= to && <line x1={xOf(filePos)} x2={xOf(filePos)} y1={0} y2={height} className="vp-playhead"/>}
          </svg>
        </div>}
    </div>
    <footer className="vs-status-bar">{pst.message || "Notes show detected pitch (outline) and target (solid); the grey line is what was sung, the coloured line what you'll hear."} · {notes.length} notes · original take untouched</footer>
  </div>;
}

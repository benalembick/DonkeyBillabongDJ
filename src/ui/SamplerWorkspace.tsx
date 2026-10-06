import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { midiName } from "../production/midi";
import { sliceRegions, transientMarkers } from "../production/slicing";
import { PAD_BANKS, PADS_PER_BANK, QUANTIZE_BEATS, padLabel, type ChokeGroup, type QuantizeGrid, type SamplerPad, type SamplerPattern, type SamplerSample, type SliceMode } from "../production/types";
import { useApp } from "./context";

const modes = [["one-shot", "One Shot"], ["gate", "Gate"], ["toggle", "Toggle"], ["loop", "Loop"]] as const;
const sliceModes: [SliceMode, string, string][] = [["transient", "TRANSIENT", "Slice at detected attacks"], ["beat", "BEAT", "Slice on the beat grid"], ["equal", "EQUAL", "Equal-length slices"], ["manual", "MANUAL", "Place your own markers"]];
const beatDivisions = [[.25, "1/4 beat"], [.5, "1/2 beat"], [1, "1 beat"], [4, "1 bar"], [8, "2 bars"]] as const;
const equalCounts = [2, 4, 8, 16, 32];
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
const fileTitle = (name: string) => name.replace(/\.[^.]+$/, "");
const quantizeGrids: [QuantizeGrid, string][] = [["off", "OFF"], ["1/4", "1/4"], ["1/8", "1/8"], ["1/16", "1/16"], ["1/32", "1/32"], ["triplet", "TRIPLET"]];
const noteOptions = Array.from({ length: 128 }, (_, n) => n);
/** Computer keyboard: a 4×4 pad grid (Z X C V = pads 1–4 … 1 2 3 4 = pads 13–16) for SLICES … */
const PAD_KEYS: Record<string, number> = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3, KeyA: 4, KeyS: 5, KeyD: 6, KeyF: 7, KeyQ: 8, KeyW: 9, KeyE: 10, KeyR: 11, Digit1: 12, Digit2: 13, Digit3: 14, Digit4: 15 };
/** … and a piano row (A = C, W = C#, … K = next C) for CHROMATIC, with Z / X shifting the octave. */
const PIANO_KEYS: Record<string, number> = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const keyName = (code: string) => code.replace(/^Key|^Digit/, "").replace("Semicolon", ";");

/** Pattern thumbnail: played timing faint, quantized timing solid. */
function PatternPreview({ pattern, quantized }: { pattern: SamplerPattern; quantized: { start: number; pitch: number; duration: number }[] }) {
  const beats = pattern.bars * 4; const pitches = [...new Set(pattern.notes.map((n) => n.pitch))].sort((a, b) => b - a); const row = (pitch: number) => pitches.indexOf(pitch) / Math.max(1, pitches.length) * 100;
  const h = 100 / Math.max(1, pitches.length);
  return <svg className="sampler-pattern-preview" viewBox="0 0 400 100" preserveAspectRatio="none" aria-label={`Pattern: ${pattern.notes.length} notes over ${pattern.bars} bars`}>
    {Array.from({ length: beats + 1 }, (_, b) => <line key={b} x1={b / beats * 400} x2={b / beats * 400} y1={0} y2={100} className={b % 4 ? "beat" : "bar"}/>)}
    {pattern.notes.map((n) => <rect key={`r${n.id}`} className="raw" x={n.start / beats * 400} y={row(n.pitch)} width={Math.max(2, Math.min(n.duration, .5) / beats * 400)} height={h}/>)}
    {quantized.map((n, i) => <rect key={i} className="q" x={n.start / beats * 400} y={row(n.pitch) + h * .2} width={Math.max(2, Math.min(n.duration, .5) / beats * 400)} height={h * .6}/>)}
  </svg>;
}

/** Two-octave keyboard for CHROMATIC mode (mouse / touch). */
function ChromaticKeys({ from, root, playing, onDown, onUp }: { from: number; root: number; playing: number[]; onDown(note: number): void; onUp(note: number): void }) {
  const notes = Array.from({ length: 25 }, (_, i) => from + i).filter((n) => n <= 127); const whites = notes.filter((n) => ![1, 3, 6, 8, 10].includes(n % 12));
  return <div className="sampler-keys" role="group" aria-label="Chromatic keyboard">{notes.map((note) => { const black = [1, 3, 6, 8, 10].includes(note % 12); const whiteIndex = whites.filter((w) => w < note).length; return <button key={note} className={`${black ? "black" : "white"}${note === root ? " root" : ""}${playing.includes(note) ? " playing" : ""}`} style={black ? { left: `calc(${whiteIndex / whites.length * 100}% - 1.6%)` } : undefined} aria-label={midiName(note)} title={`${midiName(note)}${note === root ? " (root)" : ` (${note > root ? "+" : ""}${note - root} st)`}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onDown(note); }} onPointerUp={() => onUp(note)} onPointerCancel={() => onUp(note)}>{!black && note % 12 === 0 ? midiName(note) : ""}</button>; })}</div>;
}

/** Filter cutoff slider: 0–1 ↔ 40 Hz–20 kHz on a log scale. */
const cutoffFrom = (x: number) => Math.round(40 * 500 ** x);
const cutoffTo = (hz: number) => Math.log(hz / 40) / Math.log(500);

function waveformPath(peaks: number[]): string {
  const max = Math.max(.001, ...peaks);
  return peaks.map((peak, index) => { const x = index / Math.max(1, peaks.length - 1) * 1000; const height = Math.max(1, peak / max * 92); return `M${x.toFixed(2)} ${(100 - height).toFixed(2)}V${(100 + height).toFixed(2)}`; }).join("");
}

/** Pad thumbnail of the sample's start–end region of its source overview. */
function MiniWave({ sample }: { sample: SamplerSample }) {
  const from = Math.floor(sample.start / sample.sourceDuration * sample.peaks.length), to = Math.max(from + 1, Math.floor(sample.end / sample.sourceDuration * sample.peaks.length));
  const region = sample.peaks.slice(from, to); const max = Math.max(.001, ...region); const bars = 36;
  const points = Array.from({ length: bars }, (_, i) => { let m = 0; for (let j = Math.floor(i * region.length / bars); j < Math.max(Math.floor(i * region.length / bars) + 1, Math.floor((i + 1) * region.length / bars)); j++) m = Math.max(m, region[j] ?? 0); return m / max; });
  if (sample.edits.reverse) points.reverse();
  return <svg className="sampler-mini-wave" viewBox="0 0 36 18" preserveAspectRatio="none" aria-hidden="true">{points.map((peak, index) => <line key={index} x1={index + .5} x2={index + .5} y1={9 - peak * 8} y2={9 + peak * 8}/>)}</svg>;
}

/** BPM for beat slicing: library analysis, else a "120 BPM" style hint in the name. */
function suggestedBpm(libraryBpm: number | null | undefined, name: string): number | null {
  if (libraryBpm) return Math.round(libraryBpm * 100) / 100;
  const match = /(\d{2,3}(?:\.\d+)?)\s*-?\s*bpm/i.exec(name); return match ? Number(match[1]) : null;
}

function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange(v: number): void }) {
  return <label className="sampler-param"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)}/><output>{format(value)}</output></label>;
}

function PadInspector({ pad, onError }: { pad: SamplerPad; onError(reason: unknown): void }) {
  const { production: studio } = useApp(); const sample = pad.sample; const p = pad.params; const label = padLabel(pad.index);
  const set = (patch: Partial<SamplerPad["params"]>) => studio.updatePadParams(pad.index, patch);
  const preview = (action: "down" | "up") => void studio.triggerSamplerPad(pad.index, action, true).catch(onError);
  if (!sample) return <div className="sampler-pad-inspector"><h3>PAD {label}</h3><label className="sampler-name">MIDI NOTE <select value={pad.midiNote} onChange={(e) => studio.setPadNote(pad.index, +e.target.value)}>{noteOptions.map((n) => <option key={n} value={n}>{midiName(n)} · {n}</option>)}</select></label><p>Empty pad. Assign the editor sample from the SAMPLE tab, or use MAP SLICES TO PADS.</p></div>;
  return <div className="sampler-pad-inspector">
    <h3>PAD {label}</h3>
    <label className="sampler-name">NAME <input value={sample.name} onChange={(e) => studio.updatePadSample(pad.index, { name: e.target.value })}/></label>
    <div className="sampler-pad-actions">
      <button className="primary" onPointerDown={() => preview("down")} onPointerUp={() => preview("up")} onPointerLeave={(e) => { if (e.buttons) preview("up"); }}>▶ PREVIEW</button>
      <button className={p.muted ? "active warn" : ""} aria-pressed={p.muted} onClick={() => set({ muted: !p.muted })}>MUTE</button>
      <button className={p.solo ? "active" : ""} aria-pressed={p.solo} onClick={() => set({ solo: !p.solo })}>SOLO</button>
      <button className={sample.edits.reverse ? "active" : ""} aria-pressed={sample.edits.reverse} onClick={() => studio.updatePadSample(pad.index, { edits: { ...sample.edits, reverse: !sample.edits.reverse } })}>⇆ REV</button>
    </div>
    <div className="sampler-pad-row">
      <label>MODE <select value={sample.playbackMode} onChange={(e) => studio.updatePadSample(pad.index, { playbackMode: e.target.value as SamplerSample["playbackMode"] })}>{modes.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <label title="Triggering a pad stops the other pads in the same choke group">CHOKE <select value={p.choke} onChange={(e) => set({ choke: +e.target.value as ChokeGroup })}><option value={0}>None</option>{[1, 2, 3, 4].map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
    </div>
    <label className="sampler-name" title="Incoming MIDI note for this pad. A pad already on that note swaps to this pad's old note.">MIDI NOTE <select value={pad.midiNote} onChange={(e) => studio.setPadNote(pad.index, +e.target.value)}>{noteOptions.map((n) => <option key={n} value={n}>{midiName(n)} · {n}</option>)}</select></label>
    <div className="sampler-pad-row">
      <label>START <input type="number" min="0" step=".001" value={sample.start.toFixed(3)} onChange={(e) => studio.updatePadSample(pad.index, { start: +e.target.value })}/></label>
      <label>END <input type="number" min="0" step=".001" value={sample.end.toFixed(3)} onChange={(e) => studio.updatePadSample(pad.index, { end: +e.target.value })}/></label>
    </div>
    <Slider label="GAIN" value={sample.gain} min={0} max={2} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.updatePadSample(pad.index, { gain: v })}/>
    <Slider label="PAN" value={p.pan} min={-1} max={1} step={.01} format={(v) => v === 0 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`} onChange={(v) => set({ pan: v })}/>
    <Slider label="PITCH" value={p.pitch} min={-24} max={24} step={1} format={(v) => `${v > 0 ? "+" : ""}${v} st`} onChange={(v) => set({ pitch: v })}/>
    <h4>ENVELOPE</h4>
    <Slider label="ATTACK" value={p.attack} min={0} max={2} step={.001} format={(v) => `${Math.round(v * 1000)} ms`} onChange={(v) => set({ attack: v })}/>
    <Slider label="DECAY" value={p.decay} min={0} max={2} step={.001} format={(v) => `${Math.round(v * 1000)} ms`} onChange={(v) => set({ decay: v })}/>
    <Slider label="SUSTAIN" value={p.sustain} min={0} max={1} step={.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ sustain: v })}/>
    <Slider label="RELEASE" value={p.release} min={0} max={3} step={.001} format={(v) => `${Math.round(v * 1000)} ms`} onChange={(v) => set({ release: v })}/>
    <h4>FILTER</h4>
    <Slider label="CUTOFF" value={cutoffTo(p.cutoff)} min={0} max={1} step={.001} format={(v) => { const hz = cutoffFrom(v); return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`; }} onChange={(v) => set({ cutoff: cutoffFrom(v) })}/>
    <Slider label="RESO" value={p.resonance} min={.1} max={15} step={.1} format={(v) => v.toFixed(1)} onChange={(v) => set({ resonance: v })}/>
    <button onClick={() => { studio.stopPad(pad.index); studio.clearSamplerPad(pad.index); }}>CLEAR PAD</button>
  </div>;
}

export function SamplerWorkspace({ onOpenPianoRoll }: { onOpenPianoRoll?(clipId: string): void } = {}) {
  const app = useApp(); const studio = app.production; const state = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState); const sampler = state.project.sampler; const sample = sampler.editor; const slicing = sampler.slicing; const [zoom, setZoom] = useState(90); const [query, setQuery] = useState(""); const [error, setError] = useState(""); const [tab, setTab] = useState<"sample" | "pad">("sample"); const scrollRef = useRef<HTMLDivElement>(null);
  const library = useMemo(() => app.library.getState().tracks.filter((track) => track.source === "local" && `${track.title} ${track.artist}`.toLowerCase().includes(query.toLowerCase())), [app.library, state.project.updatedAt, query]);
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const action = (work: Promise<unknown>) => void work.catch(fail);
  const loadFile = async () => { const [ref] = await app.platform.pickAudioFiles(); if (!ref) return; await app.addFiles([ref]); await studio.loadSamplerSource({ ref: ref.ref, title: fileTitle(ref.name) }); };
  const loadDropped = async (files: FileList) => { const [ref] = await app.platform.refsFromDrop([...files]); if (!ref) return; await app.addFiles([ref]); await studio.loadSamplerSource({ ref: ref.ref, title: fileTitle(ref.name) }); };
  const width = sample ? Math.max(900, sample.sourceDuration * zoom) : 900; const playback = state.samplerPlayback; const cursor = sample && playback?.sampleId === sample.id ? playback.regionStart + playback.position : sample?.start ?? 0;
  const pct = (seconds: number) => `${seconds / (sample?.sourceDuration || 1) * 100}%`;
  const timeAt = (clientX: number) => { const el = scrollRef.current!; const rect = el.getBoundingClientRect(); return Math.max(0, Math.min(sample!.sourceDuration, (clientX - rect.left + el.scrollLeft) / width * sample!.sourceDuration)); };
  const drag = (onMove: (seconds: number) => void, onUp?: (seconds: number) => void) => (event: React.PointerEvent<HTMLElement>) => {
    if (!sample || !scrollRef.current || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); const target = event.currentTarget; target.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => onMove(timeAt(pointer.clientX));
    const up = (pointer: PointerEvent) => { target.removeEventListener("pointermove", move); onUp?.(timeAt(pointer.clientX)); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up, { once: true });
  };
  const marker = (kind: "start" | "end") => drag((seconds) => studio.updateSamplerEditor(kind === "start" ? { start: Math.min(seconds, sample!.end - .001) } : { end: Math.max(seconds, sample!.start + .001) }));
  const slicingOn = !!sample && slicing.enabled; const sliceSource = slicingOn && slicing.sourceRef === sample.sourceRef;
  const regions = useMemo(() => sample ? sliceRegions(sample.start, sample.end, slicing.markers) : [], [sample, slicing.markers]);
  const activeTransients = useMemo(() => new Set(sample && sliceSource ? transientMarkers(slicing.detected, slicing.sensitivity, sample.start, sample.end) : []), [sample, sliceSource, slicing.detected, slicing.sensitivity]);
  const bpmHint = sample ? suggestedBpm(app.library.getByRef(sample.sourceRef)?.bpm, `${sample.name} ${sample.sourceRef}`) : null;
  const firstPad = sampler.bank * PADS_PER_BANK; const mappable = Math.min(regions.length, sampler.pads.length - firstPad);
  const bankPads = sampler.pads.slice(firstPad, firstPad + PADS_PER_BANK); const selectedPad = sampler.pads[sampler.selectedPad];
  const setMode = (mode: SliceMode) => studio.setSliceSettings(mode === "beat" && slicing.bpm === null && bpmHint ? { mode, bpm: bpmHint } : { mode });
  const chromatic = sampler.mode === "chromatic"; const [octave, setOctave] = useState(0); const [countIn, setCountIn] = useState(true); const [click, setClick] = useState(true);
  const keysFrom = Math.max(0, Math.min(103, 12 * Math.floor(sampler.chromatic.rootNote / 12) + 12 * octave));
  const quantized = useMemo(() => studio.quantizedPattern(), [studio, sampler.pattern, sampler.quantize]);
  const recording = state.patternRecording; const pattern = sampler.pattern;
  const patternAction = (fn: () => string) => { try { return fn(); } catch (reason) { fail(reason); return null; } };
  // Computer keyboard plays the Sampler while it is open (captured before DJ shortcuts); keys already down keep their note.
  const held = useRef(new Map<string, number>()); const live = useRef({ chromatic, bank: sampler.bank, keysFrom }); live.current = { chromatic, bank: sampler.bank, keysFrom };
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) && !(target instanceof HTMLInputElement && ["range", "checkbox", "radio", "button"].includes(target.type));
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return; const { chromatic: isChromatic, bank, keysFrom: from } = live.current;
      if (isChromatic && (e.code === "KeyZ" || e.code === "KeyX")) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) setOctave((o) => Math.max(-4, Math.min(4, o + (e.code === "KeyZ" ? -1 : 1)))); return; }
      const offset = isChromatic ? PIANO_KEYS[e.code] : PAD_KEYS[e.code]; if (offset === undefined) return;
      e.preventDefault(); e.stopPropagation(); if (e.repeat || held.current.has(e.code)) return;
      const note = isChromatic ? from + offset : studio.padNote(bank * PADS_PER_BANK + offset); held.current.set(e.code, note); studio.samplerNoteOn(note, 127);
    };
    const up = (e: KeyboardEvent) => { const note = held.current.get(e.code); if (note === undefined) return; e.preventDefault(); e.stopPropagation(); held.current.delete(e.code); studio.samplerNoteOff(note); };
    const blur = () => { for (const note of held.current.values()) studio.samplerNoteOff(note); held.current.clear(); };
    window.addEventListener("keydown", down, true); window.addEventListener("keyup", up, true); window.addEventListener("blur", blur);
    return () => { blur(); window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", blur); };
  }, [studio]);

  return <section className="sampler-workspace" aria-label="Production Studio Sampler">
    {error && <button className="sampler-error" onClick={() => setError("")}>⚠ {error} · dismiss</button>}
    <aside className="sampler-browser"><h2>SAMPLER SOURCES</h2><button className="primary" onClick={() => action(loadFile())}>＋ BROWSE AUDIO FILE</button><div className="sampler-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); action(loadDropped(event.dataTransfer.files)); }}><b>DROP AUDIO HERE</b><span>MP3, WAV, AIFF, FLAC and supported audio</span></div><input aria-label="Search local library" placeholder="Search local library…" value={query} onChange={(event) => setQuery(event.target.value)}/><h3>LOCAL DJ LIBRARY</h3><div className="sampler-library">{library.map((track) => <button key={track.ref} onClick={() => action(studio.loadSamplerSource(track))}><b>{track.title}</b><span>{track.artist || "Unknown artist"}</span><small>{track.durationMs ? time(track.durationMs / 1000) : "Audio"}</small></button>)}</div></aside>
    <div className="sampler-main">
      <header className="sampler-transport"><button className={state.samplerRecording ? "recording" : ""} aria-pressed={state.samplerRecording} title={state.samplerRecording ? "Stop and load the microphone recording" : "Record a new sample from the microphone"} onClick={() => action(studio.toggleSamplerRecording())}>{state.samplerRecording ? "■ STOP RECORDING" : "● RECORD MIC"}</button><button disabled={!sample || state.samplerRecording} onClick={() => action(playback?.paused ? studio.resumeSampler() : studio.playSampler(false, false))}>{playback?.paused ? "▶ RESUME" : "▶ PLAY"}</button><button disabled={!playback?.playing} onClick={() => studio.pauseSampler()}>❚❚ PAUSE</button><button disabled={!playback && !state.padsPlaying.length} onClick={() => { studio.stopSampler(); studio.stopAllPads(); }}>■ STOP</button><button disabled={!sample || state.samplerRecording} onClick={() => action(studio.playSampler(true, false))}>▶ PLAY SELECTION</button><button className={sample?.playbackMode === "loop" ? "active" : ""} disabled={!sample || state.samplerRecording} onClick={() => action(studio.playSampler(true, true))}>↻ LOOP SELECTION</button><button className={`sampler-slice-toggle${slicing.enabled ? " active" : ""}`} aria-pressed={slicing.enabled} disabled={!sample} title="Slice the sample at transients, beats, equal parts or your own markers, then map the slices to pads" onClick={() => studio.setSliceSettings({ enabled: !slicing.enabled })}>✂ SLICE</button><span/><label>ZOOM <input type="range" min="30" max="500" value={zoom} onChange={(event) => setZoom(+event.target.value)}/></label><output>{zoom}px/s</output></header>
      <div className="sampler-wave-scroll" ref={scrollRef}>{sample ? <div className={`sampler-wave${slicingOn ? " slicing" : ""}`} style={{ width }} onDoubleClick={(event) => { const at = timeAt(event.clientX); if (slicingOn) studio.addSliceMarker(at); else studio.updateSamplerEditor({ start: Math.min(at, sample.end - .001) }); }}>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-label={`Waveform for ${sample.name}`}><path d={waveformPath(sample.peaks)}/></svg>
        <div className="sampler-selection" style={{ left: pct(sample.start), width: pct(sample.end - sample.start) }}/>
        {slicingOn && regions.map((region) => <button key={region.index} className={`sampler-slice-region${region.index % 2 ? " odd" : ""}`} style={{ left: pct(region.start), width: pct(region.end - region.start) }} title={`Slice ${region.index + 1} · ${((region.end - region.start) * 1000).toFixed(0)} ms — click to preview`} onClick={() => action(studio.previewSlice(region.index))} onDoubleClick={(e) => { e.stopPropagation(); studio.addSliceMarker(timeAt(e.clientX)); }}><span>{region.index + 1}</span></button>)}
        {sliceSource && slicing.detected.map((t) => <i key={t.time} className={`sampler-transient${activeTransients.has(t.time) ? " active" : ""}`} style={{ left: pct(t.time), height: `${Math.round(20 + t.strength * 60)}%` }} title={`Transient ${t.time.toFixed(3)} s · strength ${Math.round(t.strength * 100)}%`}/>)}
        {slicingOn && slicing.markers.map((m, i) => <button key={i} className="sampler-slice-marker" style={{ left: pct(m) }} aria-label={`Slice marker ${i + 1} at ${m.toFixed(3)} seconds — drag to move, right-click or Delete to remove`} title="Drag to move · right-click or Delete to remove" onPointerDown={drag((t) => studio.moveSliceMarker(i, t), (t) => studio.moveSliceMarker(i, t, true))} onContextMenu={(e) => { e.preventDefault(); studio.deleteSliceMarker(i); }} onKeyDown={(e) => { if (e.key === "Delete" || e.key === "Backspace") studio.deleteSliceMarker(i); }} onDoubleClick={(e) => e.stopPropagation()}/>)}
        <i className="sampler-cursor" style={{ left: pct(cursor) }}/>
        <button className="sampler-marker start" style={{ left: pct(sample.start) }} onPointerDown={marker("start")} aria-label="Drag sample start">START</button><button className="sampler-marker end" style={{ left: pct(sample.end) }} onPointerDown={marker("end")} aria-label="Drag sample end">END</button>
        <div className="sampler-ruler">{Array.from({ length: Math.ceil(sample.sourceDuration) + 1 }, (_, second) => <i key={second} style={{ left: pct(second) }}>{second}s</i>)}</div>
      </div> : <div className="sampler-empty"><b>LOAD A SOUND TO START SAMPLING</b><span>Browse, drop a file, or select a track from the local library.</span></div>}</div>
      <div className="sampler-controls">
        <div className="sampler-edit-controls"><label>START <input disabled={!sample} type="number" min="0" step=".001" value={sample?.start.toFixed(3) ?? "0.000"} onChange={(event) => studio.updateSamplerEditor({ start: +event.target.value })}/></label><label>END <input disabled={!sample} type="number" min="0" step=".001" value={sample?.end.toFixed(3) ?? "0.000"} onChange={(event) => studio.updateSamplerEditor({ end: +event.target.value })}/></label><button disabled={!sample} onClick={() => studio.cropSamplerToSelection()}>✂ TRIM / CROP</button><button className={sample?.edits.fadeIn ? "active" : ""} disabled={!sample} onClick={() => studio.setSamplerEdit({ fadeIn: sample?.edits.fadeIn ? 0 : Math.min(.1, (sample!.end - sample!.start) / 4) })}>FADE IN</button><button className={sample?.edits.fadeOut ? "active" : ""} disabled={!sample} onClick={() => studio.setSamplerEdit({ fadeOut: sample?.edits.fadeOut ? 0 : Math.min(.1, (sample!.end - sample!.start) / 4) })}>FADE OUT</button><button className={sample?.edits.reverse ? "active" : ""} disabled={!sample} onClick={() => studio.setSamplerEdit({ reverse: !sample?.edits.reverse })}>⇆ REVERSE</button><button className={sample?.edits.normalize ? "active" : ""} disabled={!sample} onClick={() => studio.setSamplerEdit({ normalize: !sample?.edits.normalize })}>NORMALIZE</button><button disabled={!sample} title="Trim silence, snap edges to zero crossings, add tiny anti-click fades and measure peak / RMS / clipping. Level is not changed." onClick={() => { setTab("sample"); action(studio.autoCleanEditor()); }}>✧ AUTO CLEAN</button><label>GAIN <input disabled={!sample} type="range" min="0" max="2" step=".01" value={sample?.gain ?? 1} onChange={(event) => studio.updateSamplerEditor({ gain: +event.target.value })}/><output>{((sample?.gain ?? 1) * 100).toFixed(0)}%</output></label><button disabled={!state.undoAvailable} onClick={() => studio.undo()}>↶ UNDO</button><button disabled={!state.redoAvailable} onClick={() => studio.redo()}>↷ REDO</button></div>
        {slicingOn && <div className="sampler-slice-bar">
          <div className="sampler-slice-modes" role="radiogroup" aria-label="Slice mode">{sliceModes.map(([mode, label, hint]) => <button key={mode} role="radio" aria-checked={slicing.mode === mode} className={slicing.mode === mode ? "active" : ""} title={hint} onClick={() => setMode(mode)}>{label}</button>)}</div>
          {slicing.mode === "transient" && <><label>SENSITIVITY <input type="range" min="0" max="1" step=".01" value={slicing.sensitivity} onChange={(e) => studio.setSliceSettings({ sensitivity: +e.target.value })}/><output>{Math.round(slicing.sensitivity * 100)}%</output></label><button onClick={() => action(studio.analyseSlices())}>⟳ DETECT</button></>}
          {slicing.mode === "beat" && <><label>SLICE <select value={slicing.beats} onChange={(e) => studio.setSliceSettings({ beats: +e.target.value })}>{beatDivisions.map(([beats, text]) => <option key={beats} value={beats}>{text}</option>)}</select></label><label title={bpmHint ? `Detected ${bpmHint} BPM` : "Defaults to the project BPM"}>BPM <input type="number" min="20" max="300" step=".01" placeholder={String(bpmHint ?? state.project.bpm)} value={slicing.bpm ?? ""} onChange={(e) => studio.setSliceSettings({ bpm: e.target.value ? +e.target.value : null })}/></label></>}
          {slicing.mode === "equal" && <label>SLICES <select value={slicing.equal} onChange={(e) => studio.setSliceSettings({ equal: +e.target.value })}>{equalCounts.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
          <button onClick={() => studio.resetSliceMarkers()} title={slicing.mode === "manual" ? "Remove all manual markers" : "Back to the generated markers"}>RESET</button>
          <button disabled={!slicing.markers.length} onClick={() => studio.clearSliceMarkers()}>CLEAR</button>
          <label className="sampler-check" title="Zero-crossing edges, trimmed silence and 2–3 ms anti-click fades on every mapped slice"><input type="checkbox" checked={slicing.autoClean} onChange={(e) => studio.setSliceSettings({ autoClean: e.target.checked })}/> AUTO CLEAN SLICES</label>
          <span/>
          <button className="primary sampler-map" disabled={!mappable} onClick={() => action(studio.mapSlicesToPads().then(() => setTab("pad")))}>MAP {regions.length} SLICE{regions.length === 1 ? "" : "S"} TO PADS {padLabel(firstPad)}{mappable > 1 ? `–${padLabel(firstPad + mappable - 1)}` : ""}</button>
        </div>}
        <div className="sampler-pattern-bar" aria-label="Pattern">
          <button className={`sampler-record${recording ? " recording" : ""}`} aria-pressed={!!recording} title="Record pad, keyboard and MIDI performance as a pattern" onClick={() => action(studio.togglePatternRecording({ countIn, click }))}>{recording ? "■ STOP" : "● RECORD PATTERN"}</button>
          <label className="sampler-check" title="One bar of clicks before recording starts"><input type="checkbox" checked={countIn} disabled={!!recording} onChange={(e) => setCountIn(e.target.checked)}/> COUNT-IN</label>
          <label className="sampler-check" title="Metronome while recording"><input type="checkbox" checked={click} disabled={!!recording} onChange={(e) => setClick(e.target.checked)}/> CLICK</label>
          <output className={`sampler-rec-status${recording ? " live" : ""}`}>{recording ? recording.phase === "count-in" ? `COUNT-IN ${recording.beat + 5}` : `BAR ${Math.floor(recording.beat / 4) + 1}.${recording.beat % 4 + 1}` : pattern ? `${pattern.notes.length} notes · ${pattern.bars} bar${pattern.bars === 1 ? "" : "s"} · ${pattern.mode.toUpperCase()}` : `${state.project.bpm} BPM · no pattern yet`}</output>
          <label>QUANTIZE <select value={sampler.quantize.grid} onChange={(e) => studio.setQuantize({ grid: e.target.value as QuantizeGrid })}>{quantizeGrids.map(([grid, text]) => <option key={grid} value={grid}>{text}</option>)}</select></label>
          <label title="100% snaps notes to the grid; lower values keep part of the played timing">STRENGTH <input type="range" min="0" max="1" step=".01" disabled={sampler.quantize.grid === "off"} value={sampler.quantize.strength} onChange={(e) => studio.setQuantize({ strength: +e.target.value })}/><output>{Math.round(sampler.quantize.strength * 100)}%</output></label>
          {pattern && <PatternPreview pattern={pattern} quantized={QUANTIZE_BEATS[sampler.quantize.grid] ? quantized : []}/>}
          <span/>
          <button disabled={!pattern || !!recording} onClick={() => state.patternPlaying ? studio.stopPattern() : action(studio.playPattern())}>{state.patternPlaying ? "■ STOP" : "▶ PLAY PATTERN"}</button>
          <button className="primary" disabled={!pattern || !!recording} title="Create a MIDI clip from the quantized pattern and edit it in the Piano Roll" onClick={() => { const id = patternAction(() => studio.patternToArrangement()); if (id) onOpenPianoRoll?.(id); }}>OPEN IN PIANO ROLL</button>
          <button disabled={!pattern || !!recording} title="Add the quantized pattern at the arrangement playhead on a Sampler track (or drag it from the arrangement browser)" onClick={() => patternAction(() => studio.patternToArrangement())}>SEND TO ARRANGEMENT</button>
          <button disabled={!pattern || !!recording} onClick={() => studio.clearPattern()}>CLEAR</button>
        </div>
        {slicingOn && <div className="sampler-slice-list" aria-label="Slices">{regions.map((region) => <button key={region.index} onClick={() => action(studio.previewSlice(region.index))} title="Preview slice"><b>{region.index + 1}</b><span>{region.start.toFixed(3)}s</span><small>{((region.end - region.start) * 1000).toFixed(0)} ms</small></button>)}<em>Double-click the waveform to add a marker · drag markers to move · right-click to delete</em></div>}
      </div>
      <div className="sampler-lower">
        <div className="sampler-pad-area">
          <div className="sampler-banks" role="tablist" aria-label="Pad banks">{PAD_BANKS.map((name, bank) => { const used = sampler.pads.slice(bank * PADS_PER_BANK, (bank + 1) * PADS_PER_BANK).filter((pad) => pad.sample).length; return <button key={name} role="tab" aria-selected={sampler.bank === bank} className={`${sampler.bank === bank ? "active" : ""}${used ? " used" : ""}`} onClick={() => studio.setSamplerBank(bank)}>BANK {name}<small>{used}/16</small></button>; })}</div>
          <div className={`sampler-mode-bar${chromatic ? " chromatic" : ""}`}>
            <div className="sampler-mode-switch" role="radiogroup" aria-label="Sampler mode"><button role="radio" aria-checked={!chromatic} className={!chromatic ? "active" : ""} title="Each pad plays its own sample on its own MIDI note" onClick={() => studio.setSamplerMode("slices")}>SLICES</button><button role="radio" aria-checked={chromatic} className={chromatic ? "active" : ""} title="One sample across the keyboard; the root note plays at normal pitch" onClick={() => sampler.chromatic.sample ? studio.setSamplerMode("chromatic") : action(studio.setChromaticSample(sample ? "editor" : sampler.selectedPad))}>CHROMATIC</button></div>
            {!chromatic ? <><label title="MIDI note of pad A1; the other pads follow chromatically (replaces manual remaps)">BASE NOTE <select value={sampler.baseNote} onChange={(e) => studio.setBaseNote(+e.target.value)}>{noteOptions.filter((n) => n <= 64).map((n) => <option key={n} value={n}>{midiName(n)} · {n}</option>)}</select></label><small>Keys: Z X C V · A S D F · Q W E R · 1 2 3 4 · MIDI keyboards and drum pads play the pads</small></>
              : <><b className="sampler-chromatic-name" title={sampler.chromatic.sample?.name}>{sampler.chromatic.sample?.name ?? "No sample"}</b><span className="sampler-root">Detected Root: <b>{sampler.chromatic.detectedRoot === null ? "not detected" : midiName(sampler.chromatic.detectedRoot)}</b></span><label title="This note plays the sample at its original pitch">ROOT <select value={sampler.chromatic.rootNote} onChange={(e) => studio.setChromaticRoot(+e.target.value)}>{noteOptions.map((n) => <option key={n} value={n}>{midiName(n)}{n === sampler.chromatic.detectedRoot ? " (detected)" : ""}</option>)}</select></label><button disabled={!sample} onClick={() => action(studio.setChromaticSample("editor"))}>USE EDITOR SAMPLE</button><button disabled={!selectedPad?.sample} onClick={() => action(studio.setChromaticSample(sampler.selectedPad))}>USE PAD {padLabel(sampler.selectedPad)}</button><small>Keys: A–; play, W E T Y U O P sharps · Z / X octave ({octave >= 0 ? "+" : ""}{octave})</small></>}
          </div>
          {chromatic && <ChromaticKeys from={keysFrom} root={sampler.chromatic.rootNote} playing={state.notesPlaying} onDown={(note) => studio.samplerNoteOn(note, 127)} onUp={(note) => studio.samplerNoteOff(note)}/>}
          <div className="sampler-pads" role="group" aria-label={`Bank ${PAD_BANKS[sampler.bank]} pads`}>{bankPads.map((pad) => { const note = studio.padNote(pad.index); const active = chromatic ? state.notesPlaying.includes(note) : state.padsPlaying.includes(pad.index); const p = pad.params; const key = Object.keys(PAD_KEYS).find((code) => PAD_KEYS[code] === pad.index % PADS_PER_BANK); return <button key={pad.index} className={`${pad.sample || chromatic ? "loaded" : "empty"}${chromatic ? " chromatic" : ""}${active ? " playing" : ""}${sampler.selectedPad === pad.index ? " selected" : ""}${p.muted && !chromatic ? " muted" : ""}`} aria-label={`Pad ${padLabel(pad.index)}, ${pad.sample ? `${pad.sample.name}, loaded` : "empty"}${active ? ", playing" : ""}`} aria-pressed={active} onPointerDown={() => { studio.selectSamplerPad(pad.index); if (pad.sample || chromatic) { if (pad.sample) setTab("pad"); studio.padDown(pad.index); } }} onPointerUp={() => (pad.sample || chromatic) && studio.padUp(pad.index)} onPointerLeave={(e) => e.buttons > 0 && (pad.sample || chromatic) && studio.padUp(pad.index)}><span className="pad-number">{padLabel(pad.index)}</span>{pad.sample && !chromatic ? <><b>{pad.sample.name}</b><MiniWave sample={pad.sample}/><span className="pad-state">{active ? "▶ PLAYING" : "● LOADED"}{p.muted && <em className="pad-badge">M</em>}{p.solo && <em className="pad-badge solo">S</em>}{p.choke > 0 && <em className="pad-badge">C{p.choke}</em>}{p.pitch !== 0 && <em className="pad-badge">{p.pitch > 0 ? "+" : ""}{p.pitch}</em>}</span><small><em className="pad-note">{midiName(note)}</em> {note} · {chromatic ? "CHROMATIC" : pad.sample.playbackMode.toUpperCase()} · key {keyName(key ?? "")}</small></> : <><b>{chromatic ? `${midiName(note)} (${note - sampler.chromatic.rootNote >= 0 ? "+" : ""}${note - sampler.chromatic.rootNote})` : "EMPTY PAD"}</b><span className="pad-state">{chromatic ? "♪ CHROMATIC" : "＋ UNLOADED"}</span><small><em className="pad-note">{midiName(note)}</em> {note} · key {keyName(key ?? "")}</small></>}</button>; })}</div>
        </div>
        <aside className="sampler-info">
          <div className="sampler-info-tabs" role="tablist"><button role="tab" aria-selected={tab === "sample"} className={tab === "sample" ? "active" : ""} onClick={() => setTab("sample")}>SAMPLE</button><button role="tab" aria-selected={tab === "pad"} className={tab === "pad" ? "active" : ""} onClick={() => setTab("pad")}>PAD {padLabel(sampler.selectedPad)}</button></div>
          {tab === "pad" ? (selectedPad && <PadInspector pad={selectedPad} onError={fail}/>) : sample ? <><h2>SAMPLE INFORMATION</h2><label>NAME <input value={sample.name} onChange={(event) => studio.updateSamplerEditor({ name: event.target.value })}/></label><dl><dt>Source</dt><dd title={sample.sourceRef}>{sample.sourceRef.split(/[\\/]/).pop()}</dd><dt>Duration</dt><dd>{time(sample.sourceDuration)}</dd><dt>Selection</dt><dd>{time(sample.end - sample.start)}</dd><dt>Created</dt><dd>{new Date(sample.createdAt).toLocaleString()}</dd>{slicingOn && <><dt>Slices</dt><dd>{regions.length}{sliceSource ? ` · ${slicing.detected.length} transients` : ""}</dd></>}</dl>
            {state.cleanReport && <dl className="sampler-clean-report" aria-label="Auto Clean analysis"><dt>Peak</dt><dd>{state.cleanReport.peakDb.toFixed(1)} dBFS</dd><dt>RMS</dt><dd>{state.cleanReport.rmsDb.toFixed(1)} dBFS</dd><dt>Clipping</dt><dd className={state.cleanReport.clippedSamples ? "warn" : ""}>{state.cleanReport.clippedSamples ? `${state.cleanReport.clippedSamples} samples at full scale` : "None"}</dd><dt>Trimmed</dt><dd>{(state.cleanReport.leadingSilence * 1000).toFixed(0)} ms start · {(state.cleanReport.trailingSilence * 1000).toFixed(0)} ms end</dd></dl>}
            <fieldset><legend>PLAYBACK MODE</legend>{modes.map(([value, label]) => <label key={value}><input type="radio" name="sample-mode" value={value} checked={sample.playbackMode === value} onChange={() => studio.updateSamplerEditor({ playbackMode: value })}/>{label}</label>)}</fieldset><label>ASSIGN TO PAD <select value={sampler.selectedPad} onChange={(event) => studio.selectSamplerPad(+event.target.value)}>{sampler.pads.map((pad) => <option key={pad.index} value={pad.index}>Pad {padLabel(pad.index)}{pad.sample ? ` · ${pad.sample.name}` : " · Empty"}</option>)}</select></label><button className="primary" onClick={() => studio.assignSamplerToPad()}>ASSIGN SAMPLE TO PAD {padLabel(sampler.selectedPad)}</button><button onClick={() => studio.saveSamplerSample()}>SAVE SAMPLE</button><button title="Place this sample at the arrangement playhead on the Samples track" onClick={() => action(Promise.resolve().then(() => studio.addSampleToArrangement(sample)))}>＋ ADD TO ARRANGEMENT</button><small>{sampler.savedSamples.length} saved sample{sampler.savedSamples.length === 1 ? "" : "s"} in this project</small></> : <p>Load a source to inspect and edit its sample settings.</p>}
        </aside>
      </div>
    </div>
  </section>;
}

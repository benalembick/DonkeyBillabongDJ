/**
 * Vocal Studio — Phase 1: input, metering, monitoring, latency, recording (count-in, metronome, backing, punch),
 * takes with waveforms and level analysis. Processing (pitch, cleanup, timing, FX) arrives in later phases on top
 * of these untouched takes (docs/VOCAL-STUDIO.md).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { WAVEFORM_RATE } from "../production/ProductionStudio";
import type { ProductionTrack, VocalTake } from "../production/types";
import { useApp } from "./context";
import { trackKind } from "./TrackIcons";
import { VocalPitchEditor } from "./VocalPitchEditor";
import { VocalEnhancePanel } from "./VocalEnhancePanel";

const dbOf = (v: number) => 20 * Math.log10(Math.max(1e-6, v));
const meterPct = (v: number) => `${Math.max(0, Math.min(100, (dbOf(v) + 60) / 60 * 100))}%`;
const trimDb = (gain: number) => Math.round(dbOf(gain) * 10) / 10;
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

/** Take waveform lane: detailed peaks of the take's recorded range, positioned on the timeline. */
function TakeWave({ take, px, total }: { take: VocalTake; px: number; total: number }) {
  const { production } = useApp(); const data = production.waveform(take.ref);
  const d = useMemo(() => {
    if (!data) return ""; const width = Math.max(1, Math.round(take.duration * px)); let top = "", bottom = "";
    for (let x = 0; x < width; x++) { const a = Math.floor((take.offset + x / px) * WAVEFORM_RATE), b = Math.max(a + 1, Math.floor((take.offset + (x + 1) / px) * WAVEFORM_RATE)); let m = 0; for (let i = a; i < b && i < data.length; i++) m = Math.max(m, data[i]); const h = Math.max(.5, m * 46); top += `${x ? "L" : "M"}${x} ${(50 - h).toFixed(1)}`; bottom = `L${x + 1} ${(50 + h).toFixed(1)}` + bottom; }
    return `${top}L${width} 50${bottom}Z`;
  }, [data, take.offset, take.duration, px]);
  return <div className="vs-take-wave" style={{ left: take.start * px, width: Math.max(2, take.duration * px), maxWidth: total * px }}>{d ? <svg viewBox={`0 0 ${Math.max(1, Math.round(take.duration * px))} 100`} preserveAspectRatio="none"><path d={d}/></svg> : <span>Loading…</span>}</div>;
}

export function VocalStudioWorkspace() {
  const app = useApp(); const vocal = app.vocal; const studio = app.production;
  const v = useSyncExternalStore(vocal.subscribe, vocal.getState, vocal.getState); const ps = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState);
  const [px, setPx] = useState(40); const [error, setError] = useState(""); const [mode, setMode] = useState<"record" | "pitch" | "enhance">("record");
  const s = v.settings; const rec = v.recording; const project = ps.project;
  const vocalTracks = project.tracks.filter((t) => t.vocal); const track: ProductionTrack | undefined = vocalTracks.find((t) => t.id === v.targetTrackId) ?? vocalTracks[0];
  useEffect(() => { if (track && v.targetTrackId !== track.id) vocal.setTarget(track.id); }, [track, v.targetTrackId, vocal]);
  useEffect(() => { void vocal.refreshDevices().catch(() => undefined); }, [vocal]);
  const run = (work: () => unknown) => { try { const r = work(); if (r instanceof Promise) r.catch((x) => setError(x instanceof Error ? x.message : String(x))); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } };
  // Space stops a recording (instead of only pausing the backing track underneath it).
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.code === "Space" && vocal.isRecording) { e.preventDefault(); e.stopImmediatePropagation(); void vocal.stopRecording(); } }; window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true); }, [vocal]);

  // Backing: tracks with content other than the vocal track; shown as a lane so nothing plays "hidden".
  const otherTracks = project.tracks.filter((t) => t.id !== track?.id && t.clips.length);
  const backingChoice = s.backing === "off" || s.backing === "all" || otherTracks.some((t) => t.id === s.backing) ? s.backing : "off";
  const backingIds = new Set(track ? vocal.backingTracks(track.id) : backingChoice === "all" ? otherTracks.map((t) => t.id) : backingChoice === "off" ? [] : [backingChoice]);
  const backingClips = project.tracks.filter((t) => backingIds.has(t.id)).flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
  const bar = 60 / project.bpm * project.timeSignature[0]; const takes = track?.vocal?.takes ?? [];
  const total = Math.max(studio.duration(), ...takes.map((t) => t.start + t.duration), (rec?.stopAt ?? 0) + bar, ps.position + bar * 2);
  const width = total * px; const position = rec?.position ?? ps.position;
  const livePath = useMemo(() => { if (!rec?.peaks.length) return ""; return rec.peaks.map((p) => { const x = p.pos * px, h = Math.max(.5, Math.min(1, p.peak) * 46); return `M${x.toFixed(1)} ${(50 - h).toFixed(1)}V${(50 + h).toFixed(1)}`; }).join(""); }, [rec?.peaks, px]);
  const monitorRoute = v.input.headphones === null ? "—" : v.input.headphones ? "Headphone output (4-channel routing)" : "Main output";
  const needsHeadphoneConfirm = v.input.headphones === false && !s.headphonesConfirmed;

  const tabs = <nav className="vs-tabs" aria-label="Vocal Studio">
    <button className={mode === "record" ? "active" : ""} aria-pressed={mode === "record"} onClick={() => setMode("record")}>● RECORD</button>
    <button className={mode === "pitch" ? "active" : ""} aria-pressed={mode === "pitch"} disabled={!track} onClick={() => setMode("pitch")}>♪ PITCH</button>
    <button className={mode === "enhance" ? "active" : ""} aria-pressed={mode === "enhance"} disabled={!track} onClick={() => setMode("enhance")}>✧ ENHANCE</button>
    {track && <span className="vs-tab-track">{track.name}{track.vocal?.listen === "original" ? " · ORIGINAL" : `${track.vocal?.pitch?.enabled ? " · TUNED" : ""}${app.pitch.chainActive(track) ? " · ENHANCED" : ""}`}</span>}
    {rec && mode !== "record" && <span className="vs-tab-recording">● RECORDING <button onClick={() => void vocal.stopRecording()}>STOP</button></span>}
  </nav>;
  if (mode === "enhance" && track) return <section className="vocal-studio pitch-mode" aria-label="Vocal Studio — enhance">{tabs}<VocalEnhancePanel track={track}/></section>;
  if (mode === "pitch" && track) return <section className="vocal-studio pitch-mode" aria-label="Vocal Studio — pitch">{tabs}<VocalPitchEditor track={track}/></section>;
  return <section className="vocal-studio" aria-label="Vocal Studio">
    {tabs}
    {error && <button className="sampler-error" onClick={() => setError("")}>⚠ {error} · dismiss</button>}
    <aside className="vs-input">
      <h2>INPUT</h2>
      {!v.input.open ? <button className="primary" onClick={() => run(() => vocal.openInput())}>🎙 CONNECT MICROPHONE</button> : <button onClick={() => vocal.closeInput()}>DISCONNECT</button>}
      {v.input.error && <p className="vs-warn">{v.input.error}</p>}
      <label>DEVICE <select value={s.deviceId} onFocus={() => void vocal.refreshDevices()} onChange={(e) => vocal.setSettings({ deviceId: e.target.value })}><option value="default">System default</option>{v.devices.filter((d) => d.id !== "default").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
      <label title="Which input channel of the interface carries the vocal">CHANNEL <select value={s.channel} onChange={(e) => vocal.setSettings({ channel: +e.target.value as 0 | 1 | -1 })}><option value={0}>Input 1{v.input.channels > 1 ? " (left)" : ""}</option><option value={1} disabled={v.input.channels < 2}>Input 2 (right)</option><option value={-1} disabled={v.input.channels < 2}>Mix 1 + 2</option></select></label>
      <label title="Digital trim before recording. Set your interface gain first; use this for fine adjustment.">INPUT TRIM <input type="range" min={-12} max={24} step={.5} value={trimDb(s.trim)} onChange={(e) => vocal.setSettings({ trim: 10 ** (+e.target.value / 20) })}/><output>{trimDb(s.trim) > 0 ? "+" : ""}{trimDb(s.trim)} dB</output></label>
      <div className="vs-meter" aria-label={`Input level ${dbOf(v.level.peak).toFixed(1)} dBFS`}><i className="rms" style={{ width: meterPct(v.level.rms) }}/><i className="peak" style={{ left: meterPct(v.level.peak) }}/><span className="mark" style={{ left: "70%" }}>-18</span><span className="mark" style={{ left: "90%" }}>-6</span></div>
      <div className="vs-meter-row"><output>{v.input.open ? `${dbOf(v.level.peak).toFixed(1)} dBFS` : "no input"}</output><button className={`vs-clip${v.level.clip || v.level.inputClip ? " on" : ""}`} onClick={() => vocal.resetClip()} title="Clip indicator — click to reset">{v.level.inputClip ? "INPUT CLIPPING" : v.level.clip ? "CLIP" : "OK"}</button></div>
      {v.level.inputClip && <p className="vs-warn">The signal clips before the trim — turn down the gain on your microphone / interface.</p>}
      {!v.level.inputClip && v.level.clip && <p className="vs-warn">Clipping after trim — lower INPUT TRIM.</p>}
      <p className="vs-hint">Aim for peaks around −12 to −6 dBFS.</p>

      <h2>MONITORING</h2>
      <label className="vs-check"><input type="checkbox" checked={s.monitor} disabled={!v.input.open || needsHeadphoneConfirm} onChange={(e) => vocal.setSettings({ monitor: e.target.checked })}/> LIVE MONITOR (dry)</label>
      <label>LEVEL <input type="range" min={0} max={1.5} step={.01} value={s.monitorLevel} onChange={(e) => vocal.setSettings({ monitorLevel: +e.target.value })}/><output>{Math.round(s.monitorLevel * 100)}%</output></label>
      <p className="vs-hint">Route: <b>{monitorRoute}</b></p>
      {v.input.headphones === false && <label className="vs-check vs-warn"><input type="checkbox" checked={s.headphonesConfirmed} onChange={(e) => vocal.setSettings({ headphonesConfirmed: e.target.checked, ...(e.target.checked ? {} : { monitor: false }) })}/> I'm wearing headphones — monitoring through speakers causes feedback</label>}
      <label className="vs-check" title="Hear your voice pitch-corrected to the track's key while you sing. The recording stays dry."><input type="checkbox" checked={v.tunedMonitor} disabled={!v.input.open || !track} onChange={(e) => { const ps2 = track ? app.pitch.settings(track) : null; if (ps2) vocal.setTunedMonitor({ enabled: e.target.checked, mask: app.pitch.mask(ps2), retuneMs: ps2.retuneMs, strength: ps2.strength }); }}/> TUNED MONITOR{track ? ` (${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][app.pitch.settings(track).key]} ${app.pitch.settings(track).scale})` : ""}</label>
      <p className="vs-hint">Your voice is heard ~{Math.round(v.latency.estimatedMs + (v.tunedMonitor ? vocal.tunedMonitorLatencyMs : 0))} ms late through the computer{v.tunedMonitor ? ` (incl. +${vocal.tunedMonitorLatencyMs.toFixed(0)} ms tuning)` : ""}. Set the key in the PITCH tab.</p>

      <h2>LATENCY</h2>
      <dl className="vs-latency"><dt>Output</dt><dd>{v.latency.outputMs.toFixed(1)} ms</dd><dt>Input</dt><dd>{v.latency.inputMs ? `${v.latency.inputMs.toFixed(1)} ms` : "not reported"}</dd><dt>Estimated</dt><dd>{v.latency.estimatedMs.toFixed(1)} ms</dd><dt>Measured</dt><dd>{v.latency.measuredMs === null ? "—" : `${v.latency.measuredMs.toFixed(1)} ms`}</dd><dt>Applied</dt><dd><b>{v.latency.appliedMs.toFixed(1)} ms</b></dd></dl>
      <button disabled={!v.input.open || v.measuring || !!rec} title="Plays six clicks through the speakers and listens for them. Use speakers (or hold the headphones to the mic / a loopback cable)." onClick={() => run(() => vocal.measureLatency())}>{v.measuring ? "MEASURING…" : "⏱ MEASURE LATENCY"}</button>
      <label>COMPENSATION <select value={s.latencyMode} onChange={(e) => vocal.setSettings({ latencyMode: e.target.value as "auto" | "manual" })}><option value="auto">Auto (measured, else estimated)</option><option value="manual">Manual</option></select></label>
      {s.latencyMode === "manual" && <label>MANUAL <input type="number" min={0} max={1000} step={.5} value={s.manualLatencyMs} onChange={(e) => vocal.setSettings({ manualLatencyMs: Math.max(0, +e.target.value) })}/> ms</label>}
    </aside>

    <div className="vs-main">
      <header className="vs-transport">
        <label>TRACK <select value={track?.id ?? ""} onChange={(e) => vocal.setTarget(e.target.value || null)} disabled={!!rec}>{!vocalTracks.length && <option value="">— new vocal track —</option>}{vocalTracks.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.vocal!.takes.length} take{t.vocal!.takes.length === 1 ? "" : "s"}</option>)}</select></label>
        <button disabled={!!rec} onClick={() => vocal.setTarget(studio.addVocalTrack())}>＋ NEW VOCAL TRACK</button>
        {!rec ? <button className="vs-record" disabled={v.measuring} title="Record a take (Space stops)" onClick={() => run(() => vocal.startRecording(track?.id))}>● RECORD</button>
          : <><button className="vs-record recording" onClick={() => void vocal.stopRecording()}>■ STOP</button><button onClick={() => void vocal.stopRecording(true)}>✕ DISCARD</button></>}
        <label className="vs-check" title="One bar of clicks / pre-roll before recording"><input type="checkbox" checked={s.countIn} disabled={!!rec} onChange={(e) => vocal.setSettings({ countIn: e.target.checked })}/> COUNT-IN</label>
        <label className="vs-check"><input type="checkbox" checked={s.metronome} disabled={!!rec} onChange={(e) => vocal.setSettings({ metronome: e.target.checked })}/> METRONOME</label>
        <label title="What you hear while recording. Off = only the count-in / metronome.">BACKING <select value={backingChoice} disabled={!!rec} onChange={(e) => vocal.setSettings({ backing: e.target.value })}><option value="off">Off</option><option value="all" disabled={!otherTracks.length}>Full arrangement ({otherTracks.length} track{otherTracks.length === 1 ? "" : "s"})</option>{otherTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <span className="vs-sep"/>
        <label className="vs-check" title="Record only between punch in and out; the rest of the existing take stays"><input type="checkbox" checked={s.punch} disabled={!!rec} onChange={(e) => vocal.setSettings({ punch: e.target.checked })}/> PUNCH</label>
        {s.punch && <><label>IN <input type="number" step={.01} min={0} value={s.punchIn.toFixed(2)} disabled={!!rec} onChange={(e) => vocal.setSettings({ punchIn: Math.max(0, +e.target.value) })}/></label><label>OUT <input type="number" step={.01} min={0} value={s.punchOut.toFixed(2)} disabled={!!rec} onChange={(e) => vocal.setSettings({ punchOut: Math.max(0, +e.target.value) })}/></label><button disabled={!!rec} title="Use the arrangement loop region as punch range" onClick={() => vocal.setSettings({ punchIn: project.loop.start, punchOut: project.loop.end })}>= LOOP</button></>}
        <span className="vs-grow"/>
        <output className={`vs-status${rec ? ` ${rec.phase}` : ""}`}>{rec ? (rec.phase === "count-in" ? `COUNT-IN · ${clock(rec.position)}` : `● REC ${clock(rec.position)}`) : clock(ps.position)}</output>
        <label>ZOOM <input type="range" min={10} max={160} value={px} onChange={(e) => setPx(+e.target.value)}/></label>
      </header>
      <div className="vs-timeline">
        <div className="vs-lanes" style={{ width: width + 160 }}>
          <div className="vs-ruler" style={{ marginLeft: 160, width }} onClick={(e) => { if (!rec) studio.seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / px); }}>{Array.from({ length: Math.ceil(total / bar) + 1 }, (_, i) => <span key={i} style={{ left: i * bar * px }}>{i + 1}</span>)}</div>
          <div className={`vs-lane vs-backing${backingClips.length ? "" : " off"}`}><div className="vs-lane-head"><b>BACKING</b><small>{backingChoice === "off" ? "Off — only the click plays" : backingChoice === "all" ? `Full arrangement · ${backingIds.size} tracks` : project.tracks.find((t) => t.id === backingChoice)?.name}</small></div><div className="vs-lane-body" style={{ width }}>
            {backingClips.map(({ clip, track: t }) => <div key={clip.id} className={`vs-backing-clip kind-${trackKind(t)}`} style={{ left: clip.start * px, width: Math.max(2, clip.duration * px) }} title={`${t.name} · ${clip.name}`}><span>{clip.name}</span></div>)}
            {!backingClips.length && <span className="vs-backing-hint">Choose BACKING to sing along to the arrangement or one track</span>}
            <i className="vs-playhead" style={{ left: position * px }}/>
          </div></div>
          <div className="vs-lane vs-live"><div className="vs-lane-head"><b>{rec ? "● RECORDING" : "INPUT"}</b><small>{rec ? `${track?.name ?? "new track"}` : v.input.open ? v.input.label : "not connected"}</small></div><div className="vs-lane-body" style={{ width }}>
            {s.punch && <i className="vs-punch" style={{ left: s.punchIn * px, width: Math.max(0, s.punchOut - s.punchIn) * px }}/>}
            {livePath && <svg className="vs-live-wave" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" style={{ width }}><path d={livePath}/></svg>}
            <i className="vs-playhead" style={{ left: position * px }}/>
          </div></div>
          {takes.slice().reverse().map((take) => { const active = track?.vocal?.activeTakeId === take.id; const a = take.analysis; return <div key={take.id} className={`vs-lane vs-take${active ? " active" : ""}`}>
            <div className="vs-lane-head"><input value={take.name} aria-label="Take name" onChange={(e) => studio.renameTake(track!.id, take.id, e.target.value)}/>
              <div className="vs-take-buttons"><button className={active ? "on" : ""} title={active ? "This take plays on the track" : "Use this take on the track (others are kept)"} onClick={() => run(() => studio.setActiveTake(track!.id, take.id))}>{active ? "★ ACTIVE" : "☆ USE"}</button><button title={`Play this take${backingIds.size ? " with the backing" : ""} from its start`} onClick={() => run(async () => { if (track?.vocal?.activeTakeId !== take.id) await studio.setActiveTake(track!.id, take.id); await vocal.playTake(track!.id, take.start); })}>▶</button><button title="Preview the dry recording on its own" onClick={() => run(() => studio.previewSource(take.ref))}>{ps.previewRef === take.ref ? "■" : "♪"}</button></div>
              {a && <small className={a.clippedSamples ? "vs-bad" : ""} title={`Peak ${a.peakDb.toFixed(1)} dBFS · RMS ${a.rmsDb.toFixed(1)} dBFS · noise floor ${a.noiseFloorDb.toFixed(1)} dBFS · voice active ${Math.round(a.activeRatio * 100)}% · latency compensation ${take.latencyMs.toFixed(1)} ms · ${take.input}`}>{take.duration.toFixed(1)}s · pk {a.peakDb.toFixed(0)} · floor {a.noiseFloorDb.toFixed(0)} dB{a.clippedSamples ? ` · ${a.clippedSamples} clipped` : ""}{take.punch ? " · punch" : ""}</small>}
            </div>
            <div className="vs-lane-body" style={{ width }}><TakeWave take={take} px={px} total={total}/><i className="vs-playhead" style={{ left: position * px }}/></div>
          </div>; })}
          {!takes.length && <p className="vs-empty">{v.input.open ? "Press ● RECORD. Takes appear here — every take is kept, and the ★ active one plays on the track in the arrangement." : "Connect a microphone, set the input level, then press ● RECORD."}</p>}
        </div>
      </div>
      <footer className="vs-status-bar">{v.message} · originals are never modified — pitch correction (PITCH tab) is non-destructive</footer>
    </div>
  </section>;
}

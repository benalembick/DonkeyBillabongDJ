/**
 * Live Looper — big performance controls, loop tracks with state + progress, shared input. Phase 2 adds overdub
 * layers (DUB / UNDO / REDO), LOOP QUANTIZE, the master-tempo proposal banner (free-running first loop), Threshold
 * Recording (AUTO-START arms REC and waits for input past a dB level) and Manual Trim (the IN slider / STRIP).
 * Everything calls `looper.perform()` (the future foot-controller / MIDI mapping target).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LoopStatus } from "../production/looper/LiveLooper";
import { LOOP_QUANTIZE_OPTIONS, type LoopQuantize, type LoopTrack } from "../production/types";
import { mixPeaks } from "../production/looper/timing";
import { useApp } from "./context";
import { useTick } from "./hooks";

const STATUS: Record<LoopStatus, { icon: string; label: string }> = {
  empty: { icon: "○", label: "EMPTY" }, armed: { icon: "◉", label: "ARMED" }, queued: { icon: "◔", label: "WAITING" }, recording: { icon: "●", label: "RECORDING" },
  closing: { icon: "⟳", label: "CLOSING" }, playing: { icon: "▶", label: "PLAYING" }, stopped: { icon: "■", label: "STOPPED" },
};
const dbOf = (v: number) => 20 * Math.log10(Math.max(1e-6, v));

/** Circular loop progress with the loop's (combined active-layer) waveform inside. */
function LoopRing({ track, progress, status }: { track: LoopTrack; progress: number; status: LoopStatus }) {
  const r = 46, c = 2 * Math.PI * r; const peaks = track.loop ? mixPeaks(track.loop.layers.slice(0, track.loop.active).map((l) => l.peaks)) : []; const max = Math.max(.01, ...peaks);
  const wave = peaks.length ? peaks.map((p, i) => { const x = 24 + i / peaks.length * 72, h = p / max * 16; return `M${x.toFixed(1)} ${(60 - h).toFixed(1)}V${(60 + h).toFixed(1)}`; }).join("") : "";
  return <svg className="lp-ring" viewBox="0 0 120 120" aria-hidden>
    <circle cx="60" cy="60" r={r} className="track"/>
    <circle cx="60" cy="60" r={r} className={`fill ${status}`} strokeDasharray={`${(progress * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 60 60)"/>
    {track.loop && Array.from({ length: track.loop.bars }, (_, i) => { const a = i / track.loop!.bars * 2 * Math.PI - Math.PI / 2; return <line key={i} x1={60 + Math.cos(a) * 40} y1={60 + Math.sin(a) * 40} x2={60 + Math.cos(a) * 52} y2={60 + Math.sin(a) * 52} className="tick"/>; })}
    {wave && <path d={wave} className="wave"/>}
  </svg>;
}

export function LiveLooperWorkspace() {
  const app = useApp(); const looper = app.looper; const vocal = app.vocal; const studio = app.production;
  const ls = useSyncExternalStore(looper.subscribe, looper.getState, looper.getState); const vs = useSyncExternalStore(vocal.subscribe, vocal.getState, vocal.getState); const ps = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState);
  useTick(40); const live = looper.live(); const session = ps.project.looper ?? looper.session(); const project = ps.project;
  useEffect(() => { looper.ensureSession(); }, [looper]);
  const act = (action: Parameters<typeof looper.perform>[0], trackId?: string) => void looper.perform(action, trackId).catch(() => undefined);
  // Space = REC / LOOP / DUB on the selected track (so it never starts the hidden arrangement).
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.code !== "Space" || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && !(e.target instanceof HTMLInputElement && ["range", "checkbox"].includes(e.target.type)))) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat) return; const s = looper.getState(); if (s.recording) { void looper.perform("loop").catch(() => undefined); return; } const sel = looper.session().tracks.find((t) => t.id === looper.session().selectedTrackId); void looper.perform(sel?.loop ? "overdub" : "record").catch(() => undefined); }; window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true); }, [looper]);
  const selected = session.tracks.find((t) => t.id === session.selectedTrackId); const rec = ls.recording; const hasLoops = session.tracks.some((t) => t.loop);
  const bigAction: Parameters<typeof looper.perform>[0] = rec ? "loop" : selected?.loop ? "overdub" : "record";
  const bigLabel = rec
    ? (rec.armed ? "◉ ARMED — press to cancel" : rec.closing ? `⟳ CLOSING ${rec.closing.bars} BAR${rec.closing.bars === 1 ? "" : "S"}` : live.countIn ? `COUNT-IN ${live.countIn}` : rec.kind === "overdub" ? "⧉ DUB — press to close" : rec.kind === "master" ? "⟳ LOOP — set the tempo" : "⟳ LOOP")
    : selected?.loop ? `⧉ DUB ${selected.name}` : `● REC ${selected?.name ?? ""}`;
  const needsHeadphones = vs.input.headphones === false && !vs.settings.headphonesConfirmed;
  const [draft, setDraft] = useState<{ bpm: number; bars: number } | null>(null);
  useEffect(() => { setDraft(ls.proposal ? { bpm: ls.proposal.bpm, bars: ls.proposal.bars } : null); }, [ls.proposal]);

  return <section className="live-looper" aria-label="Live Looper">
    <header className="lp-top">
      <div className="lp-title"><b>LIVE LOOPER</b><small>Phase 2 · overdub & timing</small></div>
      <label className="lp-bpm" title={hasLoops ? "Clear the loops to change tempo (time-stretch comes later)" : "Project tempo — or record the first loop freely and let LOOP detect it"}>BPM <input type="number" min={40} max={240} value={project.bpm} disabled={hasLoops || !!rec} onChange={(e) => studio.updateProject({ bpm: Math.max(40, Math.min(240, +e.target.value)) })}/></label>
      <span className="lp-sig">{project.timeSignature[0]} / {project.timeSignature[1]}</span>
      <output className={`lp-clock${ls.running ? " running" : ""}${live.countIn ? " count" : ""}`}>{live.countIn ? `COUNT-IN ${live.countIn}` : ls.running ? `${live.bar}.${live.beat}` : "—.—"}</output>
      <button className={`lp-big-rec${rec ? (rec.armed ? " armed" : rec.closing ? " closing" : " recording") : ""}`} disabled={!selected && !rec} onClick={() => act(bigAction)} title="REC starts on the next bar (count-in when stopped; free-running for the very first loop). Press again to close it (LOOP), or DUB to layer another pass over an existing loop. Space does the same.">{bigLabel}</button>
      <button className="lp-btn" disabled={!hasLoops} onClick={() => act("play-all")}>▶ PLAY ALL</button>
      <button className="lp-btn" disabled={!ls.running && !rec} onClick={() => act("stop-all")}>■ STOP ALL</button>
      <button className="lp-btn" disabled={!hasLoops} onClick={() => act("mute-all")}>🔇 MUTE ALL</button>
      <button className="lp-btn lp-panic" onClick={() => act("panic")} title="Stop all audio, recording, pads and notes; turn live monitoring off. Loops are kept.">⚠ PANIC</button>
      <span className="lp-grow"/>
      <label className="lp-check"><input type="checkbox" checked={session.countIn} onChange={(e) => looper.setOptions({ countIn: e.target.checked })}/> COUNT-IN</label>
      <label className="lp-check" title={vs.input.headphones ? "Click goes to the headphone output only" : "Click goes to the main output (no separate headphone output available)"}><input type="checkbox" checked={session.click} onChange={(e) => looper.setOptions({ click: e.target.checked })}/> CLICK</label>
      <label className="lp-quantize" title="How precisely REC/LOOP close on the bar (clamped to whole bars) and PLAY/STOP/TOGGLE land on the beat">QUANTIZE <select value={session.quantize} onChange={(e) => looper.setOptions({ quantize: e.target.value as LoopQuantize })}>{LOOP_QUANTIZE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
      <label className="lp-check lp-threshold" title="REC arms and waits silently; recording starts the instant the input crosses this level, so there's no leading silence. Doesn't apply to DUB, which always starts on the loop's own beat."><input type="checkbox" checked={session.thresholdRecord} onChange={(e) => looper.setOptions({ thresholdRecord: e.target.checked })}/> AUTO-START</label>
      {session.thresholdRecord && <label className="lp-threshold-db" title="Trigger level">AT <input type="number" min={-60} max={-6} value={session.thresholdDb} onChange={(e) => looper.setOptions({ thresholdDb: Math.max(-60, Math.min(-6, +e.target.value)) })}/> dB</label>}
    </header>
    {ls.proposal && draft && <div className="lp-proposal">
      <b>⟳ TEMPO DETECTED</b>
      <label>BPM <input type="number" min={40} max={240} value={draft.bpm} onChange={(e) => setDraft({ ...draft, bpm: +e.target.value })}/></label>
      <label>BARS <input type="number" min={1} max={16} value={draft.bars} onChange={(e) => setDraft({ ...draft, bars: Math.max(1, Math.round(+e.target.value)) })}/></label>
      <span className="lp-confidence">confidence {Math.round(ls.proposal.confidence * 100)}%</span>
      <button className="primary" onClick={() => void looper.confirmMaster(draft).catch(() => undefined)}>✓ USE THIS TEMPO</button>
      <button onClick={() => looper.discardMaster()}>DISCARD</button>
    </div>}
    <div className="lp-input">
      <b>INPUT</b>
      {vs.input.open ? <span className="lp-input-name">🎙 {vs.input.label}</span> : <button className="primary" onClick={() => void vocal.openInput().catch(() => undefined)}>🎙 CONNECT INPUT</button>}
      <select value={vs.settings.deviceId} onFocus={() => void vocal.refreshDevices()} onChange={(e) => vocal.setSettings({ deviceId: e.target.value })} aria-label="Input device"><option value="default">System default</option>{vs.devices.filter((d) => d.id !== "default").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
      <div className="lp-meter" title={`${dbOf(vs.level.peak).toFixed(1)} dBFS`}><i style={{ width: `${Math.max(0, Math.min(100, (dbOf(vs.level.peak) + 60) / 60 * 100))}%` }}/></div>
      {(vs.level.clip || vs.level.inputClip) && <button className="lp-clip" onClick={() => vocal.resetClip()}>CLIP</button>}
      <label className="lp-check"><input type="checkbox" checked={vs.settings.monitor} disabled={!vs.input.open || needsHeadphones} onChange={(e) => vocal.setSettings({ monitor: e.target.checked })}/> MONITOR</label>
      {vs.input.headphones === false && <label className="lp-check lp-warn"><input type="checkbox" checked={vs.settings.headphonesConfirmed} onChange={(e) => vocal.setSettings({ headphonesConfirmed: e.target.checked })}/> headphones on</label>}
      <small>latency comp {vs.latency.appliedMs.toFixed(0)} ms · trim, channel & latency test in the VOCAL tab</small>
    </div>
    <div className="lp-tracks">
      {session.tracks.map((t) => { const status = live.status[t.id] ?? "empty"; const st = STATUS[status]; const isSel = session.selectedTrackId === t.id; const anySolo = session.tracks.some((x) => x.solo); const silent = t.muted || (anySolo && !t.solo);
        return <div key={t.id} className={`lp-track ${status}${isSel ? " selected" : ""}${silent ? " silent" : ""}`} onClick={() => act("select", t.id)}>
          <div className="lp-track-head"><input value={t.name} aria-label="Track name" onClick={(e) => e.stopPropagation()} onChange={(e) => looper.setTrack(t.id, { name: e.target.value })}/><span className={`lp-status ${status}`}>{st.icon} {status === "queued" && live.countIn ? `COUNT-IN ${live.countIn}` : status === "recording" ? `REC ${live.recordingBars.toFixed(1)} BARS` : st.label}</span></div>
          <div className="lp-ring-wrap"><LoopRing track={t} progress={live.progress[t.id] ?? 0} status={status}/><span className="lp-len">{t.loop ? `${t.loop.bars} BAR${t.loop.bars === 1 ? "" : "S"}` : status === "recording" || status === "closing" ? "REC" : "—"}</span>{t.loop && t.loop.layers.length > 1 && <span className="lp-layers">{t.loop.active}/{t.loop.layers.length} PASS{t.loop.layers.length === 1 ? "" : "ES"}</span>}{silent && t.loop && <span className="lp-muted-tag">{t.muted ? "MUTED" : "NOT SOLO"}</span>}</div>
          <div className="lp-track-buttons" onClick={(e) => e.stopPropagation()}>
            {!t.loop ? <button className={`lp-rec${status === "recording" || status === "queued" || status === "armed" ? " on" : ""}`} disabled={!!rec && rec.trackId !== t.id} onClick={() => act(rec?.trackId === t.id ? "loop" : "record", t.id)}>{rec?.trackId === t.id ? (rec.armed ? "◉ …" : rec.closing ? "⟳ …" : "⟳ LOOP") : "● REC"}</button>
              : <button className={`lp-play${status === "playing" ? " on" : ""}`} disabled={rec?.trackId === t.id && rec.kind === "overdub"} onClick={() => act("toggle", t.id)}>{status === "playing" ? "■ STOP" : "▶ PLAY"}</button>}
            <button className={t.muted ? "on" : ""} aria-pressed={t.muted} disabled={!t.loop} onClick={() => act("mute", t.id)}>M</button>
            <button className={t.solo ? "on solo" : ""} aria-pressed={t.solo} disabled={!t.loop} onClick={() => act("solo", t.id)}>S</button>
            <button disabled={!t.loop || status === "recording"} title="Remove the loop and every overdub layer (Production Studio undo brings it back)" onClick={() => act("clear", t.id)}>CLEAR</button>
          </div>
          {t.loop && <div className="lp-dub-row" onClick={(e) => e.stopPropagation()}>
            <button className={`lp-dub${rec?.trackId === t.id && rec.kind === "overdub" ? " on" : ""}`} disabled={!!rec && rec.trackId !== t.id} title="Layer another pass over this loop without erasing what's there (hold through more repeats to layer them together)" onClick={() => act(rec?.trackId === t.id ? "loop" : "overdub", t.id)}>{rec?.trackId === t.id && rec.kind === "overdub" ? (rec.closing ? "⧉ …" : "⧉ STOP") : "⧉ DUB"}</button>
            <button disabled={t.loop.active <= 1} title="Undo the last overdub (kept, not deleted — REDO brings it back)" onClick={() => act("undo", t.id)}>↶ UNDO</button>
            <button disabled={t.loop.active >= t.loop.layers.length} title="Redo the overdub" onClick={() => act("redo", t.id)}>↷ REDO</button>
          </div>}
          {t.loop && <div className="lp-trim-row" onClick={(e) => e.stopPropagation()} title="Manual Trim: where playback starts inside the loop (non-destructive — nothing is cut, the loop just starts later and wraps around to what came before)">
            <span className="lp-trim-label">IN {(t.loop.trimIn * 1000).toFixed(0)} ms</span>
            <input type="range" min={0} max={Math.max(.01, t.loop.duration - .02)} step={.005} value={t.loop.trimIn} disabled={rec?.trackId === t.id} onChange={(e) => looper.setTrim(t.id, +e.target.value)}/>
            <button disabled={rec?.trackId === t.id} title="Auto-detect and skip leading silence" onClick={() => void looper.stripSilence(t.id).catch(() => undefined)}>✂ STRIP</button>
          </div>}
          <label className="lp-vol" onClick={(e) => e.stopPropagation()}>VOL <input type="range" min={0} max={1.5} step={.01} value={t.volume} onChange={(e) => looper.setTrack(t.id, { volume: +e.target.value }, false)}/></label>
          {t.loop && <label className="lp-vol lp-lowcut" onClick={(e) => e.stopPropagation()} title="Rolls bass off this track in real time — useful when two layers are competing for the same low end">LOW CUT {t.lowCutHz ? `${Math.round(t.lowCutHz)} Hz` : "OFF"} <input type="range" min={20} max={400} step={5} value={t.lowCutHz ?? 20} onChange={(e) => looper.setLowCut(t.id, +e.target.value)}/></label>}
        </div>; })}
      <button className="lp-add" onClick={() => looper.addTrack()}>＋<span>ADD TRACK</span></button>
    </div>
    <footer className="lp-footer">{ls.message}{!vs.input.open ? " · connect an input to record" : ""}</footer>
  </section>;
}

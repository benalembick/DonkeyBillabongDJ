/**
 * Vocal Studio — ENHANCE tab (Phase 3): AUTO ENHANCE VOCAL with presets + AMOUNT, ORIGINAL | ENHANCED A/B, the report
 * of what was applied, and (ADVANCED) every processor with its own bypass, parameters and gain-reduction readout.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { BREATH_GAIN, LEVEL_MODES, PROCESSOR_ORDER, type CleanupChain, type ProcessorId } from "../production/vocal/cleanup";
import { ENHANCE_PRESETS, type EnhancePresetId } from "../production/vocal/enhance";
import type { AudioClip, ProductionTrack } from "../production/types";
import { useApp } from "./context";

const TITLES: Record<ProcessorId, { title: string; hint: string }> = {
  gate: { title: "Gate / Expander", hint: "Turns down background noise between phrases" }, breath: { title: "Breath Control", hint: "Makes breaths quieter (after the compressor, so they stay down) — never deletes them" },
  deesser: { title: "De-esser", hint: "Tames harsh S / SH / T sounds" }, eq: { title: "EQ", hint: "Rumble filter, mud, presence, air and resonance cuts" },
  level: { title: "Auto Level", hint: "Rides the volume to even out mic-distance swings" }, comp: { title: "Compressor", hint: "Smooths the remaining dynamics" },
  multiband: { title: "Multiband Compressor", hint: "Controls lows, mids and highs separately" }, limiter: { title: "Limiter", hint: "Stops peaks going over the ceiling" },
};

function Param({ label, value, min, max, step, unit = "", onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange(v: number): void }) {
  return <label className="ve-param"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)}/><output>{Number.isInteger(step) ? Math.round(value) : value.toFixed(step < .1 ? 2 : 1)}{unit}</output></label>;
}

/** Gain-change graph over the take: reductions hang from the top (dB); `bipolar` (Auto Level) centres 0 dB, lifts go up. */
function GrGraph({ gr, from, to, bipolar = false }: { gr: Float32Array; from: number; to: number; bipolar?: boolean }) {
  const a = Math.max(0, Math.floor(from / .01)), b = Math.min(gr.length, Math.ceil(to / .01)); const n = Math.max(1, b - a); const W = 220, H = 30; const step = Math.max(1, Math.floor(n / W));
  const zero = bipolar ? H / 2 : 0, scale = bipolar ? H / 2 / 12 : H / 24; let d = `M0 ${zero}`;
  for (let i = 0; i < n; i += step) { let m = 0; for (let k = i; k < Math.min(n, i + step); k++) { const v = gr[a + k]; if (Math.abs(v) > Math.abs(m)) m = bipolar ? v : Math.min(m, v); } d += `L${(i / n * W).toFixed(1)} ${Math.max(0, Math.min(H, zero - m * scale)).toFixed(1)}`; }
  d += `L${W} ${zero}Z`;
  return <svg className="ve-gr" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>{bipolar && <line x1={0} x2={W} y1={zero} y2={zero}/>}<path d={d}/></svg>;
}

export function VocalEnhancePanel({ track }: { track: ProductionTrack }) {
  const app = useApp(); const pitch = app.pitch; const studio = app.production; const vocal = app.vocal;
  const pst = useSyncExternalStore(pitch.subscribe, pitch.getState, pitch.getState); const ps = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState);
  const [advanced, setAdvanced] = useState(false); const [preset, setPreset] = useState<EnhancePresetId>(track.vocal?.chain?.preset && track.vocal.chain.preset !== "custom" ? track.vocal.chain.preset : "clean-studio"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const take = track.vocal?.takes.find((t) => t.id === track.vocal?.activeTakeId) ?? track.vocal?.takes.at(-1); const chain = pitch.chain(track); const c = chain.processors; const listen = track.vocal?.listen ?? "processed";
  const clip = track.clips.find((x): x is AudioClip => x.type === "audio" && !!take && x.takeId === take.id); const result = clip ? pitch.resultOf(clip.ref) : null;
  useEffect(() => { if (clip && clip.ref !== take?.ref && !result) void studio.getBuffer(clip.ref).catch(() => undefined); }, [clip?.ref, result, studio, take?.ref]);
  void pst;
  const set = <K extends ProcessorId>(id: K, patch: Partial<CleanupChain[K]>, message = `${TITLES[id].title} updated`) => pitch.updateChain(track.id, (s) => { s.processors[id] = { ...s.processors[id], ...patch }; s.preset = "custom"; }, message);
  const enhance = async () => { if (!take) return; setBusy(true); setError(""); try { await pitch.autoEnhance(track.id, take.id, preset, chain.amount || 1); } catch (x) { setError(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } };
  if (!take) return <div className="vp-empty">Record a take first, then AUTO ENHANCE it here.</div>;
  const meter = (id: ProcessorId) => { const m = result?.meters[id]; if (!m) return <span className="ve-readout">{c[id].on ? "—" : "bypassed"}</span>;
    if (id === "level") return <span className={`ve-readout${m.maxGr < -.5 || m.maxBoost > .5 ? " active" : ""}`}>rides {m.maxGr.toFixed(1)} … +{m.maxBoost.toFixed(1)} dB</span>;
    return <span className={`ve-readout${m.maxGr < -.5 ? " active" : ""}`}>GR max {m.maxGr.toFixed(1)} dB · avg {m.avgGr.toFixed(1)} dB</span>; };
  const card = (id: ProcessorId, body: ReactNode) => <section key={id} className={`ve-card${c[id].on ? " on" : ""}`}>
    <header><label className="ve-power" title={c[id].on ? "Bypass" : "Enable"}><input type="checkbox" checked={c[id].on} onChange={(e) => set(id, { on: e.target.checked } as Partial<CleanupChain[typeof id]>, `${TITLES[id].title} ${e.target.checked ? "on" : "bypassed"}`)}/> <b>{TITLES[id].title}</b></label><small>{TITLES[id].hint}</small></header>
    {meter(id)}{result?.meters[id] && <GrGraph gr={result.meters[id]!.gr} from={take.offset} to={take.offset + take.duration} bipolar={id === "level"}/>}
    <div className="ve-params">{body}</div>
  </section>;

  return <div className="vocal-enhance">
    {error && <button className="sampler-error" onClick={() => setError("")}>⚠ {error} · dismiss</button>}
    <div className="vp-controls ve-top">
      <div className="vp-ab" role="group" aria-label="A/B"><button className={listen === "original" ? "active" : ""} aria-pressed={listen === "original"} onClick={() => pitch.setListen(track.id, "original")}>ORIGINAL</button><button className={listen !== "original" ? "active" : ""} aria-pressed={listen !== "original"} onClick={() => pitch.setListen(track.id, "processed")}>ENHANCED</button></div>
      <button className="vp-play" onClick={() => (ps.playing ? studio.pause() : void vocal.playTake(track.id, take.start))}>{ps.playing ? "■ STOP" : "▶ PLAY"}</button>
      <button className="ve-auto" disabled={busy} onClick={() => void enhance()}>{busy ? "ANALYSING…" : "✦ AUTO ENHANCE VOCAL"}</button>
      <label className="ve-amount">AMOUNT <input type="range" min={0} max={1} step={.01} value={chain.amount} onChange={(e) => pitch.updateChain(track.id, (s) => { s.amount = +e.target.value; }, "Amount", false)}/><output>{Math.round(chain.amount * 100)}%</output></label>
      <span className="vp-grow"/>
      {pst.renderingRef && <span className="vp-busy">Rendering…</span>}
      <div className="vp-ab" role="group" aria-label="View"><button className={!advanced ? "active" : ""} onClick={() => setAdvanced(false)}>SIMPLE</button><button className={advanced ? "active" : ""} onClick={() => setAdvanced(true)}>ADVANCED</button></div>
    </div>
    <div className="ve-body">
      <div className="ve-presets" role="radiogroup" aria-label="Enhance preset">{(Object.keys(ENHANCE_PRESETS) as EnhancePresetId[]).map((id) => <button key={id} role="radio" aria-checked={preset === id} className={`${preset === id ? "selected" : ""}${chain.preset === id ? " applied" : ""}`} onClick={() => setPreset(id)}><b>{ENHANCE_PRESETS[id].label}</b><small>{ENHANCE_PRESETS[id].hint}</small>{chain.preset === id && <em>APPLIED</em>}</button>)}</div>
      <aside className="ve-report"><h3>WHAT WAS APPLIED</h3>{chain.report ? <ol>{chain.report.map((line, i) => <li key={i}>{line}</li>)}</ol> : <p>Press <b>AUTO ENHANCE VOCAL</b>: the take is analysed (noise, sibilance, level swings, tone, resonances, breaths) and the chain is built for the chosen preset. Your recording is never changed — ORIGINAL is always one click away.</p>}
        {result && <dl>{result.levelSpread && <><dt>Level swing</dt><dd>{result.levelSpread.before.toFixed(1)} → {result.levelSpread.after.toFixed(1)} dB</dd></>}<dt>Breaths</dt><dd>{result.breaths.length ? `${result.breaths.length} found${c.breath.on ? ` · ${c.breath.mode === "keep" ? "kept" : `${BREATH_GAIN[c.breath.mode]} dB`}` : ""}` : "none found"}</dd></dl>}
        <small>Space, width, saturation and doubling join the chain in Phase 5.</small></aside>
      {advanced && <div className="ve-cards">{PROCESSOR_ORDER.map((id) => {
        switch (id) {
          case "gate": return card(id, <><Param label="THRESHOLD" value={c.gate.threshold} min={-80} max={-10} step={.5} unit=" dB" onChange={(v) => set("gate", { threshold: v })}/><Param label="RANGE" value={c.gate.range} min={0} max={40} step={1} unit=" dB" onChange={(v) => set("gate", { range: v })}/><Param label="RATIO" value={c.gate.ratio} min={1.5} max={10} step={.5} onChange={(v) => set("gate", { ratio: v })}/><Param label="HOLD" value={c.gate.holdMs} min={0} max={200} step={5} unit=" ms" onChange={(v) => set("gate", { holdMs: v })}/><Param label="RELEASE" value={c.gate.releaseMs} min={20} max={500} step={10} unit=" ms" onChange={(v) => set("gate", { releaseMs: v })}/></>);
          case "breath": return card(id, <div className="ve-modes">{(["keep", "reduce", "strong"] as const).map((m) => <button key={m} className={c.breath.mode === m ? "active" : ""} onClick={() => set("breath", { mode: m })}>{m === "keep" ? "KEEP" : m === "reduce" ? "REDUCE −9 dB" : "STRONG −20 dB"}</button>)}</div>);
          case "deesser": return card(id, <><Param label="FREQUENCY" value={c.deesser.freq} min={3000} max={10000} step={100} unit=" Hz" onChange={(v) => set("deesser", { freq: v })}/><Param label="THRESHOLD" value={c.deesser.threshold} min={-60} max={-5} step={.5} unit=" dB" onChange={(v) => set("deesser", { threshold: v })}/><Param label="MAX REDUCTION" value={c.deesser.maxReduction} min={0} max={20} step={.5} unit=" dB" onChange={(v) => set("deesser", { maxReduction: v })}/></>);
          case "eq": return card(id, <><Param label="HIGH-PASS" value={c.eq.hpf} min={0} max={250} step={5} unit=" Hz" onChange={(v) => set("eq", { hpf: v })}/><Param label="WARMTH" value={c.eq.lowShelf.gain} min={-6} max={6} step={.5} unit=" dB" onChange={(v) => set("eq", { lowShelf: { ...c.eq.lowShelf, gain: v } })}/><Param label={`MUD ${c.eq.mud.freq} Hz`} value={c.eq.mud.gain} min={-9} max={3} step={.5} unit=" dB" onChange={(v) => set("eq", { mud: { ...c.eq.mud, gain: v } })}/><Param label={`PRESENCE ${c.eq.presence.freq / 1000}k`} value={c.eq.presence.gain} min={-6} max={8} step={.5} unit=" dB" onChange={(v) => set("eq", { presence: { ...c.eq.presence, gain: v } })}/><Param label="AIR 10k" value={c.eq.air.gain} min={-6} max={8} step={.5} unit=" dB" onChange={(v) => set("eq", { air: { ...c.eq.air, gain: v } })}/>
            <div className="ve-res">{c.eq.resonances.length ? c.eq.resonances.map((r, i) => <span key={i}>{r.freq} Hz {r.gain} dB <button aria-label={`Remove the ${r.freq} Hz cut`} onClick={() => set("eq", { resonances: c.eq.resonances.filter((_, j) => j !== i) })}>×</button></span>) : <small>No resonance cuts (Auto Enhance finds them)</small>}</div></>);
          case "level": return card(id, <div className="ve-modes">{(Object.keys(LEVEL_MODES) as (keyof typeof LEVEL_MODES)[]).map((m) => <button key={m} className={c.level.mode === m ? "active" : ""} title={`±${LEVEL_MODES[m].range} dB`} onClick={() => set("level", { mode: m })}>{LEVEL_MODES[m].label.toUpperCase()} ±{LEVEL_MODES[m].range} dB</button>)}</div>);
          case "comp": return card(id, <><Param label="THRESHOLD" value={c.comp.threshold} min={-50} max={0} step={.5} unit=" dB" onChange={(v) => set("comp", { threshold: v })}/><Param label="RATIO" value={c.comp.ratio} min={1} max={12} step={.1} unit=":1" onChange={(v) => set("comp", { ratio: v })}/><Param label="ATTACK" value={c.comp.attackMs} min={.5} max={60} step={.5} unit=" ms" onChange={(v) => set("comp", { attackMs: v })}/><Param label="RELEASE" value={c.comp.releaseMs} min={20} max={600} step={10} unit=" ms" onChange={(v) => set("comp", { releaseMs: v })}/><Param label="KNEE" value={c.comp.knee} min={0} max={12} step={.5} unit=" dB" onChange={(v) => set("comp", { knee: v })}/><Param label="MAKEUP" value={c.comp.makeup} min={0} max={18} step={.5} unit=" dB" onChange={(v) => set("comp", { makeup: v })}/></>);
          case "multiband": return card(id, <><Param label="LOW / MID" value={c.multiband.lowFreq} min={80} max={800} step={10} unit=" Hz" onChange={(v) => set("multiband", { lowFreq: v })}/><Param label="MID / HIGH" value={c.multiband.highFreq} min={1500} max={10000} step={100} unit=" Hz" onChange={(v) => set("multiband", { highFreq: v })}/>{["LOW", "MID", "HIGH"].map((name, k) => <Param key={name} label={`${name} THRESH`} value={c.multiband.bands[k].threshold} min={-50} max={0} step={.5} unit=" dB" onChange={(v) => set("multiband", { bands: c.multiband.bands.map((b, j) => (j === k ? { ...b, threshold: v } : b)) })}/>)}{["LOW", "MID", "HIGH"].map((name, k) => <Param key={`${name}r`} label={`${name} RATIO`} value={c.multiband.bands[k].ratio} min={1} max={8} step={.1} unit=":1" onChange={(v) => set("multiband", { bands: c.multiband.bands.map((b, j) => (j === k ? { ...b, ratio: v } : b)) })}/>)}</>);
          case "limiter": return card(id, <><Param label="CEILING" value={c.limiter.ceiling} min={-6} max={0} step={.1} unit=" dBFS" onChange={(v) => set("limiter", { ceiling: v })}/><Param label="RELEASE" value={c.limiter.releaseMs} min={10} max={300} step={5} unit=" ms" onChange={(v) => set("limiter", { releaseMs: v })}/></>);
        }
      })}</div>}
    </div>
    <footer className="vs-status-bar">{pst.message || "Auto Enhance builds the chain; ADVANCED shows every processor"} · original take untouched · order: gate → de-esser → EQ → auto level → compressor → multiband → breath → limiter (breaths are found on the clean signal, lowered after the dynamics)</footer>
  </div>;
}

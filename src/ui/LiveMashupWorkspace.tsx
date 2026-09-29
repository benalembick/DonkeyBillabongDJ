import { useCallback, useEffect, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { MASHUP_STEMS, type MashupSource } from "../mashup/LiveMashupService";
import { useApp, useEngineState } from "./context";
import { useFrameStore } from "./hooks";
import { ArtTile } from "./ArtTile";
import { OverviewWaveform, ScrollingWaveform } from "./Waveforms";

function Source({ label, source, side }: { label: string; source: MashupSource | null; side: "a" | "b" }) {
  const { liveMashup } = useApp();
  const engine = useEngineState();
  if (!source) return <section className="mashup-source"><h3>{label}</h3><p>Preparing…</p></section>;
  const d = engine.decks[source.deck];
  return <section className="mashup-source">
    <h3>{label}</h3><div className="mashup-track"><ArtTile track={source.track} size={64}/><div><b>{source.track.title}</b><p>{source.track.artist}</p><span>{source.track.bpm ?? "?"} BPM · {source.track.key ?? "Unknown key"} · {source.track.camelot ?? "—"} · Energy {source.track.energy ?? "?"}</span></div></div>
    <OverviewWaveform deck={source.deck}/>
    <div className="mashup-scroll"><ScrollingWaveform deck={source.deck} orientation="horizontal"/></div>
    <div className="mashup-stems">{MASHUP_STEMS.map((name, i) => <label key={name}><span><input type="checkbox" checked={source.selected[i]} onChange={(e) => liveMashup.setStem(side, i, e.target.checked)}/>{name}</span><input type="range" min="0" max="1" step=".01" value={source.levels[i]} onChange={(e) => liveMashup.setLevel(side, i, Number(e.target.value))}/><output>{Math.round(source.levels[i] * 100)}%</output></label>)}</div>
    <small className={`stem-progress-text ${d.stems.status}`}>STEMS: {d.stems.status} {Math.round(d.stems.progress * 100)}% {d.stems.message ?? ""}</small>
  </section>;
}

export function LiveMashupWorkspace({ a, b, recipeId, onBack }: { a: TrackInfo; b: TrackInfo; recipeId?: string; onBack: () => void }) {
  const { liveMashup } = useApp();
  const state = useFrameStore(useCallback((cb) => liveMashup.on("change", cb), [liveMashup]), () => liveMashup.getState());
  const [savedProject, setSavedProject] = useState("");
  useEffect(() => { void (recipeId ? liveMashup.ready.then(() => liveMashup.openRecipe(recipeId)) : liveMashup.create(a, b)); }, [liveMashup, a.ref, b.ref, recipeId]);
  useEffect(() => { setSavedProject((current) => state.recipeId ?? (state.recipes.some((r) => r.id === current) ? current : state.recipes[0]?.id ?? "")); }, [state.recipeId, state.recipes]);
  return <div className="live-mashup">
    <div className="toolbar"><button onClick={onBack}>← Recommendations</button><b>LIVE MASHUP</b><button className="primary" disabled={!state.a || !state.b} onClick={() => liveMashup.playPause()}>{state.status === "playing" ? "PAUSE" : "PLAY"}</button><button disabled={!state.a} onClick={() => liveMashup.resync()}>SYNC</button><label>Phrase <select value={state.phraseBars} onChange={(e) => liveMashup.setPhraseBars(Number(e.target.value) as 8 | 16 | 32)}><option value="8">8 bars</option><option value="16">16 bars</option><option value="32">32 bars</option></select></label><button disabled={!state.a} onClick={() => liveMashup.swap()}>SWAP VOCAL / INSTRUMENTAL</button><button disabled={!state.a} onClick={() => void liveMashup.saveRecipe()}>SAVE PROJECT</button><button className="primary" disabled={!state.a || state.renderProgress !== null} onClick={() => void liveMashup.renderMashup()}>SAVE MASHUP MP3</button>{state.renderProgress !== null && <span>Rendering {Math.round(state.renderProgress*100)}%</span>}</div>
    {!!state.recipes.length && <div className="mashup-projects"><label><b>Saved projects</b><select aria-label="Saved mashup project" value={savedProject} onChange={(e) => setSavedProject(e.target.value)}>{state.recipes.slice().sort((a,b) => b.updatedAt-a.updatedAt).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><button className="primary" disabled={!savedProject} onClick={() => void liveMashup.openRecipe(savedProject)}>LOAD TO DECKS</button><button disabled={!savedProject} onClick={() => void liveMashup.openRecipe(savedProject)}>EDIT</button><button className="danger" disabled={!savedProject} onClick={() => { const id=savedProject,set=state.recipes.filter((r)=>r.id!==id);setSavedProject(set[0]?.id??"");void liveMashup.deleteRecipe(id); }}>DELETE</button></div>}
    <div className="mashup-summary"><b>{state.targetBpm ?? "?"} BPM</b><span>Target key {state.targetKey ?? "Unknown"}</span><span>{state.score}% compatibility</span><span>{state.phraseBars}-bar phrase alignment</span></div>
    {state.warning && <p className="warn">{state.warning}</p>}<p className="hint">{state.message}</p>
    <div className="mashup-sources"><Source label="TRACK A — VOCAL SOURCE" source={state.a} side="a"/><div className="mashup-center">×<small>SYNC</small></div><Source label="TRACK B — INSTRUMENTAL SOURCE" source={state.b} side="b"/></div>
    <section className="mashup-arrangement"><div className="toolbar"><b>ARRANGEMENT BLOCKS</b><button onClick={() => liveMashup.addBlock()}>+ Add block</button></div>{state.blocks.map((block) => <div className="mashup-block" key={block.id}><label>Start bar <input type="number" min="0" value={block.startBar} onChange={(e) => liveMashup.updateBlock(block.id, { startBar: Number(e.target.value) })}/></label><label>Length <select value={block.bars} onChange={(e) => liveMashup.updateBlock(block.id, { bars: Number(e.target.value) as 8|16|32 })}><option value="8">8</option><option value="16">16</option><option value="32">32</option></select> bars</label><span>A: {MASHUP_STEMS.map((name,i)=><label key={name}><input type="checkbox" checked={block.aSelected[i]} onChange={(e)=>{const x=block.aSelected.slice();x[i]=e.target.checked;liveMashup.updateBlock(block.id,{aSelected:x});}}/>{name[0]}</label>)}</span><span>B: {MASHUP_STEMS.map((name,i)=><label key={name}><input type="checkbox" checked={block.bSelected[i]} onChange={(e)=>{const x=block.bSelected.slice();x[i]=e.target.checked;liveMashup.updateBlock(block.id,{bSelected:x});}}/>{name[0]}</label>)}</span><button onClick={() => liveMashup.removeBlock(block.id)}>Delete</button></div>)}</section>
    {(state.vocalRegions.a.length > 0 || state.vocalRegions.b.length > 0) && <div className="vocal-regions"><b>Detected vocal activity</b><span>A: {state.vocalRegions.a.slice(0,8).map(([a,b])=>`${a.toFixed(0)}–${b.toFixed(0)}s`).join(" · ") || "none"}</span><span>B: {state.vocalRegions.b.slice(0,8).map(([a,b])=>`${a.toFixed(0)}–${b.toFixed(0)}s`).join(" · ") || "none"}</span></div>}
    <p className="hint">Live playback and arrangement automation use the normal decks, cached STEMS, deck Sync, beatgrids, phrase-snapped entries, vocal low-frequency reduction and conservative headroom. Projects persist in the application database and can be reopened and edited.</p>
  </div>;
}

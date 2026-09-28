import { useMemo, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { compatibility, mashupMatches, recommendSequence, type EnergyFlow, type Recommendation } from "../analysis/discovery";
import { useApp, useEngineState } from "./context";

export type DiscoveryMode = "matches" | "djmix" | "mashup";
const time = (s?: number) => s === undefined ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function DiscoveryDialog({ mode, start, tracks, onClose }: { mode: DiscoveryMode; start: TrackInfo; tracks: TrackInfo[]; onClose: () => void }) {
  const { preparation, playlists, stems, engine, log } = useApp();
  const deckState = useEngineState();
  const [flow, setFlow] = useState<EnergyFlow>("steady");
  const [revision, setRevision] = useState(0);
  const [removed, setRemoved] = useState<string[]>([]);
  const prep = (t: TrackInfo) => preparation.forRef(t.ref);
  const recommendations = useMemo(() => {
    const candidates = tracks.filter((t) => !removed.includes(t.ref));
    if (mode === "mashup") return mashupMatches(start, candidates, prep, (r) => !!stems.index()[r]);
    if (mode === "djmix") return recommendSequence(start, candidates, prep, flow);
    return candidates.filter((t) => t.ref !== start.ref).map((track) => ({ track, match: compatibility(start, track, prep(start), prep(track)) })).sort((a, b) => b.match.score - a.match.score);
  }, [tracks, start, mode, flow, removed, revision, preparation, stems]);
  const [order, setOrder] = useState<string[]>([]);
  const ranked: Recommendation[] = order.length ? order.map((ref) => recommendations.find((x) => x.track.ref === ref)).filter((x): x is Recommendation => !!x).concat(recommendations.filter((x) => !order.includes(x.track.ref))) : recommendations;
  const move = (ref: string, delta: number) => {
    const refs = ranked.map((r) => r.track.ref), i = refs.indexOf(ref), j = Math.max(0, Math.min(refs.length - 1, i + delta));
    [refs[i], refs[j]] = [refs[j], refs[i]]; setOrder(refs);
  };
  const save = () => {
    const refs = [start.ref, ...ranked.slice(0, 30).map((r) => r.track.ref)];
    const p = playlists.create(`DJMix - ${start.title}`, refs);
    log.info("library", `Created ${p.name} with ${refs.length} tracks; it is ready for Auto DJ.`); onClose();
  };
  const preview = (track: TrackInfo) => {
    const free = deckState.decks.findIndex((d) => !d.playing);
    if (free < 0) log.warn("engine", "Pause a deck to preview without interrupting playback."); else void engine.loadTrack(free, track);
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal wide discovery" onMouseDown={(e) => e.stopPropagation()}>
    <button className="modal-close" onClick={onClose}>×</button>
    <h2>{mode === "djmix" ? "Create DJMix Playlist" : mode === "mashup" ? "Mashup Mode" : "Compatible Tracks"}</h2>
    <p className="hint">Reference: <b>{start.artist} — {start.title}</b>. Scores combine key, tempo, energy, genre, structure and detected mix points.</p>
    {mode === "djmix" && <div className="toolbar"><label>Energy flow <select value={flow} onChange={(e) => setFlow(e.target.value as EnergyFlow)}><option value="steady">Steady</option><option value="warm-build-peak-wind-down">Warm Up → Build → Peak → Wind Down</option></select></label><button onClick={() => { setOrder([]); setRemoved([]); setRevision((x) => x + 1); }}>Regenerate</button><button className="primary" onClick={save}>Save DJMix Playlist</button></div>}
    <div className="table-wrap"><table className="tracks"><thead><tr><th>Match</th><th>Track</th><th>Why</th><th>Transition</th><th>Actions</th></tr></thead><tbody>
      {ranked.slice(0, 50).map((r) => <tr key={r.track.ref}><td><b>{r.match.score}%</b><small className="confidence">{Math.round(r.match.confidence * 100)}% confidence</small></td><td>{r.track.artist} — {r.track.title}</td><td>{r.match.reasons.join(" · ")}{"combinations" in r ? ` · ${(r as ReturnType<typeof mashupMatches>[number]).combinations.join(" · ")}` : ""}</td><td>{r.match.mixOut !== undefined && r.match.mixIn !== undefined ? `Out ${time(r.match.mixOut)} → In ${time(r.match.mixIn)}, ${r.match.bars ?? 16} bars` : "Analyse both tracks for mix points"}</td><td className="row-actions"><button onClick={() => preview(r.track)}>Preview</button>{mode === "djmix" && <><button onClick={() => move(r.track.ref, -1)}>↑</button><button onClick={() => move(r.track.ref, 1)}>↓</button><button onClick={() => setRemoved((x) => [...x, r.track.ref])}>Remove</button></>}</td></tr>)}
    </tbody></table></div>
  </div></div>;
}

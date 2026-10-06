import { useMemo, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { compatibility } from "../analysis/discovery";
import { useApp, useLibraryState } from "./context";
import { LiveMashupWorkspace } from "./LiveMashupWorkspace";

export function ManualMashupWizard({ onClose }: { onClose: () => void }) {
  const app = useApp(); const library = useLibraryState(); const [aRef, setARef] = useState(""); const [bRef, setBRef] = useState(""); const [editing, setEditing] = useState(false);
  const tracks = library.tracks.filter((t) => t.source === "local" && !t.unavailableReason); const a = tracks.find((t) => t.ref === aRef); const b = tracks.find((t) => t.ref === bRef);
  const score = useMemo(() => a && b ? compatibility(a, b, app.preparation.forRef(a.ref), app.preparation.forRef(b.ref)) : null, [a, b, app.preparation]);
  if (editing && a && b) return <div className="modal-backdrop"><div className="modal wide discovery live-workspace"><button className="modal-close" onClick={onClose}>×</button><LiveMashupWorkspace a={a} b={b} manual onBack={() => setEditing(false)} /></div></div>;
  const option = (track: TrackInfo) => <option key={track.ref} value={track.ref}>{track.artist ? `${track.artist} — ` : ""}{track.title}{track.bpm ? ` · ${track.bpm.toFixed(1)} BPM` : ""}{track.key ? ` · ${track.key}` : ""}</option>;
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal mashup-wizard" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={onClose}>×</button><h2><span aria-hidden>🎚</span> Create New Mashup</h2><p className="hint">Choose the two local tracks you want to combine. You can audition, align, arrange, save and render them in the next step.</p><div className="mashup-wizard-picks"><label><b>TRACK A</b><select value={aRef} onChange={(e) => setARef(e.target.value)}><option value="">Choose the first track…</option>{tracks.map(option)}</select></label><span className="mashup-wizard-cross">×</span><label><b>TRACK B</b><select value={bRef} onChange={(e) => setBRef(e.target.value)}><option value="">Choose the second track…</option>{tracks.filter((t) => t.ref !== aRef).map(option)}</select></label></div>{score && <div className="mashup-wizard-score"><b>{score.score}% compatibility</b><span>{score.reasons.join(" · ") || "Ready for manual arrangement"}</span></div>}{!tracks.length && <p className="warn">Add local tracks to your library before creating a mashup.</p>}<div className="modal-actions"><button className="cancel prominent-cancel" onClick={onClose}>✕ Cancel</button><button className="primary create-mashup-confirm" disabled={!a || !b || a.ref === b.ref} onClick={() => setEditing(true)}>🎚 Continue to Manual Mashup</button></div></div></div>;
}

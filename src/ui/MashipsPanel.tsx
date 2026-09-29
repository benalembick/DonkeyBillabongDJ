import { useCallback, useState } from "react";
import { useApp } from "./context";
import { useFrameStore } from "./hooks";
import { LiveMashupWorkspace } from "./LiveMashupWorkspace";

export function useMashipProjects() {
  const { liveMashup } = useApp();
  return useFrameStore(useCallback((cb) => liveMashup.on("change", cb), [liveMashup]), () => liveMashup.getState());
}

export function MashipsView({ kind }: { kind: "auto" | "manual" }) {
  const app = useApp();
  const state = useMashipProjects();
  const [editing, setEditing] = useState<string | null>(null);
  const recipe = state.recipes.find((row) => row.id === editing);
  const a = recipe ? app.library.getByRef(recipe.aRef) : null;
  const b = recipe ? app.library.getByRef(recipe.bRef) : null;
  const recipes = state.recipes.filter((row) => kind === "manual" ? !!row.manual : !row.manual);
  const title = kind === "manual" ? "MANUAL MASHUPS" : "AUTO MASHUPS";

  return <div className="library maships-view">
    <div className="library-controls"><div className="toolbar"><b>{title}</b><span className="hint">{kind === "manual" ? "Saved snapshots from the two-deck performance view" : "Saved mashups created with Live Mashup"}</span></div></div>
    <div className="table-wrap"><table className="tracks"><thead><tr><th>Project</th><th>Track A</th><th>Track B</th><th>BPM</th><th>Key</th><th>Phrase</th><th>Updated</th><th>Actions</th></tr></thead><tbody>
      {recipes.map((row) => { const left=app.library.getByRef(row.aRef),right=app.library.getByRef(row.bRef),available=!!left&&!!right; return <tr key={row.id}>
        <td className="title-cell">{row.name}{row.manual && <span className="source-badge">MANUAL</span>}</td><td>{left ? `${left.artist} — ${left.title}` : "Track unavailable"}</td><td>{right ? `${right.artist} — ${right.title}` : "Track unavailable"}</td><td>{row.targetBpm?.toFixed(1) ?? "—"}</td><td>{row.targetKey ?? "—"}</td><td>{row.manual ? "Saved setup" : `${row.phraseBars} bars`}</td><td>{new Date(row.updatedAt).toLocaleString()}</td><td className="row-actions"><button className="primary" disabled={!available} onClick={() => void app.liveMashup.openRecipe(row.id).then((loaded) => loaded && app.log.info("mashup", `${row.name} loaded to Deck A and Deck B`))}>LOAD TO DECKS</button><button disabled={!available} onClick={() => setEditing(row.id)}>EDIT MASHUP</button><button className="danger" onClick={() => void app.liveMashup.deleteRecipe(row.id)}>Delete</button></td>
      </tr>; })}
      {!recipes.length && <tr><td colSpan={8} className="empty">{kind === "manual" ? "Manual Mashups will appear here after you use SAVE MANUAL MASHUP in the performance view." : "Auto Mashups will appear here after you select SAVE PROJECT in Live Mashup."}</td></tr>}
    </tbody></table></div>
    {recipe && a && b && <div className="modal-backdrop"><div className="modal wide discovery live-workspace"><button className="modal-close" onClick={() => setEditing(null)}>×</button><LiveMashupWorkspace a={a} b={b} recipeId={recipe.id} onBack={() => setEditing(null)}/></div></div>}
  </div>;
}

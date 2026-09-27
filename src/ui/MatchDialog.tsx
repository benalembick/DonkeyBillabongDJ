/**
 * Smart Match details / chooser. Opens when a streaming track can't be loaded
 * automatically (possible, ambiguous, no match) or when the user inspects a match.
 */
import { useEffect, useMemo, useState } from "react";
import type { MatchPrompt } from "../app/matching";
import { describeVersion, type TrackIdentity } from "../matching/identity";
import { BAND_LABEL } from "../matching/scoring";
import type { ResolutionResult, ScoredCandidate } from "../matching/SmartTrackResolver";
import { useApp, useEngineState, useLibraryState } from "./context";

const fmt = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const srcName = (s: string) => (s === "spotify" ? "Spotify" : s === "apple-music" ? "Apple Music" : s === "local" ? "Local Library" : s);

const STATUS_TEXT: Record<ResolutionResult["status"], string> = {
  resolved: "✓ Match found",
  possible: "⚠ Possible match — please confirm",
  ambiguous: "⇆ Multiple matches found — choose the right version",
  unavailable: "✕ No playable match found",
};

export function MatchDialogHost() {
  const { matching } = useApp();
  const [prompt, setPrompt] = useState<MatchPrompt | null>(null);
  useEffect(() => matching.on("prompt", setPrompt), [matching]);
  if (!prompt) return null;
  return <MatchDialog prompt={prompt} onClose={() => setPrompt(null)} onUpdate={(result) => setPrompt({ ...prompt, result })} />;
}

function IdentityBlock({ id, label }: { id: TrackIdentity; label: string }) {
  return (
    <div className="identity">
      <div className="label">{label}</div>
      <div className="id-title">{id.title}</div>
      <div>{id.artists.join(", ") || "—"}</div>
      <div className="hint">
        {id.album || "—"} · {fmt(id.durationMs)} · version: {describeVersion(id.version)}
        {id.isrc ? ` · ISRC ${id.isrc}` : " · no ISRC"}
      </div>
    </div>
  );
}

function MatchDialog({ prompt, onClose, onUpdate }: { prompt: MatchPrompt; onClose: () => void; onUpdate: (r: ResolutionResult) => void }) {
  const app = useApp();
  const { matching, platform } = app;
  const engineState = useEngineState();
  const lib = useLibraryState();
  const { result, deck } = prompt;
  const [query, setQuery] = useState(`${result.requested.artists[0] ?? ""} ${result.requested.title}`.trim());
  const [showDiag, setShowDiag] = useState(false);
  const [remember, setRemember] = useState(true);
  const mapping = matching.resolver.getMapping(result.requested);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Manual search of the local library (all local; nothing leaves the machine).
  const manualScored = useMemo(() => {
    void lib.tracks; // re-run when the library changes
    const ids = new Set(result.candidates.map((c) => c.sourceTrackId));
    return matching.local
      .query(query, 30)
      .filter((t) => !ids.has(t.ref))
      .map((t) => matching.localCandidate(t.ref)!)
      .filter(Boolean);
  }, [query, lib.tracks, matching, result]);

  const pick = async (c: ScoredCandidate | NonNullable<ReturnType<typeof matching.localCandidate>>, loadDeck: number | null) => {
    const updated = await matching.choose(result, c, remember);
    const best = updated.candidates.find((x) => x.sourceTrackId === c.sourceTrackId) ?? updated.best;
    if (loadDeck != null && best) {
      await matching.loadCandidate(loadDeck, updated, best);
      onClose();
    } else {
      onUpdate(updated);
    }
  };

  const searchFolder = async () => {
    const refs = await platform.pickFolder();
    if (!refs.length) return;
    await app.addFiles(refs);
    // Tags are read in the background; re-resolve shortly after so ISRCs count.
    setTimeout(() => onUpdate(matching.resolver.resolveLocal(result.requested)), 1500);
  };

  const deckButtons = (c: ScoredCandidate | NonNullable<ReturnType<typeof matching.localCandidate>>) =>
    engineState.decks.map((d, i) => (
      <button key={i} className={`tiny ${i === 0 ? "deck-a-btn" : "deck-b-btn"} ${deck === i ? "primary" : ""}`} disabled={d.playing || !c.capabilities.canPlay} onClick={() => void pick(c, i)}>
        Load → {String.fromCharCode(65 + i)}
      </button>
    ));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-label="Smart match" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Smart Match</h2>
        <div className={`match-status status-${result.status}`}>
          {STATUS_TEXT[result.status]}
          {result.best && ` · ${result.confidence}% — ${BAND_LABEL[result.band]}`}
          {result.userConfirmed && " · your saved match"}
          {result.fromCache && !result.userConfirmed && " · cached"}
        </div>

        <div className="identity-row">
          <IdentityBlock id={result.requested} label={`REQUESTED · metadata from ${srcName(result.requested.source)}`} />
          {result.best && <IdentityBlock id={result.best.identity} label={`BEST MATCH · audio from ${srcName(result.best.source)}`} />}
        </div>

        {result.candidates.length > 0 && (
          <>
            <h4>Candidates</h4>
            <table className="candidates">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Title / artist</th>
                  <th>Version</th>
                  <th>Length</th>
                  <th>Confidence</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.candidates.slice(0, 8).map((c) => (
                  <tr key={`${c.source}:${c.sourceTrackId}`} className={c === result.best ? "best" : ""}>
                    <td>{srcName(c.source)}</td>
                    <td>
                      <div>{c.identity.title}</div>
                      <div className="hint">{c.identity.artists.join(", ")}</div>
                    </td>
                    <td>{describeVersion(c.identity.version)}</td>
                    <td>{fmt(c.identity.durationMs)}</td>
                    <td>
                      <b>{c.score}%</b>
                      <ul className="reasons">
                        {c.reasons.map((r, i) => (
                          <li key={i} className={r.points > 0 ? "plus" : r.points < 0 ? "minus" : ""}>
                            {r.points > 0 ? `+${r.points}` : r.points < 0 ? r.points : "·"} {r.label}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="row-actions">{deckButtons(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <label className="remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice for this{" "}
          {srcName(result.requested.source)} track
        </label>

        <h4>Find in my library</h4>
        <div className="row">
          <input className="wide" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Artist, title, album…" />
          <button onClick={() => void searchFolder()}>Search another folder…</button>
        </div>
        <div className="manual-results">
          {manualScored.length === 0 && <p className="hint">No other local tracks match "{query}".</p>}
          {manualScored.slice(0, 12).map((c) => (
            <div key={c.sourceTrackId} className="manual-row">
              <span>
                {c.identity.artists.join(", ")} — {c.identity.title} <span className="hint">{fmt(c.identity.durationMs)}</span>
              </span>
              <span className="row-actions">
                <button className="tiny" onClick={() => void pick(c, null)}>Use this match</button>
                {deckButtons(c)}
              </span>
            </div>
          ))}
        </div>

        {result.sourceNotes.length > 0 && (
          <details>
            <summary>DJ streaming services ({result.sourceNotes.length} unavailable)</summary>
            <ul className="hint">
              {result.sourceNotes.map((n) => (
                <li key={n.source}>
                  <b>{n.name}:</b> {n.message}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="row">
          {mapping && (
            <button onClick={() => void matching.forget(result).then(onUpdate)}>
              Clear saved match
            </button>
          )}
          <button onClick={() => setShowDiag((x) => !x)}>{showDiag ? "Hide" : "Show"} diagnostics</button>
          <span className="hint">
            Spotify and Apple Music audio is never used; only files you have (or licensed DJ services) can be loaded.
          </span>
        </div>
        {showDiag && <MatchDiagnostics result={result} />}
      </div>
    </div>
  );
}

export function MatchDiagnostics({ result }: { result: ResolutionResult }) {
  const r = result.requested;
  return (
    <div className="diag-match mono">
      <div>
        {srcName(r.source)} id: {r.sourceTrackId} · ISRC: {r.isrc ?? "—"} · duration: {r.durationMs ?? "—"} ms
      </div>
      <div>
        normalised title: "{r.baseTitle}" · artists: [{r.artistKeys.join(" | ")}] · version: {r.version.kind}
        {r.version.remixer ? ` (${r.version.remixer})` : ""}
      </div>
      <div>
        status: {result.status} · method: {result.method ?? "—"} · cache: {String(result.fromCache)} · user-confirmed: {String(result.userConfirmed)}
      </div>
      {result.candidates.slice(0, 10).map((c) => (
        <div key={c.sourceTrackId}>
          → {c.source} {c.sourceTrackId} · ISRC {c.details.isrc} · title {Math.round(c.details.titleSimilarity * 100)}% · artist{" "}
          {Math.round(c.details.artistSimilarity * 100)}% · Δ{c.details.durationDeltaS != null ? `${c.details.durationDeltaS.toFixed(1)}s` : "?"} · version{" "}
          {c.details.version} · score {c.score}
        </div>
      ))}
    </div>
  );
}

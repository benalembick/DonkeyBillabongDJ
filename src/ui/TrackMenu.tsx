/** Right-click track context menu: shared so every list (library, playlists, queue…) offers the same actions. */
import { useEffect } from "react";
import type { TrackInfo } from "../core/engine/types";
import { useApp, useEngineState, useLibraryState } from "./context";
import { useStemStatus } from "./stemHooks";
import { TrackDiscoveryActions } from "./TrackDiscoveryActions";
import { PlaylistActions } from "./PlaylistPanel";
import { useMenuPosition } from "./useMenuPosition";
import { openStudio } from "./setstudio/nav";
import { fixGridFor } from "./gridEditorStore";
import { useWorkspace } from "./workspaceHooks";

export function TrackMenu({ x, y, track, refs, cached, onInfo, onClose, extra }: {
  x: number;
  y: number;
  track: TrackInfo;
  refs: string[];
  cached: boolean;
  onInfo: () => void;
  onClose: () => void;
  /** Extra actions specific to where this menu was opened from (e.g. "Remove from playlist"), appended after the standard ones. */
  extra?: React.ReactNode;
}) {
  const app = useApp(), { engine, stems, platform, analysis, library, production, log } = app;
  const libraryState = useLibraryState();
  const s = useEngineState();
  const ws = useWorkspace();
  const stemStatus = useStemStatus();
  useEffect(() => {
    const close = (e?: Event) => { if (e?.target instanceof Element && e.target.closest(".modal-backdrop")) return; onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const act = (fn: () => void) => (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onClose();
  };
  const canAnalyse = stemStatus.modelInstalled && platform.kind === "desktop";
  const splitBlocked = track.source !== "local" ? "Only local files can be split into stems" : !stemStatus.available ? stemStatus.reason ?? "STEM separation is unavailable" : null;
  const splitIntoStems = () => {
    window.dispatchEvent(new CustomEvent("dbdj:navigate", { detail: "production" }));
    void production.addLibraryTrackAsStems(track).catch((err) => log.warn("stems", `Couldn't split ${track.title} into stems: ${err instanceof Error ? err.message : String(err)}`));
  };
  const { ref: menuRef, style: menuStyle } = useMenuPosition(x, y);
  return (
    <div ref={menuRef} className="ctx-menu" style={menuStyle} onPointerDown={(e) => e.stopPropagation()}>
      {s.decks.slice(0, ws.deckMode).map((d, i) => (
        <button key={i} className={`ctx-load deck-scope-${"abcd"[i]}`} disabled={d.playing} title={d.playing ? `Deck ${String.fromCharCode(65 + i)} is playing — pause it first` : undefined} onClick={act(() => void engine.loadTrack(i, track))}>
          Load to Deck {String.fromCharCode(65 + i)}{d.track?.ref === track.ref ? " ●" : ""}
        </button>
      ))}
      {(() => {
        const f = ws.focusedDeck, d = s.decks[f];
        return d && f < ws.deckMode ? (
          <button disabled={d.playing} title="The deck with keyboard focus (click a deck, or Alt+1…4). Shortcut: Shift+L" onClick={act(() => void engine.loadTrack(f, track))}>
            Load to focused deck ({String.fromCharCode(65 + f)})
          </button>
        ) : null;
      })()}
      <hr />
      <PlaylistActions refs={refs} onDone={onClose} />
      <TrackDiscoveryActions compact track={track} tracks={libraryState.tracks} />
      <hr />
      <button onClick={act(onInfo)}>Track information</button>
      {track.source === "local" && <button onClick={act(() => void fixGridFor(app, track.ref))} title="Check and correct the beat grid on a deck: BPM, tap tempo, downbeat, phrase start">Edit beat grid…</button>}
      {track.source === "local" && <>
        <button onClick={act(() => openStudio({ tab: "autocue", ref: track.ref }))}>Auto Cue (suggest hot cues)…</button>
        <button onClick={act(() => { const next = refs.length > 1 && refs[1] !== track.ref ? refs[1] : null; openStudio(next ? { tab: "lab", outRef: track.ref, inRef: next } : { tab: "lab", outRef: track.ref }); })}>Transition Lab from this track…</button>
      </>}
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t)))}>Analyse selected</button>
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t), true))}>Reanalyse selected</button>
      <button disabled={!canAnalyse} title={canAnalyse ? "" : stemStatus.reason} onClick={act(() => stems.analyse([track], (r) => platform.readAudio(r)))}>
        Analyse STEMS
      </button>
      <button disabled={!cached} onClick={act(() => void stems.removeCache([track.ref]))}>
        Remove STEM Cache
      </button>
      <button disabled={!!splitBlocked} title={splitBlocked ?? "4 stems (Vocals, Drums, Bass, Instruments) on synchronized tracks at the Production Studio playhead"} onClick={act(splitIntoStems)}>
        Split into stems (Production Studio)
      </button>
      {extra && <><hr />{extra}</>}
    </div>
  );
}

/** Right-click track context menu: shared so every list (library, playlists, queue…) offers the same actions. */
import { useEffect } from "react";
import type { TrackInfo } from "../core/engine/types";
import { useApp, useEngineState, useLibraryState } from "./context";
import { useStemStatus } from "./stemHooks";
import { TrackDiscoveryActions } from "./TrackDiscoveryActions";
import { PlaylistActions } from "./PlaylistPanel";
import { useMenuPosition } from "./useMenuPosition";

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
  const { engine, stems, platform, analysis, library } = useApp();
  const libraryState = useLibraryState();
  const s = useEngineState();
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
  const { ref: menuRef, style: menuStyle } = useMenuPosition(x, y);
  return (
    <div ref={menuRef} className="ctx-menu" style={menuStyle} onPointerDown={(e) => e.stopPropagation()}>
      {s.decks.map((d, i) => (
        <button key={i} disabled={d.playing} onClick={act(() => void engine.loadTrack(i, track))}>
          Load to Deck {String.fromCharCode(65 + i)}
        </button>
      ))}
      <hr />
      <PlaylistActions refs={refs} onDone={onClose} />
      <TrackDiscoveryActions compact track={track} tracks={libraryState.tracks} />
      <hr />
      <button onClick={act(onInfo)}>Track information</button>
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t)))}>Analyse selected</button>
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t), true))}>Reanalyse selected</button>
      <button disabled={!canAnalyse} title={canAnalyse ? "" : stemStatus.reason} onClick={act(() => stems.analyse([track], (r) => platform.readAudio(r)))}>
        Analyse STEMS
      </button>
      <button disabled={!cached} onClick={act(() => void stems.removeCache([track.ref]))}>
        Remove STEM Cache
      </button>
      {extra && <><hr />{extra}</>}
    </div>
  );
}

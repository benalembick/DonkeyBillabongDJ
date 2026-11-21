/** Track-list artwork with a headphone button on hover: previews the track in the headphones only. */
import { useEffect, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { HeadphonePreview, type HeadphonePreviewState } from "../audio/HeadphonePreview";
import { ArtTile } from "./ArtTile";
import { useApp } from "./context";

export function useHeadphonePreview(): HeadphonePreviewState {
  const { preview } = useApp();
  const [s, setS] = useState(preview.state);
  useEffect(() => {
    setS(preview.state);
    return preview.on("change", setS);
  }, [preview]);
  return s;
}

const HeadphonesIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" />
    <rect x="1.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" />
    <rect x="11.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" />
  </svg>
);

export function PreviewArtTile({ track, size }: { track: TrackInfo; size: number }) {
  const { preview, log } = useApp();
  const s = useHeadphonePreview();
  if (track.source !== "local" || track.unavailableReason) return <ArtTile track={track} size={size} />;
  const active = s.ref === track.ref;
  const blocked = !s.available && !active;
  const label = active ? (s.status === "loading" ? "Loading headphone preview… (click to cancel)" : "Stop headphone preview") : blocked ? HeadphonePreview.unavailableReason : "Preview in headphones (decks and master output are not affected)";
  return (
    <span className={`art-preview${active ? " active" : ""}`} style={{ width: size, height: size }}>
      <ArtTile track={track} size={size} />
      <button
        type="button"
        className={`art-preview-btn${blocked ? " blocked" : ""}`}
        aria-label={label}
        aria-disabled={blocked || undefined}
        aria-pressed={active}
        title={label}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          if (blocked) return;
          void preview.toggle(track).catch((err) => log.warn("audio", `Headphone preview: ${err instanceof Error ? err.message : String(err)}`));
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {active && s.status === "loading" ? <span className="art-preview-spin" aria-hidden /> : active ? <span aria-hidden>■</span> : <HeadphonesIcon />}
      </button>
    </span>
  );
}

/** Track artwork: embedded/provider cover when available, else a coloured initial tile. */
import { useState } from "react";
import type { TrackInfo } from "../core/engine/types";

export function artColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 32%)`;
}

export function ArtTile({ track, size = 20 }: { track: Pick<TrackInfo, "title" | "artist" | "album" | "artworkUrl">; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = track.artworkUrl && failed !== track.artworkUrl ? track.artworkUrl : null;
  const style = { width: size, height: size };
  if (url) return <img className="art-tile art-img" src={url} alt="" style={style} loading="lazy" draggable={false} onError={() => setFailed(url)} />;
  return (
    <span className="art-tile" style={{ ...style, background: artColor(track.album || track.artist || track.title), fontSize: Math.round(size * 0.5) }}>
      {(track.artist || track.title).slice(0, 1).toUpperCase()}
    </span>
  );
}

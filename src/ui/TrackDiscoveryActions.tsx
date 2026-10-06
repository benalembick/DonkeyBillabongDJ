import { useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { DiscoveryDialog, type DiscoveryMode } from "./DiscoveryDialog";

export function TrackDiscoveryActions({ track, tracks, compact = false, onDone }: { track: TrackInfo | null | undefined; tracks: TrackInfo[]; compact?: boolean; onDone?: () => void }) {
  const [mode, setMode] = useState<DiscoveryMode | null>(null);
  const open = (next: DiscoveryMode) => { if (track) setMode(next); onDone?.(); };
  return <>
    {!compact && <button disabled={!track} onClick={() => open("matches")}><span aria-hidden>◎</span> FIND MATCHES</button>}
    <button className={compact ? "" : "discovery-action djmix-action"} disabled={!track} onClick={() => open("djmix")}><span aria-hidden>☷</span> {compact ? "Create DJMix from this track" : "CREATE DJMIX"}</button>
    <button className={compact ? "" : "discovery-action mashup-action"} disabled={!track} onClick={() => open("mashup")}><span aria-hidden>⚡</span> {compact ? "Find mashups for this track" : "FIND MASHUPS"}</button>
    {mode && track && <DiscoveryDialog mode={mode} start={track} tracks={tracks} onClose={() => setMode(null)} />}
  </>;
}

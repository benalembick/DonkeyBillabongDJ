/** Track types in Production Studio: icon, colour class and the shared "add track" buttons. */
import type { ProductionTrack } from "../production/types";
import { useApp } from "./context";

export type TrackKind = "audio" | "vocal" | "stem" | "drums" | "synth" | "sampler";

export function trackKind(track: ProductionTrack): TrackKind {
  if (track.kind === "audio") return track.vocal ? "vocal" : track.stem ? "stem" : "audio";
  return track.instrument?.type === "drums" ? "drums" : track.instrument?.type === "sampler" ? "sampler" : "synth";
}
export const TRACK_KIND_LABEL: Record<TrackKind, string> = { audio: "AUDIO", vocal: "VOCAL", stem: "STEM", drums: "DRUMS", synth: "SYNTH", sampler: "SAMPLER" };

export function TrackIcon({ kind }: { kind: TrackKind }) {
  const common = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "track-icon" };
  switch (kind) {
    case "audio": return <svg {...common}><path d="M1.5 8h1M4.5 5.5v5M7.5 2v12M10.5 4.5v7M13.5 6.5v3"/></svg>;
    case "vocal": return <svg {...common}><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5M5.5 15h5"/></svg>;
    case "stem": return <svg {...common}><path d="M2 3.5h12M2 6.5h9M2 9.5h11M2 12.5h7"/></svg>;
    case "drums": return <svg {...common}><ellipse cx="8" cy="6" rx="6" ry="2.3"/><path d="M2 6v5c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V6M10.5 1.5 8.5 5M5 1.5l2 3.5"/></svg>;
    case "synth": return <svg {...common}><rect x="1.5" y="3.5" width="13" height="9" rx="1.2"/><path d="M5.5 3.5v5M8 3.5v5M10.5 3.5v5"/></svg>;
    case "sampler": return <svg {...common}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/></svg>;
  }
}

const ADD: [Exclude<TrackKind, "stem">, string, string][] = [
  ["audio", "AUDIO", "Audio track for files, recordings and samples"],
  ["vocal", "VOCAL", "Vocal track: record takes in the VOCAL tab"],
  ["drums", "DRUMS", "Drum kit with a 16-step sequencer"],
  ["synth", "SYNTH", "Synth played from the piano roll"],
  ["sampler", "SAMPLER", "Sampler track: MIDI notes play the Sampler pads"],
];

/** The same add-track buttons everywhere (browser header and under the track list). */
export function AddTrackButtons({ className = "", onError }: { className?: string; onError?(message: string): void }) {
  const { production } = useApp();
  const add = (kind: Exclude<TrackKind, "stem">) => { try { if (kind === "audio") production.addTrack(); else if (kind === "vocal") production.addVocalTrack(); else production.addInstrumentTrack(kind); } catch (x) { onError?.(x instanceof Error ? x.message : String(x)); } };
  return <div className={`ps-add-tracks ${className}`} role="group" aria-label="Add track">{ADD.map(([kind, label, hint]) => <button key={kind} className={`kind-${kind}`} title={`Add ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`} onClick={() => add(kind)}><TrackIcon kind={kind}/><span>＋ {label}</span></button>)}</div>;
}

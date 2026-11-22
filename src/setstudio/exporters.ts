/**
 * Phase 1 export formats. M3U8 carries order, duration, "Artist - Title" and the file location —
 * nothing else is claimed. The native .dbdjset.json carries the whole set document.
 */
import { migrateSet } from "./SetStore";
import { newId } from "./editor";
import type { DJSet, SetTrackRef } from "./types";

export interface ExportTrack { ref: SetTrackRef; path: string | null }

export function toM3U8(set: DJSet, resolvePath: (r: SetTrackRef) => string | null): { text: string; skipped: number } {
  const lines = ["#EXTM3U", `#PLAYLIST:${set.name.replace(/[\r\n]/g, " ")}`];
  let skipped = 0;
  for (const s of set.mode === "groups" ? set.groups.flatMap((g) => g.tracks.map((track) => ({ track }))) : set.slots) {
    if (!s.track) continue;
    const path = resolvePath(s.track);
    if (!path) { skipped++; continue; }
    const secs = s.track.durationSec ? Math.round(s.track.durationSec) : -1;
    const label = `${s.track.artist ? `${s.track.artist} - ` : ""}${s.track.title}`.replace(/[\r\n]/g, " ");
    lines.push(`#EXTINF:${secs},${label}`, path);
  }
  return { text: lines.join("\n") + "\n", skipped };
}

export const NATIVE_FORMAT = "dbdj-set";
export function toNative(set: DJSet, appVersion: string): string {
  return JSON.stringify({ format: NATIVE_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), app: appVersion, set }, null, 2);
}
/** Parses a native export into a new set (fresh id, so importing never overwrites an existing set). */
export function fromNative(text: string): DJSet {
  const doc = JSON.parse(text);
  if (doc?.format !== NATIVE_FORMAT || !doc.set) throw new Error("Not a Donkey Billabong DJ set file");
  const set = migrateSet(doc.set), now = Date.now();
  return { ...set, id: newId("set"), createdAt: now, updatedAt: now, name: `${set.name} (imported)` };
}

export function safeFileName(name: string): string { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "set"; }

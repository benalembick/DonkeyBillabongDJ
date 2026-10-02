/**
 * Desktop app updates: the status shared by electron/updater.ts and the UI.
 *
 * "auto": the installed Windows app downloads the update in the background and
 * installs it on restart. "manual": macOS (unsigned apps can't self-update) and
 * dev builds — the UI offers the new installer as a browser download.
 */
export type UpdateMode = "auto" | "manual";

export type UpdateStatus =
  | { state: "idle"; current: string }
  | { state: "checking"; current: string }
  | { state: "none"; current: string; checkedAt: number }
  | { state: "available"; current: string; version: string; mode: UpdateMode; downloadUrl: string; notesUrl: string }
  | { state: "downloading"; current: string; version: string; percent: number }
  | { state: "ready"; current: string; version: string }
  | { state: "error"; current: string; message: string };

/** Compare dotted versions ("v0.1.10" > "0.1.9"). Pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export const isNewerVersion = (candidate: string, current: string) => compareVersions(candidate, current) > 0;

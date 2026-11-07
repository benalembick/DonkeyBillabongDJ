/** STEMS status badge shared by every track listing (Collection, Playlists, …) so they read the same way. */
export function StemBadge({ stem, stemProgress, liveStem }: {
  stem?: "complete" | "partial";
  /** Background (library-queue) separation progress 0..1, for a ref currently being analysed off-deck. */
  stemProgress?: number;
  /** This ref is loaded on a deck and actively loading/separating right now — takes priority over the cached index. */
  liveStem?: { status: "loading" | "analysing"; progress: number };
}) {
  if (!stem && stemProgress === undefined && !liveStem) return null;
  return (
    <span
      className={`lib-stem ${liveStem || stemProgress !== undefined ? "partial" : (stem ?? "partial")}`}
      title={
        liveStem ? `${liveStem.status === "loading" ? "Loading cached STEMS" : "Analysing STEMS"} on a deck — ${Math.round(liveStem.progress * 100)}%`
        : stem === "complete" ? "STEMS analysed and cached"
        : stemProgress !== undefined ? `STEMS analysing — ${Math.round(stemProgress * 100)}%`
        : "STEMS partly analysed (not currently running)"
      }
    >
      {liveStem ? `STEMS ${Math.round(liveStem.progress * 100)}%` : stem === "complete" ? "STEMS" : stemProgress !== undefined ? `STEMS ${Math.round(stemProgress * 100)}%` : "STEMS…"}
    </span>
  );
}

/** Stable sort rank for a Stems column: complete > currently analysing (further along first) > cached-partial > not analysed. */
export function stemRank(ref: string, stemIdx: Record<string, "complete" | "partial">, stemProgress: Record<string, number>): number {
  if (stemIdx[ref] === "complete") return 3;
  if (stemProgress[ref] !== undefined) return 2 + stemProgress[ref];
  if (stemIdx[ref] === "partial") return 1;
  return 0;
}

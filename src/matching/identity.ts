/**
 * TrackIdentity: the normalised, source-independent description of a
 * recording. Every metadata provider (Spotify, Apple Music, local tags,
 * playlist imports…) converts its data into this shape; the resolver only
 * ever compares TrackIdentity objects.
 */

export type VersionKind =
  | "original" // no version text, "Original Mix", "Album Version"
  | "remaster"
  | "radio"
  | "extended"
  | "club"
  | "edit"
  | "remix"
  | "live"
  | "acoustic"
  | "instrumental"
  | "dub"
  | "vip"
  | "clean"
  | "explicit"
  | "other";

export interface VersionInfo {
  kind: VersionKind;
  /** Version text as written, e.g. "Club Version", "Calvin Harris Remix" ("" if none). */
  raw: string;
  /** Normalised remixer/mix name for remixes, e.g. "calvin harris". */
  remixer?: string;
  /** True when the title states a version explicitly ("Original Mix") rather than saying nothing. */
  explicitlyStated: boolean;
}

export interface TrackIdentity {
  /** Where this metadata came from ("spotify", "apple-music", "local", …). */
  source: string;
  sourceTrackId: string;
  title: string;
  /** Normalised title without version / featuring text — the main comparison key. */
  baseTitle: string;
  artists: string[];
  /** Normalised artist names (featured artists included). */
  artistKeys: string[];
  album: string;
  durationMs: number | null;
  /** Upper-case, validated ISRC, or null. */
  isrc: string | null;
  version: VersionInfo;
  releaseDate?: string;
  explicit?: boolean;
  artworkUrl?: string;
  bpm?: number | null;
  key?: string | null;
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function normalizeIsrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[-\s]/g, "").toUpperCase();
  return ISRC_RE.test(s) ? s : null;
}

/** Lower-case, strip accents and punctuation, "&" → "and", collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "") // "Y.O.G.A." → "yoga", "don't" → "dont"
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const FEAT_RE = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+?)\s*[)\]]?\s*$/i;

/** Split an artist credit into individual artists: "A, B & C feat. D" → [A, B, C, D]. */
export function splitArtists(credit: string): string[] {
  return credit
    .split(/\s*(?:[,;/&]|\bvs\.?(?=\s)|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing(?=\s)|\bwith(?=\s)|(?<=\s)x(?=\s))\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

interface VersionRule {
  re: RegExp;
  kind: VersionKind;
}

// Order matters: first match wins.
const VERSION_RULES: VersionRule[] = [
  { re: /\bradio\s*(edit|version|mix|cut)\b|\bsingle\s*(version|edit)\b/i, kind: "radio" },
  { re: /\bextended\b/i, kind: "extended" },
  { re: /\bclub\s*(mix|version|edit)?\b/i, kind: "club" },
  { re: /\binstrumental\b/i, kind: "instrumental" },
  { re: /\bacoustic\b/i, kind: "acoustic" },
  { re: /\blive\b/i, kind: "live" },
  { re: /\bdub\b/i, kind: "dub" },
  { re: /\bvip\b/i, kind: "vip" },
  { re: /\b(original|album)\s*(mix|version)\b/i, kind: "original" },
  { re: /\bremaster(ed)?\b/i, kind: "remaster" },
  { re: /\b(remix|rework|bootleg|flip|refix|mix)\b/i, kind: "remix" }, // "X Remix", "Y Mix" (after the specific mixes above)
  { re: /\bclean\b/i, kind: "clean" },
  { re: /\bexplicit\b/i, kind: "explicit" },
  { re: /\bedit\b/i, kind: "edit" },
];

function classifyVersion(text: string): VersionInfo | null {
  for (const r of VERSION_RULES) {
    if (!r.re.test(text)) continue;
    let remixer: string | undefined;
    if (r.kind === "remix") {
      remixer = normalizeText(text.replace(/\b(remix|rework|bootleg|flip|refix|mix)\b.*$/i, "")) || undefined;
    }
    return { kind: r.kind, raw: text.trim(), remixer, explicitlyStated: true };
  }
  return null;
}

/**
 * Split a title into base title, version and featured artists:
 *  "Get Lucky (Radio Edit) [feat. Pharrell Williams]" → base "get lucky", radio, [Pharrell Williams]
 *  "Achy Breaky Heart - Club Version"                 → base "achy breaky heart", club
 *  "One More Time - Remastered 2021"                  → base "one more time", remaster
 */
export function parseTitle(title: string): { baseTitle: string; version: VersionInfo; featured: string[] } {
  let t = title.trim();
  const featured: string[] = [];
  let version: VersionInfo | null = null;

  // Repeatedly peel trailing "(…)", "[…]" or " - …" segments.
  for (let i = 0; i < 4; i++) {
    const m = /^(.*?)(?:\s*[([]([^()[\]]+)[)\]]|\s+[-–—]\s+([^-–—]+))\s*$/.exec(t);
    if (!m) break;
    const seg = (m[2] ?? m[3] ?? "").trim();
    const feat = /^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i.exec(seg);
    if (feat) {
      featured.push(...splitArtists(feat[1]));
    } else {
      const v = classifyVersion(seg);
      if (!v) break; // a segment that isn't version/feat text is part of the title
      version ??= v;
    }
    t = m[1];
  }
  const inlineFeat = FEAT_RE.exec(t);
  if (inlineFeat) {
    featured.push(...splitArtists(inlineFeat[1]));
    t = t.slice(0, inlineFeat.index);
  }
  return {
    baseTitle: normalizeText(t),
    version: version ?? { kind: "original", raw: "", explicitlyStated: false },
    featured,
  };
}

export function buildIdentity(input: {
  source: string;
  sourceTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number | null;
  isrc?: unknown;
  releaseDate?: string;
  explicit?: boolean;
  artworkUrl?: string;
  bpm?: number | null;
  key?: string | null;
}): TrackIdentity {
  const { baseTitle, version, featured } = parseTitle(input.title);
  const artists = [...input.artists.flatMap((a) => splitArtists(a)), ...featured];
  const artistKeys = [...new Set(artists.map(normalizeText).filter(Boolean))];
  return {
    source: input.source,
    sourceTrackId: input.sourceTrackId,
    title: input.title,
    baseTitle,
    artists: [...new Set(artists)],
    artistKeys,
    album: input.album ?? "",
    durationMs: input.durationMs && input.durationMs > 0 ? Math.round(input.durationMs) : null,
    isrc: normalizeIsrc(input.isrc),
    version,
    releaseDate: input.releaseDate,
    explicit: input.explicit,
    artworkUrl: input.artworkUrl,
    bpm: input.bpm ?? null,
    key: input.key ?? null,
  };
}

export type VersionCompatibility = "match" | "compatible" | "uncertain" | "conflict";

const ORIGINAL_LIKE = new Set<VersionKind>(["original", "remaster", "clean", "explicit"]);

/** Are two versions the same recording variant? Never silently treats remix/extended/radio as interchangeable. */
export function compareVersions(a: VersionInfo, b: VersionInfo): VersionCompatibility {
  if (a.kind === b.kind) {
    if (a.kind === "remix") {
      if (!a.remixer || !b.remixer) return "uncertain";
      return a.remixer === b.remixer ? "match" : "conflict";
    }
    return "match";
  }
  const aOrig = ORIGINAL_LIKE.has(a.kind);
  const bOrig = ORIGINAL_LIKE.has(b.kind);
  if (aOrig && bOrig) return "compatible"; // e.g. original vs remaster, clean vs explicit
  // One side says nothing about version while the other names one: can't tell from text.
  if ((aOrig && !a.explicitlyStated) || (bOrig && !b.explicitlyStated)) return "uncertain";
  const edits = new Set<VersionKind>(["radio", "edit"]);
  if (edits.has(a.kind) && edits.has(b.kind)) return "compatible";
  const longs = new Set<VersionKind>(["extended", "club"]);
  if (longs.has(a.kind) && longs.has(b.kind)) return "uncertain";
  return "conflict";
}

export function describeVersion(v: VersionInfo): string {
  return v.raw || (v.kind === "original" ? "no version stated" : v.kind);
}

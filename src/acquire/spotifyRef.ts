/**
 * Parse pasted Spotify references: open.spotify.com links (with or without /intl-xx/ and
 * query strings), spotify: URIs and bare playlist/track ids. Anything else is rejected with a
 * message the user can act on.
 */
export type SpotifyRef = { type: "playlist" | "track"; id: string } | { type: "liked"; id: "__liked__" };

export type SpotifyRefResult = { ok: true; ref: SpotifyRef } | { ok: false; error: string };

const ID = /^[A-Za-z0-9]{22}$/;
const UNSUPPORTED: Record<string, string> = {
  album: "Albums aren't supported yet — paste a playlist or track link, or add the album's tracks to a playlist on Spotify.",
  artist: "Artist pages aren't supported — paste a playlist or track link.",
  episode: "Podcast episodes can't be prepared for DJ playback.",
  show: "Podcasts can't be prepared for DJ playback.",
  user: "That's a Spotify profile link — open one of the user's playlists and copy its link instead.",
};

export function parseSpotifyRef(input: string): SpotifyRefResult {
  const s = input.trim();
  if (!s) return { ok: false, error: "Paste a Spotify playlist or track link." };
  if (/^(liked|liked songs|spotify:collection(:tracks)?)$/i.test(s) || /open\.spotify\.com\/collection\/tracks/i.test(s)) return { ok: true, ref: { type: "liked", id: "__liked__" } };

  let type: string | undefined;
  let id: string | undefined;
  const uri = /^spotify:(?:user:[^:]+:)?([a-z]+):([A-Za-z0-9]+)$/i.exec(s);
  if (uri) {
    type = uri[1].toLowerCase();
    id = uri[2];
  } else if (/^https?:\/\//i.test(s) || /^open\.spotify\.com\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    } catch {
      return { ok: false, error: "That doesn't look like a valid link." };
    }
    if (url.hostname === "spotify.link" || url.hostname.endsWith(".page.link")) {
      return { ok: false, error: "Short share links (spotify.link) can't be read offline — open it in a browser and copy the full open.spotify.com link." };
    }
    if (url.hostname !== "open.spotify.com" && url.hostname !== "play.spotify.com") return { ok: false, error: "Only open.spotify.com links are supported." };
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("intl-")) parts.shift();
    if (parts[0] === "embed") parts.shift();
    if (parts[0] === "user" && parts[2] === "playlist") parts.splice(0, 2);
    [type, id] = parts;
  } else if (ID.test(s)) {
    return { ok: false, error: "A bare id is ambiguous — paste the full link (open.spotify.com/playlist/… or /track/…)." };
  } else {
    return { ok: false, error: "Paste an open.spotify.com playlist or track link, or a spotify: URI." };
  }

  if (!type || !id) return { ok: false, error: "That Spotify link doesn't point to a playlist or track." };
  if (UNSUPPORTED[type]) return { ok: false, error: UNSUPPORTED[type] };
  if (type !== "playlist" && type !== "track") return { ok: false, error: `Spotify ${type} links aren't supported.` };
  if (!ID.test(id)) return { ok: false, error: "That Spotify id isn't valid (expected 22 letters and digits)." };
  return { ok: true, ref: { type, id } };
}

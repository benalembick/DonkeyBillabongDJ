/** IPC surface for streaming providers. Credentials never leave the main process. */
import { ipcMain } from "electron";
import type { StreamingConfig, StreamingProviderId } from "../../src/providers/streamingTypes";
import { createDesktopAppleMusic } from "./appleMusic";
import { createDesktopSpotify } from "./spotify";
import { readPlaylistViaSpotdl } from "../acquire/ipc";

const clients = {
  spotify: createDesktopSpotify(),
  "apple-music": createDesktopAppleMusic(),
};
// Playlists Spotify won't return to this app (by other people) are read with the installed spotDL.
clients.spotify.setPlaylistFallback(readPlaylistViaSpotdl);

function client(id: unknown) {
  const c = clients[id as StreamingProviderId];
  if (!c) throw new Error(`Unknown provider ${String(id)}`);
  return c;
}

/** Only well-formed playlist / track / liked references reach the Spotify client. */
function validRef(raw: unknown): { type: "playlist" | "track" | "liked"; id: string } {
  const r = raw as { type?: unknown; id?: unknown } | null;
  if (r?.type === "liked") return { type: "liked", id: "__liked__" };
  if ((r?.type === "playlist" || r?.type === "track") && typeof r.id === "string" && /^[A-Za-z0-9]{22}$/.test(r.id)) return { type: r.type, id: r.id };
  throw new Error("Invalid Spotify reference");
}

export function registerStreamingIpc(): void {
  ipcMain.handle("dbdj:stream:status", (_e, id) => client(id).status());
  ipcMain.handle("dbdj:stream:configure", async (_e, id, cfg: StreamingConfig) => {
    await client(id).configure(cfg as never);
    return client(id).status();
  });
  ipcMain.handle("dbdj:stream:connect", (_e, id) => client(id).connect());
  ipcMain.handle("dbdj:stream:disconnect", async (_e, id, forget: boolean) => {
    await client(id).disconnect(!!forget);
    return client(id).status();
  });
  ipcMain.handle("dbdj:stream:playlists", (_e, id) => client(id).playlists());
  ipcMain.handle("dbdj:stream:playlistTracks", (_e, id, playlistId) => client(id).playlistTracks(String(playlistId)));
  ipcMain.handle("dbdj:stream:search", (_e, id, q) => client(id).search(String(q)));
  ipcMain.handle("dbdj:stream:spotifySource", (_e, ref: unknown) => clients.spotify.resolveSource(validRef(ref)));
}

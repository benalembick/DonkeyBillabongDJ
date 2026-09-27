/** IPC surface for streaming providers. Credentials never leave the main process. */
import { ipcMain } from "electron";
import type { StreamingConfig, StreamingProviderId } from "../../src/providers/streamingTypes";
import { createDesktopAppleMusic } from "./appleMusic";
import { createDesktopSpotify } from "./spotify";

const clients = {
  spotify: createDesktopSpotify(),
  "apple-music": createDesktopAppleMusic(),
};

function client(id: unknown) {
  const c = clients[id as StreamingProviderId];
  if (!c) throw new Error(`Unknown provider ${String(id)}`);
  return c;
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
}

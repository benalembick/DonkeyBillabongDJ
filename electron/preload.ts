import { contextBridge, ipcRenderer, webUtils } from "electron";

/** The only privileged surface exposed to the renderer. Mirrors `DesktopBridge` in src/platform. */
contextBridge.exposeInMainWorld("dbdjDesktop", {
  platform: process.platform,
  openAudioFiles: (): Promise<string[]> => ipcRenderer.invoke("dbdj:openAudioFiles"),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke("dbdj:openFolder"),
  scanFolder: (dir: string) => ipcRenderer.invoke("dbdj:scanFolder", dir),
  expandPaths: (paths: string[]) => ipcRenderer.invoke("dbdj:expandPaths", paths),
  /** Filesystem path of a File dropped from Explorer/Finder ("" if none). */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  readAudioFile: (p: string): Promise<ArrayBuffer> => ipcRenderer.invoke("dbdj:readAudioFile", p),
  openMappingFile: (): Promise<string | null> => ipcRenderer.invoke("dbdj:openMappingFile"),
  readTextFile: (p: string): Promise<string> => ipcRenderer.invoke("dbdj:readTextFile", p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("dbdj:openExternal", url),
  streaming: {
    status: (id: string) => ipcRenderer.invoke("dbdj:stream:status", id),
    configure: (id: string, cfg: unknown) => ipcRenderer.invoke("dbdj:stream:configure", id, cfg),
    connect: (id: string) => ipcRenderer.invoke("dbdj:stream:connect", id),
    disconnect: (id: string, forget: boolean) => ipcRenderer.invoke("dbdj:stream:disconnect", id, forget),
    playlists: (id: string) => ipcRenderer.invoke("dbdj:stream:playlists", id),
    playlistTracks: (id: string, playlistId: string) => ipcRenderer.invoke("dbdj:stream:playlistTracks", id, playlistId),
    search: (id: string, q: string) => ipcRenderer.invoke("dbdj:stream:search", id, q),
  },
});

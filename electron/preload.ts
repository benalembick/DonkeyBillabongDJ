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
  readTags: (paths: string[]) => ipcRenderer.invoke("dbdj:tags:read", paths),
  db: {
    loadTracks: () => ipcRenderer.invoke("dbdj:library:load"),
    upsertTracks: (rows: unknown[]) => ipcRenderer.invoke("dbdj:library:upsert", rows),
    removeTracks: (refs: string[]) => ipcRenderer.invoke("dbdj:library:remove", refs),
    loadPlaylists: () => ipcRenderer.invoke("dbdj:playlists:load"),
    savePlaylist: (p: unknown) => ipcRenderer.invoke("dbdj:playlists:save", p),
    removePlaylist: (id: string) => ipcRenderer.invoke("dbdj:playlists:remove", id),
    loadMappings: () => ipcRenderer.invoke("dbdj:mappings:load"),
    putMapping: (row: unknown) => ipcRenderer.invoke("dbdj:mappings:put", row),
    removeMapping: (key: string) => ipcRenderer.invoke("dbdj:mappings:remove", key),
  },
  stems: {
    status: () => ipcRenderer.invoke("dbdj:stems:status"),
    downloadModel: () => ipcRenderer.invoke("dbdj:stems:downloadModel"),
    onDownloadProgress: (cb: (p: { received: number; total: number }) => void) => {
      const h = (_e: unknown, p: { received: number; total: number }) => cb(p);
      ipcRenderer.on("dbdj:stems:downloadProgress", h);
      return () => ipcRenderer.removeListener("dbdj:stems:downloadProgress", h);
    },
    onWorkerExit: (cb: () => void) => {
      ipcRenderer.on("dbdj:stems:workerExit", cb);
      return () => ipcRenderer.removeListener("dbdj:stems:workerExit", cb);
    },
    /** Asks main for a worker channel; the port arrives as a window "message" (see StemService). */
    connect: () => ipcRenderer.invoke("dbdj:stems:connect"),
    fileKey: (p: string) => ipcRenderer.invoke("dbdj:stems:fileKey", p),
    index: () => ipcRenderer.invoke("dbdj:stems:index"),
    setIndex: (ref: string, key: string | null) => ipcRenderer.invoke("dbdj:stems:setIndex", ref, key),
    remove: (refs: string[]) => ipcRenderer.invoke("dbdj:stems:remove", refs),
    cacheInfo: () => ipcRenderer.invoke("dbdj:stems:cacheInfo"),
    clearCache: () => ipcRenderer.invoke("dbdj:stems:clearCache"),
    setConfig: (patch: unknown) => ipcRenderer.invoke("dbdj:stems:setConfig", patch),
    pickCacheDir: () => ipcRenderer.invoke("dbdj:stems:pickCacheDir"),
  },
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

// The stem worker's MessagePort arrives here and is forwarded to the page.
ipcRenderer.on("dbdj:stems:port", (e) => {
  window.postMessage("dbdj:stems:port", "*", e.ports);
});

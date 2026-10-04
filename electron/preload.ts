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
  transcodeAudio: (data: ArrayBuffer): Promise<ArrayBuffer | null> => ipcRenderer.invoke("dbdj:audio:transcode", data),
  requestMicrophone: (): Promise<{ granted: boolean; status: string }> => ipcRenderer.invoke("dbdj:media:microphone"),
  saveMashupFile: (name: string, data: ArrayBuffer): Promise<{ ref: string; name: string } | null> => ipcRenderer.invoke("dbdj:mashup:saveFile", name, data),
  openMappingFile: (): Promise<string | null> => ipcRenderer.invoke("dbdj:openMappingFile"),
  readTextFile: (p: string): Promise<string> => ipcRenderer.invoke("dbdj:readTextFile", p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("dbdj:openExternal", url),
  readTags: (paths: string[]) => ipcRenderer.invoke("dbdj:tags:read", paths),
  db: {
    loadPreparation: () => ipcRenderer.invoke("dbdj:preparation:load"),
    savePreparation: (record: unknown) => ipcRenderer.invoke("dbdj:preparation:save", record),
    loadWaveform: (trackId: string) => ipcRenderer.invoke("dbdj:preparation:waveform", trackId),
    saveWaveform: (record: unknown) => ipcRenderer.invoke("dbdj:preparation:waveform-save", record),
    loadMashupRecipes: () => ipcRenderer.invoke("dbdj:mashups:load"),
    saveMashupRecipe: (record: unknown) => ipcRenderer.invoke("dbdj:mashups:save", record),
    removeMashupRecipe: (id: string) => ipcRenderer.invoke("dbdj:mashups:remove", id),
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
    revealLog: () => ipcRenderer.invoke("dbdj:stems:revealLog"),
    renderData: (ref: string) => ipcRenderer.invoke("dbdj:stems:renderData", ref),
  },
  lighting: {
    load: () => ipcRenderer.invoke("dbdj:lighting:load"),
    save: (cfg: unknown) => ipcRenderer.invoke("dbdj:lighting:save", cfg),
    configure: (io: unknown, exit: unknown) => ipcRenderer.invoke("dbdj:dmx:configure", io, exit),
    frame: (universe: number, data: Uint8Array) => ipcRenderer.send("dbdj:dmx:frame", universe, data),
    onStatus: (cb: (universe: number, status: unknown) => void) => {
      const h = (_e: unknown, u: number, s: unknown) => cb(u, s);
      ipcRenderer.on("dbdj:dmx:status", h);
      return () => ipcRenderer.removeListener("dbdj:dmx:status", h);
    },
    onInput: (cb: (universe: number, data: Uint8Array) => void) => {
      const h = (_e: unknown, u: number, d: Uint8Array) => cb(u, d);
      ipcRenderer.on("dbdj:dmx:input", h);
      return () => ipcRenderer.removeListener("dbdj:dmx:input", h);
    },
  },
  acquire: {
    config: () => ipcRenderer.invoke("dbdj:acquire:config"),
    pickDestination: () => ipcRenderer.invoke("dbdj:acquire:pickDestination"),
    pickWatchFolder: () => ipcRenderer.invoke("dbdj:acquire:pickWatchFolder"),
    setWatching: (on: boolean) => ipcRenderer.invoke("dbdj:acquire:setWatching", on),
    rescan: () => ipcRenderer.invoke("dbdj:acquire:rescan"),
    download: (req: unknown) => ipcRenderer.invoke("dbdj:acquire:download", req),
    toolStatus: (id: string, force?: boolean) => ipcRenderer.invoke("dbdj:acquire:toolStatus", id, force),
    cancelDownload: (id: string) => ipcRenderer.invoke("dbdj:acquire:cancelDownload", id),
    probe: (p: string) => ipcRenderer.invoke("dbdj:acquire:probe", p),
    loadJobs: () => ipcRenderer.invoke("dbdj:acquire:jobs:load"),
    saveJob: (job: unknown) => ipcRenderer.invoke("dbdj:acquire:jobs:save", job),
    removeJob: (id: string) => ipcRenderer.invoke("dbdj:acquire:jobs:remove", id),
    onFile: (cb: (f: unknown) => void) => {
      const h = (_e: unknown, f: unknown) => cb(f);
      ipcRenderer.on("dbdj:acquire:file", h);
      return () => ipcRenderer.removeListener("dbdj:acquire:file", h);
    },
    onWatchStatus: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("dbdj:acquire:watchStatus", h);
      return () => ipcRenderer.removeListener("dbdj:acquire:watchStatus", h);
    },
    onProgress: (cb: (id: string, p: number) => void) => {
      const h = (_e: unknown, id: string, p: number) => cb(id, p);
      ipcRenderer.on("dbdj:acquire:progress", h);
      return () => ipcRenderer.removeListener("dbdj:acquire:progress", h);
    },
  },
  updates: {
    status: () => ipcRenderer.invoke("dbdj:update:status"),
    check: () => ipcRenderer.invoke("dbdj:update:check"),
    download: () => ipcRenderer.invoke("dbdj:update:download"),
    openNotes: () => ipcRenderer.invoke("dbdj:update:notes"),
    install: () => ipcRenderer.invoke("dbdj:update:install"),
    onStatus: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("dbdj:update:status", h);
      return () => ipcRenderer.removeListener("dbdj:update:status", h);
    },
  },
  streaming: {
    status: (id: string) => ipcRenderer.invoke("dbdj:stream:status", id),
    configure: (id: string, cfg: unknown) => ipcRenderer.invoke("dbdj:stream:configure", id, cfg),
    connect: (id: string) => ipcRenderer.invoke("dbdj:stream:connect", id),
    disconnect: (id: string, forget: boolean) => ipcRenderer.invoke("dbdj:stream:disconnect", id, forget),
    playlists: (id: string) => ipcRenderer.invoke("dbdj:stream:playlists", id),
    playlistTracks: (id: string, playlistId: string) => ipcRenderer.invoke("dbdj:stream:playlistTracks", id, playlistId),
    search: (id: string, q: string) => ipcRenderer.invoke("dbdj:stream:search", id, q),
    spotifySource: (ref: unknown) => ipcRenderer.invoke("dbdj:stream:spotifySource", ref),
  },
});

// The stem worker's MessagePort arrives here and is forwarded to the page.
ipcRenderer.on("dbdj:stems:port", (e) => {
  window.postMessage("dbdj:stems:port", "*", e.ports);
});

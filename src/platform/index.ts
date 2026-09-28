import type {
  ProviderStatus,
  StreamingConfig,
  StreamingPlaylist,
  StreamingProviderId,
  StreamingTrack,
} from "../providers/streamingTypes";
import { createBrowserStreaming } from "../providers/browser/browserStreaming";
import type { TrackInfo } from "../core/engine/types";
import type { TagResult } from "../library/tags";
import type { MappingStorage, ResolutionMapping } from "../matching/SmartTrackResolver";
import type { SourceId } from "../matching/sources";
import { LocalStorageStore } from "../providers/web";
import type { StemBridge } from "../stems/StemService";
import { BrowserLibrary, browserFileRef, coverDataUrl } from "../library/BrowserLibrary";
import { BrowserPreparation } from "../preparation/BrowserPreparation";
import type { PreparationPersistence, TrackPreparation, WaveformRecord } from "../preparation/types";

/**
 * Platform abstraction: desktop (Electron, full filesystem access) vs browser
 * (File System pickers only). Everything above this layer is platform-neutral.
 */

export interface ScannedFile {
  path: string;
  name: string;
  size: number;
}

/** Main-process streaming API (credentials stay in the main process). */
export interface StreamingBridge {
  status(id: StreamingProviderId): Promise<ProviderStatus>;
  configure(id: StreamingProviderId, cfg: StreamingConfig): Promise<ProviderStatus>;
  connect(id: StreamingProviderId): Promise<ProviderStatus>;
  disconnect(id: StreamingProviderId, forget: boolean): Promise<ProviderStatus>;
  playlists(id: StreamingProviderId): Promise<StreamingPlaylist[]>;
  playlistTracks(id: StreamingProviderId, playlistId: string): Promise<StreamingTrack[]>;
  search(id: StreamingProviderId, q: string): Promise<StreamingTrack[]>;
}

/** Shape exposed by electron/preload.ts as window.dbdjDesktop. */
export interface DesktopBridge {
  platform: string;
  openAudioFiles(): Promise<string[]>;
  openFolder(): Promise<string | null>;
  scanFolder(dir: string): Promise<ScannedFile[]>;
  expandPaths(paths: string[]): Promise<ScannedFile[]>;
  getPathForFile(file: File): string;
  readAudioFile(path: string): Promise<ArrayBuffer>;
  openMappingFile(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  readTags(paths: string[]): Promise<TagResult[]>;
  db: {
    loadPreparation(): Promise<TrackPreparation[]>;
    savePreparation(record: TrackPreparation): Promise<void>;
    loadWaveform(trackId: string): Promise<WaveformRecord | null>;
    saveWaveform(record: WaveformRecord): Promise<void>;
    loadTracks(): Promise<TrackRow[]>;
    upsertTracks(rows: TrackRow[]): Promise<void>;
    removeTracks(refs: string[]): Promise<void>;
    loadPlaylists(): Promise<PlaylistRow[]>;
    savePlaylist(p: PlaylistRow): Promise<void>;
    removePlaylist(id: string): Promise<void>;
    loadMappings(): Promise<MappingRow[]>;
    putMapping(row: MappingRow): Promise<void>;
    removeMapping(key: string): Promise<void>;
  };
  streaming: StreamingBridge;
  stems: StemBridge;
}

/** Row shapes of the desktop SQLite database (electron/library/db.ts). */
export interface TrackRow {
  ref: string;
  title: string;
  artist: string;
  album: string;
  genre: string | null;
  year: number | null;
  duration_ms: number | null;
  isrc: string | null;
  bpm: number | null;
  key: string | null;
  tags_read: number;
  added_at: number;
  rating?: number;
  /** Cached cover art URL (dbdj-art://…). */
  artwork?: string | null;
  artwork_read?: number;
}
export interface PlaylistRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  refs: string[];
}
export interface MappingRow {
  key: string;
  metadata_source: string;
  metadata_track_id: string;
  audio_source: string;
  audio_track_id: string;
  isrc: string | null;
  confidence: number;
  method: string;
  user_confirmed: number;
  resolved_at: number;
}

export interface PlaylistPersistence {
  load(): Promise<PlaylistRow[]>;
  save(p: PlaylistRow): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Browser: playlists in localStorage (track files must be re-added after a reload, but names/order survive). */
class LocalStoragePlaylists implements PlaylistPersistence {
  private read(): Record<string, PlaylistRow> { return JSON.parse(localStorage.getItem("dbdj.playlists.all") ?? "{}"); }
  async load(): Promise<PlaylistRow[]> {
    return Object.values(this.read()).sort((a, b) => a.created_at - b.created_at);
  }
  async save(p: PlaylistRow): Promise<void> {
    const all = this.read();
    all[p.id] = { ...p, updated_at: Date.now() };
    localStorage.setItem("dbdj.playlists.all", JSON.stringify(all));
  }
  async remove(id: string): Promise<void> {
    const all = this.read();
    delete all[id];
    localStorage.setItem("dbdj.playlists.all", JSON.stringify(all));
  }
}

/** Persistent local library (desktop only; browser file references don't survive a reload). */
export interface LibraryPersistence {
  load(): Promise<TrackInfo[]>;
  save(tracks: TrackInfo[]): Promise<void>;
  remove(refs: string[]): Promise<void>;
}

declare global {
  interface Window {
    dbdjDesktop?: DesktopBridge;
  }
}

/** A reference to an audio file the platform can read later. */
export interface AudioFileRef {
  ref: string;
  name: string;
}

export interface Platform {
  preparation: PreparationPersistence;
  kind: "desktop" | "browser";
  os: string;
  pickAudioFiles(): Promise<AudioFileRef[]>;
  pickFolder(): Promise<AudioFileRef[]>;
  /** Files/folders dropped from the OS file manager → audio file refs (folders are scanned on desktop). */
  refsFromDrop(files: File[]): Promise<AudioFileRef[]>;
  readAudio(ref: string): Promise<ArrayBuffer>;
  pickTextFile(accept: string): Promise<{ name: string; text: string } | null>;
  openExternal(url: string): void;
  /** Null in browser mode: streaming accounts need the desktop app. */
  streaming: StreamingBridge | null;
  /** Read embedded tags (ISRC, duration, BPM, key…) for local refs. */
  readTags(refs: string[]): Promise<TagResult[]>;
  library: LibraryPersistence | null;
  /** Playlists: SQLite on desktop, localStorage in the browser. */
  playlists: PlaylistPersistence;
  mappingStorage: MappingStorage;
}

function rowToTrack(r: TrackRow): TrackInfo {
  return {
    ref: r.ref,
    title: r.title,
    artist: r.artist,
    album: r.album,
    source: "local",
    bpm: r.bpm,
    key: r.key,
    durationMs: r.duration_ms ?? undefined,
    isrc: r.isrc,
    genre: r.genre ?? undefined,
    year: r.year ?? undefined,
    tagsRead: !!r.tags_read,
    artworkRead: !!r.artwork_read,
    rating: r.rating ?? 0,
    addedAt: r.added_at,
    artworkUrl: r.artwork ?? undefined,
  };
}

function trackToRow(t: TrackInfo): TrackRow {
  return {
    ref: t.ref,
    title: t.title,
    artist: t.artist,
    album: t.album,
    genre: t.genre ?? null,
    year: t.year ?? null,
    duration_ms: t.durationMs ?? null,
    isrc: t.isrc ?? null,
    bpm: t.bpm,
    key: t.key,
    tags_read: t.tagsRead ? 1 : 0,
    artwork_read: t.artworkRead ? 1 : 0,
    added_at: t.addedAt ?? Date.now(),
    rating: t.rating ?? 0,
    artwork: t.artworkUrl?.startsWith("dbdj-art://") ? t.artworkUrl : null,
  };
}

const rowToMapping = (r: MappingRow): ResolutionMapping => ({
  key: r.key,
  metadataSource: r.metadata_source,
  metadataTrackId: r.metadata_track_id,
  audioSource: r.audio_source as SourceId,
  audioTrackId: r.audio_track_id,
  isrc: r.isrc,
  confidence: r.confidence,
  method: r.method as ResolutionMapping["method"],
  userConfirmed: !!r.user_confirmed,
  resolvedAt: r.resolved_at,
});

const mappingToRow = (m: ResolutionMapping): MappingRow => ({
  key: m.key,
  metadata_source: m.metadataSource,
  metadata_track_id: m.metadataTrackId,
  audio_source: m.audioSource,
  audio_track_id: m.audioTrackId,
  isrc: m.isrc,
  confidence: m.confidence,
  method: m.method,
  user_confirmed: m.userConfirmed ? 1 : 0,
  resolved_at: m.resolvedAt,
});

/** Browser: mappings in localStorage (desktop uses SQLite). */
class LocalStorageMappings implements MappingStorage {
  private store = new LocalStorageStore("dbdj.matching.");
  async loadAll(): Promise<ResolutionMapping[]> {
    return Object.values((await this.store.get<Record<string, ResolutionMapping>>("mappings")) ?? {});
  }
  async put(m: ResolutionMapping): Promise<void> {
    const all = (await this.store.get<Record<string, ResolutionMapping>>("mappings")) ?? {};
    all[m.key] = m;
    await this.store.set("mappings", all);
  }
  async remove(key: string): Promise<void> {
    const all = (await this.store.get<Record<string, ResolutionMapping>>("mappings")) ?? {};
    delete all[key];
    await this.store.set("mappings", all);
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const AUDIO_NAME = /\.(mp3|wav|m4a|aac|mp4|flac|ogg|opus|aiff?)$/i;

class DesktopPlatform implements Platform {
  readonly kind = "desktop" as const;
  readonly os: string;
  private readonly bridge: DesktopBridge;
  constructor(bridge: DesktopBridge) {
    this.bridge = bridge;
    this.os = bridge.platform;
  }
  async pickAudioFiles(): Promise<AudioFileRef[]> {
    const paths = await this.bridge.openAudioFiles();
    return paths.map((p) => ({ ref: p, name: basename(p) }));
  }
  async pickFolder(): Promise<AudioFileRef[]> {
    const dir = await this.bridge.openFolder();
    if (!dir) return [];
    const files = await this.bridge.scanFolder(dir);
    return files.map((f) => ({ ref: f.path, name: f.name }));
  }
  async refsFromDrop(files: File[]): Promise<AudioFileRef[]> {
    const paths = files.map((f) => this.bridge.getPathForFile(f)).filter(Boolean);
    if (paths.length === 0) return [];
    const scanned = await this.bridge.expandPaths(paths);
    return scanned.map((f) => ({ ref: f.path, name: f.name }));
  }
  readAudio(ref: string): Promise<ArrayBuffer> {
    return this.bridge.readAudioFile(ref);
  }
  openExternal(url: string): void {
    void this.bridge.openExternal(url).catch(() => undefined);
  }
  get streaming(): StreamingBridge {
    return this.bridge.streaming;
  }
  readTags(refs: string[]): Promise<TagResult[]> {
    return this.bridge.readTags(refs);
  }
  get library(): LibraryPersistence {
    const db = this.bridge.db;
    return {
      load: async () => (await db.loadTracks()).map(rowToTrack),
      save: (tracks) => db.upsertTracks(tracks.filter((t) => t.source === "local").map(trackToRow)),
      remove: (refs) => db.removeTracks(refs),
    };
  }
  get playlists(): PlaylistPersistence {
    const db = this.bridge.db;
    return { load: () => db.loadPlaylists(), save: (p) => db.savePlaylist(p), remove: (id) => db.removePlaylist(id) };
  }
  get preparation(): PreparationPersistence {
    const db = this.bridge.db;
    return { list: () => db.loadPreparation(), save: (r) => db.savePreparation(r), loadWaveform: (id) => db.loadWaveform(id), saveWaveform: (r) => db.saveWaveform(r) };
  }
  get mappingStorage(): MappingStorage {
    const db = this.bridge.db;
    return {
      loadAll: async () => (await db.loadMappings()).map(rowToMapping),
      put: (m) => db.putMapping(mappingToRow(m)),
      remove: (key) => db.removeMapping(key),
    };
  }
  async pickTextFile(): Promise<{ name: string; text: string } | null> {
    const p = await this.bridge.openMappingFile();
    if (!p) return null;
    return { name: basename(p), text: await this.bridge.readTextFile(p) };
  }
}

const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.mp4,.flac,.ogg,.opus,.aif,.aiff,audio/*";

class BrowserPlatform implements Platform {
  readonly kind = "browser" as const;
  readonly os = typeof navigator !== "undefined" ? navigator.platform : "unknown";
  private files = new Map<string, File>();

  private pick(opts: { accept?: string; multiple?: boolean; directory?: boolean }): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (opts.accept) input.accept = opts.accept;
      input.multiple = !!opts.multiple;
      if (opts.directory) input.setAttribute("webkitdirectory", "");
      input.onchange = () => resolve(input.files ? [...input.files] : []);
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  readonly streaming: StreamingBridge = createBrowserStreaming();
  readonly library = new BrowserLibrary();
  readonly preparation = new BrowserPreparation();
  readonly mappingStorage: MappingStorage = new LocalStorageMappings();
  readonly playlists: PlaylistPersistence = new LocalStoragePlaylists();

  async readTags(refs: string[]): Promise<TagResult[]> {
    const { parseBlob, selectCover } = await import("music-metadata");
    const out: TagResult[] = [];
    for (const ref of refs) {
      const f = this.files.get(ref);
      if (!f) {
        out.push({ ref, ok: false, error: "file no longer available" });
        continue;
      }
      try {
        const m = await parseBlob(f, { skipCovers: false, duration: false });
        const c = m.common;
        const cover = selectCover(c.picture);
        out.push({
          artworkUrl: cover ? await coverDataUrl(cover.data, cover.format) : undefined,
          ref,
          ok: true,
          title: c.title,
          artist: c.artists?.length ? c.artists.join(", ") : c.artist,
          album: c.album,
          isrc: c.isrc?.[0],
          durationMs: m.format.duration ? Math.round(m.format.duration * 1000) : undefined,
          bpm: c.bpm,
          key: c.key,
          genre: c.genre?.[0],
          year: c.year,
        });
      } catch (err) {
        out.push({ ref, ok: false, error: String(err) });
      }
    }
    return out;
  }

  openExternal(url: string): void {
    window.open(url, "_blank", "noopener");
  }

  async refsFromDrop(files: File[]): Promise<AudioFileRef[]> {
    return this.register(files);
  }

  private register(files: File[]): AudioFileRef[] {
    return files
      .filter((f) => AUDIO_NAME.test(f.name))
      .map((f) => {
        const ref = browserFileRef(f);
        this.files.set(ref, f);
        return { ref, name: f.name };
      });
  }

  async pickAudioFiles(): Promise<AudioFileRef[]> {
    return this.register(await this.pick({ accept: AUDIO_ACCEPT, multiple: true }));
  }
  async pickFolder(): Promise<AudioFileRef[]> {
    return this.register(await this.pick({ directory: true }));
  }
  async readAudio(ref: string): Promise<ArrayBuffer> {
    const f = this.files.get(ref);
    if (!f) throw new Error("File is no longer available in this browser session");
    return f.arrayBuffer();
  }
  async pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
    const [f] = await this.pick({ accept });
    return f ? { name: f.name, text: await f.text() } : null;
  }
}

export function createPlatform(): Platform {
  if (typeof window !== "undefined" && window.dbdjDesktop) return new DesktopPlatform(window.dbdjDesktop);
  return new BrowserPlatform();
}

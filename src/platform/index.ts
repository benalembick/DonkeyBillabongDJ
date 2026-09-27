import type {
  ProviderStatus,
  StreamingConfig,
  StreamingPlaylist,
  StreamingProviderId,
  StreamingTrack,
} from "../providers/streamingTypes";
import { createBrowserStreaming } from "../providers/browser/browserStreaming";

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
  streaming: StreamingBridge;
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
  private nextId = 1;

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
        const ref = `browser-file:${this.nextId++}`;
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

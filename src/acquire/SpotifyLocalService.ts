/**
 * Spotify → Local workflow.
 *
 *   Spotify playlist / track / selection (metadata only)
 *     → local playlist created at once (source order, repeats kept, unresolved entries listed)
 *     → per entry:  A. local library (saved mapping → ISRC → artist/title/version/duration)
 *                   B. watched download folder (files from an external converter)
 *                   C. authorised download provider (if enabled and available)
 *     → validate (exists, non-empty, decodes, plausible length) → library → analysis
 *     → playable as soon as the audio is validated; Auto DJ / decks via the existing actions
 *
 * Jobs and entry states are persisted after every change and resumed after a restart.
 * One failing entry never stops the others; cancel / retry never duplicate files or queue items.
 */
import type { AutoDJ } from "../autodj/AutoDJ";
import type { DJEngine } from "../core/engine/DJEngine";
import type { TrackInfo } from "../core/engine/types";
import { Emitter } from "../core/events";
import type { EventLog } from "../core/log";
import type { LibraryStore } from "../library/LibraryStore";
import type { PlaylistStore } from "../library/PlaylistStore";
import { describeVersion } from "../matching/identity";
import { scoreMatch } from "../matching/scoring";
import type { SmartTrackResolver } from "../matching/SmartTrackResolver";
import { FULL_CAPABILITIES, identityFromLocal, type SourceCandidate } from "../matching/sources";
import type { AudioFileRef, ImportJobPersistence } from "../platform";
import type { StreamingTrack } from "../providers/streamingTypes";
import { CancelledError, isCancelled, Limiter, withRetry, withTimeout } from "./jobs";
import { durationCheck, matchFileToEntries, matchLibrary, sourceIdentity, toReview, versionNeedsReview } from "./match";
import type { AcquisitionProvider, Downloader, ProviderCandidate, ProviderState, SpotifyMetadata } from "./providers";
import { pairEntries, previewRefresh, type IncomingEntry, type RefreshPreview } from "./refresh";
import type { SpotifyRef } from "./spotifyRef";
import {
  DEFAULT_ACQUIRE_MATCH,
  PLAYABLE_STATES,
  STATE_LABEL,
  TRANSIENT_STATES,
  type AcquireConfig,
  type AcquireMatchConfig,
  type AudioQuality,
  type EntryState,
  type ImportJob,
  type JobSource,
  type LocalFile,
  type PlaylistEntry,
  type Provenance,
  type ReviewCandidate,
  type SourceTrack,
  type SpotifySourceResult,
  type WatchedFile,
  type WatchStatus,
} from "./types";

export interface FileCheck {
  ok: boolean;
  quality?: AudioQuality;
  error?: string;
}

export interface SpotifyLocalDeps {
  metadata: SpotifyMetadata | null;
  library: Pick<LibraryStore, "getByRef" | "getState" | "on">;
  playlists: Pick<PlaylistStore, "create" | "get" | "setOrderedRefs" | "rename" | "getState" | "addTracks">;
  resolver: SmartTrackResolver;
  /** Add files to the library (tags + analysis are queued by the app). */
  addFiles(refs: AudioFileRef[]): Promise<number>;
  /** Exists, non-empty, readable audio; `decode` also decodes it fully (off the audio thread). */
  checkFile(ref: string, opts: { decode: boolean }): Promise<FileCheck>;
  analysis: { on(event: "change", cb: (p: { busy: boolean }) => void): () => void };
  autoDJ: Pick<AutoDJ, "getState" | "add" | "start" | "playNext">;
  engine: Pick<DJEngine, "getState" | "loadTrack">;
  providers: AcquisitionProvider[];
  downloader: Downloader | null;
  persistence: ImportJobPersistence;
  log: Pick<EventLog, "info" | "warn">;
  /** Desktop watched-folder + destination settings (null in browser mode). */
  desktop?: {
    config(): Promise<{ config: AcquireConfig; watch: WatchStatus }>;
    onFile(cb: (f: WatchedFile) => void): () => void;
    onWatchStatus(cb: (s: WatchStatus) => void): () => void;
    pickDestination(): Promise<{ config: AcquireConfig; watch: WatchStatus }>;
    pickWatchFolder(): Promise<{ config: AcquireConfig; watch: WatchStatus }>;
    setWatching(on: boolean): Promise<{ config: AcquireConfig; watch: WatchStatus }>;
    rescan(): Promise<WatchStatus>;
  } | null;
  pickFiles?: () => Promise<AudioFileRef[]>;
  /** Bring the library search index up to date before matching (it is rebuilt with a debounce). */
  freshIndex?: () => void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export interface ProviderView {
  id: string;
  name: string;
  audioSource: string;
  note: string;
  canDownload: boolean;
  enabled: boolean;
  state: ProviderState | null;
}

export interface DraftPreview {
  ref: SpotifyRef | null;
  result: SpotifySourceResult;
  /** Entries already matched confidently in the local library (instant check). */
  alreadyLocal: number;
  toReview: number;
  unsupported: number;
}

export interface SpotifyLocalState {
  jobs: ImportJob[];
  draft: DraftPreview | null;
  loadingDraft: boolean;
  watch: WatchStatus | null;
  config: AcquireConfig | null;
  providers: ProviderView[];
  match: AcquireMatchConfig;
  /** Latest user-facing message (errors, Auto DJ results). */
  message: { text: string; kind: "info" | "error" } | null;
  refresh: { jobId: string; preview: RefreshPreview; incoming: IncomingEntry[]; source: JobSource } | null;
}

const SETTINGS_KEY = "dbdj.spotifyLocal.settings.v1";
const PROVIDER_SEARCH_TIMEOUT = 15_000;
/** The persistent list behind the per-track "Download" buttons, and its local playlist's name. */
export const DOWNLOADS_ID = "__downloads__";
export const DOWNLOADS_NAME = "Downloads";
/** Marks a provider note as a failed download attempt (vs. "nothing found"). */
const DOWNLOAD_FAILED = "\u0000dl:";

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function sourceTrackFromStreaming(t: StreamingTrack): SourceTrack {
  return {
    id: t.id,
    uri: `spotify:track:${t.id}`,
    title: t.title,
    artists: t.artists?.length ? t.artists : t.artist ? [t.artist] : [],
    album: t.album,
    durationMs: t.durationMs || null,
    explicit: t.explicit ?? null,
    isrc: t.isrc ?? null,
    url: t.externalUrl ?? null,
  };
}

export class SpotifyLocalService extends Emitter<{ change: SpotifyLocalState }> {
  private state: SpotifyLocalState;
  private readonly entryLimiter = new Limiter(3);
  private readonly searchLimiter = new Limiter(2);
  private readonly downloadLimiter = new Limiter(2);
  private readonly checkLimiter = new Limiter(1);
  private running = new Map<string, AbortController>();
  /** Spotify id → in-flight acquisition, so repeats / other jobs never download twice. */
  private acquiring = new Map<string, Promise<LocalFile | null>>();
  /** Watched files seen this session (matched later when a job reaches them). */
  private seenFiles = new Map<string, WatchedFile>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disabledProviders: Set<string>;
  private analysisBatchStart = 0;
  private loaded = false;

  constructor(private d: SpotifyLocalDeps) {
    super();
    const saved = this.loadSettings();
    this.disabledProviders = new Set(saved.disabled ?? []);
    this.state = {
      jobs: [],
      draft: null,
      loadingDraft: false,
      watch: null,
      config: null,
      providers: d.providers.map((p) => ({ id: p.id, name: p.name, audioSource: p.audioSource, note: p.note, canDownload: p.canDownload, enabled: p.canDownload && !this.disabledProviders.has(p.id), state: null })),
      match: { ...DEFAULT_ACQUIRE_MATCH, ...saved.match },
      message: null,
      refresh: null,
    };
    d.library.on("change", () => this.onLibraryChange());
    d.analysis.on("change", (p) => this.onAnalysisProgress(p.busy));
    if (d.desktop) {
      d.desktop.onFile((f) => void this.onWatchedFile(f));
      d.desktop.onWatchStatus((watch) => this.set({ watch }));
    }
  }

  getState(): SpotifyLocalState {
    return this.state;
  }

  get canDownload(): boolean {
    return !!this.d.downloader && !!this.state.config?.destination && this.state.providers.some((p) => p.enabled && p.canDownload && p.state?.available);
  }

  private set(p: Partial<SpotifyLocalState>): void {
    this.state = { ...this.state, ...p };
    this.emit("change", this.state);
  }

  private say(text: string, kind: "info" | "error" = "info"): void {
    this.set({ message: { text, kind } });
  }

  clearMessage(): void {
    this.set({ message: null });
  }

  // ─────────────────────────── startup / recovery ───────────────────────────

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let jobs: ImportJob[] = [];
    try {
      jobs = await this.d.persistence.load();
    } catch (err) {
      this.d.log.warn("spotify-local", `Couldn't load Spotify → Local jobs: ${String(err)}`);
    }
    // Work interrupted by a restart starts again from Pending (downloads are idempotent).
    const recovered = jobs.map((j) => ({
      ...j,
      entries: j.entries.map((e) => (TRANSIENT_STATES.has(e.state) ? { ...e, state: "pending" as EntryState, detail: "Resumed after restart", progress: undefined } : e)),
    }));
    this.set({ jobs: recovered });
    this.onLibraryChange();
    // Resume only once provider and folder availability is known, or resumed entries would skip them.
    await Promise.all([this.refreshDesktop(), this.refreshProviders()]);
    for (const j of recovered) {
      this.syncPlaylist(j.id);
      // Resume anything left to do (a job's saved status can lag behind its entries).
      if (j.status !== "cancelled" && (j.status === "running" || j.entries.some((e) => e.state === "pending"))) void this.run(j.id);
    }
  }

  async refreshDesktop(): Promise<void> {
    if (!this.d.desktop) return;
    try {
      const { config, watch } = await this.d.desktop.config();
      this.set({ config, watch });
    } catch (err) {
      this.d.log.warn("spotify-local", `Desktop services unavailable: ${String(err)}`);
    }
  }

  setDesktopState(s: { config: AcquireConfig; watch: WatchStatus }): void {
    this.set({ config: s.config, watch: s.watch });
  }

  /** Desktop folder settings (native dialogs in the main process). Errors are shown, never thrown. */
  async desktopAction(kind: "destination" | "watchFolder" | "watchOn" | "watchOff" | "rescan"): Promise<void> {
    const d = this.d.desktop;
    if (!d) return this.say("Folders can only be chosen in the desktop app.", "error");
    try {
      if (kind === "rescan") this.set({ watch: await d.rescan() });
      else this.setDesktopState(await (kind === "destination" ? d.pickDestination() : kind === "watchFolder" ? d.pickWatchFolder() : d.setWatching(kind === "watchOn")));
      if (kind === "destination" && this.state.config?.destination) {
        await this.refreshProviders();
        if (this.state.providers.some((v) => v.enabled && v.canDownload && v.state?.available)) this.retryAwaiting();
      }
    } catch (err) {
      this.say(cleanError(err), "error");
    }
  }

  async refreshProviders(force = false): Promise<void> {
    const views = await Promise.all(
      this.d.providers.map(async (p) => {
        let state: ProviderState;
        try {
          // Generous: a first spotDL check starts Python, which can take a while on a busy machine.
          state = await withTimeout(p.state(force), 60_000, `${p.name} check`);
        } catch (err) {
          state = { available: false, reason: err instanceof Error ? err.message : String(err) };
        }
        return { ...this.state.providers.find((v) => v.id === p.id)!, state };
      }),
    );
    const usable = (v: ProviderView) => v.enabled && v.canDownload && !!v.state?.available;
    const before = new Set(this.state.providers.filter((v) => usable(v) && v.state).map((v) => v.id));
    const newlyUsable = views.some((v) => usable(v) && !before.has(v.id));
    this.set({ providers: views });
    // A provider became usable (e.g. spotDL was just installed): retry entries waiting for a file.
    if (newlyUsable && this.loaded) this.retryAwaiting();
  }

  private retryAwaiting(onlyJob?: string): void {
    for (const j of this.state.jobs) {
      if ((onlyJob && j.id !== onlyJob) || !j.useProviders || j.status === "cancelled") continue;
      const keys = j.entries.filter((e) => e.state === "awaiting-file").map((e) => e.key);
      if (!keys.length) continue;
      const set = new Set(keys);
      this.set({ jobs: this.state.jobs.map((x) => (x.id !== j.id ? x : { ...x, entries: x.entries.map((e) => (set.has(e.key) ? { ...e, state: "pending" as EntryState, detail: "Retrying with the newly available provider" } : e)) })) });
      this.persist(j.id, true);
      if (this.running.has(j.id)) for (const k of keys) void this.entryLimiter.run(() => this.processEntry(j.id, k, this.running.get(j.id)!.signal));
      else void this.run(j.id);
    }
  }

  setProviderEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabledProviders.delete(id);
    else this.disabledProviders.add(id);
    this.saveSettings();
    this.set({ providers: this.state.providers.map((p) => (p.id === id ? { ...p, enabled: p.canDownload && enabled } : p)) });
    if (enabled && this.state.providers.find((p) => p.id === id)?.state?.available) this.retryAwaiting();
  }

  setMatchConfig(c: Partial<AcquireMatchConfig>): void {
    const match = { ...this.state.match, ...c };
    match.reviewMin = Math.max(30, Math.min(match.autoAccept, match.reviewMin));
    this.set({ match });
    this.saveSettings();
  }

  // ─────────────────────────── preview / start ───────────────────────────

  /** Fetch a Spotify source and show what would happen before anything is created. */
  async preview(ref: SpotifyRef): Promise<DraftPreview | null> {
    if (!this.d.metadata) {
      this.say("Spotify needs the desktop app or a connected browser session — open Library → Spotify to connect.", "error");
      return null;
    }
    this.set({ loadingDraft: true, draft: null, message: null });
    try {
      const result = await this.d.metadata.resolve(ref);
      const draft = this.describeDraft(ref, result);
      this.set({ draft });
      return draft;
    } catch (err) {
      this.say(cleanError(err), "error");
      return null;
    } finally {
      this.set({ loadingDraft: false });
    }
  }

  /** Preview a set of Spotify search results / selected rows (no extra API calls). */
  previewSelection(tracks: StreamingTrack[], name: string): DraftPreview {
    const result: SpotifySourceResult = {
      source: { kind: "selection", spotifyId: null, name, owner: null, url: null, snapshotId: null },
      entries: tracks.map((t) => ({ kind: "track", track: sourceTrackFromStreaming(t), addedAt: null })),
    };
    const draft = this.describeDraft(null, result);
    this.set({ draft, message: null });
    return draft;
  }

  private describeDraft(ref: SpotifyRef | null, result: SpotifySourceResult): DraftPreview {
    this.d.freshIndex?.();
    let alreadyLocal = 0;
    let toReview = 0;
    let unsupported = 0;
    result.entries.forEach((e, i) => {
      if (e.kind === "episode" || (e.kind === "unavailable" && !e.track.title)) return void unsupported++;
      const m = matchLibrary(this.d.resolver, sourceIdentity({ key: `draft${i}`, source: e.track }), this.state.match);
      if (m.kind === "accept") alreadyLocal++;
      else if (m.kind === "review") toReview++;
    });
    return { ref, result, alreadyLocal, toReview, unsupported };
  }

  discardDraft(): void {
    this.set({ draft: null });
  }

  /** The persistent "Downloads" list fed by the per-track Download buttons, if it exists. */
  downloadsJob(): ImportJob | undefined {
    return this.state.jobs.find((j) => j.source.kind === "selection" && j.source.spotifyId === DOWNLOADS_ID);
  }

  /** Entry for a Spotify track in the Downloads list (for row status). */
  downloadEntry(spotifyId: string): PlaylistEntry | undefined {
    return this.downloadsJob()?.entries.find((e) => e.source.id === spotifyId);
  }

  /**
   * Download one Spotify track (e.g. a search result) into the local playlist "Downloads":
   * library first, then the watched folder, then the enabled download providers.
   * Adding the same track again only retries it if it didn't work before.
   */
  downloadTrack(t: StreamingTrack): void {
    const now = Date.now();
    let job = this.downloadsJob();
    if (!job) {
      // Reuse an existing local playlist called "Downloads" rather than creating "Downloads 2".
      const existing = this.d.playlists.getState().playlists.find((p) => p.name === DOWNLOADS_NAME);
      const playlist = existing ?? this.d.playlists.create(DOWNLOADS_NAME);
      job = {
        id: uid("job"),
        playlistId: playlist.id,
        playlistName: playlist.name,
        source: { kind: "selection", spotifyId: DOWNLOADS_ID, name: DOWNLOADS_NAME, owner: null, url: null, snapshotId: null },
        entries: [],
        status: "done",
        autoAppend: false,
        useProviders: true,
        createdAt: now,
        updatedAt: now,
        lastRefreshAt: null,
      };
      this.set({ jobs: [...this.state.jobs, job] });
    }
    const jobId = job.id;
    const prev = job.entries.find((e) => e.source.id === t.id);
    if (prev) {
      if (prev.state === "failed" || prev.state === "cancelled" || prev.state === "awaiting-file") this.retryEntry(jobId, prev.key);
      else this.say(`“${t.title}” is already in Downloads (${STATE_LABEL[prev.state]}).`);
      return;
    }
    const entry = this.newEntry(job.entries.length, "track", sourceTrackFromStreaming(t), now);
    this.patchJob(jobId, { entries: [...job.entries, entry], useProviders: true }, true);
    if (!this.canDownload) this.say(`Added “${t.title}” to Downloads. No download provider is ready, so it waits for a file — see ⚙ Folders & providers.`);
    const ctl = this.running.get(jobId);
    if (ctl) void this.entryLimiter.run(() => this.processEntry(jobId, entry.key, ctl.signal));
    else void this.run(jobId);
  }

  /** Create the local playlist and the job, then start working through it. */
  start(opts: { playlistName: string; useProviders: boolean; autoAppend: boolean }): ImportJob | null {
    const draft = this.state.draft;
    if (!draft) return null;
    const now = Date.now();
    const playlist = this.d.playlists.create(opts.playlistName.trim() || draft.result.source.name);
    const job: ImportJob = {
      id: uid("job"),
      playlistId: playlist.id,
      playlistName: playlist.name,
      source: draft.result.source,
      entries: draft.result.entries.map((e, i) => this.newEntry(i, e.kind, e.track, now)),
      status: "running",
      autoAppend: opts.autoAppend,
      useProviders: opts.useProviders,
      createdAt: now,
      updatedAt: now,
      lastRefreshAt: now,
    };
    this.set({ jobs: [...this.state.jobs, job], draft: null });
    this.persist(job.id, true);
    this.d.log.info("spotify-local", `Preparing "${job.playlistName}" (${job.entries.length} entries from Spotify)`);
    void this.run(job.id);
    return job;
  }

  private newEntry(position: number, kind: PlaylistEntry["kind"], track: SourceTrack, now: number): PlaylistEntry {
    const unsupported = kind === "episode" ? "Podcast episodes can't be prepared for DJ playback" : kind === "unavailable" && !track.title ? "Removed from Spotify — no metadata left to match" : null;
    return {
      key: uid("e"),
      position,
      kind,
      source: track,
      state: unsupported ? "failed" : "pending",
      detail: unsupported ?? (kind === "unavailable" ? "Unavailable on Spotify — matching your local files anyway" : kind === "spotify-local-file" ? "Spotify local file — matching by its tags" : ""),
      attempts: 0,
      local: null,
      review: [],
      queued: false,
      analysis: "pending",
      updatedAt: now,
    };
  }

  // ─────────────────────────── job control ───────────────────────────

  job(id: string): ImportJob | undefined {
    return this.state.jobs.find((j) => j.id === id);
  }

  private entry(jobId: string, key: string): PlaylistEntry | undefined {
    return this.job(jobId)?.entries.find((e) => e.key === key);
  }

  private patchJob(jobId: string, patch: Partial<ImportJob>, now = false): void {
    this.set({ jobs: this.state.jobs.map((j) => (j.id === jobId ? { ...j, ...patch, updatedAt: Date.now() } : j)) });
    this.persist(jobId, now);
  }

  private patchEntry(jobId: string, key: string, patch: Partial<PlaylistEntry>): PlaylistEntry | undefined {
    let out: PlaylistEntry | undefined;
    this.set({
      jobs: this.state.jobs.map((j) => {
        if (j.id !== jobId) return j;
        return { ...j, updatedAt: Date.now(), entries: j.entries.map((e) => (e.key === key ? (out = { ...e, ...patch, updatedAt: Date.now() }) : e)) };
      }),
    });
    this.persist(jobId);
    return out;
  }

  private setEntryState(jobId: string, key: string, state: EntryState, detail = "", extra: Partial<PlaylistEntry> = {}): void {
    const before = this.entry(jobId, key);
    const after = this.patchEntry(jobId, key, { state, detail, progress: undefined, ...extra });
    if (before && after && PLAYABLE_STATES.has(after.state) !== PLAYABLE_STATES.has(before.state)) {
      this.syncPlaylist(jobId);
      if (PLAYABLE_STATES.has(after.state)) this.maybeAutoAppend(jobId, key);
    }
  }

  async run(jobId: string): Promise<void> {
    const job = this.job(jobId);
    if (!job || this.running.has(jobId)) return;
    const ctl = new AbortController();
    this.running.set(jobId, ctl);
    this.patchJob(jobId, { status: "running" }, true);
    try {
      const work = job.entries.filter((e) => e.state === "pending").map((e) => e.key);
      await Promise.all(work.map((key) => this.entryLimiter.run(() => this.processEntry(jobId, key, ctl.signal))));
    } finally {
      this.running.delete(jobId);
      if (!ctl.signal.aborted && this.job(jobId)) this.patchJob(jobId, { status: "done" }, true);
      const j = this.job(jobId);
      if (j && !ctl.signal.aborted) {
        const c = counts(j);
        this.d.log.info("spotify-local", `"${j.playlistName}": ${c.playable}/${j.entries.length} playable, ${c.awaiting} awaiting a file, ${c.review} to review, ${c.failed} failed`);
      }
    }
  }

  cancel(jobId: string): void {
    this.running.get(jobId)?.abort();
    const job = this.job(jobId);
    if (!job) return;
    const stop = new Set<EntryState>(["pending", "matching", "downloading", "importing", "awaiting-file"]);
    this.set({
      jobs: this.state.jobs.map((j) =>
        j.id !== jobId ? j : { ...j, status: "cancelled", updatedAt: Date.now(), entries: j.entries.map((e) => (stop.has(e.state) ? { ...e, state: "cancelled" as EntryState, detail: "Cancelled", progress: undefined } : e)) },
      ),
    });
    this.persist(jobId, true);
  }

  /** Retry every failed / cancelled entry (and resume a cancelled job). */
  retryFailed(jobId: string): void {
    const job = this.job(jobId);
    if (!job) return;
    const again = (e: PlaylistEntry) => (e.state === "failed" || e.state === "cancelled") && e.kind !== "episode" && !!e.source.title;
    this.set({ jobs: this.state.jobs.map((j) => (j.id !== jobId ? j : { ...j, entries: j.entries.map((e) => (again(e) ? { ...e, state: "pending" as EntryState, detail: "Retrying" } : e)) })) });
    this.persist(jobId, true);
    void this.run(jobId);
  }

  retryEntry(jobId: string, key: string): void {
    const e = this.entry(jobId, key);
    if (!e || PLAYABLE_STATES.has(e.state) || TRANSIENT_STATES.has(e.state) || e.kind === "episode") return;
    this.setEntryState(jobId, key, "pending", "Retrying", { review: [] });
    if (this.running.has(jobId)) void this.entryLimiter.run(() => this.processEntry(jobId, key, this.running.get(jobId)!.signal));
    else void this.run(jobId);
  }

  setAutoAppend(jobId: string, on: boolean): void {
    this.patchJob(jobId, { autoAppend: on }, true);
    if (on) for (const e of this.job(jobId)?.entries ?? []) if (PLAYABLE_STATES.has(e.state)) this.maybeAutoAppend(jobId, e.key);
  }

  setUseProviders(jobId: string, on: boolean): void {
    this.patchJob(jobId, { useProviders: on }, true);
    // Switching downloads on retries the entries that were only waiting for a file.
    if (on) this.retryAwaiting(jobId);
  }

  rename(jobId: string, name: string): void {
    const job = this.job(jobId);
    if (!job || !name.trim()) return;
    this.d.playlists.rename(job.playlistId, name);
    this.patchJob(jobId, { playlistName: this.d.playlists.get(job.playlistId)?.name ?? name.trim() }, true);
  }

  /** Unlink: the local playlist, its files and their preparation are kept. */
  async removeJob(jobId: string): Promise<void> {
    this.running.get(jobId)?.abort();
    this.set({ jobs: this.state.jobs.filter((j) => j.id !== jobId) });
    await this.d.persistence.remove(jobId).catch(() => undefined);
  }

  // ─────────────────────────── the pipeline ───────────────────────────

  private async processEntry(jobId: string, key: string, signal: AbortSignal): Promise<void> {
    const start = this.entry(jobId, key);
    if (!start || start.state !== "pending") return;
    this.patchEntry(jobId, key, { attempts: start.attempts + 1 });
    try {
      if (signal.aborted) throw new CancelledError();
      const id = start.source.id;
      // A repeat of a track already being acquired (this or another job) waits for that result.
      const inflight = id ? this.acquiring.get(id) : undefined;
      if (inflight) {
        this.setEntryState(jobId, key, "matching", "Same track appears earlier — waiting for it");
        const shared = await inflight;
        if (shared) return void this.attach(jobId, key, shared);
        this.setEntryState(jobId, key, "pending");
      }
      const task = this.acquire(jobId, key, signal);
      if (id) this.acquiring.set(id, task);
      try {
        await task;
      } finally {
        if (id && this.acquiring.get(id) === task) this.acquiring.delete(id);
      }
    } catch (err) {
      if (isCancelled(err) || signal.aborted) this.setEntryState(jobId, key, "cancelled", "Cancelled");
      else this.setEntryState(jobId, key, "failed", cleanError(err));
    }
  }

  /** Resolve one entry; returns the attached local file, or null when it ends unresolved. */
  private async acquire(jobId: string, key: string, signal: AbortSignal): Promise<LocalFile | null> {
    const e = this.entry(jobId, key)!;
    const identity = sourceIdentity(e);
    const cfg = this.state.match;

    // A. Existing local library.
    let libNote = "";
    this.setEntryState(jobId, key, "matching", "Searching your library");
    this.d.freshIndex?.();
    const lib = matchLibrary(this.d.resolver, identity, cfg);
    if (lib.kind === "accept") {
      const track = this.d.library.getByRef(lib.candidate.sourceTrackId);
      if (track) {
        const check = await this.checkLimiter.run(() => this.d.checkFile(track.ref, { decode: !track.prepared }));
        if (signal.aborted) throw new CancelledError();
        const dur = durationCheck(e.source.durationMs, check.quality?.durationMs ?? track.durationMs ?? null, cfg);
        if (check.ok && (dur.ok || lib.method === "manual")) {
          const local = this.localFrom(track, check.quality ?? null, {
            origin: "library",
            provider: null,
            audioSource: "Local library",
            candidateId: null,
            confidence: lib.candidate.score,
            method: lib.method,
            version: describeVersion(lib.candidate.identity.version),
            matchedAt: Date.now(),
          });
          if (lib.method !== "mapping" && lib.method !== "manual") await this.d.resolver.recordMatch(identity, localCandidate(track), lib.method === "isrc" ? "isrc" : "metadata");
          this.attach(jobId, key, local);
          return local;
        }
        libNote = `Library file "${track.title}" not usable: ${check.error ?? dur.message}. `;
        this.patchEntry(jobId, key, { detail: libNote });
      }
    } else if (lib.kind === "review") {
      this.setEntryState(jobId, key, "needs-review", `${lib.candidates.length} possible match${lib.candidates.length > 1 ? "es" : ""} in your library — choose the right version`, { review: lib.candidates });
      return null;
    }

    // B. Files already seen in the watched folder.
    const files = [...this.seenFiles.values()].filter((f) => !f.error || f.quality);
    for (const f of files) {
      const m = matchFileToEntries(f, [this.entry(jobId, key)!], cfg);
      if (m.kind === "accept") return this.importFile(jobId, [key], f, "watch-folder", m.score, m.version, signal);
    }

    // C. Download providers. Each one's outcome is noted so "Awaiting File" says what was tried.
    const job = this.job(jobId)!;
    const notes: string[] = [];
    if (!job.useProviders) notes.push("Downloads are off for this playlist (tick “Use download providers” above)");
    else if (!this.d.downloader) notes.push("Downloads need the desktop app");
    else {
      const got = await this.tryProviders(jobId, key, signal, notes);
      if (got !== undefined) return got;
    }

    // A download was attempted and failed: Failed (so "Retry failed" picks it up), with every reason.
    if (notes.some((n) => n.startsWith(DOWNLOAD_FAILED))) {
      this.setEntryState(jobId, key, "failed", `${libNote}${notes.map((n) => n.replace(DOWNLOAD_FAILED, "")).join(" · ")}`);
      return null;
    }

    // D. Nothing yet: wait for a file.
    const watching = this.state.watch?.watching;
    this.setEntryState(
      jobId,
      key,
      "awaiting-file",
      libNote +
        "Not in your library. " +
        (notes.length ? `${notes.join(" · ")}. ` : "") +
        (watching ? "Save it into the watched folder and it's picked up automatically, or choose a file." : this.d.desktop ? "Turn on Watch Download Folder for your converter's output, or choose a file." : "Add the file to your library, then press Retry."),
    );
    return null;
  }

  /** undefined = no provider could help (continue); null = ended in review; LocalFile = done. */
  private async tryProviders(jobId: string, key: string, signal: AbortSignal, notes: string[]): Promise<LocalFile | null | undefined> {
    const cfg = this.state.match;
    const e = this.entry(jobId, key)!;
    const identity = sourceIdentity(e);
    const active: AcquisitionProvider[] = [];
    for (const p of this.d.providers.filter((x) => x.canDownload)) {
      const v = this.state.providers.find((x) => x.id === p.id);
      if (!v?.enabled) notes.push(`${p.name}: turned off`);
      else if (!v.state) notes.push(`${p.name}: still being checked — press Retry in a moment`);
      else if (!v.state.available) notes.push(`${p.name}: ${(v.state.reason ?? "unavailable").replace(/\.$/, "")} — see ⚙ Folders & providers`);
      else active.push(p);
    }
    if (!active.length) return undefined;
    if (!this.state.config?.destination) {
      notes.push("Downloads skipped — choose a download destination in ⚙ Folders & providers");
      return undefined;
    }
    const review: ReviewCandidate[] = [];
    for (const p of active) {
      this.setEntryState(jobId, key, "matching", `Searching ${p.name}`);
      let found: ProviderCandidate[];
      try {
        found = await this.searchLimiter.run(() =>
          withRetry(() => withTimeout(p.search(identity, signal), PROVIDER_SEARCH_TIMEOUT, `${p.name} search`, signal), {
            attempts: 3,
            baseMs: 2000,
            maxMs: 30_000,
            signal,
            onRetry: (n, wait) => this.patchEntry(jobId, key, { detail: `${p.name} busy — retry ${n} in ${Math.round(wait / 1000)} s` }),
          }),
        );
      } catch (err) {
        if (isCancelled(err)) throw err;
        notes.push(`${p.name}: ${cleanError(err)}`);
        continue;
      }
      const scored = found.map((c) => ({ c, s: scoreMatch(identity, c.identity) })).sort((a, b) => b.s.score - a.s.score);
      const best = scored[0];
      if (!best || best.s.score < cfg.reviewMin) {
        notes.push(`${p.name}: ${found.length ? `no close enough match (best ${best?.s.score ?? 0}%)` : "no downloadable match"}`);
        continue;
      }
      const rival = scored[1] && scored[1].s.score >= cfg.autoAccept && best.s.score - scored[1].s.score < 10;
      const dur = durationCheck(e.source.durationMs, best.c.identity.durationMs, cfg);
      if (best.s.score >= cfg.autoAccept && !rival && dur.ok && !versionNeedsReview(identity.version, best.c.identity.version)) {
        try {
          return await this.download(jobId, [key], p, best.c, best.s.score, signal);
        } catch (err) {
          // One provider failing (e.g. no YouTube match, wrong length) lets the next one try.
          if (isCancelled(err) || signal.aborted) throw err;
          notes.push(`${DOWNLOAD_FAILED}${p.name}: ${cleanError(err)}`);
          continue;
        }
      }
      for (const x of scored.filter((x) => x.s.score >= cfg.reviewMin).slice(0, 4)) {
        review.push({ ...toReview({ ...x.s, source: "local", sourceTrackId: x.c.id, identity: x.c.identity, track: null, capabilities: FULL_CAPABILITIES }, "provider"), kind: "provider", id: x.c.id, provider: p.id, label: p.audioSource });
      }
    }
    if (review.length) {
      this.setEntryState(jobId, key, "needs-review", "Possible download match — check the version before downloading", { review });
      return null;
    }
    return undefined;
  }

  private async download(jobId: string, keys: string[], p: AcquisitionProvider, c: ProviderCandidate, score: number, signal: AbortSignal): Promise<LocalFile | null> {
    const dl = this.d.downloader!;
    const e = this.entry(jobId, keys[0])!;
    for (const k of keys) this.setEntryState(jobId, k, "downloading", `Downloading from ${p.audioSource}`, { progress: 0 });
    const res = await this.downloadLimiter.run(() =>
      withRetry(
        () =>
          dl.download(
            { provider: p.id, candidateId: c.id, url: c.downloadUrl, name: c.name, expectedDurationMs: e.source.durationMs },
            (progress) => keys.forEach((k) => this.patchEntry(jobId, k, { progress })),
            signal,
          ),
        { attempts: 3, baseMs: 3000, maxMs: 30_000, signal, onRetry: (n, wait) => keys.forEach((k) => this.patchEntry(jobId, k, { detail: `Download interrupted — retry ${n} in ${Math.round(wait / 1000)} s` })) },
      ),
    );
    const file: WatchedFile = { path: res.path, name: res.name, size: res.quality.sizeBytes ?? 0, mtimeMs: Date.now(), tags: {}, quality: res.quality };
    return this.importFile(jobId, keys, file, "provider", score, describeVersion(c.identity.version), signal, { provider: p.id, audioSource: p.audioSource, candidateId: c.id, note: c.matchNote });
  }

  /** Validate a file, add it to the library, attach it to the entries and record the mapping. */
  private async importFile(
    jobId: string,
    keys: string[],
    f: WatchedFile,
    origin: Provenance["origin"],
    score: number,
    version: string,
    signal?: AbortSignal,
    prov: Partial<Provenance> = {},
  ): Promise<LocalFile | null> {
    for (const k of keys) this.setEntryState(jobId, k, "importing", "Checking the file");
    const e = this.entry(jobId, keys[0])!;
    const check = await this.checkLimiter.run(() => this.d.checkFile(f.path, { decode: true }));
    if (signal?.aborted) throw new CancelledError();
    if (!check.ok) throw new Error(`File rejected: ${check.error ?? "not readable audio"}`);
    const quality = { ...f.quality, ...check.quality } as AudioQuality;
    const dur = durationCheck(e.source.durationMs, quality.durationMs ?? null, this.state.match);
    if (!dur.ok && origin !== "manual") throw new Error(`File rejected: ${dur.message}`);
    for (const k of keys) this.patchEntry(jobId, k, { detail: "Adding to your library" });
    await this.d.addFiles([{ ref: f.path, name: f.name }]);
    const track = this.d.library.getByRef(f.path);
    if (!track) throw new Error("The library didn't accept the file");
    const local = this.localFrom(track, quality, {
      origin,
      provider: prov.provider ?? null,
      audioSource: prov.audioSource ?? (origin === "watch-folder" ? "Watched folder" : origin === "manual" ? "Chosen by you" : "Download"),
      candidateId: prov.candidateId ?? null,
      confidence: score,
      method: origin === "manual" ? "manual" : "metadata",
      version,
      matchedAt: Date.now(),
      ...(prov.note ? { note: prov.note } : {}),
    });
    const identity = sourceIdentity(e);
    if (origin === "manual") await this.d.resolver.confirm(identity, localCandidate(track));
    else await this.d.resolver.recordMatch(identity, localCandidate(track), "metadata");
    for (const k of keys) this.attach(jobId, k, local);
    this.d.log.info("spotify-local", `${e.source.artists.join(", ")} – ${e.source.title}: ${local.provenance.audioSource} (${score}%)`);
    return local;
  }

  private localFrom(track: TrackInfo, quality: AudioQuality | null, provenance: Provenance): LocalFile {
    return { ref: track.ref, title: track.title, artist: track.artist, quality, provenance };
  }

  private attach(jobId: string, key: string, local: LocalFile): void {
    const prepared = !!this.d.library.getByRef(local.ref)?.prepared;
    this.setEntryState(jobId, key, prepared ? "ready" : "analysing", prepared ? "" : "Playable now — analysing (BPM, key, beatgrid)", { local, review: [], analysis: prepared ? "done" : "pending" });
  }

  // ─────────────────────────── review ───────────────────────────

  async confirmReview(jobId: string, key: string, c: ReviewCandidate): Promise<void> {
    const e = this.entry(jobId, key);
    if (!e) return;
    try {
      if (c.kind === "library") {
        const track = this.d.library.getByRef(c.id);
        if (!track) throw new Error("That library track is no longer available");
        const check = await this.checkLimiter.run(() => this.d.checkFile(track.ref, { decode: !track.prepared }));
        if (!check.ok) throw new Error(check.error ?? "File unreadable");
        await this.d.resolver.confirm(sourceIdentity(e), localCandidate(track));
        this.attach(jobId, key, this.localFrom(track, check.quality ?? null, { origin: "manual", provider: null, audioSource: "Local library (your choice)", candidateId: null, confidence: c.score, method: "manual", version: c.version, matchedAt: Date.now() }));
      } else if (c.kind === "file") {
        const f = this.seenFiles.get(c.id) ?? { path: c.id, name: c.id.split(/[\\/]/).pop() ?? c.id, size: 0, mtimeMs: 0, tags: {}, quality: null };
        await this.importFile(jobId, [key], f, "manual", c.score, c.version);
      } else {
        const p = this.d.providers.find((x) => x.id === c.provider);
        if (!p || !this.d.downloader) throw new Error("That provider isn't available");
        const found = await p.search(sourceIdentity(e));
        const pc = found.find((x) => x.id === c.id);
        if (!pc) throw new Error("The provider no longer offers that file");
        await this.download(jobId, [key], p, pc, c.score, new AbortController().signal);
      }
    } catch (err) {
      this.setEntryState(jobId, key, "needs-review", cleanError(err));
    }
  }

  /** None of the candidates is right: wait for a file instead. */
  rejectReview(jobId: string, key: string): void {
    this.setEntryState(jobId, key, "awaiting-file", "Waiting for the right version — add it to the watched folder or choose a file", { review: [] });
  }

  /** Pick a specific file from disk for an entry (treated as a confirmed match). */
  async chooseFile(jobId: string, key: string): Promise<void> {
    const [f] = (await this.d.pickFiles?.()) ?? [];
    if (!f) return;
    try {
      await this.importFile(jobId, [key], { path: f.ref, name: f.name, size: 0, mtimeMs: 0, tags: {}, quality: null }, "manual", 100, "chosen by you");
    } catch (err) {
      this.setEntryState(jobId, key, "failed", cleanError(err));
    }
  }

  /** Use a library track for an entry (confirmed match, remembered for next time). */
  async chooseLibraryTrack(jobId: string, key: string, ref: string): Promise<void> {
    const track = this.d.library.getByRef(ref);
    if (!track) return;
    await this.confirmReview(jobId, key, { kind: "library", id: ref, label: "Local library", title: track.title, artist: track.artist, durationMs: track.durationMs ?? null, version: describeVersion(identityFromLocal(track).version), score: 100, reasons: ["Chosen by you"] });
  }

  // ─────────────────────────── watched folder ───────────────────────────

  async onWatchedFile(f: WatchedFile): Promise<void> {
    this.seenFiles.set(f.path, f);
    if (this.seenFiles.size > 5000) this.seenFiles.delete(this.seenFiles.keys().next().value!);
    if (f.error && !f.quality) {
      this.d.log.warn("spotify-local", `Watched folder: ${f.name} isn't readable audio (${f.error})`);
      return;
    }
    // Idempotent: a file already attached to an entry is never imported twice.
    if (this.state.jobs.some((j) => j.entries.some((e) => e.local?.ref === f.path))) return;
    const open = new Set<EntryState>(["pending", "awaiting-file", "failed", "needs-review"]);
    const owner = new Map<string, string>();
    const candidates: PlaylistEntry[] = [];
    for (const j of this.state.jobs) {
      if (j.status === "cancelled") continue;
      for (const e of j.entries) {
        if (!open.has(e.state) || e.kind === "episode" || !e.source.title) continue;
        candidates.push(e);
        owner.set(e.key, j.id);
      }
    }
    if (!candidates.length) return;
    const m = matchFileToEntries(f, candidates, this.state.match);
    if (m.kind === "accept") {
      const byJob = new Map<string, string[]>();
      for (const k of m.keys) byJob.set(owner.get(k)!, [...(byJob.get(owner.get(k)!) ?? []), k]);
      for (const [jobId, keys] of byJob) {
        try {
          await this.importFile(jobId, keys, f, "watch-folder", m.score, m.version);
        } catch (err) {
          for (const k of keys) this.setEntryState(jobId, k, "failed", cleanError(err));
        }
      }
    } else if (m.kind === "review") {
      for (const o of m.options) {
        const jobId = owner.get(o.key)!;
        const e = this.entry(jobId, o.key)!;
        const review = [...e.review.filter((r) => r.id !== o.candidate.id), o.candidate].sort((a, b) => b.score - a.score);
        this.setEntryState(jobId, o.key, "needs-review", `New file "${f.name}" might be this track — confirm the version`, { review });
      }
    }
  }

  // ─────────────────────────── refresh from Spotify ───────────────────────────

  async previewRefresh(jobId: string): Promise<void> {
    const job = this.job(jobId);
    if (!job || !this.d.metadata) return;
    if (job.source.kind !== "playlist" && job.source.kind !== "liked") return this.say("Only playlists and Liked Songs can be refreshed from Spotify.", "error");
    try {
      const ref: SpotifyRef = job.source.kind === "liked" ? { type: "liked", id: "__liked__" } : { type: "playlist", id: job.source.spotifyId! };
      const res = await this.d.metadata.resolve(ref);
      const incoming = res.entries.map((x) => ({ kind: x.kind, track: x.track }));
      this.set({ refresh: { jobId, preview: previewRefresh(job.entries, incoming), incoming, source: res.source } });
    } catch (err) {
      this.say(cleanError(err), "error");
    }
  }

  cancelRefresh(): void {
    this.set({ refresh: null });
  }

  /** Apply the previewed refresh: new order, new entries pending, removed entries unlinked (files kept). */
  applyRefresh(): void {
    const r = this.state.refresh;
    const job = r && this.job(r.jobId);
    if (!r || !job) return;
    const now = Date.now();
    const pairs = pairEntries(job.entries, r.incoming);
    const entries = r.incoming.map((x, i) => {
      const old = pairs[i];
      return old ? { ...old, position: i, source: { ...x.track, isrc: x.track.isrc ?? old.source.isrc } } : this.newEntry(i, x.kind, x.track, now);
    });
    this.set({ refresh: null });
    this.patchJob(job.id, { entries, source: { ...job.source, ...r.source }, lastRefreshAt: now }, true);
    this.syncPlaylist(job.id);
    this.say(`Refreshed "${job.playlistName}": ${r.preview.added.length} added, ${r.preview.removed.length} removed, ${r.preview.moved.length} moved. Removed tracks' files and cues are kept.`);
    if (entries.some((e) => e.state === "pending")) void this.run(job.id);
  }

  // ─────────────────────────── playlist / Auto DJ / decks ───────────────────────────

  /** Local playlist = playable entries in source order (repeats kept). Recreated if deleted. */
  private syncPlaylist(jobId: string): void {
    const job = this.job(jobId);
    if (!job) return;
    let pid = job.playlistId;
    if (!this.d.playlists.get(pid)) {
      pid = this.d.playlists.create(job.playlistName).id;
      this.patchJob(jobId, { playlistId: pid }, true);
    }
    const refs = [...job.entries].sort((a, b) => a.position - b.position).filter((e) => PLAYABLE_STATES.has(e.state) && e.local && this.d.library.getByRef(e.local.ref)).map((e) => e.local!.ref);
    // "Downloads" is also yours to edit: only add newly downloaded tracks, never remove or reorder.
    if (job.source.spotifyId === DOWNLOADS_ID) this.d.playlists.addTracks(pid, refs);
    else this.d.playlists.setOrderedRefs(pid, refs);
  }

  private onLibraryChange(): void {
    for (const j of this.state.jobs) {
      for (const e of j.entries) {
        if (e.state !== "analysing" || !e.local) continue;
        const t = this.d.library.getByRef(e.local.ref);
        if (t?.prepared) this.patchEntry(j.id, e.key, { state: "ready", detail: "", analysis: "done" });
      }
    }
  }

  private onAnalysisProgress(busy: boolean): void {
    if (busy) {
      if (!this.analysisBatchStart) this.analysisBatchStart = Date.now();
      return;
    }
    const batchStart = this.analysisBatchStart;
    this.analysisBatchStart = 0;
    if (!batchStart) return;
    // Analysis finished without preparing these tracks (too long / skipped / failed): still playable.
    for (const j of this.state.jobs) {
      for (const e of j.entries) {
        if (e.state !== "analysing" || !e.local || e.updatedAt > batchStart) continue;
        if (!this.d.library.getByRef(e.local.ref)?.prepared) this.patchEntry(j.id, e.key, { state: "ready", analysis: "skipped", detail: "Analysis skipped in the background — it runs when the track is loaded onto a deck" });
      }
    }
  }

  /** Add playable, not-yet-queued entries to Auto DJ in source order. */
  addReadyToAutoDJ(jobId: string): void {
    const job = this.job(jobId);
    if (!job) return;
    const ordered = [...job.entries].sort((a, b) => a.position - b.position);
    const ready = ordered.filter((e) => PLAYABLE_STATES.has(e.state) && e.local && !e.queued);
    const notReady = ordered.filter((e) => !PLAYABLE_STATES.has(e.state));
    const skippedNote = notReady.length ? ` ${notReady.length} not ready yet (skipped until they are).` : "";
    if (!ready.length) return this.say(`Nothing new to queue.${skippedNote}`);
    const s = this.d.autoDJ.getState();
    if (s.status === "OFF") {
      if (this.d.engine.getState().decks.some((d) => d.playing)) {
        return this.say("Auto DJ is off and a deck is playing. Pause the decks and press Add again, or load tracks onto a deck yourself.", "error");
      }
      void this.d.autoDJ.start(job.playlistId);
      this.markQueued(jobId, ordered.filter((e) => PLAYABLE_STATES.has(e.state)).map((e) => e.key));
      return this.say(`Auto DJ started with "${job.playlistName}" (${ready.length} ready).${skippedNote}`);
    }
    // Auto DJ started from this playlist already holds its tracks: mark those, don't add them twice.
    const inSession = new Map<string, number>();
    if (s.playlistId === job.playlistId) for (const r of [...s.played, ...(s.current ? [s.current] : []), ...s.upcoming]) inSession.set(r, (inSession.get(r) ?? 0) + 1);
    const add: string[] = [];
    for (const e of ready) {
      const ref = e.local!.ref;
      const n = inSession.get(ref) ?? 0;
      if (n > 0) inSession.set(ref, n - 1);
      else add.push(ref);
    }
    if (add.length) this.d.autoDJ.add(add);
    this.markQueued(jobId, ready.map((e) => e.key));
    this.say(`Added ${add.length} track${add.length === 1 ? "" : "s"} to the end of the Auto DJ queue (your queue edits are kept).${skippedNote}`);
  }

  private markQueued(jobId: string, keys: string[]): void {
    const set = new Set(keys);
    this.set({ jobs: this.state.jobs.map((j) => (j.id !== jobId ? j : { ...j, entries: j.entries.map((e) => (set.has(e.key) ? { ...e, queued: true } : e)) })) });
    this.persist(jobId);
  }

  private maybeAutoAppend(jobId: string, key: string): void {
    const job = this.job(jobId);
    const e = this.entry(jobId, key);
    if (!job?.autoAppend || !e?.local || e.queued || !PLAYABLE_STATES.has(e.state)) return;
    if (this.d.autoDJ.getState().status === "OFF") return;
    this.d.autoDJ.add([e.local.ref]);
    this.markQueued(jobId, [key]);
  }

  /** Next in Auto DJ when it's running, otherwise load onto a deck that isn't playing. */
  playNext(jobId: string, key: string): void {
    const e = this.entry(jobId, key);
    if (!e?.local || !PLAYABLE_STATES.has(e.state)) return this.say("That track isn't ready yet.", "error");
    const s = this.d.autoDJ.getState();
    if (s.status !== "OFF") {
      if (s.status === "TRANSITIONING") return this.say("Auto DJ is mid-transition — try Play Next again in a moment.", "error");
      let at = s.upcoming.indexOf(e.local.ref);
      if (at < 0) {
        this.d.autoDJ.add([e.local.ref]);
        at = this.d.autoDJ.getState().upcoming.lastIndexOf(e.local.ref);
        this.markQueued(jobId, [key]);
      }
      if (at > 0) this.d.autoDJ.playNext(at);
      return this.say(`"${e.source.title}" plays next in Auto DJ.`);
    }
    const free = this.d.engine.getState().decks.findIndex((d) => !d.playing);
    if (free < 0) return this.say("Both decks are playing — nothing was replaced.", "error");
    this.loadDeck(jobId, key, free);
  }

  loadDeck(jobId: string, key: string, deck: number): void {
    const e = this.entry(jobId, key);
    const t = e?.local && this.d.library.getByRef(e.local.ref);
    if (!t || !PLAYABLE_STATES.has(e!.state)) return this.say("That track isn't ready yet.", "error");
    if (this.d.engine.getState().decks[deck]?.playing) return this.say(`Deck ${deck ? "B" : "A"} is playing — pause it first (nothing was replaced).`, "error");
    void this.d.engine.loadTrack(deck, t);
  }

  // ─────────────────────────── persistence ───────────────────────────

  private persist(jobId: string, now = false): void {
    const t = this.saveTimers.get(jobId);
    if (t) clearTimeout(t);
    const write = () => {
      this.saveTimers.delete(jobId);
      const job = this.job(jobId);
      if (job) void this.d.persistence.save(stripVolatile(job)).catch((err) => this.d.log.warn("spotify-local", `Couldn't save job: ${String(err)}`));
    };
    if (now) write();
    else this.saveTimers.set(jobId, setTimeout(write, 400));
  }

  /** Write pending job changes now (window closing). */
  flush(): void {
    for (const [jobId, t] of this.saveTimers) {
      clearTimeout(t);
      this.saveTimers.delete(jobId);
      const job = this.job(jobId);
      if (job) void this.d.persistence.save(stripVolatile(job)).catch(() => undefined);
    }
  }

  private loadSettings(): { disabled?: string[]; match?: Partial<AcquireMatchConfig> } {
    try {
      return JSON.parse(this.d.storage?.getItem(SETTINGS_KEY) ?? "{}");
    } catch {
      return {};
    }
  }

  private saveSettings(): void {
    try {
      this.d.storage?.setItem(SETTINGS_KEY, JSON.stringify({ disabled: [...this.disabledProviders], match: this.state.match }));
    } catch {
      /* best effort */
    }
  }
}

function localCandidate(t: TrackInfo): SourceCandidate {
  return { source: "local", sourceTrackId: t.ref, identity: identityFromLocal(t), track: t, capabilities: FULL_CAPABILITIES };
}

/** Progress fractions are runtime-only. */
function stripVolatile(j: ImportJob): ImportJob {
  return { ...j, entries: j.entries.map(({ progress: _p, ...e }) => e) };
}

export function counts(j: ImportJob): { playable: number; ready: number; awaiting: number; review: number; failed: number; active: number; unresolved: number } {
  let playable = 0;
  let ready = 0;
  let awaiting = 0;
  let review = 0;
  let failed = 0;
  let active = 0;
  for (const e of j.entries) {
    if (PLAYABLE_STATES.has(e.state)) playable++;
    if (e.state === "ready") ready++;
    if (e.state === "awaiting-file") awaiting++;
    if (e.state === "needs-review") review++;
    if (e.state === "failed" || e.state === "cancelled") failed++;
    if (e.state === "pending" || TRANSIENT_STATES.has(e.state)) active++;
  }
  return { playable, ready, awaiting, review, failed, active, unresolved: j.entries.length - playable };
}

function cleanError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^Error: /, "");
}

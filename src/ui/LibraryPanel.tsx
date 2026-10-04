/**
 * Music browser: Local Library + streaming providers (Spotify, Apple Music).
 * Streaming tracks are browse-only; when a matching local file exists it can be loaded instead.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { PROVIDER_CAPABILITIES } from "../providers/MusicProvider";
import { PROVIDER_NAMES, toTrackInfo, type ProviderView } from "../providers/StreamingStore";
import { summarize } from "../app/matching";
import { AudiusPane, useAudiusState } from "./AudiusPane";
import type { ResolutionResult } from "../matching/SmartTrackResolver";
import type { StreamingProviderId } from "../providers/streamingTypes";
import { useApp, useEngineState, useLibraryState } from "./context";
import type { App } from "../app/createApp";
import { useFrameStore } from "./hooks";
import { useStemIndex, useStemStatus } from "./stemHooks";
import { ArtTile } from "./ArtTile";
import { AutoDJQueue, PlaylistActions, PlaylistNav, PlaylistView, TrackDetails, TRACK_REFS } from "./PlaylistPanel";
import { compatibility } from "../analysis/discovery";
import { DiscoveryDialog, type DiscoveryMode } from "./DiscoveryDialog";
import { MashipsView } from "./MashipsPanel";
import { PracticePanel } from "./PracticePanel";
import { SpotifyLocalPanel, useSpotifyLocal } from "./SpotifyLocalPanel";
import { PERMISSION_REMINDER } from "../acquire/providers";
import { PLAYABLE_STATES, STATE_LABEL } from "../acquire/types";
import type { StreamingTrack } from "../providers/streamingTypes";

type Source = "local" | "audius" | "playlist" | "practice" | "auto-mashups" | "manual-mashups" | "queue" | "spotify-local" | StreamingProviderId;
export type MainBrowserArea = "collections" | "playlists" | "mashups" | "practice" | "streaming";

function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useStreamingState() {
  const { streaming } = useApp();
  return useFrameStore(
    useCallback((cb) => streaming.on("change", cb), [streaming]),
    () => streaming.getState(),
  );
}

/** Deck to use for "load" shortcuts: the first deck that isn't playing. */
/**
 * One engine value as a primitive, re-rendering only when it changes — not on every engine
 * update (library rows mustn't re-render while a deck plays).
 */
function useEngineValue<T extends string | number | null>(read: (s: ReturnType<App["engine"]["getState"]>) => T): T {
  const { engine } = useApp();
  return useFrameStore(useCallback((cb) => engine.on("state", cb), [engine]), () => read(engine.getState()));
}

function useFreeDeck(): number | null {
  return useEngineValue((s) => {
    const i = s.decks.findIndex((d) => !d.playing);
    return i >= 0 ? i : null;
  });
}

/** "10" = deck A playing, deck B not. */
const usePlayingFlags = () => useEngineValue((s) => s.decks.map((d) => (d.playing ? "1" : "0")).join(""));

type LocalCollection = "all" | "recent" | "rated";

export function LibraryPanel({ navigation, onNavigateArea }: { navigation?: { area: MainBrowserArea; id: number }; onNavigateArea?: (area: MainBrowserArea) => void }) {
  const [source, setSource] = useState<Source>(() => {
    try {
      const saved = localStorage.getItem("dbdj.ui.librarySource");
      return (saved === "maships" ? "auto-mashups" : saved as Source) || "local";
    } catch {
      return "local";
    }
  });
  const [collection, setCollection] = useState<LocalCollection>("all");
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [home, setHome] = useState<MainBrowserArea | null>(navigation?.area ?? null);
  const [practiceView, setPracticeView] = useState<"practice" | "history">("practice");
  const openPlaylist = (id: string) => { setHome(null); setPlaylistId(id); setSource("playlist"); };
  const openQueue = () => { setHome(null); setSource("queue"); };
  const [spotifyLocalJob, setSpotifyLocalJob] = useState<string | null>(null);
  const openSpotifyLocal = (jobId: string | null = null) => { setHome(null); setSpotifyLocalJob(jobId); setSource("spotify-local"); };
  const openMaships = (kind: "auto" | "manual") => { setHome(null); setSource(kind === "manual" ? "manual-mashups" : "auto-mashups"); };
  const lib = useLibraryState();
  const streams = useStreamingState();
  const audiusState = useAudiusState();
  /** Connection status on the right of a streaming item (text, so it doesn't rely on colour). */
  const status = (v: ProviderView) =>
    v.status?.connected ? <span className="count nav-status on" title="Connected">● on</span>
    : v.status?.configured ? <span className="count nav-status" title="Set up, not signed in">◐ sign in</span>
    : <span className="count nav-status" title="Not set up">○ off</span>;
  const label = (icon: string, text: string) => <span><span className="nav-icon" aria-hidden>{icon}</span>{text}</span>;
  const choose = (s: Source, c?: LocalCollection) => {
    setSource(s);
    if (c) setCollection(c);
    try {
      localStorage.setItem("dbdj.ui.librarySource", s);
    } catch {
      /* ignore */
    }
  };
  const recent = lib.tracks.filter((t) => t.addedAt && Date.now() - t.addedAt < 30 * 86400_000).length;
  const rated = lib.tracks.filter((t) => (t.rating ?? 0) >= 4).length;
  useEffect(() => { if (navigation) setHome(navigation.area); }, [navigation]);
  const open = (s: Source, c?: LocalCollection) => { setHome(null); choose(s, c); };
  const item = (s: Source, label: React.ReactNode, c?: LocalCollection) => (
    <button data-source={c ? `local-${c}` : s} className={!home && source === s && (!c || collection === c) ? "active" : ""} onClick={() => open(s, c)}>
      {label}
    </button>
  );
  return (
    <div className="browser header-navigation">
      <nav className="browser-sources">
        <button className="browser-heading browser-section-link" onClick={() => { setHome("collections"); onNavigateArea?.("collections"); }}>COLLECTION <span>›</span></button>
        {item("local", <><span><span className="nav-icon" aria-hidden>♫</span>All Tracks</span><span className="count">{lib.tracks.length}</span></>, "all")}
        {item("local", <><span><span className="nav-icon" aria-hidden>⏱</span>Recently Added</span><span className="count">{recent}</span></>, "recent")}
        {item("local", <><span><span className="nav-icon" aria-hidden>★</span>Top Rated</span><span className="count">{rated}</span></>, "rated")}
        {item("practice", <><span><span className="nav-icon" aria-hidden>◆</span>Practice Mode</span></>)}
        <PlaylistNav selected={!home && source === "playlist" ? playlistId : null} mashipsSelected={!home && source === "manual-mashups" ? "manual" : !home && source === "auto-mashups" ? "auto" : null} onOpen={openPlaylist} onMaships={openMaships} onQueue={openQueue} onArea={(area) => { setHome(area); onNavigateArea?.(area); }} />
        <button className="browser-heading browser-section-link" onClick={() => { setHome("streaming"); onNavigateArea?.("streaming"); }}>STREAMING <span>›</span></button>
        {item("spotify", <>{label("◉", "Spotify")}{status(streams.spotify)}</>)}
        {item("spotify-local", <>{label("⇄", "Spotify → Local")}</>)}
        {item("apple-music", <>{label("♪", "Apple Music")}{status(streams["apple-music"])}</>)}
        {item("audius", <>{label("◎", "Audius")}<span className={`count nav-status${audiusState.connection === "ok" ? " on" : ""}`} title={audiusState.connection === "error" ? "Can't reach Audius" : "Free streaming"}>{audiusState.connection === "ok" ? "● free" : audiusState.connection === "error" ? "▲ offline" : "○ free"}</span></>)}
      </nav>
      <div className="browser-body">
        {home ? <SectionHome area={home} open={open} openPlaylist={(id) => { setHome(null); openPlaylist(id); }} openPractice={(view) => { setPracticeView(view); open("practice"); }} /> : source === "playlist" ? <PlaylistView id={playlistId ?? ""} onOpen={openPlaylist} onQueue={openQueue} onOpenSpotifyLocal={openSpotifyLocal} /> : source === "spotify-local" ? <SpotifyLocalPanel jobId={spotifyLocalJob} onOpenPlaylist={openPlaylist} /> : source === "practice" ? <PracticePanel key={practiceView} initialView={practiceView} /> : source === "auto-mashups" ? <MashipsView kind="auto" /> : source === "manual-mashups" ? <MashipsView kind="manual" /> : source === "queue" ? <AutoDJQueue /> : source === "local" ? <LocalView collection={collection} /> : source === "audius" ? <AudiusPane /> : <ProviderPane id={source} onPrepare={() => openSpotifyLocal(null)} />}
      </div>
    </div>
  );
}

function SectionHome({ area, open, openPlaylist, openPractice }: { area: MainBrowserArea; open: (s: Source, c?: LocalCollection) => void; openPlaylist: (id: string) => void; openPractice: (view: "practice" | "history") => void }) {
  const app = useApp(), lib = useLibraryState();
  const playlists = useFrameStore(useCallback((cb) => app.playlists.on("change", cb), [app.playlists]), () => app.playlists.getState());
  const mashups = useFrameStore(useCallback((cb) => app.liveMashup.on("change", cb), [app.liveMashup]), () => app.liveMashup.getState());
  const practice = useFrameStore(useCallback((cb) => app.practice.on("change", cb), [app.practice]), () => app.practice.getState());
  const streams = useStreamingState(), audius = useAudiusState();
  const recent=lib.tracks.filter(t=>t.addedAt&&Date.now()-t.addedAt<30*86400_000).length,rated=lib.tracks.filter(t=>(t.rating??0)>=4).length;
  const Tile=({icon,title,detail,onClick,accent}:{icon:string;title:string;detail:string;onClick:()=>void;accent?:string})=><button className="nav-tile" onClick={onClick} style={{["--tile-accent" as string]:accent}}><span className="nav-tile-icon">{icon}</span><span><b>{title}</b><small>{detail}</small></span><i>›</i></button>;
  let title="COLLECTIONS",tiles:React.ReactNode;
  if(area==="collections")tiles=<><Tile icon="♫" title="All Tracks" detail={`${lib.tracks.length} tracks`} onClick={()=>open("local","all")}/><Tile icon="◷" title="Recently Added" detail={`${recent} tracks from the last 30 days`} onClick={()=>open("local","recent")}/><Tile icon="★" title="Top Rated" detail={`${rated} tracks rated 4 stars or higher`} onClick={()=>open("local","rated")}/><Tile icon="◆" title="Practice Mode" detail="Build and review your mixing skills" onClick={()=>openPractice("practice")} accent="#39dca0"/></>;
  else if(area==="playlists"){title="PLAYLISTS";tiles=<>{playlists.playlists.map(p=><Tile key={p.id} icon="▤" title={p.name} detail={`${p.refs.length} tracks`} onClick={()=>openPlaylist(p.id)} accent="#4ca8ff"/>)}<Tile icon="＋" title="Create New Playlist" detail="Create an empty playlist, then add tracks" onClick={()=>{const p=app.playlists.create("New Playlist");openPlaylist(p.id)}} accent="#39dca0"/></>}
  else if(area==="mashups"){title="MASHUP PROJECTS";tiles=<><Tile icon="⚡" title="Auto Mashups" detail={`${mashups.recipes.filter(r=>!r.manual).length} saved projects`} onClick={()=>open("auto-mashups")} accent="#ff9f43"/><Tile icon="🎚" title="Manual Mashups" detail={`${mashups.recipes.filter(r=>!!r.manual).length} saved deck setups`} onClick={()=>open("manual-mashups")} accent="#d16cff"/></>}
  else if(area==="practice"){title="PRACTICE MODE";tiles=<><Tile icon="◇" title="DJ Training Curriculum" detail="Seven guided lessons, from beatmatching to effects transitions" onClick={()=>window.dispatchEvent(new CustomEvent("dbdj:navigate",{detail:"training"}))} accent="#ffd166"/><Tile icon="▶" title="Start or Continue Practice" detail="Choose difficulty and begin a mixing challenge" onClick={()=>openPractice("practice")} accent="#39dca0"/><Tile icon="↗" title="Practice History" detail={`${practice.history.length} sessions · review your progress`} onClick={()=>openPractice("history")} accent="#4ca8ff"/></>}
  else {title="STREAMING";tiles=<><Tile icon="◉" title="Spotify" detail={streams.spotify.status?.connected?"Connected":"Browse and configure Spotify"} onClick={()=>open("spotify")} accent="#1ed760"/><Tile icon="♪" title="Apple Music" detail={streams["apple-music"].status?.connected?"Connected":"Browse and configure Apple Music"} onClick={()=>open("apple-music")} accent="#fa586a"/><Tile icon="●" title="Audius" detail={audius.connection==="ok"?"Connected · free streaming":"Free music discovery"} onClick={()=>open("audius")} accent="#8b5cf6"/></>}
  return <div className="section-home"><div className="section-home-title"><b>{title}</b><span>Choose where you want to go</span></div><div className="nav-tiles">{tiles}</div></div>;
}

// ─────────────────────────────── Local ───────────────────────────────

type SortKey = "title" | "artist" | "album" | "genre" | "bpm" | "key" | "camelot" | "energy" | "durationMs" | "rating" | "addedAt";
const COLUMNS: { key: SortKey | null; label: string; cls?: string }[] = [
  { key: null, label: "", cls: "col-art" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "genre", label: "Genre" },
  { key: "bpm", label: "BPM", cls: "num" },
  { key: "key", label: "Key" },
  { key: "camelot", label: "Camelot" },
  { key: "energy", label: "Energy", cls: "num" },
  { key: null, label: "Match", cls: "num" },
  { key: "durationMs", label: "Time", cls: "num" },
  { key: "rating", label: "Rating" },
  { key: null, label: "Source" },
  { key: "addedAt", label: "Added" },
  { key: null, label: "Load" },
];

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="stars" onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={n <= value ? "on" : ""} onClick={() => onChange(n === value ? 0 : n)} aria-label={`${n} stars`}>
          ★
        </button>
      ))}
    </span>
  );
}

/** Sorting 20,000 titles: one shared collator is far faster than localeCompare with options. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ROW_OVERSCAN = 12;

interface RowHandlers {
  click: (t: TrackInfo, e: React.MouseEvent) => void;
  doubleClick: (t: TrackInfo) => void;
  dragStart: (t: TrackInfo, e: React.DragEvent) => void;
  contextMenu: (t: TrackInfo, e: React.MouseEvent) => void;
  rate: (t: TrackInfo, n: number) => void;
}

/** One library row; re-renders only when its own track, selection or match changes. */
const TrackRow = memo(function TrackRow({ track: t, selected, matchScore, matchReasons, stem, handlers }: {
  track: TrackInfo; selected: boolean; matchScore: number | null; matchReasons?: string; stem?: string; handlers: RowHandlers;
}) {
  return (
    <tr
      className={`track-row ${selected ? "selected" : ""}`}
      onClick={(e) => handlers.click(t, e)}
      onDoubleClick={() => handlers.doubleClick(t)}
      draggable
      onDragStart={(e) => handlers.dragStart(t, e)}
      onContextMenu={(e) => handlers.contextMenu(t, e)}
    >
      <td className="col-art">
        <ArtTile track={t} size={22} />
      </td>
      <td className="title-cell">{t.title}{t.unavailableReason && <span className="warn"> · Reconnect file</span>}</td>
      <td>{t.artist}</td>
      <td>{t.album}</td>
      <td>{t.genre ?? ""}</td>
      <td className="num">{t.bpm ? t.bpm.toFixed(1) : "—"}</td>
      <td>{t.key ?? "—"}</td>
      <td>{t.camelot ?? "—"}</td>
      <td className="num" title={t.analysisConfidence === undefined ? "Not analysed" : `${Math.round(t.analysisConfidence * 100)}% confidence`}>{t.energy ?? "—"}</td>
      <td className="num" title={matchReasons}>{matchScore ?? "—"}{matchScore !== null ? "%" : ""}</td>
      <td className="num">{fmtDuration(t.durationMs)}</td>
      <td>
        <Stars value={t.rating ?? 0} onChange={(n) => handlers.rate(t, n)} />
      </td>
      <td>
        <span className="source-badge">LOCAL</span>{" "}
        {stem && (
          <span className={`lib-stem ${stem}`} title={stem === "complete" ? "STEMS analysed and cached" : "STEMS partly analysed"}>
            {stem === "complete" ? "STEMS" : "STEMS…"}
          </span>
        )}
      </td>
      <td className="hint">{t.addedAt ? new Date(t.addedAt).toLocaleDateString() : ""}</td>
      <td className="row-actions">
        <LoadButtons track={t} />
      </td>
    </tr>
  );
});

/** Background analysis progress, kept out of the table so progress doesn't re-render it. */
function AnalysisProgress() {
  const { analysis } = useApp();
  const s = useFrameStore(useCallback((cb) => analysis.on("change", cb), [analysis]), () => analysis.getState());
  if (!s.busy) return null;
  return <><span className="hint">Analysing {s.done + 1}/{s.total}: {s.current}</span><button onClick={() => analysis.cancelBatch()}>Cancel</button></>;
}

function LocalView({ collection }: { collection: LocalCollection }) {
  const app = useApp();
  const { library, platform, engine, log, browser } = app;
  const state = useLibraryState();
  const freeDeck = useFreeDeck();
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: collection === "recent" ? "addedAt" : "artist", dir: collection === "recent" ? -1 : 1 });
  const stemIdx = useStemIndex();
  const [menu, setMenu] = useState<{ x: number; y: number; track: TrackInfo } | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [info, setInfo] = useState<TrackInfo | null>(null);
  const [advanced, setAdvanced] = useState({ minBpm: "", maxBpm: "", key: "", minEnergy: "", maxEnergy: "", genre: "", minMatch: "" });
  const [discovery, setDiscovery] = useState<DiscoveryMode | null>(null);
  // Match % is measured against the playing track (else the selected one). Only the playing
  // track's ref is watched, so engine updates don't re-render the table.
  const playingRef = useEngineValue((s) => s.decks.find((d) => d.playing)?.track?.ref ?? null);
  const playingTrack = useMemo(() => (playingRef ? engine.getState().decks.find((d) => d.track?.ref === playingRef)?.track ?? null : null), [playingRef, engine]);
  const reference = playingTrack ?? state.tracks[state.selected];
  const match = useCallback((t: TrackInfo) => reference && reference.ref !== t.ref ? compatibility(reference, t, app.preparation.forRef(reference.ref), app.preparation.forRef(t.ref)) : null, [reference, app.preparation]);
  // The list only depends on the reference while the Min match % filter is in use.
  const matchFilter = advanced.minMatch && reference ? match : null;

  useEffect(() => {
    if (collection === "recent") setSort({ key: "addedAt", dir: -1 });
    if (collection === "rated") setSort({ key: "rating", dir: -1 });
  }, [collection]);

  // What's on screen, in on-screen order (filter → collection → sort).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = state.tracks;
    if (collection === "recent") list = list.filter((t) => t.addedAt && Date.now() - t.addedAt < 30 * 86400_000);
    if (collection === "rated") list = list.filter((t) => (t.rating ?? 0) >= 4);
    if (q) list = list.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.genre ?? ""} ${t.key ?? ""}`.toLowerCase().includes(q));
    if (advanced.minBpm) list = list.filter((t) => (t.bpm ?? -Infinity) >= Number(advanced.minBpm));
    if (advanced.maxBpm) list = list.filter((t) => (t.bpm ?? Infinity) <= Number(advanced.maxBpm));
    if (advanced.key) list = list.filter((t) => [t.key, t.camelot].some((x) => x?.toLowerCase().includes(advanced.key.toLowerCase())));
    if (advanced.minEnergy) list = list.filter((t) => (t.energy ?? -Infinity) >= Number(advanced.minEnergy));
    if (advanced.maxEnergy) list = list.filter((t) => (t.energy ?? Infinity) <= Number(advanced.maxEnergy));
    if (advanced.genre) list = list.filter((t) => t.genre?.toLowerCase().includes(advanced.genre.toLowerCase()));
    if (matchFilter) list = list.filter((t) => (matchFilter(t)?.score ?? 0) >= Number(advanced.minMatch));
    const k = sort.key;
    return [...list].sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[k] ?? (typeof (b as unknown as Record<string, unknown>)[k] === "number" ? -1 : "");
      const vb = (b as unknown as Record<string, unknown>)[k] ?? (typeof va === "number" ? -1 : "");
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : COLLATOR.compare(String(va), String(vb));
      return c * sort.dir;
    });
  }, [state.tracks, query, sort, collection, advanced, matchFilter]);

  const selectedTrack = state.tracks[state.selected];
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // The controller's browse encoder / LOAD follow the on-screen order.
  useEffect(() => {
    const port = {
      moveSelection: (delta: number) => {
        const list = visibleRef.current;
        if (!list.length) return;
        const cur = list.findIndex((t) => t.ref === library.getSelected()?.ref);
        const next = list[Math.max(0, Math.min(list.length - 1, (cur < 0 ? 0 : cur + delta)))];
        library.select(library.getState().tracks.findIndex((t) => t.ref === next.ref));
      },
      getSelected: () => {
        const sel = library.getSelected();
        return sel && visibleRef.current.some((t) => t.ref === sel.ref) ? sel : visibleRef.current[0] ?? null;
      },
    };
    browser.setActive(port);
    return () => browser.setActive(library);
  }, [browser, library]);

  // Virtualised list: only the rows in view (plus a margin) are in the page — a library can
  // hold tens of thousands of tracks. Spacer rows keep the scrollbar the right size.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [rowH, setRowH] = useState(29);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    update();
    return () => { el.removeEventListener("scroll", onScroll); ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  // Measure the real row height once rows exist (font size / zoom).
  useLayoutEffect(() => {
    const row = wrapRef.current?.querySelector<HTMLTableRowElement>("tr.track-row");
    if (row && Math.abs(row.offsetHeight - rowH) > 0.5) setRowH(row.offsetHeight);
  });
  const first = Math.max(0, Math.floor(viewport.top / rowH) - ROW_OVERSCAN);
  const last = Math.min(visible.length, Math.ceil((viewport.top + viewport.height) / rowH) + ROW_OVERSCAN);

  // Keep the selected track in view when it moves (browse knob, keyboard).
  useEffect(() => {
    const el = wrapRef.current;
    const sel = state.tracks[state.selected];
    if (!el || !sel) return;
    const i = visibleRef.current.findIndex((t) => t.ref === sel.ref);
    if (i < 0) return;
    const header = el.querySelector("thead")?.offsetHeight ?? 0;
    const top = header + i * rowH;
    if (top < el.scrollTop + header) el.scrollTop = top - header;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [state.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Row handlers read the latest state through a ref so rows can be memoised.
  const selectedSet = useMemo(() => new Set(selectedRefs), [selectedRefs]);
  const live = useRef({ visible, selectedRefs, freeDeck, tracks: state.tracks });
  live.current = { visible, selectedRefs, freeDeck, tracks: state.tracks };
  const rowHandlers = useMemo<RowHandlers>(() => ({
    click: (t, e) => {
      const { visible: vis, selectedRefs: refs, tracks } = live.current;
      if (e.shiftKey && refs.length) {
        const a = vis.findIndex((x) => x.ref === refs[0]), b = vis.indexOf(t);
        setSelectedRefs(vis.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1).map((x) => x.ref));
      } else setSelectedRefs(e.ctrlKey || e.metaKey ? refs.includes(t.ref) ? refs.filter((r) => r !== t.ref) : [...refs, t.ref] : [t.ref]);
      library.select(tracks.indexOf(t));
    },
    doubleClick: (t) => {
      const fd = live.current.freeDeck;
      if (fd === null) log.warn("engine", "Both decks are playing — pause one to load.");
      else void engine.loadTrack(fd, t);
    },
    dragStart: (t, e) => {
      const refs = live.current.selectedRefs;
      e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(t));
      e.dataTransfer.setData(TRACK_REFS, JSON.stringify(refs.includes(t.ref) ? refs : [t.ref]));
      e.dataTransfer.effectAllowed = "copy";
    },
    contextMenu: (t, e) => {
      e.preventDefault();
      library.select(live.current.tracks.indexOf(t));
      if (!live.current.selectedRefs.includes(t.ref)) setSelectedRefs([t.ref]);
      setMenu({ x: e.clientX, y: e.clientY, track: t });
    },
    rate: (t, n) => void app.setRating(t.ref, n),
  }), [library, log, engine, app]);

  const add = async (folder: boolean) => {
    try {
      const files = folder ? await platform.pickFolder() : await platform.pickAudioFiles();
      if (files.length) await app.addFiles(files);
    } catch (err) {
      log.error("library", String(err));
    }
  };

  const headerClick = (k: SortKey | null) => k && setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }));

  return (
    <div
      className={`library ${dropping ? "drop-target" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void platform.refsFromDrop(files).then((refs) => app.addFiles(refs));
      }}
    >
      <div className="library-controls">
      <div className="toolbar">
        <input className="search-input" placeholder="Search title, artist, album, genre, key…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={() => void add(false)}>+ Add files…</button>
        <button onClick={() => void add(true)}>+ Add folder…</button>
        {platform.kind === "browser" && <button onClick={() => void add(false)}>Reconnect files</button>}
        <button onClick={() => setSelectedRefs(visible.map((t) => t.ref))}>Select all</button>
        <PlaylistActions refs={selectedRefs.length ? selectedRefs : selectedTrack ? [selectedTrack.ref] : []} />
        <button onClick={() => void app.analysis.analyseTracks((selectedRefs.length ? selectedRefs : selectedTrack ? [selectedTrack.ref] : []).map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t))}>ANALYSE TRACK</button>
        <button onClick={() => void app.analysis.analyseTracks(state.tracks, true)}>REANALYSE LIBRARY</button>
        <button disabled={!selectedTrack} onClick={() => setDiscovery("matches")}>FIND MATCHES</button>
        <button disabled={!selectedTrack} onClick={() => setDiscovery("djmix")}>CREATE DJMIX</button>
        <button disabled={!selectedTrack} onClick={() => setDiscovery("mashup")}>FIND MASHUPS</button>
        <AnalysisProgress />
        <span className="hint">
          {visible.length} of {state.tracks.length} tracks · double-click loads into a free deck · drag to a deck · browse knob + LOAD on the DDJ-SB
        </span>
      </div>
      <div className="advanced-filters">
        <input type="number" placeholder="Min BPM" value={advanced.minBpm} onChange={(e) => setAdvanced({ ...advanced, minBpm: e.target.value })}/><input type="number" placeholder="Max BPM" value={advanced.maxBpm} onChange={(e) => setAdvanced({ ...advanced, maxBpm: e.target.value })}/>
        <input placeholder="Key / Camelot" value={advanced.key} onChange={(e) => setAdvanced({ ...advanced, key: e.target.value })}/><input type="number" min="1" max="10" placeholder="Min energy" value={advanced.minEnergy} onChange={(e) => setAdvanced({ ...advanced, minEnergy: e.target.value })}/><input type="number" min="1" max="10" placeholder="Max energy" value={advanced.maxEnergy} onChange={(e) => setAdvanced({ ...advanced, maxEnergy: e.target.value })}/><input placeholder="Genre" value={advanced.genre} onChange={(e) => setAdvanced({ ...advanced, genre: e.target.value })}/><input type="number" min="0" max="100" placeholder="Min match %" value={advanced.minMatch} onChange={(e) => setAdvanced({ ...advanced, minMatch: e.target.value })}/>
        <button onClick={() => setAdvanced({ ...advanced, minEnergy: "4", maxEnergy: "6" })}>Warm Up</button><button onClick={() => setAdvanced({ ...advanced, minEnergy: "7", maxEnergy: "10" })}>Peak Hour Bangers</button><button onClick={() => setAdvanced({ minBpm: "", maxBpm: "", key: "", minEnergy: "", maxEnergy: "", genre: "", minMatch: "" })}>Clear</button>
      </div>
      </div>
      <div className="table-wrap" ref={wrapRef}>
        <table className="tracks">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.label || "art"} className={`${c.cls ?? ""} ${c.key ? "sortable" : ""}`} onClick={() => headerClick(c.key)}>
                  {c.label}
                  {c.key && sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.tracks.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty dropzone">
                  <div className="dropzone-big">⤓ Drop audio files or folders here</div>
                  or use <b>+ Add files…</b> / <b>+ Add folder…</b>. Files are referenced in place, never moved or modified.
                </td>
              </tr>
            )}
            {first > 0 && <tr className="spacer" aria-hidden="true" style={{ height: first * rowH }}><td colSpan={COLUMNS.length} /></tr>}
            {visible.slice(first, last).map((t) => {
              const m = reference ? match(t) : null;
              return (
                <TrackRow
                  key={t.ref}
                  track={t}
                  selected={selectedSet.has(t.ref) || t.ref === selectedTrack?.ref}
                  matchScore={m?.score ?? null}
                  matchReasons={m?.reasons.join(" · ")}
                  stem={stemIdx[t.ref]}
                  handlers={rowHandlers}
                />
              );
            })}
            {last < visible.length && <tr className="spacer" aria-hidden="true" style={{ height: (visible.length - last) * rowH }}><td colSpan={COLUMNS.length} /></tr>}
          </tbody>
        </table>
      </div>
      {info && <TrackDetails track={state.tracks.find((t) => t.ref === info.ref) ?? info} onClose={() => setInfo(null)} />}
      {menu && <TrackMenu {...menu} refs={selectedRefs.includes(menu.track.ref) ? selectedRefs : [menu.track.ref]} cached={!!stemIdx[menu.track.ref]} onInfo={() => setInfo(menu.track)} onClose={() => setMenu(null)} />}
      {discovery && selectedTrack && <DiscoveryDialog mode={discovery} start={selectedTrack} tracks={state.tracks} onClose={() => setDiscovery(null)} />}
    </div>
  );
}

/** Right-click menu for a local track: load, and STEM cache management. */
function TrackMenu({ x, y, track, refs, cached, onInfo, onClose }: { x: number; y: number; track: TrackInfo; refs: string[]; cached: boolean; onInfo: () => void; onClose: () => void }) {
  const { engine, stems, platform, analysis, library } = useApp();
  const s = useEngineState();
  const stemStatus = useStemStatus();
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const act = (fn: () => void) => (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onClose();
  };
  const canAnalyse = stemStatus.modelInstalled && platform.kind === "desktop";
  return (
    <div className="ctx-menu" style={{ left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - 160) }} onPointerDown={(e) => e.stopPropagation()}>
      {s.decks.map((d, i) => (
        <button key={i} disabled={d.playing} onClick={act(() => void engine.loadTrack(i, track))}>
          Load to Deck {String.fromCharCode(65 + i)}
        </button>
      ))}
      <hr />
      <PlaylistActions refs={refs} onDone={onClose} />
      <button onClick={act(onInfo)}>Track information</button>
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t)))}>Analyse selected</button>
      <button onClick={act(() => void analysis.analyseTracks(refs.map((r) => library.getByRef(r)).filter((t): t is TrackInfo => !!t), true))}>Reanalyse selected</button>
      <button disabled={!canAnalyse} title={canAnalyse ? "" : stemStatus.reason} onClick={act(() => stems.analyse([track], (r) => platform.readAudio(r)))}>
        Analyse STEMS
      </button>
      <button disabled={!cached} onClick={act(() => void stems.removeCache([track.ref]))}>
        Remove STEM Cache
      </button>
    </div>
  );
}

function LoadButtons({ track }: { track: TrackInfo }) {
  const { engine } = useApp();
  const playing = usePlayingFlags();
  return (
    <>
      {[...playing].map((flag, i) => (
        <button
          key={i}
          className={`tiny ${i === 0 ? "deck-a-btn" : "deck-b-btn"}`}
          disabled={flag === "1"}
          title={flag === "1" ? `Deck ${String.fromCharCode(65 + i)} is playing` : `Load into deck ${String.fromCharCode(65 + i)}`}
          onClick={(e) => {
            e.stopPropagation();
            void engine.loadTrack(i, track);
          }}
        >
          → {String.fromCharCode(65 + i)}
        </button>
      ))}
    </>
  );
}

// ─────────────────────────────── Streaming ───────────────────────────────

function ProviderPane({ id, onPrepare }: { id: StreamingProviderId; onPrepare: () => void }) {
  const { streaming } = useApp();
  const view = useStreamingState()[id];
  const name = PROVIDER_NAMES[id];

  useEffect(() => {
    void streaming.refresh(id);
  }, [streaming, id]);

  if (!streaming.available) {
    return (
      <div className="provider-msg">
        <h3>{name}</h3>
        <p>Connecting streaming accounts needs the desktop app (npm run dev / the installed app). It isn't available in browser mode.</p>
      </div>
    );
  }
  if (!view.status) return <div className="provider-msg">{view.error ? `⚠ ${view.error}` : "Loading…"}</div>;

  return (
    <div className="provider">
      <RestrictionBanner id={id} />
      {view.error && <div className="provider-error">⚠ {view.error}</div>}
      {!view.status.configured ? (
        id === "spotify" ? <SpotifySetup view={view} /> : <AppleSetup view={view} />
      ) : !view.status.connected ? (
        <ConnectStep id={id} view={view} />
      ) : (
        <ConnectedView id={id} view={view} onPrepare={onPrepare} />
      )}
    </div>
  );
}

function RestrictionBanner({ id }: { id: StreamingProviderId }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="restriction">
      🔎 <b>Smart Match:</b> {PROVIDER_NAMES[id]} is your discovery &amp; playlist source. When you load a track, the app finds the same
      recording (by ISRC, then title/artist/version/length) in your <b>local library</b> and plays that file. {PROVIDER_NAMES[id]} audio itself is
      never used — its terms don't allow mixing in third-party apps.{" "}
      <button className="linklike" onClick={() => setOpen((o) => !o)}>{open ? "Hide details" : "Why?"}</button>
      {open && <p className="hint">{PROVIDER_CAPABILITIES[id].restriction}</p>}
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-field">
      <code>{value}</code>
      <button
        className="tiny"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </span>
  );
}

function SpotifySetup({ view }: { view: ProviderView }) {
  const { streaming, platform } = useApp();
  const [clientId, setClientId] = useState("");
  const redirect = view.status?.redirectUri ?? "http://127.0.0.1:43821/callback";
  return (
    <div className="setup">
      <h3>Connect Spotify Premium</h3>
      <p className="hint">Spotify only lets apps sign in with a Client ID you create (free, about 2 minutes). You only need to do this once.</p>
      <ol>
        <li>
          Open the{" "}
          <button className="linklike" onClick={() => platform.openExternal("https://developer.spotify.com/dashboard")}>
            Spotify Developer Dashboard
          </button>{" "}
          and log in with your Premium account → <b>Create app</b>.
        </li>
        <li>
          Name it anything (e.g. "My DJ app"). Under <b>Redirect URIs</b> add exactly: <CopyField value={redirect} />
        </li>
        <li>
          Tick <b>Web API</b>, accept the terms and save.
        </li>
        <li>
          Open <b>Settings</b> of the new app, copy the <b>Client ID</b> and paste it here:
        </li>
      </ol>
      <div className="row">
        <input className="wide" placeholder="Spotify Client ID (32 characters)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <button className="primary" disabled={view.busy || clientId.trim().length < 32} onClick={() => void streaming.configure("spotify", { clientId })}>
          Save
        </button>
      </div>
      <p className="hint">
        Spotify limits personal ("development mode") apps to 5 accounts and requires Premium. To let another account connect, add
        its email under <b>User Management</b> in the dashboard.
      </p>
    </div>
  );
}

function AppleSetup({ view }: { view: ProviderView }) {
  const { streaming, platform } = useApp();
  const [mode, setMode] = useState<"key" | "token">("key");
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [token, setToken] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = mode === "token" ? token.trim().length > 20 : teamId.trim() && keyId.trim() && privateKey.includes("PRIVATE KEY");
  return (
    <div className="setup">
      <h3>Connect Apple Music</h3>
      <p className="hint">
        Apple requires every app that reads Apple Music to have a <b>MusicKit key</b> from an{" "}
        <button className="linklike" onClick={() => platform.openExternal("https://developer.apple.com/programs/")}>
          Apple Developer Program
        </button>{" "}
        membership. Your Apple Music subscription alone is not enough — this is Apple's rule, not ours.
      </p>
      <div className="row">
        <label>
          <input type="radio" checked={mode === "key"} onChange={() => setMode("key")} /> I have a MusicKit key (.p8)
        </label>
        <label>
          <input type="radio" checked={mode === "token"} onChange={() => setMode("token")} /> I have a developer token
        </label>
      </div>
      {mode === "key" ? (
        <>
          <ol>
            <li>
              In{" "}
              <button className="linklike" onClick={() => platform.openExternal("https://developer.apple.com/account/resources/authkeys/list")}>
                Certificates, IDs &amp; Profiles → Keys
              </button>{" "}
              create a key with <b>Media Services (MusicKit)</b> enabled and download the <code>AuthKey_XXXXXXXXXX.p8</code> file.
            </li>
            <li>Your <b>Team ID</b> is shown under Membership details; the <b>Key ID</b> is shown next to the key.</li>
          </ol>
          <div className="form-grid">
            <span>Team ID</span>
            <input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="e.g. A1B2C3D4E5" />
            <span>Key ID</span>
            <input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="e.g. 9Z8Y7X6W5V" />
            <span>Private key</span>
            <span>
              <button onClick={() => fileRef.current?.click()}>{privateKey ? "✓ Key loaded — change…" : "Choose .p8 file…"}</button>
              <input
                ref={fileRef}
                type="file"
                accept=".p8"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(setPrivateKey);
                }}
              />
            </span>
          </div>
          <p className="hint">The key is stored encrypted by your operating system's keychain and only used to sign Apple Music API requests.</p>
        </>
      ) : (
        <textarea className="wide" rows={4} placeholder="Paste a MusicKit developer token (JWT)" value={token} onChange={(e) => setToken(e.target.value)} />
      )}
      <div className="row">
        <button
          className="primary"
          disabled={view.busy || !ready}
          onClick={() => void streaming.configure("apple-music", mode === "token" ? { developerToken: token } : { teamId, keyId, privateKey })}
        >
          {view.busy ? "Checking with Apple…" : "Save & verify"}
        </button>
      </div>
    </div>
  );
}

function ConnectStep({ id, view }: { id: StreamingProviderId; view: ProviderView }) {
  const { streaming } = useApp();
  return (
    <div className="setup">
      <h3>{PROVIDER_NAMES[id]} is set up — sign in to your account</h3>
      <p className="hint">
        Your web browser will open for you to sign in to {PROVIDER_NAMES[id]} and approve <b>read-only</b> access to your library and playlists.
        Then come back here.
      </p>
      <div className="row">
        <button className="primary big" disabled={view.busy} onClick={() => void streaming.connect(id)}>
          {view.busy ? "Waiting for you to sign in in the browser…" : `Connect ${PROVIDER_NAMES[id]} account`}
        </button>
        <button disabled={view.busy} onClick={() => void streaming.disconnect(id, true)}>
          Change credentials
        </button>
      </div>
    </div>
  );
}

const LOCKED_HELP =
  "Spotify only gives this app the tracks of playlists you own or collaborate on. To use one fully, copy its tracks into one of your playlists in Spotify (select all → Add to playlist → New playlist).";

function ConnectedView({ id, view, onPrepare }: { id: StreamingProviderId; view: ProviderView; onPrepare: () => void }) {
  const { streaming } = useApp();
  const [q, setQ] = useState("");
  // Locked playlists can still be read with an installed spotDL (desktop), slowly the first time.
  const sl = useSpotifyLocal();
  const viaSpotdl = id === "spotify" && !!sl.providers.find((p) => p.id === "spotdl")?.state?.available;
  return (
    <div className="connected">
      <div className="toolbar">
        <span className="status ok">● {view.status?.account ?? "Connected"}</span>
        {view.status?.detail && <span className="warn">⚠ {view.status.detail}</span>}
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void streaming.search(id, q);
          }}
        >
          <input placeholder={`Search ${PROVIDER_NAMES[id]}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit">Search</button>
        </form>
        <button onClick={() => void streaming.loadPlaylists(id)}>↻</button>
        <button onClick={() => void streaming.disconnect(id)}>Disconnect</button>
      </div>
      <div className="provider-split">
        <ul className="playlists">
          {view.playlists.filter((p) => p.readable).map((p) => (
            <li key={p.id}>
              <button className={view.selected === p.id ? "active" : ""} onClick={() => void streaming.openPlaylist(id, p.id)}>
                {p.name}
                {p.trackCount ? <span className="count">{p.trackCount}</span> : null}
              </button>
            </li>
          ))}
          {view.playlists.some((p) => !p.readable) && (
            <li className="playlists-locked-heading" title={LOCKED_HELP}>
              🔒 By other people <span className="hint">({view.playlists.filter((p) => !p.readable).length})</span>
              <div className="hint">{viaSpotdl ? "Spotify doesn't share their tracks with this app. Click one to read it with spotDL (the first read can take several minutes)." : "Spotify doesn't share their tracks with this app."}</div>
            </li>
          )}
          {view.playlists.filter((p) => !p.readable).map((p) => (
            <li key={p.id}>
              <button
                className={`locked ${view.selected === p.id ? "active" : ""}`}
                disabled={!viaSpotdl}
                title={`${p.note ?? ""} — ${viaSpotdl ? "read with spotDL (slow the first time, then cached)" : LOCKED_HELP}`}
                onClick={() => void streaming.openPlaylist(id, p.id)}
              >
                <span>🔒 {p.name}</span>
                {p.trackCount ? <span className="count">{p.trackCount}</span> : null}
              </button>
            </li>
          ))}
          {view.playlists.length === 0 && !view.loading && <li className="hint">No playlists</li>}
        </ul>
        <StreamingTracks view={view} onPrepare={id === "spotify" ? onPrepare : undefined} />
      </div>
    </div>
  );
}

function useMatchingTick(): void {
  const { matching } = useApp();
  const [, force] = useState(0);
  useEffect(() => {
    let frame = 0;
    return matching.on("change", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        force((n) => n + 1);
      });
    });
  }, [matching]);
}

function MatchBadge({ r }: { r: ResolutionResult | undefined }) {
  const { matching } = useApp();
  if (!r) return <span className="match-badge pending">…</span>;
  const srcId = r.best?.source ?? r.cachedMapping?.audioSource;
  const src = srcId ? matching.sourceName(srcId).toUpperCase().replace("LOCAL LIBRARY", "LOCAL") : "";
  switch (r.status) {
    case "resolved":
      return <span className="match-badge ok" title={`${r.confidence}% · ${r.method}${r.userConfirmed ? " · your saved match" : ""}`}>✓ {src} {r.confidence}%</span>;
    case "possible":
      return <span className="match-badge warn" title="Check before loading">⚠ {src} POSSIBLE {r.confidence}%</span>;
    case "ambiguous":
      return <span className="match-badge warn" title="Several versions match">⇆ {r.candidates.length} MATCHES</span>;
    default:
      return <span className="match-badge none">✕ NO PLAYABLE SOURCE</span>;
  }
}

/** Per-row Spotify → Local download into the "Downloads" playlist, showing that track's live state. */
function DownloadButton({ track }: { track: StreamingTrack }) {
  const { spotifyLocal } = useApp();
  useSpotifyLocal(); // re-render as the entry moves through its states
  const e = spotifyLocal.downloadEntry(track.id);
  const go = () => spotifyLocal.downloadTrack(track);
  if (!e) {
    return (
      <button className="tiny sl-dl" onClick={go} title={`Download into the "Downloads" playlist (library → watched folder → download providers). ${PERMISSION_REMINDER}`}>
        ⇩ Download
      </button>
    );
  }
  const busy = e.state === "pending" || e.state === "matching" || e.state === "importing" || e.state === "downloading";
  const label =
    e.state === "downloading" ? `⇩ ${Math.round((e.progress ?? 0) * 100)}%`
    : busy ? "⇩ …"
    : PLAYABLE_STATES.has(e.state) ? "✓ Downloaded"
    : e.state === "needs-review" ? "? Review"
    : e.state === "awaiting-file" ? "⏳ Retry"
    : "✕ Retry";
  const retry = e.state === "failed" || e.state === "cancelled" || e.state === "awaiting-file";
  return (
    <button
      className={`tiny sl-dl st-${e.state}`}
      disabled={busy || PLAYABLE_STATES.has(e.state) || e.state === "needs-review"}
      onClick={retry ? go : undefined}
      title={`${STATE_LABEL[e.state]}${e.detail ? ` — ${e.detail}` : ""}${e.state === "needs-review" ? " (open Spotify → Local → Downloads to choose)" : ""}`}
    >
      {label}
    </button>
  );
}

function StreamingTracks({ view, onPrepare }: { view: ProviderView; onPrepare?: () => void }) {
  const { platform, matching, spotifyLocal } = useApp();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [view.selected]);
  const prepare = () => {
    if (!onPrepare) return;
    if (view.selected === "search") {
      const chosen: StreamingTrack[] = view.tracks.filter((t) => picked.has(t.id));
      if (!chosen.length) return;
      spotifyLocal.previewSelection(chosen, `Spotify picks ${new Date().toLocaleDateString()}`);
    } else if (view.selected) void spotifyLocal.preview(view.selected === "__liked__" ? { type: "liked", id: "__liked__" } : { type: "playlist", id: view.selected });
    onPrepare();
  };
  const engineState = useEngineState();
  useMatchingTick();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  useEffect(() => matching.on("progress", setProgress), [matching]);
  // Resolve the visible list against the local library as soon as it's shown (instant, all local).
  useEffect(() => {
    if (view.tracks.length) void matching.resolveList(view.tracks);
  }, [view.tracks, matching]);

  if (view.loading) {
    const theirs = view.playlists.find((p) => p.id === view.selected)?.note;
    return (
      <div className="provider-msg">
        Loading…
        {theirs && <p className="hint">{theirs}: Spotify doesn't share other people's playlists with this app, so the desktop app reads it with your installed spotDL. The first time can take a few minutes for a big playlist; after that it opens instantly.</p>}
      </div>
    );
  }
  if (!view.selected) return <div className="provider-msg">Choose a playlist or search.</div>;
  const results = view.tracks.map((t) => matching.resultFor(t));
  const sum = summarize(results);
  const review = results.filter((r) => r && (r.status === "possible" || r.status === "ambiguous")).length;

  return (
    <div className="table-wrap">
      <div className="toolbar match-summary">
        <b>{view.tracks.length}</b> tracks ·{" "}
        {Object.entries(sum.bySource).map(([s, n]) => (
          <span key={s} className="ok-text">
            {n} {matching.sourceName(s).replace("Local Library", "Local")} ·{" "}
          </span>
        ))}
        <span className="warn">{review} to review</span> · <span className="hint">{sum.unavailable} unavailable</span> ·{" "}
        <b>
          {sum.playable} / {view.tracks.length} PLAYABLE
        </b>
        {progress && <span className="hint"> · matching {progress.done}/{progress.total}…</span>}
        <button
          disabled={resolving}
          title="Match every track now (local library + connected DJ services) and cache the results before your set"
          onClick={() => {
            setResolving(true);
            void matching.preResolve(view.tracks).finally(() => setResolving(false));
          }}
        >
          {resolving ? "Resolving…" : "⟳ Resolve playlist"}
        </button>
        {onPrepare && (
          <button
            className="primary"
            disabled={view.selected === "search" && picked.size === 0}
            title={view.selected === "search" ? "Tick the tracks to prepare as a local playlist" : "Create a local playlist of real files in this playlist's order"}
            onClick={prepare}
          >
            ⇄ Prepare Local Playlist{view.selected === "search" ? ` (${picked.size})` : ""}
          </button>
        )}
      </div>
      {onPrepare && <p className="sl-permission sl-permission-compact">⚖ ⇩ Download saves a track into your “Downloads” playlist. {PERMISSION_REMINDER}</p>}
      <table>
        <thead>
          <tr>
            {onPrepare && view.selected === "search" && <th />}
            <th />
            <th>Title</th>
            <th>Artist</th>
            <th>Time</th>
            <th>Metadata</th>
            <th>Playable source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.tracks.map((t, i) => {
            const r = results[i];
            return (
              <tr
                key={t.id}
                className={r?.status === "resolved" ? "" : "stream-only"}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(toTrackInfo(t)));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => matching.inspect(t)}
              >
                {onPrepare && view.selected === "search" && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${t.title} for a local playlist`}
                      checked={picked.has(t.id)}
                      onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })}
                    />
                  </td>
                )}
                <td>{t.artworkUrl ? <img className="art" src={t.artworkUrl} alt="" loading="lazy" /> : null}</td>
                <td>{t.title}</td>
                <td>{t.artist}</td>
                <td>{fmtDuration(t.durationMs)}</td>
                <td>
                  <span className={`source-badge ${t.provider}`}>{t.provider === "spotify" ? "SPOTIFY" : "APPLE MUSIC"}</span>
                </td>
                <td>
                  <button className="linklike badge-btn" onClick={() => matching.inspect(t)} title="Match details">
                    <MatchBadge r={r} />
                  </button>
                </td>
                <td className="row-actions">
                  {engineState.decks.map((d, deck) => (
                    <button
                      key={deck}
                      className={`tiny ${deck === 0 ? "deck-a-btn" : "deck-b-btn"}`}
                      disabled={d.playing}
                      title={r?.status === "resolved" ? `Load the matched file into deck ${String.fromCharCode(65 + deck)}` : "Find a playable version first"}
                      onClick={() => void matching.loadToDeck(deck, toTrackInfo(t), t)}
                    >
                      → {String.fromCharCode(65 + deck)}
                    </button>
                  ))}
                  {onPrepare && t.provider === "spotify" && <DownloadButton track={t} />}
                  {t.externalUrl && (
                    <button className="tiny" title="Open in the service's own app" onClick={() => platform.openExternal(t.externalUrl!)}>
                      ↗
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

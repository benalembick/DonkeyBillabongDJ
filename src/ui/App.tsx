import { Component, useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { App as AppServices } from "../app/createApp";
import type { ControllerInfo } from "../controllers/ControllerManager";
import type { LogEntry } from "../core/log";
import { AppContext, useApp, useEngineState } from "./context";
import { ControllerTest, LiveEvents, MidiMonitor } from "./ControllerPanels";
import { Deck } from "./Deck";
import { DownloadDesktopButton } from "./DownloadDesktop";
import { UpdateBadge } from "./Updates";
import { NavIcon, SaveMashupIcon, ToolsIcon } from "./NavIcons";
import { useFrameStore, useTick } from "./hooks";
import { LibraryPanel, type MainBrowserArea } from "./LibraryPanel";
import { MatchDialogHost } from "./MatchDialog";
import { Mixer } from "./Mixer";
import { Diagnostics, Settings } from "./SystemPanels";
import { FxBar, FxSummary } from "./FxBar";
import { LiveSamplerBar } from "./LiveSamplerBar";
import { getLayout, setLayout, useLayout, zoom, type LayoutMode } from "./layout";
import { WaveformStack } from "./Waveforms";
import brandLogo from "../assets/donkey-billabong-dj-logo.png";
import { About } from "./About";
import { WaveStylePicker } from "./WaveStylePicker";
import { LightingWorkspace } from "./lighting/LightingWorkspace";
import { ProductionStudioWorkspace } from "./ProductionStudioWorkspace";
import { SetStudioWorkspace } from "./setstudio/SetStudioWorkspace";

/** Contains UI crashes to one panel; the engine/audio keep running regardless. */
class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="panel-error">
          ⚠ {this.props.name} crashed: {this.state.error.message}{" "}
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ControllerStatus() {
  const { controllers } = useApp();
  const list = useFrameStore<ControllerInfo[]>(
    useCallback((cb) => controllers.on("controllers", cb), [controllers]),
    () => controllers.getControllers(),
  );
  useTick(1000);
  const mapped = list.filter((c) => c.mappingId);
  const connected = mapped.find((c) => c.connected);
  if (controllers.getAvailability() === "unsupported") return <span className="status warn">▲ MIDI unavailable</span>;
  if (controllers.getAvailability() === "denied") return <span className="status warn">▲ MIDI access denied</span>;
  if (connected) return <span className="status ok">● {connected.mappingName} — Connected</span>;
  const lost = mapped.find((c) => !c.connected);
  if (lost) return <span className="status warn blink">▲ {lost.mappingName} disconnected — playback continues</span>;
  return <span className="status idle">○ No DJ Controller Detected</span>;
}

function AudioStatusBadge() {
  const { audio } = useApp();
  useTick(1000);
  const s = audio.getStatus();
  if (s.state === "suspended") {
    return (
      <button className="status warn" onClick={() => void audio.start()}>
        ▲ Audio suspended — click to start
      </button>
    );
  }
  if (s.state !== "running") return <span className="status warn">▲ Audio {s.state}{s.error ? `: ${s.error}` : ""}</span>;
  return (
    <span className="status ok" title={s.backend}>
      ● Audio {s.sampleRate / 1000} kHz · {((s.baseLatency + s.outputLatency) * 1000).toFixed(0)} ms · {s.routing}
    </span>
  );
}

const TOOL_TABS = ["Controller events", "Controller test", "MIDI monitor", "Diagnostics", "Settings", "About"] as const;
type ToolTab = (typeof TOOL_TABS)[number];

/** Transient notices for warnings/errors (e.g. "deck is playing", "Spotify audio can't be mixed"). */
function Toasts() {
  const { log } = useApp();
  const [items, setItems] = useState<LogEntry[]>([]);
  useEffect(
    () =>
      log.on("entry", (e) => {
        const notable = e.level === "warn" || e.level === "error" || e.source === "mashup" || (e.source === "library" && e.message.startsWith("Added")) || e.source === "streaming" || (e.source === "matching" && !e.message.startsWith("Resolving")) || (e.source === "library" && e.message.startsWith("Read tags"));
        if (!notable || e.source === "controllers") return;
        setItems((xs) => [...xs.slice(-3), e]);
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== e.id)), e.level === "info" ? 3500 : 7000);
      }),
    [log],
  );
  return (
    <div className="toasts">
      {items.map((e) => (
        <div key={e.id} className={`toast toast-${e.level}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== e.id))}>
          {e.level === "error" ? "⛔ " : e.level === "warn" ? "⚠ " : "✓ "}
          {e.message}
        </div>
      ))}
    </div>
  );
}

/** Close a popover on a click outside `ref` or on Escape. */
function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open, close, ref]);
}

const MODES: { id: LayoutMode; label: string; title: string }[] = [
  { id: "horizontal", label: "HORIZONTAL", title: "Stacked horizontal waveforms, decks and mixer below" },
  { id: "vertical", label: "VERTICAL", title: "Parallel vertical waveforms in the centre, decks either side" },
  { id: "classic", label: "CLASSIC", title: "Slim waveforms, compact decks, bigger library" },
];

function LayoutSwitch() {
  const { liveMashup, log } = useApp();
  const engine = useEngineState();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mode, zoomSeconds } = useLayout();
  const canSave = engine.decks.slice(0, 2).every((d) => d.status === "ready" && d.track);
  const saveManual = async () => {
    setSaving(true);
    try {
      const recipe = await liveMashup.saveManualMashup();
      if (recipe) log.info("mashup", `${recipe.name} saved to Mashup Projects`);
      else log.warn("mashup", "Load a track into both decks before saving a Manual Mashup");
    } catch (e) { log.error("mashup", `Could not save Manual Mashup: ${String(e)}`); }
    finally { setSaving(false); }
  };
  useDismiss(open, useCallback(() => setOpen(false), []), menuRef);
  return (
    <div className="layout-actions">
      <div className="view-menu-wrap" ref={menuRef}>
        <button className={`view-menu-trigger ${open ? "active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}><span>▣</span> VIEW</button>
        {open && <div className="view-popover" role="menu">
          <b>DECK VIEW</b>
          <div className="layout-switch" role="group" aria-label="View options">
            {MODES.map((m) => <button key={m.id} className={mode === m.id ? "active" : ""} title={m.title} onClick={() => { setLayout({ mode: m.id }); setOpen(false); }}>{m.label}</button>)}
          </div>
          <b>WAVEFORM STYLE</b>
          <WaveStylePicker compact />
          <div className="view-zoom"><span>WAVEFORM ZOOM</span><button className="tiny" onClick={() => zoom(-1)} aria-label="Zoom in">＋</button><output>{zoomSeconds}s</output><button className="tiny" onClick={() => zoom(1)} aria-label="Zoom out">－</button></div>
        </div>}
      </div>
      <button className="manual-mashup-save" disabled={!canSave || saving} title="Save the current tracks, positions, tempo, STEMS, mixer, filters and effects as an editable Mashup Project" onClick={() => void saveManual()}>
        <SaveMashupIcon />
        <span>{saving ? "SAVING…" : "SAVE MANUAL MASHUP"}</span>
      </button>
    </div>
  );
}

const UTILITIES: { tool: ToolTab; icon: string; label: string; title: string; extra?: string }[] = [
  { tool: "Controller events", icon: "🎛", label: "Controller", title: "Controller events, test and MIDI monitor", extra: "open-tools" },
  { tool: "Diagnostics", icon: "◫", label: "Diagnostics", title: "Audio, engine and performance diagnostics" },
  { tool: "Settings", icon: "⚙", label: "Settings", title: "Audio output, library and app settings" },
  { tool: "About", icon: "ⓘ", label: "About", title: "Version, updates and features" },
];

/** Controller / Diagnostics / Settings / About behind one icon at the far right of the top bar. */
function UtilityMenu({ onOpen }: { onOpen: (t: ToolTab) => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 48, right: 10 });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, useCallback(() => setOpen(false), []), ref);
  // Fixed position (the status area clips overflow), anchored under the trigger when it opens.
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ top: Math.round(r.bottom + 6), right: Math.max(4, Math.round(window.innerWidth - r.right)) });
    setOpen((v) => !v);
  };
  return (
    <div className="utility-menu-wrap" ref={ref}>
      <button className={`utility-menu-trigger${open ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label="Tools: Controller, Diagnostics, Settings, About" title="Controller · Diagnostics · Settings · About" onClick={toggle}>
        <ToolsIcon />
      </button>
      {/* Always mounted (just hidden) so smoke tests can still click .open-tools / the last utility-button directly. */}
      <div className="utility-menu" role="menu" hidden={!open} style={anchor}>
        {UTILITIES.map((u) => (
          <button key={u.tool} role="menuitem" className={`utility-button${u.extra ? ` ${u.extra}` : ""}`} title={u.title} onClick={() => { setOpen(false); onOpen(u.tool); }}>
            <span aria-hidden="true">{u.icon}</span> {u.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const FX_OPEN_KEY = "dbdj.ui.fxOpen";
const readFxOpen = (): boolean => { try { return localStorage.getItem(FX_OPEN_KEY) === "1"; } catch { return false; } };

/** True while a training step is outlining FX1/FX2, so the full controls show even if the strip is collapsed. */
function useTrainingWantsFx(): boolean {
  const [wants, setWants] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setWants(/(^|\s)fx-\d/.test(root.getAttribute("data-train-hl") ?? ""));
    read();
    const watch = new MutationObserver(read);
    watch.observe(root, { attributes: true, attributeFilter: ["data-train-hl"] });
    return () => watch.disconnect();
  }, []);
  return wants;
}

/**
 * FX1/FX2 + Sampler. Collapsed (the default) it's one slim row: an FX toggle with a status chip per unit
 * (lit effects only; it stays visible when expanded too), then the sampler head. Expanded, the full FX units open beneath
 * that row, so the FX toggle stays where it was clicked.
 */
function TopTools() {
  const [fxOpen, setFxOpen] = useState(readFxOpen);
  const training = useTrainingWantsFx();
  const showFx = fxOpen || training;
  const toggleFx = (to = !fxOpen) => { setFxOpen(to); try { localStorage.setItem(FX_OPEN_KEY, to ? "1" : "0"); } catch { /* storage unavailable */ } };
  const fxLeading = (
    <>
      <button className="fx-strip-toggle" aria-expanded={showFx} aria-controls="fx-bar" disabled={training && !fxOpen} onClick={() => toggleFx()} title={showFx ? "Hide the FX controls" : "Show the FX controls"}>
        <span aria-hidden>{showFx ? "▾" : "▸"}</span> FX
      </button>
      <FxSummary expanded={showFx} onToggle={() => { if (!(training && !fxOpen)) toggleFx(); }} />
      <span className="top-tools-divider" aria-hidden />
    </>
  );
  return (
    <div className={`top-tools${showFx ? " fx-open" : ""}`}>
      <Boundary name="Sampler"><LiveSamplerBar leading={fxLeading} afterHead={showFx && <div id="fx-bar" className="fx-bar-slot"><Boundary name="FX"><FxBar /></Boundary></div>} /></Boundary>
    </div>
  );
}

function ToolsOverlay({ tab, setTab, onClose }: { tab: ToolTab; setTab: (t: ToolTab) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="tools-overlay" role="dialog" aria-label="Tools">
      <div className="tools-head">
        <nav className="tabs">
          {TOOL_TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="tools-body">
        <Boundary name={tab}>
          {tab === "Controller events" && <LiveEvents />}
          {tab === "Controller test" && <ControllerTest />}
          {tab === "MIDI monitor" && <MidiMonitor />}
          {tab === "Diagnostics" && <Diagnostics />}
          {tab === "Settings" && <Settings />}
          {tab === "About" && <About />}
        </Boundary>
      </div>
    </div>
  );
}

/** Drag handle between the performance area and the library (height saved per layout). */
function Splitter({ mode, maximized, onToggleMaximize }: { mode: LayoutMode; maximized: boolean; onToggleMaximize: () => void }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className={`splitter${maximized ? " maximized" : ""}`}
      title={maximized ? "Library focus view is open (double-click to restore)" : "Drag to resize the library (double-click to expand)"}
      onPointerDown={(e) => {
        if (maximized || e.target !== e.currentTarget) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, h: getLayout().libraryHeight[mode] };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const h = Math.max(160, Math.min(window.innerHeight * 0.75, s.h - (e.clientY - s.y)));
        setLayout({ libraryHeight: { ...getLayout().libraryHeight, [mode]: Math.round(h) } });
      }}
      onPointerUp={() => (start.current = null)}
      onDoubleClick={(e) => { if (e.target === e.currentTarget) onToggleMaximize(); }}
    >
      {/* A slim pill centred on the line (the row stays 6 px): the obvious way to give the track list the screen. */}
      <button className="panel-maximize" aria-label={maximized ? "Show the decks" : "Expand the track list"} aria-pressed={maximized} title={maximized ? "Show the decks again (Esc, or double-click the bar)" : "Give the track list the full screen (or double-click the bar)"} onPointerDown={(e) => e.stopPropagation()} onClick={onToggleMaximize}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{maximized ? <path d="m4 4 4 4 4-4M4 9l4 4 4-4" /> : <path d="m4 12 4-4 4 4M4 7l4-4 4 4" />}</svg>
        <span>{maximized ? "SHOW DECKS" : "EXPAND"}</span>
      </button>
      <span className="splitter-hint" aria-hidden="true">{maximized ? "Esc or double-click to show the decks" : "Drag to resize · double-click to expand"}</span>
    </div>
  );
}

function Stage({ mode }: { mode: LayoutMode }) {
  if (mode === "vertical") {
    return (
      <main className="stage vertical">
        <Boundary name="Deck A"><Deck deck={0} /></Boundary>
        <div className="center-col">
          <Boundary name="Waveforms"><WaveformStack orientation="vertical" /></Boundary>
          <Boundary name="Mixer"><Mixer dense /></Boundary>
        </div>
        <Boundary name="Deck B"><Deck deck={1} /></Boundary>
      </main>
    );
  }
  const compact = mode === "classic";
  return (
    <main className={`stage ${mode}`}>
      <Boundary name="Waveforms"><WaveformStack orientation="horizontal" /></Boundary>
      <div className="deck-row-3">
        <Boundary name="Deck A"><Deck deck={0} variant={compact ? "compact" : "full"} /></Boundary>
        <Boundary name="Mixer"><Mixer dense={compact} /></Boundary>
        <Boundary name="Deck B"><Deck deck={1} variant={compact ? "compact" : "full"} /></Boundary>
      </div>
    </main>
  );
}

function Shell() {
  const [tool, setTool] = useState<ToolTab | null>(null);
  const [lowerMaximized, setLowerMaximized] = useState(false);
  // Other parts of the UI (About page, Practice home) can open an area: dispatch "dbdj:navigate".
  useEffect(() => {
    const go = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setTool(null);
      // "learn:practice" / "learn:history" (Learn sub-menu) open those views of the library's Practice page.
      if (detail === "learn:practice" || detail === "learn:history") { setNavigation((n) => ({ area: "practice", id: n.id + 1, open: detail === "learn:practice" ? "learn-practice" : "learn-history" })); return; }
      setNavigation((n) => ({ area: detail as typeof navigation.area, id: n.id + 1 }));
    };
    window.addEventListener("dbdj:navigate", go);
    return () => window.removeEventListener("dbdj:navigate", go);
  }, []);
  // "Fix grid…" anywhere brings the decks into view (expanded pane, AI Set Studio, Lighting, Production Studio).
  useEffect(() => {
    const show = () => { setTool(null); setLowerMaximized(false); setNavigation((n) => (n.area === "production" ? { area: "collections", id: n.id + 1 } : n)); };
    window.addEventListener("dbdj:show-decks", show);
    return () => window.removeEventListener("dbdj:show-decks", show);
  }, []);
  // `open: "all-tracks"` (DJ Deck) skips the Collections home and opens All Tracks directly.
  const [navigation, setNavigation] = useState<{ area: MainBrowserArea | "lighting" | "transitions" | "training" | "production" | "teachloop" | "setstudio"; id: number; open?: "all-tracks" | "learn-practice" | "learn-history" }>({ area: "collections", id: 0 });
  const libraryNavigation = useRef<{ area: MainBrowserArea; id: number; open?: "all-tracks" | "learn-practice" | "learn-history" }>({ area: "collections", id: 0 });
  if (navigation.area !== "lighting" && navigation.area !== "production" && navigation.area !== "setstudio") libraryNavigation.current = navigation as { area: MainBrowserArea; id: number; open?: "all-tracks" | "learn-practice" | "learn-history" };
  /** DJ Deck: both decks on screen (leaves any expanded library / workspace) and All Tracks in the lower pane. */
  const openDjDeck = () => { setTool(null); setLowerMaximized(false); setNavigation((n) => ({ area: "collections", id: n.id + 1, open: "all-tracks" })); };
  const app = useApp();
  const { platform } = app;
  const layout = useLayout();
  useEffect(() => {
    document.title = "Donkey Billabong DJ";
  }, []);
  // AI Set Studio needs the room: entering it expands the lower pane ("Show decks" restores them).
  useEffect(() => { if (navigation.area === "setstudio") setLowerMaximized(true); }, [navigation.area, navigation.id]);
  useEffect(() => {
    if (!lowerMaximized) return;
    const restore = (e: KeyboardEvent) => { if (e.key === "Escape") setLowerMaximized(false); };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [lowerMaximized]);

  // Files dropped anywhere that isn't a deck or the library are added to the library.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      void platform.refsFromDrop(files).then((refs) => app.addFiles(refs));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [platform, app]);

  return (
    <div className={`app layout-${layout.mode}${lowerMaximized ? " lower-maximized" : ""}`} style={{ ["--lib-h" as string]: `${layout.libraryHeight[layout.mode]}px` }}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={brandLogo} alt="Donkey Billabong DJ" width={800} height={267} draggable={false} />
        </div>
        <nav className="main-navigation" aria-label="Main browser areas">
          <button title="DJ Deck" className={`nav-decks ${navigation.area === "collections" || navigation.area === "playlists" ? "active" : ""}`} onClick={openDjDeck}><NavIcon area="decks"/><span className="nav-label">DJ Deck</span></button>
          {([["mashups","Mashup Projects"],["setstudio","AI Set Studio"],["production","Production Studio"],["practice","Learn"],["streaming","Audio Sources"],["lighting","Lighting"]] as const).map(([area,label])=><button key={area} title={label} className={`nav-${area} ${navigation.area===area||(area==="practice"&&(navigation.area==="transitions"||navigation.area==="training"||navigation.area==="teachloop"))?"active":""}`} onClick={()=>{ if(area==="practice"||area==="lighting") setLowerMaximized(true); /* Learn and Lighting open with the lower pane expanded ("Show decks" restores) */ setNavigation(n=>({area,id:n.id+1})); }}><NavIcon area={area}/><span className="nav-label">{label}</span></button>)}
        </nav>
        <LayoutSwitch />
        <div className="statuses">
          <div className="system-status-stack"><AudioStatusBadge /><ControllerStatus /></div>
          {platform.kind === "desktop" ? <UpdateBadge onOpen={() => setTool("About")} /> : <DownloadDesktopButton />}
          <UtilityMenu onOpen={setTool} />
        </div>
      </header>
      {navigation.area === "production" ? <Boundary name="Production Studio"><ProductionStudioWorkspace /></Boundary> : <>
      <TopTools />
      <Stage mode={layout.mode} />
      <Splitter mode={layout.mode} maximized={lowerMaximized} onToggleMaximize={() => setLowerMaximized((v) => !v)} />
      <section className="lower">
        {/* The library stays mounted (hidden) while Lighting is open, so it comes back exactly as it was. */}
        <div className="lower-pane" hidden={navigation.area === "lighting" || navigation.area === "setstudio"}>
          <Boundary name="Library"><LibraryPanel navigation={libraryNavigation.current} onNavigateArea={(area) => setNavigation((n) => ({ area, id: n.id + 1 }))} expanded={lowerMaximized} onToggleExpanded={() => setLowerMaximized((v) => !v)} /></Boundary>
        </div>
        {navigation.area === "lighting" && <Boundary name="Lighting"><LightingWorkspace /></Boundary>}
        {navigation.area === "setstudio" && <Boundary name="AI Set Studio"><SetStudioWorkspace /></Boundary>}
      </section>
      </>}
      {tool && <ToolsOverlay tab={tool} setTab={setTool} onClose={() => setTool(null)} />}
      <Toasts />
      <MatchDialogHost />
    </div>
  );
}

export function AppRoot({ app }: { app: AppServices }) {
  return (
    <AppContext.Provider value={app}>
      <Shell />
    </AppContext.Provider>
  );
}

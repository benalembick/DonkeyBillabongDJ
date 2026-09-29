import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { App as AppServices } from "../app/createApp";
import type { ControllerInfo } from "../controllers/ControllerManager";
import type { LogEntry } from "../core/log";
import { AppContext, useApp, useEngineState } from "./context";
import { ControllerTest, LiveEvents, MidiMonitor } from "./ControllerPanels";
import { Deck } from "./Deck";
import { DownloadDesktopButton } from "./DownloadDesktop";
import { useFrameStore, useTick } from "./hooks";
import { LibraryPanel, type MainBrowserArea } from "./LibraryPanel";
import { MatchDialogHost } from "./MatchDialog";
import { Mixer } from "./Mixer";
import { Diagnostics, Settings } from "./SystemPanels";
import { FxBar } from "./FxBar";
import { getLayout, setLayout, useLayout, zoom, type LayoutMode } from "./layout";
import { WaveformStack } from "./Waveforms";
import brandLogo from "../assets/donkey-billabong-dj-logo.png";
import { About } from "./About";
import { WaveStylePicker } from "./WaveStylePicker";

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
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
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
        {saving ? "SAVING…" : "SAVE MANUAL MASHUP"}
      </button>
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
function Splitter({ mode }: { mode: LayoutMode }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className="splitter"
      title="Drag to resize the library"
      onPointerDown={(e) => {
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
    />
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
  const [navigation, setNavigation] = useState<{ area: MainBrowserArea; id: number }>({ area: "collections", id: 0 });
  const app = useApp();
  const { platform } = app;
  const layout = useLayout();
  useEffect(() => {
    document.title = "Donkey Billabong DJ";
  }, []);

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
    <div className={`app layout-${layout.mode}`} style={{ ["--lib-h" as string]: `${layout.libraryHeight[layout.mode]}px` }}>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={brandLogo} alt="Donkey Billabong DJ" width={2153} height={730} draggable={false} />
        </div>
        <nav className="main-navigation" aria-label="Main browser areas">
          {([['collections','▦','Collections'],['playlists','▤','Playlists'],['mashups','⚡','Mashup Projects'],['practice','◆','Practice Mode'],['streaming','◉','Streaming']] as const).map(([area,icon,label])=><button key={area} className={navigation.area===area?"active":""} onClick={()=>setNavigation(n=>({area,id:n.id+1}))}><span>{icon}</span>{label}</button>)}
        </nav>
        <LayoutSwitch />
        <div className="statuses">
          <div className="system-status-stack"><AudioStatusBadge /><ControllerStatus /></div>
          {platform.kind === "desktop" ? null : <DownloadDesktopButton />}
          <button className="status open-tools utility-button" onClick={() => setTool("Controller events")} title="Controller events, test and MIDI monitor"><span aria-hidden="true">🎛</span> Controller</button>
          <button className="status utility-button" onClick={() => setTool("Diagnostics")}><span aria-hidden="true">◫</span> Diagnostics</button>
          <button className="status utility-button" onClick={() => setTool("Settings")}><span aria-hidden="true">⚙</span> Settings</button>
          <button className="status utility-button" onClick={() => setTool("About")}><span aria-hidden="true">ⓘ</span> About</button>
        </div>
      </header>
      <Boundary name="FX"><FxBar /></Boundary>
      <Stage mode={layout.mode} />
      {layout.mode !== "classic" && <Splitter mode={layout.mode} />}
      <section className="lower">
        <Boundary name="Library"><LibraryPanel navigation={navigation} onNavigateArea={(area) => setNavigation((n) => ({ area, id: n.id + 1 }))} /></Boundary>
      </section>
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

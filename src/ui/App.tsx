import { Component, useCallback, useEffect, useState, type ReactNode } from "react";
import type { App as AppServices } from "../app/createApp";
import type { ControllerInfo } from "../controllers/ControllerManager";
import type { LogEntry } from "../core/log";
import { AppContext, useApp } from "./context";
import { ControllerTest, LiveEvents, MidiMonitor } from "./ControllerPanels";
import { Deck } from "./Deck";
import { DownloadDesktopButton } from "./DownloadDesktop";
import { useFrameStore, useTick } from "./hooks";
import { LibraryPanel } from "./LibraryPanel";
import { MatchDialogHost } from "./MatchDialog";
import { Mixer } from "./Mixer";
import { Diagnostics, Settings } from "./SystemPanels";

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

const TABS = ["Library", "Live controller events", "Controller test", "MIDI monitor", "Diagnostics", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** Transient notices for warnings/errors (e.g. "deck is playing", "Spotify audio can't be mixed"). */
function Toasts() {
  const { log } = useApp();
  const [items, setItems] = useState<LogEntry[]>([]);
  useEffect(
    () =>
      log.on("entry", (e) => {
        const notable = e.level === "warn" || e.level === "error" || (e.source === "library" && e.message.startsWith("Added")) || e.source === "streaming" || (e.source === "matching" && !e.message.startsWith("Resolving")) || (e.source === "library" && e.message.startsWith("Read tags"));
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

function Shell() {
  const [tab, setTab] = useState<Tab>("Library");
  const app = useApp();
  const { platform } = app;
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
      setTab("Library");
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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◐</span> DONKEY BILLABONG <span className="thin">DJ</span>
          <span className="phase">Phase 1 · hardware spike</span>
        </div>
        <div className="statuses">
          <AudioStatusBadge />
          <ControllerStatus />
          {platform.kind === "desktop" ? <span className="status idle">Desktop</span> : <DownloadDesktopButton />}
          <button className="status" onClick={() => setTab("Settings")}>⚙ Settings</button>
        </div>
      </header>
      <main className="main">
        <Boundary name="Deck A"><Deck deck={0} /></Boundary>
        <Boundary name="Mixer"><Mixer /></Boundary>
        <Boundary name="Deck B"><Deck deck={1} /></Boundary>
      </main>
      <section className="lower">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          <Boundary name={tab}>
            {tab === "Library" && <LibraryPanel />}
            {tab === "Live controller events" && <LiveEvents />}
            {tab === "Controller test" && <ControllerTest />}
            {tab === "MIDI monitor" && <MidiMonitor />}
            {tab === "Diagnostics" && <Diagnostics />}
            {tab === "Settings" && <Settings />}
          </Boundary>
        </div>
      </section>
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

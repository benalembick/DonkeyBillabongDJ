import { useEffect, useRef, useState } from "react";
import { deckLetter } from "../core/actions";
import type { Overview } from "../analysis/AnalysisService";
import { useApp, useEngineState, useSend } from "./context";
import { formatTime, useAnimationFrame } from "./hooks";

const RANGE_LABEL: Record<string, string> = { "0.06": "±6%", "0.1": "±10%", "0.16": "±16%", "1": "WIDE" };

/** Press/release button for momentary actions (CUE, hot cues). */
function HoldButton(props: { action: string; className?: string; children: React.ReactNode; title?: string }) {
  const send = useSend();
  return (
    <button
      className={props.className}
      title={props.title}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        send(props.action, 1);
      }}
      onPointerUp={() => send(props.action, 0)}
      onPointerCancel={() => send(props.action, 0)}
    >
      {props.children}
    </button>
  );
}

function OverviewWaveform({ deck }: { deck: number }) {
  const { analysis, engine } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overview, setOverview] = useState<Overview | null>(analysis.get(deck));
  const baseRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(
    () =>
      analysis.on("overview", (e) => {
        if (e.deck === deck) setOverview(e.overview);
      }),
    [analysis, deck],
  );

  // Pre-render the static waveform once per track into an offscreen canvas.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const g = off.getContext("2d")!;
    if (overview) {
      const styles = getComputedStyle(c);
      const peakColor = styles.getPropertyValue("--deck-color").trim() || "#4cc9f0";
      const rmsColor = styles.getPropertyValue("--deck-color-strong").trim() || "#fff";
      const n = overview.peaks.length;
      let max = 0.0001;
      for (let i = 0; i < n; i++) max = Math.max(max, overview.peaks[i]);
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * n);
        const p = (overview.peaks[i] / max) * (h / 2);
        const r = (overview.rms[i] / max) * (h / 2);
        g.fillStyle = peakColor;
        g.globalAlpha = 0.55;
        g.fillRect(x, h / 2 - p, 1, p * 2);
        g.globalAlpha = 1;
        g.fillStyle = rmsColor;
        g.fillRect(x, h / 2 - r, 1, r * 2);
      }
    }
    baseRef.current = off;
  }, [overview]);

  useAnimationFrame(() => {
    const c = canvasRef.current;
    const base = baseRef.current;
    if (!c || !base) return;
    const g = c.getContext("2d")!;
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    g.drawImage(base, 0, 0);
    const d = engine.getState().decks[deck];
    if (!d || d.duration <= 0) return;
    const x = (t: number) => (t / d.duration) * w;
    const pos = engine.getPosition(deck);
    // played region dimmed
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(0, 0, x(pos), h);
    // cue marker (triangle + line)
    g.fillStyle = "#ffd166";
    g.fillRect(x(d.cuePoint), 0, 2 * devicePixelRatio, h);
    // hot cues: numbered ticks
    g.font = `${10 * devicePixelRatio}px system-ui`;
    d.hotcues.forEach((hc, i) => {
      if (hc == null) return;
      g.fillStyle = "#c77dff";
      g.fillRect(x(hc), 0, 2 * devicePixelRatio, h);
      g.fillText(String(i + 1), x(hc) + 3 * devicePixelRatio, 11 * devicePixelRatio);
    });
    // playhead
    g.fillStyle = "#ffffff";
    g.fillRect(x(pos) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
  });

  const send = useSend();
  return (
    <canvas
      ref={canvasRef}
      className="overview"
      onPointerDown={(e) => {
        const d = engine.getState().decks[deck];
        if (!d || d.duration <= 0 || d.playing) return; // safety: no accidental jumps while playing
        const r = (e.target as HTMLElement).getBoundingClientRect();
        send(`deck${deck + 1}.seek`, (e.clientX - r.left) / r.width);
      }}
      title="Click to seek (when paused)"
    />
  );
}

function DeckClock({ deck }: { deck: number }) {
  const { engine } = useApp();
  const elapsed = useRef<HTMLSpanElement>(null);
  const remain = useRef<HTMLSpanElement>(null);
  const ticks = useRef<HTMLSpanElement>(null);
  useAnimationFrame(() => {
    const d = engine.getState().decks[deck];
    const pos = engine.getPosition(deck);
    if (elapsed.current) elapsed.current.textContent = formatTime(pos);
    if (remain.current) remain.current.textContent = "-" + formatTime((d?.duration ?? 0) - pos);
    if (ticks.current) ticks.current.textContent = String(engine.getJogTicks(deck));
  });
  return (
    <div className="deck-clock">
      <div>
        <span className="label">ELAPSED</span>
        <span ref={elapsed} className="time">00:00.0</span>
      </div>
      <div>
        <span className="label">REMAIN</span>
        <span ref={remain} className="time">-00:00.0</span>
      </div>
      <div title="Cumulative jog ticks — spin the platter one full turn to calibrate ticks/revolution (Settings)">
        <span className="label">JOG TICKS</span>
        <span className="time small" ref={ticks}>0</span>
        <button className="tiny" onClick={() => engine.resetJogTicks(deck)}>reset</button>
      </div>
    </div>
  );
}

export function Deck({ deck }: { deck: number }) {
  const state = useEngineState();
  const app = useApp();
  const { engine, platform, log } = app;
  const send = useSend();
  const d = state.decks[deck];
  const L = deckLetter(deck);
  const p = `deck${deck + 1}`;
  const [dragOver, setDragOver] = useState(false);
  const pct = (d.rate - 1) * 100;

  const pickAndLoad = async () => {
    try {
      const refs = await platform.pickAudioFiles();
      if (refs.length) await app.addFiles(refs, deck);
    } catch (err) {
      log.error("library", `Could not open files: ${String(err)}`);
    }
  };

  return (
    <section
      className={`deck deck-${L.toLowerCase()} ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (types.includes("application/x-dbdj-track") || types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const raw = e.dataTransfer.getData("application/x-dbdj-track");
        if (raw) {
          void engine.loadTrack(deck, JSON.parse(raw));
          return;
        }
        const files = [...e.dataTransfer.files];
        if (files.length) {
          void platform
            .refsFromDrop(files)
            .then((refs) => app.addFiles(refs, deck))
            .catch((err) => log.error("library", `Drop failed: ${String(err)}`));
        }
      }}
    >
      <header className="deck-header">
        <div className="deck-letter" aria-label={`Deck ${L}`}>{L}</div>
        <div className="deck-meta">
          <div
            className={`deck-title ${d.status === "empty" ? "clickable" : ""}`}
            onClick={d.status === "empty" ? () => void pickAndLoad() : undefined}
            title={d.status === "empty" ? "Click to choose a file" : undefined}
          >
            {d.status === "loading" ? "Loading…" : d.track?.title ?? "Empty — click or drop an audio file here"}
          </div>
          <div className="deck-artist">
            {d.track?.artist || (d.status === "error" ? `⚠ ${d.error}` : "")}
            {d.track && <span className="source-badge">{d.track.source.toUpperCase()}</span>}
          </div>
        </div>
        <button className="load-btn" onClick={() => void pickAndLoad()} disabled={d.playing} title={d.playing ? "Pause the deck to load another track" : "Choose an audio file for this deck"}>
          ⏏ LOAD…
        </button>
        <div className="deck-bpm">
          <div className="big">{d.track?.bpm ? (d.track.bpm * d.rate).toFixed(1) : "—"}</div>
          <div className="label">BPM</div>
        </div>
      </header>

      <OverviewWaveform deck={deck} />
      <DeckClock deck={deck} />

      <div className="deck-status">
        <span className={`chip ${d.playing ? "on" : ""}`}>{d.playing ? "▶ PLAYING" : "❚❚ PAUSED"}</span>
        <span className={`chip ${d.vinyl ? "on" : ""}`}>◎ VINYL {d.vinyl ? "ON" : "OFF"}</span>
        <span className={`chip ${d.jogTouched ? "on warn" : ""}`}>✋ {d.scratching ? "SCRATCH" : d.jogTouched ? "TOUCH" : "JOG"}</span>
        <span className={`chip ${d.keylock ? "on" : ""}`} title="Key lock arrives in Phase 2">🔒 KEY LOCK</span>
        <span className="chip" title="Sync arrives in Phase 2 (needs beat grid)">SYNC —</span>
      </div>

      <div className="deck-tempo">
        <div>
          <span className="label">TEMPO</span>
          <span className="tempo-value">{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
        </div>
        <button onClick={() => send(`${p}.tempo.range`)} title="Cycle pitch range">{RANGE_LABEL[String(d.tempoRange)] ?? d.tempoRange}</button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.0005}
          value={0.5 + d.tempo / 2 * (engine.getSettings().tempoDownIsFaster ? 1 : -1)}
          onChange={(e) => send(`${p}.tempo`, Number(e.target.value))}
          onDoubleClick={() => send(`${p}.tempo.reset`)}
          className="tempo-slider"
          title="Tempo (double-click to reset)"
        />
      </div>

      <div className="transport">
        <HoldButton action={`${p}.cue`} className={`big-btn cue ${engine.getFeedback(`${p}.cue`) ? "lit" : ""}`}>CUE</HoldButton>
        <button className={`big-btn play ${d.playing ? "lit" : ""}`} onClick={() => send(`${p}.play`)}>
          {d.playing ? "❚❚" : "▶"} PLAY
        </button>
        <button className={`mid-btn ${d.vinyl ? "lit" : ""}`} onClick={() => send(`${p}.vinyl`)}>VINYL</button>
      </div>

      <div className="pads">
        {d.hotcues.map((hc, i) => (
          <div key={i} className="pad-wrap">
            <HoldButton action={`${p}.hotcue.${i + 1}`} className={`pad ${hc != null ? "set" : ""}`} title={hc != null ? `Hot cue ${i + 1} @ ${formatTime(hc)}` : `Set hot cue ${i + 1}`}>
              {i + 1}
              {hc != null && <small>{formatTime(hc)}</small>}
            </HoldButton>
            {hc != null && (
              <button className="pad-clear" onClick={() => send(`${p}.hotcue.${i + 1}.clear`)} title="Delete hot cue">×</button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

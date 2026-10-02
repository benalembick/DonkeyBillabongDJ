/**
 * Deck panel (presentation only; all state lives in the DJ engine).
 *  - "full": header, overview, hot-cue pads, transport, loop section, jog display, tempo fader.
 *  - "compact": header, overview, one row of transport/pads/tempo (Classic layout).
 */
import { useRef, useState } from "react";
import { deckLetter, STEM_LABELS, STEM_NAMES } from "../core/actions";
import { LOOP_SIZES } from "../core/engine/DJEngine";
import { useApp, useEngineState, useSend } from "./context";
import { formatTime, useAnimationFrame } from "./hooks";
import { HOTCUE_COLORS, STEM_COLORS } from "./layout";
import { OverviewWaveform } from "./Waveforms";
import { ArtTile } from "./ArtTile";

const RANGE_LABEL: Record<string, string> = { "0.06": "±6", "0.1": "±10", "0.16": "±16", "1": "WIDE" };
const SOURCE_LABEL: Record<string, string> = { "apple-music": "APPLE MUSIC" };

/** Press/release button for momentary actions (CUE, hot cues). */
function HoldButton(props: { action: string; className?: string; children: React.ReactNode; title?: string; style?: React.CSSProperties }) {
  const send = useSend();
  return (
    <button
      className={props.className}
      title={props.title}
      style={props.style}
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

function Clock({ deck, big }: { deck: number; big?: boolean }) {
  const { engine } = useApp();
  const remain = useRef<HTMLSpanElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  useAnimationFrame(() => {
    const d = engine.getState().decks[deck];
    const pos = engine.getPosition(deck);
    if (remain.current) remain.current.textContent = "-" + formatTime((d?.duration ?? 0) - pos);
    if (elapsed.current) elapsed.current.textContent = formatTime(pos);
  });
  return (
    <div className={`clock ${big ? "big" : ""}`}>
      <span ref={remain} className="remain">-00:00.0</span>
      <span ref={elapsed} className="elapsed">00:00.0</span>
    </div>
  );
}

/** Jog display: rotates with the track (33⅓ rpm), shows BPM, pitch and touch state. */
function JogDisplay({ deck, size }: { deck: number; size: number }) {
  const { engine } = useApp();
  const needle = useRef<SVGLineElement>(null);
  const bpmRef = useRef<HTMLSpanElement>(null);
  const d = useEngineState().decks[deck];
  useAnimationFrame(() => {
    const pos = engine.getPosition(deck);
    const deg = ((pos / 1.8) * 360) % 360;
    needle.current?.setAttribute("transform", `rotate(${deg} 50 50)`);
    const bpm = engine.getBpm(deck);
    if (bpmRef.current) bpmRef.current.textContent = bpm ? bpm.toFixed(2) : "—";
  });
  const pct = (d.rate - 1) * 100;
  return (
    <div className={`jog ${d.jogTouched ? "touched" : ""} ${d.playing ? "playing" : ""}`} style={size ? { width: size, height: size } : undefined} title={`Jog ticks: ${engine.getJogTicks(deck)}`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="46" className="jog-ring" />
        <circle cx="50" cy="50" r="40" className="jog-inner" />
        <line ref={needle} x1="50" y1="5" x2="50" y2="15" className="jog-needle" />
      </svg>
      <div className="jog-text">
        <span className="label">BPM</span>
        <span ref={bpmRef} className="jog-bpm">—</span>
        <span className="jog-pct">
          {pct >= 0 ? "+" : ""}
          {pct.toFixed(1)}% <small>{RANGE_LABEL[String(d.tempoRange)]}</small>
        </span>
        {d.scratching && <span className="jog-state">SCRATCH</span>}
      </div>
    </div>
  );
}

function TempoFader({ deck, vertical }: { deck: number; vertical: boolean }) {
  const { engine } = useApp();
  const send = useSend();
  const d = useEngineState().decks[deck];
  const p = `deck${deck + 1}`;
  const value = 0.5 + (d.tempo / 2) * (engine.getSettings().tempoDownIsFaster ? 1 : -1);
  return (
    <div className={`tempo ${vertical ? "vertical" : ""}`}>
      <button className="tiny" onClick={() => send(`${p}.tempo.range`)} title="Pitch range">
        {RANGE_LABEL[String(d.tempoRange)]}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.0005}
        value={value}
        className={vertical ? "vfader tempo-fader" : "tempo-fader"}
        onChange={(e) => send(`${p}.tempo`, Number(e.target.value))}
        onDoubleClick={() => send(`${p}.tempo.reset`)}
        title="Tempo (double-click to reset)"
      />
      <button className="tiny" onClick={() => send(`${p}.tempo.reset`)} title="Reset tempo">
        0
      </button>
    </div>
  );
}

function Pads({ deck, columns }: { deck: number; columns: number }) {
  const send = useSend();
  const d = useEngineState().decks[deck];
  const p = `deck${deck + 1}`;
  return (
    <div className="pads" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {d.hotcues.map((hc, i) => (
        <div key={i} className="pad-wrap">
          <HoldButton
            action={`${p}.hotcue.${i + 1}`}
            className={`pad ${hc != null ? "set" : ""}`}
            style={hc != null ? { borderColor: HOTCUE_COLORS[i], background: `${HOTCUE_COLORS[i]}33` } : undefined}
            title={hc != null ? `Hot cue ${String.fromCharCode(65 + i)} @ ${formatTime(hc)}` : `Set hot cue ${String.fromCharCode(65 + i)}`}
          >
            {String.fromCharCode(65 + i)}
            {hc != null && <small>{formatTime(hc)}</small>}
          </HoldButton>
          {hc != null && (
            <button className="pad-clear" onClick={() => send(`${p}.hotcue.${i + 1}.clear`)} title="Delete hot cue">
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const sizeLabel = (b: number) => (b < 1 ? `1/${Math.round(1 / b)}` : String(Math.round(b * 100) / 100));

/**
 * Loop controls: ‹ › pick the auto-loop size (or halve/double an active loop), AUTO sets a
 * beat-aligned loop of that size, IN/OUT make a manual loop, EXIT leaves it (RELOOP re-enters).
 */
function LoopSection({ deck }: { deck: number }) {
  const send = useSend();
  const d = useEngineState().decks[deck];
  const p = `deck${deck + 1}`;
  const [size, setSize] = useState(4);
  const lp = d.loop;
  const active = !!lp?.active;
  const shown = active && lp?.beats ? lp.beats : size;
  const step = (dir: 1 | -1) => {
    if (active) send(`${p}.loop.${dir > 0 ? "double" : "halve"}`);
    const i = LOOP_SIZES.indexOf(size as (typeof LOOP_SIZES)[number]);
    setSize(LOOP_SIZES[Math.max(0, Math.min(LOOP_SIZES.length - 1, i + dir))]);
  };
  const noGrid = d.status === "ready" && !d.beatGrid && !d.track?.bpm;
  return (
    <div className={`loops ${active ? "looping" : ""}`} title={noGrid ? "No BPM yet — loops assume 120 BPM until analysis finishes" : "Beat-aligned loops"}>
      <div className="loop-size">
        <button className="tiny" onClick={() => step(-1)} title={active ? "Halve loop" : "Shorter"}>‹</button>
        <span>{active && !lp?.beats ? "MAN" : sizeLabel(shown)}</span>
        <button className="tiny" onClick={() => step(1)} title={active ? "Double loop" : "Longer"}>›</button>
      </div>
      <button className={`tiny ${active && lp?.beats === size ? "lit" : ""}`} onClick={() => send(`${p}.beatloop.${size}`)} disabled={d.status !== "ready"}>
        AUTO
      </button>
      <button className={`tiny ${d.loopIn != null ? "lit" : ""}`} onClick={() => send(`${p}.loop.in`)} disabled={d.status !== "ready"}>IN</button>
      <button className="tiny" onClick={() => send(`${p}.loop.out`)} disabled={d.status !== "ready" || (d.loopIn == null && !lp)}>OUT</button>
      <button className={`tiny ${active ? "lit" : ""}`} onClick={() => send(`${p}.loop.exit`)} disabled={!lp}>
        {lp && !active ? "RELOOP" : "EXIT"}
      </button>
    </div>
  );
}

const STEM_STATUS: Record<string, string> = {
  off: "",
  waiting: "READY TO ANALYSE",
  loading: "LOADING STEMS…",
  analysing: "ANALYSING STEMS",
  ready: "STEMS READY",
  error: "STEMS ERROR",
  unavailable: "STEMS UNAVAILABLE",
};

/** Short, actionable reason shown in the strip (full text in the tooltip). */
function unavailableLabel(msg?: string): string {
  const m = msg ?? "";
  if (/install the separation model/i.test(m)) return "STEMS: INSTALL MODEL IN SETTINGS";
  if (/switched off/i.test(m)) return "STEMS OFF IN SETTINGS";
  if (/desktop app/i.test(m)) return "STEMS: DESKTOP APP ONLY";
  if (/Apple Silicon|Windows and macOS/i.test(m)) return "STEMS NOT SUPPORTED HERE";
  if (/source/i.test(m)) return "NO STEMS FOR THIS SOURCE";
  return "STEMS UNAVAILABLE";
}

/**
 * STEMS strip: on/off, then one control per stem (click = mute/unmute,
 * Shift+click or right-click = isolate, slider = stem volume). Separated audio
 * plays only where the worker has finished; elsewhere the deck plays the original.
 */
function StemStrip({ deck }: { deck: number }) {
  const send = useSend();
  const d = useEngineState().decks[deck];
  const p = `deck${deck + 1}`;
  const st = d.stems;
  if (!d.track) return null;
  const unavailable = st.status === "unavailable";
  const pct = Math.round(st.progress * 100);
  const label =
    st.status === "analysing" ? `ANALYSING STEMS… ${pct}%` : st.status === "loading" ? `LOADING STEMS… ${pct}%` : unavailable ? unavailableLabel(st.message) : STEM_STATUS[st.status];
  return (
    <div className={`stem-strip ${st.enabled ? "on" : ""} ${unavailable ? "disabled" : ""}`}>
      <button
        className={`tiny stems-btn ${st.enabled ? "lit" : ""}`}
        disabled={unavailable}
        onClick={() => send(`${p}.stems`)}
        title={unavailable ? st.message ?? "STEMS unavailable" : "STEMS on/off — the original track is always available"}
      >
        STEMS
      </button>
      {STEM_NAMES.map((s, k) => {
        const muted = st.muted[k] || st.volume[k] === 0;
        return (
          <div key={s} className={`stem ${muted ? "muted" : ""}`} style={{ "--stem": STEM_COLORS[s] } as React.CSSProperties}>
            <button
              className="stem-btn"
              disabled={unavailable}
              onClick={(e) => send(`${p}.stem.${s}.${e.shiftKey ? "isolate" : "toggle"}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                send(`${p}.stem.${s}.isolate`);
              }}
              title={`${STEM_LABELS[s]}: click to mute/unmute, Shift+click or right-click to solo`}
            >
              {STEM_LABELS[s].slice(0, 3).toUpperCase()}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={st.volume[k]}
              disabled={unavailable}
              onChange={(e) => send(`${p}.stem.${s}.volume`, Number(e.target.value))}
              onDoubleClick={() => send(`${p}.stem.${s}.volume`, 1)}
              title={`${STEM_LABELS[s]} volume (double-click to reset)`}
            />
          </div>
        );
      })}
      <span className={`stem-status ${st.status}`} title={st.message}>
        {label}
        {(st.status === "analysing" || st.status === "loading") && (
          <span className="stem-progress">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
    </div>
  );
}

function StateButtons({ deck }: { deck: number }) {
  const send = useSend();
  const s = useEngineState();
  const d = s.decks[deck];
  const isMaster = s.masterDeck === deck;
  const p = `deck${deck + 1}`;
  return (
    <div className="state-buttons">
      <button className={`tiny ${d.vinyl ? "lit" : ""}`} onClick={() => send(`${p}.vinyl`)} title="Vinyl (scratch) mode">VINYL</button>
      <button className={`tiny ${d.keylock ? "lit" : ""}`} onClick={() => send(`${p}.keylock`)} title="Key lock: change tempo without changing the key (pitch). Scratching still sounds like vinyl.">KEY LOCK</button>
      <button
        className={`tiny ${d.sync ? "lit" : ""}`}
        onClick={() => send(`${p}.sync`)}
        disabled={d.status !== "ready"}
        title="Beat sync: match BPM and keep beats aligned with the master deck"
      >
        SYNC
      </button>
      <button
        className={`tiny ${isMaster ? "lit master-lit" : ""}`}
        onClick={() => send(`${p}.master`)}
        disabled={d.status !== "ready"}
        title="Tempo master: synced decks follow this deck"
      >
        MASTER
      </button>
    </div>
  );
}

export function Deck({ deck, variant = "full" }: { deck: number; variant?: "full" | "compact" }) {
  const state = useEngineState();
  const app = useApp();
  const { platform, log, engine } = app;
  const send = useSend();
  const d = state.decks[deck];
  const L = deckLetter(deck);
  const p = `deck${deck + 1}`;
  const [dragOver, setDragOver] = useState(false);
  const bpm = engine.getBpm(deck);

  const pickAndLoad = async () => {
    try {
      const refs = await platform.pickAudioFiles();
      if (refs.length) await app.addFiles(refs, deck);
    } catch (err) {
      log.error("library", `Could not open files: ${String(err)}`);
    }
  };

  const src = d.track ? SOURCE_LABEL[d.track.source] ?? d.track.source.toUpperCase() : "";

  return (
    <section
      className={`deck deck-${L.toLowerCase()} ${variant} ${dragOver ? "drag-over" : ""}`}
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
          // Streaming tracks are resolved to a playable source (Smart Match); local ones load directly.
          void app.matching.loadToDeck(deck, JSON.parse(raw));
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
      <header className="deck-head">
        <div className="deck-letter" aria-label={`Deck ${L}`}>{L}</div>
        <div className="art">{d.track && <ArtTile track={d.track} size={40} />}</div>
        <div className="deck-meta">
          <div
            className={`deck-title ${d.status === "empty" ? "clickable" : ""}`}
            onClick={d.status === "empty" ? () => void pickAndLoad() : undefined}
            title={d.track?.title ?? "Click to choose a file"}
          >
            {d.track?.title ?? "Empty — click, drop a file or press LOAD"}
          </div>
          <div className="deck-artist">
            <span className="artist">{d.track?.artist || (d.status === "error" ? `⚠ ${d.error}` : "")}</span>
            {d.track && <span className={`source-badge ${d.track.source}`}>{src}</span>}
            {d.track?.resolvedFrom && (
              <span
                className="via-badge"
                title={`Metadata: ${d.track.resolvedFrom.metadataSource} — "${d.track.resolvedFrom.requestedTitle}" by ${d.track.resolvedFrom.requestedArtist}\nAudio: ${d.track.resolvedFrom.audioSource}\nMatch: ${d.track.resolvedFrom.confidence}% (${d.track.resolvedFrom.method})`}
              >
                {d.track.resolvedFrom.metadataSource === "apple-music" ? "APPLE MUSIC" : d.track.resolvedFrom.metadataSource.toUpperCase()} →{" "}
                {d.track.resolvedFrom.audioSource.toUpperCase()} · {d.track.resolvedFrom.confidence}%
              </span>
            )}
          </div>
        </div>
        <div className="deck-bpm" title={d.beatGrid ? `Beat grid: ${d.beatGrid.source}, confidence ${d.beatGrid.confidence}` : "BPM from tags/service"}>
          <span className="big">{bpm ? bpm.toFixed(1) : "—"}</span>
          <span className="key">{d.track?.key ?? ""}</span>
        </div>
        <Clock deck={deck} big={variant === "full"} />
        <button className="load-btn" onClick={() => void pickAndLoad()} disabled={d.playing} title={d.playing ? "Pause the deck to load another track" : "Choose an audio file for this deck"}>
          LOAD
        </button>
      </header>

      {(d.status === "loading" || d.status === "error") && (
        <div className={`deck-load ${d.loadMessage || d.status === "error" ? "warn" : ""}`}>
          {d.status === "error" ? (
            <>⛔ ERROR — {d.error}</>
          ) : (
            <>
              <span>
                {d.track?.source === "audius" ? "BUFFERING" : "LOADING"}
                {d.loadProgress != null ? ` ${Math.round(d.loadProgress * 100)}%` : "…"}
              </span>
              {d.loadMessage && <span> · {d.loadMessage}</span>}
              <div className="load-bar">
                <div style={{ width: `${Math.round((d.loadProgress ?? 0) * 100)}%` }} />
              </div>
            </>
          )}
        </div>
      )}

      <OverviewWaveform deck={deck} />
      <StemStrip deck={deck} />

      {variant === "full" ? (
        <div className="deck-body">
          <div className="deck-left">
            <div className="section-label">HOT CUE</div>
            <Pads deck={deck} columns={4} />
            <LoopSection deck={deck} />
          </div>
          <div className="deck-center">
            <div className="transport">
              <HoldButton action={`${p}.cue`} className={`round cue ${engine.getFeedback(`${p}.cue`) ? "lit" : ""}`}>CUE</HoldButton>
              <button className={`round play ${d.playing ? "lit" : ""}`} onClick={() => send(`${p}.play`)} aria-label="Play/Pause">
                {d.playing ? "❚❚" : "▶"}
              </button>
            </div>
            <StateButtons deck={deck} />
          </div>
          <JogDisplay deck={deck} size={0} />
          <TempoFader deck={deck} vertical />
        </div>
      ) : (
        <div className="deck-row">
          <HoldButton action={`${p}.cue`} className={`round small cue ${engine.getFeedback(`${p}.cue`) ? "lit" : ""}`}>CUE</HoldButton>
          <button className={`round small play ${d.playing ? "lit" : ""}`} onClick={() => send(`${p}.play`)} aria-label="Play/Pause">
            {d.playing ? "❚❚" : "▶"}
          </button>
          <Pads deck={deck} columns={8} />
          <JogDisplay deck={deck} size={78} />
          <div className="compact-side">
            <StateButtons deck={deck} />
            <TempoFader deck={deck} vertical={false} />
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Four-deck workspace UI: the 2 DECK | 4 DECK switch, deck status chips (ON AIR derived from real
 * routing), the compact and micro deck densities for decks C/D, the indicator that keeps a playing
 * hidden deck reachable in 2 DECK mode, the controller layer indicator with software layer selectors,
 * the master clock and soft-takeover pickup guidance.
 * Everything per-frame (ON AIR, phase, clock, progress) writes to the DOM from requestAnimationFrame;
 * React only re-renders on state changes. See docs/architecture/four-deck-performance-engine.md.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deckLetter } from "../core/actions";
import { audibility } from "../core/engine/audibility";
import { faderToGain } from "../core/engine/mixerMath";
import { SIDE_DECKS, type ControllerSide } from "../controllers/layers";
import { keyBindingLabel } from "../input/keyboard";
import type { DeckDensity } from "../workspace/WorkspaceStore";
import { useApp, useEngineState, useSend } from "./context";
import { deckCssLetter } from "./deckTheme";
import { formatTime, useAnimationFrame } from "./hooks";
import { useLayerState, usePickups, useWorkspace } from "./workspaceHooks";
import { HOTCUE_COLORS } from "./layout";
import { OverviewWaveform } from "./Waveforms";

export { useLayerState, usePickups, useWorkspace };

/** Short label for a pickup target, e.g. "mixer.channel3.volume" → { deck: 2, label: "VOLUME" }. */
export function pickupLabel(target: string): { deck: number | null; label: string } {
  const ch = /^mixer\.channel(\d+)\.(.+)$/.exec(target);
  const names: Record<string, string> = { volume: "VOLUME", gain: "TRIM", "eq.high": "HI", "eq.mid": "MID", "eq.low": "LOW", filter: "FILTER" };
  if (ch) return { deck: Number(ch[1]) - 1, label: names[ch[2]] ?? ch[2].toUpperCase() };
  const dk = /^deck(\d+)\.(.+)$/.exec(target);
  if (dk) return { deck: Number(dk[1]) - 1, label: dk[2] === "tempo" ? "PITCH" : dk[2].replace(/^stem\.(\w+)\.volume$/, "$1").toUpperCase() };
  const globals: Record<string, string> = { "mixer.crossfader": "CROSSFADER", "mixer.headphone.mix": "HP MIX", "mixer.headphone.level": "HP LEVEL", "mixer.master.level": "MASTER" };
  return { deck: null, label: globals[target] ?? target.replace(/^fx\.unit(\d)\..*/, "FX$1") };
}

// ───────────────────────────── small pieces ─────────────────────────────

/** 2 DECK | 4 DECK in the workspace toolbar. Switching never touches playback or the mixer. */
export function DeckModeSwitch() {
  const app = useApp();
  const ws = useWorkspace();
  const key = app.keyboard.bindingFor("workspace.deckMode.toggle");
  const hint = key ? ` · ${keyBindingLabel(key)}` : "";
  return (
    <div className="deck-mode-switch" role="radiogroup" aria-label="Deck mode">
      {([2, 4] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={ws.deckMode === m}
          className={ws.deckMode === m ? "active" : ""}
          title={`${m === 2 ? "Two decks (A, B)" : "Four decks (A, B, C, D)"} — switching never stops playback${hint}`}
          onClick={() => app.workspace.setDeckMode(m)}
          aria-label={`${m} DECK`}
        >
          {m}<span className="dm-word"> DECK</span>
        </button>
      ))}
    </div>
  );
}

export function DeckBadge({ deck, small }: { deck: number; small?: boolean }) {
  return (
    <span className={`deck-letter deck-badge${small ? " small" : ""}`} aria-label={`Deck ${deckLetter(deck)}`}>
      {deckLetter(deck)}
    </span>
  );
}

/** ON AIR / OFF AIR from routing + playback + post-fader signal (core/engine/audibility.ts). */
export function OnAirBadge({ deck }: { deck: number }) {
  const { engine, audio } = useApp();
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef("");
  useAnimationFrame(() => {
    const el = ref.current;
    const s = engine.getState();
    const d = s.decks[deck];
    if (!el || !d) return;
    const a = audibility({ playing: d.playing, outputGain: engine.channelRouting(deck).outputGain, masterGain: faderToGain(s.mixer.masterLevel), level: audio.getLevels().channels[deck] ?? 0 });
    if (a === last.current) return;
    last.current = a;
    el.dataset.state = a;
    el.textContent = a === "on-air" ? "ON AIR" : a === "tail" ? "ON AIR · TAIL" : a === "off-air" ? "OFF AIR" : "";
    el.title =
      a === "on-air" ? "Audible on the master output"
      : a === "tail" ? "Stopped, but its effect tail is still audible on the master"
      : a === "off-air" ? "Playing, but the channel fader, crossfader, mute or master keeps it off the master output"
      : "";
  });
  return <span ref={ref} className="on-air-badge" data-state="stopped" role="status" />;
}

/**
 * Text chips for a deck's states (never colour alone): load/play state, LOOP, SYNC, MASTER, headphone CUE,
 * which controller side drives it, keyboard focus, and ON AIR.
 */
export function DeckStatusChips({ deck, compact }: { deck: number; compact?: boolean }) {
  const { engine } = useApp();
  const s = useEngineState();
  const ws = useWorkspace();
  const layers = useLayerState();
  const d = s.decks[deck];
  if (!d) return null;
  const play =
    d.status === "empty" ? "EMPTY"
    : d.status === "loading" ? "LOADING"
    : d.status === "error" ? "ERROR"
    : d.playing ? "▶ PLAYING"
    : Math.abs(engine.getPosition(deck) - d.cuePoint) < 0.05 ? "READY"
    : "❚❚ PAUSED";
  const side = layers.enabled ? (layers.left === deck ? "left" : layers.right === deck ? "right" : null) : null;
  return (
    <span className={`deck-chips${compact ? " compact" : ""}`}>
      <span className={`chip state-${d.status}${d.playing ? " playing" : ""}`}>{play}</span>
      {d.loop?.active && <span className="chip loop">LOOP</span>}
      {d.sync && <span className="chip sync">SYNC</span>}
      {s.masterDeck === deck && <span className="chip master">MASTER</span>}
      {s.mixer.channels[deck]?.pfl && <span className="chip cue" title="Headphone cue (PFL) on">🎧 CUE</span>}
      {side && <span className="chip hw" title={`The ${side} side of the controller drives this deck`}>{side === "left" ? "◀ CTRL L" : "CTRL R ▶"}</span>}
      {ws.deckMode === 4 && ws.focusedDeck === deck && <span className="chip kb" title="Keyboard focus: Shift+L loads the selected track here">⌨ FOCUS</span>}
      <OnAirBadge deck={deck} />
    </span>
  );
}

/** Beat phase against the master: centre = aligned; the marker shows how far ahead/behind (±½ beat). */
export function PhaseMeter({ deck }: { deck: number }) {
  const { engine } = useApp();
  const marker = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useAnimationFrame(() => {
    const s = engine.getState();
    const m = s.masterDeck;
    const el = marker.current;
    const r = root.current;
    if (!el || !r) return;
    const err = m === null || m === deck ? null : engine.phaseError(deck, m);
    r.dataset.state = m === deck ? "master" : err === null ? "none" : Math.abs(err) < 0.02 ? "locked" : "off";
    el.style.left = `${50 + (err ?? 0) * 100}%`;
    r.title = m === deck ? "This deck is the tempo master" : err === null ? "Phase: both this deck and the master need to be playing with beat grids" : `Phase ${err >= 0 ? "+" : ""}${err.toFixed(3)} beat vs deck ${deckLetter(m!)}`;
  });
  return (
    <div ref={root} className="phase-meter" data-state="none" aria-label="Beat phase against the master">
      <span className="phase-centre" />
      <span ref={marker} className="phase-marker" />
    </div>
  );
}

/** Drag-and-drop a library track or audio files onto any deck (any density). */
export function useDeckDrop(deck: number) {
  const app = useApp();
  const [over, setOver] = useState(false);
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      if (types.includes("application/x-dbdj-track") || types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const raw = e.dataTransfer.getData("application/x-dbdj-track");
      if (raw) {
        void app.matching.loadToDeck(deck, JSON.parse(raw));
        return;
      }
      const files = [...e.dataTransfer.files];
      if (files.length) void app.platform.refsFromDrop(files).then((refs) => app.addFiles(refs, deck)).catch((err) => app.log.error("library", `Drop failed: ${String(err)}`));
    },
  };
  return { over, handlers };
}

/** Press/release for momentary actions (CUE, hot cues). */
export function Hold(props: { action: string; className?: string; children: ReactNode; title?: string; style?: React.CSSProperties; disabled?: boolean }) {
  const send = useSend();
  return (
    <button
      className={props.className}
      title={props.title}
      style={props.style}
      disabled={props.disabled}
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

function TimeReadout({ deck }: { deck: number }) {
  const { engine } = useApp();
  const ref = useRef<HTMLSpanElement>(null);
  useAnimationFrame(() => {
    const d = engine.getState().decks[deck];
    if (ref.current && d) ref.current.textContent = d.status === "ready" ? `-${formatTime(d.duration - engine.getPosition(deck))}` : "";
  });
  return <span ref={ref} className="sd-time" />;
}

/** Thin progress bar; click/drag to seek (play state untouched). */
function ProgressBar({ deck }: { deck: number }) {
  const { engine } = useApp();
  const send = useSend();
  const fill = useRef<HTMLSpanElement>(null);
  const seeking = useRef(false);
  useAnimationFrame(() => {
    const d = engine.getState().decks[deck];
    if (fill.current) fill.current.style.width = d && d.duration > 0 ? `${(engine.getPosition(deck) / d.duration) * 100}%` : "0%";
  });
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    send(`deck${deck + 1}.seek`, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };
  return (
    <div
      className="md-progress"
      title="Playback position — click or drag to jump"
      onPointerDown={(e) => {
        const d = engine.getState().decks[deck];
        if (!d || d.status !== "ready") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seeking.current = true;
        seek(e);
      }}
      onPointerMove={(e) => seeking.current && seek(e)}
      onPointerUp={() => (seeking.current = false)}
      onPointerCancel={() => (seeking.current = false)}
    >
      <span ref={fill} />
    </div>
  );
}

const DENSITY_LABEL: Record<DeckDensity, string> = { micro: "Slim row", compact: "Compact", full: "Full deck" };

/** Expand/collapse a secondary deck (C/D) between micro, compact and full. Never touches playback. */
export function DensityButtons({ deck, density }: { deck: number; density: DeckDensity }) {
  const { workspace } = useApp();
  const order: DeckDensity[] = ["micro", "compact", "full"];
  const i = order.indexOf(density);
  const L = deckLetter(deck);
  return (
    <span className="density-buttons">
      {i > 0 && (
        <button className="tiny density-btn" aria-label={`Collapse deck ${L} to ${DENSITY_LABEL[order[i - 1]].toLowerCase()}`} title={`Collapse deck ${L} (${DENSITY_LABEL[order[i - 1]]}) — playback continues`} onClick={() => workspace.setDensity(deck, order[i - 1])}>
          ▾
        </button>
      )}
      {i < order.length - 1 && (
        <button className="tiny density-btn" aria-label={`Expand deck ${L} to ${DENSITY_LABEL[order[i + 1]].toLowerCase()}`} title={`Expand deck ${L} (${DENSITY_LABEL[order[i + 1]]}) — playback continues`} onClick={() => workspace.setDensity(deck, order[i + 1])}>
          ▴
        </button>
      )}
    </span>
  );
}

/** Classes shared by every deck density: identity, hardware focus (with a flash on change), keyboard focus, dimming. */
export function useDeckFrameClass(deck: number): string {
  const s = useEngineState();
  const ws = useWorkspace();
  const layers = useLayerState();
  const d = s.decks[deck];
  const side = layers.enabled ? (layers.left === deck ? "left" : layers.right === deck ? "right" : null) : null;
  const [flash, setFlash] = useState(false);
  const seen = useRef(layers.seq);
  useEffect(() => {
    if (layers.seq === seen.current) return;
    seen.current = layers.seq;
    if (!layers.changed || layers[layers.changed] !== deck) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
  }, [layers, deck]);
  const four = ws.deckMode === 4;
  return [
    `deck-${deckCssLetter(deck)}`,
    d?.playing ? "is-playing" : "",
    four && side ? `hw-focus hw-${side}` : "",
    four && flash ? "hw-flash" : "",
    four && ws.focusedDeck === deck ? "kb-focus" : "",
    four && !d?.playing ? "inactive" : "",
  ].filter(Boolean).join(" ");
}

/** Corner tag on the deck the controller side drives (4 DECK mode). */
export function HardwareTag({ deck }: { deck: number }) {
  const layers = useLayerState();
  if (!layers.enabled) return null;
  const side = layers.left === deck ? "left" : layers.right === deck ? "right" : null;
  if (!side) return null;
  return <span className={`hw-tag hw-${side}`}>{side === "left" ? "◀ LEFT CONTROLLER" : "RIGHT CONTROLLER ▶"}</span>;
}

// ───────────────────────────── secondary deck densities ─────────────────────────────

/** Compact deck: title/artist, BPM, position, phase, play/cue/sync, 8 hot cues, headphone cue, ON AIR. */
export function CompactDeck({ deck }: { deck: number }) {
  const { engine, bus } = useApp();
  const s = useEngineState();
  const send = useSend();
  const d = s.decks[deck];
  const c = s.mixer.channels[deck];
  const frame = useDeckFrameClass(deck);
  const { over, handlers } = useDeckDrop(deck);
  const p = `deck${deck + 1}`;
  const bpm = engine.getBpm(deck);
  const ready = d.status === "ready";
  return (
    <section className={`deck secondary compact-deck ${frame}${over ? " drag-over" : ""}`} {...handlers} onPointerDown={() => bus.send(`workspace.focus.deck${deck + 1}`, 1, "ui")} aria-label={`Deck ${deckLetter(deck)} (compact)`}>
      <header className="sd-head">
        <DeckBadge deck={deck} />
        <div className="sd-meta">
          <span className="sd-title" title={d.track?.title}>{d.track?.title ?? "Empty — drop a track or use Load to Deck " + deckLetter(deck)}</span>
          <span className="sd-artist">{d.track?.artist ?? ""}</span>
        </div>
        <span className="sd-bpm" title="Current tempo (BPM)">{bpm ? bpm.toFixed(1) : "—"}</span>
        <TimeReadout deck={deck} />
        <DeckStatusChips deck={deck} compact />
        <DensityButtons deck={deck} density="compact" />
      </header>
      <div className="sd-body">
        <div className="sd-wave"><OverviewWaveform deck={deck} /></div>
        <PhaseMeter deck={deck} />
        <div className="sd-transport">
          <Hold action={`${p}.cue`} className={`round small cue ${engine.getFeedback(`${p}.cue`) ? "lit" : ""}`} disabled={!ready}>CUE</Hold>
          <button className={`round small play ${d.playing ? "lit" : ""}`} disabled={!ready} onClick={() => send(`${p}.play`)} aria-label={`Play/Pause deck ${deckLetter(deck)}`}>{d.playing ? "❚❚" : "▶"}</button>
          <button className={`tiny ${d.sync ? "lit" : ""}`} disabled={!ready} onClick={() => send(`${p}.sync`)} title="Beat sync to the master">SYNC</button>
        </div>
        <div className="sd-pads" role="group" aria-label={`Deck ${deckLetter(deck)} hot cues`}>
          {d.hotcues.map((hc, i) => (
            <Hold
              key={i}
              action={`${p}.hotcue.${i + 1}`}
              className={`pad mini ${hc != null ? "set" : ""}`}
              disabled={!ready}
              style={hc != null ? { borderColor: HOTCUE_COLORS[i], background: `${HOTCUE_COLORS[i]}33` } : undefined}
              title={hc != null ? `Hot cue ${String.fromCharCode(65 + i)} @ ${formatTime(hc)}` : `Set hot cue ${String.fromCharCode(65 + i)}`}
            >
              {String.fromCharCode(65 + i)}
            </Hold>
          ))}
        </div>
        <button className={`cue-btn ${c?.pfl ? "lit" : ""}`} onClick={() => send(`mixer.channel${deck + 1}.cue`)} title="Headphone cue (PFL) — never changes what's on the master">🎧</button>
      </div>
    </section>
  );
}

/**
 * Micro deck: one slim row — identifier, track, BPM, play/pause, progress, ON AIR, expand.
 * `indicator`: shown in 2 DECK mode while a hidden deck C/D plays — adds its channel volume and headphone
 * cue, and "expand" switches to 4 DECK mode. A playing deck is never silently hidden.
 */
export function MicroDeck({ deck, indicator }: { deck: number; indicator?: boolean }) {
  const app = useApp();
  const { engine, workspace, bus } = app;
  const s = useEngineState();
  const send = useSend();
  const d = s.decks[deck];
  const c = s.mixer.channels[deck];
  const frame = useDeckFrameClass(deck);
  const { over, handlers } = useDeckDrop(deck);
  const bpm = engine.getBpm(deck);
  const p = `deck${deck + 1}`;
  const expand = () => {
    if (indicator) {
      if (workspace.densityOf(deck) === "micro") workspace.setDensity(deck, "compact");
      workspace.setDeckMode(4);
    } else workspace.setDensity(deck, "compact");
  };
  return (
    <section className={`deck secondary micro-deck ${frame}${indicator ? " hidden-indicator" : ""}${over ? " drag-over" : ""}`} {...handlers} onPointerDown={() => !indicator && bus.send(`workspace.focus.deck${deck + 1}`, 1, "ui")} aria-label={`Deck ${deckLetter(deck)}${indicator ? " (playing outside 2 DECK view)" : " (slim)"}`}>
      <DeckBadge deck={deck} small />
      {indicator && <span className="md-note" title="This deck is still playing — it isn't shown in 2 DECK mode">PLAYING</span>}
      <span className="md-title" title={d.track ? `${d.track.title} — ${d.track.artist}` : ""}>{d.track?.title ?? "Empty"}</span>
      <span className="md-bpm">{bpm ? bpm.toFixed(1) : "—"}</span>
      <button className={`tiny md-play ${d.playing ? "lit" : ""}`} disabled={d.status !== "ready"} onClick={() => send(`${p}.play`)} aria-label={`Play/Pause deck ${deckLetter(deck)}`}>{d.playing ? "❚❚" : "▶"}</button>
      <ProgressBar deck={deck} />
      {indicator && (
        <>
          <input className="md-volume" type="range" min={0} max={1} step={0.001} value={c?.volume ?? 0} aria-label={`Deck ${deckLetter(deck)} channel volume`} title="Channel volume" onChange={(e) => send(`mixer.channel${deck + 1}.volume`, Number(e.target.value))} />
          <button className={`tiny ${c?.pfl ? "lit" : ""}`} onClick={() => send(`mixer.channel${deck + 1}.cue`)} title="Headphone cue (PFL)">🎧</button>
        </>
      )}
      <OnAirBadge deck={deck} />
      <button className="tiny density-btn" onClick={expand} aria-label={indicator ? `Show deck ${deckLetter(deck)} (switch to 4 DECK)` : `Expand deck ${deckLetter(deck)}`} title={indicator ? "Show all four decks (playback continues)" : "Expand (playback continues)"}>
        {indicator ? "4 DECK ⤢" : "▴"}
      </button>
    </section>
  );
}

// ───────────────────────────── four-deck bar ─────────────────────────────

/** Software layer selector + indicator for one controller side ("LEFT CONTROLLER: DECK C"). */
function ControllerSideSelector({ side }: { side: ControllerSide }) {
  const app = useApp();
  const layers = useLayerState();
  const current = layers[side];
  const key = app.keyboard.bindingFor(`controller.layer.${side}.toggle`);
  const connected = app.controllers.getControllers().some((c) => c.connected && c.mappingId);
  return (
    <div className={`hw-side hw-${side}`} role="group" aria-label={`${side === "left" ? "Left" : "Right"} controller side`}>
      <span className="hw-side-label" title={connected ? "Controller connected" : "No mapped controller connected — the selection still applies when one connects"}>
        {side === "left" ? "◀ LEFT CONTROLLER" : "RIGHT CONTROLLER ▶"}
      </span>
      {SIDE_DECKS[side].map((deck) => (
        <button
          key={deck}
          className={`tiny hw-pick deck-scope-${deckCssLetter(deck)}${current === deck ? " lit" : ""}`}
          aria-pressed={current === deck}
          onClick={() => app.controllers.layers.set(side, deck)}
          title={`${side === "left" ? "Left" : "Right"} side of the controller drives deck ${deckLetter(deck)} — DDJ-SB: SHIFT + KEY LOCK (TEMPO RANGE)${key ? ` · keyboard ${keyBindingLabel(key)}` : ""}`}
        >
          DECK {deckLetter(deck)}
        </button>
      ))}
    </div>
  );
}

/** Master clock: master deck, BPM, sync count, beat in bar, play state; pick any eligible deck as master. */
function MasterClock() {
  const { engine } = useApp();
  const send = useSend();
  const s = useEngineState();
  const m = s.masterDeck;
  const bpmRef = useRef<HTMLSpanElement>(null);
  const dots = useRef<(HTMLSpanElement | null)[]>([]);
  const stateRef = useRef<HTMLSpanElement>(null);
  const synced = s.decks.filter((d) => d.sync && d.index !== m && d.status === "ready").length;
  useAnimationFrame(() => {
    const st = engine.getState();
    const mm = st.masterDeck;
    const d = mm === null ? null : st.decks[mm];
    const bpm = mm === null ? null : engine.getBpm(mm);
    if (bpmRef.current) bpmRef.current.textContent = bpm ? bpm.toFixed(2) : "—";
    const g = d?.beatGrid;
    const beat = g && mm !== null ? Math.floor((((engine.getPosition(mm) - g.firstBeat) / (60 / g.bpm)) % 4 + 4) % 4) : -1;
    dots.current.forEach((el, i) => el?.classList.toggle("on", i === beat && !!d?.playing));
    if (stateRef.current) stateRef.current.textContent = d?.playing ? "▶" : "■";
  });
  const eligible = s.decks.filter((d) => d.status === "ready" && (d.beatGrid?.bpm || d.track?.bpm));
  return (
    <div className={`master-clock${m !== null ? ` deck-scope-${deckCssLetter(m)}` : ""}`} role="group" aria-label="Master clock">
      <b>MASTER</b>
      <span className="mc-source" title={m === null ? "No tempo master yet — press SYNC or MASTER on a deck" : `Synced decks follow deck ${deckLetter(m)}`}>{m === null ? "NONE" : `DECK ${deckLetter(m)}`}</span>
      <span className="mc-bpm"><span ref={bpmRef}>—</span> <small>BPM</small></span>
      <span className="mc-beats" aria-hidden>{[0, 1, 2, 3].map((i) => <span key={i} ref={(el) => { dots.current[i] = el; }} className={i === 0 ? "downbeat" : ""} />)}</span>
      <span ref={stateRef} className="mc-state" title="Master playing / stopped">■</span>
      <span className="mc-sync" title="Decks with SYNC following the master">{synced} SYNCED</span>
      <span className="mc-pick" role="group" aria-label="Make a deck the master">
        {eligible.map((d) => (
          <button key={d.index} className={`tiny deck-scope-${deckCssLetter(d.index)}${m === d.index ? " lit" : ""}`} onClick={() => send(`deck${d.index + 1}.master`)} title={`Make deck ${deckLetter(d.index)} the tempo master (no tempo jump)`}>
            {deckLetter(d.index)}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Controls waiting for pickup after a layer switch / software change: which way to move them. */
function PickupGuide() {
  const pickups = usePickups();
  const { engine } = useApp();
  if (!pickups.length) return null;
  return (
    <div className="pickup-guide" role="status" aria-live="polite">
      {pickups.slice(-3).map((p) => {
        const { deck, label } = pickupLabel(p.target);
        const sw = engine.getActionValue(p.target) ?? p.software;
        return (
          <span key={p.target} className={`pickup-chip${deck !== null ? ` deck-scope-${deckCssLetter(deck)}` : ""}`} title={`Soft takeover: move the hardware control ${p.direction > 0 ? "up / right" : "down / left"} to ${Math.round(sw * 100)}% to pick up ${deck !== null ? `deck ${deckLetter(deck)} ` : ""}${label}`}>
            {deck !== null && <b>{deckLetter(deck)}</b>} {label} {p.direction > 0 ? "▲" : "▼"} {Math.round(sw * 100)}%
          </span>
        );
      })}
    </div>
  );
}

/** Slim bar under the waveforms in 4 DECK mode: left controller side, master clock, pickups, right side. */
export function FourDeckBar() {
  return (
    <div className="four-deck-bar">
      <ControllerSideSelector side="left" />
      <MasterClock />
      <PickupGuide />
      <ControllerSideSelector side="right" />
    </div>
  );
}


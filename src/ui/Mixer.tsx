/** Mixer console (between the decks): per-channel TRIM / EQ / FILTER / CUE / fader + meters, master, crossfader. */
import { useEffect, useRef, useState } from "react";
import { deckLetter } from "../core/actions";
import { dbToEqKnob, describeEqKnob, describeFaderKnob, describeFilterKnob, describeGainKnob, describeHeadMixKnob, eqKnobToDb, EQ_KILL_DB } from "../core/engine/mixerMath";
import { useApp, useEngineState, useSend } from "./context";
import { useAnimationFrame } from "./hooks";
import { clampRaw, dragDelta, FINE_FACTOR, KEY_STEP, rawToValue, stepValue, valueToRaw, wheelDelta } from "./knobMath";
import { CROSSFADER_ASSIGNS, type CrossfaderAssign } from "../core/engine/DJEngine";
import type { Pickup } from "../controllers/softTakeover";
import { mixerLayout } from "../workspace/WorkspaceStore";
import { deckCssLetter } from "./deckTheme";
import { useLayerState, usePickups, useWorkspace } from "./FourDeck";
import { useAutoDJ } from "./PlaylistPanel";

/** How long the live readout stays up after the last turn (a learning aid, not a permanent display). */
const READOUT_LINGER_MS = 1200;

/**
 * Rotary knob: drag up/down (or left/right) or scroll the wheel over it; hold Shift for fine
 * control. Bipolar knobs catch at the centre and double-click back to it. Response: knobMath.ts.
 * `describe`, when given, drives a live floating readout (e.g. "+2.3 dB") while the knob is being
 * turned — a "what is this actually doing" aid, not a permanent fixture on the dense mixer.
 */
export function Knob(props: {
  label: string;
  value: number;
  action: string;
  kill?: boolean;
  killAction?: string;
  bipolar?: boolean;
  size?: number;
  /** Training: control id for highlighting */
  train?: string;
  describe?: (value: number) => string;
  /**
   * Where the dial is actually drawn (0..1), when that differs from the stored knob position —
   * e.g. Auto EQ cutting the band further than `value` alone says. Dragging/stepping still moves
   * the real `value`; only the needle, arc and readout reflect this. Defaults to `value`.
   */
  effectiveValue?: number;
  /** True while something other than the user is actively driving `effectiveValue` (e.g. Auto EQ). */
  auto?: boolean;
  /** Soft takeover: the hardware knob is elsewhere and waiting to pick up — drawn as a ghost needle + arrow. */
  pickup?: Pickup;
}) {
  const send = useSend();
  const size = props.size ?? 30;
  const bipolar = !!props.bipolar;
  const dial = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; raw: number } | null>(null);
  const [showReadout, setShowReadout] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpReadout = () => {
    if (!props.describe) return;
    setShowReadout(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowReadout(false), READOUT_LINGER_MS);
  };
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  const display = props.effectiveValue ?? props.value;
  // Surfaces automated movement too (Auto EQ etc.), not just the user's own drag/scroll/keys.
  const prevDisplay = useRef(display);
  useEffect(() => {
    if (Math.abs(display - prevDisplay.current) > 0.001) bumpReadout();
    prevDisplay.current = display;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);
  // Latest props for the native wheel listener, which is attached once.
  const live = useRef({ value: props.value, action: props.action, bipolar, send, bumpReadout });
  live.current = { value: props.value, action: props.action, bipolar, send, bumpReadout };
  const deg = (display - 0.5) * 270;
  const fine = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }) => e.shiftKey || e.ctrlKey || e.altKey;

  // React's onWheel is passive and can't stop the page scrolling, so listen natively.
  useEffect(() => {
    const el = dial.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = live.current;
      const next = stepValue(k.value, wheelDelta(e, fine(e)), k.bipolar);
      if (next !== k.value) k.send(k.action, next);
      k.bumpReadout();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, raw: valueToRaw(props.value, bipolar) };
    bumpReadout();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // Incremental, so pressing Shift mid-drag changes the speed without a jump.
    d.raw = clampRaw(d.raw + dragDelta(e.clientX - d.x, e.clientY - d.y, fine(e)), bipolar);
    d.x = e.clientX;
    d.y = e.clientY;
    const next = rawToValue(d.raw, bipolar);
    if (next !== props.value) send(props.action, next);
    bumpReadout();
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP * (fine(e) ? FINE_FACTOR : 1);
    const delta = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 0.1, PageDown: -0.1 }[e.key];
    let next: number | undefined;
    if (delta !== undefined) next = stepValue(props.value, delta, bipolar);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else if ((e.key === "Enter" || e.key === " ") && bipolar) next = 0.5;
    if (next === undefined) return;
    e.preventDefault();
    if (next !== props.value) send(props.action, next);
    bumpReadout();
  };

  return (
    <div className={`knob ${props.kill ? "killed" : ""} ${props.auto ? "auto-driven" : ""} ${props.pickup ? "pickup" : ""}`} data-train={props.train}>
      <div
        ref={dial}
        className="knob-dial"
        style={{ width: size, height: size, ["--deg" as string]: `${deg}deg` }}
        role="slider"
        tabIndex={0}
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(display * 100)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => { if (bipolar) send(props.action, 0.5); bumpReadout(); }}
        title={`${props.label} ${Math.round(props.value * 100)}% · drag or scroll · Shift for fine${bipolar ? " · double-click centres" : ""}`}
      >
        <svg viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="17" className="knob-track" />
          <path d={arcPath(bipolar ? 0.5 : 0, display)} className="knob-arc" />
          {props.pickup && <line x1="20" y1="2" x2="20" y2="9" className="knob-ghost" transform={`rotate(${(props.pickup.hardware - 0.5) * 270} 20 20)`} />}
        </svg>
        {props.pickup && <span className="knob-pickup" title={`Hardware knob at ${Math.round(props.pickup.hardware * 100)}% — turn it ${props.pickup.direction > 0 ? "right" : "left"} to pick up`}>{props.pickup.direction > 0 ? "↻" : "↺"}</span>}
        {props.describe && showReadout && <div className="knob-readout" role="status">{props.describe(display)}</div>}
      </div>
      <span className="knob-label">
        {props.label}
        {props.killAction && (
          <button className={`kill ${props.kill ? "lit" : ""}`} onClick={() => { send(props.killAction!); bumpReadout(); }} title="Kill">
            K
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * An EQ knob's view when Auto DJ's Auto EQ may be cutting the band further than the knob itself
 * says: the dial is drawn at the combined (manual + auto) position, coloured to show it's live,
 * and the readout names the auto contribution — without ever changing the stored knob value.
 */
function eqKnobView(manual: number, killed: boolean, autoDb: number) {
  if (killed || autoDb === 0) return { effectiveValue: manual, auto: false, describe: (v: number) => describeEqKnob(v, killed) };
  const manualDb = killed ? EQ_KILL_DB : eqKnobToDb(manual);
  const combinedDb = Math.max(EQ_KILL_DB, manualDb + autoDb);
  return {
    effectiveValue: dbToEqKnob(combinedDb),
    auto: true,
    describe: () => `${describeEqKnob(dbToEqKnob(combinedDb), false)} — Auto EQ (manual: ${describeEqKnob(manual, false)})`,
  };
}

/** SVG arc on a 270° knob from value a to b (0..1). */
function arcPath(a: number, b: number): string {
  const [from, to] = a < b ? [a, b] : [b, a];
  const ang = (v: number) => ((v * 270 - 225) * Math.PI) / 180;
  const pt = (v: number) => `${20 + 17 * Math.cos(ang(v))} ${20 + 17 * Math.sin(ang(v))}`;
  if (to - from < 0.002) return "";
  return `M ${pt(from)} A 17 17 0 ${(to - from) * 270 > 180 ? 1 : 0} 1 ${pt(to)}`;
}

function Meter({ index }: { index: number | "master" }) {
  const { audio } = useApp();
  const bar = useRef<HTMLDivElement>(null);
  const peakHold = useRef(0);
  useAnimationFrame(() => {
    const lv = audio.getLevels();
    const v = index === "master" ? lv.master : lv.channels[index] ?? 0;
    peakHold.current = Math.max(v, peakHold.current * 0.93);
    const db = 20 * Math.log10(Math.max(1e-5, peakHold.current));
    const pct = Math.max(0, Math.min(100, ((db + 48) / 48) * 100));
    if (bar.current) {
      bar.current.style.height = `${pct}%`;
      bar.current.dataset.clip = v >= 0.99 ? "1" : "0";
    }
  });
  return (
    <div className="meter" title="Peak level">
      <div className="meter-fill" ref={bar} />
    </div>
  );
}

const XF_LABEL: Record<CrossfaderAssign, string> = { left: "A", thru: "THRU", right: "B" };
const XF_ACTION: Record<CrossfaderAssign, string> = { left: "a", thru: "thru", right: "b" };

/** A | THRU | B: which side of the crossfader this channel is on (THRU = unaffected by it). */
function CrossfaderAssignSwitch({ deck }: { deck: number }) {
  const { engine } = useApp();
  useEngineState();
  const send = useSend();
  const cur = engine.getCrossfaderAssign(deck);
  return (
    <div className="xf-assign" role="radiogroup" aria-label={`Channel ${deckLetter(deck)} crossfader assignment`}>
      {CROSSFADER_ASSIGNS.map((a) => (
        <button
          key={a}
          role="radio"
          aria-checked={cur === a}
          className={cur === a ? "lit" : ""}
          onClick={() => send(`mixer.channel${deck + 1}.xfader.${XF_ACTION[a]}`)}
          title={a === "thru" ? "THRU: the crossfader doesn't affect this channel (channel fader and master still do)" : `Crossfader side ${XF_LABEL[a]}`}
        >
          {XF_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

/** Where the hardware fader physically is while it waits for soft-takeover pickup. */
function FaderGhost({ pickup }: { pickup: Pickup | undefined }) {
  if (!pickup) return null;
  return (
    <span className={`fader-ghost ${pickup.direction > 0 ? "up" : "down"}`} style={{ bottom: `${pickup.hardware * 100}%` }} title={`Hardware fader at ${Math.round(pickup.hardware * 100)}% — move it ${pickup.direction > 0 ? "up" : "down"} to pick up`}>
      {pickup.direction > 0 ? "▲" : "▼"}
    </span>
  );
}

export function Mixer({ dense }: { dense?: boolean }) {
  const state = useEngineState();
  const { audio, engine } = useApp();
  const ws = useWorkspace();
  const layers = useLayerState();
  const pickups = usePickups();
  const auto = useAutoDJ();
  const send = useSend();
  const mx = state.mixer;
  const quad = audio.getStatus().routing === "quad";
  const four = ws.deckMode === 4;
  const k = dense || four ? 22 : 26;
  const { left, right } = mixerLayout(ws);
  const pickupFor = (target: string) => pickups.find((p) => p.target === target);

  const strip = (i: number) => {
    const c = mx.channels[i];
    if (!c) return null;
    const a = state.autoEq[i];
    const autoEqActive = a.lowDb !== 0 || a.midDb !== 0 || a.highDb !== 0;
    const hi = eqKnobView(c.eqHigh, c.killHigh, a.highDb);
    const mid = eqKnobView(c.eqMid, c.killMid, a.midDb);
    const low = eqKnobView(c.eqLow, c.killLow, a.lowDb);
    const m = `mixer.channel${i + 1}`;
    const assign = engine.getCrossfaderAssign(i);
    const defaultAssign = assign === (i % 2 === 0 ? "left" : "right");
    const side = layers.enabled ? (layers.left === i ? "left" : layers.right === i ? "right" : null) : null;
    // Auto DJ drives the shared crossfader; a manual deck C/D on side A/B follows it.
    const followsAutoDj = i >= 2 && auto.status !== "OFF" && assign !== "thru";
    return (
      <div key={i} className={`strip channel-${deckCssLetter(i)}${side ? ` hw-focus hw-${side}` : ""}`}>
        <div className="strip-name">
          {deckLetter(i)}
          {side && <span className="strip-hw" title={`${side === "left" ? "Left" : "Right"} controller side`}>{side === "left" ? "◀" : "▶"}</span>}
          {autoEqActive && <span className="auto-eq-badge" title="Auto EQ is temporarily cutting this deck's EQ for the transition — move a knob to take a band back">AUTO EQ</span>}
          {followsAutoDj && <span className="auto-eq-badge xf-warn" title={`Auto DJ is moving the crossfader and this channel is on side ${XF_LABEL[assign]}, so it follows. Set THRU to keep deck ${deckLetter(i)} independent of Auto DJ.`}>XF ⚠</span>}
        </div>
        <div className="strip-knobs">
          <Knob size={k} label="TRIM" value={c.gain} action={`${m}.gain`} bipolar describe={describeGainKnob} pickup={pickupFor(`${m}.gain`)} />
          <Knob size={k} label="HI" value={c.eqHigh} effectiveValue={hi.effectiveValue} auto={hi.auto} action={`${m}.eq.high`} train={`eq-high-${deckLetter(i)}`} kill={c.killHigh} killAction={`${m}.eq.high.kill`} bipolar describe={hi.describe} pickup={pickupFor(`${m}.eq.high`)} />
          <Knob size={k} label="MID" value={c.eqMid} effectiveValue={mid.effectiveValue} auto={mid.auto} action={`${m}.eq.mid`} train={`eq-mid-${deckLetter(i)}`} kill={c.killMid} killAction={`${m}.eq.mid.kill`} bipolar describe={mid.describe} pickup={pickupFor(`${m}.eq.mid`)} />
          <Knob size={k} label="LOW" value={c.eqLow} effectiveValue={low.effectiveValue} auto={low.auto} action={`${m}.eq.low`} train={`eq-low-${deckLetter(i)}`} kill={c.killLow} killAction={`${m}.eq.low.kill`} bipolar describe={low.describe} pickup={pickupFor(`${m}.eq.low`)} />
          <Knob size={k} label="FILTER" value={c.filter} action={`${m}.filter`} train={`filter-${deckLetter(i)}`} bipolar describe={describeFilterKnob} pickup={pickupFor(`${m}.filter`)} />
        </div>
        <div className="strip-fader">
        <button
          className={`cue-btn ${c.pfl ? "lit" : ""}`}
          onClick={() => send(`${m}.cue`)}
          title={quad ? "Headphone cue (PFL) — any number of channels; never changes the master" : "Headphone cue needs a 4-output device (Settings → Audio → routing)"}
        >
          CUE
        </button>
        <div className="fader-row" data-train={`volume-${deckLetter(i)}`}>
          <Meter index={i} />
          <input
            type="range"
            className="vfader"
            min={0}
            max={1}
            step={0.001}
            value={c.volume}
            aria-label={`Channel ${deckLetter(i)} volume`}
            onChange={(e) => send(`${m}.volume`, Number(e.target.value))}
          />
          <FaderGhost pickup={pickupFor(`${m}.volume`)} />
        </div>
        </div>
        {(four || !defaultAssign) && <CrossfaderAssignSwitch deck={i} />}
      </div>
    );
  };

  return (
    <section className={`mixer ${dense ? "dense" : ""}${four ? " four" : ""}`}>
      <div className="mixer-strips">
        {left.map(strip)}
        <div className="strip master">
          <div className="strip-name">MASTER</div>
          <div className="strip-knobs">
            <Knob size={k} label="LEVEL" value={mx.masterLevel} action="mixer.master.level" bipolar={false} describe={describeFaderKnob} />
            <Knob size={k} label="HP MIX" value={mx.headMix} action="mixer.headphone.mix" bipolar={false} describe={describeHeadMixKnob} pickup={pickupFor("mixer.headphone.mix")} />
            <Knob size={k} label="HP LVL" value={mx.headLevel} action="mixer.headphone.level" bipolar={false} describe={describeFaderKnob} />
          </div>
          <div className="strip-fader">
            <div className="fader-row">
              <Meter index="master" />
            </div>
          </div>
        </div>
        {right.map(strip)}
      </div>
      <div className="crossfader" data-train="crossfader">
        <span className="xf-end deck-scope-a">A</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={mx.crossfader}
          aria-label="Crossfader"
          onChange={(e) => send("mixer.crossfader", Number(e.target.value))}
          onDoubleClick={() => send("mixer.crossfader", 0.5)}
        />
        <span className="xf-end deck-scope-b">B</span>
        <FaderGhostX pickup={pickupFor("mixer.crossfader")} />
      </div>
    </section>
  );
}

function FaderGhostX({ pickup }: { pickup: Pickup | undefined }) {
  if (!pickup) return null;
  return <span className="xf-ghost" style={{ left: `calc(26px + (100% - 52px) * ${pickup.hardware})` }} title={`Hardware crossfader at ${Math.round(pickup.hardware * 100)}% — move it ${pickup.direction > 0 ? "right" : "left"} to pick up`}>{pickup.direction > 0 ? "▶" : "◀"}</span>;
}


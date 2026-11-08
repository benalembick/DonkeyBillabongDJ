/** Mixer console (between the decks): per-channel TRIM / EQ / FILTER / CUE / fader + meters, master, crossfader. */
import { useEffect, useRef, useState } from "react";
import { deckLetter } from "../core/actions";
import { dbToEqKnob, describeEqKnob, describeFaderKnob, describeFilterKnob, describeGainKnob, describeHeadMixKnob, eqKnobToDb, EQ_KILL_DB } from "../core/engine/mixerMath";
import { useApp, useEngineState, useSend } from "./context";
import { useAnimationFrame } from "./hooks";
import { clampRaw, dragDelta, FINE_FACTOR, KEY_STEP, rawToValue, stepValue, valueToRaw, wheelDelta } from "./knobMath";

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
    <div className={`knob ${props.kill ? "killed" : ""} ${props.auto ? "auto-driven" : ""}`} data-train={props.train}>
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
        </svg>
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

export function Mixer({ dense }: { dense?: boolean }) {
  const state = useEngineState();
  const { audio } = useApp();
  const send = useSend();
  const mx = state.mixer;
  const quad = audio.getStatus().routing === "quad";
  const k = dense ? 22 : 26;

  const strip = (i: number) => {
    const c = mx.channels[i];
    const a = state.autoEq[i];
    const autoEqActive = a.lowDb !== 0 || a.midDb !== 0 || a.highDb !== 0;
    const hi = eqKnobView(c.eqHigh, c.killHigh, a.highDb);
    const mid = eqKnobView(c.eqMid, c.killMid, a.midDb);
    const low = eqKnobView(c.eqLow, c.killLow, a.lowDb);
    const m = `mixer.channel${i + 1}`;
    return (
      <div key={i} className={`strip channel-${deckLetter(i).toLowerCase()}`}>
        <div className="strip-name">{deckLetter(i)}{autoEqActive && <span className="auto-eq-badge" title="Auto EQ is temporarily cutting this deck's EQ for the transition — move a knob to take a band back">AUTO EQ</span>}</div>
        <div className="strip-knobs">
          <Knob size={k} label="TRIM" value={c.gain} action={`${m}.gain`} bipolar describe={describeGainKnob} />
          <Knob size={k} label="HI" value={c.eqHigh} effectiveValue={hi.effectiveValue} auto={hi.auto} action={`${m}.eq.high`} train={`eq-high-${deckLetter(i)}`} kill={c.killHigh} killAction={`${m}.eq.high.kill`} bipolar describe={hi.describe} />
          <Knob size={k} label="MID" value={c.eqMid} effectiveValue={mid.effectiveValue} auto={mid.auto} action={`${m}.eq.mid`} train={`eq-mid-${deckLetter(i)}`} kill={c.killMid} killAction={`${m}.eq.mid.kill`} bipolar describe={mid.describe} />
          <Knob size={k} label="LOW" value={c.eqLow} effectiveValue={low.effectiveValue} auto={low.auto} action={`${m}.eq.low`} train={`eq-low-${deckLetter(i)}`} kill={c.killLow} killAction={`${m}.eq.low.kill`} bipolar describe={low.describe} />
          <Knob size={k} label="FILTER" value={c.filter} action={`${m}.filter`} train={`filter-${deckLetter(i)}`} bipolar describe={describeFilterKnob} />
        </div>
        <div className="strip-fader">
        <button
          className={`cue-btn ${c.pfl ? "lit" : ""}`}
          onClick={() => send(`${m}.cue`)}
          title={quad ? "Headphone cue" : "Headphone cue needs a 4-output device (Settings → Audio → routing)"}
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
        </div>
        </div>
      </div>
    );
  };

  return (
    <section className={`mixer ${dense ? "dense" : ""}`}>
      <div className="mixer-strips">
        {strip(0)}
        <div className="strip master">
          <div className="strip-name">MASTER</div>
          <div className="strip-knobs">
            <Knob size={k} label="LEVEL" value={mx.masterLevel} action="mixer.master.level" bipolar={false} describe={describeFaderKnob} />
            <Knob size={k} label="HP MIX" value={mx.headMix} action="mixer.headphone.mix" bipolar={false} describe={describeHeadMixKnob} />
            <Knob size={k} label="HP LVL" value={mx.headLevel} action="mixer.headphone.level" bipolar={false} describe={describeFaderKnob} />
          </div>
          <div className="strip-fader">
            <div className="fader-row">
              <Meter index="master" />
            </div>
          </div>
        </div>
        {strip(1)}
      </div>
      <div className="crossfader" data-train="crossfader">
        <span>A</span>
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
        <span>B</span>
      </div>
    </section>
  );
}

/** Mixer console (between the decks): per-channel TRIM / EQ / FILTER / CUE / fader + meters, master, crossfader. */
import { useRef } from "react";
import { deckLetter } from "../core/actions";
import { useApp, useEngineState, useSend } from "./context";
import { useAnimationFrame } from "./hooks";

export function Knob(props: { label: string; value: number; action: string; kill?: boolean; killAction?: string; bipolar?: boolean; size?: number }) {
  const send = useSend();
  const size = props.size ?? 30;
  const deg = (props.value - 0.5) * 270;
  return (
    <div className={`knob ${props.kill ? "killed" : ""}`}>
      <div className="knob-dial" style={{ width: size, height: size, ["--deg" as string]: `${deg}deg` }}>
        <svg viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="17" className="knob-track" />
          <path d={arcPath(props.bipolar ? 0.5 : 0, props.value)} className="knob-arc" />
        </svg>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={props.value}
          aria-label={props.label}
          onChange={(e) => send(props.action, Number(e.target.value))}
          onDoubleClick={() => props.bipolar !== false && send(props.action, 0.5)}
          title={props.bipolar !== false ? `${props.label} (drag · double-click centres)` : props.label}
        />
      </div>
      <span className="knob-label">
        {props.label}
        {props.killAction && (
          <button className={`kill ${props.kill ? "lit" : ""}`} onClick={() => send(props.killAction!)} title="Kill">
            K
          </button>
        )}
      </span>
    </div>
  );
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
    const m = `mixer.channel${i + 1}`;
    return (
      <div key={i} className={`strip channel-${deckLetter(i).toLowerCase()}`}>
        <div className="strip-name">{deckLetter(i)}</div>
        <div className="strip-knobs">
          <Knob size={k} label="TRIM" value={c.gain} action={`${m}.gain`} bipolar />
          <Knob size={k} label="HI" value={c.eqHigh} action={`${m}.eq.high`} kill={c.killHigh} killAction={`${m}.eq.high.kill`} bipolar />
          <Knob size={k} label="MID" value={c.eqMid} action={`${m}.eq.mid`} kill={c.killMid} killAction={`${m}.eq.mid.kill`} bipolar />
          <Knob size={k} label="LOW" value={c.eqLow} action={`${m}.eq.low`} kill={c.killLow} killAction={`${m}.eq.low.kill`} bipolar />
          <Knob size={k} label="FILTER" value={c.filter} action={`${m}.filter`} bipolar />
        </div>
        <div className="strip-fader">
        <button
          className={`cue-btn ${c.pfl ? "lit" : ""}`}
          onClick={() => send(`${m}.cue`)}
          title={quad ? "Headphone cue" : "Headphone cue needs a 4-output device (Settings → Audio → routing)"}
        >
          CUE
        </button>
        <div className="fader-row">
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
            <Knob size={k} label="LEVEL" value={mx.masterLevel} action="mixer.master.level" bipolar={false} />
            <Knob size={k} label="HP MIX" value={mx.headMix} action="mixer.headphone.mix" bipolar={false} />
            <Knob size={k} label="HP LVL" value={mx.headLevel} action="mixer.headphone.level" bipolar={false} />
          </div>
          <div className="strip-fader">
            <div className="fader-row">
              <Meter index="master" />
            </div>
          </div>
        </div>
        {strip(1)}
      </div>
      <div className="crossfader">
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

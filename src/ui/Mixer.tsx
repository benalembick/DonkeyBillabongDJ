import { useRef } from "react";
import { deckLetter } from "../core/actions";
import { useApp, useEngineState, useSend } from "./context";
import { useAnimationFrame } from "./hooks";

function Knob(props: { label: string; value: number; action: string; kill?: boolean; killAction?: string }) {
  const send = useSend();
  const deg = (props.value - 0.5) * 270;
  return (
    <div className={`knob ${props.kill ? "killed" : ""}`}>
      <div className="knob-dial" style={{ ["--deg" as string]: `${deg}deg` }}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={props.value}
          aria-label={props.label}
          onChange={(e) => send(props.action, Number(e.target.value))}
          onDoubleClick={() => send(props.action, 0.5)}
          title={`${props.label} (double-click to centre)`}
        />
      </div>
      <span className="knob-label">
        {props.label}
        {props.killAction && (
          <button className={`tiny ${props.kill ? "lit" : ""}`} onClick={() => send(props.killAction!)} title="Kill">
            K
          </button>
        )}
      </span>
    </div>
  );
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

export function Mixer() {
  const state = useEngineState();
  const { audio } = useApp();
  const send = useSend();
  const mx = state.mixer;
  const quad = audio.getStatus().routing === "quad";

  return (
    <section className="mixer">
      <div className="mixer-channels">
        {mx.channels.map((c, i) => {
          const m = `mixer.channel${i + 1}`;
          return (
            <div key={i} className={`channel channel-${deckLetter(i).toLowerCase()}`}>
              <div className="channel-name">{deckLetter(i)}</div>
              <Knob label="GAIN" value={c.gain} action={`${m}.gain`} />
              <Knob label="HIGH" value={c.eqHigh} action={`${m}.eq.high`} kill={c.killHigh} killAction={`${m}.eq.high.kill`} />
              <Knob label="MID" value={c.eqMid} action={`${m}.eq.mid`} kill={c.killMid} killAction={`${m}.eq.mid.kill`} />
              <Knob label="LOW" value={c.eqLow} action={`${m}.eq.low`} kill={c.killLow} killAction={`${m}.eq.low.kill`} />
              <Knob label="FILTER" value={c.filter} action={`${m}.filter`} />
              <button
                className={`cue-btn ${c.pfl ? "lit" : ""}`}
                onClick={() => send(`${m}.cue`)}
                title={quad ? "Headphone cue" : "Headphone cue needs a 4-output device (Settings → Audio → routing)"}
              >
                🎧 CUE
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
          );
        })}
        <div className="channel master">
          <div className="channel-name">MASTER</div>
          <Knob label="LEVEL" value={mx.masterLevel} action="mixer.master.level" />
          <Knob label="HP MIX" value={mx.headMix} action="mixer.headphone.mix" />
          <Knob label="HP LEVEL" value={mx.headLevel} action="mixer.headphone.level" />
          <div className="fader-row">
            <Meter index="master" />
          </div>
        </div>
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

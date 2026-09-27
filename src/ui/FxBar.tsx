/** FX units across the top (FX1 / FX2): effect, beat length, level, parameter, ON, deck assign. */
import { deckLetter } from "../core/actions";
import { FX_BEATS, FX_TARGETS, FX_TYPES } from "../core/engine/DJEngine";
import { useEngineState, useSend } from "./context";
import { Knob } from "./Mixer";

const NAMES: Record<string, string> = { echo: "ECHO", delay: "DELAY", reverb: "REVERB", flanger: "FLANGER", filter: "FILTER" };
const PARAM: Record<string, string> = { echo: "FEEDBK", delay: "FEEDBK", reverb: "SIZE", flanger: "RATE", filter: "CUTOFF" };
const beatLabel = (b: number) => (b === 0.25 ? "1/4" : b === 0.5 ? "1/2" : b === 0.75 ? "3/4" : String(b));

export function FxBar() {
  const s = useEngineState();
  const send = useSend();
  return (
    <div className="fx-bar">
      {s.fx.map((f, u) => {
        const a = `fx.unit${u + 1}`;
        const timed = f.type === "echo" || f.type === "delay";
        return (
          <div key={u} className={`fx-unit ${f.on ? "on" : ""}`}>
            <span className="fx-name">FX{u + 1}</span>
            <select
              value={f.type}
              onChange={(e) => {
                // Step through types with the same action the controller uses.
                const target = FX_TYPES.indexOf(e.target.value as (typeof FX_TYPES)[number]);
                const cur = FX_TYPES.indexOf(f.type);
                const steps = (target - cur + FX_TYPES.length) % FX_TYPES.length;
                for (let i = 0; i < steps; i++) send(`${a}.chain.next`);
              }}
              aria-label={`FX${u + 1} effect`}
            >
              {FX_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NAMES[t]}
                </option>
              ))}
            </select>
            <div className={`fx-beats ${timed ? "" : "dim"}`} title={timed ? "Beat length (synced to the deck's BPM)" : "Beat length applies to echo/delay"}>
              <button className="tiny" onClick={() => send(`${a}.beats.prev`)} disabled={f.beats === FX_BEATS[0]}>‹</button>
              <span>{beatLabel(f.beats)}</span>
              <button className="tiny" onClick={() => send(`${a}.beats.next`)} disabled={f.beats === FX_BEATS[FX_BEATS.length - 1]}>›</button>
            </div>
            <Knob size={24} label="LEVEL" value={f.mix} action={`${a}.mix`} bipolar={false} />
            <Knob size={24} label={PARAM[f.type]} value={f.param} action={`${a}.param`} bipolar={f.type === "filter"} />
            <div className="fx-assign">
              {f.decks.map((on, d) => (
                <button key={d} className={`tiny ${on ? "lit" : ""}`} onClick={() => send(`${a}.assign.deck${d + 1}`)} title={`Apply FX${u + 1} to deck ${deckLetter(d)}`}>
                  {deckLetter(d)}
                </button>
              ))}
            </div>
            <select
              className="fx-target"
              value={f.target}
              disabled={f.type === "flanger" || f.type === "filter"}
              onChange={(e) => {
                const steps = (FX_TARGETS.indexOf(e.target.value as (typeof FX_TARGETS)[number]) - FX_TARGETS.indexOf(f.target) + FX_TARGETS.length) % FX_TARGETS.length;
                for (let i = 0; i < steps; i++) send(`${a}.target.next`);
              }}
              title="Send the whole deck, or only one stem, to this FX (echo / delay / reverb; needs STEMS analysed)"
              aria-label={`FX${u + 1} target`}
            >
              {FX_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t === "deck" ? "DECK" : t.toUpperCase()}
                </option>
              ))}
            </select>
            <button className={`fx-on ${f.on ? "lit" : ""}`} onClick={() => send(`${a}.on`)}>
              {f.on ? "ON" : "OFF"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

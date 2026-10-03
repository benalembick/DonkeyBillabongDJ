/**
 * FX units across the top (FX1 = deck A side, FX2 = deck B side, like the DDJ-SB).
 * Each unit has three effect slots matching the controller's FX1/FX2/FX3 buttons:
 * pick the effect, switch it on, set its parameter. Unit-wide: beat length, level
 * (the FX knob), deck assign and stem target.
 */
import { deckLetter } from "../core/actions";
import { FX_BEATS, FX_TARGETS, FX_TYPES } from "../core/engine/DJEngine";
import type { FxType } from "../core/engine/types";
import { useApp, useEngineState, useSend } from "./context";
import { Knob } from "./Mixer";

export const FX_NAMES: Record<FxType, string> = {
  echo: "ECHO",
  delay: "DELAY",
  reverb: "REVERB",
  flanger: "FLANGER",
  phaser: "PHASER",
  filter: "FILTER",
  bitcrusher: "CRUSH",
  distortion: "DRIVE",
  gate: "GATE",
  roll: "ROLL",
};
const PARAM: Record<FxType, string> = {
  echo: "FEEDBK",
  delay: "FEEDBK",
  reverb: "SIZE",
  flanger: "RATE",
  phaser: "RATE",
  filter: "CUTOFF",
  bitcrusher: "BITS",
  distortion: "DRIVE",
  gate: "DEPTH",
  roll: "DECAY",
};
const TIMED = new Set<FxType>(["echo", "delay", "gate", "roll"]);
const SEND_TYPES = new Set<FxType>(["echo", "delay", "reverb"]);
const beatLabel = (b: number) => (b === 0.125 ? "1/8" : b === 0.25 ? "1/4" : b === 0.5 ? "1/2" : b === 0.75 ? "3/4" : String(b));

export function FxBar() {
  const s = useEngineState();
  const { engine } = useApp();
  const send = useSend();
  return (
    <div className="fx-bar">
      {s.fx.map((f, u) => {
        const a = `fx.unit${u + 1}`;
        const anyOn = f.slots.some((x) => x.on);
        const timed = f.slots.some((x) => TIMED.has(x.type));
        const stemCapable = f.slots.some((x) => SEND_TYPES.has(x.type));
        return (
          <div key={u} className={`fx-unit ${anyOn ? "on" : ""}`} data-train={`fx-${u + 1}`}>
            <span className="fx-name" title={`FX unit ${u + 1} — DDJ-SB: FX buttons 1–3 switch the slots, SHIFT+button changes the effect, knob = level`}>
              FX{u + 1}
            </span>
            <div className="fx-slots">
              {f.slots.map((slot, k) => (
                <div key={k} className={`fx-slot ${slot.on ? "on" : ""}`}>
                  <select
                    value={slot.type}
                    onChange={(e) => engine.setFxSlotType(u, k, e.target.value as FxType)}
                    aria-label={`FX${u + 1} slot ${k + 1} effect`}
                    title={`FX${u + 1}-${k + 1} effect (remembered)`}
                  >
                    {FX_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {FX_NAMES[t]}
                      </option>
                    ))}
                  </select>
                  <Knob size={20} label={PARAM[slot.type]} value={slot.param} action={`${a}.slot${k + 1}.param`} bipolar={slot.type === "filter"} />
                  <button className={`fx-on ${slot.on ? "lit" : ""}`} onClick={() => send(`${a}.slot${k + 1}.toggle`)} title={`FX${u + 1} button ${k + 1}`}>
                    {k + 1}
                  </button>
                </div>
              ))}
            </div>
            <div className={`fx-beats ${timed ? "" : "dim"}`} title={timed ? "Beat length (synced to the deck's BPM)" : "Beat length applies to echo/delay/gate/roll"}>
              <button className="tiny" onClick={() => send(`${a}.beats.prev`)} disabled={f.beats === FX_BEATS[0]}>‹</button>
              <span>{beatLabel(f.beats)}</span>
              <button className="tiny" onClick={() => send(`${a}.beats.next`)} disabled={f.beats === FX_BEATS[FX_BEATS.length - 1]}>›</button>
            </div>
            <Knob size={24} label="LEVEL" value={f.mix} action={`${a}.mix`} bipolar={false} />
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
              disabled={!stemCapable}
              onChange={(e) => {
                const steps = (FX_TARGETS.indexOf(e.target.value as (typeof FX_TARGETS)[number]) - FX_TARGETS.indexOf(f.target) + FX_TARGETS.length) % FX_TARGETS.length;
                for (let i = 0; i < steps; i++) send(`${a}.target.next`);
              }}
              title="Send the whole deck, or only one stem, to this unit's echo / delay / reverb (needs STEMS analysed)"
              aria-label={`FX${u + 1} target`}
            >
              {FX_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t === "deck" ? "DECK" : t.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

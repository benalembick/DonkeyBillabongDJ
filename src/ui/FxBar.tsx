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
import { useWorkspace } from "./workspaceHooks";

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

/**
 * FX status: one chip per unit showing only what's live (lit effects + the decks they hit), shown whether
 * the FX controls are open or not; clicking a chip toggles them. While collapsed the chips carry the units'
 * data-train ids so training highlights still land on something (expanded, the full units have them).
 */
export function FxSummary({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const s = useEngineState();
  return (
    <div className="fx-summary" role="group" aria-label="Active effects">
      {s.fx.map((f, u) => {
        const lit = f.slots.filter((x) => x.on);
        const decks = f.decks.map((on, d) => (on ? deckLetter(d) : null)).filter(Boolean);
        const desc = lit.length ? `${lit.map((x) => FX_NAMES[x.type]).join(", ")}${decks.length ? ` on deck ${decks.join("+")}` : " (no deck assigned)"}` : "no effects on";
        return (
          <button key={u} className={`fx-chip deck-scope-${deckLetter(u).toLowerCase()}${lit.length ? " on" : ""}`} data-train={expanded ? undefined : `fx-${u + 1}`} aria-expanded={expanded} onClick={onToggle} title={`FX${u + 1}: ${desc} — click to ${expanded ? "hide" : "show"} the FX controls`} aria-label={`FX${u + 1}: ${desc}. ${expanded ? "Hide" : "Show"} FX controls`}>
            <span className="fx-chip-name">FX{u + 1}</span>
            {lit.length ? lit.map((x, k) => <b key={k} className="fx-badge">{FX_NAMES[x.type]}</b>) : <span className="fx-chip-off">off</span>}
            {lit.length > 0 && decks.length > 0 && <span className="fx-chip-decks">→{decks.join("")}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function FxBar() {
  const s = useEngineState();
  const { deckMode } = useWorkspace();
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
          // FX1 sits on deck A's side, FX2 on deck B's (as on the DDJ-SB): each unit wears its side's deck colour.
          <div key={u} className={`fx-unit deck-scope-${deckLetter(u).toLowerCase()} ${anyOn ? "on" : ""}`} data-train={`fx-${u + 1}`}>
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
              {/* 2 DECK mode offers A/B; an assigned hidden deck C/D stays visible (and can be unassigned). */}
              {f.decks.map((on, d) => d >= deckMode && !on ? null : (
                <button key={d} className={`tiny fx-assign-${deckLetter(d).toLowerCase()} ${on ? "lit" : ""}`} aria-pressed={on} onClick={() => send(`${a}.assign.deck${d + 1}`)} title={`Apply FX${u + 1} to deck ${deckLetter(d)}`}>
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

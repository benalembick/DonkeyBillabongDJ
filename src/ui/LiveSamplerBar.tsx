/**
 * Live sampler: the 16 Production Studio Sampler pads on the DJ screen, layered over the mix.
 * Pads dispatch the same `samplerN.play` actions a MIDI controller can be mapped to (Controller → MIDI learn).
 */
import { useState, useSyncExternalStore } from "react";
import { midiName } from "../production/midi";
import { PAD_BANKS, PADS_PER_BANK, padLabel } from "../production/types";
import { useApp, useSend } from "./context";

const OPEN_KEY = "dbdj.ui.liveSamplerOpen";
const readOpen = (): boolean => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } };

export function LiveSamplerBar() {
  const { production } = useApp();
  const send = useSend();
  const state = useSyncExternalStore(production.subscribe, production.getState, production.getState);
  const [open, setOpen] = useState(readOpen);
  const bank = state.project.sampler.bank;
  const pads = state.project.sampler.pads.slice(bank * PADS_PER_BANK, (bank + 1) * PADS_PER_BANK);
  const loaded = state.project.sampler.pads.filter((pad) => pad.sample).length;
  const chromatic = state.project.sampler.mode === "chromatic";
  const toggle = () => setOpen((was) => { try { localStorage.setItem(OPEN_KEY, was ? "0" : "1"); } catch { /* storage unavailable */ } return !was; });
  const openStudio = () => window.dispatchEvent(new CustomEvent("dbdj:navigate", { detail: "production" }));

  return (
    <div className={`live-sampler${open ? " open" : ""}`}>
      <div className="live-sampler-head">
        <button className="live-sampler-toggle" aria-expanded={open} onClick={toggle} title={open ? "Hide sampler pads" : "Show sampler pads"}>
          <span aria-hidden>{open ? "▾" : "▸"}</span> SAMPLER
        </button>
        <span className="live-sampler-count">
          {loaded ? `${loaded} pad${loaded === 1 ? "" : "s"} loaded` : "No samples on pads yet"}
          {state.padsPlaying.length > 0 && <b> · {state.padsPlaying.length} playing</b>}
        </span>
        {open && <>
          <div className="live-sampler-banks" role="group" aria-label="Pad bank">
            {PAD_BANKS.map((name, i) => { const used = state.project.sampler.pads.slice(i * PADS_PER_BANK, (i + 1) * PADS_PER_BANK).some((pad) => pad.sample); return <button key={name} className={`${bank === i ? "active" : ""}${used ? " used" : ""}`} aria-pressed={bank === i} title={`Pad bank ${name}`} onClick={() => send(`sampler.bank.${name.toLowerCase()}`)}>{name}</button>; })}
          </div>
          <label className="live-sampler-volume" title="Sampler pad volume">VOL
            <input type="range" min="0" max="1.5" step=".01" value={state.padVolume} onChange={(e) => send("sampler.volume", +e.target.value / 1.5)} />
          </label>
          <button disabled={!state.padsPlaying.length} onClick={() => send("sampler.stopall")}>■ STOP ALL</button>
        </>}
        <button className="live-sampler-edit" onClick={openStudio} title="Load, trim and assign samples in Production Studio → Sampler">EDIT PADS</button>
      </div>
      {open && (
        <div className="live-sampler-pads" role="group" aria-label="Sampler pads">
          {pads.map((pad) => {
            const note = production.padNote(pad.index); const playable = !!pad.sample || chromatic;
            const playing = chromatic ? state.notesPlaying.includes(note) : state.padsPlaying.includes(pad.index);
            const action = `sampler${pad.index % PADS_PER_BANK + 1}.play`;
            return (
              <button
                key={pad.index}
                className={`${playable ? "loaded" : "empty"}${playing ? " playing" : ""}`}
                disabled={!playable}
                aria-pressed={playing}
                aria-label={`Pad ${padLabel(pad.index)}${pad.sample ? `, ${pad.sample.name}, ${pad.sample.playbackMode}` : ", empty"}${playing ? ", playing" : ""}`}
                title={pad.sample ? `${pad.sample.name} · ${pad.sample.playbackMode.toUpperCase()}` : "Empty — assign a sample in Production Studio → Sampler"}
                onPointerDown={(e) => { if (e.button === 0) send(action, 1); }}
                onPointerUp={() => send(action, 0)}
                onPointerLeave={(e) => { if (e.buttons) send(action, 0); }}
              >
                <span className="pad-number">{padLabel(pad.index)}</span>
                <b>{chromatic ? midiName(note) : pad.sample?.name ?? "—"}</b>
                {playable && <small>{chromatic ? "CHROMATIC" : `${midiName(note)} · ${pad.sample!.playbackMode.toUpperCase()}`}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

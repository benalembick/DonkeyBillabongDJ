/**
 * Settings → FOUR DECKS & CONTROLLER LAYERS, and Diagnostics → FOUR-DECK PERFORMANCE.
 * See docs/architecture/four-deck-performance-engine.md §9–§10 and §15.
 */
import { useEffect, useState } from "react";
import { actionCatalog, deckLetter } from "../core/actions";
import { audibility } from "../core/engine/audibility";
import { faderToGain } from "../core/engine/mixerMath";
import { keyBindingLabel, REBINDABLE_ACTIONS, type KeyBinding } from "../input/keyboard";
import type { PickupMode } from "../controllers/softTakeover";
import type { MixerOrder } from "../workspace/WorkspaceStore";
import { useApp, useEngineState } from "./context";
import { useTick } from "./hooks";
import { waveStats } from "./Waveforms";
import { useWorkspace } from "./workspaceHooks";

/** Keyboard shortcut editor for rebindable workspace actions: press a key combination to assign it. */
function ShortcutEditor() {
  const { keyboard, rebindShortcut, resetShortcuts } = useApp();
  const [recording, setRecording] = useState<string | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopImmediatePropagation: the key being assigned must not also trigger its old action.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setRecording(null);
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const b: Omit<KeyBinding, "action"> = { code: e.code, ...(e.shiftKey ? { shift: true } : null), ...(e.ctrlKey || e.metaKey ? { ctrl: true } : null), ...(e.altKey ? { alt: true } : null) };
      rebindShortcut(recording, b);
      setRecording(null);
      bump((n) => n + 1);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, rebindShortcut]);
  return (
    <div className="shortcut-editor">
      <b>Workspace keyboard shortcuts</b>
      {REBINDABLE_ACTIONS.map((action) => {
        const b = keyboard.bindingFor(action);
        return (
          <div key={action} className="shortcut-row">
            <span>{actionCatalog().get(action)?.label ?? action}</span>
            <kbd>{recording === action ? "press keys… (Esc cancels)" : b ? keyBindingLabel(b) : "—"}</kbd>
            <button className="tiny" onClick={() => setRecording(recording === action ? null : action)}>{recording === action ? "Cancel" : "Change"}</button>
            <button className="tiny" disabled={!b} onClick={() => { rebindShortcut(action, null); bump((n) => n + 1); }}>Clear</button>
          </div>
        );
      })}
      <button className="tiny" onClick={() => { resetShortcuts(); bump((n) => n + 1); }}>Reset shortcuts to defaults</button>
    </div>
  );
}

export function FourDeckSettings() {
  const app = useApp();
  const ws = useWorkspace();
  const [, bump] = useState(0);
  const layers = app.controllers.layers.getSettings();
  const takeover = app.controllers.takeover?.getSettings();
  const perf = app.performancePrefs();
  const setLayers = (p: Partial<typeof layers>) => { app.saveControllerPrefs({ layers: p }); bump((n) => n + 1); };
  const setTakeover = (p: { mode?: PickupMode; tolerance?: number }) => { app.saveControllerPrefs({ takeover: p }); bump((n) => n + 1); };
  const setPerf = (p: Partial<typeof perf>) => { app.savePerformancePrefs(p); bump((n) => n + 1); };
  return (
    <fieldset className="four-deck-settings">
      <legend>FOUR DECKS &amp; CONTROLLER LAYERS</legend>
      <label>
        Deck mode
        <select value={ws.deckMode} onChange={(e) => app.workspace.setDeckMode(Number(e.target.value) === 4 ? 4 : 2)}>
          <option value={2}>2 DECK — decks A and B</option>
          <option value={4}>4 DECK — decks A, B, C and D</option>
        </select>
      </label>
      <label>
        4 DECK mixer order
        <select value={ws.mixerOrder} onChange={(e) => app.workspace.set({ mixerOrder: e.target.value as MixerOrder })}>
          <option value="3-1-2-4">C A | B D (follows the controller sides)</option>
          <option value="1-2-3-4">A B | C D</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={layers.layerButton} onChange={(e) => setLayers({ layerButton: e.target.checked })} />
        DDJ-SB: SHIFT + KEY LOCK (printed TEMPO RANGE) switches that side between decks A/C or B/D in 4 DECK mode (otherwise it stays tempo range)
      </label>
      <label>
        <input type="checkbox" checked={layers.followHardwareLayer} onChange={(e) => setLayers({ followHardwareLayer: e.target.checked })} />
        Follow Hardware Layer: highlight the deck a controller side switches to, and open it if it's collapsed
      </label>
      <label>
        <input type="checkbox" checked={layers.hardwareFollowsFocus} onChange={(e) => setLayers({ hardwareFollowsFocus: e.target.checked })} />
        Controller follows deck focus: clicking a deck (or Alt+1…4) also moves that controller side to it
      </label>
      {takeover && (
        <>
          <label>
            Soft takeover (faders, knobs, tempo)
            <select value={takeover.mode} onChange={(e) => setTakeover({ mode: e.target.value as PickupMode })}>
              <option value="pickup">Pickup — wait until the control reaches the deck's value (safest)</option>
              <option value="relative">Relative scaling — move the value proportionally until they meet</option>
              <option value="off">Off — the hardware value applies at once (can jump)</option>
            </select>
          </label>
          <label>
            Pickup tolerance
            <input type="range" min={0.01} max={0.1} step={0.005} value={takeover.tolerance} disabled={takeover.mode === "off"} onChange={(e) => setTakeover({ tolerance: Number(e.target.value) })} />
            <span>{Math.round(takeover.tolerance * 1000) / 10}%</span>
          </label>
        </>
      )}
      <label>
        Background analysis &amp; STEMS pre-analysis
        <select value={perf.deferBackgroundAt} onChange={(e) => setPerf({ deferBackgroundAt: Number(e.target.value) as 0 | 2 | 3 | 4 })}>
          <option value={0}>Always run</option>
          <option value={2}>Wait while 2+ decks play</option>
          <option value={3}>Wait while 3+ decks play</option>
          <option value={4}>Wait while 4 decks play</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={perf.clipGuard} onChange={(e) => setPerf({ clipGuard: e.target.checked })} />
        Master clip protection — soft-limits only peaks above −1 dBFS; quieter audio is untouched and channel levels are never changed
      </label>
      <ShortcutEditor />
    </fieldset>
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function FourDeckDiagnostics() {
  const { audio, engine, analysis, stems } = useApp();
  const s = useEngineState();
  useTick(1000);
  const p = audio.getPerformance();
  const loads = engine.getLoadStats();
  const ms = loads.map((l) => l.ms);
  const an = analysis.getState();
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  const levels = audio.getLevels();
  return (
    <>
      <h4>Four-deck performance</h4>
      <div className="diag-grid">
        <dl>
          <dt>Decks playing</dt>
          <dd>{s.decks.filter((d) => d.playing).length} of {s.decks.length}</dd>
          <dt>Per deck</dt>
          <dd>
            {s.decks.map((d, i) => {
              const a = audibility({ playing: d.playing, outputGain: engine.channelRouting(i).outputGain, masterGain: faderToGain(s.mixer.masterLevel), level: levels.channels[i] ?? 0 });
              return <div key={i}>{deckLetter(i)}: {d.status}{d.playing ? " · playing" : ""} · {a.toUpperCase()} · peak {(20 * Math.log10(Math.max(1e-5, levels.channels[i] ?? 0))).toFixed(1)} dBFS · {s.reservations[i] === "manual" ? "manual" : "automation"}</div>;
            })}
          </dd>
          <dt>Audio render load</dt>
          <dd>{p.renderCapacity ? `${(p.renderCapacity.averageLoad * 100).toFixed(1)}% average, ${(p.renderCapacity.peakLoad * 100).toFixed(1)}% peak, underrun ratio ${(p.renderCapacity.underrunRatio * 100).toFixed(2)}%` : "not exposed by this runtime (AudioContext.renderCapacity)"}</dd>
          <dt>Audio underruns</dt>
          <dd>{p.playbackStats ? `${p.playbackStats.underrunEvents} (${p.playbackStats.underrunDurationMs.toFixed(0)} ms of ${p.playbackStats.totalDurationS.toFixed(0)} s)` : "not exposed by this runtime (AudioContext.playbackStats)"}</dd>
          <dt>Audio clock stalls (estimate)</dt>
          <dd>{p.clockStalls} ({p.clockStallMs} ms) in {p.monitoredS} s — windows where audio rendering fell 30 ms+ behind the wall clock</dd>
          <dt>Master clip protection</dt>
          <dd>{p.clipGuard ? "on" : "off"} · peaks reached it {p.clipGuardEpisodes} time(s) · master peak {(20 * Math.log10(Math.max(1e-5, levels.master))).toFixed(1)} dBFS</dd>
        </dl>
        <dl>
          <dt>Track loading (request → ready)</dt>
          <dd>{ms.length ? `last ${Math.round(ms[ms.length - 1])} ms · average ${Math.round(avg(ms))} ms · max ${Math.round(Math.max(...ms))} ms (${ms.length} loads)` : "no loads yet"}</dd>
          <dt>Waveform drawing</dt>
          <dd>{waveStats.avg().toFixed(2)} ms per lane frame (average of recent frames)</dd>
          <dt>Memory (JS heap)</dt>
          <dd>{mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB used of ${(mem.totalJSHeapSize / 1048576).toFixed(0)} MB` : "n/a"}</dd>
          <dt>Background analysis</dt>
          <dd>{an.busy ? `${an.done}/${an.total}${an.current ? ` — ${an.current}` : ""}` : "idle"}{an.deferred ? ` · paused: ${an.deferred}` : ""}</dd>
          <dt>STEMS</dt>
          <dd>worker {stems.status.worker.state} · library queue {stems.status.libraryQueue}{stems.status.rtf ? ` · ${stems.status.rtf.toFixed(2)} s compute per s of audio` : ""}</dd>
        </dl>
      </div>
    </>
  );
}

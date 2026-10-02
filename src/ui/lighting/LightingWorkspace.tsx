/**
 * LIGHTING workspace: Virtual Console | DMX Desk | Fixtures | Inputs / Outputs.
 * Presentation only — all state lives in the LightingService / DmxEngine, so the
 * lights keep running (and the DDJ-SB can control them later) whichever page is open.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../context";
import { useAnimationFrame } from "../hooks";
import type { LightingConfig, LightingService, QlcImportReport, VcWidget } from "../../lighting/LightingService";
import { VC_WIDGET_TYPES } from "../../lighting/LightingService";
import { LAYER_DESK } from "../../lighting/DmxEngine";
import { CHANNEL_LABELS, addressRange, capabilityAt, channelMap, findDef, type ChannelType, type PatchedFixture } from "../../lighting/fixtures";
import { INPUT_LABELS, OUTPUT_LABELS, type InputKind, type LinkState, type OutputKind, type UniverseIo } from "../../lighting/io";
import { DEFAULT_MAPPINGS, MOVEMENT_PATTERNS, type MovementPattern, type MovementSettings, type SoundInput, type SoundMapping, type SoundSettings, type SoundSource } from "../../lighting/SoundToLight";

type Tab = "console" | "desk" | "fixtures" | "io";
const TABS: [Tab, string][] = [
  ["console", "Virtual Console"],
  ["desk", "DMX Desk"],
  ["fixtures", "Fixtures"],
  ["io", "Inputs / Outputs"],
];

function useLightingConfig(l: LightingService): LightingConfig {
  return useSyncExternalStore(
    (cb) => l.on("config", cb),
    () => l.getConfig(),
  );
}

/** Re-render when statuses change (outputs, USB, mic). */
function useLightingStatus(l: LightingService): number {
  const [n, setN] = useState(0);
  useEffect(() => l.on("status", () => setN((x) => x + 1)), [l]);
  return n;
}

/** Re-render at most ~30×/s while DMX values change (desk faders follow other sources live). */
function useDmxVersion(l: LightingService): number {
  const [v, setV] = useState(l.engine.version);
  const last = useRef(0);
  useAnimationFrame((t) => {
    if (t - last.current < 33) return;
    last.current = t;
    if (l.engine.version !== v) setV(l.engine.version);
  });
  return v;
}

const fixtureColour = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 45%)`;
};

export function LightingWorkspace() {
  const { lighting } = useApp();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem("dbdj.ui.lightingTab") as Tab) || "console";
    } catch {
      return "console";
    }
  });
  const choose = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem("dbdj.ui.lightingTab", t);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="lx">
      <nav className="lx-tabs" aria-label="Lighting">
        <span className="lx-title">LIGHTING</span>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
        <span className="lx-spacer" />
        <MasterStrip l={lighting} compact />
      </nav>
      <div className="lx-body">
        {tab === "console" && <VirtualConsole l={lighting} />}
        {tab === "desk" && <DmxDesk l={lighting} />}
        {tab === "fixtures" && <Fixtures l={lighting} />}
        {tab === "io" && <InputsOutputs l={lighting} />}
      </div>
    </div>
  );
}

// ───────────────────────── shared: master + blackout ─────────────────────────

function MasterStrip({ l, compact = false }: { l: LightingService; compact?: boolean }) {
  const cfg = useLightingConfig(l);
  useLightingStatus(l);
  const send = useApp().bus;
  const bo = l.engine.isBlackout();
  return (
    <div className={`lx-master ${compact ? "compact" : ""}`}>
      <label title="Grand master: scales all light output (not pan/tilt/strobe)">
        MASTER
        <input type="range" min={0} max={1} step={0.01} value={cfg.master} onChange={(e) => send.send("lighting.master", Number(e.target.value))} />
        <output>{Math.round(cfg.master * 100)}%</output>
      </label>
      <button className={`lx-blackout ${bo ? "on" : ""}`} onClick={() => send.send("lighting.blackout")} title="Blackout: all DMX output to zero, programmed looks are kept">
        BLACKOUT
      </button>
    </div>
  );
}

const STATE_LABEL: Record<LinkState, string> = {
  disabled: "Disabled",
  connected: "Connected",
  disconnected: "Disconnected",
  sending: "Sending",
  error: "Error",
  unavailable: "Unavailable",
};

function StatusDot({ state }: { state: LinkState }) {
  return <span className={`lx-dot ${state}`}>{STATE_LABEL[state]}</span>;
}

// ───────────────────────── Virtual Console ─────────────────────────

function VirtualConsole({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  const [adding, setAdding] = useState(false);
  const widgets = cfg.console.widgets;
  const add = (type: VcWidget["type"]) => {
    const meta = VC_WIDGET_TYPES.find((w) => w.type === type)!;
    l.setWidgets([...widgets, { id: `vc-${Date.now().toString(36)}`, type, title: meta.label }]);
    setAdding(false);
  };
  return (
    <div className="lx-vc">
      <div className="lx-toolbar">
        <span className="hint">Master and BLACKOUT are in the Lighting bar above; each sound widget also has its own BLACKOUT.</span>
        <span className="lx-spacer" />
        <div className="lx-add">
          <button onClick={() => setAdding((a) => !a)}>+ Add widget</button>
          {adding && (
            <div className="lx-menu">
              {VC_WIDGET_TYPES.map((w) => (
                <button key={w.type} onClick={() => add(w.type)} title={w.description}>
                  {w.label}
                </button>
              ))}
              <span className="hint">Buttons, faders, XY pads, scenes, chases and colour controls come next.</span>
            </div>
          )}
        </div>
      </div>
      <div className="lx-widgets">
        {widgets.length === 0 && <p className="hint">No widgets yet — add a Sound Activated Light Control.</p>}
        {widgets.map((w) => (
          <section key={w.id} className="lx-widget">
            <header>
              <b>{w.title}</b>
              <button className="tiny" title="Remove widget" onClick={() => l.setWidgets(widgets.filter((x) => x.id !== w.id))}>
                ×
              </button>
            </header>
            {w.type === "soundToLight" && <SoundWidget l={l} />}
          </section>
        ))}
      </div>
    </div>
  );
}

const SOURCES: [SoundSource, string][] = [
  ["master", "Master"],
  ["deckA", "Deck A"],
  ["deckB", "Deck B"],
  ["mic", "Microphone"],
];

function Slider({ label, value, onChange, left, right }: { label: string; value: number; onChange: (v: number) => void; left?: string; right?: string }) {
  return (
    <label className="lx-slider">
      <span>{label}</span>
      <small>{left ?? ""}</small>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <small>{right ?? ""}</small>
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

function SoundWidget({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  useLightingStatus(l);
  const { bus } = useApp();
  const s = cfg.sound;
  const set = (patch: Partial<SoundSettings>) => l.setSound(patch);
  const meters = useRef<Record<string, HTMLDivElement | null>>({});
  const info = useRef<HTMLSpanElement>(null);
  const beatDot = useRef<HTMLSpanElement>(null);
  useAnimationFrame(() => {
    const m = l.sound.meters;
    for (const [k, v] of [["low", m.low], ["mid", m.mid], ["high", m.high], ["beat", m.beat]] as const) {
      const el = meters.current[k];
      if (el) el.style.height = `${Math.round(Math.min(1, v) * 100)}%`;
    }
    if (info.current) {
      info.current.textContent = !s.enabled
        ? "Off"
        : !m.signal
          ? s.source === "mic" && l.mic.state !== "on"
            ? l.mic.message || "Starting microphone…"
            : "No signal — play something"
          : `${m.bpm ? `${m.bpm.toFixed(1)} BPM` : "— BPM"} · beats from ${m.beatFrom === "grid" ? "the deck's beat grid" : m.beatFrom === "onsets" ? "kick detection" : "—"}`;
    }
    if (beatDot.current) beatDot.current.style.opacity = String(0.25 + 0.75 * Math.min(1, m.beat));
  });
  const fixtures = cfg.fixtures;
  const selected = new Set(s.fixtures);
  return (
    <div className="lx-sound">
      <div className="lx-sound-top">
        <button className={`lx-enable ${s.enabled ? "on" : ""}`} onClick={() => bus.send("lighting.sound.enable")}>
          {s.enabled ? "SOUND CONTROL ON" : "ENABLE SOUND CONTROL"}
        </button>
        <label>
          Audio source{" "}
          <select value={s.source} onChange={(e) => set({ source: e.target.value as SoundSource })}>
            {SOURCES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="lx-beat-dot" ref={beatDot} />
        <span className="hint" ref={info} />
        <span className="lx-spacer" />
        <button className={`lx-blackout ${l.engine.isBlackout() ? "on" : ""}`} onClick={() => bus.send("lighting.blackout")}>
          BLACKOUT
        </button>
      </div>
      <div className="lx-sound-grid">
        <div className="lx-meters" aria-label="Detected bass, mid, high and beat">
          {(["low", "mid", "high", "beat"] as const).map((k) => (
            <div key={k} className={`lx-meter ${k}`}>
              <div className="lx-meter-track">
                <div className="lx-meter-fill" ref={(el) => void (meters.current[k] = el)} />
              </div>
              <span>{k === "low" ? "BASS" : k.toUpperCase()}</span>
            </div>
          ))}
        </div>
        <div className="lx-controls">
          <Slider label="Sensitivity" value={s.sensitivity} onChange={(v) => set({ sensitivity: v })} />
          <Slider label="Master brightness" value={s.brightness} onChange={(v) => set({ brightness: v })} />
          <Slider label="Speed / response" value={s.speed} onChange={(v) => set({ speed: v })} left="Slow" right="Fast" />
          <Slider label="Bass response" value={s.bassResponse} onChange={(v) => set({ bassResponse: v })} />
          <Slider label="Mid response" value={s.midResponse} onChange={(v) => set({ midResponse: v })} />
          <Slider label="High response" value={s.highResponse} onChange={(v) => set({ highResponse: v })} />
          <div className="lx-toggles">
            <label>
              <input type="checkbox" checked={s.beatFlash} onChange={(e) => set({ beatFlash: e.target.checked })} /> Beat flash
            </label>
            <label>
              <input type="checkbox" checked={s.downbeatAccent} onChange={(e) => set({ downbeatAccent: e.target.checked })} /> Downbeat accent
            </label>
          </div>
        </div>
        <div className="lx-fixture-pick">
          <div className="lx-row">
            <b>Controlled fixtures</b>
            <span className="lx-spacer" />
            <button className="tiny" onClick={() => set({ fixtures: fixtures.map((f) => f.id) })} disabled={!fixtures.length}>
              Select all
            </button>
            <button className="tiny" onClick={() => set({ fixtures: [] })} disabled={!s.fixtures.length}>
              Clear
            </button>
          </div>
          {fixtures.length === 0 && <p className="hint">Add fixtures on the Fixtures page first.</p>}
          {fixtures.map((f) => {
            const def = findDef(l.defs, f.defId);
            const laser = !!def?.laser;
            const blocked = laser && !s.allowLasers;
            return (
              <label key={f.id} className={`lx-check ${blocked ? "blocked" : ""}`} title={blocked ? "Laser — excluded from sound control unless “Allow lasers” is on" : def?.placeholder ? "No fixture definition imported yet: its channels are unknown, so sound can't drive it" : ""}>
                <input
                  type="checkbox"
                  disabled={blocked}
                  checked={selected.has(f.id) && !blocked}
                  onChange={(e) => set({ fixtures: e.target.checked ? [...s.fixtures, f.id] : s.fixtures.filter((x) => x !== f.id) })}
                />
                <span className="lx-swatch" style={{ background: fixtureColour(f.id) }} />
                {f.name} <small className="hint">U{f.universe} · {addressRange(f).join("–")}</small>
                {laser && <span className="lx-badge laser">LASER</span>}
                {def?.placeholder && <span className="lx-badge todo">NEEDS DEFINITION</span>}
              </label>
            );
          })}
          {fixtures.some((f) => findDef(l.defs, f.defId)?.laser) && (
            <label className="lx-check lx-laser-optin">
              <input
                type="checkbox"
                checked={s.allowLasers}
                onChange={(e) => {
                  if (e.target.checked && !confirm("Allow sound-to-light to control lasers?\n\nOnly do this if your lasers are aimed safely (above head height, never at the audience) and you understand the risks.")) return;
                  set({ allowLasers: e.target.checked, fixtures: e.target.checked ? s.fixtures : s.fixtures.filter((id) => !findDef(l.defs, fixtures.find((x) => x.id === id)?.defId ?? "")?.laser) });
                }}
              />
              Allow lasers <small className="hint">(off by default — safety)</small>
            </label>
          )}
        </div>
      </div>
      <MovementControls l={l} />
      <MappingEditor value={s.mappings} onChange={(mappings) => set({ mappings })} />
    </div>
  );
}

const CYCLES: [number, string][] = [
  [1, "1 beat"],
  [2, "2 beats"],
  [4, "1 bar"],
  [8, "2 bars"],
  [16, "4 bars"],
];

/** Moving heads following the music: part of sound control, for selected fixtures with pan/tilt. */
function MovementControls({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  const { bus } = useApp();
  const mv = cfg.sound.movement;
  const set = (patch: Partial<MovementSettings>) => l.setMovement(patch);
  const selected = new Set(cfg.sound.fixtures);
  const heads = cfg.fixtures.filter((f) => selected.has(f.id) && l.defs.find((d) => d.id === f.defId)?.modes.some((m) => m.channels.some((c) => c.type === "pan" || c.type === "tilt")));
  const anyHeads = cfg.fixtures.some((f) => l.defs.find((d) => d.id === f.defId)?.modes.some((m) => m.channels.some((c) => c.type === "pan" || c.type === "tilt")));
  return (
    <div className="lx-movement">
      <div className="lx-row">
        <button className={`lx-enable small ${mv.enabled ? "on" : ""}`} onClick={() => bus.send("lighting.sound.movement")} disabled={!anyHeads} title={anyHeads ? "Moving heads trace a pattern locked to the beat" : "No fixtures with pan/tilt in the rig"}>
          {mv.enabled ? "MOVEMENT ON" : "MOVE HEADS WITH THE MUSIC"}
        </button>
        <label>
          Pattern{" "}
          <select value={mv.pattern} onChange={(e) => set({ pattern: e.target.value as MovementPattern })}>
            {MOVEMENT_PATTERNS.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          One cycle every{" "}
          <select value={mv.beatsPerCycle} onChange={(e) => set({ beatsPerCycle: Number(e.target.value) })}>
            {CYCLES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label title="Every other head moves as a mirror image">
          <input type="checkbox" checked={mv.mirror} onChange={(e) => set({ mirror: e.target.checked })} /> Mirror pairs
        </label>
        <label title="Bigger moves at the drop, smaller in breakdowns">
          <input type="checkbox" checked={mv.followEnergy} onChange={(e) => set({ followEnergy: e.target.checked })} /> Follow energy
        </label>
        <span className="hint">
          {!anyHeads
            ? "Add a moving head (a fixture with pan/tilt) to use movement."
            : heads.length
              ? `Moves ${heads.length} head${heads.length === 1 ? "" : "s"} · pan/tilt follow the beat while sound control is on`
              : "Tick moving heads under Controlled fixtures to move them."}
        </span>
      </div>
      <div className="lx-movement-sliders">
        <Slider label="Size" value={mv.size} onChange={(v) => set({ size: v })} left="Small" right="Wide" />
        <Slider label="Spread" value={mv.spread} onChange={(v) => set({ spread: v })} left="Unison" right="Wave" />
        <Slider label="Pan centre" value={mv.panCentre} onChange={(v) => set({ panCentre: v })} left="◀" right="▶" />
        <Slider label="Tilt centre" value={mv.tiltCentre} onChange={(v) => set({ tiltCentre: v })} left="▼" right="▲" />
      </div>
    </div>
  );
}

const INPUTS: [SoundInput, string][] = [
  ["low", "Bass"],
  ["mid", "Mid"],
  ["high", "High"],
  ["amplitude", "Overall level"],
  ["beat", "Beat flash"],
];
const MAPPABLE: ChannelType[] = ["red", "green", "blue", "white", "amber", "uv", "intensity", "generic"];

function MappingEditor({ value, onChange }: { value: SoundMapping[]; onChange: (m: SoundMapping[]) => void }) {
  const patch = (i: number, p: Partial<SoundMapping>) => onChange(value.map((m, j) => (j === i ? { ...m, ...p } : m)));
  return (
    <details className="lx-mappings">
      <summary>Sound → light mappings ({value.length})</summary>
      <table>
        <thead>
          <tr>
            <th>Sound</th>
            <th>Drives</th>
            <th>Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {value.map((m, i) => (
            <tr key={i}>
              <td>
                <select value={m.input} onChange={(e) => patch(i, { input: e.target.value as SoundInput })}>
                  {INPUTS.map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={m.output} onChange={(e) => patch(i, { output: e.target.value as ChannelType })}>
                  {MAPPABLE.map((t) => (
                    <option key={t} value={t}>
                      {CHANNEL_LABELS[t]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="range" min={0} max={1} step={0.05} value={m.amount} onChange={(e) => patch(i, { amount: Number(e.target.value) })} /> {Math.round(m.amount * 100)}%
              </td>
              <td>
                <button className="tiny" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="lx-row">
        <button className="tiny" onClick={() => onChange([...value, { input: "low", output: "red", amount: 1 }])}>
          + Mapping
        </button>
        <button className="tiny" onClick={() => onChange(DEFAULT_MAPPINGS)}>
          Reset to defaults
        </button>
        <span className="hint">Strobe and effect channels are never driven by sound; pan/tilt only by Movement.</span>
      </div>
    </details>
  );
}

// ───────────────────────── DMX Desk ─────────────────────────

const PAGE = 32;

function DmxDesk({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  useDmxVersion(l);
  const universes = cfg.universes.map((u) => u.universe);
  const [u, setU] = useState(universes[0] ?? 1);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const universe = universes.includes(u) ? u : universes[0];
  const map = useMemo(() => channelMap(l.defs, cfg.fixtures, universe), [l, cfg.fixtures, universe]);
  const out = l.engine.compute(universe);
  const first = page * PAGE + 1;
  const channels = Array.from({ length: PAGE }, (_, i) => first + i).filter((c) => c <= 512);
  const move = (ch: number, v: number) => {
    const group = sel.has(ch) && sel.size > 1 ? [...sel] : [ch];
    const delta = v - l.engine.getLayerValue(LAYER_DESK, universe, ch);
    l.setDeskMany(universe, group.map((c) => [c, c === ch ? v : l.engine.getLayerValue(LAYER_DESK, universe, c) + delta]));
  };
  const toggleSel = (ch: number, e: React.MouseEvent) =>
    setSel((s) => {
      const n = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? s : []);
      if (s.has(ch) && (e.ctrlKey || e.metaKey || e.shiftKey)) n.delete(ch);
      else n.add(ch);
      return n;
    });
  return (
    <div className="lx-desk">
      <div className="lx-toolbar">
        <label>
          Universe{" "}
          <select value={universe} onChange={(e) => setU(Number(e.target.value))}>
            {universes.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <div className="lx-pages">
          <button className="tiny" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹
          </button>
          <span>
            CH {String(first).padStart(3, "0")}–{String(Math.min(512, first + PAGE - 1)).padStart(3, "0")}
          </span>
          <button className="tiny" disabled={first + PAGE > 512} onClick={() => setPage((p) => p + 1)}>
            ›
          </button>
        </div>
        <span className="hint">{sel.size > 1 ? `${sel.size} channels selected — they move together` : "Click channel numbers to select; Ctrl/Shift-click for groups"}</span>
        <span className="lx-spacer" />
        <button onClick={() => l.deskFullOn(universe)} title="All light-output channels to full (not pan/tilt/strobe)">
          FULL ON
        </button>
        <button onClick={() => l.deskClear(universe)}>RESET</button>
      </div>
      <div className="lx-faders">
        {channels.map((ch) => {
          const info = map[ch];
          const desk = l.engine.getLayerValue(LAYER_DESK, universe, ch);
          const live = out[ch - 1];
          return (
            <div key={ch} className={`lx-fader ${sel.has(ch) ? "selected" : ""} ${info ? "patched" : ""}`} style={info ? { ["--fx" as string]: fixtureColour(info.fixture.id) } : undefined}>
              <button
                className="lx-ch"
                onClick={(e) => toggleSel(ch, e)}
                title={info ? `${info.fixture.name} — ${info.channel.name}${capabilityAt(info.channel, live) ? `\nNow: ${capabilityAt(info.channel, live)}` : ""}` : "Unpatched"}
              >
                {String(ch).padStart(3, "0")}
              </button>
              <span className="lx-fix">{info?.fixture.name ?? ""}</span>
              <span className="lx-fn">{info?.channel.name ?? ""}</span>
              <div className="lx-fader-body">
                <div className="lx-live" style={{ height: `${(live / 255) * 100}%` }} title={`Output ${live}`} />
                <input className="vfader" type="range" min={0} max={255} step={1} value={desk} onChange={(e) => move(ch, Number(e.target.value))} aria-label={`Channel ${ch}`} />
              </div>
              <output title="Desk value (bar behind the fader = actual output)">{desk}</output>
              <small className="lx-out">{live}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Fixtures ─────────────────────────

function Fixtures({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  const universes = cfg.universes.map((u) => u.universe);
  const [defId, setDefId] = useState(l.defs[0].id);
  const def = l.defs.find((d) => d.id === defId)!;
  const [mode, setMode] = useState(def.modes[0].name);
  const modeDef = def.modes.find((m) => m.name === mode) ?? def.modes[0];
  const [universe, setUniverse] = useState(universes[0] ?? 1);
  const [name, setName] = useState("");
  const [address, setAddress] = useState<number>(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; overlap?: PatchedFixture } | null>(null);
  const [mapU, setMapU] = useState(universes[0] ?? 1);

  // Suggest the next free address whenever the fixture type/mode/universe changes (not while editing).
  useEffect(() => {
    if (editing) return;
    setAddress(l.suggestAddress(universe, modeDef.channels.length) ?? 1);
  }, [l, universe, modeDef.channels.length, editing, cfg.fixtures.length]);

  const reset = () => {
    setEditing(null);
    setName("");
    setProblem(null);
  };
  const save = (allowOverlap = false) => {
    const f: PatchedFixture = {
      id: editing ?? `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || `${def.model} ${cfg.fixtures.filter((x) => x.defId === def.id).length + 1}`,
      defId: def.id,
      mode: modeDef.name,
      universe,
      address,
      channelCount: modeDef.channels.length,
    };
    const r = l.saveFixture(f, allowOverlap);
    if (r.ok) reset();
    else if (r.overlaps) setProblem({ text: `Addresses ${address}–${address + f.channelCount - 1} overlap ${r.overlaps.map((o) => `${o.name} (${addressRange(o).join("–")})`).join(", ")}.`, overlap: f });
    else setProblem({ text: r.error ?? "Can't save this fixture" });
  };
  const edit = (f: PatchedFixture) => {
    setEditing(f.id);
    setDefId(f.defId);
    setMode(f.mode);
    setUniverse(f.universe);
    setAddress(f.address);
    setName(f.name);
    setProblem(null);
  };
  const mapUniverse = universes.includes(mapU) ? mapU : universes[0];
  const occ = useMemo(() => {
    const cells: { f: PatchedFixture; clash: boolean }[][] = Array.from({ length: 513 }, () => []);
    for (const f of cfg.fixtures) if (f.universe === mapUniverse) for (let a = f.address; a < f.address + f.channelCount && a <= 512; a++) cells[a].push({ f, clash: false });
    return cells;
  }, [cfg.fixtures, mapUniverse]);

  return (
    <div className="lx-fixtures">
      <QlcImport l={l} />
      <section className="lx-panel">
        <h4>{editing ? "Edit fixture" : "Add fixture"}</h4>
        <div className="lx-form">
          <label>
            Fixture
            <select
              value={defId}
              onChange={(e) => {
                setDefId(e.target.value);
                setMode(l.defs.find((d) => d.id === e.target.value)!.modes[0].name);
              }}
            >
              {l.defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.manufacturer} — {d.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select value={modeDef.name} onChange={(e) => setMode(e.target.value)}>
              {def.modes.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={name} placeholder={`${def.model} ${cfg.fixtures.filter((x) => x.defId === def.id).length + 1}`} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Universe
            <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
              {universes.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start address
            <input type="number" min={1} max={512} value={address} onChange={(e) => setAddress(Math.max(1, Math.min(512, Number(e.target.value) || 1)))} />
          </label>
          <label>
            Channels
            <input value={`${modeDef.channels.length}  (DMX ${address}–${address + modeDef.channels.length - 1})`} readOnly />
          </label>
        </div>
        <p className="hint lx-chlist">{modeDef.channels.map((c, i) => `${i + 1} ${c.name}`).join(" · ")}</p>
        {problem && (
          <div className="lx-warn">
            ⚠ {problem.text}
            {problem.overlap && (
              <button className="tiny" onClick={() => save(true)}>
                Overlap anyway
              </button>
            )}
          </div>
        )}
        <div className="lx-row">
          <button className="primary" onClick={() => save(false)}>
            {editing ? "Save fixture" : "Add fixture"}
          </button>
          {editing && <button onClick={reset}>Cancel</button>}
        </div>
      </section>

      <section className="lx-panel lx-grow">
        <h4>Patched fixtures ({cfg.fixtures.length})</h4>
        <table className="lx-table">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Manufacturer</th>
              <th>Model</th>
              <th>Mode</th>
              <th>Univ.</th>
              <th>DMX</th>
              <th>Ch</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cfg.fixtures.map((f) => {
              const d = l.defs.find((x) => x.id === f.defId);
              return (
                <tr key={f.id} className={editing === f.id ? "selected" : ""}>
                  <td>
                    <span className="lx-swatch" style={{ background: fixtureColour(f.id) }} />
                  </td>
                  <td>
                    {f.name}
                    {d?.laser && <span className="lx-badge laser">LASER</span>}
                    {d?.placeholder && <span className="lx-badge todo" title="Import this fixture's QLC+ definition (.qxf) to give its channels their real functions">NEEDS DEFINITION</span>}
                    {f.modifiers?.some((m) => m.curve === "invert") && <span className="lx-badge" title="Inverted channel(s), as in QLC+">INV</span>}
                  </td>
                  <td>{d?.manufacturer ?? "?"}</td>
                  <td>{d?.model ?? f.defId}</td>
                  <td className="hint">{f.mode}</td>
                  <td>{f.universe}</td>
                  <td className="mono">{addressRange(f).join("–")}</td>
                  <td>{f.channelCount}</td>
                  <td className="row-actions">
                    <button className="tiny" onClick={() => edit(f)}>
                      Edit
                    </button>
                    <button className="tiny" onClick={() => l.removeFixture(f.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {cfg.fixtures.length === 0 && (
              <tr>
                <td colSpan={9} className="hint">
                  No fixtures yet. Pick a fixture type on the left and add it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="lx-panel">
        <h4>
          Address map — universe{" "}
          <select value={mapUniverse} onChange={(e) => setMapU(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </h4>
        <div className="lx-map" role="grid" aria-label="DMX address map">
          {Array.from({ length: 512 }, (_, i) => i + 1).map((a) => {
            const c = occ[a];
            const clash = c.length > 1;
            return (
              <span
                key={a}
                className={`lx-cell ${c.length ? "used" : ""} ${clash ? "clash" : ""}`}
                style={c.length && !clash ? { background: fixtureColour(c[0].f.id) } : undefined}
                title={c.length ? `${a}: ${c.map((x) => x.f.name).join(" + ")}${clash ? " (overlap!)" : ""}` : `${a}: free`}
              >
                {a % 32 === 1 ? a : ""}
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** Import a QLC+ fixture list / workspace and fixture definitions (several files at once). */
function QlcImport({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  const [replace, setReplace] = useState(true);
  const [report, setReport] = useState<QlcImportReport | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const need = cfg.fixtures.filter((f) => findDef(l.defs, f.defId)?.placeholder);
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await f.text() })));
    setReport(l.importQlc(list, { replaceFixtures: replace && list.some((f) => /<FixtureList|<Workspace/.test(f.text.slice(0, 600))) }));
    if (input.current) input.current.value = "";
  };
  return (
    <section className="lx-panel lx-qlc">
      <h4>Import from QLC+</h4>
      <div className="lx-row">
        <button className="primary" onClick={() => input.current?.click()}>
          Choose QLC+ files…
        </button>
        <input ref={input} type="file" multiple accept=".qxfl,.qxw,.qxf,.xml,.txt" hidden onChange={(e) => void run(e.target.files)} />
        <label className="lx-check">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace my current fixtures with the imported list
        </label>
      </div>
      <p className="hint">
        Select your fixture list (<b>.qxfl</b>) or workspace (<b>.qxw</b>) <i>and</i> the fixture definitions (<b>.qxf</b>) together. On the computer with QLC+ your own
        definitions are in <code>%USERPROFILE%\QLC+\Fixtures</code> (Windows), <code>~/Library/Application Support/QLC+/Fixtures</code> (Mac) or{" "}
        <code>~/.qlcplus/fixtures</code> (Linux). Addresses and universes are converted from QLC+'s 0-based numbers.
      </p>
      {need.length > 0 && (
        <div className="lx-warn">
          ⚠ {need.length} fixture(s) still need their definition, so their channels are “unknown” and nothing automatic drives them:{" "}
          {[...new Set(need.map((f) => { const d = findDef(l.defs, f.defId); return `${d?.manufacturer} ${d?.model}`; }))].join(", ")}
        </div>
      )}
      {report && (
        <div className="lx-report">
          <b>
            Imported {report.fixtures} fixture(s){report.definitions.length ? `, ${report.definitions.length} definition(s)` : ""}.
          </b>
          {report.definitions.length > 0 && <div>Definitions: {report.definitions.join(" · ")}</div>}
          {report.skipped.map((s) => (
            <div key={s} className="hint">
              Skipped — {s}
            </div>
          ))}
          {report.notes.map((n) => (
            <div key={n} className="hint">
              Note — {n}
            </div>
          ))}
          {report.errors.map((e) => (
            <div key={e} className="lx-warn">
              ✖ {e}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── Inputs / Outputs ─────────────────────────

function InputsOutputs({ l }: { l: LightingService }) {
  const cfg = useLightingConfig(l);
  useLightingStatus(l);
  const desktop = !!window.dbdjDesktop?.lighting;
  const set = (u: number, patch: Partial<UniverseIo>) => l.setIo(u, patch);
  return (
    <div className="lx-io">
      <table className="lx-table">
        <thead>
          <tr>
            <th>Universe</th>
            <th>Input</th>
            <th>Output</th>
            <th>Settings</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cfg.universes.map((io) => {
            const st = l.statusOf(io.universe);
            return (
              <tr key={io.universe}>
                <td className="lx-univ">{io.universe}</td>
                <td>
                  <select value={io.input} onChange={(e) => set(io.universe, { input: e.target.value as InputKind })}>
                    {(Object.keys(INPUT_LABELS) as InputKind[]).map((k) => (
                      <option key={k} value={k} disabled={k === "artnet" && !desktop}>
                        {INPUT_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  {io.input === "artnet" && (
                    <div className="lx-sub">
                      from port-address{" "}
                      <input type="number" min={0} max={32767} value={io.artnet.inputPortAddress} onChange={(e) => set(io.universe, { artnet: { ...io.artnet, inputPortAddress: Number(e.target.value) } })} />
                    </div>
                  )}
                </td>
                <td>
                  <select value={io.output} onChange={(e) => set(io.universe, { output: e.target.value as OutputKind })}>
                    {(Object.keys(OUTPUT_LABELS) as OutputKind[]).map((k) => (
                      <option key={k} value={k} disabled={(k === "artnet" || k === "sacn") && !desktop}>
                        {OUTPUT_LABELS[k]}
                        {(k === "artnet" || k === "sacn") && !desktop ? " (desktop app)" : ""}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="lx-settings">
                  {io.output === "artnet" && (
                    <>
                      <label>
                        Node IP{" "}
                        <input value={io.artnet.host} placeholder="255.255.255.255" onChange={(e) => set(io.universe, { artnet: { ...io.artnet, host: e.target.value } })} />
                      </label>
                      <label>
                        Art-Net universe (port-address){" "}
                        <input type="number" min={0} max={32767} value={io.artnet.portAddress} onChange={(e) => set(io.universe, { artnet: { ...io.artnet, portAddress: Number(e.target.value) } })} />
                      </label>
                    </>
                  )}
                  {io.output === "sacn" && (
                    <>
                      <label>
                        sACN universe{" "}
                        <input type="number" min={1} max={63999} value={io.sacn.universe} onChange={(e) => set(io.universe, { sacn: { ...io.sacn, universe: Number(e.target.value) } })} />
                      </label>
                      <label>
                        Priority <input type="number" min={0} max={200} value={io.sacn.priority} onChange={(e) => set(io.universe, { sacn: { ...io.sacn, priority: Number(e.target.value) } })} />
                      </label>
                      <label>
                        Unicast IP (optional) <input value={io.sacn.host ?? ""} placeholder="multicast" onChange={(e) => set(io.universe, { sacn: { ...io.sacn, host: e.target.value } })} />
                      </label>
                    </>
                  )}
                  {io.output === "usb-pro" && (
                    <>
                      <button onClick={() => void l.usb.connect()} disabled={l.usb.state === "unavailable"}>
                        {l.usb.state === "connected" || l.usb.state === "sending" ? "Reconnect USB DMX" : "Connect USB DMX interface"}
                      </button>
                      <span className="hint">
                        {l.usb.mode === "pro"
                          ? "Mode: Enttec Pro protocol (the interface confirmed it)."
                          : l.usb.mode === "open"
                            ? "Mode: Open DMX — the app generates the DMX signal (~35 frames/s)."
                            : "Detects the type automatically: Enttec DMX USB Pro-compatible, or Open DMX (bare FTDI cable)."}
                      </span>
                    </>
                  )}
                </td>
                <td>
                  <div>
                    Out: <StatusDot state={st.output} />
                  </div>
                  {io.input !== "none" && (
                    <div>
                      In: <StatusDot state={st.input} />
                    </div>
                  )}
                  {st.detail && <div className="hint lx-detail">{st.detail}</div>}
                </td>
                <td>
                  <button className="tiny" disabled={cfg.universes.length <= 1} onClick={() => l.removeUniverse(io.universe)} title="Remove universe (and its fixtures)">
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="lx-row">
        <button onClick={() => l.addUniverse()}>+ Add universe</button>
        <label>
          On exit / disconnect{" "}
          <select value={cfg.exitBehaviour} onChange={(e) => l.setExitBehaviour(e.target.value as "blackout" | "hold")}>
            <option value="blackout">DMX output → 0 (safe)</option>
            <option value="hold">Hold last look</option>
          </select>
        </label>
      </div>
      <p className="hint">
        Art-Net and sACN are sent by the desktop app over your network (Art-Net port 6454, sACN multicast 239.255.x.x:5568). “Connected” for Art-Net means a node answered
        ArtPoll; sACN has no acknowledgement, so it shows “Sending”. USB DMX works with Enttec Pro-compatible interfaces (they confirm, so “Connected”) and bare FTDI “Open DMX” cables (output only, so “Sending”); other USB chipsets need a companion
        service and aren't supported yet (see docs/LIGHTING.md).
      </p>
    </div>
  );
}

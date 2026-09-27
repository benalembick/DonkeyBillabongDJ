/**
 * Controller tooling: live event feed (hardware spike), MIDI monitor,
 * controller test screen (every physical control, highlights on use, pass/fail report).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { actionCatalog } from "../core/actions";
import type { MonitorEntry } from "../controllers/ControllerManager";
import { friendlyEvent } from "../controllers/describe";
import { describeMidi } from "../controllers/midi/message";
import type { ControllerMapping } from "../controllers/mapping/schema";
import { useApp } from "./context";
import { useTick } from "./hooks";

const FEED_MAX = 250;

/** Collects monitor entries outside React state; components re-render at a capped rate. */
function useMonitorBuffer(max = FEED_MAX): MonitorEntry[] {
  const { controllers } = useApp();
  const buf = useRef<MonitorEntry[]>([]);
  const [, force] = useState(0);
  useEffect(() => {
    let pending = false;
    return controllers.on("monitor", (e) => {
      buf.current.push(e);
      if (buf.current.length > max) buf.current.splice(0, buf.current.length - max);
      if (!pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          force((n) => n + 1);
        }, 60);
      }
    });
  }, [controllers, max]);
  return buf.current;
}

export function LiveEvents() {
  const { engine } = useApp();
  const entries = useMonitorBuffer();
  const [paused, setPaused] = useState(false);
  const frozen = useRef<MonitorEntry[]>([]);
  if (!paused) frozen.current = entries.slice(-120);
  const rows = frozen.current
    .flatMap((e) =>
      e.translations.length > 0
        ? e.translations.map((t, i) => ({ key: `${e.id}.${i}`, text: friendlyEvent(t, engine.getState()), raw: describeMidi(e.message), action: t.action, value: t.value }))
        : [{ key: `${e.id}`, text: e.mapping ? "UNMAPPED" : e.message.deviceName, raw: describeMidi(e.message), action: "—", value: NaN }],
    )
    .filter((r) => r.text !== null)
    .reverse();

  return (
    <div className="feed">
      <div className="toolbar">
        <button onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "❚❚ Pause"}</button>
        <span className="hint">Operate any control on the DDJ-SB. Unmapped messages appear as UNMAPPED.</span>
      </div>
      <div className="feed-rows">
        {rows.map((r) => (
          <div key={r.key} className={`feed-row ${r.text === "UNMAPPED" ? "unmapped" : ""}`}>
            <span className="feed-text">{r.text}</span>
            <span className="feed-action">{r.action}{Number.isFinite(r.value) ? ` = ${Number(r.value.toFixed(3))}` : ""}</span>
            <span className="feed-raw">{r.raw}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MidiMonitor() {
  const entries = useMonitorBuffer(400);
  const [paused, setPaused] = useState(false);
  const frozen = useRef<MonitorEntry[]>([]);
  if (!paused) frozen.current = entries.slice(-200);
  return (
    <div className="feed monitor">
      <div className="toolbar">
        <button onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "❚❚ Pause"}</button>
        <span className="hint">Raw incoming MIDI and the command each message triggered.</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Type</th>
            <th>Ch</th>
            <th>Control</th>
            <th>Value</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody>
          {[...frozen.current].reverse().map((e) => (
            <tr key={e.id}>
              <td>{e.message.deviceName}</td>
              <td>{e.message.type}</td>
              <td>{e.message.channel}</td>
              <td>
                {e.message.data1} (0x{e.message.data1.toString(16).toUpperCase().padStart(2, "0")})
              </td>
              <td>{e.message.data2}</td>
              <td className="mono">
                {e.translations.length
                  ? e.translations.map((t) => `${t.binding.midi.type.toUpperCase()} ${e.message.data1} → ${t.action}`).join(", ")
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Verdict = "pass" | "fail" | undefined;

export function ControllerTest() {
  const { controllers } = useApp();
  // Re-render at a fixed low rate; hits accumulate in a ref (jog wheels send hundreds of messages/s).
  useTick(150);
  const mapping: ControllerMapping | null = controllers.getActiveMapping() ?? controllers.getMappings()[0] ?? null;
  const hitsRef = useRef<Record<string, { count: number; last: number; actions: Set<string> }>>({});
  const hits = hitsRef.current;
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  useEffect(
    () =>
      controllers.on("monitor", (e) => {
        for (const t of e.translations) {
          const h = (hitsRef.current[t.binding.control] ??= { count: 0, last: 0, actions: new Set() });
          h.count++;
          h.last = performance.now();
          h.actions.add(t.action);
        }
      }),
    [controllers],
  );

  const sections = useMemo(() => {
    const m = new Map<string, ControllerMapping["controls"]>();
    for (const c of mapping?.controls ?? []) {
      if (!m.has(c.section)) m.set(c.section, []);
      m.get(c.section)!.push(c);
    }
    return [...m.entries()];
  }, [mapping]);

  if (!mapping) return <div className="empty">No mapping loaded.</div>;
  const catalog = actionCatalog();
  const now = performance.now();

  const report = () => {
    const lines = [
      `# ${mapping.name} controller test report`,
      ``,
      `Date: ${new Date().toISOString()}  `,
      `Platform: ${navigator.userAgent}`,
      ``,
      `| Control | Operated | Commands seen | Result | Notes |`,
      `|---|---|---|---|---|`,
      ...mapping.controls.map((c) => {
        const h = hits[c.id];
        return `| ${c.label} | ${h ? `yes (${h.count})` : "no"} | ${h ? [...h.actions].join(", ") : ""} | ${verdicts[c.id]?.toUpperCase() ?? ""} | ${notes[c.id] ?? ""} |`;
      }),
    ];
    return lines.join("\n");
  };

  return (
    <div className="ctrl-test">
      <div className="toolbar">
        <strong>{mapping.name}</strong>
        <span className="hint">
          Operate each control: it lights up when received. Mark ✓/✗ and add notes, then copy the report.
        </span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(report()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied ✓" : "Copy test report (Markdown)"}
        </button>
        <button onClick={() => { hitsRef.current = {}; setVerdicts({}); setNotes({}); }}>Reset</button>
      </div>
      <div className="ctrl-sections">
        {sections.map(([section, list]) => (
          <div key={section} className="ctrl-section">
            <h4>{section}</h4>
            {list.map((c) => {
              const h = hits[c.id];
              const recent = h && now - h.last < 1200;
              const v = verdicts[c.id];
              const actions = mapping.inputs.filter((b) => b.control === c.id).map((b) => b.action);
              const unimplemented = actions.filter((a) => catalog.get(a)?.implemented === false);
              return (
                <div key={c.id} className={`ctrl ${h ? "seen" : ""} ${recent ? "active" : ""} ${v ?? ""}`} title={actions.join("\n")}>
                  <span className="ctrl-state">{v === "pass" ? "✓" : v === "fail" ? "✗" : h ? "●" : "○"}</span>
                  <span className="ctrl-label">{c.label}</span>
                  {unimplemented.length === actions.length && actions.length > 0 && <span className="tag">not implemented yet</span>}
                  <span className="ctrl-count">{h?.count ?? ""}</span>
                  <button className="tiny" onClick={() => setVerdicts((x) => ({ ...x, [c.id]: x[c.id] === "pass" ? undefined : "pass" }))}>✓</button>
                  <button className="tiny" onClick={() => setVerdicts((x) => ({ ...x, [c.id]: x[c.id] === "fail" ? undefined : "fail" }))}>✗</button>
                  {v === "fail" && (
                    <input className="note" placeholder="what happened?" value={notes[c.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))} />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

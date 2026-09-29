/** Diagnostics + Settings (audio, controller/jog, Mixxx import). */
import { useEffect, useState } from "react";
import type { AudioConfig, OutputDevice } from "../core/engine/types";
import type { CrossfaderCurve } from "../core/engine/mixerMath";
import { importMixxxMapping, type ImportResult } from "../controllers/mixxx/MixxxImporter";
import { useApp, useEngineState } from "./context";
import { MatchDiagnostics } from "./MatchDialog";
import { useAudiusState } from "./AudiusPane";
import { AUDIUS_APP_NAME } from "../providers/audius/AudiusClient";
import { StemDiagnostics, StemSettings } from "./StemSettings";
import { WaveformSettings } from "./WaveStylePicker";

const audiusAppName = () => AUDIUS_APP_NAME;
import type { SourceId } from "../matching/sources";
import { useTick } from "./hooks";

function AudiusDiagnostics() {
  const { audius, engine } = useApp();
  useTick(500);
  const st = audius.client.stats;
  const decks = engine.getState().decks;
  return (
    <>
      <h4>Audius</h4>
      <dl>
        <dt>API</dt>
        <dd>{st.host} · status {st.apiStatus}{st.lastError ? ` · last error: ${st.lastError}` : ""}</dd>
        <dt>Latency</dt>
        <dd>last {st.lastLatencyMs ?? "—"} ms · average {st.avgLatencyMs ?? "—"} ms</dd>
        <dt>Requests</dt>
        <dd>{st.requests} · cache hits {st.cacheHits} · retries {st.retries} · errors {st.errors}</dd>
        <dt>Last stream</dt>
        <dd>
          {st.lastStream
            ? `track ${st.lastStream.trackId} · first byte ${st.lastStream.ttfbMs} ms · full buffer ${st.lastStream.totalMs} ms · ${(st.lastStream.bytes / 1048576).toFixed(1)} MB · ${st.lastStream.retries} retries`
            : "—"}
        </dd>
        {decks.map((d, i) =>
          d.track?.source === "audius" ? (
            <div key={i} style={{ display: "contents" }}>
              <dt>Deck {String.fromCharCode(65 + i)}</dt>
              <dd>
                {d.track.ref} · {d.status}
                {d.loadProgress != null ? ` ${Math.round(d.loadProgress * 100)}%` : ""} · {d.duration ? `${d.duration.toFixed(1)} s` : ""}
                {d.track.resolvedFrom ? ` · Smart Match ${d.track.resolvedFrom.confidence}% from ${d.track.resolvedFrom.metadataSource}` : ""}
                {d.loadMessage ? ` · ${d.loadMessage}` : ""}
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    </>
  );
}

function SmartMatchDiagnostics() {
  const { matching } = useApp();
  useTick(1000);
  const recent = matching.resolver.recent.filter((r, i, a) => a.findIndex((x) => x.requested.sourceTrackId === r.requested.sourceTrackId) === i).slice(0, 8);
  return (
    <>
      <h4>Smart Match</h4>
      <p className="hint">
        Local index: {matching.local.size} tracks · sources:{" "}
        {matching.resolver
          .getSources()
          .map((s) => `${s.name} (${s.availability().available ? "available" : "unavailable"})`)
          .join(" → ")}
      </p>
      {recent.length === 0 && <p className="hint">No resolutions yet — open a Spotify playlist or load a Spotify track.</p>}
      {recent.map((r) => (
        <details key={`${r.requested.source}:${r.requested.sourceTrackId}`}>
          <summary>
            {r.requested.artists.join(", ")} — {r.requested.title} · {r.status} {r.best ? `${r.confidence}%` : ""}
          </summary>
          <MatchDiagnostics result={r} />
        </details>
      ))}
    </>
  );
}

export function Diagnostics() {
  const { audio, controllers, engine, log } = useApp();
  useTick(500);
  const s = audio.getStatus();
  const state = engine.getState();
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const entries = log.all().slice(-150).reverse();
  return (
    <div className="diag">
      <div className="diag-grid">
        <dl>
          <dt>Audio backend</dt>
          <dd>{s.backend}</dd>
          <dt>State</dt>
          <dd>{s.state}{s.error ? ` — ${s.error}` : ""}</dd>
          <dt>Sample rate</dt>
          <dd>{s.sampleRate} Hz</dd>
          <dt>Buffer / base latency</dt>
          <dd>{(s.baseLatency * 1000).toFixed(1)} ms (≈ {Math.round(s.baseLatency * s.sampleRate)} frames)</dd>
          <dt>Output latency</dt>
          <dd>{(s.outputLatency * 1000).toFixed(1)} ms</dd>
          <dt>Estimated total</dt>
          <dd>{((s.baseLatency + s.outputLatency) * 1000).toFixed(1)} ms</dd>
          <dt>Output channels</dt>
          <dd>{s.maxOutputChannels} (routing: {s.routing})</dd>
          <dt>Dropped buffers</dt>
          <dd>not exposed by Web Audio (see AUDIO-ENGINE.md)</dd>
        </dl>
        <dl>
          <dt>MIDI</dt>
          <dd>{controllers.getAvailability()}</dd>
          <dt>MIDI messages/sec</dt>
          <dd>{controllers.messagesPerSecond()}</dd>
          <dt>Devices</dt>
          <dd>
            {controllers.getControllers().map((c) => (
              <div key={c.portName}>
                {c.portName} — {c.connected ? "connected" : "disconnected"} — {c.mappingName ?? "no mapping"}
                {c.connected && !c.hasOutput ? " (no LED output)" : ""}
              </div>
            ))}
            {controllers.getControllers().length === 0 && "none"}
          </dd>
          <dt>Loaded tracks</dt>
          <dd>
            {state.decks.map((d, i) => (
              <div key={i}>
                {String.fromCharCode(65 + i)}: {d.track?.title ?? "—"} ({d.status})
              </div>
            ))}
          </dd>
          <dt>Database</dt>
          <dd>Phase 3 (in-memory library for now)</dd>
          <dt>JS heap</dt>
          <dd>{mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : "n/a"}</dd>
        </dl>
      </div>
      <StemDiagnostics />
      <AudiusDiagnostics />
      <SmartMatchDiagnostics />
      <h4>Event log</h4>
      <div className="log">
        {entries.map((e) => (
          <div key={e.id} className={`log-${e.level}`}>
            <span className="mono">{new Date(e.time).toLocaleTimeString()}</span> [{e.source}] {e.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function AudiusSettings() {
  const { audius, matching } = useApp();
  const st = useAudiusState();
  useTick(1000);
  const stats = audius.client.stats;
  const enabled = matching.resolver.isEnabled("audius");
  return (
    <fieldset>
      <legend>STREAMING → AUDIUS</legend>
      <div className="row">
        <span className={st.connection === "ok" ? "ok-text" : st.connection === "error" ? "warn" : "hint"}>
          {st.connection === "ok" ? "● Connected — API reachable" : st.connection === "error" ? `▲ Unreachable: ${st.connectionError ?? ""}` : st.connection === "testing" ? "Testing…" : "Not tested yet"}
        </span>
        <button disabled={st.connection === "testing"} onClick={() => void audius.testConnection().then(() => matching.notifySourcesChanged())}>
          Test connection
        </button>
      </div>
      <p className="hint">
        Authentication: none needed (public API, identified as app "{audiusAppName()}"). No account, key or secret is stored. Free tier: 10 requests/s,
        500k/month — the app throttles itself to 5/s, retries with back-off and caches metadata for 10 minutes.
      </p>
      <p className="hint">
        API {stats.host} · requests this session {stats.requests} · cache hits {stats.cacheHits} · retries {stats.retries} · errors {stats.errors}
        {stats.avgLatencyMs != null ? ` · avg latency ${stats.avgLatencyMs} ms` : ""}
      </p>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => matching.setSourceEnabled("audius", e.target.checked)} />
        Use Audius for Smart Matching (Spotify / Apple Music tracks without a local file)
      </label>
    </fieldset>
  );
}

function ProviderStatusTable() {
  const { matching, streaming } = useApp();
  useTick(1000);
  const s = streaming.getState();
  const rows: [string, string, string][] = [
    ["Local Library", "AVAILABLE", "Your files — every DJ feature"],
    ["Spotify", s.spotify.status?.connected ? "METADATA / PLAYLISTS" : "NOT CONNECTED", "Discovery & playlists only; audio never used"],
    ["Apple Music", s["apple-music"].status?.connected ? "METADATA / PLAYLISTS" : "NOT CONNECTED", "Discovery & library only; audio never used"],
  ];
  for (const src of matching.resolver.getSources()) {
    if (src.id === "local") continue;
    const a = src.availability();
    rows.push([
      src.name,
      a.available ? (matching.resolver.isEnabled(src.id) ? "AVAILABLE" : "AVAILABLE (matching off)") : src.remote && src.id !== "audius" ? "PARTNER ACCESS REQUIRED" : "UNAVAILABLE",
      a.available ? "Playable in the decks (recording disabled)" : (a.reason ?? ""),
    ]);
  }
  return (
    <fieldset>
      <legend>STREAMING / MUSIC PROVIDERS</legend>
      <table className="provider-table">
        <tbody>
          {rows.map(([name, status, note]) => (
            <tr key={name}>
              <td><b>{name}</b></td>
              <td className={status.startsWith("AVAILABLE") || status.startsWith("METADATA") ? "ok-text" : "hint"}>{status}</td>
              <td className="hint">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </fieldset>
  );
}

function SmartMatchSettings() {
  const { matching, platform } = useApp();
  const [, force] = useState(0);
  const sources = matching.resolver.getSources();
  const cfg = matching.resolver.getConfig();
  const move = (i: number, d: -1 | 1) => {
    const order: SourceId[] = sources.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    matching.setOrder(order);
    force((n) => n + 1);
  };
  const set = (patch: Parameters<typeof matching.setConfig>[0]) => {
    matching.setConfig(patch);
    force((n) => n + 1);
  };
  return (
    <fieldset>
      <legend>STREAMING → SMART MATCHING</legend>
      <p className="hint">Spotify / Apple Music tracks are matched to a source that may actually be played, in this order:</p>
      <ol className="source-order">
        {sources.map((s, i) => {
          const a = s.availability();
          return (
            <li key={s.id}>
              <span className={a.available ? "ok-text" : "hint"}>{s.name}</span>
              {!a.available && (
                <span className="hint" title={a.reason}>
                  {" "}— unavailable (partner access only){" "}
                  {a.docsUrl && <button className="linklike" onClick={() => platform.openExternal(a.docsUrl!)}>why?</button>}
                </span>
              )}
              <span className="row-actions">
                {s.id !== "local" && a.available && (
                  <label className="hint">
                    <input type="checkbox" checked={matching.resolver.isEnabled(s.id)} onChange={(e) => { matching.setSourceEnabled(s.id, e.target.checked); force((n) => n + 1); }} /> use
                  </label>
                )}
                <button className="tiny" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="tiny" disabled={i === sources.length - 1} onClick={() => move(i, 1)}>↓</button>
              </span>
            </li>
          );
        })}
      </ol>
      <label>
        Load automatically at or above
        <input type="range" min={70} max={100} step={1} value={cfg.autoLoadMin} onChange={(e) => set({ autoLoadMin: Number(e.target.value) })} />
        <span>{cfg.autoLoadMin}%</span>
      </label>
      <label>
        Duration: very strong within (s)
        <input type="number" min={0.5} max={10} step={0.5} value={cfg.durationVeryStrongS} onChange={(e) => set({ durationVeryStrongS: Number(e.target.value) })} />
      </label>
      <label>
        Duration: strong within (s)
        <input type="number" min={1} max={20} step={0.5} value={cfg.durationStrongS} onChange={(e) => set({ durationStrongS: Number(e.target.value) })} />
      </label>
      <label>
        Duration: possible within (s)
        <input type="number" min={2} max={60} step={1} value={cfg.durationPossibleS} onChange={(e) => set({ durationPossibleS: Number(e.target.value) })} />
      </label>
      <p className="hint">Below 70% nothing is ever loaded automatically; ambiguous versions always ask you.</p>
    </fieldset>
  );
}

function StreamingSettings() {
  const { streaming } = useApp();
  const [, force] = useState(0);
  useEffect(() => {
    void streaming.refresh("spotify");
    void streaming.refresh("apple-music");
    return streaming.on("change", () => force((n) => n + 1));
  }, [streaming]);
  const s = streaming.getState();
  const row = (id: "spotify" | "apple-music", name: string) => {
    const st = s[id].status;
    return (
      <div className="row" key={id}>
        <strong style={{ minWidth: 100 }}>{name}</strong>
        <span className={st?.connected ? "ok-text" : "hint"}>
          {!streaming.available ? "desktop app only" : st?.connected ? `Connected — ${st.account ?? ""}` : st?.configured ? "Set up, not signed in" : "Not connected"}
        </span>
        {st?.connected && <button onClick={() => void streaming.disconnect(id)}>Disconnect</button>}
        {st?.configured && <button onClick={() => void streaming.disconnect(id, true)}>Forget credentials</button>}
      </div>
    );
  };
  return (
    <fieldset>
      <legend>STREAMING</legend>
      {row("spotify", "Spotify")}
      {row("apple-music", "Apple Music")}
      <p className="hint">Connect or browse from the Library tab → MUSIC. Streaming tracks are browse-and-match only; they can't be mixed or recorded.</p>
    </fieldset>
  );
}

export function Settings() {
  const app = useApp();
  const { audio, engine, controllers, platform, log } = app;
  useEngineState();
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [cfg, setCfg] = useState<AudioConfig>(audio.getConfig());
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const settings = engine.getSettings();

  useEffect(() => {
    void audio.listOutputDevices().then(setDevices).catch(() => setDevices([]));
  }, [audio]);

  const applyAudio = async (next: AudioConfig = cfg) => {
    setBusy(true);
    try {
      await audio.reconfigure(next);
      app.saveAudioConfig(next);
      setCfg(next);
      log.info("audio", "Audio configuration applied");
    } catch (err) {
      log.error("audio", String(err));
    } finally {
      setBusy(false);
    }
  };

  const importMixxx = async () => {
    const file = await platform.pickTextFile(".xml");
    if (!file) return;
    try {
      const result = importMixxxMapping(file.text, { fileName: file.name });
      setImported(result);
      log.info("controllers", `Imported Mixxx mapping "${result.mapping.name}": ${result.report.exact} exact, ${result.report.heuristic} inferred, ${result.report.unresolved.length} unresolved`);
    } catch (err) {
      log.error("controllers", `Import failed: ${String(err)}`);
    }
  };

  const download = (name: string, data: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const jog = settings.jog;
  const setJog = (k: keyof typeof jog, v: number) => app.saveEngineSettings({ jog: { ...jog, [k]: v } });
  const ddjAudio = devices.find((d) => /ddj[- ]?sb/i.test(d.label));
  const selectedDevice = devices.find((d) => d.id === cfg.outputDeviceId);
  const ddjConnected = controllers.getControllers().some((c) => c.connected && /ddj[- ]?sb/i.test(c.portName));
  const usingDdjAudio = !!selectedDevice && /ddj[- ]?sb/i.test(selectedDevice.label);

  return (
    <div className="settings">
      <fieldset>
        <legend>AUDIO</legend>
        <label>
          Master output device
          <select value={cfg.outputDeviceId} onChange={(e) => setCfg({ ...cfg, outputDeviceId: e.target.value })}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Routing
          <select value={cfg.routing} onChange={(e) => setCfg({ ...cfg, routing: e.target.value as AudioConfig["routing"] })}>
            <option value="stereo">Stereo — master only (no headphone cue)</option>
            <option value="quad">4 channels — master 1/2, headphones 3/4 (DDJ-SB sound card)</option>
          </select>
        </label>
        <label>
          Latency / buffer
          <select
            value={String(cfg.latencyHint)}
            onChange={(e) => {
              const v = e.target.value;
              setCfg({ ...cfg, latencyHint: v === "interactive" || v === "balanced" ? v : Number(v) });
            }}
          >
            <option value="interactive">Lowest (interactive)</option>
            <option value="0.005">~5 ms</option>
            <option value="0.01">~10 ms</option>
            <option value="0.02">~20 ms (safe)</option>
            <option value="balanced">Balanced</option>
          </select>
        </label>
        <label>
          Sample rate
          <select value={String(cfg.sampleRate ?? "")} onChange={(e) => setCfg({ ...cfg, sampleRate: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Device default</option>
            <option value="44100">44100 Hz</option>
            <option value="48000">48000 Hz</option>
          </select>
        </label>
        <button disabled={busy} onClick={() => void applyAudio()}>
          {busy ? "Applying…" : "Apply audio settings"}
        </button>
        {ddjConnected && !usingDdjAudio && <div className="hardware-audio-notice"><b>DDJ-SB hardware level knobs</b><span>MASTER LEVEL and HEADPHONES LEVEL do not send MIDI. They control the DDJ-SB sound card directly, so they only affect audio routed to that device.</span>{ddjAudio?<button disabled={busy} onClick={()=>void applyAudio({...cfg,outputDeviceId:ddjAudio.id,routing:"quad"})}>Use DDJ-SB audio + headphone cue</button>:<span className="hint">The DDJ-SB audio output is not currently exposed by Windows. Connect it, install or enable its audio driver, then reopen Settings.</span>}</div>}
        <p className="hint">Changing sample rate, latency or routing restarts the audio engine (loaded tracks are kept).</p>
      </fieldset>

      <fieldset>
        <legend>CONTROLLERS / JOG</legend>
        <label>
          Jog ticks per revolution
          <input type="number" value={jog.ticksPerRevolution} min={16} max={8192} onChange={(e) => setJog("ticksPerRevolution", Number(e.target.value))} />
        </label>
        <label>
          Jog sensitivity (paused positioning)
          <input type="range" min={0.1} max={4} step={0.1} value={jog.jogSensitivity} onChange={(e) => setJog("jogSensitivity", Number(e.target.value))} />
          <span>{jog.jogSensitivity.toFixed(1)}×</span>
        </label>
        <label>
          Scratch sensitivity
          <input type="range" min={0.25} max={4} step={0.05} value={jog.scratchSensitivity} onChange={(e) => setJog("scratchSensitivity", Number(e.target.value))} />
          <span>{jog.scratchSensitivity.toFixed(2)}×</span>
        </label>
        <label>
          Pitch bend strength
          <input type="range" min={0.0005} max={0.02} step={0.0005} value={jog.pitchBendStrength} onChange={(e) => setJog("pitchBendStrength", Number(e.target.value))} />
          <span>{jog.pitchBendStrength.toFixed(4)}</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.tempoDownIsFaster} onChange={(e) => app.saveEngineSettings({ tempoDownIsFaster: e.target.checked })} />
          Tempo slider: pulling towards you (down) = faster
        </label>
        <label>
          Crossfader curve
          <select value={settings.crossfaderCurve} onChange={(e) => app.saveEngineSettings({ crossfaderCurve: e.target.value as CrossfaderCurve })}>
            <option value="additive">Additive (mix)</option>
            <option value="smooth">Smooth (constant power)</option>
            <option value="sharp">Sharp (scratch cut)</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={settings.lockPlayingDecks} onChange={(e) => app.saveEngineSettings({ lockPlayingDecks: e.target.checked })} />
          Prevent loading into a playing deck
        </label>
        <div className="row">
          <button onClick={() => { const m = controllers.getActiveMapping() ?? controllers.getMappings()[0]; if (m) download(`${m.id}.json`, m); }}>
            Export mapping (JSON)
          </button>
          <button onClick={() => void importMixxx()}>Import Mixxx mapping (.xml)…</button>
        </div>
      </fieldset>

      <StreamingSettings />
      <WaveformSettings />
      <StemSettings />
      <AudiusSettings />
      <ProviderStatusTable />
      <SmartMatchSettings />

      {imported && (
        <fieldset className="import-report">
          <legend>MIXXX IMPORT — {imported.report.controllerName}</legend>
          <p>
            {imported.report.totalControls} controls: <strong>{imported.report.exact}</strong> exact,{" "}
            <strong>{imported.report.heuristic}</strong> inferred from script names (review),{" "}
            <strong>{imported.report.unresolved.length}</strong> unresolved. LEDs: {imported.report.outputsMapped}/{imported.report.totalOutputs}.
          </p>
          {imported.report.warnings.map((w, i) => (
            <p key={i} className="warn">⚠ {w}</p>
          ))}
          <details>
            <summary>Unresolved ({imported.report.unresolved.length})</summary>
            <ul className="mono">
              {imported.report.unresolved.map((u, i) => (
                <li key={i}>
                  {u.status}/{u.midino} {u.group} {u.key} — {u.reason}
                </li>
              ))}
            </ul>
          </details>
          <div className="row">
            <button onClick={() => download(`${imported.mapping.id}.json`, imported.mapping)}>Download as dbdj JSON</button>
            <button
              onClick={() => {
                controllers.addMapping(imported.mapping);
                log.info("controllers", `Mapping "${imported.mapping.name}" installed (matches ports: ${imported.mapping.match.portNamePatterns.join(", ")})`);
              }}
            >
              Use this mapping for matching devices
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

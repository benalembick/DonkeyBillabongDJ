/**
 * Settings → STEMS and the STEMS diagnostics block.
 * Everything shown here is measured (device in use, compute speed), not assumed.
 */
import { useEffect, useState } from "react";
import type { StemDevice } from "../stems/protocol";
import type { StemMode } from "../stems/StemService";
import type { Quality } from "../stems/separator";
import { useApp, useEngineState } from "./context";
import { useStemStatus } from "./stemHooks";

type Config = { cacheDir: string; maxCacheGB: number; device: StemDevice };

const MB = 1024 * 1024;

function speedVerdict(rtf?: number): { text: string; cls: string } {
  if (rtf == null) return { text: "not measured yet (measured on first separation)", cls: "hint" };
  const x = 1 / rtf;
  if (rtf <= 0.5) return { text: `${x.toFixed(1)}× real time — real-time capable`, cls: "ok-text" };
  if (rtf <= 1) return { text: `${x.toFixed(1)}× real time — keeps up with playback, but seeks/jumps need a moment; pre-analyse for instant STEMS`, cls: "warn" };
  return { text: `${x.toFixed(2)}× real time — slower than playback: pre-analyse tracks before your set`, cls: "warn" };
}

export function StemSettings() {
  const { stems, platform } = useApp();
  const st = useStemStatus();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cache, setCache] = useState<{ entries: number; bytes: number; complete: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.dbdjDesktop?.stems;

  const reload = async () => {
    if (!bridge) return;
    try {
      const s = await bridge.status();
      setCfg(s.config);
      setCache(await bridge.cacheInfo());
    } catch (err) {
      setError(String(err));
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.modelInstalled, st.libraryQueue]);

  if (platform.kind !== "desktop" || !bridge) {
    return (
      <fieldset>
        <legend>STEMS</legend>
        <p className="hint">STEM separation runs locally with an open-source model and needs the desktop app.</p>
      </fieldset>
    );
  }

  const setConfig = async (patch: Partial<Config>) => {
    setCfg((await bridge.setConfig(patch)) as Config);
  };
  const verdict = speedVerdict(st.rtf ?? st.worker.rtf);
  const realtimeOk = (st.rtf ?? st.worker.rtf ?? 9) <= 0.5;
  const dl = st.download;

  return (
    <fieldset>
      <legend>STEMS</legend>
      {!st.modelInstalled ? (
        <div className="row">
          <span className="hint">
            Separation model: HT-Demucs 4-stem (Meta AI research, MIT licence), ONNX, ~166 MB. Downloaded once from Hugging Face, checksum-verified, runs
            entirely on this computer — no audio leaves your machine.
          </span>
          <button className="primary" disabled={!!dl} onClick={() => void stems.downloadModel().catch((e) => setError(String(e)))}>
            {dl ? `Downloading… ${Math.round((dl.received / dl.total) * 100)}%` : "Install model"}
          </button>
        </div>
      ) : (
        <p className="hint">Model: HT-Demucs 4-stem (ONNX) installed · vocals, drums, bass, instruments</p>
      )}
      {error && <p className="warn">⚠ {error}</p>}

      <div className="row">
        <label>
          Mode{" "}
          <select value={st.settings.mode} onChange={(e) => stems.updateSettings({ mode: e.target.value as StemMode })}>
            <option value="off">Off</option>
            <option value="automatic">Automatic — separate each loaded track from the playhead</option>
            <option value="preanalyse">Pre-analyse — only when STEMS is switched on, or from the library</option>
            <option value="realtime" disabled={!realtimeOk}>
              Real-time {realtimeOk ? "" : "(not fast enough on this computer)"}
            </option>
          </select>
        </label>
        <label>
          Quality{" "}
          <select value={st.settings.quality} onChange={(e) => stems.updateSettings({ quality: e.target.value as Quality })}>
            <option value="performance">Performance (fastest, 10% overlap)</option>
            <option value="balanced">Balanced (25% overlap)</option>
            <option value="high">High (50% overlap, ~1.5× slower)</option>
          </select>
        </label>
        {cfg && (
          <label>
            Device{" "}
            <select value={cfg.device} onChange={(e) => void setConfig({ device: e.target.value as StemDevice })}>
              <option value="auto">Auto (GPU if it works, else CPU)</option>
              <option value="gpu">GPU ({platform.os === "darwin" ? "CoreML / Apple Silicon" : "DirectML"})</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
        )}
      </div>

      <p className="hint">
        Worker: {st.worker.state}
        {st.worker.device ? ` · device in use: ${st.worker.device}` : ""}
        {st.worker.message ? ` · ${st.worker.message}` : ""}
        {st.libraryQueue ? ` · library queue: ${st.libraryQueue}` : ""}
      </p>
      <p className={verdict.cls}>Processing speed: {verdict.text}</p>
      {st.modelInstalled && (
        <div className="row">
          <button onClick={() => void stems.benchmark()}>Measure speed</button>
        </div>
      )}

      {cfg && (
        <>
          <div className="row">
            <span className="hint" title={cfg.cacheDir}>
              Cache: {cfg.cacheDir}
            </span>
            <button
              onClick={() =>
                void bridge.pickCacheDir().then((d) => {
                  if (d) void setConfig({ cacheDir: d }).then(reload);
                })
              }
            >
              Change…
            </button>
          </div>
          <div className="row">
            <label>
              Max cache size{" "}
              <input
                type="number"
                min={1}
                max={2000}
                value={cfg.maxCacheGB}
                style={{ width: 70 }}
                onChange={(e) => void setConfig({ maxCacheGB: Math.max(1, Number(e.target.value) || 1) })}
              />{" "}
              GB
            </label>
            <span className="hint">
              {cache ? `${cache.entries} track(s), ${cache.complete} complete, ${(cache.bytes / MB).toFixed(0)} MB used` : ""} · oldest entries are removed
              automatically when full
            </span>
            <button
              disabled={!cache?.entries}
              onClick={() => {
                if (confirm("Delete all cached STEMS? Tracks will need to be analysed again.")) void bridge.clearCache().then(() => stems.refreshIndex()).then(reload);
              }}
            >
              Clear cache
            </button>
          </div>
        </>
      )}
      <p className="hint">
        Only local files are cached (keyed by audio content, so renaming or re-tagging keeps the cache). Audius tracks are separated in memory and never
        saved. Spotify / Apple Music audio is never available to the app, so it can't be separated.
      </p>
    </fieldset>
  );
}

export function StemDiagnostics() {
  const st = useStemStatus();
  const s = useEngineState();
  return (
    <fieldset>
      <legend>STEMS</legend>
      <p className="mono">
        available: {String(st.available)}
        {st.reason ? ` (${st.reason})` : ""} · model: {st.modelInstalled ? "installed" : "missing"} · worker: {st.worker.state}
        {st.worker.device ? ` on ${st.worker.device}` : ""} · rtf: {st.rtf ?? st.worker.rtf ?? "—"} · mode: {st.settings.mode}/{st.settings.quality}
      </p>
      {s.decks.map((d, i) => (
        <p key={i} className="mono">
          Deck {String.fromCharCode(65 + i)}: {d.stems.status} {Math.round(d.stems.progress * 100)}% · {d.stems.enabled ? "ON" : "off"} · gains{" "}
          {d.stems.volume.map((v, k) => (d.stems.muted[k] ? "M" : v.toFixed(2))).join(" / ")}
          {d.stems.message ? ` · ${d.stems.message}` : ""}
        </p>
      ))}
    </fieldset>
  );
}

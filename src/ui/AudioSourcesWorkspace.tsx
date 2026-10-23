import { useEffect, useMemo, useState } from "react";
import type { AcquisitionCapabilities, CaptureSource, ConversionFormat, ConversionProgress } from "../acquire/types";
import { useApp } from "./context";

type Job = ConversionProgress & { input: string; name: string };

export function AudioSourcesWorkspace({ mode }: { mode: "converter" | "recorder" }) {
  const app = useApp(), bridge = window.dbdjDesktop?.acquire;
  const [capabilities, setCapabilities] = useState<AcquisitionCapabilities | null>(null);
  const [files, setFiles] = useState<string[]>([]), [destination, setDestination] = useState("");
  const [format, setFormat] = useState<ConversionFormat>("mp3"), [bitrate, setBitrate] = useState(320);
  const [rights, setRights] = useState(false), [jobs, setJobs] = useState<Job[]>([]), [running, setRunning] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]), [selectedSource, setSelectedSource] = useState("");
  const [recording, setRecording] = useState(false), [saving, setSaving] = useState(false), [recordingError, setRecordingError] = useState(""), [elapsed, setElapsed] = useState(0);
  useEffect(() => { void bridge?.capabilities().then(setCapabilities); }, [bridge]);
  useEffect(() => { void bridge?.recordingActive().then(setRecording); }, [bridge]);
  useEffect(() => bridge?.onConversionProgress((p) => setJobs((all) => all.map((j) => j.id === p.id ? { ...j, ...p } : j))) ?? (() => undefined), [bridge]);
  const active = useMemo(() => jobs.filter((j) => !["completed", "failed", "cancelled"].includes(j.state)), [jobs]);
  const start = async () => {
    if (!bridge || !files.length || !destination || !rights) return;
    setRunning(true);
    const batch = files.map((input, index) => ({ id: `convert_${Date.now()}_${index}`, input, name: input.split(/[\\/]/).pop() ?? input }));
    setJobs((old) => [...batch.map((j) => ({ ...j, state: "queued" as const, progress: 0 })), ...old]);
    for (const job of batch) try {
      const result = await bridge.convert({ id: job.id, input: job.input, destination, format, bitrateKbps: bitrate, rightsConfirmed: true });
      await app.addFiles([{ ref: result.path, name: result.name }]);
    } catch (error) { setJobs((all) => all.map((j) => j.id === job.id ? { ...j, state: "failed", error: error instanceof Error ? error.message : String(error) } : j)); }
    setRunning(false);
  };
  const refreshSources = async () => {
    if (!bridge?.captureSources) return;
    try {
      const found = (await bridge.captureSources()).filter((source) => /\bVivaldi$/i.test(source.name));
      setSources(found);
      if (!found.some((source) => source.id === selectedSource)) setSelectedSource(found.find((source) => /vivaldi/i.test(source.name))?.id ?? found[0]?.id ?? "");
    } catch (error) { setRecordingError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { if (mode === "recorder" && capabilities?.recorder.available) void refreshSources(); }, [mode, capabilities?.recorder.available]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  const startRecording = async () => {
    if (!bridge?.startRecording || !selectedSource || !rights) return;
    setRecordingError("");
    try {
      await bridge.startRecording(selectedSource);
      setElapsed(0);
      setRecording(true);
    } catch (error) { setRecordingError(error instanceof Error ? error.message : String(error)); }
  };
  const stopRecording = async () => {
    if (!bridge?.stopRecording || saving) return;
    setSaving(true);
    try {
      const saved = await bridge.stopRecording();
      if (saved) await app.addFiles([{ ref: saved.path, name: saved.name }]);
    } catch (error) { setRecordingError(error instanceof Error ? error.message : String(error)); }
    finally { setRecording(false); setSaving(false); }
  };
  if (!bridge) return <div className="audio-sources"><h2>{mode === "converter" ? "High Speed Converter" : "App Recorder"}</h2><p>This feature is available in the desktop app.</p></div>;
  return <div className="audio-sources">
    <header><div><h2>{mode === "converter" ? "High Speed Converter" : "App Recorder"}</h2><p>{mode === "converter" ? "Convert local audio, then import it into your library." : "Record permitted app audio, then import it into your library."}</p></div></header>
    <div className="rights-reminder" role="note"><b>Use permitted audio only.</b> You must own the recording or have permission to convert or record it. DonkeyBillabongDJ does not bypass DRM or provider capture restrictions.</div>
    {mode === "converter" ? <section className="audio-source-card">
      <div className="source-card-title"><div><h3>Local file conversion</h3><p>Offline conversion can reach 15–20× real time on suitable hardware and formats; actual speed is shown for every file.</p></div><span className={capabilities?.converter.available ? "capability-ready" : "capability-off"}>{capabilities?.converter.available ? "● Ready" : "○ Unavailable"}</span></div>
      <div className="converter-grid"><label>Source files<button onClick={() => void bridge.pickConversionFiles().then((x) => x.length && setFiles(x))}>Choose audio files…</button><small>{files.length ? `${files.length} selected` : "MP3, WAV, FLAC, M4A, AAC, OGG or AIFF"}</small></label><label>Output folder<button onClick={() => void bridge.pickConversionDestination().then((x) => x && setDestination(x))}>Choose folder…</button><small title={destination}>{destination || "No folder selected"}</small></label><label>Format<select value={format} onChange={(e) => setFormat(e.target.value as ConversionFormat)}><option value="mp3">MP3</option><option value="flac">FLAC</option><option value="wav">WAV (24-bit PCM)</option><option value="m4a">M4A (AAC)</option></select></label>{(format === "mp3" || format === "m4a") && <label>Bitrate<select value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))}><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option></select></label>}</div>
      <label className="rights-check"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)}/> I confirm I have the rights or permission to convert these files.</label>
      <button className="primary convert-start" disabled={running || !rights || !files.length || !destination || !capabilities?.converter.available} onClick={() => void start()}>{running ? `Converting ${active.length || 1}…` : `Convert and import ${files.length || ""}`}</button>
      {!!jobs.length && <div className="conversion-jobs" aria-live="polite">{jobs.map((j) => <div className="conversion-job" key={j.id}><div><b>{j.name}</b><small>{j.state}{j.speed ? ` · ${j.speed.toFixed(1)}× real time` : ""}{j.error ? ` · ${j.error}` : ""}</small></div><progress max="1" value={j.progress}/>{!["completed", "failed", "cancelled"].includes(j.state) && <button onClick={() => void bridge.cancelConversion(j.id)}>Cancel</button>}</div>)}</div>}
    </section> : <section className="audio-source-card"><div className="source-card-title"><div><h3>Vivaldi Audio Recorder</h3><p>Choose the Vivaldi window whose audio you want to record.</p></div><span className={capabilities?.recorder.available ? "capability-ready" : "capability-off"}>{capabilities?.recorder.available ? "● Ready" : "○ Not available"}</span></div>{capabilities?.recorder.available ? <div className="recorder-controls"><div className="recorder-warning"><b>Recording includes audio from Vivaldi and its child processes.</b><p>Other audible Vivaldi tabs may also be included. Close or mute them before recording.</p></div><div className="capture-source-row"><label>Vivaldi window<select value={selectedSource} disabled={recording} onChange={(event) => setSelectedSource(event.target.value)}><option value="">Choose a window…</option>{sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></label><button disabled={recording} onClick={() => void refreshSources()}>Refresh windows</button></div><label className="rights-check"><input type="checkbox" checked={rights} disabled={recording} onChange={(event) => setRights(event.target.checked)}/> I confirm I own or have permission to record the audio.</label><div className="recorder-actions">{recording ? <button className="record-stop" disabled={saving} onClick={() => void stopRecording()}>{saving ? "Saving…" : "■ Stop and save"}</button> : <button className="primary" disabled={!selectedSource || !rights} onClick={() => void startRecording()}>● Start recording</button>}<span>{recording ? `Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : "Saved as MP3 by default, or WAV, and imported into the library."}</span></div>{recordingError && <p className="recorder-error" role="alert">{recordingError}</p>}</div> : <div className="recorder-notice"><b>{capabilities?.recorder.reason ?? "Checking platform support…"}</b><p>This build cannot capture Vivaldi audio on the current platform.</p></div>}</section>}
  </div>;
}

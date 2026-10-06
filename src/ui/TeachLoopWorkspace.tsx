/**
 * Teach Me: Live Looping — Phase 1 lesson UI. Every control calls the real `LiveLooper`/`TeachLoopService` (see
 * src/teachloop/TeachLoopService.ts); there is no simulated transport here, only presentation. Reduced-motion:
 * the beat-number text is always shown; only the ring's pulsing animation is gated by prefers-reduced-motion (CSS).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useApp } from "./context";
import { useTick } from "./hooks";
import { ACTIVITIES, MILESTONES } from "../teachloop/curriculum";
import { LAYERS, PADS, type PadId } from "../teachloop/sounds";
import { describeClash } from "../teachloop/scoring";
import { LAYER_ADD_ORDER, type Phase } from "../teachloop/TeachLoopService";

const PHASE_LABEL: Record<Phase, string> = { ready: "READY", demo: "DEMO", countin: "COUNT-IN", practice: "PRACTICE", evaluation: "SCORING…", results: "RESULTS" };

function BeatClock({ bar, beat, countIn, running }: { bar: number; beat: number; countIn: number | null; running: boolean }) {
  return <div className={`tl-clock${running ? " running" : ""}`}>
    <svg viewBox="0 0 100 100" aria-hidden className={`tl-clock-ring${countIn !== null ? " count" : ""}`}>
      <circle cx="50" cy="50" r="42" className="track" />
      {Array.from({ length: 4 }, (_, i) => { const a = (i / 4) * 2 * Math.PI - Math.PI / 2; return <line key={i} x1={50 + Math.cos(a) * 34} y1={50 + Math.sin(a) * 34} x2={50 + Math.cos(a) * 44} y2={50 + Math.sin(a) * 44} className={`tick${i === 0 ? " one" : ""}`} />; })}
      <circle cx={50 + Math.cos(((beat - 1) / 4) * 2 * Math.PI - Math.PI / 2) * 39} cy={50 + Math.sin(((beat - 1) / 4) * 2 * Math.PI - Math.PI / 2) * 39} r="5" className="hand" />
    </svg>
    <output className="tl-clock-text" aria-live="polite">{countIn !== null ? `COUNT-IN ${countIn}` : running ? `BAR ${bar} · BEAT ${beat}` : "—"}</output>
  </div>;
}

function PadGrid({ onHit, disabled }: { onHit: (id: PadId) => void; disabled?: boolean }) {
  return <div className="tl-pads" role="group" aria-label="Instrument pads">
    {PADS.map((p) => <button key={p.id} className={`tl-pad tl-pad-${p.id}`} disabled={disabled} onClick={() => onHit(p.id)}><b>{p.label}</b><small>key {p.key}</small></button>)}
  </div>;
}

function ProgressBadge({ earned }: { earned: boolean }) {
  return <span className={`tl-badge${earned ? " earned" : ""}`}>{earned ? "✓ DONE" : "○ NOT YET"}</span>;
}

export function TeachLoopWorkspace() {
  const app = useApp(); const tl = app.teachLoop;
  const ts = useSyncExternalStore(tl.subscribe, tl.getState, tl.getState);
  useSyncExternalStore(tl.looper.subscribe, tl.looper.getState, tl.looper.getState);
  useTick(40); const live = tl.looper.live();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [fixDraft, setFixDraft] = useState<number | null>(null);

  // Keyboard: Space taps (Drill A only), A/S/D/F hit pads. Ignored while typing, and key-repeat never double-counts.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    const key = (e: KeyboardEvent) => {
      if (e.repeat || typing(e)) return;
      const pad = PADS.find((p) => p.key.toLowerCase() === e.key.toLowerCase());
      if (pad) { e.preventDefault(); void tl.hitPad(pad.id); if (ts.phase === "practice" && ts.drill === "a") tl.tapBeatOne(); return; }
      if (e.code === "Space" && ts.phase === "practice" && ts.drill === "a") { e.preventDefault(); tl.tapBeatOne(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [tl, ts.phase, ts.drill]);

  // Sandbox Level 1: award "Built My First Layer" the moment the learner's track gets a playable loop.
  const learnerHasLoop = ts.activity === "sandbox-1" && ts.learnerTrackId ? !!tl.looper.session().tracks.find((t) => t.id === ts.learnerTrackId)?.loop : false;
  useEffect(() => { if (ts.activity === "sandbox-1") tl.maybeAwardFirstLayer(); }, [tl, ts.activity, learnerHasLoop]);

  // Module 2: award "Balanced the Low End" once all four layers are in and at least one has a correction applied.
  const layeringCorrected = ts.activity === "layering" ? LAYER_ADD_ORDER.some((r) => { const id = ts.layerTrackIds[r]; const t = id && tl.looper.session().tracks.find((x) => x.id === id); return t && ((t.lowCutHz ?? 0) > 20 || t.muted); }) : false;
  useEffect(() => { if (ts.activity === "layering") tl.maybeAwardBalance(); }, [tl, ts.activity, ts.layerStep, layeringCorrected]);

  const hitPad = (id: PadId) => { void tl.hitPad(id); if (ts.phase === "practice" && ts.drill === "a") tl.tapBeatOne(); };

  // ── Overview ──
  if (!ts.activity) {
    return <section className="teach-loop" aria-label="Teach Me: Live Looping">
      <header className="tl-top"><div className="tl-title"><b>🎓 TEACH ME: LIVE LOOPING</b><small>Learn by performing — hands-on lessons in the real Looper engine, no microphone needed</small></div></header>
      <div className="tl-overview">
        <div className="tl-progress-summary"><b>{ts.milestonesEarned.length} of {Object.keys(MILESTONES).length} milestones earned</b>
          {!resetConfirm ? <button onClick={() => setResetConfirm(true)}>Reset training progress…</button>
            : <span className="tl-reset-confirm"><b>Reset all progress and milestones?</b><button className="danger" onClick={() => { tl.resetProgress(); setResetConfirm(false); }}>🗑 Reset</button><button onClick={() => setResetConfirm(false)}>✕ Cancel</button></span>}
        </div>
        <div className="tl-cards">
          {ACTIVITIES.map((a) => { const p = ts.progress[a.id]; const locked = !!a.planned || !!a.prerequisites?.some((id) => !ts.progress[id]?.completed);
            return <button key={a.id} className={`tl-card tl-card-${a.kind}${a.planned ? " planned" : ""}`} disabled={a.planned || locked} onClick={() => void tl.selectActivity(a.id)}>
              <header><b>{a.title}</b>{a.planned && <em>PLANNED</em>}</header>
              <p>{a.summary}</p>
              <footer><span>{a.minutes} min</span>{!a.planned && <ProgressBadge earned={!!p?.completed} />}{!a.planned && p?.bestScore != null && <span className="tl-best">best {p.bestScore}</span>}{locked && !a.planned && <span className="tl-locked">🔒 complete Module 1 first</span>}</footer>
            </button>; })}
        </div>
      </div>
    </section>;
  }

  const def = ACTIVITIES.find((a) => a.id === ts.activity)!;
  const modeToggle = <div className="tl-mode" role="group" aria-label="Lesson mode">
    <button className={ts.mode === "strict" ? "active" : ""} title="Strict: your raw, unquantised timing is captured and assessed" onClick={() => tl.setMode("strict")}>STRICT</button>
    <button className={ts.mode === "sandbox" ? "active" : ""} title="Sandbox: REC/LOOP snap to the beat grid — build satisfying loops with less timing pressure" onClick={() => tl.setMode("sandbox")}>SANDBOX</button>
  </div>;
  const header = <header className="tl-top">
    <button className="tl-back" onClick={() => tl.openOverview()}>‹ Lessons</button>
    <div className="tl-title"><b>{def.title}</b><small>{PHASE_LABEL[ts.phase]}{ts.drill ? ` · Drill ${ts.drill.toUpperCase()}` : ""}</small></div>
    {modeToggle}
  </header>;

  // ── Module 1: The Perfect Loop (Drill A then Drill B) ──
  if (ts.activity === "perfect-loop") {
    const drill = ts.drill ?? "a";
    return <section className="teach-loop" aria-label={def.title}>
      {header}
      <div className="tl-lesson">
        <BeatClock bar={live.bar} beat={live.beat} countIn={live.countIn} running={tl.looper.getState().running} />
        <div className="tl-instructions" aria-live="polite">
          {ts.phase === "ready" && drill === "a" && <><p>Drill A — Beat-one practice. The click accents beat one (high tone). Tap a pad or press Space exactly on that accent, {4} times.</p><p className="tl-windows">Target windows: within 40 ms = Perfect, within 90 ms = Good, beyond 180 ms = a miss (every attempt still counts).</p><button className="primary" onClick={() => void tl.playDemo("a")}>▶ HEAR DEMO</button></>}
          {ts.phase === "ready" && drill === "b" && <><p>Drill B — Capture a complete loop. Press ● REC on beat one, play a few pads, then press ⟟ LOOP on the next intended beat one, {4} bars later. The result becomes a real, playable loop.</p><button className="primary" onClick={() => void tl.playDemo("b")}>▶ HEAR DEMO</button></>}
          {ts.phase === "demo" && <><p>That high accent tone is beat one — that's what you'll be judging yourself against.</p><button className="primary" onClick={() => void (drill === "a" ? tl.beginBeatDrill() : tl.beginLoopDrill())}>Got it — START PRACTICE</button></>}
          {ts.phase === "countin" && <p>{ts.message}</p>}
          {ts.phase === "practice" && drill === "a" && <p>{ts.message} <small>({ts.taps.length}/4 taps)</small></p>}
          {ts.phase === "practice" && drill === "b" && <p>{ts.message}</p>}
          {ts.phase === "evaluation" && <p>Scoring your attempt…</p>}
          {ts.phase === "results" && <div className="tl-results">
            <b className="tl-score">{ts.lastScore}/100</b>
            {ts.lastLoopResult && <ul>{ts.lastLoopResult.feedback.map((f, i) => <li key={i}>{f}</li>)}</ul>}
            {drill === "a" && <ul>{ts.taps.map((t, i) => <li key={i}>Tap {i + 1}: {t.judgement === "perfect" ? "Perfect — within the target window." : `${t.errorMs < 0 ? "Early" : "Late"} by ${Math.round(Math.abs(t.errorMs))} ms.`}</li>)}</ul>}
            <div className="tl-result-actions"><button onClick={() => tl.retry()}>↺ RETRY</button>{drill === "a" ? <button className="primary" onClick={() => tl.goToDrillB()}>NEXT: Capture a Loop ›</button> : <button className="primary" onClick={() => tl.openOverview()}>✓ DONE — back to lessons</button>}</div>
          </div>}
        </div>
        {drill === "b" && ts.phase === "practice" && <div className="tl-rec-controls">
          <button className={`tl-big-rec${tl.looper.getState().recording ? " on" : ""}`} onClick={() => tl.looper.getState().recording ? void tl.endLoopRecording() : tl.beginLoopRecording()}>
            {tl.looper.getState().recording?.armed ? "◉ ARMED — play a pad (or press to cancel)" : tl.looper.getState().recording ? "⟟ LOOP (close it)" : "● REC (press on beat one)"}
          </button>
        </div>}
        <PadGrid onHit={hitPad} disabled={ts.phase !== "practice" && ts.phase !== "demo" && ts.phase !== "ready"} />
      </div>
    </section>;
  }

  // ── Fix My Timing ──
  if (ts.activity === "fix-my-timing") {
    const ghost = ts.ghostTrackId ? tl.looper.session().tracks.find((t) => t.id === ts.ghostTrackId) : null;
    const trimIn = ghost?.loop?.trimIn ?? 0; const playing = ts.ghostTrackId ? live.status[ts.ghostTrackId] === "playing" : false;
    return <section className="teach-loop" aria-label={def.title}>
      {header}
      <div className="tl-lesson tl-fix">
        {ts.phase === "ready" ? <><p>{def.summary} The backing loop you'll hear is deliberately misaligned — its downbeat sits a little after where the loop restarts.</p><button className="primary" onClick={() => void tl.beginFixMyTiming()}>▶ START</button></> : <>
          <p>{ts.message}</p>
          <ol className="tl-fix-steps">
            <li><b>1. Hear the problem</b> — <button onClick={() => void tl.looper.perform("toggle", ts.ghostTrackId ?? undefined)}>{playing ? "■ STOP" : "▶ PLAY"}</button></li>
            <li><b>2. Inspect the boundary</b> — IN point: {(trimIn * 1000).toFixed(0)} ms <input type="range" min={0} max={0.3} step={.005} value={trimIn} onChange={(e) => { setFixDraft(+e.target.value); tl.setFixTrim(+e.target.value); }} /></li>
            <li><b>3. Apply a correction</b> — <button onClick={() => void tl.stripFixSilence()}>✂ STRIP SILENCE (auto)</button></li>
            <li><b>4. Compare before / after</b> — <button onClick={() => tl.setFixTrim(0)}>Before (0 ms)</button> <button onClick={() => fixDraft !== null && tl.setFixTrim(fixDraft)}>After ({fixDraft !== null ? Math.round(fixDraft * 1000) : "—"} ms)</button></li>
            <li><b>5. Replay the corrected loop</b> and listen — the kick should now land exactly on the downbeat.</li>
          </ol>
          <div className="tl-explain">
            <p><b>What actually fixes this:</b> Manual Trim moves the loop's playback start point — nothing is cut, so it's always safe to undo back to 0. That's what STRIP SILENCE just did automatically.</p>
            <p><b>What wouldn't fix this:</b> LOOP QUANTIZE only changes where a <i>future</i> recording's start/stop snap to — it can't repair a take that's already been captured. And neither tool can nudge a single off-beat hit <i>inside</i> a recording without moving everything else; that kind of transient correction isn't built yet (planned for a later phase).</p>
          </div>
        </>}
      </div>
    </section>;
  }

  // ── Progressive Sandbox · Level 1 ──
  if (ts.activity === "sandbox-1") {
    const learner = ts.learnerTrackId ? tl.looper.session().tracks.find((t) => t.id === ts.learnerTrackId) : null;
    const ghost = ts.ghostTrackId ? tl.looper.session().tracks.find((t) => t.id === ts.ghostTrackId) : null;
    const rec = tl.looper.getState().recording;
    return <section className="teach-loop" aria-label={def.title}>
      {header}
      <div className="tl-lesson tl-sandbox">
        {ts.phase === "ready" ? <><p>{def.summary}</p><button className="primary" onClick={() => void tl.beginSandbox()}>▶ START</button></> : <>
          <p>{ts.message}</p>
          <PadGrid onHit={hitPad} />
          <div className="tl-sandbox-tracks">
            <div className="tl-sandbox-track"><b>Backing (protected)</b><span className="tl-status">{ghost && ts.ghostTrackId && live.status[ts.ghostTrackId]}</span>
              <label>VOL <input type="range" min={0} max={1.5} step={.01} value={ghost?.volume ?? 1} onChange={(e) => tl.sandboxGhostVolume(+e.target.value)} /></label>
              <button className={ghost?.muted ? "on" : ""} onClick={() => tl.sandboxGhostMute()}>{ghost?.muted ? "🔇 MUTED" : "🔊 MUTE"}</button>
            </div>
            <div className="tl-sandbox-track"><b>Your Loop</b><span className="tl-status">{learner && ts.learnerTrackId && live.status[ts.learnerTrackId]}</span>
              <div className="tl-sandbox-buttons">
                <button className={`tl-big-rec${rec ? " on" : ""}`} onClick={() => tl.sandboxRecordToggle()}>{rec?.armed ? "◉ ARMED" : rec && rec.kind !== "overdub" ? "⟟ LOOP" : "● REC"}</button>
                {learner?.loop && <button onClick={() => tl.sandboxOverdub()}>{rec?.kind === "overdub" ? "⟟ STOP DUB" : "⧉ DUB"}</button>}
                {learner?.loop && <button disabled={(learner.loop.active ?? 1) <= 1} onClick={() => tl.sandboxUndo()}>↶ UNDO</button>}
                {learner?.loop && <button className={learner.muted ? "on" : ""} onClick={() => tl.sandboxMute()}>{learner.muted ? "🔇" : "🔊"}</button>}
                {learner?.loop && <button onClick={() => tl.sandboxClear()}>CLEAR</button>}
              </div>
            </div>
          </div>
          <button onClick={() => tl.retry()}>↺ RETRY (clear everything and start again)</button>
        </>}
      </div>
    </section>;
  }

  // ── Module 2: Layering & Frequency Management ──
  if (ts.activity === "layering") {
    const clashes = tl.clashReport();
    const worst = clashes[0];
    return <section className="teach-loop" aria-label={def.title}>
      {header}
      <div className="tl-lesson tl-layering">
        {ts.phase === "ready" ? <><p>{def.summary}</p><button className="primary" onClick={() => void tl.beginLayering()}>▶ START</button></> : <>
          <p>{ts.message}</p>
          <div className="tl-layer-tracks">
            {LAYERS.map((l) => {
              const id = ts.layerTrackIds[l.role]; const track = id ? tl.looper.session().tracks.find((t) => t.id === id) : undefined;
              const added = l.role === "drums" || LAYER_ADD_ORDER.slice(0, ts.layerStep).includes(l.role);
              return <div key={l.role} className={`tl-layer-track${added ? "" : " tl-layer-pending"}`}>
                <b>{l.label}{l.role === "drums" && " (protected)"}</b><small>{l.note}</small>
                {added && track && <>
                  <label>VOL <input type="range" min={0} max={1.5} step={.01} value={track.volume} onChange={(e) => tl.layerVolume(l.role, +e.target.value)} /></label>
                  {l.role !== "drums" && <label>LOW CUT {track.lowCutHz ? `${Math.round(track.lowCutHz)} Hz` : "OFF"} <input type="range" min={20} max={400} step={5} value={track.lowCutHz ?? 20} onChange={(e) => tl.layerLowCut(l.role, +e.target.value)} /></label>}
                  {l.role !== "drums" && <button className={track.muted ? "on" : ""} onClick={() => tl.layerMute(l.role)}>{track.muted ? "🔇 MUTED" : "🔊 MUTE"}</button>}
                </>}
                {!added && <span className="tl-locked">not added yet</span>}
              </div>;
            })}
          </div>
          <div className="tl-layer-actions">
            {ts.layerStep < LAYER_ADD_ORDER.length ? <button className="primary" onClick={() => tl.addNextLayer()}>＋ ADD LAYER ({LAYERS.find((l) => l.role === LAYER_ADD_ORDER[ts.layerStep])?.label})</button>
              : <button onClick={() => tl.toggleLayeringCompare()}>⇄ COMPARE before / after</button>}
            <button onClick={() => tl.retry()}>↺ RETRY</button>
          </div>
          {clashes.length > 0 && <div className="tl-clash-report">
            <b>⚠ LOW-END DIAGNOSE</b>
            <ul>{clashes.map((c) => <li key={`${c.a}-${c.b}`} className={c.clash >= .6 ? "tl-clash-high" : c.clash >= .3 ? "tl-clash-mid" : "tl-clash-low"}>
              <span className="tl-clash-bar"><i style={{ width: `${Math.round(c.clash * 100)}%` }} /></span>
              {LAYERS.find((l) => l.role === c.a)?.label} × {LAYERS.find((l) => l.role === c.b)?.label}: {describeClash(c.clash)}
            </li>)}</ul>
            {worst && worst.clash >= .3 && <p className="tl-hint">Try LOW CUT on {LAYERS.find((l) => l.role === (worst.a === "drums" ? worst.b : worst.a))?.label} to make room.</p>}
          </div>}
        </>}
      </div>
    </section>;
  }
  return null;
}

/**
 * DJ TRAINING workspace: curriculum dashboard, lesson setup, live coaching panel and results.
 * Coaching never blocks the decks: highlights are outlines on the real controls, and every
 * state is given in text/icons as well as colour.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useApp } from "./context";
import { TrackPicker } from "./TransitionWorkspace";
import { ASSIST_LABELS, lesson as lessonOf, LESSONS, LEVELS, type AssistId, type Lesson, type LessonId } from "../training/curriculum";
import { PASS_MARK, type TrainingService, type TrainingState } from "../training/TrainingService";

function useTraining(svc: TrainingService): TrainingState {
  return useSyncExternalStore(useCallback((cb) => svc.on("change", cb), [svc]), () => svc.getState());
}

/** Outline the controls a step needs (data-train ids) without covering them. */
const HL_IDS = ["transport", "tempo", "jog", "sync", "volume", "eq-low", "eq-mid", "eq-high", "filter"].flatMap((c) => [`${c}-A`, `${c}-B`]).concat(["crossfader", "fx-1", "fx-2"]);
const HIGHLIGHT_CSS = HL_IDS.map((id) => `html[data-train-hl~="${id}"] [data-train="${id}"]`).join(",\n") + " { outline: 2px dashed #ffd166; outline-offset: 3px; border-radius: 6px; animation: train-pulse 1.4s ease-in-out infinite; }";

export function TrainingWorkspace() {
  const { training: svc } = useApp();
  const s = useTraining(svc);
  return (
    <div className="tr">
      <style>{HIGHLIGHT_CSS}</style>
      {s.phase === "dashboard" && <Dashboard s={s} svc={svc} />}
      {s.phase === "setup" && s.lessonId && <Setup s={s} svc={svc} l={lessonOf(s.lessonId)} />}
      {(s.phase === "practice" || s.phase === "assess") && s.lessonId && <Coach s={s} svc={svc} l={lessonOf(s.lessonId)} />}
      {s.phase === "results" && s.lessonId && <Results s={s} svc={svc} l={lessonOf(s.lessonId)} />}
    </div>
  );
}

// ─────────────────────────── dashboard ───────────────────────────

function Dashboard({ s, svc }: { s: TrainingState; svc: TrainingService }) {
  const done = LESSONS.filter((l) => s.progress[l.id]?.completed).length;
  const next = svc.suggestedNext();
  return (
    <>
      <div className="tr-head">
        <h2>DJ TRAINING</h2>
        <span className="hint">Seven lessons from beatmatching to effects transitions — explanation, guided practice and an assessed attempt, scored from your actual playback and controls.</span>
        <span className="tr-spacer" />
        <span className="tr-progress-text">✓ {done} of {LESSONS.length} lessons completed</span>
        <button
          onClick={() => {
            if (confirm("Reset all DJ training progress? Completed lessons, best scores and attempt history will be deleted.")) svc.resetProgress();
          }}
        >
          Reset progress…
        </button>
      </div>
      {s.message && <p className="tr-note">ℹ {s.message}</p>}
      {LEVELS.map((level) => (
        <section key={level} className="tr-level">
          <h3>{level === "Beginner" ? "◔" : level === "Intermediate" ? "◑" : "●"} {level}</h3>
          <div className="tr-cards">
            {LESSONS.filter((l) => l.level === level).map((l) => {
              const p = s.progress[l.id];
              const prereq = l.prerequisites.map((id) => ({ id, done: !!s.progress[id]?.completed }));
              return (
                <button key={l.id} className={`tr-card ${p?.completed ? "done" : ""} ${l.id === next ? "next" : ""}`} onClick={() => svc.selectLesson(l.id)}>
                  <span className="tr-card-title">
                    {l.title}
                    {l.id === next && <em className="tr-badge next">★ Suggested next</em>}
                  </span>
                  <span className="tr-card-sum">{l.summary}</span>
                  <span className="tr-card-meta">
                    <span>⏱ ~{l.minutes} min</span>
                    <span>{p?.completed ? "✓ Completed" : p?.attempts.length ? "◐ Attempted" : p?.practised ? "◐ Practised" : "○ Not started"}</span>
                    <span>{p?.best != null ? `Best ${p.best}` : "No score yet"}</span>
                  </span>
                  {prereq.length > 0 && (
                    <span className="tr-card-pre">
                      Recommended first: {prereq.map((x) => `${x.done ? "✓" : "○"} ${lessonOf(x.id).title}`).join(", ")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

// ─────────────────────────── lesson setup ───────────────────────────

function AssistTable({ l }: { l: Lesson }) {
  const all = [...new Set([...l.assists.practice, ...l.assists.assess, "sync" as AssistId])];
  return (
    <table className="tr-assists">
      <thead>
        <tr><th>Assist</th><th>Guided practice</th><th>Assessed attempt</th></tr>
      </thead>
      <tbody>
        {all.map((a) => (
          <tr key={a}>
            <td>{ASSIST_LABELS[a]}</td>
            <td>{l.assists.practice.includes(a) ? "✓ On" : "✕ Off"}</td>
            <td>{l.assists.assess.includes(a) ? "✓ On" : "✕ Off"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Setup({ s, svc, l }: { s: TrainingState; svc: TrainingService; l: Lesson }) {
  const { engine, library } = useApp();
  const decks = engine.getState().decks;
  const problem = svc.setupProblem();
  const deckTracks = decks.filter((d) => d.status === "ready" && d.track?.source === "local").map((d) => ({ deck: d.index, track: d.track! }));
  const side = (k: "a" | "b") => {
    const ref = k === "a" ? s.aRef : s.bRef;
    const t = ref ? library.getByRef(ref) : null;
    const rd = k === "a" ? s.readiness.a : s.readiness.b;
    const job = ref ? s.analysing[ref] : undefined;
    return (
      <div className={`tr-pick ${k}`}>
        <b className={`tr-side ${k}`}>{k.toUpperCase()}</b> <b>{k === "a" ? "Track A (outgoing, deck A)" : "Track B (incoming, deck B)"}</b>
        <TrackPicker value={ref} onPick={(r) => svc.setTrack(k, r)} deckTracks={deckTracks} />
        {t && <div className="tr-title">{t.title} {t.artist && <span className="hint">· {t.artist}</span>}</div>}
        <ul className="tr-ready">
          {rd.map((r) => (
            <li key={r.text} className={r.level}>
              {r.level === "ok" ? "✓" : r.level === "warn" ? "⚠" : "✕"} {r.text}
              {r.text === "Not analysed yet" && !job && <button className="tiny primary" onClick={() => void svc.analyse(k)}>Analyse now</button>}
            </li>
          ))}
        </ul>
        {job && <p className="tr-job">⏳ {job}</p>}
      </div>
    );
  };
  return (
    <div className="tr-setup">
      <div className="tr-head">
        <button onClick={() => svc.openDashboard()}>‹ Curriculum</button>
        <h2>{l.title}</h2>
        <em className="tr-badge level">{l.level}</em>
        <span className="hint">⏱ ~{l.minutes} min</span>
      </div>
      <div className="tr-cols">
        <div className="tr-col">
          <div className="tr-box">
            <h3>Objective</h3>
            <p className="tr-objective">{l.objective}</p>
            {l.explanation.map((p) => <p key={p}>{p}</p>)}
          </div>
          <div className="tr-box">
            <h3>Example</h3>
            <Illustration id={l.id} />
          </div>
          <div className="tr-box">
            <h3>Steps</h3>
            <ol className="tr-steps-preview">{l.steps.map((x) => <li key={x}>{x}</li>)}</ol>
            <h3>Assessed attempt</h3>
            <p>{l.assessment}</p>
            <AssistTable l={l} />
          </div>
        </div>
        <div className="tr-col">
          <div className="tr-box">
            <h3>Tracks</h3>
            {s.message && <p className="tr-note">ℹ {s.message}</p>}
            {s.suggestions.length > 0 && (
              <>
                <p className="hint">Suggested pairs for this lesson (from your analysed library):</p>
                <ul className="tr-suggest">
                  {s.suggestions.map((p) => (
                    <li key={p.a.ref + p.b.ref}>
                      <button className={`tiny ${s.aRef === p.a.ref && s.bRef === p.b.ref ? "lit" : ""}`} onClick={() => svc.usePair(p)}>Use</button>
                      <span>
                        <b>{p.a.title}</b> → <b>{p.b.title}</b>
                        <span className="hint"> · {p.reasons.join(" · ")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {side("a")}
            {l.id === "harmonic" && s.aRef ? (
              <div className="tr-pick b">
                <b className="tr-side b">B</b> <b>Choose Track B — which key works with Track A?</b>
                {s.choices.length < 2 && <p className="warn">⚠ Not enough analysed tracks with keys near Track A's tempo to choose from. Analyse more tracks, or pick Track B below.</p>}
                <div className="tr-choices">
                  {s.choices.map((c) => (
                    <button key={c.ref} className={`tr-choice ${s.bRef === c.ref ? "chosen" : ""}`} onClick={() => svc.chooseB(c.ref)}>
                      <span>{s.bRef === c.ref ? "◉" : "○"} {c.title}</span>
                      <span>Key {c.key ?? "?"}{c.uncertain ? " (uncertain)" : ""}</span>
                      {s.bRef === c.ref && <span className={c.compatible ? "tr-ok" : "warn"}>{c.compatible ? "✓ Compatible" : "✕ Likely to clash"} — {compatText(s, c.key)}</span>}
                    </button>
                  ))}
                </div>
                <TrackPicker value={s.bRef} onPick={(r) => svc.setTrack("b", r)} deckTracks={deckTracks} />
              </div>
            ) : (
              side("b")
            )}
            {l.id === "quickcut" && (
              <div className="tr-row">
                Cut on:{" "}
                <button className={`tiny ${s.cutOn === "bar" ? "lit" : ""}`} onClick={() => svc.setCutOn("bar")}>Next bar</button>
                <button className={`tiny ${s.cutOn === "phrase" ? "lit" : ""}`} onClick={() => svc.setCutOn("phrase")}>Next phrase</button>
              </div>
            )}
          </div>
          <div className="tr-box">
            {s.blocked && (
              <p className="warn">
                ⚠ {s.blocked} <button className="tiny" onClick={() => void svc.start("practice", true)}>Stop decks & start practice</button>
              </p>
            )}
            {problem && <p className="warn">✕ {problem}</p>}
            <div className="tr-row">
              <button className="primary" disabled={!!problem} onClick={() => void svc.start("practice")}>▶ Start guided practice</button>
              <button disabled={!!problem} onClick={() => void svc.skipGuidance()}>Skip guidance — assessed attempt</button>
            </div>
            <p className="hint">Training loads the tracks onto decks A and B and sets the mixer for the exercise, but never presses PLAY for you. Exit restores your decks, mixer and effects.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function compatText(s: TrainingState, keyB: string | null): string {
  const a = s.readiness.a.find((r) => r.text.startsWith("Key "))?.text.replace(/^Key /, "").replace(/ \(.*$/, "");
  return a && keyB ? `${a} → ${keyB}` : "keys unknown";
}

// ─────────────────────────── coaching panel ───────────────────────────

function Coach({ s, svc, l }: { s: TrainingState; svc: TrainingService; l: Lesson }) {
  const assess = s.phase === "assess";
  const all = [...new Set([...l.assists.practice, ...l.assists.assess, "sync" as AssistId])];
  const done = s.step >= l.steps.length;
  return (
    <div className="tr-coach">
      <div className="tr-head">
        <h2>{l.title}</h2>
        <em className={`tr-badge ${assess ? "assess" : "practice"}`}>{assess ? "● ASSESSED ATTEMPT" : "◐ GUIDED PRACTICE"}</em>
        <span className="tr-spacer" />
        {s.paused ? <button className="primary" onClick={() => svc.resume()}>▶ Resume</button> : <button onClick={() => svc.pause()}>❚❚ Pause</button>}
        <button onClick={() => void svc.retry()}>↻ Retry</button>
        {!assess && <button onClick={() => void svc.skipGuidance()}>Skip guidance</button>}
        {assess && <button onClick={() => svc.finishNow()}>{l.id === "beatmatch" ? "✓ Done — I'm matched" : "✓ Finish attempt"}</button>}
        <button onClick={() => void svc.exit()}>✕ Exit training</button>
      </div>
      <div className="tr-assist-chips" aria-label="Assists">
        {all.map((a) => (
          <span key={a} className={`tr-chip ${s.assists.includes(a) ? "on" : "off"}`}>
            {s.assists.includes(a) ? "✓" : "✕"} {ASSIST_LABELS[a]}
          </span>
        ))}
      </div>
      {s.message && <p className="tr-note">ℹ {s.message === "Practice complete" ? "Practice complete — start the assessed attempt when you're ready." : s.message}</p>}
      <div className="tr-cols">
        <div className="tr-col">
          <div className="tr-box tr-task">
            <small>{done ? "All steps done" : `Step ${s.step + 1} of ${l.steps.length}`}</small>
            <b>{done ? (assess ? "Finishing the attempt…" : "Well done — ready for the assessed attempt?") : l.steps[s.step]}</b>
            {s.highlights.length > 0 && <span className="hint">Highlighted on screen (dashed outline): {s.highlights.map(controlName).join(", ")}</span>}
            {done && !assess && <button className="primary" onClick={() => void svc.start("assess")}>Start the assessed attempt</button>}
          </div>
          <ol className="tr-steps">
            {l.steps.map((x, i) => (
              <li key={x} className={i < s.step ? "done" : i === s.step ? "now" : ""}>
                <span className="tr-step-icon">{i < s.step ? "✓" : i === s.step ? "▶" : "○"}</span> {x}
              </li>
            ))}
          </ol>
          {l.id === "phrase" && <button className="tr-tap" onClick={() => svc.tap()}>Phrase! <small>(tap on the 1 of a new phrase — also mappable as “Training: tap a phrase start”)</small></button>}
        </div>
        <div className="tr-col">
          {s.counter && <div className="tr-box tr-counter">⏲ {s.counter}</div>}
          {s.meter && <Meter m={s.meter} />}
          {s.hints.length > 0 && (
            <ul className="tr-hints">
              {s.hints.map((h) => <li key={h}>💡 {h}</li>)}
            </ul>
          )}
          {!s.assists.includes("hints") && <p className="hint">Coaching hints are off for the assessed attempt — show what you can do.</p>}
          <p className="hint">Timing is measured on the audio clock. Output latency here: ~{s.latencyMs} ms (you hear the music that much after it's played) — taps are corrected for it.</p>
        </div>
      </div>
    </div>
  );
}

const CONTROL_NAMES: Record<string, string> = {
  transport: "PLAY/CUE", tempo: "tempo fader", jog: "jog wheel", sync: "SYNC", volume: "channel fader", "eq-low": "LOW EQ", "eq-mid": "MID EQ", "eq-high": "HIGH EQ", filter: "FILTER",
};
function controlName(id: string): string {
  if (id === "crossfader") return "crossfader";
  if (id.startsWith("fx-")) return `FX${id.slice(3)}`;
  const deck = id.slice(-1);
  return `Deck ${deck} ${CONTROL_NAMES[id.slice(0, -2)] ?? id}`;
}

function Meter({ m }: { m: NonNullable<TrainingState["meter"]> }) {
  const ph = m.phaseMs;
  const clamp = ph === null ? 0 : Math.max(-100, Math.min(100, ph));
  return (
    <div className="tr-box tr-meter">
      <div>
        Tempo: {m.tempoDiff === null ? "—" : Math.abs(m.tempoDiff) < 0.05 ? "✓ matched" : `B ${m.tempoDiff > 0 ? "faster" : "slower"} by ${Math.abs(m.tempoDiff).toFixed(2)} BPM`}
      </div>
      <div className="tr-phase" aria-label="Beat alignment">
        <span>◀ B behind</span>
        <div className="tr-phase-track">
          <div className="tr-phase-zone" />
          {ph !== null && <div className="tr-phase-dot" style={{ left: `${50 + clamp / 2}%` }} />}
        </div>
        <span>B ahead ▶</span>
      </div>
      <div>{ph === null ? "Alignment: — (both decks must play)" : Math.abs(ph) <= 15 ? `✓ Beats aligned (${Math.round(Math.abs(ph))} ms)` : `B ${ph > 0 ? "ahead" : "behind"} by ${Math.round(Math.abs(ph))} ms`}</div>
    </div>
  );
}

// ─────────────────────────── results ───────────────────────────

function Results({ s, svc, l }: { s: TrainingState; svc: TrainingService; l: Lesson }) {
  const r = s.result!;
  const passed = (r.total ?? 0) >= PASS_MARK;
  const history = s.progress[l.id]?.attempts ?? [];
  return (
    <div className="tr-results">
      <div className="tr-head">
        <h2>{l.title} — results</h2>
        <span className="tr-spacer" />
        <button className="primary" onClick={() => void svc.retry()}>↻ Retry</button>
        <button onClick={() => void svc.nextLesson()}>Next lesson ›</button>
        <button onClick={() => svc.openDashboard()}>Curriculum</button>
        <button onClick={() => void svc.exit()}>✕ Exit training</button>
      </div>
      <div className="tr-cols">
        <div className="tr-col">
          <div className={`tr-box tr-total ${passed ? "pass" : "fail"}`}>
            <b>{r.total === null ? "—" : r.total}</b>
            <span>{r.total === null ? "No metric could be measured" : passed ? `✓ Passed (${PASS_MARK} needed)` : `✕ Not yet — ${PASS_MARK} needed to complete the lesson`}</span>
          </div>
          {r.strengths.length > 0 && (
            <div className="tr-box">
              <h3>✓ Strengths</h3>
              <ul>{r.strengths.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          {r.improvements.length > 0 && (
            <div className="tr-box">
              <h3>→ To improve</h3>
              <ul>{r.improvements.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
          {history.length > 1 && (
            <div className="tr-box">
              <h3>Attempts</h3>
              <ol className="tr-history">{history.slice(-8).map((a) => <li key={a.date}>{new Date(a.date).toLocaleString()} — {a.total ?? "—"}</li>)}</ol>
            </div>
          )}
        </div>
        <div className="tr-col">
          <div className="tr-box">
            <h3>How this was scored</h3>
            <p className="hint">Each score comes from playback positions on the audio clock, the tracks' beat grids and your mixer/FX settings during the attempt — not from listening to the audio. The total is the weighted average of the available metrics; unavailable ones are excluded.</p>
            <table className="tr-metrics">
              <thead><tr><th>Metric</th><th>Score</th><th>Measured</th><th>Weight</th></tr></thead>
              <tbody>
                {r.metrics.map((m) => (
                  <tr key={m.id} className={m.score === null ? "na" : ""}>
                    <td>
                      {m.label}
                      <details><summary>How</summary>{m.how}{m.note && <p className="warn">⚠ {m.note}</p>}</details>
                    </td>
                    <td>{m.score === null ? "Unavailable" : `${m.score}`}</td>
                    <td>{m.value}</td>
                    <td>{m.score === null ? "excluded" : `×${m.weight}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── lesson illustrations ───────────────────────────

/** Simple diagrams of what each lesson looks like (text labels on every element). */
function Illustration({ id }: { id: LessonId }) {
  const W = 520;
  const lane = (y: number, label: string) => <text x={4} y={y + 4} className="tr-svg-label">{label}</text>;
  const bars = (n: number, y0: number, y1: number, phrase = 8) =>
    Array.from({ length: n + 1 }, (_, i) => <line key={i} x1={70 + (i * (W - 80)) / n} x2={70 + (i * (W - 80)) / n} y1={y0} y2={y1} className={i % phrase === 0 ? "tr-svg-phrase" : "tr-svg-bar"} />);
  const X = (bar: number, n: number) => 70 + (bar * (W - 80)) / n;
  switch (id) {
    case "beatmatch":
      return (
        <svg viewBox={`0 0 ${W} 120`} className="tr-svg" role="img" aria-label="Beats drifting, then aligned after matching tempo and nudging">
          {lane(30, "Track A")}
          {lane(70, "Track B")}
          {Array.from({ length: 16 }, (_, i) => <line key={`a${i}`} x1={70 + i * 28} x2={70 + i * 28} y1={20} y2={40} className="tr-svg-beat a" />)}
          {Array.from({ length: 16 }, (_, i) => { const drift = i < 8 ? (8 - i) * 2.5 : 0; return <line key={`b${i}`} x1={70 + i * 28 + drift} x2={70 + i * 28 + drift} y1={60} y2={80} className="tr-svg-beat b" />; })}
          <text x={70} y={105} className="tr-svg-label">B drifts (tempo off) …</text>
          <text x={300} y={105} className="tr-svg-label">… tempo matched + nudged: kicks together</text>
        </svg>
      );
    case "phrase":
      return (
        <svg viewBox={`0 0 ${W} 110`} className="tr-svg" role="img" aria-label="16 bars with phrase starts at bars 1 and 9; Track B enters on bar 9">
          {lane(30, "Track A")}
          {lane(70, "Track B")}
          {bars(16, 15, 85)}
          <rect x={X(0, 16)} y={22} width={X(16, 16) - X(0, 16)} height={16} className="tr-svg-a" />
          <rect x={X(8, 16)} y={62} width={X(16, 16) - X(8, 16)} height={16} className="tr-svg-b" />
          <text x={X(0, 16) + 2} y={100} className="tr-svg-label">▲ phrase (bar 1)</text>
          <text x={X(8, 16) + 2} y={100} className="tr-svg-label">▲ phrase (bar 9): start B here — bars 2–8 are not phrase starts</text>
        </svg>
      );
    case "bassswap":
    case "longblend": {
      const n = id === "bassswap" ? 16 : 32;
      const mid = n / 2;
      const curve = (from: number, to: number, y: number) => `M ${X(0, n)} ${y - from * 30} L ${X(mid, n)} ${y - from * 30} L ${X(mid + (id === "bassswap" ? 1 : 2), n)} ${y - to * 30} L ${X(n, n)} ${y - to * 30}`;
      return (
        <svg viewBox={`0 0 ${W} 130`} className="tr-svg" role="img" aria-label={`LOW EQ handover at bar ${mid + 1} of a ${n}-bar blend`}>
          {lane(25, "A LOW")}
          {lane(75, "B LOW")}
          {bars(n, 5, 95, 8)}
          <path d={curve(1, 0, 40)} className="tr-svg-line a" />
          <path d={curve(0, 1, 90)} className="tr-svg-line b" />
          <text x={X(mid, n) + 3} y={118} className="tr-svg-label">⇅ swap on bar {mid + 1} (within {id === "bassswap" ? "1 bar" : "2 bars"}) — one bass at a time</text>
        </svg>
      );
    }
    case "harmonic":
      return (
        <svg viewBox={`0 0 ${W} 120`} className="tr-svg" role="img" aria-label="Camelot wheel neighbours of 8A">
          {[["7A", 120], ["8A", 260], ["9A", 400]].map(([k, x]) => (
            <g key={k as string}>
              <circle cx={x as number} cy={45} r={24} className={k === "8A" ? "tr-svg-key home" : "tr-svg-key"} />
              <text x={(x as number) - 11} y={50} className="tr-svg-keytext">{k}</text>
            </g>
          ))}
          <circle cx={260} cy={100} r={16} className="tr-svg-key" />
          <text x={250} y={105} className="tr-svg-keytext">8B</text>
          <text x={10} y={20} className="tr-svg-label">From 8A, compatible: 7A / 9A (one step), 8B (relative major) — and 8A itself</text>
        </svg>
      );
    case "quickcut":
      return (
        <svg viewBox={`0 0 ${W} 110`} className="tr-svg" role="img" aria-label="Track A stops and Track B starts on the same phrase downbeat">
          {lane(30, "Track A")}
          {lane(70, "Track B")}
          {bars(16, 15, 85)}
          <rect x={X(0, 16)} y={22} width={X(8, 16) - X(0, 16)} height={16} className="tr-svg-a" />
          <rect x={X(8, 16)} y={62} width={X(16, 16) - X(8, 16)} height={16} className="tr-svg-b" />
          <line x1={X(8, 16)} x2={X(8, 16)} y1={10} y2={90} className="tr-svg-cut" />
          <text x={X(8, 16) + 4} y={102} className="tr-svg-label">✂ cut: A out and B in on the same downbeat</text>
        </svg>
      );
    case "effects":
      return (
        <svg viewBox={`0 0 ${W} 120`} className="tr-svg" role="img" aria-label="Echo on one beat before the boundary, A cut on it, echo tail for 4 bars over B">
          {lane(30, "Track A")}
          {lane(75, "Track B")}
          {bars(16, 15, 90)}
          <rect x={X(0, 16)} y={22} width={X(8, 16) - X(0, 16)} height={16} className="tr-svg-a" />
          {[0, 1, 2, 3].map((i) => <rect key={i} x={X(8 + i, 16)} y={22 + i * 3} width={X(1, 16) - X(0, 16) - 4} height={16 - i * 4} className="tr-svg-echo" />)}
          <rect x={X(8, 16)} y={67} width={X(16, 16) - X(8, 16)} height={16} className="tr-svg-b" />
          <text x={X(7.75, 16) - 60} y={12} className="tr-svg-label">ECHO on (beat 4) ▼</text>
          <text x={X(8, 16) + 4} y={110} className="tr-svg-label">A cut on the phrase · echo tail 4 bars · then FX off</text>
        </svg>
      );
  }
}

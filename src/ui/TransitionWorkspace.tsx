/**
 * TRANSITIONS workspace (Transition Intelligence): pick two tracks, get bar-accurate mix
 * instructions from their analysis, choose a technique and length, rehearse it on the decks.
 */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp, useLibraryState } from "./context";
import { useAnimationFrame } from "./hooks";
import { barLabel, barLength, fmtTime, TECHNIQUES, timeAtBar, type Difficulty, type TechniqueId, type TrackFacts, type TransitionPlan } from "../transitions/planner";
import type { Side, TransitionService, TransitionState } from "../transitions/TransitionService";
import type { TrackInfo } from "../core/engine/types";

function useTransitions(svc: TransitionService): TransitionState {
  return useSyncExternalStore(useCallback((cb) => svc.on("change", cb), [svc]), () => svc.getState());
}

const DIFFICULTY: Record<Difficulty, string> = { Easy: "●○○", Intermediate: "●●○", Advanced: "●●●" };
const confLabel = (c: number) => (c >= 0.75 ? "High" : c >= 0.5 ? "Medium" : "Low");

export function TransitionWorkspace() {
  const { transitions: svc } = useApp();
  const s = useTransitions(svc);
  const techRef = useRef<HTMLDivElement>(null);
  return (
    <div className="tx">
      <div className="tx-head">
        <h2>TRANSITIONS</h2>
        <span className="hint">Exact mix instructions from both tracks' beat grids, phrases, energy and vocals — then rehearse them on the decks.</span>
        <span className="tx-spacer" />
        <button onClick={() => svc.useDecks()} title="Track A = the playing deck (or deck A), Track B = the other deck">Use deck tracks</button>
        <button onClick={() => svc.swap()} disabled={!s.outRef && !s.inRef} title="Swap outgoing and incoming">⇄ Swap</button>
        <button className={s.savedKey ? "" : "primary"} disabled={!s.plan} onClick={() => svc.save()}>
          {s.savedKey ? "✓ Saved (auto-saving)" : "Save plan"}
        </button>
        <SavedPlans s={s} svc={svc} />
      </div>
      {s.notice && <p className="tx-notice">ℹ {s.notice}</p>}
      <div className="tx-body">
        <div className="tx-col">
          <TrackSlot side="out" s={s} svc={svc} />
          <TrackSlot side="in" s={s} svc={svc} />
        </div>
        <div className="tx-col wide">
          {s.missing.length ? (
            <div className="tx-card tx-empty">
              <h3>Waiting for analysis</h3>
              <ul>{s.missing.map((m) => <li key={m}>✕ {m}</li>)}</ul>
              <p className="hint">No recommendations are made without a beat grid for both tracks — run the analysis on the left.</p>
            </div>
          ) : (
            <>
              <div ref={techRef}>
                <Techniques s={s} svc={svc} />
              </div>
              {s.problem && !s.plan && <div className="tx-card tx-empty"><p className="warn">⚠ {s.problem}</p></div>}
              {s.plan && s.out && s.in && (
                <>
                  <PlanView plan={s.plan} a={s.out} b={s.in} />
                  <Rehearsal s={s} svc={svc} onTryAnother={() => techRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SavedPlans({ s, svc }: { s: TransitionState; svc: TransitionService }) {
  if (!s.saved.length) return null;
  return (
    <label className="tx-saved">
      Saved plans{" "}
      <select value={s.savedKey ?? ""} onChange={(e) => e.target.value && svc.open(e.target.value)}>
        <option value="">Open…</option>
        {s.saved.map((p) => (
          <option key={p.key} value={p.key}>
            {p.outTitle} → {p.inTitle}
          </option>
        ))}
      </select>
      {s.savedKey && (
        <button className="tiny" title="Delete this saved plan" onClick={() => svc.remove(s.savedKey!)}>
          ✕
        </button>
      )}
    </label>
  );
}

// ─────────────────────────── track slots ───────────────────────────

function TrackSlot({ side, s, svc }: { side: Side; s: TransitionState; svc: TransitionService }) {
  const { engine } = useApp();
  const ref = side === "out" ? s.outRef : s.inRef;
  const f = side === "out" ? s.out : s.in;
  const job = ref ? s.jobs[ref] : undefined;
  const name = side === "out" ? "Track A — outgoing" : "Track B — incoming";
  const decks = engine.getState().decks;
  const offset = side === "out" ? s.settings.outPhraseOffset : s.settings.inPhraseOffset;
  return (
    <div className={`tx-card tx-slot ${side}`}>
      <div className="tx-row">
        <b className={`tx-side ${side}`}>{side === "out" ? "A" : "B"}</b>
        <h3>{name}</h3>
      </div>
      <TrackPicker
        value={ref}
        onPick={(r) => svc.setTrack(side, r)}
        deckTracks={decks.filter((d) => d.status === "ready" && d.track?.source === "local").map((d) => ({ deck: d.index, track: d.track! }))}
      />
      {f && (
        <>
          <div className="tx-title">
            {f.title} {f.artist && <span className="hint">· {f.artist}</span>}
          </div>
          <ul className="tx-facts">
            <li className={f.analysed ? "ok" : "bad"}>
              {f.analysed ? "✓ Analysed" : "✕ Not analysed"}
              {!f.analysed && !job && (
                <button className="tiny primary" onClick={() => void svc.analyse(side)}>
                  Analyse now
                </button>
              )}
            </li>
            <li className={f.grid ? (f.grid.manual ? "ok" : f.grid.confidence < 1.4 ? "warn" : "ok") : "bad"}>
              {f.grid ? `${f.grid.manual ? "✓" : f.grid.confidence < 1.4 ? "⚠" : "✓"} Beat grid ${f.grid.bpm.toFixed(2)} BPM · ${f.grid.manual ? "set by hand" : `confidence ${f.grid.confidence.toFixed(1)}`}` : "✕ No beat grid"}
            </li>
            <li className={f.key ? "ok" : "warn"}>{f.key ? `✓ Key ${f.key}` : "? Key unknown"}</li>
            <li className={f.energy !== null ? "ok" : "warn"}>{f.energy !== null ? `✓ Energy ${f.energy}/10 · ${f.sections.length} sections (approximate)` : "? Energy unknown"}</li>
            <li className={f.vocals ? "ok" : "warn"}>
              {f.vocals ? `✓ Vocals: ${f.vocals.length} phrase${f.vocals.length === 1 ? "" : "s"} (from STEMS)` : "? Vocal activity unknown"}
              {!f.vocals && f.analysed && !job && (f.stemsCached || s.stemsAvailable) && (
                <button className="tiny" onClick={() => void svc.detectVocals(side)} title={f.stemsCached ? "Read the cached STEMS" : "Separate STEMS first (background), then detect vocals"}>
                  {f.stemsCached ? "Detect vocals" : "Separate STEMS & detect"}
                </button>
              )}
              {!f.vocals && !f.stemsCached && !s.stemsAvailable && <span className="hint">(needs STEMS separation — not available on this computer)</span>}
            </li>
          </ul>
          {job && <p className={job.kind === "error" ? "warn" : "tx-job"}>{job.kind === "error" ? "⚠" : <span className="tx-spin" />} {job.stage}</p>}
          {f.grid && (
            <div className="tx-adjust">
              <div className="tx-row">
                <span title="Bar 1 = the grid's first beat">Downbeat {fmtTime(f.grid.firstBeat)}</span>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { beats: -1 })} title="Bar 1 one beat earlier">◀ beat</button>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { beats: 1 })} title="Bar 1 one beat later">beat ▶</button>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { ms: -10 })}>−10 ms</button>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { ms: 10 })}>+10 ms</button>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { bpm: -0.01 })} title="BPM −0.01">−.01</button>
                <button className="tiny" onClick={() => svc.nudgeGrid(side, { bpm: 0.01 })} title="BPM +0.01">+.01</button>
              </div>
              <div className="tx-row">
                <span title="8-bar phrases counted from this bar">Phrases start at bar {offset + 1}</span>
                <button className="tiny" onClick={() => svc.movePhrase(side, -1)}>◀ bar</button>
                <button className="tiny" onClick={() => svc.movePhrase(side, 1)}>bar ▶</button>
              </div>
              {s.plan && (
                <div className="tx-row">
                  <span>
                    {side === "out" ? "Transition starts" : "Cue"} {barLabel(f.grid, side === "out" ? s.plan.outStart : s.plan.inCue)} · {fmtTime(side === "out" ? s.plan.outStart : s.plan.inCue)}
                  </span>
                  <button className="tiny" onClick={() => svc.movePoint(side, -8)} title="One phrase earlier">«</button>
                  <button className="tiny" onClick={() => svc.movePoint(side, -1)} title="One bar earlier">‹</button>
                  <button className="tiny" onClick={() => svc.movePoint(side, 1)} title="One bar later">›</button>
                  <button className="tiny" onClick={() => svc.movePoint(side, 8)} title="One phrase later">»</button>
                  {(side === "out" ? s.settings.outStartBar : s.settings.inCueBar) !== null && (
                    <button className="tiny" onClick={() => svc.resetPoints()}>Recommended</button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrackPicker({ value, onPick, deckTracks }: { value: string | null; onPick: (ref: string) => void; deckTracks: { deck: number; track: TrackInfo }[] }) {
  const lib = useLibraryState();
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const out: TrackInfo[] = [];
    for (const x of lib.tracks) {
      if (x.source !== "local") continue;
      if (`${x.title} ${x.artist} ${x.album}`.toLowerCase().includes(t)) out.push(x);
      if (out.length >= 8) break;
    }
    return out;
  }, [q, lib.tracks]);
  return (
    <div className="tx-picker">
      <div className="tx-row">
        {deckTracks.map(({ deck, track }) => (
          <button key={deck} className={`tiny ${track.ref === value ? "lit" : ""}`} onClick={() => onPick(track.ref)} title={track.title}>
            Deck {String.fromCharCode(65 + deck)}: {track.title.slice(0, 22)}
          </button>
        ))}
      </div>
      <input placeholder="Search the library…" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && (
        <ul className="tx-matches">
          {matches.map((t) => (
            <li key={t.ref}>
              <button onClick={() => (onPick(t.ref), setQ(""))}>
                {t.title} <span className="hint">{t.artist}{t.bpm ? ` · ${t.bpm.toFixed(1)} BPM` : ""}{t.prepared ? "" : " · not analysed"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────── techniques ───────────────────────────

function Techniques({ s, svc }: { s: TransitionState; svc: TransitionService }) {
  const chosen = TECHNIQUES.find((t) => t.id === s.settings.technique)!;
  const outBpm = s.out?.grid?.bpm ?? 0;
  const [bpmText, setBpmText] = useState<string | null>(null);
  return (
    <div className="tx-card">
      <div className="tx-row">
        <h3>Technique</h3>
        <span className="tx-spacer" />
        <label>
          Length{" "}
          {chosen.lengths.map((n) => (
            <button key={n} className={`tiny ${s.settings.bars === n ? "lit" : ""}`} onClick={() => svc.setSettings({ bars: n })}>
              {n} bar{n > 1 ? "s" : ""}
            </button>
          ))}
        </label>
        <label title="Playback tempo for the transition (Track A's tempo by default)">
          Target BPM{" "}
          <input
            type="number"
            step="0.01"
            value={bpmText ?? (s.settings.targetBpm ?? outBpm).toFixed(2)}
            onChange={(e) => setBpmText(e.target.value)}
            onBlur={() => {
              const v = Number(bpmText);
              if (bpmText !== null && v >= 40 && v <= 250) svc.setSettings({ targetBpm: Math.abs(v - outBpm) < 0.005 ? null : v });
              setBpmText(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        {s.settings.targetBpm !== null && (
          <button className="tiny" onClick={() => svc.setSettings({ targetBpm: null })}>
            Track A tempo
          </button>
        )}
      </div>
      <div className="tx-techniques">
        {s.options.map((o) => (
          <button
            key={o.info.id}
            className={`tx-tech ${o.info.id === s.settings.technique ? "chosen" : ""} ${o.available ? "" : "unavailable"}`}
            disabled={!o.available}
            onClick={() => svc.setSettings({ technique: o.info.id as TechniqueId })}
          >
            <span className="tx-tech-name">
              {o.info.id === s.settings.technique ? "◉" : "○"} {o.info.name}
              {o.recommended && <em className="tx-badge rec">★ Recommended</em>}
            </span>
            <span className="tx-tech-meta">
              <span title={`Difficulty: ${o.info.difficulty}`}>{DIFFICULTY[o.info.difficulty]} {o.info.difficulty}</span>
              {o.available ? <span title="How much of this comes from reliable analysis">Confidence: {confLabel(o.confidence)} ({Math.round(o.confidence * 100)}%)</span> : <span className="warn">✕ Unavailable</span>}
            </span>
            <span className="tx-tech-why">{o.why}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── the plan ───────────────────────────

function PlanView({ plan: p, a, b }: { plan: TransitionPlan; a: TrackFacts; b: TrackFacts }) {
  const ga = a.grid!;
  const gb = b.grid!;
  const bStart = timeAtBar(ga, p.bStartsAtBar);
  const swapA = p.swapAtBar ? timeAtBar(ga, p.outStartBar + p.swapAtBar - 1) : null;
  return (
    <div className="tx-card">
      <h3>Mix plan {p.approximate && <em className="tx-badge approx" title="Phrase points come from energy analysis; beat grids not set by hand">≈ Approximate</em>}</h3>
      <p className="tx-summary">{p.summary}</p>
      <div className="tx-numbers">
        <Num label="Track A: transition starts" value={fmtTime(p.outStart)} sub={barLabel(ga, p.outStart)} />
        <Num label="Track B: start from" value={fmtTime(p.inCue)} sub={`${barLabel(gb, p.inCue)} · at A ${fmtTime(bStart)}`} />
        <Num label="Length" value={`${p.bars} bar${p.bars > 1 ? "s" : ""}`} sub={`${p.seconds.toFixed(1)} s at ${p.targetBpm.toFixed(2)} BPM`} />
        <Num label="Tempo" value={`B ${p.inTempoPct >= 0 ? "+" : "−"}${Math.abs(p.inTempoPct).toFixed(1)}%`} sub={Math.abs(p.outTempoPct) > 0.05 ? `A ${p.outTempoPct >= 0 ? "+" : "−"}${Math.abs(p.outTempoPct).toFixed(1)}%` : `A unchanged (${ga.bpm.toFixed(2)})`} />
        {swapA !== null && <Num label="Exchange bass" value={`Bar ${p.swapAtBar}`} sub={`A ${fmtTime(swapA)}`} />}
        <Num label="Track A out by" value={fmtTime(p.outEnd)} sub={barLabel(ga, p.outEnd)} />
      </div>
      <Timeline p={p} a={a} b={b} />
      {p.warnings.length > 0 && (
        <ul className="tx-warnings">
          {p.warnings.map((w) => (
            <li key={w.text} className={w.level}>
              {w.level === "warn" ? "⚠" : "ℹ"} {w.text}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Why these points: {p.reasons.join(" · ")}.</p>
    </div>
  );
}

function Num({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tx-num">
      <small>{label}</small>
      <b>{value}</b>
      <span className="hint">{sub}</span>
    </div>
  );
}

/** Transition bars (lead-in to after the end) with both tracks' lanes, the key moments and known vocals. */
function Timeline({ p, a, b }: { p: TransitionPlan; a: TrackFacts; b: TrackFacts }) {
  const ga = a.grid!;
  const pre = 4;
  const span = Math.max(p.bars, 1) + pre + 4;
  const x = (barFromStart: number) => `${((barFromStart + pre) / span) * 100}%`;
  const bOffset = p.bStartsAtBar - p.outStartBar;
  const aEnd = (p.outEnd - p.outStart) / barLength(ga.bpm);
  const wallBar = barLength(p.targetBpm);
  const vocalBars = (f: TrackFacts, toBar: (t: number) => number) => (f.vocals ?? []).map(([s, e]) => [toBar(s), toBar(e)] as const).filter(([s, e]) => e > -pre && s < span - pre);
  const aBar = (t: number) => (t - p.outStart) / barLength(ga.bpm);
  const bBar = (t: number) => bOffset + (t - p.inCue) / (wallBar * p.inRate);
  return (
    <div className="tx-timeline" aria-label="Transition timeline">
      <div className="tx-ruler">
        {Array.from({ length: span + 1 }, (_, i) => i - pre).filter((n) => n % (span > 20 ? 4 : 1) === 0).map((n) => (
          <span key={n} style={{ left: x(n) }}>{n >= 0 ? n + 1 : n}</span>
        ))}
      </div>
      <div className="tx-lane a">
        <i>A</i>
        <div className="tx-bar a" style={{ left: x(-pre), width: `calc(${x(aEnd)} - ${x(-pre)})` }} />
        {vocalBars(a, aBar).map(([s, e], i) => <div key={i} className="tx-vocal" title="Track A vocal" style={{ left: x(Math.max(-pre, s)), width: `calc(${x(Math.min(span - pre, e))} - ${x(Math.max(-pre, s))})` }} />)}
      </div>
      <div className="tx-lane b">
        <i>B</i>
        <div className="tx-bar b" style={{ left: x(bOffset), width: `calc(${x(span - pre)} - ${x(bOffset)})` }} />
        {vocalBars(b, bBar).map(([s, e], i) => <div key={i} className="tx-vocal" title="Track B vocal" style={{ left: x(Math.max(-pre, s)), width: `calc(${x(Math.min(span - pre, e))} - ${x(Math.max(-pre, s))})` }} />)}
      </div>
      <Mark at={x(bOffset)} label={`▶ B starts ${fmtTime(timeAtBar(ga, p.bStartsAtBar))}`} cls="start" />
      {p.swapAtBar && <Mark at={x(p.swapAtBar - 1)} label={`⇅ Bass bar ${p.swapAtBar}`} cls="swap" />}
      <Mark at={x(aEnd)} label={`■ A out ${fmtTime(p.outEnd)}`} cls="end" />
      {(a.vocals || b.vocals) && <span className="tx-legend"><span className="tx-vocal-swatch" /> vocals</span>}
    </div>
  );
}

function Mark({ at, label, cls }: { at: string; label: string; cls: string }) {
  return (
    <div className={`tx-mark ${cls}`} style={{ left: at }}>
      <span>{label}</span>
    </div>
  );
}

// ─────────────────────────── rehearsal ───────────────────────────

function Rehearsal({ s, svc, onTryAnother }: { s: TransitionState; svc: TransitionService; onTryAnother: () => void }) {
  const r = s.rehearsal;
  const p = s.plan!;
  const live = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLOListElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  // Countdown from the audio clock (Track A's playback position), updated every frame.
  useAnimationFrame(() => {
    const c = svc.cue();
    const el = live.current;
    if (!el) return;
    if (!c || r.status !== "running") {
      el.textContent = "";
      if (current !== null) setCurrent(null);
      return;
    }
    const bar = c.transitionBar ? `Transition bar ${Math.min(c.transitionBar, p.bars)} of ${p.bars}` : `Lead-in: ${Math.ceil(-c.beat / 4)} bar${Math.ceil(-c.beat / 4) === 1 ? "" : "s"} to the transition`;
    const cd = c.countdown ? (c.countdown.totalBeats === 0 ? "NOW" : `${c.countdown.bars ? `${c.countdown.bars} bar${c.countdown.bars > 1 ? "s" : ""} ` : ""}${c.countdown.beats ? `${c.countdown.beats} beat${c.countdown.beats > 1 ? "s" : ""}` : ""}`.trim()) : c.done ? "Done — Track B is playing" : "";
    el.innerHTML = `<b>${cd}</b><span>${c.next ? `→ ${c.next.n}. ${c.next.text}` : c.done ? "Transition complete." : ""}</span><small>${bar}</small>`;
    const n = c.current?.n ?? null;
    if (n !== current) setCurrent(n);
  });
  return (
    <div className="tx-card tx-rehearse">
      <div className="tx-row">
        <h3>Instructions & rehearsal</h3>
        <span className="tx-spacer" />
        <label title="Track A starts this many bars before the transition">
          Start A{" "}
          <select value={r.leadBars} onChange={(e) => svc.setLeadBars(Number(e.target.value))}>
            {[2, 4, 8, 16].map((n) => <option key={n} value={n}>{n} bars before</option>)}
          </select>
        </label>
        {r.status === "off" || r.status === "error" || r.status === "blocked" ? (
          <button className="primary" onClick={() => void svc.rehearse()}>▶ Rehearse transition</button>
        ) : (
          <>
            <button onClick={() => void svc.replay()}>↻ Replay</button>
            <button onClick={() => void svc.reset()}>⟲ Reset</button>
            <button onClick={() => svc.stopRehearsal()}>■ Stop</button>
          </>
        )}
        <button onClick={onTryAnother}>Try another technique</button>
      </div>
      {r.status === "blocked" && (
        <p className="warn">
          ⚠ {r.message} <button className="tiny" onClick={() => void svc.stopDecksAndRehearse()}>Stop decks & rehearse</button>
        </p>
      )}
      {r.status === "error" && <p className="warn">⚠ {r.message}</p>}
      {(r.status === "preparing" || r.status === "ready") && <p className="hint">{r.message}</p>}
      {r.status === "running" && (
        <p className="hint">
          Track A on deck {String.fromCharCode(65 + r.outDeck)}, Track B on deck {String.fromCharCode(65 + r.inDeck)} (cued at {fmtTime(p.inCue)}; CUE returns there). Perform the steps yourself on the decks, mixer or controller.
        </p>
      )}
      <div className="tx-live" ref={live} aria-live="polite" />
      {r.startError && (
        <p className={Math.abs(r.startError.ms) <= 40 ? "tx-good" : "warn"}>
          {Math.abs(r.startError.ms) <= 40 ? "✓" : "⚠"} You started Track B {Math.abs(r.startError.ms)} ms {r.startError.ms >= 0 ? "late" : "early"} ({Math.abs(r.startError.beats).toFixed(2)} beat). {Math.abs(r.startError.ms) <= 40 ? "On the beat." : r.startError.ms > 0 ? "Press PLAY a touch earlier." : "Wait for the downbeat."}
        </p>
      )}
      <ol className="tx-steps" ref={stepsRef}>
        {p.steps.map((st) => (
          <li key={st.n} className={`${st.kind} ${current === st.n ? "now" : ""}`}>
            <span className="tx-when">{st.atBeat === null ? "Before" : st.atBeat < 0 ? `Bar ${Math.floor(st.atBeat / 4)}.${(((st.atBeat % 4) + 4) % 4) + 1}` : `Bar ${Math.floor(st.atBeat / 4) + 1}${st.atBeat % 4 ? `.${(st.atBeat % 4) + 1}` : ""}`}</span>
            <span>{st.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

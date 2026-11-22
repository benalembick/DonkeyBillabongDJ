/**
 * Beat grid editor: a non-modal popover on a deck (opened by clicking the deck's BPM readout, or from any
 * "Fix grid…" link). It stays open while you play, scrub and drag the waveform, because a grid can only
 * be judged by watching the beat lines against the kicks. Every edit goes through BeatGridService and is
 * saved as "set by hand".
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deckLetter } from "../core/actions";
import { barSeconds, gridStatus, tapTempo, TAP_RESET_MS, type GridStatus } from "../preparation/beatGrid";
import type { GridResult } from "../preparation/BeatGridService";
import { useApp, useEngineState } from "./context";
import { closeGridEditor } from "./gridEditorStore";

const SNAP_KEY = "dbdj.gridEditor.snap";
const readSnap = () => { try { return localStorage.getItem(SNAP_KEY) !== "0"; } catch { return true; } };
const STATUS_TEXT: Record<GridStatus, string> = { none: "No beat grid", manual: "Set by hand", analysed: "Analysed", unreliable: "Unreliable" };
const WIDTH = 384;
/** Typing in a text field (the BPM box): T is a letter there, not a tap. */
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "range", "button"].includes((t as HTMLInputElement).type)));

export function BeatGridEditor({ deck, anchor }: { deck: number; anchor: HTMLElement | null }) {
  const app = useApp(), { engine, beatGrid: svc } = app;
  const d = useEngineState().decks[deck];
  const trackId = d?.track?.trackId ?? null;
  const grid = d?.beatGrid ?? null;
  const status = gridStatus(grid);
  const [, bump] = useState(0);
  useEffect(() => svc.on("change", () => bump((x) => x + 1)), [svc]);
  const [bpmText, setBpmText] = useState(grid ? grid.bpm.toFixed(2) : "");
  useEffect(() => { setBpmText(grid ? grid.bpm.toFixed(2) : ""); }, [grid?.bpm, trackId]);
  const [taps, setTaps] = useState<number[]>([]);
  /** The last tap came more than TAP_RESET_MS after the one before, so the count started again. */
  const [tapRestarted, setTapRestarted] = useState(false);
  const tapped = tapTempo(taps);
  const [snap, setSnap] = useState(readSnap);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setTaps([]); setTapRestarted(false); setNote(null); }, [trackId]);

  // Fixed position under the BPM readout (portal: never clipped by the deck). It stays BELOW the readout and
  // scrolls inside when tall, so it never covers the scrolling waveforms you're checking the grid against;
  // it only flips above when there's almost no room below.
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 80, left: 8, maxHeight: 600 });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, r.right - WIDTH));
      const below = r.bottom + 6, room = window.innerHeight - below - 8;
      const next = room >= 260 ? { top: below, left, maxHeight: room } : { top: 8, left, maxHeight: Math.max(200, r.top - 14) };
      setPos((p) => (p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeGridEditor(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const playhead = () => engine.getPosition(deck);
  const show = (r: GridResult, ok: string) => setNote(r.ok ? { ok: true, text: ok } : { ok: false, text: r.reason });
  const act = (fn: (id: string) => GridResult, ok: string) => () => { if (trackId) show(fn(trackId), ok); };
  const actAsync = (fn: (id: string) => Promise<GridResult>, ok: string) => () => { if (trackId) void fn(trackId).then((r) => show(r, ok)); };
  const applyBpm = (bpm: number) => { if (trackId) show(svc.setBpm(trackId, bpm, playhead()), `BPM set to ${bpm.toFixed(2)} — the bar under the playhead stayed in place`); };
  const lastTap = useRef(0);
  // `at` is the input event's own timestamp (when the button was pressed), so a busy moment in the app
  // can't bunch taps together; taps count on press, like a hardware TAP button.
  const tap = (at: number) => {
    const now = at > 0 ? at : performance.now(), restart = taps.length > 0 && now - lastTap.current > TAP_RESET_MS;
    lastTap.current = now;
    setTapRestarted(restart);
    setTaps((t) => (restart ? [now] : [...t, now].slice(-17)));
  };
  const clearTaps = () => { setTaps([]); setTapRestarted(false); };
  // Keyboard tapping: T anywhere while the editor is open, or Space / Enter while TAP has focus. Space is
  // also the global Deck A play/pause shortcut, so these are caught first (capture phase) and kept from the
  // shortcuts. Otherwise tapping Space after clicking TAP would count nothing and start or stop Deck A, the
  // deck that may be playing out.
  const tapBtn = useRef<HTMLButtonElement>(null);
  const tapRef = useRef(tap);
  tapRef.current = tap;
  useEffect(() => {
    const onTapBtn = (e: KeyboardEvent) => e.target === tapBtn.current && (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter");
    const tKey = (e: KeyboardEvent) => e.code === "KeyT" && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(e.target);
    const down = (e: KeyboardEvent) => {
      if (!onTapBtn(e) && !tKey(e)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat && tapBtn.current) tapRef.current(e.timeStamp);
    };
    // The button's own Space click fires on key up: stop it so a tap isn't counted twice.
    const up = (e: KeyboardEvent) => { if (onTapBtn(e) || tKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener("keydown", down, true); window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, []);
  const toggleSnap = (v: boolean) => { setSnap(v); try { localStorage.setItem(SNAP_KEY, v ? "1" : "0"); } catch { /* storage unavailable */ } };

  const L = deckLetter(deck);
  const ready = d?.status === "ready" && !!trackId;
  const hasGrid = ready && !!grid;
  const phraseBar = grid && grid.phraseAnchor !== undefined && grid.phraseAnchor !== null ? Math.round((grid.phraseAnchor - grid.firstBeat) / barSeconds(grid.bpm)) + 1 : null;

  return createPortal(
    <div ref={box} className={`grid-editor deck-scope-${L.toLowerCase()}`} role="dialog" aria-label={`Beat grid, deck ${L}`} style={{ top: pos.top, left: pos.left, width: WIDTH, maxHeight: pos.maxHeight }}>
      <header className="ge-head">
        <div><b>BEAT GRID · DECK {L}</b><small>{d?.track?.title ?? "No track loaded"}</small></div>
        <button className="ge-close" onClick={closeGridEditor} aria-label="Close the beat grid editor" title="Close (Esc)">✕</button>
      </header>
      {!ready ? <p className="ge-empty">{d?.status === "loading" ? "Loading the track…" : d?.track ? "Preparing the track…" : "Load a track on this deck to edit its beat grid."}</p> : <>
        <div className={`ge-status ${status}`}>
          <span className="ge-badge">{status === "unreliable" ? "⚠" : status === "none" ? "✕" : "✓"} {STATUS_TEXT[status]}</span>
          <small>{grid ? `${grid.bpm.toFixed(2)} BPM · ${status === "manual" ? "kept when the track is re-analysed" : `confidence ${grid.confidence.toFixed(1)} (${grid.source}) — 1.4 or more is trusted`}` : "Type or tap the BPM to create one"}</small>
        </div>
        <details className="ge-help" open={status === "unreliable" || status === "none"}>
          <summary>How to check and fix the grid</summary>
          <ol>
            <li>Play the track and watch the white lines on Deck {L}'s waveform. Every line should sit on a kick or snare; the brighter ones are bar starts.</li>
            <li>Lines <b>drift</b> away from the beat over time → the BPM is wrong. Tap along or type it; if it's twice or half as fast, use ×2 / ÷2.</li>
            <li>Lines evenly spaced but <b>off</b> the beat → stop on a kick at the start of a bar and press <b>Set downbeat here</b>, drag the waveform to slide the grid, or try <b>Auto-align</b>.</li>
            <li>Fine-tune with the nudges, then press <b>Grid looks right ✓</b>. Auto DJ and Transition Lab use it straight away.</li>
            <li>Still drifting with the right BPM? The tempo changes during the track (often live drums) — no single grid fits; use short or unsynced transitions.</li>
          </ol>
        </details>

        <div className="ge-row">
          <label className="ge-bpm">BPM <input type="number" step="0.01" min={40} max={300} value={bpmText} onChange={(e) => setBpmText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") applyBpm(Number(bpmText)); }} aria-label="Beats per minute" /></label>
          <button onClick={() => applyBpm(Number(bpmText))} disabled={!(Number(bpmText) > 0) || (!!grid && Math.abs(Number(bpmText) - grid.bpm) < 0.0005)} title="Use this BPM (the bar under the playhead stays put)">Set</button>
          <button onClick={act((id) => svc.double(id, playhead()), "Doubled the BPM")} disabled={!hasGrid} title="Detected at half speed? Double it">×2</button>
          <button onClick={act((id) => svc.halve(id, playhead()), "Halved the BPM")} disabled={!hasGrid} title="Detected at double speed? Halve it">÷2</button>
          <button onClick={act((id) => svc.nudge(id, { bpm: -0.01 }), "BPM −0.01")} disabled={!hasGrid} title="BPM −0.01">−.01</button>
          <button onClick={act((id) => svc.nudge(id, { bpm: 0.01 }), "BPM +0.01")} disabled={!hasGrid} title="BPM +0.01">+.01</button>
        </div>

        <div className="ge-row ge-tap">
          <button ref={tapBtn} className="ge-tap-btn" onPointerDown={(e) => { if (e.button === 0) tap(e.timeStamp); }} onClick={(e) => { if (e.detail === 0) tap(e.timeStamp); /* assistive-technology click; Space/Enter are handled above */ }} title="Click, or press T, on every beat while the track plays (Space also works while TAP is selected). 4 taps give a BPM; more taps refine it. A gap of over 2 seconds starts again.">TAP</button>
          <span className={`hint${tapRestarted && taps.length === 1 ? " ge-tap-restart" : ""}`}>{
            taps.length === 0 ? "Click TAP or press T on every beat (each kick) while it plays — 4 taps or more"
            : tapped ? `${taps.length} taps → ${tapped.toFixed(2)} BPM · keep tapping to refine`
            : tapRestarted && taps.length === 1 ? "Started again — over 2 s since your last tap. Tap every beat, not every bar."
            : taps.length >= 4 ? `${taps.length} taps, but too uneven for a BPM — keep tapping steadily on every beat`
            : `${taps.length} of 4 taps — keep tapping on every beat`}</span>
          {tapped !== null && <button className="primary" onClick={() => { applyBpm(tapped); clearTaps(); }}>Use {tapped.toFixed(2)}</button>}
          {taps.length > 0 && <button onClick={clearTaps} title="Clear the taps">↺</button>}
        </div>

        <div className="ge-row">
          <button className="ge-strong" disabled={!hasGrid} onClick={actAsync((id) => svc.setDownbeat(id, playhead(), snap), "The beat at the playhead is now bar 1")} title="Make the beat at the playhead the start of a bar">Set downbeat here</button>
          <label className="ge-check" title="Move to the nearest kick or snare onset (within 70 ms)"><input type="checkbox" checked={snap} onChange={(e) => toggleSnap(e.target.checked)} /> snap to kick</label>
          <button disabled={!hasGrid} onClick={actAsync((id) => svc.alignToBeats(id), "Grid moved onto the detected beats (BPM unchanged)")} title="Keep the BPM; move the grid onto where the kicks and snares fall across the track">Auto-align</button>
        </div>
        <div className="ge-row ge-nudges">
          <button disabled={!hasGrid} onClick={act((id) => svc.nudge(id, { beats: -1 }), "Bar 1 moved one beat earlier")} title="Bar 1 one beat earlier">◀ beat</button>
          <button disabled={!hasGrid} onClick={act((id) => svc.nudge(id, { beats: 1 }), "Bar 1 moved one beat later")} title="Bar 1 one beat later">beat ▶</button>
          <button disabled={!hasGrid} onClick={act((id) => svc.nudge(id, { ms: -10 }), "Grid 10 ms earlier")}>−10 ms</button>
          <button disabled={!hasGrid} onClick={act((id) => svc.nudge(id, { ms: 10 }), "Grid 10 ms later")}>+10 ms</button>
        </div>

        <div className="ge-row">
          <span className="ge-label">Phrase start</span>
          <span className="hint">{phraseBar !== null ? `bar ${phraseBar} (8-bar phrases)` : "not set"}</span>
          <button disabled={!hasGrid} onClick={act((id) => svc.setPhraseStart(id, playhead()), "Phrase start set at the bar under the playhead")} title="The bar under the playhead starts an 8-bar phrase (Transition Lab snaps to phrases from here)">Set here</button>
          {phraseBar !== null && <button onClick={act((id) => svc.setPhraseStart(id, null), "Phrase start cleared")}>Clear</button>}
        </div>
        <p className="hint ge-drag">While this panel is open, <b>drag Deck {L}'s waveform</b> to slide the grid (instead of scratching).</p>

        <footer className="ge-foot">
          <button className="primary" disabled={!hasGrid} onClick={act((id) => svc.confirm(id), "Saved as set by hand — Auto DJ and Transition Lab will beat-match this track")} title="Trust this grid as it is (saved as set by hand)">Grid looks right ✓</button>
          <button disabled={!trackId || !svc.canUndo(trackId)} onClick={act((id) => svc.undo(id), "Undone")}>Undo</button>
          <button disabled={!hasGrid} onClick={actAsync((id) => svc.resetToAnalysed(id), "Back to the analysed grid")} title="Restore the detected grid (nothing else about the track changes)">Reset to analysed</button>
        </footer>
        {note && <p className={`ge-note ${note.ok ? "ok" : "warn"}`} role="status">{note.ok ? "✓" : "⚠"} {note.text}</p>}
      </>}
    </div>,
    document.body,
  );
}

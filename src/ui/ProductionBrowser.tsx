/**
 * Production Browser: categories (PROJECT, SAMPLES, LOOPS, DRUMS, INSTRUMENTS, PRESETS, RECORDINGS, STEMS,
 * MASHUPS, DJ LIBRARY) each show one searchable list; with no category selected the Sampler samples and the
 * DJ library share the panel with a draggable divider. Audio items drag onto the timeline, ＋ adds them at the
 * playhead and ▶ previews them.
 */
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { TrackInfo } from "../core/engine/types";
import { SYNTH_PRESETS } from "../production/presets";
import { isRecordingRef } from "../production/recordings";
import { padLabel, type ProductionProject, type SamplerSample } from "../production/types";
import { useApp, useLibraryState } from "./context";
import { PATTERN_MIME, SAMPLE_MIME, TRACK_MIME } from "./productionDnd";
import { AddTrackButtons } from "./TrackIcons";

type Category = "all" | "project" | "samples" | "loops" | "drums" | "instruments" | "presets" | "recordings" | "stems" | "mashups" | "library";
const CATEGORIES: [Category, string, string][] = [
  ["project", "PROJECT", "Audio already used in this project"], ["samples", "SAMPLES", "Sampler pads, saved samples and the recorded pattern"],
  ["loops", "LOOPS", "Anything named “loop”, and short files with a tempo, in your library"], ["drums", "DRUMS", "Drum hits and drum loops in your library, plus the built-in kit"],
  ["instruments", "INSTRUMENTS", "Add a drum kit, synth or Sampler track"], ["presets", "PRESETS", "Synth sounds — apply to the selected synth track or start a new one"],
  ["recordings", "RECORDINGS", "Microphone takes from this project"], ["stems", "STEMS", "Stems separated in this project"],
  ["mashups", "MASHUPS", "Rendered mashups and saved mashup recipes"], ["library", "DJ LIBRARY", "Your local DJ library"],
];
const DRUM_WORDS = /\b(kick|snare|hat|hihat|hi-hat|clap|perc|percussion|drum|drums|tom|cymbal|ride|crash|shaker|rim|808|909|break|breakbeat)\b|drum|hihat|_kick|_snare|_hat|_clap/i;
const LOOP_WORDS = /loop/i;
const STORE = { category: "dbdj.ui.psBrowser.category", split: "dbdj.ui.psBrowser.split" };
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };
const fileName = (ref: string) => ref.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? ref;
const seconds = (ms?: number) => ms ? (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`) : "";

interface AudioItem { ref: string; title: string; subtitle: string; meta?: string }

/** Sampler pads first, then saved samples. */
function sampleList(sampler: ProductionProject["sampler"]): { key: string; label: string; sample: SamplerSample }[] {
  return [...sampler.pads.flatMap((pad) => pad.sample ? [{ key: `pad-${pad.index}`, label: `Pad ${padLabel(pad.index)}`, sample: pad.sample }] : []), ...sampler.savedSamples.map((sample) => ({ key: sample.id, label: "Saved", sample }))];
}

/** Audio sources referenced anywhere in the project (clips, pads, saved samples, editor), with a display name. */
function projectSources(project: ProductionProject): Map<string, string> {
  const out = new Map<string, string>(); const add = (ref: string, name: string) => { if (!out.has(ref)) out.set(ref, name); };
  for (const track of project.tracks) for (const clip of track.clips) if (clip.type === "audio") add(clip.ref, clip.name);
  const sampler = project.sampler; for (const sample of [sampler.editor, ...sampler.pads.map((p) => p.sample), ...sampler.savedSamples, sampler.chromatic.sample]) if (sample) add(sample.sourceRef, sample.name);
  return out;
}

export function ProductionBrowser({ onError, onOpenSampler }: { onError(message: string): void; onOpenSampler(): void }) {
  const app = useApp(); const studio = app.production; const state = useSyncExternalStore(studio.subscribe, studio.getState, studio.getState); const libraryState = useLibraryState();
  const [category, setCategory] = useState<Category>(() => (CATEGORIES.some(([c]) => c === read(STORE.category)) ? read(STORE.category) as Category : "all"));
  const [query, setQuery] = useState(""); const [split, setSplit] = useState(() => Number(read(STORE.split)) || 200); const bodyRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase(); const matches = (...text: (string | null | undefined)[]) => !q || text.join(" ").toLowerCase().includes(q);
  const choose = (next: Category) => { const value = next === category ? "all" : next; setCategory(value); write(STORE.category, value); };
  const fail = (x: unknown) => onError(x instanceof Error ? x.message : String(x)); const run = (work: () => unknown) => { try { const r = work(); if (r instanceof Promise) r.catch(fail); } catch (x) { fail(x); } };

  const library = useMemo(() => libraryState.tracks.filter((t) => t.source === "local"), [libraryState.tracks]);
  const project = state.project; const sampler = project.sampler;
  const lists = useMemo(() => {
    const byRef = new Map(library.map((t) => [t.ref, t])); const sources = projectSources(project); const track = (t: TrackInfo): AudioItem => ({ ref: t.ref, title: t.title || fileName(t.ref), subtitle: t.artist || fileName(t.ref), meta: [t.bpm ? `${Math.round(t.bpm)} BPM` : "", t.key ?? "", seconds(t.durationMs)].filter(Boolean).join(" · ") });
    const kind = (ref: string) => isRecordingRef(ref) ? "Recording" : ref.startsWith("production-stem://") ? "Stem" : "File";
    const mashupPlaylist = app.playlists.getState().playlists.find((p) => p.name === "Mashups");
    return {
      project: [...sources].filter(([ref]) => !ref.startsWith("production-stem://")).map(([ref, name]): AudioItem => ({ ref, title: byRef.get(ref)?.title || name, subtitle: kind(ref), meta: byRef.get(ref)?.bpm ? `${Math.round(byRef.get(ref)!.bpm!)} BPM` : undefined })),
      recordings: [...sources].filter(([ref]) => isRecordingRef(ref)).map(([ref, name]): AudioItem => ({ ref, title: name, subtitle: ref.startsWith("production-sampler") ? "Sampler mic take" : "Arrangement take" })),
      stems: [...sources].filter(([ref]) => ref.startsWith("production-stem://")).map(([ref, name]): AudioItem => ({ ref, title: name, subtitle: `${ref.slice(ref.lastIndexOf("#") + 1).toUpperCase()} stem` })),
      // Loops: named "loop", or short (1–32 s) files that have a tempo (one-shots usually have none).
      loops: library.filter((t) => LOOP_WORDS.test(`${t.title} ${t.ref}`) || (!!t.bpm && !!t.durationMs && t.durationMs >= 1000 && t.durationMs <= 32_000)).map(track),
      drums: library.filter((t) => DRUM_WORDS.test(`${t.title} ${fileName(t.ref)}`)).map(track),
      mashups: (mashupPlaylist?.refs ?? []).map((ref) => byRef.get(ref)).filter((t): t is TrackInfo => !!t).map(track),
      library: library.map(track),
    };
  }, [library, project, app.playlists]);
  const recipes = app.liveMashup.getState().recipes;
  const samples = useMemo(() => sampleList(sampler), [sampler]);
  const selectedTrack = project.tracks.find((t) => t.clips.some((c) => c.id === state.selectedClipId)); const synthTarget = selectedTrack?.instrument?.type === "synth" ? selectedTrack : null;

  const audioRow = (item: AudioItem) => matches(item.title, item.subtitle, item.meta) && <div key={item.ref} className={`ps-browser-item${state.previewRef === item.ref ? " previewing" : ""}`} draggable title="Drag onto an audio track · ＋ adds at the playhead · ▶ previews" onDragStart={(e) => e.dataTransfer.setData(TRACK_MIME, JSON.stringify({ ref: item.ref, title: item.title }))}>
    <b>{item.title}</b><span>{item.subtitle}</span>{item.meta && <small>{item.meta}</small>}
    <div className="ps-item-actions"><button aria-label={`${state.previewRef === item.ref ? "Stop preview of" : "Preview"} ${item.title}`} onClick={() => run(() => studio.previewSource(item.ref))}>{state.previewRef === item.ref ? "■" : "▶"}</button><button aria-label={`Add ${item.title} at the playhead`} onClick={() => run(() => studio.addAudioAtPlayhead(item))}>＋</button></div>
  </div>;
  const patternRow = () => sampler.pattern && matches("pattern", sampler.pattern.mode) && <div className="ps-browser-item ps-sample-item ps-pattern-item" draggable title="Drag onto the timeline, or press ＋ to add it at the playhead on a Sampler track" onDragStart={(e) => e.dataTransfer.setData(PATTERN_MIME, "pattern")}><b>{sampler.pattern.mode === "chromatic" ? "Chromatic Pattern" : "Sampler Pattern"}</b><span>{sampler.pattern.notes.length} notes · {sampler.pattern.bars} bar{sampler.pattern.bars === 1 ? "" : "s"} · {sampler.quantize.grid === "off" ? "unquantized" : `Q ${sampler.quantize.grid}`}</span><div className="ps-item-actions"><button aria-label="Add the pattern at the playhead" onClick={() => run(() => studio.patternToArrangement())}>＋</button></div></div>;
  const sampleRows = () => samples.filter(({ sample, label }) => matches(sample.name, label)).map(({ key, label, sample }) => <div key={key} className="ps-browser-item ps-sample-item" draggable title="Drag onto an audio track, or press ＋ to drop it at the playhead" onDragStart={(e) => e.dataTransfer.setData(SAMPLE_MIME, JSON.stringify(sample))}><b>{sample.name}</b><span>{label} · {(sample.end - sample.start).toFixed(2)}s{sample.edits.reverse ? " · REV" : ""}</span><div className="ps-item-actions"><button aria-label={`Add ${sample.name} at the playhead`} onClick={() => run(() => studio.addSampleToArrangement(sample))}>＋</button></div></div>);
  const list = (items: ReactNode[], empty: ReactNode) => { const shown = items.filter(Boolean); return shown.length ? shown : <p className="ps-browser-empty">{q ? `Nothing matches “${query}”.` : empty}</p>; };

  const content = (): ReactNode => {
    switch (category) {
      case "project": return list(lists.project.map(audioRow), "Audio you add to the arrangement or the Sampler shows here.");
      case "samples": return <>{patternRow()}{list(sampleRows(), <>Assign or save samples in the <a onClick={onOpenSampler}>Sampler</a>, or right-click a clip → Save as sample.</>)}</>;
      case "loops": return list(lists.loops.map(audioRow), "No loops found. Files with “loop” in the name, or short (up to 32 s) files with a detected BPM, from your DJ library show here.");
      case "drums": return <>{matches("drum kit built-in") && <div className="ps-browser-item ps-instrument-item"><b>Built-in Drum Kit</b><span>Six voices · 16-step sequencer</span><div className="ps-item-actions"><button aria-label="Add a drum kit track" onClick={() => run(() => studio.addInstrumentTrack("drums"))}>＋</button></div></div>}{list(lists.drums.map(audioRow), "No drum files found. Files named kick, snare, hat, clap, perc, 808… in your DJ library show here.")}</>;
      case "instruments": return list([
        ["Drum Kit", "Six-voice kit with a 16-step sequencer", () => studio.addInstrumentTrack("drums")],
        ["Synth", "Subtractive synth with piano roll", () => studio.addInstrumentTrack("synth")],
        ["Sampler · Slices", "Pads and slices played by MIDI notes", () => studio.addInstrumentTrack("sampler", { samplerMode: "slices" })],
        ["Sampler · Chromatic", `One sample across the keyboard${sampler.chromatic.sample ? ` (${sampler.chromatic.sample.name})` : ""}`, () => studio.addInstrumentTrack("sampler", { samplerMode: "chromatic" })],
      ].filter(([name, text]) => matches(name as string, text as string)).map(([name, text, add]) => <div key={name as string} className="ps-browser-item ps-instrument-item"><b>{name as string}</b><span>{text as string}</span><div className="ps-item-actions"><button aria-label={`Add a ${name} track`} onClick={() => run(add as () => unknown)}>＋</button></div></div>), "");
      case "presets": return <><p className="ps-browser-note">{synthTarget ? <>Click a preset to apply it to <b>{synthTarget.name}</b>, or ＋ to start a new synth track.</> : "Select a clip on a synth track to apply presets to it; ＋ starts a new synth track with the preset."}</p>{list(SYNTH_PRESETS.filter((p) => matches(p.name, p.description)).map((preset) => <div key={preset.name} className={`ps-browser-item ps-instrument-item${synthTarget ? " clickable" : ""}`} onClick={() => synthTarget && run(() => studio.applySynthPreset(synthTarget.id, preset.synth, preset.name))}><b>{preset.name}</b><span>{preset.description} · {preset.synth.oscillator}</span><div className="ps-item-actions"><button aria-label={`New synth track with ${preset.name}`} onClick={(e) => { e.stopPropagation(); run(() => studio.addInstrumentTrack("synth", { synth: preset.synth, name: preset.name })); }}>＋</button></div></div>), "")}</>;
      case "recordings": return list(lists.recordings.map(audioRow), "Record with ● AUDIO (arm an audio track) or ● RECORD MIC in the Sampler.");
      case "stems": return list(lists.stems.map(audioRow), "Select an audio clip and use STEMS → Separate into tracks (CLIP panel or right-click).");
      case "mashups": return <>{list(lists.mashups.map(audioRow), "Rendered mashups (Mashup Projects → Render) show here.")}{recipes.length > 0 && <h4>MASHUP RECIPES</h4>}{recipes.filter((r) => matches(r.name)).map((recipe) => { const a = app.library.getByRef(recipe.aRef), b = app.library.getByRef(recipe.bRef); return <div key={recipe.id} className="ps-browser-item ps-instrument-item"><b>{recipe.name}</b><span>{a?.title ?? fileName(recipe.aRef)} × {b?.title ?? fileName(recipe.bRef)}</span><div className="ps-item-actions"><button title="Add both source tracks at the playhead on two new tracks" aria-label={`Add the sources of ${recipe.name}`} onClick={() => run(async () => { await studio.addAudioAtPlayhead({ ref: recipe.aRef, title: a?.title ?? fileName(recipe.aRef) }, { newTrack: true }); await studio.addAudioAtPlayhead({ ref: recipe.bRef, title: b?.title ?? fileName(recipe.bRef) }, { newTrack: true }); })}>＋</button></div></div>; })}</>;
      case "library": return list(lists.library.map(audioRow), "Add music to the DJ library to use it here.");
      case "all": return null;
    }
  };

  // Divider between SAMPLES and DJ LIBRARY (overview), height remembered.
  const dragSplit = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current; if (!body) return; e.preventDefault(); const target = e.currentTarget; target.setPointerCapture(e.pointerId); const y0 = e.clientY, h0 = split; let last = split;
    const move = (ev: PointerEvent) => { last = Math.max(60, Math.min(body.clientHeight - 90, h0 + ev.clientY - y0)); setSplit(last); };
    const up = () => { target.removeEventListener("pointermove", move); write(STORE.split, String(Math.round(last))); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", up, { once: true });
  };
  const active = CATEGORIES.find(([c]) => c === category);

  return <aside className="ps-browser">
    <h3>PRODUCTION BROWSER</h3>
    <AddTrackButtons className="ps-create" onError={onError}/>
    <input placeholder={active ? `Search ${active[1].toLowerCase()}…` : "Search samples and library…"} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the browser" />
    <nav aria-label="Browser categories">{CATEGORIES.map(([id, label, hint]) => <button key={id} className={category === id ? "active" : ""} aria-pressed={category === id} title={`${hint}${category === id ? " · click again for the overview" : ""}`} onClick={() => choose(id)}>{label}</button>)}</nav>
    <div className="ps-browser-body" ref={bodyRef}>
      {category === "all" ? <>
        <div className="ps-browser-section" style={{ height: split }}>
          {sampler.pattern && <h4>SAMPLER PATTERN</h4>}{patternRow()}
          <h4>SAMPLES</h4><div className="ps-browser-list">{list(sampleRows(), "Assign or save samples in the Sampler to use them here.")}</div>
        </div>
        <div className="ps-browser-divider" role="separator" aria-orientation="horizontal" aria-label="Resize samples and library" title="Drag to resize" onPointerDown={dragSplit} onDoubleClick={() => { setSplit(200); write(STORE.split, "200"); }}/>
        <div className="ps-browser-section grow"><h4>DJ LIBRARY</h4><div className="ps-browser-list">{list(lists.library.map(audioRow), "Add music to the DJ library to use it here.")}</div></div>
      </> : <div className="ps-browser-section grow"><h4>{active?.[1]}<small>{active?.[2]}</small></h4><div className="ps-browser-list">{content()}</div></div>}
    </div>
  </aside>;
}

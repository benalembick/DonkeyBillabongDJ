import { useCallback, useEffect, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { PlaylistStore } from "../library/PlaylistStore";
import type { AutoDJSettings } from "../autodj/transition";
import { useApp, useEngineState, useLibraryState } from "./context";
import { useFrameStore } from "./hooks";
import { ArtTile } from "./ArtTile";

export const TRACK_REFS = "application/x-dbdj-track-refs";
const PLAYLIST_MOVE = "application/x-dbdj-playlist-move";
const QUEUE_MOVE = "application/x-dbdj-queue-move";
export function duration(ms = 0): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function draggedRefs(data: DataTransfer): string[] {
  try {
    const refs: unknown = JSON.parse(data.getData(TRACK_REFS) || "null");
    if (Array.isArray(refs)) return refs.filter((r): r is string => typeof r === "string");
    const track = JSON.parse(data.getData("application/x-dbdj-track") || "null") as TrackInfo | null;
    return track?.ref ? [track.ref] : [];
  } catch { return []; }
}
export function usePlaylists() {
  const { playlists } = useApp();
  return useFrameStore(useCallback((cb) => playlists.on("change", cb), [playlists]), () => playlists.getState());
}
export function useAutoDJ() {
  const { autoDJ } = useApp();
  return useFrameStore(useCallback((cb) => autoDJ.on("change", cb), [autoDJ]), () => autoDJ.getState());
}

export function PlaylistNav({ selected, onOpen, onQueue }: { selected: string | null; onOpen: (id: string) => void; onQueue: () => void }) {
  const app = useApp();
  const state = usePlaylists();
  const auto = useAutoDJ();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return <>
    <div className="browser-heading">PLAYLISTS</div>
    <button disabled={!state.loaded} onClick={() => setCreating(true)}>+ Create New Playlist</button>
    {creating && <form className="playlist-create" onSubmit={(e) => { e.preventDefault(); const p = app.playlists.create(name); setCreating(false); setName(""); onOpen(p.id); }}>
      <input autoFocus aria-label="Playlist name" placeholder="Playlist name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit">Create</button><button type="button" onClick={() => setCreating(false)}>Cancel</button>
    </form>}
    {state.playlists.map((p) => <button data-source="playlist" key={p.id} className={selected === p.id ? "active" : ""} title="Drop library tracks or local files here" onClick={() => onOpen(p.id)}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        const refs = draggedRefs(e.dataTransfer).filter((r) => !!app.library.getByRef(r));
        app.playlists.addTracks(p.id, refs);
        const files = [...e.dataTransfer.files];
        if (files.length) void app.platform.refsFromDrop(files).then(async (rows) => { await app.addFiles(rows); app.playlists.addTracks(p.id, rows.map((r) => r.ref)); }).catch((err) => app.log.warn("library", String(err)));
      }}>{p.name}<span className="count">{p.refs.length}</span></button>)}
    <button data-source="auto-dj" onClick={onQueue}>Auto DJ Queue <span className={`auto-status ${auto.status.toLowerCase()}`}>{auto.status}</span></button>
  </>;
}

export function PlaylistActions({ refs, onDone }: { refs: string[]; onDone?: () => void }) {
  const { playlists, autoDJ } = useApp();
  const state = usePlaylists();
  const auto = useAutoDJ();
  return <>
    <select aria-label="Add to Playlist" value="" disabled={!refs.length || !state.loaded} onChange={(e) => {
      if (e.target.value === "__new") playlists.create("New Playlist", refs);
      else playlists.addTracks(e.target.value, refs);
      onDone?.();
    }}>
      <option value="" disabled>Add to Playlist…</option>
      <option value="__new">Create New Playlist</option>
      {state.playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    {auto.playlistId && <button disabled={!refs.length} onClick={() => { autoDJ.add(refs); onDone?.(); }}>Add to Auto DJ Queue</button>}
  </>;
}

function AutoSettings() {
  const { autoDJ } = useApp();
  const { settings } = useAutoDJ();
  return <details className="auto-settings"><summary>Auto DJ settings · {settings.style} · {settings.bars} bars</summary>
    <div className="toolbar">
      <label>Transition style <select value={settings.style} onChange={(e) => autoDJ.configure({ style: e.target.value as AutoDJSettings["style"] })}>
        <option value="smart">Smart</option><option value="beat-mix">Beat Mix</option><option value="crossfade">Crossfade</option><option value="quick-fade">Quick Fade</option>
      </select></label>
      <label>Transition length <select value={settings.bars} onChange={(e) => autoDJ.configure({ bars: e.target.value === "auto" ? "auto" : Number(e.target.value) as AutoDJSettings["bars"] })}>
        <option value="auto">Auto</option>{[4, 8, 16, 32].map((n) => <option key={n} value={n}>{n} bars</option>)}
      </select></label>
      {([['shuffle', 'Shuffle'], ['repeat', 'Repeat Playlist'], ['bpmSync', 'BPM Sync'], ['keyAware', 'Key-aware ordering']] as const).map(([key, label]) =>
        <label key={key}><input type="checkbox" checked={settings[key]} onChange={(e) => autoDJ.configure({ [key]: e.target.checked })} />{label}</label>)}
    </div><p className="hint">Shuffle and key-aware ordering apply when starting a set or repeating it. Beat Mix falls back to a fade when grids or tempos are unsuitable.</p>
  </details>;
}

export function AutoDJControls({ onQueue }: { onQueue?: () => void }) {
  const { autoDJ } = useApp();
  const s = useAutoDJ();
  return <div className="auto-controls">
    <b className={`auto-status ${s.status.toLowerCase()}`}>AUTO DJ — {s.status}</b>
    {s.status !== "OFF" && <>
      {s.status === "PAUSED" ? <button onClick={() => autoDJ.resume()}>RESUME AUTO DJ</button> : <button onClick={() => autoDJ.pause()}>PAUSE AUTO DJ</button>}
      <button onClick={() => autoDJ.stop()}>STOP AUTO DJ</button>
      <button disabled={s.status !== "ACTIVE" || s.preparing || !s.upcoming.length} onClick={() => autoDJ.skip()}>Skip to next</button>
    </>}
    {onQueue && s.playlistId && <button onClick={onQueue}>View queue</button>}
    {s.nextSeconds !== null && s.status === "ACTIVE" && <span>Next transition in {duration(s.nextSeconds * 1000)}</span>}
    <span className="hint" role="status">{s.preparing ? "Loading / preparing…" : s.message}</span>
  </div>;
}

export function TrackDetails({ track, onClose }: { track: TrackInfo; onClose: () => void }) {
  return <div className="playlist-track-info"><ArtTile track={track} size={64} /><div><b>{track.title}</b><p>{track.artist} · {track.album}</p><span>{track.genre} · {track.bpm ?? "?"} BPM · {track.key ?? "Unknown key"} · {duration(track.durationMs)}</span>{track.unavailableReason && <p>{track.unavailableReason}</p>}</div><button onClick={onClose}>Close</button></div>;
}

export function PlaylistView({ id, onOpen, onQueue }: { id: string; onOpen: (id: string) => void; onQueue: () => void }) {
  const app = useApp();
  const { playlists, library, engine } = app;
  const ps = usePlaylists();
  useLibraryState();
  const decks = useEngineState().decks;
  const p = ps.playlists.find((p) => p.id === id);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [info, setInfo] = useState<TrackInfo | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setSelected([]); setName(null); setDeleting(false); setInfo(null); }, [id]);
  useEffect(() => {
    const port = { moveSelection: (delta: number) => {
      const refs = playlists.get(id)?.refs ?? [];
      const at = refs.indexOf(library.getSelected()?.ref ?? "");
      const ref = refs[Math.max(0, Math.min(refs.length - 1, at + delta))];
      setSelected(ref ? [ref] : []);
      library.select(library.getState().tracks.findIndex((t) => t.ref === ref));
    }, getSelected: () => library.getByRef(selected[0] ?? p?.refs[0] ?? "") };
    app.browser.setActive(port);
    return () => app.browser.setActive(library);
  }, [app.browser, library, playlists, id, selected, p?.refs]);
  if (!p) return <div className="provider-msg">Create or choose a playlist to prepare your set.</div>;
  const sum = PlaylistStore.summary(p, (r) => library.getByRef(r) ?? undefined);
  const importFiles = async (reconnect = false) => {
    try { const refs = await app.platform.pickAudioFiles(); await app.addFiles(refs); if (!reconnect) playlists.addTracks(id, refs.map((r) => r.ref)); }
    catch (err) { app.log.warn("library", String(err)); }
  };
  const drop = (e: React.DragEvent, at = p.refs.length) => {
    e.preventDefault(); e.stopPropagation();
    try {
      const move = JSON.parse(e.dataTransfer.getData(PLAYLIST_MOVE) || "null") as { id: string; from: number } | null;
      if (move?.id === id) { playlists.move(id, move.from, at); return; }
    } catch { /* external drag */ }
    playlists.addTracks(id, draggedRefs(e.dataTransfer).filter((r) => !!library.getByRef(r)), at);
    const files = [...e.dataTransfer.files];
    if (files.length) void app.platform.refsFromDrop(files).then(async (refs) => { await app.addFiles(refs); playlists.addTracks(id, refs.map((r) => r.ref), at); }).catch((err) => app.log.warn("library", String(err)));
  };
  const select = (ref: string, e: React.MouseEvent) => {
    if (e.shiftKey && selected.length) {
      const a = p.refs.indexOf(selected[0]), b = p.refs.indexOf(ref);
      setSelected(p.refs.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else setSelected(e.ctrlKey || e.metaKey ? selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref] : [ref]);
    library.select(library.getState().tracks.findIndex((t) => t.ref === ref));
  };
  return <div className="library playlist-view" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e)}>
    <div className="toolbar playlist-toolbar">
      {name === null ? <b>{p.name}</b> : <form onSubmit={(e) => { e.preventDefault(); playlists.rename(id, name); setName(null); }}><input aria-label="Rename playlist" autoFocus value={name} onChange={(e) => setName(e.target.value)} /><button>Save name</button><button type="button" onClick={() => setName(null)}>Cancel</button></form>}
      <span>{sum.count} tracks · {duration(sum.durationMs)}{sum.missing ? ` · ${sum.missing} missing` : ""}</span>
      <button onClick={() => setName(p.name)}>Rename</button>
      <button onClick={() => { const copy = playlists.duplicate(id); if (copy) onOpen(copy.id); }}>Duplicate</button>
      <button onClick={() => setDeleting(true)}>Delete playlist</button>
      {deleting && <span>Delete “{p.name}”? Files stay in your library. <button onClick={() => void playlists.remove(id)}>Delete</button><button onClick={() => setDeleting(false)}>Cancel</button></span>}
      <button onClick={() => void importFiles()}>+ Add local files</button>
      {app.platform.kind === "browser" && <button onClick={() => void importFiles(true)}>Reconnect files</button>}
      <button className="primary" disabled={!p.refs.length} onClick={() => { void app.autoDJ.start(id); onQueue(); }}>▶ START AUTO DJ</button>
      <button disabled={!selected.length} onClick={() => { void app.autoDJ.start(id, selected[0]); onQueue(); }}>Start from selected</button>
    </div>
    <AutoSettings />
    <AutoDJControls onQueue={onQueue} />
    <div className="toolbar"><button onClick={() => setSelected(p.refs)}>Select all</button><span>{selected.length} selected</span><button disabled={!selected.length} onClick={() => { playlists.removeAt(id, selected.map((r) => p.refs.indexOf(r))); setSelected([]); }}>Remove from playlist</button><PlaylistActions refs={selected} /></div>
    <div className="table-wrap"><table className="tracks"><thead><tr><th>#</th><th /><th>Title</th><th>Artist</th><th>Album</th><th>BPM</th><th>Key</th><th>Time</th><th>Actions</th></tr></thead><tbody>
      {p.refs.map((ref, i) => {
        const track = library.getByRef(ref);
        return <tr key={ref} className={selected.includes(ref) ? "selected" : ""} draggable onClick={(e) => select(ref, e)}
          onDoubleClick={() => { const deck = decks.findIndex((d) => !d.playing); if (track && deck >= 0) void engine.loadTrack(deck, track); }}
          onDragStart={(e) => { e.dataTransfer.setData(PLAYLIST_MOVE, JSON.stringify({ id, from: i })); e.dataTransfer.setData(TRACK_REFS, JSON.stringify(selected.includes(ref) ? selected : [ref])); if (track) e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(track)); e.dataTransfer.effectAllowed = "copyMove"; }}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, i)}
          onContextMenu={(e) => { e.preventDefault(); if (!selected.includes(ref)) setSelected([ref]); setMenu({ x: e.clientX, y: e.clientY }); }}>
          <td>{i + 1}</td><td>{track && <ArtTile track={track} size={28} />}</td><td>{track?.title ?? ref}{track?.unavailableReason && <span className="warn"> · Reconnect file</span>}</td><td>{track?.artist}</td><td>{track?.album}</td><td>{track?.bpm?.toFixed(1) ?? "—"}</td><td>{track?.key ?? "—"}</td><td>{duration(track?.durationMs)}</td>
          <td className="row-actions" onClick={(e) => e.stopPropagation()}>{decks.map((d, deck) => <button key={deck} disabled={!track || d.playing || !!track.unavailableReason} onClick={() => track && void engine.loadTrack(deck, track)}>→ {deck ? "B" : "A"}</button>)}<button disabled={!track} onClick={() => setInfo(track)}>Info</button><button disabled={i === 0} onClick={() => playlists.move(id, i, i - 1)}>↑</button><button disabled={i === p.refs.length - 1} onClick={() => playlists.move(id, i, i + 2)}>↓</button><button onClick={() => playlists.removeAt(id, [i])}>Remove</button></td>
        </tr>;
      })}
      <tr onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e)}><td colSpan={9} className="empty">{p.refs.length ? "Drop here to move to the end" : "Drop library tracks or local files here. Use Ctrl/⌘ or Shift to select multiple tracks."}</td></tr>
    </tbody></table></div>
    {info && <TrackDetails track={library.getByRef(info.ref) ?? info} onClose={() => setInfo(null)} />}
    {menu && <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 160) }}><PlaylistActions refs={selected} onDone={() => setMenu(null)} /><button onClick={() => { playlists.removeAt(id, selected.map((r) => p.refs.indexOf(r))); setSelected([]); setMenu(null); }}>Remove from playlist</button><button onClick={() => setMenu(null)}>Close</button></div>}
  </div>;
}

export function AutoDJQueue() {
  const app = useApp();
  const { autoDJ, library, playlists } = app;
  const s = useAutoDJ();
  useLibraryState();
  usePlaylists();
  const [info, setInfo] = useState<TrackInfo | null>(null);
  const current = s.current ? library.getByRef(s.current) : null;
  const editable = !s.queueLocked;
  return <div className="library auto-queue" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.dataTransfer.types.includes(QUEUE_MOVE)) autoDJ.add(draggedRefs(e.dataTransfer)); }}>
    <div className="toolbar"><b>Auto DJ Queue {s.playlistId && `· ${playlists.get(s.playlistId)?.name ?? "Deleted playlist"}`}</b><span className="hint">Queue edits leave your playlist unchanged.</span><button disabled={!s.playlistId || !playlists.get(s.playlistId)} onClick={() => autoDJ.saveToPlaylist()}>Save queue back to playlist</button></div>
    <AutoDJControls />
    {app.platform.kind === "browser" && <div className="toolbar"><button onClick={() => { void app.platform.pickAudioFiles().then((refs) => app.addFiles(refs)).catch((err) => app.log.warn("library", String(err))); }}>Reconnect files</button><span className="hint">Select the original files, then resume Auto DJ.</span></div>}
    <AutoSettings />
    <div className="queue-now"><b>NOW PLAYING · DECK {s.deck ? "B" : "A"}</b>{current ? <><ArtTile track={current} size={40} /><span>{current.title} · {current.artist}</span><button onClick={() => setInfo(current)}>Info</button></> : <span>Open a playlist and select START AUTO DJ.</span>}</div>
    {s.plan && <div className="hint queue-plan">{s.plan.kind} · {s.plan.seconds.toFixed(1)}s · Mix-out {duration(s.plan.mixOut * 1000)} · Mix-in {duration(s.plan.mixIn * 1000)} · {s.plan.reason}</div>}
    <div className="table-wrap"><table className="tracks"><thead><tr><th>Queue</th><th /><th>Track</th><th>Artist</th><th>Time</th><th>Actions</th></tr></thead><tbody>
      {s.upcoming.map((ref, i) => { const t = library.getByRef(ref); return <tr key={`${i}:${ref}`} draggable={editable} onDragStart={(e) => { e.dataTransfer.setData(QUEUE_MOVE, String(i)); e.dataTransfer.effectAllowed = "move"; }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (!e.dataTransfer.types.includes(QUEUE_MOVE)) return; e.preventDefault(); e.stopPropagation(); autoDJ.move(Number(e.dataTransfer.getData(QUEUE_MOVE)), i); }}>
        <td>{i === 0 ? `NEXT · DECK ${s.deck ? "A" : "B"}` : `UPCOMING ${i}`}</td><td>{t && <ArtTile track={t} size={28} />}</td><td>{t?.title ?? ref}{t?.unavailableReason && <span className="warn"> · Reconnect file</span>}</td><td>{t?.artist}</td><td>{duration(t?.durationMs)}</td><td className="row-actions"><button disabled={!editable || i === 0} onClick={() => autoDJ.playNext(i)}>Play Next</button><button disabled={!editable || i === 0} onClick={() => autoDJ.move(i, i - 1)}>↑</button><button disabled={!editable || i === s.upcoming.length - 1} onClick={() => autoDJ.move(i, i + 2)}>↓</button><button disabled={!editable} onClick={() => autoDJ.remove(i)}>Remove</button><button disabled={!t} onClick={() => setInfo(t)}>Info</button></td>
      </tr>; })}
      <tr onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (!e.dataTransfer.types.includes(QUEUE_MOVE)) return; e.preventDefault(); e.stopPropagation(); autoDJ.move(Number(e.dataTransfer.getData(QUEUE_MOVE)), s.upcoming.length); }}><td colSpan={6} className="empty">Drop library tracks to add to the queue; drag queue tracks here to move to the end.</td></tr>
    </tbody></table></div>{info && <TrackDetails track={info} onClose={() => setInfo(null)} />}
  </div>;
}

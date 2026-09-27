/** Audius browser: trending, search (tracks / artists / playlists), artist & playlist drill-down. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudiusTab } from "../providers/audius/AudiusStore";
import { audiusToTrackInfo } from "../providers/audius/audiusTracks";
import { useApp, useEngineState } from "./context";
import { useFrameStore } from "./hooks";

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function useAudiusState() {
  const { audius } = useApp();
  return useFrameStore(
    useCallback((cb) => audius.on("change", cb), [audius]),
    () => audius.getState(),
  );
}

export function AudiusPane() {
  const { audius, matching, engine, platform, browser, library } = useApp();
  const s = useAudiusState();
  const decks = useEngineState().decks;
  const [q, setQ] = useState(s.query);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef<HTMLTableRowElement>(null);

  // The controller's browse encoder + LOAD A/B act on this list while it's shown.
  useEffect(() => {
    browser.setActive(audius);
    const st = audius.getState();
    if (st.tracks.length === 0 && !st.query && !st.loading) void audius.loadTrending();
    return () => browser.setActive(library);
  }, [audius, browser, library]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [s.selected]);

  const onQuery = (v: string) => {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    // Debounced to respect the API's rate limits.
    debounce.current = setTimeout(() => void audius.search(v), 450);
  };

  const tabs: AudiusTab[] = ["tracks", "artists", "playlists"];

  return (
    <div className="audius">
      <div className="toolbar">
        <span className={`status ${s.connection === "ok" ? "ok" : s.connection === "error" ? "warn" : "idle"}`}>
          {s.connection === "ok" ? "● Audius API" : s.connection === "error" ? "▲ Audius unreachable" : s.connection === "testing" ? "… testing" : "○ Audius"}
        </span>
        <input className="search-input" placeholder="Search Audius…" value={q} onChange={(e) => onQuery(e.target.value)} />
        {tabs.map((t) => (
          <button key={t} className={s.tab === t ? "active-tab" : ""} onClick={() => audius.setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <button onClick={() => { setQ(""); void audius.loadTrending(); }}>Trending</button>
        <span className="hint">{s.context}{s.loading ? " · loading…" : ""}</span>
      </div>
      {s.error && <div className="provider-error">⚠ {s.error} <button className="tiny" onClick={() => void audius.search(s.query)}>Retry</button></div>}

      {s.tab === "artists" && s.query ? (
        <ul className="audius-list">
          {s.users.map((u) => (
            <li key={u.id}>
              <button onClick={() => void audius.openArtist(u)}>
                {u.avatarUrl && <img className="art" src={u.avatarUrl} alt="" loading="lazy" />}
                <b>{u.name}</b> <span className="hint">@{u.handle} · {u.trackCount} tracks · {u.followerCount.toLocaleString()} followers</span>
              </button>
            </li>
          ))}
          {!s.loading && s.users.length === 0 && <li className="hint">No artists found.</li>}
        </ul>
      ) : s.tab === "playlists" && s.query ? (
        <ul className="audius-list">
          {s.playlists.map((p) => (
            <li key={p.id}>
              <button onClick={() => void audius.openPlaylist(p)}>
                {p.artworkUrl && <img className="art" src={p.artworkUrl} alt="" loading="lazy" />}
                <b>{p.name}</b> <span className="hint">{p.isAlbum ? "Album" : "Playlist"} by {p.owner}</span>
              </button>
            </li>
          ))}
          {!s.loading && s.playlists.length === 0 && <li className="hint">No playlists found.</li>}
        </ul>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Title</th>
                <th>Artist</th>
                <th>Genre</th>
                <th>BPM</th>
                <th>Key</th>
                <th>Time</th>
                <th>Source</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody>
              {s.tracks.map((t, i) => {
                const info = audiusToTrackInfo(t);
                return (
                  <tr
                    key={t.id}
                    ref={i === s.selected ? selectedRef : undefined}
                    className={`${i === s.selected ? "selected" : ""} ${t.streamable ? "" : "stream-only"}`}
                    onClick={() => audius.select(i)}
                    onDoubleClick={() => {
                      const free = decks.findIndex((d) => !d.playing);
                      if (free >= 0 && t.streamable) void matching.loadToDeck(free, info);
                    }}
                    draggable={t.streamable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(info));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    title={t.streamable ? `${t.license || "Audius"} · ${t.playCount.toLocaleString()} plays` : t.unavailableReason}
                  >
                    <td>{t.artworkUrl ? <img className="art" src={t.artworkUrl} alt="" loading="lazy" /> : null}</td>
                    <td>
                      {t.title}
                      {t.coverOf && <span className="tag"> cover</span>}
                      {t.remixOf && <span className="tag"> remix</span>}
                    </td>
                    <td>{t.artist}</td>
                    <td>{t.genre || "—"}</td>
                    <td>{t.bpm ?? "—"}</td>
                    <td>{t.key ?? "—"}</td>
                    <td>{fmt(t.durationMs)}</td>
                    <td>
                      <span className="source-badge audius">AUDIUS</span>
                    </td>
                    <td className="row-actions">
                      {t.streamable ? (
                        decks.map((d, deck) => (
                          <button
                            key={deck}
                            className={`tiny ${deck === 0 ? "deck-a-btn" : "deck-b-btn"}`}
                            disabled={d.playing}
                            onClick={(e) => {
                              e.stopPropagation();
                              void engine.loadTrack(deck, info);
                            }}
                          >
                            LOAD {String.fromCharCode(65 + deck)}
                          </button>
                        ))
                      ) : (
                        <span className="hint">🔒 not streamable</span>
                      )}
                      {t.permalink && (
                        <button className="tiny" title="Open on audius.co (artist credit)" onClick={() => platform.openExternal(t.permalink)}>
                          ↗
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!s.loading && s.tracks.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">No tracks.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Audius music streams under the artists' Audius Open Music License. Tracks are buffered in memory only (never saved), and recording is disabled for Audius audio.
      </p>
    </div>
  );
}

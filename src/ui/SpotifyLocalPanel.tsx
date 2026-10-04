/**
 * Spotify → Local: turn a Spotify playlist / track / selection into a local playlist of real
 * files, resolved from the library, the watched download folder or a download provider.
 * Every state is shown as icon + text (never colour alone).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PERMISSION_REMINDER } from "../acquire/providers";
import { counts, type ProviderView, type SpotifyLocalState } from "../acquire/SpotifyLocalService";
import { parseSpotifyRef } from "../acquire/spotifyRef";
import { PLAYABLE_STATES, STATE_ICON, STATE_LABEL, type AudioQuality, type ImportJob, type PlaylistEntry, type ReviewCandidate } from "../acquire/types";
import { useApp, useEngineState } from "./context";
import { useFrameStore } from "./hooks";

export function useSpotifyLocal(): SpotifyLocalState {
  const { spotifyLocal } = useApp();
  return useFrameStore(
    useCallback((cb) => spotifyLocal.on("change", cb), [spotifyLocal]),
    () => spotifyLocal.getState(),
  );
}

const fmt = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function qualityText(q: AudioQuality | null | undefined): string {
  if (!q) return "—";
  const parts = [q.codec ?? q.container, q.bitrateKbps ? `${q.bitrateKbps} kbps` : null, q.sampleRate ? `${(q.sampleRate / 1000).toFixed(q.sampleRate % 1000 ? 1 : 0)} kHz` : null, q.lossless ? "lossless" : null, q.durationMs ? fmt(q.durationMs) : null];
  return parts.filter(Boolean).join(" · ") || "—";
}

export function SpotifyLocalPanel({ jobId, onOpenPlaylist }: { jobId?: string | null; onOpenPlaylist?: (id: string) => void }) {
  const { spotifyLocal } = useApp();
  const s = useSpotifyLocal();
  const [selected, setSelected] = useState<string | null>(jobId ?? null);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    void spotifyLocal.refreshDesktop();
    void spotifyLocal.refreshProviders();
  }, [spotifyLocal]);
  useEffect(() => {
    if (jobId) setSelected(jobId);
  }, [jobId]);
  useEffect(() => {
    if (s.draft) setSelected(null);
  }, [s.draft]);
  const job = selected ? s.jobs.find((j) => j.id === selected) : undefined;

  return (
    <div className="sl">
      <div className="sl-head">
        <h3>⇄ Spotify → Local</h3>
        <span className="hint">Spotify supplies the playlist and metadata; the decks play local files only.</span>
        <button className={settings ? "active" : ""} onClick={() => setSettings((v) => !v)}>⚙ Folders &amp; providers</button>
      </div>
      {s.message && (
        <div className={s.message.kind === "error" ? "provider-error" : "sl-note"} role="status">
          {s.message.kind === "error" ? "⚠ " : "ℹ "}
          {s.message.text} <button className="linklike" onClick={() => spotifyLocal.clearMessage()}>Dismiss</button>
        </div>
      )}
      {settings && <SettingsBox s={s} />}
      <div className="sl-split">
        <ul className="sl-jobs">
          <li>
            <button className={!job ? "active" : ""} onClick={() => setSelected(null)}>＋ New from Spotify</button>
          </li>
          {s.jobs.map((j) => {
            const c = counts(j);
            return (
              <li key={j.id}>
                <button className={job?.id === j.id ? "active" : ""} onClick={() => setSelected(j.id)} title={j.source.name}>
                  {j.playlistName}
                  <span className="count">
                    {c.playable}/{j.entries.length}
                  </span>
                  {c.active > 0 && <span className="hint"> · working</span>}
                  {c.review > 0 && <span className="warn"> · ? {c.review}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="sl-body">{job ? <JobView job={job} s={s} onOpenPlaylist={onOpenPlaylist} /> : <NewImport s={s} onStarted={setSelected} />}</div>
      </div>
      {s.refresh && <RefreshDialog s={s} />}
    </div>
  );
}

// ─────────────────────────────── new import ───────────────────────────────

function NewImport({ s, onStarted }: { s: SpotifyLocalState; onStarted: (id: string) => void }) {
  const { spotifyLocal, streaming } = useApp();
  const viaSpotdl = !!s.providers.find((p) => p.id === "spotdl")?.state?.available;
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const spotify = useFrameStore(
    useCallback((cb) => streaming.on("change", cb), [streaming]),
    () => streaming.getState().spotify,
  );
  useEffect(() => {
    void streaming.refresh("spotify");
  }, [streaming]);
  const submit = () => {
    const r = parseSpotifyRef(url);
    if (!r.ok) return setError(r.error);
    setError(null);
    void spotifyLocal.preview(r.ref);
  };
  if (s.draft) return <DraftView s={s} onStarted={onStarted} />;
  return (
    <div className="sl-new">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input className="wide" placeholder="Paste a Spotify playlist or track link (open.spotify.com/… or spotify:…)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Spotify link" />
        <button type="submit" className="primary" disabled={s.loadingDraft || !url.trim()}>
          {s.loadingDraft ? "Reading Spotify…" : "Preview"}
        </button>
      </form>
      {error && <p className="provider-error">⚠ {error}</p>}
      {!streaming.available ? (
        <p className="hint">Spotify needs the desktop app (or a connected browser session). Local matching and the watched folder still work for playlists you've already prepared.</p>
      ) : !spotify.status?.connected ? (
        <p className="hint">Connect your Spotify account under Library → Spotify to list your playlists here. Pasted links need the same connection.</p>
      ) : (
        <>
          <h4>Your Spotify playlists</h4>
          <ul className="sl-picks">
            {spotify.playlists.filter((p) => p.readable).map((p) => (
              <li key={p.id}>
                <button disabled={s.loadingDraft} title={p.note} onClick={() => void spotifyLocal.preview(p.id === "__liked__" ? { type: "liked", id: "__liked__" } : { type: "playlist", id: p.id })}>
                  ♫ {p.name}
                  {p.trackCount ? <span className="count">{p.trackCount}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {spotify.playlists.some((p) => !p.readable) && (
            <>
              <h4>🔒 By other people</h4>
              <p className="hint">
                Spotify only gives this app the tracks of playlists you own or collaborate on.{" "}
                {viaSpotdl ? "These can still be read with your installed spotDL — the first read of a big playlist can take several minutes, then it's cached for 12 hours." : "Copy one into your own playlist in Spotify (select all → Add to playlist → New playlist) to prepare it here."}
              </p>
              <ul className="sl-picks">
                {spotify.playlists.filter((p) => !p.readable).map((p) => (
                  <li key={p.id}>
                    <button className="locked" disabled={!viaSpotdl || s.loadingDraft} title={`${p.note ?? ""}${viaSpotdl ? " — read with spotDL (slow the first time)" : ""}`} onClick={() => void spotifyLocal.preview({ type: "playlist", id: p.id })}>
                      🔒 {p.name}
                      {p.trackCount ? <span className="count">{p.trackCount}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="hint">From search results, use ⇩ Download on a track, or tick tracks in Library → Spotify and choose Prepare Local Playlist.</p>
        </>
      )}
    </div>
  );
}

function DraftView({ s, onStarted }: { s: SpotifyLocalState; onStarted: (id: string) => void }) {
  const { spotifyLocal } = useApp();
  const d = s.draft!;
  const [name, setName] = useState(d.result.source.name);
  const downloadable = spotifyLocal.canDownload;
  const [useProviders, setUseProviders] = useState(downloadable);
  const [autoAppend, setAutoAppend] = useState(false);
  const need = d.result.entries.length - d.alreadyLocal - d.unsupported;
  const label = useProviders && downloadable ? "Download Playlist" : "Prepare Local Playlist";
  return (
    <div className="sl-draft">
      <h4>
        {d.result.source.name} {d.result.source.owner && <span className="hint">by {d.result.source.owner}</span>}
      </h4>
      <p>
        <b>{d.result.entries.length}</b> entries · <span className="ok-text">✓ {d.alreadyLocal} already in your library</span> · <span className="warn">? {d.toReview} to review</span> · <span>⏳ {Math.max(0, need - d.toReview)} need a local file</span>
        {d.unsupported > 0 && <span className="hint"> · ✕ {d.unsupported} unsupported (podcasts / removed)</span>}
      </p>
      <div className="sl-form">
        <label>
          Local playlist name <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label title={downloadable ? "" : "No enabled provider can download right now — see Folders & providers"}>
          <input type="checkbox" checked={useProviders && downloadable} disabled={!downloadable} onChange={(e) => setUseProviders(e.target.checked)} /> Download missing tracks from enabled providers
          {!downloadable && <span className="hint"> (none available — missing tracks wait for local files)</span>}
        </label>
        {downloadable && <PermissionReminder />}
        <label>
          <input type="checkbox" checked={autoAppend} onChange={(e) => setAutoAppend(e.target.checked)} /> Append tracks to Auto DJ automatically as they become ready
        </label>
        {s.config && <p className="hint">Downloads go to: {s.config.destination ?? "— not chosen (⚙ Folders & providers)"} · Watched folder: {s.watch?.watching ? s.config.watchFolder : "off"}</p>}
      </div>
      <div className="row">
        <button
          className="primary big"
          onClick={() => {
            const job = spotifyLocal.start({ playlistName: name, useProviders: useProviders && downloadable, autoAppend });
            if (job) onStarted(job.id);
          }}
        >
          {label}
        </button>
        <button onClick={() => spotifyLocal.discardDraft()}>Cancel</button>
      </div>
      <div className="table-wrap sl-preview">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Artist</th>
              <th>Time</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {d.result.entries.slice(0, 300).map((e, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{e.track.title}</td>
                <td>{e.track.artists.join(", ")}</td>
                <td>{fmt(e.track.durationMs)}</td>
                <td className="hint">{e.kind === "episode" ? "✕ podcast (unsupported)" : e.kind === "unavailable" ? (e.track.title ? "unavailable on Spotify" : "✕ removed") : e.kind === "spotify-local-file" ? "Spotify local file" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.result.entries.length > 300 && <p className="hint">…and {d.result.entries.length - 300} more</p>}
      </div>
    </div>
  );
}

// ─────────────────────────────── job ───────────────────────────────

function JobView({ job, s, onOpenPlaylist }: { job: ImportJob; s: SpotifyLocalState; onOpenPlaylist?: (id: string) => void }) {
  const { spotifyLocal, platform } = useApp();
  const c = counts(job);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unresolved" | "review">("all");
  const [name, setName] = useState<string | null>(null);
  const running = job.status === "running" && c.active > 0;
  const entries = useMemo(
    () =>
      [...job.entries]
        .sort((a, b) => a.position - b.position)
        .filter((e) => (filter === "all" ? true : filter === "review" ? e.state === "needs-review" : !PLAYABLE_STATES.has(e.state))),
    [job.entries, filter],
  );
  const pct = job.entries.length ? Math.round((c.playable / job.entries.length) * 100) : 0;
  return (
    <div className="sl-job">
      <div className="sl-job-head">
        {name === null ? (
          <h4>
            {job.playlistName}{" "}
            <button className="linklike" onClick={() => setName(job.playlistName)} title="Rename the local playlist">
              ✎
            </button>
          </h4>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              spotifyLocal.rename(job.id, name);
              setName(null);
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setName(null)} />
          </form>
        )}
        <span className="hint">
          from Spotify {job.source.kind === "liked" ? "Liked Songs" : job.source.kind}: {job.source.name}
          {job.source.url && (
            <>
              {" "}
              <button className="linklike" onClick={() => platform.openExternal(job.source.url!)}>
                ↗ open
              </button>
            </>
          )}
        </span>
      </div>
      <div className="sl-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Playable tracks">
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="sl-counts">
        <b>
          ✓ {c.playable}/{job.entries.length} playable
        </b>{" "}
        ({c.ready} analysed) · <span>⏳ {c.awaiting} awaiting a file</span> · <span className="warn">? {c.review} to review</span> · <span>✕ {c.failed} failed/cancelled</span>
        {running && <span className="hint"> · working on {c.active}…</span>} · <b>{c.unresolved} unresolved</b>
      </p>
      <div className="toolbar sl-actions">
        {running ? <button onClick={() => spotifyLocal.cancel(job.id)}>⊘ Cancel</button> : <button disabled={job.status !== "cancelled" && c.failed === 0} onClick={() => spotifyLocal.retryFailed(job.id)}>↻ {job.status === "cancelled" ? "Resume" : "Retry failed"}</button>}
        {(job.source.kind === "playlist" || job.source.kind === "liked") && <button onClick={() => void spotifyLocal.previewRefresh(job.id)}>⟳ Refresh from Spotify</button>}
        <button className="primary" disabled={!c.playable} onClick={() => spotifyLocal.addReadyToAutoDJ(job.id)}>
          ▶ Add Ready Tracks to Auto DJ
        </button>
        <label title="Newly ready tracks are appended to the Auto DJ queue once each, while Auto DJ is running">
          <input type="checkbox" checked={job.autoAppend} onChange={(e) => spotifyLocal.setAutoAppend(job.id, e.target.checked)} /> Auto-append new ready tracks
        </label>
        <label title={spotifyLocal.canDownload ? "" : "No enabled provider can download right now"}>
          <input type="checkbox" checked={job.useProviders} onChange={(e) => spotifyLocal.setUseProviders(job.id, e.target.checked)} /> Use download providers
        </label>
        {onOpenPlaylist && <button onClick={() => onOpenPlaylist(job.playlistId)}>☰ Open playlist</button>}
        <button title="Stop linking this playlist to Spotify. The local playlist, files, cues and beatgrids are kept." onClick={() => void spotifyLocal.removeJob(job.id)}>
          Unlink
        </button>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Show">
          <option value="all">All entries</option>
          <option value="unresolved">Unresolved only</option>
          <option value="review">Needs review</option>
        </select>
      </div>
      {job.useProviders && <PermissionReminder />}
      {c.awaiting > 0 && !s.watch?.watching && s.config && (
        <p className="sl-note">ℹ {c.awaiting} track(s) need a local file. Convert or buy them with your usual tool and save them into a watched folder (⚙ Folders &amp; providers → Watch Download Folder) — they're matched, imported and analysed automatically.</p>
      )}
      <div className="table-wrap">
        <table className="sl-table">
          <thead>
            <tr>
              <th>#</th>
              <th>State</th>
              <th>Spotify track</th>
              <th>Time</th>
              <th>Local file &amp; audio source</th>
              <th>Quality (actual file)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <EntryRow key={e.key} job={job} e={e} open={open === e.key} onToggle={() => setOpen(open === e.key ? null : e.key)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryRow({ job, e, open, onToggle }: { job: ImportJob; e: PlaylistEntry; open: boolean; onToggle: () => void }) {
  const { spotifyLocal } = useApp();
  const decks = useEngineState().decks;
  const playable = PLAYABLE_STATES.has(e.state);
  const canRetry = ["failed", "cancelled", "awaiting-file", "needs-review"].includes(e.state) && e.kind !== "episode" && !!e.source.title;
  return (
    <>
      <tr className={`sl-row st-${e.state}`}>
        <td>{e.position + 1}</td>
        <td className="sl-state">
          <span className="sl-badge">
            {STATE_ICON[e.state]} {STATE_LABEL[e.state]}
            {e.state === "downloading" && e.progress != null ? ` ${Math.round(e.progress * 100)}%` : ""}
          </span>
          {e.detail && (
            <div className="hint" title={e.detail}>
              {e.detail}
            </div>
          )}
        </td>
        <td>
          <div>{e.source.title || "—"}</div>
          <div className="hint">
            {e.source.artists.join(", ")}
            {e.source.isrc ? ` · ISRC ${e.source.isrc}` : ""}
          </div>
        </td>
        <td>{fmt(e.source.durationMs)}</td>
        <td>
          {e.local ? (
            <>
              <div title={e.local.ref}>{e.local.ref.split(/[\\/]/).pop()}</div>
              <div className="hint">
                {e.local.provenance.audioSource} · {e.local.provenance.version} · {e.local.provenance.note ?? `${e.local.provenance.confidence}% (${e.local.provenance.method})`}
              </div>
            </>
          ) : (
            <span className="hint">—</span>
          )}
        </td>
        <td className="hint">{qualityText(e.local?.quality)}</td>
        <td className="row-actions">
          {e.state === "needs-review" && (
            <button className="tiny" onClick={onToggle}>
              {open ? "Hide" : "Review"}
            </button>
          )}
          {!playable && e.state !== "needs-review" && e.kind !== "episode" && (
            <button className="tiny" onClick={onToggle} title="Choose the right file yourself">
              {open ? "Hide" : "Match…"}
            </button>
          )}
          {canRetry && (
            <button className="tiny" onClick={() => spotifyLocal.retryEntry(job.id, e.key)}>
              ↻ Retry
            </button>
          )}
          {playable &&
            decks.map((d, deck) => (
              <button key={deck} className={`tiny ${deck === 0 ? "deck-a-btn" : "deck-b-btn"}`} disabled={d.playing} title={d.playing ? "Deck is playing" : `Load Deck ${deck ? "B" : "A"}`} onClick={() => spotifyLocal.loadDeck(job.id, e.key, deck)}>
                → {deck ? "B" : "A"}
              </button>
            ))}
          {playable && (
            <button className="tiny" onClick={() => spotifyLocal.playNext(job.id, e.key)} title="Next in Auto DJ, or onto a free deck">
              Play Next
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="sl-review-row">
          <td colSpan={7}>
            <ReviewBox job={job} e={e} onDone={onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

function ReviewBox({ job, e, onDone }: { job: ImportJob; e: PlaylistEntry; onDone: () => void }) {
  const { spotifyLocal, matching } = useApp();
  const [q, setQ] = useState(`${e.source.artists[0] ?? ""} ${e.source.title}`.trim());
  const results = useMemo(() => (q.trim().length > 1 ? matching.local.query(q, 8) : []), [q, matching]);
  const pick = (c: ReviewCandidate) => {
    void spotifyLocal.confirmReview(job.id, e.key, c);
    onDone();
  };
  return (
    <div className="sl-review">
      {e.review.length > 0 && (
        <>
          <p>
            <b>Which file is “{e.source.title}”?</b> <span className="hint">Spotify: {fmt(e.source.durationMs)} · versions are compared separately (remix / radio / extended / live / remaster / clean-explicit)</span>
          </p>
          <ul>
            {e.review.map((c) => (
              <li key={`${c.kind}:${c.id}`}>
                <button className="primary tiny" onClick={() => pick(c)}>
                  Use this
                </button>{" "}
                <b>{c.score}%</b> {c.artist} – {c.title} <span className="hint">({c.version}, {fmt(c.durationMs)}, {c.label})</span>
                <details>
                  <summary className="hint">Why</summary>
                  <ul className="hint">
                    {c.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <button
            onClick={() => {
              spotifyLocal.rejectReview(job.id, e.key);
              onDone();
            }}
          >
            None of these — wait for the right file
          </button>
        </>
      )}
      <div className="row">
        <input className="wide" value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="Find in your library" aria-label="Find in your library" />
        <button onClick={() => void spotifyLocal.chooseFile(job.id, e.key).then(onDone)}>Choose a file…</button>
      </div>
      {results.length > 0 && (
        <ul className="sl-lib-results">
          {results.map((t) => (
            <li key={t.ref}>
              <button
                className="tiny"
                onClick={() => {
                  void spotifyLocal.chooseLibraryTrack(job.id, e.key, t.ref);
                  onDone();
                }}
              >
                Use
              </button>{" "}
              {t.artist} – {t.title} <span className="hint">{fmt(t.durationMs)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────── refresh ───────────────────────────────

function RefreshDialog({ s }: { s: SpotifyLocalState }) {
  const { spotifyLocal } = useApp();
  const r = s.refresh!;
  const p = r.preview;
  const none = !p.added.length && !p.removed.length && !p.moved.length;
  return (
    <div className="modal-backdrop" role="dialog" aria-label="Refresh from Spotify">
      <div className="modal sl-refresh">
        <h3>Refresh from Spotify — {r.source.name}</h3>
        {none ? (
          <p>No changes: the local playlist already matches Spotify ({p.unchanged} entries).</p>
        ) : (
          <>
            <p>
              <b>＋ {p.added.length} added</b> · <b>− {p.removed.length} removed</b> · <b>↕ {p.moved.length} moved</b> · {p.unchanged} unchanged
            </p>
            {p.added.length > 0 && (
              <details open>
                <summary>Added</summary>
                <ul>{p.added.slice(0, 50).map((a) => <li key={a.position}>＋ {a.position + 1}. {a.track.artists.join(", ")} – {a.track.title}</li>)}</ul>
              </details>
            )}
            {p.removed.length > 0 && (
              <details open>
                <summary>Removed (leaves the playlist; audio files, cues and beatgrids are kept)</summary>
                <ul>{p.removed.slice(0, 50).map((e) => <li key={e.key}>− {e.source.artists.join(", ")} – {e.source.title}</li>)}</ul>
              </details>
            )}
            {p.moved.length > 0 && (
              <details>
                <summary>Moved</summary>
                <ul>{p.moved.slice(0, 50).map((m) => <li key={m.entry.key}>↕ {m.entry.source.title}: {m.from + 1} → {m.to + 1}</li>)}</ul>
              </details>
            )}
          </>
        )}
        <div className="row">
          {!none && (
            <button className="primary" onClick={() => spotifyLocal.applyRefresh()}>
              Apply changes
            </button>
          )}
          <button onClick={() => spotifyLocal.cancelRefresh()}>{none ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── settings ───────────────────────────────

function SettingsBox({ s }: { s: SpotifyLocalState }) {
  const { spotifyLocal } = useApp();
  const desktop = !!s.config;
  return (
    <div className="sl-settings">
      <section>
        <h4>Watch Download Folder</h4>
        {!desktop ? (
          <p className="hint">Folder watching needs the desktop app — a browser page can't watch folders on your computer.</p>
        ) : (
          <>
            <p className="hint">
              For files from your own converter (e.g. ViWizard). It has no documented automation interface, so the remaining step is manual: convert in that app and save into this folder. New
              files are detected when they finish writing, matched to unresolved entries by their tags, then imported and analysed automatically. Ambiguous files go to review.
            </p>
            <div className="row">
              <code>{s.config!.watchFolder ?? "no folder chosen"}</code>
              <button onClick={() => void spotifyLocal.desktopAction("watchFolder")}>Choose…</button>
              <label>
                <input type="checkbox" checked={!!s.watch?.watching} disabled={!s.config!.watchFolder} onChange={(e) => void spotifyLocal.desktopAction(e.target.checked ? "watchOn" : "watchOff")} /> Watching
              </label>
              {s.watch?.watching && <button onClick={() => void spotifyLocal.desktopAction("rescan")}>Rescan</button>}
              {s.watch?.watching && <span className="ok-text">● {s.watch.seen} file(s) seen</span>}
            </div>
            {s.watch?.error && <p className="warn">⚠ {s.watch.error}</p>}
          </>
        )}
      </section>
      <section>
        <h4>Download destination</h4>
        {!desktop ? (
          <p className="hint">Downloads need the desktop app.</p>
        ) : (
          <div className="row">
            <code>{s.config!.destination ?? "no folder chosen"}</code>
            <button onClick={() => void spotifyLocal.desktopAction("destination")}>Choose…</button>
          </div>
        )}
      </section>
      <section>
        <h4>
          Download providers{" "}
          <button className="linklike" onClick={() => void spotifyLocal.refreshProviders(true)} title="Re-check which providers are installed and reachable">
            ↻ Check again
          </button>
        </h4>
        <PermissionReminder />
        <ul className="sl-providers">
          {s.providers.map((p) => (
            <ProviderRow key={p.id} p={p} />
          ))}
        </ul>
        <p className="hint">Files are kept at the quality the source provides; nothing is re-encoded (converting a 128 kbps source to FLAC or 320 kbps doesn't improve it).</p>
      </section>
      <section>
        <h4>Matching</h4>
        <div className="row sl-thresholds">
          <label>
            Accept automatically at ≥ <input type="number" min={60} max={100} value={s.match.autoAccept} onChange={(e) => spotifyLocal.setMatchConfig({ autoAccept: Number(e.target.value) })} />%
          </label>
          <label>
            Offer for review at ≥ <input type="number" min={30} max={100} value={s.match.reviewMin} onChange={(e) => spotifyLocal.setMatchConfig({ reviewMin: Number(e.target.value) })} />%
          </label>
          <label>
            Length tolerance <input type="number" min={2} max={120} value={s.match.durationToleranceS} onChange={(e) => spotifyLocal.setMatchConfig({ durationToleranceS: Number(e.target.value) })} /> s
          </label>
        </div>
      </section>
    </div>
  );
}

function ProviderRow({ p }: { p: ProviderView }) {
  const { spotifyLocal } = useApp();
  return (
    <li>
      <label>
        <input type="checkbox" checked={p.enabled} disabled={!p.canDownload} onChange={(e) => spotifyLocal.setProviderEnabled(p.id, e.target.checked)} /> <b>{p.name}</b>
      </label>{" "}
      <span className="hint">audio source: {p.audioSource}</span>{" "}
      {p.state === null ? (
        <span className="hint">· checking…</span>
      ) : p.state.available ? (
        <span className="ok-text">· ✓ available{p.state.reason ? ` (${p.state.reason})` : ""}</span>
      ) : (
        <span className="warn">· ✕ {p.canDownload ? "unavailable" : "not bundled"}</span>
      )}
      <div className="hint">{p.note}</div>
      {p.state && !p.state.available && p.state.reason && <div className="hint">{p.state.reason}</div>}
      {p.state && !p.state.available && p.state.setup && (
        <div className="hint">
          Setup: <code>{p.state.setup}</code> — then press{" "}
          <button className="linklike" onClick={() => void spotifyLocal.refreshProviders(true)}>
            Check again
          </button>
        </div>
      )}
    </li>
  );
}

function PermissionReminder() {
  return (
    <p className="sl-permission" role="note">
      ⚖ {PERMISSION_REMINDER}
    </p>
  );
}

/** Banner for a local playlist linked to Spotify, listing entries that aren't local yet. */
export function LinkedPlaylistBanner({ playlistId, onOpen }: { playlistId: string; onOpen: (jobId: string) => void }) {
  const s = useSpotifyLocal();
  const job = s.jobs.find((j) => j.playlistId === playlistId);
  if (!job) return null;
  const c = counts(job);
  const unresolved = [...job.entries].filter((e) => !PLAYABLE_STATES.has(e.state)).sort((a, b) => a.position - b.position);
  return (
    <div className="sl-linked">
      ⇄ Linked to Spotify {job.source.kind === "liked" ? "Liked Songs" : `“${job.source.name}”`} · <b>{c.playable}/{job.entries.length} ready</b>
      {unresolved.length > 0 && <> · {unresolved.length} not local yet</>} <button className="linklike" onClick={() => onOpen(job.id)}>Open Spotify → Local</button>
      {unresolved.length > 0 && (
        <details>
          <summary className="hint">Show unresolved entries</summary>
          <ul className="hint">
            {unresolved.slice(0, 100).map((e) => (
              <li key={e.key}>
                {e.position + 1}. {STATE_ICON[e.state]} {STATE_LABEL[e.state]} — {e.source.artists.join(", ")} – {e.source.title}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Music browser: Local Library + streaming providers (Spotify, Apple Music).
 * Streaming tracks are browse-only; when a matching local file exists it can be loaded instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackInfo } from "../core/engine/types";
import { buildLocalIndex } from "../library/matching";
import { PROVIDER_CAPABILITIES } from "../providers/MusicProvider";
import { PROVIDER_NAMES, toTrackInfo, type ProviderView } from "../providers/StreamingStore";
import type { StreamingProviderId, StreamingTrack } from "../providers/streamingTypes";
import { useApp, useEngineState, useLibraryState } from "./context";
import { useFrameStore } from "./hooks";

type Source = "local" | StreamingProviderId;

function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useStreamingState() {
  const { streaming } = useApp();
  return useFrameStore(
    useCallback((cb) => streaming.on("change", cb), [streaming]),
    () => streaming.getState(),
  );
}

/** Deck to use for "load" shortcuts: the first deck that isn't playing. */
function useFreeDeck(): number | null {
  const s = useEngineState();
  const i = s.decks.findIndex((d) => !d.playing);
  return i >= 0 ? i : null;
}

export function LibraryPanel() {
  const [source, setSource] = useState<Source>("local");
  const lib = useLibraryState();
  const streams = useStreamingState();
  const dot = (v: ProviderView) => (v.status?.connected ? "● " : v.status?.configured ? "◐ " : "○ ");
  return (
    <div className="browser">
      <nav className="browser-sources">
        <div className="browser-heading">MUSIC</div>
        <button className={source === "local" ? "active" : ""} onClick={() => setSource("local")}>
          Local Library <span className="count">{lib.tracks.length}</span>
        </button>
        <button className={source === "spotify" ? "active" : ""} onClick={() => setSource("spotify")}>
          {dot(streams.spotify)}Spotify
        </button>
        <button className={source === "apple-music" ? "active" : ""} onClick={() => setSource("apple-music")}>
          {dot(streams["apple-music"])}Apple Music
        </button>
      </nav>
      <div className="browser-body">{source === "local" ? <LocalView /> : <ProviderPane id={source} />}</div>
    </div>
  );
}

// ─────────────────────────────── Local ───────────────────────────────

function LocalView() {
  const app = useApp();
  const { library, platform, engine, log } = app;
  const state = useLibraryState();
  const freeDeck = useFreeDeck();
  const selectedRef = useRef<HTMLTableRowElement>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  const add = async (folder: boolean) => {
    try {
      const files = folder ? await platform.pickFolder() : await platform.pickAudioFiles();
      if (files.length) await app.addFiles(files);
    } catch (err) {
      log.error("library", String(err));
    }
  };

  return (
    <div
      className={`library ${dropping ? "drop-target" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void platform.refsFromDrop(files).then((refs) => app.addFiles(refs));
      }}
    >
      <div className="toolbar">
        <button className="primary" onClick={() => void add(false)}>+ Add files…</button>
        <button onClick={() => void add(true)}>+ Add folder…</button>
        <span className="hint">
          Drop files or folders here · drag a row onto a deck · double-click loads into a free deck · browse encoder + LOAD A/B on the DDJ-SB
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Artist</th>
              <th>BPM</th>
              <th>Key</th>
              <th>Source</th>
              <th>Load</th>
            </tr>
          </thead>
          <tbody>
            {state.tracks.length === 0 && (
              <tr>
                <td colSpan={7} className="empty dropzone">
                  <div className="dropzone-big">⤓ Drop audio files or folders here</div>
                  or use <b>+ Add files…</b> / <b>+ Add folder…</b>. Files are referenced in place, never moved or modified.
                </td>
              </tr>
            )}
            {state.tracks.map((t, i) => (
              <tr
                key={t.ref}
                ref={i === state.selected ? selectedRef : undefined}
                className={i === state.selected ? "selected" : ""}
                onClick={() => library.select(i)}
                onDoubleClick={() => {
                  if (freeDeck === null) log.warn("engine", "Both decks are playing — pause one to load.");
                  else void engine.loadTrack(freeDeck, t);
                }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(t));
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <td>{i + 1}</td>
                <td>{t.title}</td>
                <td>{t.artist}</td>
                <td>{t.bpm ?? "—"}</td>
                <td>{t.key ?? "—"}</td>
                <td>
                  <span className="source-badge">LOCAL</span>
                </td>
                <td className="row-actions">
                  <LoadButtons track={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LoadButtons({ track }: { track: TrackInfo }) {
  const { engine } = useApp();
  const s = useEngineState();
  return (
    <>
      {s.decks.map((d, i) => (
        <button
          key={i}
          className={`tiny ${i === 0 ? "deck-a-btn" : "deck-b-btn"}`}
          disabled={d.playing}
          title={d.playing ? `Deck ${String.fromCharCode(65 + i)} is playing` : `Load into deck ${String.fromCharCode(65 + i)}`}
          onClick={(e) => {
            e.stopPropagation();
            void engine.loadTrack(i, track);
          }}
        >
          → {String.fromCharCode(65 + i)}
        </button>
      ))}
    </>
  );
}

// ─────────────────────────────── Streaming ───────────────────────────────

function ProviderPane({ id }: { id: StreamingProviderId }) {
  const { streaming } = useApp();
  const view = useStreamingState()[id];
  const name = PROVIDER_NAMES[id];

  useEffect(() => {
    void streaming.refresh(id);
  }, [streaming, id]);

  if (!streaming.available) {
    return (
      <div className="provider-msg">
        <h3>{name}</h3>
        <p>Connecting streaming accounts needs the desktop app (npm run dev / the installed app). It isn't available in browser mode.</p>
      </div>
    );
  }
  if (!view.status) return <div className="provider-msg">{view.error ? `⚠ ${view.error}` : "Loading…"}</div>;

  return (
    <div className="provider">
      <RestrictionBanner id={id} />
      {view.error && <div className="provider-error">⚠ {view.error}</div>}
      {!view.status.configured ? (
        id === "spotify" ? <SpotifySetup view={view} /> : <AppleSetup view={view} />
      ) : !view.status.connected ? (
        <ConnectStep id={id} view={view} />
      ) : (
        <ConnectedView id={id} view={view} />
      )}
    </div>
  );
}

function RestrictionBanner({ id }: { id: StreamingProviderId }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="restriction">
      🔒 <b>Browse &amp; match only.</b> {PROVIDER_NAMES[id]} tracks can't be loaded onto decks, mixed or recorded — the service's terms
      don't allow it for third-party apps. Tracks that exist in your <b>local library</b> are matched automatically and can be loaded.{" "}
      <button className="linklike" onClick={() => setOpen((o) => !o)}>{open ? "Hide details" : "Why?"}</button>
      {open && <p className="hint">{PROVIDER_CAPABILITIES[id].restriction}</p>}
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-field">
      <code>{value}</code>
      <button
        className="tiny"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </span>
  );
}

function SpotifySetup({ view }: { view: ProviderView }) {
  const { streaming, platform } = useApp();
  const [clientId, setClientId] = useState("");
  const redirect = view.status?.redirectUri ?? "http://127.0.0.1:43821/callback";
  return (
    <div className="setup">
      <h3>Connect Spotify Premium</h3>
      <p className="hint">Spotify only lets apps sign in with a Client ID you create (free, about 2 minutes). You only need to do this once.</p>
      <ol>
        <li>
          Open the{" "}
          <button className="linklike" onClick={() => platform.openExternal("https://developer.spotify.com/dashboard")}>
            Spotify Developer Dashboard
          </button>{" "}
          and log in with your Premium account → <b>Create app</b>.
        </li>
        <li>
          Name it anything (e.g. "My DJ app"). Under <b>Redirect URIs</b> add exactly: <CopyField value={redirect} />
        </li>
        <li>
          Tick <b>Web API</b>, accept the terms and save.
        </li>
        <li>
          Open <b>Settings</b> of the new app, copy the <b>Client ID</b> and paste it here:
        </li>
      </ol>
      <div className="row">
        <input className="wide" placeholder="Spotify Client ID (32 characters)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <button className="primary" disabled={view.busy || clientId.trim().length < 32} onClick={() => void streaming.configure("spotify", { clientId })}>
          Save
        </button>
      </div>
      <p className="hint">
        Spotify limits personal ("development mode") apps to 5 accounts and requires Premium. To let another account connect, add
        its email under <b>User Management</b> in the dashboard.
      </p>
    </div>
  );
}

function AppleSetup({ view }: { view: ProviderView }) {
  const { streaming, platform } = useApp();
  const [mode, setMode] = useState<"key" | "token">("key");
  const [teamId, setTeamId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [token, setToken] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = mode === "token" ? token.trim().length > 20 : teamId.trim() && keyId.trim() && privateKey.includes("PRIVATE KEY");
  return (
    <div className="setup">
      <h3>Connect Apple Music</h3>
      <p className="hint">
        Apple requires every app that reads Apple Music to have a <b>MusicKit key</b> from an{" "}
        <button className="linklike" onClick={() => platform.openExternal("https://developer.apple.com/programs/")}>
          Apple Developer Program
        </button>{" "}
        membership. Your Apple Music subscription alone is not enough — this is Apple's rule, not ours.
      </p>
      <div className="row">
        <label>
          <input type="radio" checked={mode === "key"} onChange={() => setMode("key")} /> I have a MusicKit key (.p8)
        </label>
        <label>
          <input type="radio" checked={mode === "token"} onChange={() => setMode("token")} /> I have a developer token
        </label>
      </div>
      {mode === "key" ? (
        <>
          <ol>
            <li>
              In{" "}
              <button className="linklike" onClick={() => platform.openExternal("https://developer.apple.com/account/resources/authkeys/list")}>
                Certificates, IDs &amp; Profiles → Keys
              </button>{" "}
              create a key with <b>Media Services (MusicKit)</b> enabled and download the <code>AuthKey_XXXXXXXXXX.p8</code> file.
            </li>
            <li>Your <b>Team ID</b> is shown under Membership details; the <b>Key ID</b> is shown next to the key.</li>
          </ol>
          <div className="form-grid">
            <span>Team ID</span>
            <input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="e.g. A1B2C3D4E5" />
            <span>Key ID</span>
            <input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="e.g. 9Z8Y7X6W5V" />
            <span>Private key</span>
            <span>
              <button onClick={() => fileRef.current?.click()}>{privateKey ? "✓ Key loaded — change…" : "Choose .p8 file…"}</button>
              <input
                ref={fileRef}
                type="file"
                accept=".p8"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(setPrivateKey);
                }}
              />
            </span>
          </div>
          <p className="hint">The key is stored encrypted by your operating system's keychain and only used to sign Apple Music API requests.</p>
        </>
      ) : (
        <textarea className="wide" rows={4} placeholder="Paste a MusicKit developer token (JWT)" value={token} onChange={(e) => setToken(e.target.value)} />
      )}
      <div className="row">
        <button
          className="primary"
          disabled={view.busy || !ready}
          onClick={() => void streaming.configure("apple-music", mode === "token" ? { developerToken: token } : { teamId, keyId, privateKey })}
        >
          {view.busy ? "Checking with Apple…" : "Save & verify"}
        </button>
      </div>
    </div>
  );
}

function ConnectStep({ id, view }: { id: StreamingProviderId; view: ProviderView }) {
  const { streaming } = useApp();
  return (
    <div className="setup">
      <h3>{PROVIDER_NAMES[id]} is set up — sign in to your account</h3>
      <p className="hint">
        Your web browser will open for you to sign in to {PROVIDER_NAMES[id]} and approve <b>read-only</b> access to your library and playlists.
        Then come back here.
      </p>
      <div className="row">
        <button className="primary big" disabled={view.busy} onClick={() => void streaming.connect(id)}>
          {view.busy ? "Waiting for you to sign in in the browser…" : `Connect ${PROVIDER_NAMES[id]} account`}
        </button>
        <button disabled={view.busy} onClick={() => void streaming.disconnect(id, true)}>
          Change credentials
        </button>
      </div>
    </div>
  );
}

function ConnectedView({ id, view }: { id: StreamingProviderId; view: ProviderView }) {
  const { streaming } = useApp();
  const [q, setQ] = useState("");
  return (
    <div className="connected">
      <div className="toolbar">
        <span className="status ok">● {view.status?.account ?? "Connected"}</span>
        {view.status?.detail && <span className="warn">⚠ {view.status.detail}</span>}
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void streaming.search(id, q);
          }}
        >
          <input placeholder={`Search ${PROVIDER_NAMES[id]}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit">Search</button>
        </form>
        <button onClick={() => void streaming.loadPlaylists(id)}>↻</button>
        <button onClick={() => void streaming.disconnect(id)}>Disconnect</button>
      </div>
      <div className="provider-split">
        <ul className="playlists">
          {view.playlists.map((p) => (
            <li key={p.id}>
              <button
                className={view.selected === p.id ? "active" : ""}
                disabled={!p.readable}
                title={p.note}
                onClick={() => void streaming.openPlaylist(id, p.id)}
              >
                {p.name}
                {p.trackCount ? <span className="count">{p.trackCount}</span> : null}
                {!p.readable && " 🔒"}
              </button>
            </li>
          ))}
          {view.playlists.length === 0 && !view.loading && <li className="hint">No playlists</li>}
        </ul>
        <StreamingTracks view={view} />
      </div>
    </div>
  );
}

function StreamingTracks({ view }: { view: ProviderView }) {
  const lib = useLibraryState();
  const { platform } = useApp();
  const index = useMemo(() => buildLocalIndex(lib.tracks), [lib.tracks]);
  const rows = view.tracks.map((t: StreamingTrack) => ({ t, local: index.find(t.title, t.artist) }));
  const matched = rows.filter((r) => r.local).length;
  if (view.loading) return <div className="provider-msg">Loading…</div>;
  if (!view.selected) return <div className="provider-msg">Choose a playlist or search.</div>;
  return (
    <div className="table-wrap">
      <div className="hint match-summary">
        {rows.length} tracks · <b>{matched}</b> found in your local library (loadable)
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>Title</th>
            <th>Artist</th>
            <th>Album</th>
            <th>Time</th>
            <th>Source</th>
            <th>Local file</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, local }) => (
            <tr
              key={t.id}
              className={local ? "" : "stream-only"}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-dbdj-track", JSON.stringify(local ?? toTrackInfo(t)));
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <td>{t.artworkUrl ? <img className="art" src={t.artworkUrl} alt="" loading="lazy" /> : null}</td>
              <td>{t.title}</td>
              <td>{t.artist}</td>
              <td>{t.album}</td>
              <td>{fmtDuration(t.durationMs)}</td>
              <td>
                <span className={`source-badge ${t.provider}`}>{t.provider === "spotify" ? "SPOTIFY" : "APPLE MUSIC"}</span>
              </td>
              <td className="row-actions">
                {local ? (
                  <>
                    <span className="ok-text" title={local.ref}>✓ </span>
                    <LoadButtons track={local} />
                  </>
                ) : (
                  <span className="hint" title="Not in your local library. Streaming audio can't be mixed.">🔒 stream only</span>
                )}
                {t.externalUrl && (
                  <button className="tiny" title="Open in the service's own app" onClick={() => platform.openExternal(t.externalUrl!)}>
                    ↗
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Desktop app updates: a topbar badge when a new version is found, and the
 * "Check for updates" panel on the About page. Desktop only (see electron/updater.ts).
 */
import { useEffect, useState, type ReactNode } from "react";
import type { UpdateStatus } from "../platform/updates";
import { useApp } from "./context";

declare const __APP_VERSION__: string;

const bridge = () => window.dbdjDesktop?.updates;

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    void b.status().then((s) => alive && setStatus(s));
    const off = b.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/** Restart only after confirming if music is playing; the update otherwise installs on quit. */
function useInstall(): () => void {
  const { engine } = useApp();
  return () => {
    const playing = engine.getState().decks.some((d) => d.playing);
    if (playing && !window.confirm("A deck is playing. Restart now to install the update? Playback will stop.")) return;
    void bridge()?.install();
  };
}

export function UpdateBadge({ onOpen }: { onOpen: () => void }) {
  const s = useUpdateStatus();
  const install = useInstall();
  if (!s) return null;
  if (s.state === "ready")
    return (
      <button className="status download" onClick={install} title={`Version ${s.version} is downloaded. Restart to install it (or it installs when you quit).`}>
        ⬆ Restart to update
      </button>
    );
  if (s.state === "available" || s.state === "downloading")
    return (
      <button className="status update-badge" onClick={onOpen} title={`Version ${s.version} is available`}>
        ⬆ v{s.version}
        {s.state === "downloading" ? ` · ${s.percent}%` : " available"}
      </button>
    );
  return null;
}

export function UpdatePanel() {
  const s = useUpdateStatus();
  const install = useInstall();
  const b = bridge();
  if (!b || !s) return null;
  const checking = s.state === "checking";
  const isMac = window.dbdjDesktop?.platform === "darwin";

  let message: ReactNode;
  switch (s.state) {
    case "idle":
      message = "Updates are checked automatically when the app starts.";
      break;
    case "checking":
      message = "Checking for updates…";
      break;
    case "none":
      message = `You're up to date. Last checked ${new Date(s.checkedAt).toLocaleTimeString()}.`;
      break;
    case "available":
      message =
        s.mode === "manual" ? (
          <>
            Version <b>{s.version}</b> is available.{" "}
            {isMac
              ? "Download it, open the .dmg and drag the app to Applications to replace this one. Your library and settings are kept."
              : "Download and run the installer. Your library and settings are kept."}
          </>
        ) : (
          <>Version <b>{s.version}</b> is available.</>
        );
      break;
    case "downloading":
      message = (
        <>
          Downloading version <b>{s.version}</b> in the background… {s.percent}%
        </>
      );
      break;
    case "ready":
      message = (
        <>
          Version <b>{s.version}</b> is ready. Restart to install it now, or it installs automatically when you quit.
        </>
      );
      break;
    case "error":
      message = <span className="warn">Couldn't check for updates: {s.message}</span>;
      break;
  }

  return (
    <div className="update-panel">
      <div>
        <h3>Updates</h3>
        <p className="hint">{message}</p>
      </div>
      <div className="update-actions">
        {s.state === "available" && s.mode === "manual" && (
          <button className="primary" onClick={() => void b.download()}>⬇ Download v{s.version}</button>
        )}
        {s.state === "ready" && <button className="primary" onClick={install}>Restart &amp; install</button>}
        {(s.state === "available" || s.state === "ready") && <button onClick={() => void b.openNotes()}>What's new</button>}
        <button disabled={checking || s.state === "downloading" || s.state === "ready"} onClick={() => void b.check()}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>
    </div>
  );
}

export const appVersion = __APP_VERSION__;

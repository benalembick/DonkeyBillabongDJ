/**
 * "Get the desktop app" (browser mode only). Installers are published as
 * GitHub Release assets with stable names by .github/workflows/release.yml.
 */
import { useEffect, useState } from "react";

declare const __GITHUB_REPO__: string;
declare const __APP_VERSION__: string;

const REPO = __GITHUB_REPO__;
const ASSETS = {
  windows: "DonkeyBillabongDJ-Setup.exe",
  mac: "DonkeyBillabongDJ-macOS.dmg",
} as const;
type Os = keyof typeof ASSETS;

export const releasesPage = () => `https://github.com/${REPO}/releases/latest`;
export const assetUrl = (os: Os) => `https://github.com/${REPO}/releases/latest/download/${ASSETS[os]}`;

export function detectOs(ua = navigator.userAgent): Os | "other" {
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
  return "other";
}

interface ReleaseInfo {
  version: string;
  assets: Partial<Record<Os, number>>; // size in bytes
}

/** Latest release from the GitHub API (CORS-enabled). null = none published / unreachable. */
function useLatestRelease(open: boolean): ReleaseInfo | null | "loading" {
  const [info, setInfo] = useState<ReleaseInfo | null | "loading">("loading");
  useEffect(() => {
    if (!open || !REPO) return;
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (!j) return setInfo(null);
        const assets: ReleaseInfo["assets"] = {};
        for (const a of j.assets ?? []) {
          for (const os of Object.keys(ASSETS) as Os[]) if (a.name === ASSETS[os]) assets[os] = a.size;
        }
        setInfo({ version: String(j.tag_name ?? "").replace(/^v/, ""), assets });
      })
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [open]);
  return info;
}

const mb = (n?: number) => (n ? ` · ${(n / 1048576).toFixed(0)} MB` : "");

export function DownloadDesktopButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="status download" onClick={() => setOpen(true)}>
        ⬇ Get the desktop app
      </button>
      {open && <DownloadDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function DownloadDialog({ onClose }: { onClose: () => void }) {
  const os = detectOs();
  const release = useLatestRelease(true);
  const primary: Os = os === "mac" ? "mac" : "windows";
  const other: Os = primary === "mac" ? "windows" : "mac";
  const label: Record<Os, string> = { windows: "Windows 10/11", mac: "macOS (Apple silicon & Intel)" };
  const published = release !== "loading" && release !== null;
  const has = (o: Os) => published && (release as ReleaseInfo).assets[o] !== undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Download the desktop app" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Donkey Billabong DJ for desktop</h2>
        <p className="hint">
          The desktop app is the full version. Everything in this browser version, plus:
        </p>
        <ul className="benefits">
          <li>Scan whole music folders and keep files referenced on disk</li>
          <li>Choose audio outputs, including the DDJ-SB's headphone channels (4-channel routing)</li>
          <li>Runs reliably in the background, with no browser tab throttling or permission prompts</li>
          <li>Streaming sign-ins stored in your OS keychain</li>
        </ul>

        {release === "loading" && <p className="hint">Checking the latest release…</p>}
        {release === null && (
          <p className="warn">
            No desktop release has been published yet. Releases appear at{" "}
            <a href={releasesPage()} target="_blank" rel="noreferrer">GitHub → Releases</a>.
          </p>
        )}

        <div className="download-row">
          <a
            className={`download-primary ${has(primary) ? "" : "disabled"}`}
            href={has(primary) ? assetUrl(primary) : undefined}
            aria-disabled={!has(primary)}
          >
            ⬇ Download for {label[primary]}
            <small>
              {published ? `v${(release as ReleaseInfo).version}` : `v${__APP_VERSION__}`}
              {published ? mb((release as ReleaseInfo).assets[primary]) : ""}
              {published && !has(primary) ? " · not built for this OS yet" : ""}
            </small>
          </a>
          {has(other) && (
            <a className="download-other" href={assetUrl(other)}>
              Also available for {label[other]}
              {mb((release as ReleaseInfo).assets[other])}
            </a>
          )}
          {os === "other" && <p className="hint">The desktop app runs on Windows and macOS.</p>}
        </div>

        <details>
          <summary>Installing</summary>
          {primary === "windows" ? (
            <p className="hint">
              Run <code>{ASSETS.windows}</code>. If Windows SmartScreen says "Windows protected your PC", choose{" "}
              <b>More info → Run anyway</b>. That appears until the app is code-signed.
            </p>
          ) : (
            <p className="hint">
              Open <code>{ASSETS.mac}</code> and drag the app to Applications. If macOS says it can't verify the developer,
              right-click the app → <b>Open</b> → <b>Open</b>. That appears until the app is notarised by Apple.
            </p>
          )}
          <p className="hint">Close Serato, rekordbox or Mixxx before connecting your DDJ-SB, because only one app can use it at a time.</p>
        </details>
        <p className="hint">
          <a href={releasesPage()} target="_blank" rel="noreferrer">All releases &amp; release notes ↗</a>
        </p>
      </div>
    </div>
  );
}

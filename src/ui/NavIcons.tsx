/** Icons for the main navigation (top bar): drawn in the button's colour, 24 px. */
import type { ReactNode } from "react";

export type NavArea = "decks" | "collections" | "playlists" | "mashups" | "transitions" | "practice" | "streaming" | "lighting" | "production" | "setstudio";

const PATHS: Record<NavArea, ReactNode> = {
  // Two platters: the DJ Deck view.
  decks: (
    <>
      <circle cx="7" cy="12" r="4.5" />
      <circle cx="7" cy="12" r="1" fill="currentColor" />
      <circle cx="17" cy="12" r="4.5" />
      <circle cx="17" cy="12" r="1" fill="currentColor" />
      <path d="M2 4h20M2 20h20" />
    </>
  ),
  // Music library: a note.
  collections: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  // A list with a note.
  playlists: (
    <>
      <path d="M3 6h12M3 11h12M3 16h7" />
      <path d="M17 18V9l4-1" />
      <circle cx="15" cy="18" r="2" />
    </>
  ),
  // Lightning: mashups.
  mashups: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />,
  // An energy arc with a spark: AI Set Studio.
  setstudio: <><path d="M2 19c3 0 4-6 7-6s3 3 5 3 3-9 8-11" /><path d="M18 3v3M16.5 4.5h3" /><circle cx="9" cy="13" r="1.2" fill="currentColor" /><path d="M2 22h20" /></>,
  production: <><path d="M3 5v14M7 8v8M11 3v18M15 7v10M19 5v14M22 9v6" /><path d="M1 12h22" /></>,
  // Two tracks crossing: transitions.
  transitions: (
    <>
      <path d="M3 7h6c4 0 6 10 10 10h2" />
      <path d="M3 17h6c4 0 6-10 10-10h2" />
      <path d="m18 4 3 3-3 3M18 14l3 3-3 3" />
    </>
  ),
  // Target: practice.
  practice: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  // Download tray: combined streaming, conversion and recording sources.
  streaming: <><path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 18h16v3H4z"/></>,
  // Light bulb with rays: lighting.
  lighting: (
    <>
      <path d="M12 6a5 5 0 0 0-3.3 8.8c.7.6 1 1.3 1 2.2h4.6c0-.9.3-1.6 1-2.2A5 5 0 0 0 12 6z" />
      <path d="M10 20h4M12 2v1.5M4.2 5.2l1.1 1.1M19.8 5.2l-1.1 1.1M2.5 11.5H4M20 11.5h1.5" />
    </>
  ),
};

export function NavIcon({ area }: { area: NavArea }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[area]}
    </svg>
  );
}

/** Mixer sliders: the top bar's tools menu (Controller, Diagnostics, Settings, About). */
export function ToolsIcon() {
  return (
    <svg className="tools-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  );
}

/** A document or folder with a plus: the Collection's Add files… / Add folder… buttons. */
export function AddToLibraryIcon({ kind }: { kind: "files" | "folder" }) {
  return (
    <svg className="add-source-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "files"
        ? <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 11v6M9 14h6" /></>
        : <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10.5v6M9 13.5h6" /></>}
    </svg>
  );
}

/** A compact two-track save icon for the header's Manual Mashup action. */
export function SaveMashupIcon() {
  return (
    <svg className="manual-mashup-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h10M4 9h7M4 15h7M4 19h10" />
      <path d="M16 4v11m0 0-3-3m3 3 3-3" />
      <path d="M13 20h6" />
    </svg>
  );
}

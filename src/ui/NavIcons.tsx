/** Icons for the main navigation (top bar): drawn in the button's colour, 24 px. */
import type { ReactNode } from "react";

export type NavArea = "collections" | "playlists" | "mashups" | "transitions" | "practice" | "streaming" | "lighting" | "production";

const PATHS: Record<NavArea, ReactNode> = {
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
  // Broadcast waves: streaming.
  streaming: (
    <>
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
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

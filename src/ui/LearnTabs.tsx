/**
 * Learn sub-menu: shown above every Learn page (Transition Guides, DJ Training, Teach Me: Live Looping,
 * Practice, Practice History) so you can move between them without going back to the Learn home.
 * Same tile style as the Production Studio / Lighting sub-menus; colours match the Learn home cards.
 * Navigation goes through "dbdj:navigate" (App routes it), because the pages live in different places:
 * some in the library pane, some as their own workspaces.
 */
import type { ReactNode } from "react";

export type LearnView = "transitions" | "training" | "teachloop" | "practice" | "history";

const ITEMS: { id: LearnView; label: string; title: string; colour: string; icon: ReactNode }[] = [
  { id: "transitions", label: "Transition Guides", title: "Plan and rehearse transitions", colour: "#ff6bd6", icon: <><path d="M4 8h14m0 0-3-3m3 3-3 3" /><path d="M20 16H6m0 0 3-3m-3 3 3 3" /></> },
  { id: "training", label: "DJ Training", title: "DJ Training Curriculum: seven guided lessons", colour: "#ffd166", icon: <><path d="m12 4 9 4.5-9 4.5-9-4.5z" /><path d="M7 10.5V15c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.5" /><path d="M21 8.5V14" /></> },
  { id: "teachloop", label: "Teach Me: Looping", title: "Teach Me: Live Looping", colour: "#ff9f43", icon: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></> },
  { id: "practice", label: "Practice", title: "Start or continue a mixing challenge", colour: "#39dca0", icon: <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" /></> },
  { id: "history", label: "Practice History", title: "Review your practice sessions", colour: "#4ca8ff", icon: <><path d="M3 17l6-6 4 4 7-7" /><path d="M14 8h6v6" /></> },
];

/** Practice and History are views inside the library's Practice page, so they get their own route names. */
const route = (v: LearnView) => (v === "practice" || v === "history" ? `learn:${v}` : v);
const go = (detail: string) => window.dispatchEvent(new CustomEvent("dbdj:navigate", { detail }));

export function LearnTabs({ active }: { active: LearnView }) {
  return (
    <nav className="learn-tabs" aria-label="Learn">
      <button className="learn-tabs-home" title="All Learn options" onClick={() => go("practice")}>LEARN</button>
      <div className="learn-tab-tiles">
        {ITEMS.map((item) => (
          <button key={item.id} className={`learn-tab${active === item.id ? " active" : ""}`} style={{ ["--tab-c" as string]: item.colour }} aria-current={active === item.id ? "page" : undefined} title={item.title} onClick={() => go(route(item.id))}>
            <svg className="learn-tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{item.icon}</svg>
            <span className="learn-tab-label">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

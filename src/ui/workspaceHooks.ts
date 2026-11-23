/** React bindings for the four-deck workspace store, controller deck layers and soft-takeover pickups. */
import { useCallback, useSyncExternalStore } from "react";

/** True while a CSS media query matches (e.g. a small window), re-rendering when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => (typeof window !== "undefined" && !!window.matchMedia?.(query).matches));
}
import type { LayerState } from "../controllers/layers";
import type { Pickup } from "../controllers/softTakeover";
import type { WorkspacePrefs } from "../workspace/WorkspaceStore";
import type { DeckState } from "../core/engine/DJEngine";
import { useApp, useEngineState } from "./context";
import { useFrameStore } from "./hooks";

export function useWorkspace(): WorkspacePrefs {
  const { workspace } = useApp();
  const subscribe = useCallback((cb: () => void) => workspace.on("change", cb), [workspace]);
  return useSyncExternalStore(subscribe, () => workspace.get());
}

export function useLayerState(): LayerState {
  const { controllers } = useApp();
  return useFrameStore(
    useCallback((cb) => controllers.layers.on("change", cb), [controllers]),
    () => controllers.layers.getState(),
  );
}

/** The decks that are load destinations in the current mode (A, B — or A–D), indexed by deck number. */
export function useWorkspaceDecks(): DeckState[] {
  const s = useEngineState();
  return s.decks.slice(0, useWorkspace().deckMode);
}

const NO_PICKUPS: Pickup[] = [];
export function usePickups(): Pickup[] {
  const { controllers } = useApp();
  return useFrameStore(
    useCallback((cb) => controllers.takeover?.on("change", cb) ?? (() => undefined), [controllers]),
    () => controllers.takeover?.getPickups() ?? NO_PICKUPS,
  );
}

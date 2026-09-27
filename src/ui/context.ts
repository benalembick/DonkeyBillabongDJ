import { createContext, useCallback, useContext } from "react";
import type { App } from "../app/createApp";
import type { EngineState } from "../core/engine/DJEngine";
import type { LibraryState } from "../library/LibraryStore";
import { useFrameStore } from "./hooks";

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("AppContext missing");
  return app;
}

export function useEngineState(): EngineState {
  const { engine } = useApp();
  return useFrameStore(
    useCallback((cb) => engine.on("state", cb), [engine]),
    () => engine.getState(),
  );
}

export function useLibraryState(): LibraryState {
  const { library } = useApp();
  return useFrameStore(
    useCallback((cb) => library.on("change", cb), [library]),
    () => library.getState(),
  );
}

/** Dispatch helper for UI controls. */
export function useSend(): (action: string, value?: number) => void {
  const { bus } = useApp();
  return useCallback((action: string, value = 1) => void bus.send(action, value, "ui"), [bus]);
}

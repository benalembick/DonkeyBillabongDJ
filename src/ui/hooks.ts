import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type Subscribe = (cb: () => void) => () => void;

/**
 * Subscribe React to an engine-side store, coalescing notifications to at most
 * one render per animation frame (controller knobs can emit hundreds of
 * changes per second; the UI does not need them all).
 */
export function useFrameStore<T>(subscribe: Subscribe, getSnapshot: () => T): T {
  const subRef = useRef<Subscribe | null>(null);
  if (!subRef.current) {
    subRef.current = (cb) => {
      let frame = 0;
      const unsub = subscribe(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          cb();
        });
      });
      return () => {
        if (frame) cancelAnimationFrame(frame);
        unsub();
      };
    };
  }
  return useSyncExternalStore(subRef.current, getSnapshot);
}

/** Run `fn` every animation frame while mounted (for playheads, meters, clocks). */
export function useAnimationFrame(fn: (t: number) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = (t: number) => {
      try {
        ref.current(t);
      } catch (err) {
        console.error(err);
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

/** Re-render on an interval (for low-rate diagnostics). */
export function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const t = Math.floor((s * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${t}`;
}

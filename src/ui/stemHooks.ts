import { useEffect, useState } from "react";
import type { StemServiceStatus } from "../stems/StemService";
import { useApp } from "./context";

export function useStemStatus(): StemServiceStatus {
  const { stems } = useApp();
  const [s, setS] = useState(stems.status);
  useEffect(() => {
    setS(stems.status);
    return stems.on("status", setS);
  }, [stems]);
  return s;
}

/** Library ref → cached STEMS state. */
export function useStemIndex(): Record<string, "complete" | "partial"> {
  const { stems } = useApp();
  const [idx, setIdx] = useState(stems.index());
  useEffect(() => {
    setIdx(stems.index());
    return stems.on("index", setIdx);
  }, [stems]);
  return idx;
}

/** Library ref → background separation progress (0..1), for refs currently being analysed. */
export function useStemProgress(): Record<string, number> {
  const { stems } = useApp();
  const [p, setP] = useState(stems.libraryProgress());
  useEffect(() => {
    setP(stems.libraryProgress());
    return stems.on("libraryProgress", setP);
  }, [stems]);
  return p;
}

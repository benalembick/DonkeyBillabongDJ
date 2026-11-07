import { useLayoutEffect, useRef, useState } from "react";

/**
 * Clamps a fixed-position context menu so it never renders past the window edge, by measuring
 * its actual rendered size after mount — a hardcoded height guess underestimates menus with a
 * variable number of items (e.g. a track's right-click menu is much taller when STEMS/discovery
 * actions are available), letting the bottom of the menu render off-screen with nothing to click.
 */
export function useMenuPosition(x: number, y: number): { ref: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);
  return { ref, style: { left: pos.left, top: pos.top } };
}

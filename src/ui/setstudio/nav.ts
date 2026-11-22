/**
 * Open a part of AI Set Studio from anywhere (track menu, Auto DJ queue, set builder). The request is
 * kept until the workspace mounts and reads it, so it survives the navigation itself.
 */
export type StudioTab = "sets" | "autocue" | "lab" | "groups" | "intel";
export interface StudioRequest { tab: StudioTab; ref?: string; outRef?: string; inRef?: string; setId?: string | null; fromSlotId?: string | null; toSlotId?: string | null }

let pending: StudioRequest | null = null;
export function openStudio(req: StudioRequest): void {
  pending = req;
  window.dispatchEvent(new CustomEvent("dbdj:navigate", { detail: "setstudio" }));
  window.dispatchEvent(new CustomEvent("dbdj:setstudio", { detail: req }));
}
export function takePending(): StudioRequest | null { const p = pending; pending = null; return p; }

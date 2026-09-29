/**
 * Universe input/output configuration shared by the renderer and the main
 * process. New protocols are added as new OutputKind/InputKind values plus a
 * provider — the DMX engine and the UI don't change.
 */

export type OutputKind = "none" | "artnet" | "sacn" | "usb-pro";
export type InputKind = "none" | "artnet";

export const OUTPUT_LABELS: Record<OutputKind, string> = {
  none: "None",
  artnet: "Art-Net",
  sacn: "sACN / E1.31",
  "usb-pro": "USB DMX (Enttec Pro / Open DMX)",
};
export const INPUT_LABELS: Record<InputKind, string> = { none: "None", artnet: "Art-Net" };

export interface UniverseIo {
  universe: number;
  output: OutputKind;
  input: InputKind;
  artnet: {
    /** Node IP, or a broadcast address (default 255.255.255.255). */
    host: string;
    /** 15-bit Art-Net port-address to send to (default universe − 1). */
    portAddress: number;
    /** Port-address to listen on when Art-Net is the input. */
    inputPortAddress: number;
  };
  sacn: {
    universe: number;
    priority: number;
    /** Optional unicast target; empty = multicast. */
    host?: string;
  };
}

export type LinkState = "disabled" | "connected" | "disconnected" | "sending" | "error" | "unavailable";

export interface IoStatus {
  output: LinkState;
  input: LinkState;
  detail: string;
}

export function defaultIo(universe: number): UniverseIo {
  return {
    universe,
    output: "none",
    input: "none",
    artnet: { host: "255.255.255.255", portAddress: universe - 1, inputPortAddress: universe - 1 },
    sacn: { universe, priority: 100 },
  };
}

/** What happens to the lights when the app closes or an output goes away. */
export type ExitBehaviour = "blackout" | "hold";

/**
 * ON AIR — is a deck actually reaching the master output? Playing and audible are different states:
 * a deck playing with its channel fader closed, muted, or routed away by the crossfader is not on air
 * (it may be cueing in the headphones), and a paused deck whose echo/reverb tail is still sounding is.
 *
 *  - routing: trim × channel fader × crossfader (per its A/THRU/B side) × mute, × master level;
 *  - playback state;
 *  - signal: the channel's post-fader peak (catches FX tails after pause).
 */
/** Below this combined linear gain (-40 dB) a deck counts as routed away. */
export const ON_AIR_GAIN = 0.01;
/** Post-fader peak above this (≈ -50 dBFS) on a stopped deck = a tail still sounding. */
export const TAIL_LEVEL = 0.003;

export type Audibility =
  /** Playing and routed to the master. */
  | "on-air"
  /** Stopped, but its post-fader signal (an FX tail) is still audible on the master. */
  | "tail"
  /** Playing, but the fader / crossfader / mute / master keeps it off the master. */
  | "off-air"
  /** Not playing, nothing sounding. */
  | "stopped";

export interface AudibilityInput {
  playing: boolean;
  /** DJEngine.channelRouting(deck).outputGain (linear). */
  outputGain: number;
  /** Master level as linear gain. */
  masterGain: number;
  /** The channel's post-fader peak level (0..1). */
  level: number;
}

export function audibility(i: AudibilityInput): Audibility {
  const routed = i.outputGain * i.masterGain > ON_AIR_GAIN;
  if (i.playing) return routed ? "on-air" : "off-air";
  return routed && i.level > TAIL_LEVEL ? "tail" : "stopped";
}

export const isOnAir = (a: Audibility) => a === "on-air" || a === "tail";

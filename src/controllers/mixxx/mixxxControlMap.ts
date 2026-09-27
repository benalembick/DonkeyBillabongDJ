/**
 * Translation tables from Mixxx's control vocabulary ([Group], key) to our
 * action ids / feedback keys. These are facts about Mixxx's public control
 * names (documented at https://manual.mixxx.org/latest/en/chapters/appendix/mixxx_controls),
 * not copied code.
 */
import type { InputEncoding } from "../mapping/schema";

export interface MixxxTarget {
  action: string;
  encoding?: InputEncoding;
  note?: string;
}

/** Resolve a Mixxx group to {deck} or {channel}/{sampler}/{fxUnit}. */
export function parseGroup(group: string): { kind: string; index: number } | null {
  let m = /^\[Channel(\d+)\]$/.exec(group);
  if (m) return { kind: "deck", index: Number(m[1]) };
  m = /^\[Sampler(\d+)\]$/.exec(group);
  if (m) return { kind: "sampler", index: Number(m[1]) };
  m = /^\[EffectRack1_EffectUnit(\d+)\]$/.exec(group);
  if (m) return { kind: "fx", index: Number(m[1]) };
  m = /^\[QuickEffectRack1_\[Channel(\d+)\]\]$/.exec(group);
  if (m) return { kind: "quickfx", index: Number(m[1]) };
  m = /^\[EqualizerRack1_\[Channel(\d+)\]_Effect1\]$/.exec(group);
  if (m) return { kind: "eq", index: Number(m[1]) };
  if (group === "[Master]" || group === "[Mixer]") return { kind: "master", index: 0 };
  if (group === "[Playlist]" || group === "[Library]") return { kind: "library", index: 0 };
  return null;
}

const MIXXX_BEATLOOP = /^beatloop_([\d.]+)_(toggle|activate)$/;
const MIXXX_ROLL = /^beatlooproll_([\d.]+)_activate$/;
const MIXXX_HOTCUE = /^hotcue_(\d+)_(activate|clear|gotoandplay|goto)$/;

function normalizeSize(s: string): string {
  return String(Number(s));
}

/** (group, key) → action for input controls. */
export function mapMixxxInput(group: string, key: string): MixxxTarget | null {
  const g = parseGroup(group);
  if (!g) return null;
  const n = g.index;
  const deck = `deck${n}`;
  const ch = `mixer.channel${n}`;

  if (g.kind === "deck") {
    const direct: Record<string, MixxxTarget> = {
      play: { action: `${deck}.play` },
      cue_default: { action: `${deck}.cue` },
      cue_cdj: { action: `${deck}.cue` },
      sync_enabled: { action: `${deck}.sync` },
      beatsync: { action: `${deck}.sync` },
      sync_leader: { action: `${deck}.master` },
      sync_master: { action: `${deck}.master` },
      keylock: { action: `${deck}.keylock` },
      slip_enabled: { action: `${deck}.slip` },
      quantize: { action: `${deck}.quantize` },
      reverse: { action: `${deck}.reverse` },
      reverseroll: { action: `${deck}.reverse` },
      eject: { action: `${deck}.eject` },
      rate: { action: `${deck}.tempo`, encoding: "absolute", note: "Mixxx rate direction depends on the user's rate_dir preference — verify" },
      rate_set_zero: { action: `${deck}.tempo.reset` },
      jog: { action: `${deck}.jog.ring`, encoding: "relative-offset64" },
      wheel: { action: `${deck}.jog.ring`, encoding: "relative-offset64" },
      scratch2_enable: { action: `${deck}.jog.touch` },
      pfl: { action: `${ch}.cue` },
      volume: { action: `${ch}.volume`, encoding: "absolute" },
      pregain: { action: `${ch}.gain`, encoding: "absolute" },
      filterHigh: { action: `${ch}.eq.high`, encoding: "absolute" },
      filterMid: { action: `${ch}.eq.mid`, encoding: "absolute" },
      filterLow: { action: `${ch}.eq.low`, encoding: "absolute" },
      filterHighKill: { action: `${ch}.eq.high.kill` },
      filterMidKill: { action: `${ch}.eq.mid.kill` },
      filterLowKill: { action: `${ch}.eq.low.kill` },
      mute: { action: `${ch}.mute` },
      loop_in: { action: `${deck}.loop.in` },
      loop_out: { action: `${deck}.loop.out` },
      reloop_exit: { action: `${deck}.loop.exit` },
      reloop_toggle: { action: `${deck}.loop.exit` },
      loop_halve: { action: `${deck}.loop.halve` },
      loop_double: { action: `${deck}.loop.double` },
      LoadSelectedTrack: { action: `browser.load.deck${n}` },
    };
    if (direct[key]) return direct[key];
    let m = MIXXX_HOTCUE.exec(key);
    if (m) return { action: m[2] === "clear" ? `${deck}.hotcue.${m[1]}.clear` : `${deck}.hotcue.${m[1]}` };
    m = MIXXX_BEATLOOP.exec(key);
    if (m) return { action: `${deck}.beatloop.${normalizeSize(m[1])}` };
    m = MIXXX_ROLL.exec(key);
    if (m) return { action: `${deck}.beatloop.roll.${normalizeSize(m[1])}` };
    return null;
  }
  if (g.kind === "eq") {
    const band: Record<string, string> = { parameter1: "low", parameter2: "mid", parameter3: "high" };
    if (band[key]) return { action: `${ch}.eq.${band[key]}`, encoding: "absolute" };
    const kill: Record<string, string> = { button_parameter1: "low", button_parameter2: "mid", button_parameter3: "high" };
    if (kill[key]) return { action: `${ch}.eq.${kill[key]}.kill` };
    return null;
  }
  if (g.kind === "quickfx") {
    if (key === "super1") return { action: `${ch}.filter`, encoding: "absolute" };
    return null;
  }
  if (g.kind === "master") {
    const direct: Record<string, MixxxTarget> = {
      crossfader: { action: "mixer.crossfader", encoding: "absolute" },
      headMix: { action: "mixer.headphone.mix", encoding: "absolute" },
      headGain: { action: "mixer.headphone.level", encoding: "absolute" },
      gain: { action: "mixer.master.level", encoding: "absolute" },
    };
    return direct[key] ?? null;
  }
  if (g.kind === "library") {
    const direct: Record<string, MixxxTarget> = {
      SelectTrackKnob: { action: "browser.scroll", encoding: "relative-twos-complement" },
      MoveVertical: { action: "browser.scroll", encoding: "relative-twos-complement" },
      SelectNextPlaylist: { action: "browser.playlist.scroll" },
      SelectPrevPlaylist: { action: "browser.playlist.scroll" },
      GoToItem: { action: "browser.select" },
      LoadSelectedIntoFirstStopped: { action: "browser.load.deck1", note: "Mixxx loads into first stopped deck; mapped to deck A" },
    };
    return direct[key] ?? null;
  }
  if (g.kind === "sampler") {
    const direct: Record<string, string> = { start_play: "play", cue_gotoandplay: "play", play: "play", stop: "stop", LoadSelectedTrack: "load", eject: "eject" };
    return direct[key] ? { action: `sampler${n}.${direct[key]}` } : null;
  }
  if (g.kind === "fx") {
    if (key === "next_chain") return { action: `fx.unit${n}.chain.next` };
    if (key === "prev_chain") return { action: `fx.unit${n}.chain.prev` };
    if (key === "mix" || key === "super1") return { action: `fx.unit${n}.knob`, encoding: "absolute" };
    return null;
  }
  return null;
}

/** (group, key) → feedback key for LED outputs. */
export function mapMixxxOutput(group: string, key: string): string | null {
  const g = parseGroup(group);
  if (!g) return null;
  if (g.kind === "deck") {
    const d = `deck${g.index}`;
    const c = `mixer.channel${g.index}`;
    const direct: Record<string, string> = {
      play: `${d}.playing`,
      play_indicator: `${d}.playing`,
      cue_indicator: `${d}.cue`,
      sync_enabled: `${d}.sync`,
      keylock: `${d}.keylock`,
      pfl: `${c}.cue`,
      mute: `${c}.mute`,
    };
    if (direct[key]) return direct[key];
    const m = /^hotcue_(\d+)_(enabled|status)$/.exec(key);
    if (m) return `${d}.hotcue.${m[1]}`;
  }
  return null;
}

/**
 * Heuristics for <script-binding/> controls: Mixxx executes a JavaScript
 * function for these, which we deliberately never run. We infer intent from
 * the function name; every result is flagged "heuristic" for review.
 */
export interface ScriptGuess extends MixxxTarget {
  /** Present when the function is one half of a 14-bit pair. */
  half?: "msb" | "lsb";
  /** For indexed functions (hot cues etc.) the caller assigns the index. */
  indexed?: "hotcue" | "hotcue.clear" | "beatloop" | "roll" | "sampler";
}

export function guessScriptBinding(fn: string, group: string): ScriptGuess | null {
  const g = parseGroup(group);
  const name = fn.includes(".") ? fn.slice(fn.lastIndexOf(".") + 1) : fn;
  const lower = name.toLowerCase();
  const half: "msb" | "lsb" | undefined = /msb$/i.test(name) ? "msb" : /lsb$/i.test(name) ? "lsb" : undefined;
  const n = g && (g.kind === "deck" || g.kind === "quickfx" || g.kind === "eq") ? g.index : 1;
  const deck = `deck${n}`;
  const ch = `mixer.channel${n}`;
  const withHalf = (t: ScriptGuess): ScriptGuess => (half ? { ...t, half, encoding: "absolute" } : t);

  if (/shift/.test(lower) && /button/.test(lower) && !/(jog|ring|platter|rotary|fx|selector)/.test(lower)) return { action: "modifier.shift" };
  if (/(headphone|pfl)/.test(lower)) return { action: `${ch}.cue` };
  if (/clear.*hot.?cue|hot.?cue.*clear/.test(lower)) return { action: `${deck}.hotcue.?.clear`, indexed: "hotcue.clear" };
  if (/hot.?cue/.test(lower)) return { action: `${deck}.hotcue.?`, indexed: "hotcue" };
  if (/loop.?roll|looproll|beatlooproll/.test(lower)) return { action: `${deck}.beatloop.roll.?`, indexed: "roll" };
  if (/beat.?loop/.test(lower)) return { action: `${deck}.beatloop.?`, indexed: "beatloop" };
  if (/loop.?move.?(back|left)/.test(lower)) return { action: `${deck}.loop.move.back` };
  if (/loop.?move.?(forward|right)/.test(lower)) return { action: `${deck}.loop.move.forward` };
  if (/fx.?knob|effect.?knob/.test(lower)) {
    const unit = g && (g.kind === "fx" || g.kind === "deck") ? g.index : 1;
    return withHalf({ action: /shift/.test(lower) ? `fx.unit${unit}.knob.shift` : `fx.unit${unit}.knob`, encoding: "absolute" });
  }
  if (/loop.?in/.test(lower)) return { action: `${deck}.loop.in` };
  if (/loop.?out/.test(lower)) return { action: `${deck}.loop.out` };
  if (/loop.?(exit|reloop)/.test(lower)) return { action: `${deck}.loop.exit` };
  if (/loop.?halve/.test(lower)) return { action: `${deck}.loop.halve` };
  if (/loop.?double/.test(lower)) return { action: `${deck}.loop.double` };
  if (/jog.*touch|touch.*jog|wheel.*touch/.test(lower)) return { action: `${deck}.jog.touch` };
  if (/jog|platter|wheel/.test(lower)) {
    const shifted = /shift/.test(lower);
    if (shifted) return { action: `${deck}.jog.search`, encoding: "relative-offset64" };
    if (/ring/.test(lower)) return { action: `${deck}.jog.ring`, encoding: "relative-offset64" };
    return { action: `${deck}.jog.platter`, encoding: "relative-offset64" };
  }
  if (/(rotary|selector|browse)/.test(lower) && /(click|push|press)/.test(lower)) {
    return { action: /shift/.test(lower) ? "browser.back" : "browser.select" };
  }
  if (/(rotary|selector|browse|scroll)/.test(lower)) {
    return { action: /shift/.test(lower) ? "browser.playlist.scroll" : "browser.scroll", encoding: "relative-twos-complement" };
  }
  if (/load/.test(lower)) return { action: `browser.load.deck${n}` };
  if (/reverse|censor/.test(lower)) return { action: `${deck}.reverse` };
  if (/play/.test(lower)) return { action: `${deck}.play` };
  if (/cue/.test(lower)) return { action: `${deck}.cue` };
  if (/sync/.test(lower)) return { action: `${deck}.sync` };
  if (/key.?lock/.test(lower)) return { action: `${deck}.keylock` };
  if (/vinyl|scratch/.test(lower)) return { action: `${deck}.vinyl` };
  if (/slip/.test(lower)) return { action: `${deck}.slip` };
  if (/quantize/.test(lower)) return { action: `${deck}.quantize` };
  if (/brake/.test(lower)) return { action: `${deck}.brake` };
  if (/(low|mid|high)kill/.test(lower)) {
    const band = /low/.test(lower) ? "low" : /mid/.test(lower) ? "mid" : "high";
    return { action: `${ch}.eq.${band}.kill` };
  }
  if (/mute/.test(lower)) return { action: `${ch}.mute` };
  if (/tempo|pitch|^rate|rate(slider|fader|knob)/.test(lower)) return withHalf({ action: `${deck}.tempo`, encoding: "absolute" });
  if (/(deck|channel|volume).*fader|volume/.test(lower)) return withHalf({ action: `${ch}.volume`, encoding: "absolute" });
  if (/(filter|eq).?high|high.?(knob|eq)|treble/.test(lower)) return withHalf({ action: `${ch}.eq.high`, encoding: "absolute" });
  if (/(filter|eq).?mid|mid.?(knob|eq)/.test(lower)) return withHalf({ action: `${ch}.eq.mid`, encoding: "absolute" });
  if (/(filter|eq).?low|low.?(knob|eq)|bass/.test(lower)) return withHalf({ action: `${ch}.eq.low`, encoding: "absolute" });
  if (/gain|trim/.test(lower)) return withHalf({ action: `${ch}.gain`, encoding: "absolute" });
  if (/filter/.test(lower)) return withHalf({ action: `${ch}.filter`, encoding: "absolute" });
  if (/crossfader/.test(lower)) return withHalf({ action: "mixer.crossfader", encoding: "absolute" });
  return null;
}

/** Waveform Style selector (Dual-Deck Tonal | Simple | Filtered | RGB | RGB L/R | HSV). Applies instantly and is remembered. */
import { setLayout, useLayout } from "./layout";
import { WAVE_STYLES } from "./waveStyle";
import { EQ_HIGH_HZ, EQ_LOW_HZ } from "../core/engine/mixerMath";

const hz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);

export function WaveStylePicker({ compact = false }: { compact?: boolean }) {
  const { waveStyle } = useLayout();
  return (
    <div className={`layout-switch wave-style-picker ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Waveform style">
      {WAVE_STYLES.map((s) => (
        <button key={s.id} role="radio" aria-checked={waveStyle === s.id} className={waveStyle === s.id ? "active" : ""} title={s.title} onClick={() => setLayout({ waveStyle: s.id })}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function WaveformSettings() {
  const { waveStyle, waveEqReactive } = useLayout();
  const current = WAVE_STYLES.find((s) => s.id === waveStyle);
  return (
    <fieldset>
      <legend>WAVEFORM</legend>
      <div className="row">
        <span>Waveform Style</span>
        <WaveStylePicker />
      </div>
      <p className="hint">{current?.title}</p>
      <label title="Cutting a deck's LOW / MID / HIGH EQ (or Auto EQ doing it) fades that band from the deck's waveforms. Display only — the audio and the stored analysis are never changed.">
        <span>Waveforms follow the deck EQ</span>
        <input type="checkbox" checked={waveEqReactive} onChange={(e) => setLayout({ waveEqReactive: e.target.checked })} />
      </label>
      <p className="hint">
        Bands (the channel EQ's own crossovers): low below {hz(EQ_LOW_HZ)}, mid {hz(EQ_LOW_HZ)}–{hz(EQ_HIGH_HZ)}, high above {hz(EQ_HIGH_HZ)}. Dual-Deck Tonal draws deck A in blue and deck B in amber from the same analysis, whichever
        deck a track is on. Applies to both decks, the overview and the scrolling waveform in every layout. The STD / STEM button on each waveform still switches to
        the four STEMS lanes.
      </p>
    </fieldset>
  );
}

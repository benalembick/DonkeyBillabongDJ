/** Waveform Style selector (Simple | Filtered | RGB | RGB L/R | HSV). Applies instantly and is remembered. */
import { setLayout, useLayout } from "./layout";
import { WAVE_STYLES } from "./waveStyle";

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
  const { waveStyle } = useLayout();
  const current = WAVE_STYLES.find((s) => s.id === waveStyle);
  return (
    <fieldset>
      <legend>WAVEFORM</legend>
      <div className="row">
        <span>Waveform Style</span>
        <WaveStylePicker />
      </div>
      <p className="hint">{current?.title}</p>
      <p className="hint">
        Bands: low ≈ 20–250 Hz, mid ≈ 250 Hz–4 kHz, high ≈ 4–20 kHz. Applies to both decks, the overview and the scrolling waveform in every layout. The STD / STEM
        button on each waveform still switches to the four STEMS lanes.
      </p>
    </fieldset>
  );
}

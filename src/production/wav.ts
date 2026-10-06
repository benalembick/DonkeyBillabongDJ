/** `right` omitted = mono file (vocal takes). */
export interface RenderPcm { sampleRate: number; left: Float32Array; right?: Float32Array }

/** Encodes PCM (stereo, or mono when `right` is omitted) as a standards-compliant 16-bit WAV. */
export function encodeWav(pcm: RenderPcm): ArrayBuffer {
  const channels = pcm.right ? [pcm.left, pcm.right] : [pcm.left]; const count = channels.length;
  const frames = Math.min(...channels.map((c) => c.length)); const block = count * 2;
  const out = new ArrayBuffer(44 + frames * block);
  const view = new DataView(out);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * block, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
  view.setUint32(24, pcm.sampleRate, true); view.setUint32(28, pcm.sampleRate * block, true);
  view.setUint16(32, block, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * block, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(p, x < 0 ? x * 32768 : x * 32767, true); p += 2;
    }
  }
  return out;
}

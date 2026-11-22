/** Drum transcription off the UI thread. Cancellation = the service terminates this worker. */
import { transcribeDrums, type TranscribeOptions } from "./transcribe";

self.onmessage = async (e: MessageEvent<{ id: number; data: Float32Array; rate: number; options: TranscribeOptions }>) => {
  const { id, data, rate, options } = e.data; const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const result = await transcribeDrums(data, rate, options, { onProgress: (stage, progress) => post({ id, stage, progress }) });
    post({ id, result });
  } catch (err) { post({ id, error: err instanceof Error ? err.message : String(err) }); }
};

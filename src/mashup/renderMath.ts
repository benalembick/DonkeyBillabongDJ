export interface RenderTimelineSource {
  sampleRate: number;
  sampleCount: number;
  bpm: number;
  entry: number;
}

/** Output time needed to play every remaining sample after tempo matching. */
export function mashupDuration(targetBpm: number, ...sources: RenderTimelineSource[]): number {
  return Math.max(0, ...sources.map((source) => {
    const sourceDuration = source.sampleCount / source.sampleRate;
    const playbackRate = source.bpm > 0 ? targetBpm / source.bpm : 1;
    return Math.max(0, sourceDuration - source.entry) / playbackRate;
  }));
}

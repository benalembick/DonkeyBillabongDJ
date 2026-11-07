/**
 * Serializes embedded-cue reads/writes per file: an operation always waits for
 * any earlier one queued for that same file, so switching cue source modes
 * back and forth can never observe a write that hasn't landed on disk yet.
 * Operations for different files never block each other.
 */
export class CueIoQueue {
  private tail = new Map<string, Promise<unknown>>();
  run<T>(ref: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail.get(ref) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.tail.set(ref, result.catch(() => undefined));
    return result;
  }
}

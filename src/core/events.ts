/**
 * Minimal typed event emitter used by every layer. Listener exceptions are
 * isolated so a misbehaving subscriber (e.g. a UI component) can never break
 * the emitter's caller (e.g. the audio or controller engines).
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const l of set) {
      try {
        l(payload);
      } catch (err) {
        // Never propagate: resilience requirement (UI errors must not stop audio/controllers).
        console.error(`[events] listener for "${String(event)}" threw`, err);
      }
    }
  }
}

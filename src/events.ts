// Tiny typed event bus shared by all modules (owned by the lead).
export class Emitter<T extends { [K in keyof T]: unknown }> {
  private listeners = new Map<keyof T, Set<(payload: never) => void>>();

  on<K extends keyof T>(type: K, fn: (payload: T[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  once<K extends keyof T>(type: K, fn: (payload: T[K]) => void): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof T>(type: K, payload: T[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: T[K]) => void)(payload);
      } catch (e) {
        // One bad listener must never take down the frame loop.
        console.error(`[events] listener for "${String(type)}" threw`, e);
      }
    }
  }
}

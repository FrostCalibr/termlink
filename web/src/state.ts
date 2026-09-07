/**
 * Minimal observable store. Values are replaced wholesale (immutable-style);
 * views subscribe via {@link Store.subscribe} and read the latest snapshot.
 */

export type Listener<T> = (state: T) => void;

export class Store<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.emit();
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.value);
      } catch {
        /* a broken listener must never silence the rest */
      }
    }
  }
}

/** Tiny typed emitter for per-object events (used by terminal sessions). */
export type Handler<T = undefined | void> = T extends undefined
  ? () => void
  : (payload: T) => void;

export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set<(payload: never) => void>();
    set.add(handler as (payload: never) => void);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload as never);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
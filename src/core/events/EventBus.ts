import type { PlatformEventName, PlatformEvents } from './eventTypes';

type Handler<T> = (payload: T) => void;

/**
 * core/events — the centre of the platform.
 *
 * Nothing in core/ should call directly into another subsystem when an
 * event is more appropriate. Subsystems publish what happened; anything
 * that cares (Notifier, Analytics, Journal, the UI store) subscribes.
 */
export class EventBus {
  private handlers = new Map<PlatformEventName, Set<Handler<unknown>>>();
  private history: { name: PlatformEventName; payload: unknown; at: string }[] = [];
  private readonly maxHistory = 500;

  on<K extends PlatformEventName>(name: K, handler: Handler<PlatformEvents[K]>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as Handler<unknown>);
    this.handlers.set(name, set);
    return () => set.delete(handler as Handler<unknown>);
  }

  emit<K extends PlatformEventName>(name: K, payload: PlatformEvents[K]): void {
    this.history.push({ name, payload, at: new Date().toISOString() });
    if (this.history.length > this.maxHistory) this.history.shift();
    this.handlers.get(name)?.forEach((h) => h(payload));
  }

  recentHistory(limit = 50) {
    return this.history.slice(-limit);
  }
}

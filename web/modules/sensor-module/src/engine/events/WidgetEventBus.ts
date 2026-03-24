import type { EventAction, EventHandler, WidgetEventPayload } from './types';

export class WidgetEventBus {
  private handlers = new Map<EventAction, Set<EventHandler>>();

  register(action: EventAction, handler: EventHandler): () => void {
    if (!this.handlers.has(action)) this.handlers.set(action, new Set());
    this.handlers.get(action)!.add(handler);
    return () => {
      this.handlers.get(action)?.delete(handler);
    };
  }

  dispatch(event: WidgetEventPayload): void {
    this.handlers.get(event.action)?.forEach((h) => h(event));
  }

  clear(): void {
    this.handlers.clear();
  }
}

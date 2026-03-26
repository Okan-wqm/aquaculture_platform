/**
 * Bidirectional message bridge between our React runtime and FUXA
 * widget iframes. Handles postMessage communication with:
 *
 * - Origin validation (only accept messages from our iframes)
 * - Rate limiting (max 100 msgs/sec per widget to prevent flooding)
 * - Value type validation (reject non-primitive values)
 * - Batched outbound sends via requestAnimationFrame
 *
 * Architecture: Each FuxaWidgetRenderer instance creates its own
 * bridge. The bridge subscribes to TagValueBus for the widget's
 * bound tags and forwards value changes to the iframe via putValue.
 * When the iframe emits postValue (e.g., user drags a knob),
 * the bridge publishes the value back to TagValueBus.
 *
 * Security considerations:
 * - The iframe has sandbox="allow-scripts" (no allow-same-origin),
 *   so its origin is always 'null'. We validate message.source
 *   matches the iframe's contentWindow instead.
 * - Only primitive values (string, number, boolean) are accepted.
 * - The bridge does NOT sanitize SVG content; that responsibility
 *   belongs to the iframe sandbox itself.
 */

import type { FuxaInboundMessage, FuxaOutboundMessage } from './types';
import type { TagValueBus } from '../../../engine/tags/TagValueBus';

/** Maximum messages per second before throttling kicks in */
const MAX_MESSAGES_PER_SECOND = 100;

/** Primitive value type accepted by the bridge */
type PrimitiveValue = string | number | boolean;

/**
 * Validates that a value is a safe primitive for postMessage transport.
 * Rejects objects, arrays, functions, symbols, undefined, and null.
 */
function isPrimitive(value: unknown): value is PrimitiveValue {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

export type FuxaOutboundHandler = (msg: FuxaOutboundMessage) => void;

export class FuxaMessageBridge {
  private iframe: HTMLIFrameElement;
  private tagBus: TagValueBus | null;
  private handlers: Set<FuxaOutboundHandler> = new Set();
  private tagUnsubscribers: Array<() => void> = [];
  private disposed = false;

  /* ---------------------------------------------------------------- */
  /*  Rate limiting state                                              */
  /* ---------------------------------------------------------------- */
  private messageCount = 0;
  private messageCountResetTimer: ReturnType<typeof setInterval> | null = null;

  /* ---------------------------------------------------------------- */
  /*  Outbound batching state                                          */
  /* ---------------------------------------------------------------- */
  private pendingMessages: FuxaInboundMessage[] = [];
  private rafHandle: number | null = null;

  /* ---------------------------------------------------------------- */
  /*  Bound listener reference (for cleanup)                           */
  /* ---------------------------------------------------------------- */
  private boundMessageListener: ((event: MessageEvent) => void) | null = null;

  constructor(iframe: HTMLIFrameElement, tagBus: TagValueBus | null) {
    this.iframe = iframe;
    this.tagBus = tagBus;

    // Start rate limit counter reset interval (every 1 second)
    this.messageCountResetTimer = setInterval(() => {
      this.messageCount = 0;
    }, 1000);

    // Listen for messages from the iframe
    this.boundMessageListener = this.handleIncomingMessage.bind(this);
    window.addEventListener('message', this.boundMessageListener);
  }

  /* ---------------------------------------------------------------- */
  /*  Outbound: send values INTO the iframe                            */
  /* ---------------------------------------------------------------- */

  /**
   * Queues a putValue message for the iframe. Messages are batched
   * and sent together on the next requestAnimationFrame to avoid
   * overwhelming the iframe with rapid-fire updates (e.g., when
   * multiple tags update simultaneously).
   */
  sendValue(id: string, value: PrimitiveValue): void {
    if (this.disposed) return;
    if (!isPrimitive(value)) return;

    // Rate limit check
    if (this.messageCount >= MAX_MESSAGES_PER_SECOND) return;

    const message: FuxaInboundMessage = { type: 'putValue', id, value };
    this.pendingMessages.push(message);

    // Schedule batch flush if not already scheduled
    if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(() => {
        this.flushPendingMessages();
      });
    }
  }

  /**
   * Sends all queued messages to the iframe in a single rAF cycle.
   * Each message is sent individually via postMessage because the
   * FUXA relay script processes them one at a time.
   */
  private flushPendingMessages(): void {
    this.rafHandle = null;
    if (this.disposed) return;

    const contentWindow = this.iframe.contentWindow;
    if (!contentWindow) return;

    for (const msg of this.pendingMessages) {
      if (this.messageCount >= MAX_MESSAGES_PER_SECOND) break;
      contentWindow.postMessage(msg, '*');
      this.messageCount++;
    }

    this.pendingMessages = [];
  }

  /* ---------------------------------------------------------------- */
  /*  Inbound: receive values FROM the iframe                          */
  /* ---------------------------------------------------------------- */

  /**
   * Registers a handler for outbound messages from the FUXA iframe.
   * Multiple handlers can be registered (e.g., config panel + runtime).
   */
  onMessage(handler: FuxaOutboundHandler): void {
    this.handlers.add(handler);
  }

  /**
   * Removes a previously registered message handler.
   */
  offMessage(handler: FuxaOutboundHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Processes incoming postMessage events from the iframe.
   *
   * Security: We validate that the message source matches our iframe's
   * contentWindow. Since the iframe has no allow-same-origin, its
   * origin is 'null', so we cannot rely on origin checking alone.
   */
  private handleIncomingMessage(event: MessageEvent): void {
    if (this.disposed) return;

    // Source validation: only accept messages from our iframe
    if (event.source !== this.iframe.contentWindow) return;

    const data = event.data as Record<string, unknown> | undefined;
    if (!data || data.type !== 'postValue') return;

    // Value type validation: only accept primitives
    if (!isPrimitive(data.value)) return;
    if (typeof data.id !== 'string') return;

    const outboundMsg: FuxaOutboundMessage = {
      type: 'postValue',
      id: data.id as string,
      value: data.value as PrimitiveValue,
    };

    // Rate limit inbound messages as well
    if (this.messageCount >= MAX_MESSAGES_PER_SECOND) return;
    this.messageCount++;

    // Notify all registered handlers
    for (const handler of this.handlers) {
      handler(outboundMsg);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Tag binding: connects tag values to iframe variables             */
  /* ---------------------------------------------------------------- */

  /**
   * Binds a tag to a FUXA variable. When the tag value changes on
   * TagValueBus, the new value is forwarded to the iframe via putValue.
   *
   * Returns an unsubscribe function for cleanup.
   */
  bindTag(variableId: string, tagName: string): () => void {
    if (!this.tagBus) return () => {};

    // Send current value immediately if available
    const currentValue = this.tagBus.getLatest(tagName);
    if (isPrimitive(currentValue)) {
      this.sendValue(variableId, currentValue);
    }

    // Subscribe to future updates
    const unsub = this.tagBus.subscribe(tagName, (value: unknown) => {
      if (isPrimitive(value)) {
        this.sendValue(variableId, value);
      }
    });

    this.tagUnsubscribers.push(unsub);
    return unsub;
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Cleans up all resources: event listeners, tag subscriptions,
   * pending rAF, and rate limit timer. Must be called when the
   * widget unmounts to prevent memory leaks.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Remove window message listener
    if (this.boundMessageListener) {
      window.removeEventListener('message', this.boundMessageListener);
      this.boundMessageListener = null;
    }

    // Cancel pending rAF
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    // Clear rate limit timer
    if (this.messageCountResetTimer !== null) {
      clearInterval(this.messageCountResetTimer);
      this.messageCountResetTimer = null;
    }

    // Unsubscribe all tag bindings
    for (const unsub of this.tagUnsubscribers) {
      unsub();
    }
    this.tagUnsubscribers = [];

    // Clear handlers and pending messages
    this.handlers.clear();
    this.pendingMessages = [];
  }
}

/**
 * TagSubscriptionManager — Client-side subscription tracker with ref-counting.
 *
 * Design goals:
 *  - Track which component (by componentId) needs which tagIds
 *  - Reference-count each tagId: a tag stays subscribed on the socket while
 *    at least one component needs it
 *  - Debounced batch flush: rapid subscribe/unsubscribe calls within the
 *    debounce window are coalesced into a single socket emit
 *  - Pure class — no React dependency, easily unit-testable
 */

import { ScadaSocketEvent } from '../types/scada-runtime.types';
import { type ScadaSocketService } from './ScadaSocketService';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Called with the batch of tagIds that need to be sent to the server. */
type FlushCallback = (toSubscribe: string[], toUnsubscribe: string[]) => void;

// ── Class ─────────────────────────────────────────────────────────────────────

export class TagSubscriptionManager {
  /**
   * Map<componentId, Set<tagId>> — what each component currently wants.
   */
  private componentTags = new Map<string, Set<string>>();

  /**
   * Map<tagId, refCount> — how many components reference this tag.
   */
  private tagRefCounts = new Map<string, number>();

  /**
   * Tags that are currently active on the server (sent via subscribe emit).
   */
  private activeServerTags = new Set<string>();

  /**
   * Pending changes since the last flush.
   */
  private pendingSubscribe = new Set<string>();
  private pendingUnsubscribe = new Set<string>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly onFlush: FlushCallback;

  constructor(onFlush: FlushCallback, debounceMs = 50) {
    this.onFlush = onFlush;
    this.debounceMs = debounceMs;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Declare that `componentId` needs the given `tagIds`.
   * New tags (not already in the component's set) get their ref counts bumped.
   * Tags removed from the component's set get their ref counts decremented.
   */
  subscribe(componentId: string, tagIds: string[]): void {
    const incoming = new Set(tagIds);
    const existing = this.componentTags.get(componentId) ?? new Set<string>();

    // Tags added by this component
    for (const tagId of incoming) {
      if (!existing.has(tagId)) {
        this._incrementRef(tagId);
      }
    }

    // Tags removed by this component (component narrowed its subscription)
    for (const tagId of existing) {
      if (!incoming.has(tagId)) {
        this._decrementRef(tagId);
      }
    }

    this.componentTags.set(componentId, incoming);
    this._scheduledFlush();
  }

  /**
   * Declare that `componentId` no longer needs any tags.
   * Decrements ref counts for all previously registered tags.
   */
  unsubscribe(componentId: string): void {
    const existing = this.componentTags.get(componentId);
    if (!existing) return;

    for (const tagId of existing) {
      this._decrementRef(tagId);
    }

    this.componentTags.delete(componentId);
    this._scheduledFlush();
  }

  /**
   * Returns the full list of tagIds that are currently active on the server.
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.activeServerTags);
  }

  /**
   * Force an immediate flush (useful on reconnect to re-subscribe everything).
   */
  flushNow(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this._flush();
  }

  /**
   * Re-subscribe all currently active tags (e.g. after a reconnect).
   * Bypasses debounce so subscriptions are restored immediately.
   */
  resubscribeAll(): void {
    const all = Array.from(this.tagRefCounts.keys()).filter(
      (tagId) => (this.tagRefCounts.get(tagId) ?? 0) > 0,
    );
    if (all.length > 0) {
      this.onFlush(all, []);
      all.forEach((tagId) => this.activeServerTags.add(tagId));
    }
  }

  // ── View-oriented convenience API ──────────────────────────────────────────
  // These are thin aliases over subscribe/unsubscribe using a viewId as the
  // componentId, providing a more domain-specific name for SCADA views.

  /**
   * Register a view and subscribe to the tags used by its widgets.
   * If the view was previously registered the tag list is replaced (diff is
   * computed automatically by the underlying subscribe logic).
   */
  registerView(viewId: string, tagIds: string[]): void {
    this.subscribe(viewId, tagIds);
  }

  /**
   * Unregister a view and release all its tag subscriptions.
   */
  unregisterView(viewId: string): void {
    this.unsubscribe(viewId);
  }

  /**
   * Returns the tag IDs currently registered for a specific view.
   */
  getViewSubscriptions(viewId: string): string[] {
    const tags = this.componentTags.get(viewId);
    return tags ? Array.from(tags) : [];
  }

  /**
   * Reset all state (e.g. on provider teardown).
   *
   * The /scada socket is a shared singleton that stays connected across a
   * provider unmount (it is torn down only on logout / tenant switch), so we
   * MUST tell the server to drop every tag we still hold active before clearing
   * local tracking. Otherwise a provider teardown strands those subscriptions
   * server-side — the server keeps streaming tags no client wants (RT-010). If
   * the socket is already gone (logout teardown) the emit is a harmless no-op.
   */
  reset(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const active = Array.from(this.activeServerTags);
    if (active.length > 0) {
      this.onFlush([], active);
    }
    this.componentTags.clear();
    this.tagRefCounts.clear();
    this.activeServerTags.clear();
    this.pendingSubscribe.clear();
    this.pendingUnsubscribe.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _incrementRef(tagId: string): void {
    const current = this.tagRefCounts.get(tagId) ?? 0;
    this.tagRefCounts.set(tagId, current + 1);
    if (current === 0) {
      // This tag just became needed.
      this.pendingSubscribe.add(tagId);
      this.pendingUnsubscribe.delete(tagId);
    }
  }

  private _decrementRef(tagId: string): void {
    const current = this.tagRefCounts.get(tagId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.tagRefCounts.delete(tagId);
      // This tag is no longer needed.
      this.pendingUnsubscribe.add(tagId);
      this.pendingSubscribe.delete(tagId);
    } else {
      this.tagRefCounts.set(tagId, next);
    }
  }

  private _scheduledFlush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this._flush();
    }, this.debounceMs);
  }

  private _flush(): void {
    // Only send tags that actually changed state vs the server.
    const toSubscribe = Array.from(this.pendingSubscribe).filter(
      (tagId) => !this.activeServerTags.has(tagId),
    );
    const toUnsubscribe = Array.from(this.pendingUnsubscribe).filter(
      (tagId) => this.activeServerTags.has(tagId),
    );

    this.pendingSubscribe.clear();
    this.pendingUnsubscribe.clear();

    if (toSubscribe.length === 0 && toUnsubscribe.length === 0) return;

    // Update local tracking before the callback so re-entrant flushes are safe.
    toSubscribe.forEach((tagId) => this.activeServerTags.add(tagId));
    toUnsubscribe.forEach((tagId) => this.activeServerTags.delete(tagId));

    this.onFlush(toSubscribe, toUnsubscribe);
  }
}

// ── Factory: create a manager wired to a ScadaSocketService ──────────────────

/**
 * Create a TagSubscriptionManager that emits TAG_SUBSCRIBE / TAG_UNSUBSCRIBE
 * through the provided ScadaSocketService.
 */
export function createTagSubscriptionManager(
  socketService: ScadaSocketService,
  debounceMs = 50,
): TagSubscriptionManager {
  return new TagSubscriptionManager(
    (toSubscribe, toUnsubscribe) => {
      if (toSubscribe.length > 0) {
        socketService.emit(ScadaSocketEvent.TAG_SUBSCRIBE, { tagIds: toSubscribe });
      }
      if (toUnsubscribe.length > 0) {
        socketService.emit(ScadaSocketEvent.TAG_UNSUBSCRIBE, { tagIds: toUnsubscribe });
      }
    },
    debounceMs,
  );
}

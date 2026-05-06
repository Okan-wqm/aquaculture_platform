/**
 * TagManagerService
 *
 * Central in-process store for:
 *  - Per-socket tag subscriptions  (socketId → Set<tagId>)
 *  - Latest tag value cache        (tagId  → TagValueChange)
 *
 * The service is intentionally stateful but NOT persistent; on restart
 * clients must re-subscribe.  Any device-driver that wishes to write a
 * tag value publishes a 'scada.tag.write' event via EventEmitter2 and
 * the appropriate protocol adapter picks it up.
 *
 * Design notes:
 *  - All Maps are kept in-memory; Redis fan-out can be bolted on later
 *    by replacing the Map-level primitives without changing the interface.
 *  - `updateTagValues()` returns a routing map so the gateway can emit
 *    only the deltas each socket subscribed to — avoiding fan-out storms.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import type { TagValueChange } from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Internal event names                                               */
/* ------------------------------------------------------------------ */

/** Emitted when the gateway requests a tag write to a device driver. */
export const SCADA_TAG_WRITE_EVENT = 'scada.tag.write';

/* ------------------------------------------------------------------ */
/*  Supporting interfaces                                              */
/* ------------------------------------------------------------------ */

export interface TagWriteRequest {
  tagId: string;
  value: unknown;
  /** Write function: 'set' (default), 'add', 'remove'. */
  function: 'set' | 'add' | 'remove';
  /** User ID who initiated the write (for audit). */
  userId: string;
  /** Wall-clock timestamp (unix ms). */
  requestedAt: number;
}

/**
 * Result of `updateTagValues()`.
 * Maps each socketId to the slice of TagValueChange[] it needs.
 */
export type TagValueRoutingMap = Map<string, TagValueChange[]>;

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

@Injectable()
export class TagManagerService {
  private readonly logger = new Logger(TagManagerService.name);

  /** socketId → Set of subscribed tagIds */
  private readonly socketSubscriptions = new Map<string, Set<string>>();

  /** tagId → Set of subscribed socketIds (reverse index for O(1) fan-out) */
  private readonly tagSubscribers = new Map<string, Set<string>>();

  /** tagId → most-recent TagValueChange */
  private readonly tagValueCache = new Map<string, TagValueChange>();

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /* ---------------------------------------------------------------- */
  /*  Subscription management                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Register interest in a set of tag IDs for the given socket.
   * Returns the current cached values for newly subscribed tags so the
   * gateway can immediately send them to the client.
   */
  subscribeSocket(socketId: string, tagIds: string[]): TagValueChange[] {
    if (!this.socketSubscriptions.has(socketId)) {
      this.socketSubscriptions.set(socketId, new Set());
    }

    const socketTags = this.socketSubscriptions.get(socketId)!;
    const initialValues: TagValueChange[] = [];

    for (const tagId of tagIds) {
      if (socketTags.has(tagId)) {
        // Already subscribed — still include the cached value if present
        const cached = this.tagValueCache.get(tagId);
        if (cached) initialValues.push(cached);
        continue;
      }

      socketTags.add(tagId);

      // Update reverse index
      if (!this.tagSubscribers.has(tagId)) {
        this.tagSubscribers.set(tagId, new Set());
      }
      this.tagSubscribers.get(tagId)!.add(socketId);

      // Collect current cached value for initial push
      const cached = this.tagValueCache.get(tagId);
      if (cached) {
        initialValues.push(cached);
      }
    }

    this.logger.debug(
      `Socket ${socketId} subscribed to ${tagIds.length} tag(s); ` +
        `total subscriptions: ${socketTags.size}`,
    );

    return initialValues;
  }

  /**
   * Remove interest in specific tag IDs for the given socket.
   */
  unsubscribeSocket(socketId: string, tagIds: string[]): void {
    const socketTags = this.socketSubscriptions.get(socketId);
    if (!socketTags) return;

    for (const tagId of tagIds) {
      socketTags.delete(tagId);

      const subscribers = this.tagSubscribers.get(tagId);
      if (subscribers) {
        subscribers.delete(socketId);
        if (subscribers.size === 0) {
          this.tagSubscribers.delete(tagId);
        }
      }
    }

    this.logger.debug(
      `Socket ${socketId} unsubscribed from ${tagIds.length} tag(s); ` +
        `remaining: ${socketTags.size}`,
    );
  }

  /**
   * Remove ALL subscriptions for a socket (call on disconnect).
   */
  removeSocket(socketId: string): void {
    const socketTags = this.socketSubscriptions.get(socketId);
    if (!socketTags) return;

    for (const tagId of socketTags) {
      const subscribers = this.tagSubscribers.get(tagId);
      if (subscribers) {
        subscribers.delete(socketId);
        if (subscribers.size === 0) {
          this.tagSubscribers.delete(tagId);
        }
      }
    }

    this.socketSubscriptions.delete(socketId);
    this.logger.debug(`Removed all subscriptions for disconnected socket ${socketId}`);
  }

  /* ---------------------------------------------------------------- */
  /*  Reverse lookup                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Returns the list of socketIds that are subscribed to the given tag.
   */
  getSubscribedSockets(tagId: string): string[] {
    const subscribers = this.tagSubscribers.get(tagId);
    return subscribers ? Array.from(subscribers) : [];
  }

  /**
   * Returns all tag IDs the given socket is currently subscribed to.
   */
  getSocketSubscriptions(socketId: string): string[] {
    const tags = this.socketSubscriptions.get(socketId);
    return tags ? Array.from(tags) : [];
  }

  /* ---------------------------------------------------------------- */
  /*  Value cache                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Apply a batch of tag value updates to the cache.
   *
   * Returns a routing map: socketId → TagValueChange[] containing only
   * the values that socket is subscribed to.  The gateway should iterate
   * this map and emit a `TAG_VALUES` event per socket.
   */
  updateTagValues(values: TagValueChange[]): TagValueRoutingMap {
    const routingMap: TagValueRoutingMap = new Map();

    for (const change of values) {
      // Update cache
      this.tagValueCache.set(change.tagId, change);

      // Fan-out: find all sockets subscribed to this tagId
      const subscribers = this.tagSubscribers.get(change.tagId);
      if (!subscribers || subscribers.size === 0) continue;

      for (const socketId of subscribers) {
        if (!routingMap.has(socketId)) {
          routingMap.set(socketId, []);
        }
        routingMap.get(socketId)!.push(change);
      }
    }

    return routingMap;
  }

  /**
   * Write a value to a tag.  The actual I/O is handled by the device-driver
   * layer; this method publishes an internal event that any registered adapter
   * can consume.
   *
   * Intentionally does NOT update the cache — the device driver is expected
   * to echo the confirmed value back via `updateTagValues()`.
   */
  writeTagValue(
    tagId: string,
    value: unknown,
    userId: string,
    writeFunction: 'set' | 'add' | 'remove' = 'set',
  ): void {
    const request: TagWriteRequest = {
      tagId,
      value,
      function: writeFunction,
      userId,
      requestedAt: Date.now(),
    };

    this.logger.debug(
      `Tag write request: tagId=${tagId}, function=${writeFunction}, userId=${userId}`,
    );

    this.eventEmitter.emit(SCADA_TAG_WRITE_EVENT, request);
  }

  /**
   * Get the current cached value for a tag.
   */
  getTagValue(tagId: string): TagValueChange | null {
    return this.tagValueCache.get(tagId) ?? null;
  }

  /**
   * Return all currently cached tag values.
   */
  getAllTagValues(): TagValueChange[] {
    return Array.from(this.tagValueCache.values());
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  /** Number of sockets currently tracked. */
  get connectedSocketCount(): number {
    return this.socketSubscriptions.size;
  }

  /** Number of unique tags currently in the cache. */
  get cachedTagCount(): number {
    return this.tagValueCache.size;
  }

  /** Number of unique tags that have at least one subscriber. */
  get subscribedTagCount(): number {
    return this.tagSubscribers.size;
  }
}

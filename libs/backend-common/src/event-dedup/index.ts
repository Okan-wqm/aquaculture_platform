import { Injectable, Logger, Optional } from '@nestjs/common';

import { RedisService } from '../redis';

/**
 * Shared eventId dedup primitive (SEC-MEDIUM-101 / SEC-LOW-102 —
 * 2026-08-23 scan №46/№47).
 *
 * NATS at-least-once + outbox republish makes duplicate delivery a normal
 * operating condition; projection/notification handlers that mutate state
 * per delivery need a dedup claim. The farm harvest listener carries the
 * correct pattern (Redis SETNX + TTL + fail-open on Redis outage with
 * loud logging); this service promotes it to the zero-effort platform
 * default so every handler gets identical semantics without hand-rolling.
 *
 * Semantics:
 *   - claimEventId(scope, eventId) → true exactly once per (scope, eventId)
 *     within the TTL window.
 *   - Redis outage → true (fail-open: the event processes; the duplicate
 *     risk is the lesser evil vs silently dropping real events).
 *   - TTL defaults to 10 minutes — comfortably above the NATS msgID dedup
 *     window (2 min) + ack_wait × max_deliver horizon for the platform's
 *     durable consumers.
 */
export const EVENT_DEDUP_DEFAULT_TTL_SECONDS = 600;

@Injectable()
export class EventDedupService {
  private readonly logger = new Logger(EventDedupService.name);

  constructor(@Optional() private readonly redisService?: RedisService) {}

  /**
   * Attempt to claim an eventId for a named handler scope. Returns true
   * when THIS call is the first delivery (process it); false when a
   * previous delivery already claimed it (skip).
   */
  /**
   * SEC-MEDIUM-101 (№46): apply-if-newer guard — returns true when the
   * candidate timestamp is STRICTLY NEWER than the last-accepted timestamp
   * for this (scope, entity) pair; also records it when accepted.
   */
  async isNewerAndRecord(
    scope: string,
    entityId: string,
    candidateTimestamp: string,
  ): Promise<boolean> {
    if (!this.redisService || !entityId || !candidateTimestamp) {
      return true; // no Redis → accept (projection stays last-write-wins)
    }
    const key = `dedup-ts:${scope}:${entityId}`;
    const candidateMs = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateMs)) {
      return false; // unparseable → reject (fail-closed)
    }
    try {
      const existing = await this.redisService.get(key);
      const existingMs = existing ? Number.parseInt(existing, 10) : 0;
      if (candidateMs <= existingMs) {
        return false;
      }
      await this.redisService.set(key, String(candidateMs), EVENT_DEDUP_DEFAULT_TTL_SECONDS);
      return true;
    } catch (error) {
      this.logger.warn(
        `Newer-check failed for ${scope}/${entityId} (fail-open): ${(error as Error).message}`,
      );
      return true;
    }
  }

  async claimEventId(scope: string, eventId: string, tenantId?: string): Promise<boolean> {
    if (!this.redisService || !eventId) {
      return true;
    }
    const key = tenantId ? `dedup:${scope}:${tenantId}:${eventId}` : `dedup:${scope}:${eventId}`;
    try {
      return await this.redisService.setNx(key, '1', EVENT_DEDUP_DEFAULT_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        `Dedup claim failed for ${scope}/${eventId} (fail-open): ${(error as Error).message}`,
      );
      return true;
    }
  }
}

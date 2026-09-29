import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

/**
 * A command receipt is held by a send that is still in flight — or by one
 * whose process died mid-send, until the receipt lease runs out (V-S1a-6).
 *
 * WHY transient: the 409 used to be classified as permanent (a 409 is a
 * "domain rejection" to the event bus), so a redelivery that arrived while a
 * crashed send still held the receipt dead-lettered the page. The lease
 * (`NOTIFICATION_COMMAND_RECEIPT_LEASE_MS`, bounded below the life-safety
 * backoff cap) guarantees the receipt is free again within one backoff step.
 * Still a `ConflictException`, so the command bus reports it as before.
 */
export class NotificationReceiptHeldError extends ConflictException {
  readonly failureClass = 'transient' as const;

  constructor() {
    super('Notification command is already in progress');
    this.name = 'NotificationReceiptHeldError';
  }
}

/**
 * The tenant rate limiter could not be consulted (Redis down in production)
 * (V-S1a-6). Transient: the limiter comes back, the send is re-driven. It used
 * to be an untyped 400 — a permanent rejection — so a Redis outage dropped
 * every alarm that arrived during it.
 */
export class NotificationRateLimiterUnavailableError extends ServiceUnavailableException {
  readonly failureClass = 'transient' as const;

  constructor(reason: string) {
    super(`Notification rate limiter is unavailable: ${reason}`);
    this.name = 'NotificationRateLimiterUnavailableError';
  }
}

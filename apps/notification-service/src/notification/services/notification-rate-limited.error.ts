import { BadRequestException } from '@nestjs/common';

/**
 * A send refused by the tenant's per-minute notification rate limit.
 *
 * WHY a type of its own (ALERT-CRITICAL-004): the refusal writes no
 * notification row, so the dispatcher's retry scheduler never sees it. A
 * caller that must not lose the send — an escalated alarm — has to tell this
 * refusal apart from a provider failure (which IS persisted and retried) and
 * re-drive it after the window. `failureClass: 'transient'` is the event-bus
 * convention for "redelivery can fix this".
 *
 * WHAT stays the same: it is still a `BadRequestException`, so the
 * notification command bus keeps reporting it as it always did.
 */
export class NotificationRateLimitedError extends BadRequestException {
  readonly failureClass = 'transient' as const;

  constructor() {
    super('Rate limit exceeded. Please try again later.');
    this.name = 'NotificationRateLimitedError';
  }
}

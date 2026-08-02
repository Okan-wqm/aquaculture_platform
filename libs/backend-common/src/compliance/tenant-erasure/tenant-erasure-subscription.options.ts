import type { SubscriptionOptions } from '@platform/event-bus';

/**
 * Erasure requests are compliance commands, not ephemeral notifications.
 *
 * `tenant-erasure-v2` intentionally creates a new durable consumer instead
 * of attempting the unsupported DeliverPolicy.New -> DeliverPolicy.All
 * mutation on the legacy durable during a rolling deployment.
 */
export const TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS = Object.freeze({
  durable: true,
  consumerVersion: 'tenant-erasure-v2',
  startFrom: 'beginning',
  ackWait: 60,
  maxRetries: -1,
}) satisfies Readonly<SubscriptionOptions>;

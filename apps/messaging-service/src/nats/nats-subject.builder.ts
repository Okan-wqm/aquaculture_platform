/**
 * @module NatsSubjectBuilder
 * @description Builds tenant-scoped NATS subject patterns for the messaging service.
 *
 * SECURITY: All messaging events MUST include tenantId in the NATS subject
 * hierarchy to enable per-tenant filtering and prevent cross-tenant event
 * subscription.
 *
 * Subject format: `events.{tenantId}.{eventType}`
 * Subscribe pattern: `events.{tenantId}.*` (all events for a tenant)
 *                    `events.*.{eventType}` (all tenants for an event type)
 *
 * @see MSG-HIGH-051 (NATS subject missing tenantId segment)
 */

/**
 * Build a tenant-scoped NATS subject for publishing.
 *
 * @param tenantId - Tenant identifier (UUID)
 * @param eventType - Event type name (PascalCase)
 * @returns Fully qualified NATS subject string
 */
export function buildMessagingSubject(
  tenantId: string,
  eventType: string,
): string {
  if (!tenantId) {
    throw new Error(
      `SECURITY: Cannot build NATS subject without tenantId for event ${eventType}`,
    );
  }
  if (!eventType) {
    throw new Error('Cannot build NATS subject without eventType');
  }
  return `events.${tenantId}.${eventType}`;
}

/**
 * Build a NATS subscribe pattern for all events of a specific tenant.
 *
 * @param tenantId - Tenant identifier
 * @returns NATS subscribe pattern
 */
export function buildTenantSubscribePattern(tenantId: string): string {
  return `events.${tenantId}.*`;
}

/**
 * Build a NATS subscribe pattern for a specific event type across all tenants.
 *
 * @param eventType - Event type name
 * @returns NATS subscribe pattern
 */
export function buildEventTypeSubscribePattern(eventType: string): string {
  return `events.*.${eventType}`;
}

/**
 * Extract the tenantId from a tenant-scoped messaging NATS subject.
 * Returns undefined if the subject does not match the expected format.
 *
 * @param subject - NATS subject string
 * @returns tenantId or undefined
 */
export function extractTenantFromSubject(subject: string): string | undefined {
  const segments = subject.split('.');
  // Expected: events.{tenantId}.{eventType}
  if (segments.length === 3 && segments[0] === 'events') {
    const tenantId = segments[1];
    if (tenantId && tenantId !== '*' && tenantId !== '>') {
      return tenantId;
    }
  }
  return undefined;
}

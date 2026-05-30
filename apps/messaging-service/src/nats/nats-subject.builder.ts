/**
 * Messaging NATS subject builder.
 *
 * Thin compatibility wrapper around the platform event-bus subject SSOT.
 * New messaging event flow uses:
 *
 *   events.{tenantId}.{eventType}
 *
 * The legacy `messaging.{tenantId}.{eventType}` namespace is intentionally not
 * emitted here.
 */

import {
  buildTenantEventSubject,
  buildTenantWildcardSubject,
  buildWildcardEventSubject,
  parseTenantEventSubject,
} from '@platform/event-bus';

export function buildMessagingSubject(
  tenantId: string,
  eventType: string,
): string {
  return buildTenantEventSubject(tenantId, eventType);
}

export function buildTenantSubscribePattern(tenantId: string): string {
  return buildTenantWildcardSubject(tenantId);
}

export function buildEventTypeSubscribePattern(eventType: string): string {
  return buildWildcardEventSubject(eventType);
}

export function extractTenantFromSubject(subject: string): string | undefined {
  const parsed = parseTenantEventSubject(subject);
  if (!parsed || parsed.isSystem) {
    return undefined;
  }
  return parsed.tenantId;
}

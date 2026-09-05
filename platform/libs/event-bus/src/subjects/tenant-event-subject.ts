/**
 * Canonical tenant event subject builder.
 *
 * All durable domain events use exactly three NATS subject segments:
 *
 *   events.{tenantId}.{eventType}
 *
 * `tenantId = system` is reserved for platform-level events that do not belong
 * to a tenant. Wildcards are only emitted by the explicit subscription helpers.
 *
 * The platform segment is spelled once, in the event contract
 * (`PLATFORM_EVENT_TENANT_ID`, SEC-HIGH-057); this module aliases it.
 */
import { PLATFORM_EVENT_TENANT_ID } from '@platform/event-contracts';

export const CANONICAL_EVENT_PREFIX = 'events' as const;
export const SYSTEM_EVENT_TENANT_SEGMENT = PLATFORM_EVENT_TENANT_ID;

const SUBJECT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const EVENT_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]+$/;

export interface TenantEventLike {
  eventType: string;
  tenantId?: string | null;
}

export interface ParsedTenantEventSubject {
  tenantId: string;
  eventType: string;
  isSystem: boolean;
}

export function assertSafeSubjectSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (!SUBJECT_SEGMENT_PATTERN.test(value)) {
    const masked = value.length > 8 ? `${value.slice(0, 8)}...` : value;
    throw new TypeError(
      `${label} contains forbidden NATS subject characters; ` +
        `value masked to first 8 chars: "${masked}"`,
    );
  }
  return value;
}

export function assertSafeEventType(eventType: string): string {
  if (typeof eventType !== 'string' || eventType.length === 0) {
    throw new TypeError('eventType must be a non-empty string');
  }
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    throw new TypeError(
      `eventType must be PascalCase and match ${EVENT_TYPE_PATTERN.source}; ` +
        `got ${JSON.stringify(eventType)}`,
    );
  }
  return eventType;
}

export function buildTenantEventSubject(tenantId: string, eventType: string): string {
  return `${CANONICAL_EVENT_PREFIX}.${assertSafeSubjectSegment(
    tenantId,
    'tenantId',
  )}.${assertSafeEventType(eventType)}`;
}

export function buildSystemEventSubject(eventType: string): string {
  return buildTenantEventSubject(SYSTEM_EVENT_TENANT_SEGMENT, assertSafeEventType(eventType));
}

export function buildWildcardEventSubject(eventType: string): string {
  return `${CANONICAL_EVENT_PREFIX}.*.${assertSafeEventType(eventType)}`;
}

export function buildTenantWildcardSubject(tenantId: string): string {
  return `${CANONICAL_EVENT_PREFIX}.${assertSafeSubjectSegment(tenantId, 'tenantId')}.>`;
}

export function parseTenantEventSubject(subject: string): ParsedTenantEventSubject | null {
  if (typeof subject !== 'string') return null;
  const segments = subject.split('.');
  if (segments.length !== 3) return null;
  const [prefix, tenantId, eventType] = segments;
  if (prefix !== CANONICAL_EVENT_PREFIX || !tenantId || !eventType) {
    return null;
  }
  if (tenantId === '*' || tenantId === '>' || eventType === '*' || eventType === '>') {
    return null;
  }
  if (!SUBJECT_SEGMENT_PATTERN.test(tenantId) || !EVENT_TYPE_PATTERN.test(eventType)) {
    return null;
  }
  return {
    tenantId,
    eventType,
    isSystem: tenantId === SYSTEM_EVENT_TENANT_SEGMENT,
  };
}

export function assertCanonicalTenantEventSubject(subject: string): ParsedTenantEventSubject {
  const parsed = parseTenantEventSubject(subject);
  if (!parsed) {
    throw new TypeError(
      `Event subject must be canonical events.{tenantId}.{eventType}; ` +
        `got ${JSON.stringify(subject)}`,
    );
  }
  return parsed;
}

export function assertSubjectMatchesEvent(
  subject: string,
  event: TenantEventLike,
): ParsedTenantEventSubject {
  const parsed = assertCanonicalTenantEventSubject(subject);
  if (parsed.eventType !== event.eventType) {
    throw new TypeError(
      `Event subject type mismatch: subject=${parsed.eventType}, ` + `payload=${event.eventType}`,
    );
  }

  const eventTenant = event.tenantId ?? SYSTEM_EVENT_TENANT_SEGMENT;
  if (parsed.tenantId !== eventTenant) {
    throw new TypeError(
      `Event subject tenant mismatch: subject=${parsed.tenantId}, ` + `payload=${eventTenant}`,
    );
  }

  return parsed;
}

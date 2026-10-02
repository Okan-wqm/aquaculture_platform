/**
 * Canonical tenant event subject builder.
 *
 * All durable domain events use exactly three NATS subject segments:
 *
 *   events.{tenantId}.{eventType}
 *
 * `tenantId = system` is reserved for platform-level events that do not belong
 * to a tenant. Wildcards are only emitted by the explicit subscription helpers.
 * Which segment an event routes on is decided once, by
 * `eventSubjectTenantSegment` (OBS-HIGH-009).
 *
 * The platform segment is spelled once, in the event contract
 * (`PLATFORM_EVENT_TENANT_ID`, SEC-HIGH-159); this module aliases it.
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

/**
 * The tenant segment an event routes on: the ONE derivation the publisher's
 * subject builder (`deriveEventSubject`) and {@link assertSubjectMatchesEvent}
 * share (OBS-HIGH-009).
 *
 * WHAT: a tenant event routes on its tenantId; a platform-level event carries
 * the contract's platform segment (`createBaseEvent(type, PLATFORM_SCOPE)` /
 * `tenantScopeOf(null)` produce it) and routes on that; an `IEvent` with no
 * tenantId at all is platform-level too. The empty string is refused.
 *
 * WHY one function: the builder used to test `!event.tenantId` (so `''` meant
 * platform) while the assertion used `event.tenantId ?? 'system'` (so `''` was
 * a tenant named ''). Every `''` publish was therefore built for
 * `events.system.*` and then refused by its own assertion with
 * "subject tenant mismatch: subject=system, payload=" — which is how the
 * fleet's error capture never wrote a row to admin.error_groups.
 *
 * WHY `''` is refused rather than read as platform: no contract surface
 * accepts it on the wire — `eventTenantScope`, the event JSON schemas and the
 * outbox all reject it — so aliasing it here would put a second platform
 * spelling on the wire that every consumer parsing through the contract
 * throws on. It fails here, at the producer, naming the one sentinel.
 */
export function eventSubjectTenantSegment(event: TenantEventLike): string {
  const { tenantId } = event;
  if (tenantId === undefined || tenantId === null) {
    return SYSTEM_EVENT_TENANT_SEGMENT;
  }
  if (tenantId === '') {
    throw new TypeError(
      `${event.eventType}: tenantId '' is not a tenancy scope; a platform-level ` +
        `event carries "${SYSTEM_EVENT_TENANT_SEGMENT}" — build it with ` +
        `createBaseEvent(eventType, PLATFORM_SCOPE) or tenantScopeOf(null)`,
    );
  }
  return tenantId;
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

  const eventTenant = eventSubjectTenantSegment(event);
  if (parsed.tenantId !== eventTenant) {
    throw new TypeError(
      `Event subject tenant mismatch: subject=${parsed.tenantId}, ` + `payload=${eventTenant}`,
    );
  }

  return parsed;
}

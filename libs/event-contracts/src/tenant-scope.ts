import type { BaseEvent } from './base-event';
import { UUID_PATTERN, UUID_SCHEMA } from './schemas/common.schema';

/**
 * Tenancy scope of an event — an explicit contract value (SEC-HIGH-057).
 *
 * # Why
 *
 * `BaseEvent.tenantId` is a string because it is the NATS routing segment
 * (`events.{tenantId}.{eventType}`). Platform-level events — those about a
 * user with no tenant, such as a super admin's password reset — need a
 * segment too, and three libraries each spelled it themselves:
 * `SYSTEM_EVENT_TENANT_SEGMENT` (event-bus), `OUTBOX_SYSTEM_TENANT_ID`
 * (outbox) and a `?? 'system'` fallback in every auth publisher. On the
 * consuming side the notification handler guarded with a hand-rolled UUID
 * regex and silently dropped anything else, so a super admin's reset e-mail
 * was acknowledged and never sent.
 *
 * This module is the single spelling. Producers derive the segment from the
 * user's nullable tenantId through {@link tenantScopeOf}; consumers parse the
 * wire value back through {@link eventTenantScope} and branch on `kind`
 * instead of on a regex. Both libraries alias {@link PLATFORM_EVENT_TENANT_ID}
 * rather than declaring their own literal.
 */

/** Routing segment reserved for events that belong to no tenant. */
export const PLATFORM_EVENT_TENANT_ID = 'system' as const;
export type PlatformEventTenantId = typeof PLATFORM_EVENT_TENANT_ID;

export type TenantEventScope = { readonly kind: 'tenant'; readonly tenantId: string };
export type PlatformEventScope = { readonly kind: 'platform' };
export type EventTenantScope = TenantEventScope | PlatformEventScope;

export const PLATFORM_SCOPE: PlatformEventScope = Object.freeze({ kind: 'platform' });

const UUID_REGEX = new RegExp(UUID_PATTERN, 'i');

export class InvalidEventTenantScopeError extends TypeError {
  /** A malformed scope never becomes valid on redelivery (PLAT-HIGH-902). */
  readonly failureClass = 'permanent' as const;

  constructor(
    readonly eventType: string,
    readonly tenantId: unknown,
  ) {
    super(
      `${eventType}: tenantId must be a UUID or the platform segment ` +
        `"${PLATFORM_EVENT_TENANT_ID}", got ${JSON.stringify(tenantId)}`,
    );
    this.name = 'InvalidEventTenantScopeError';
  }
}

/**
 * Producer side: the scope of an event about a principal whose tenantId is
 * nullable (auth.users, auth.action_tokens). `null`/`undefined` is a platform
 * principal; a UUID is a tenant. Any other string is a programming error —
 * it would otherwise be routed as a tenant that does not exist.
 */
export function tenantScopeOf(tenantId: string | null | undefined): EventTenantScope {
  if (tenantId === null || tenantId === undefined) {
    return PLATFORM_SCOPE;
  }
  if (!UUID_REGEX.test(tenantId)) {
    throw new InvalidEventTenantScopeError('tenantScopeOf', tenantId);
  }
  return { kind: 'tenant', tenantId };
}

/** The `BaseEvent.tenantId` routing segment for a scope. */
export function tenantIdForScope(scope: EventTenantScope): string {
  return scope.kind === 'tenant' ? scope.tenantId : PLATFORM_EVENT_TENANT_ID;
}

/**
 * Consumer side: parse the wire `tenantId` back into a scope. Throws on any
 * value that is neither a UUID nor the platform segment, so a malformed event
 * fails loudly at the handler boundary instead of being dropped by a guard.
 */
export function eventTenantScope(
  event: Pick<BaseEvent, 'eventType' | 'tenantId'>,
): EventTenantScope {
  const { tenantId } = event;
  if (tenantId === PLATFORM_EVENT_TENANT_ID) {
    return PLATFORM_SCOPE;
  }
  if (typeof tenantId === 'string' && UUID_REGEX.test(tenantId)) {
    return { kind: 'tenant', tenantId };
  }
  throw new InvalidEventTenantScopeError(event.eventType, tenantId);
}

/**
 * For events that are structurally tenant-bound (e.g. UserInvited — an
 * invitation always targets a tenant): parse the scope and reject platform.
 */
export function requireTenantScope(
  event: Pick<BaseEvent, 'eventType' | 'tenantId'>,
): TenantEventScope {
  const scope = eventTenantScope(event);
  if (scope.kind !== 'tenant') {
    throw new InvalidEventTenantScopeError(event.eventType, event.tenantId);
  }
  return scope;
}

/**
 * JSON-Schema fragment for the `tenantId` of an event that may be platform
 * scoped. Per-event schemas that can legitimately carry the platform segment
 * override `BASE_EVENT_PROPERTIES.tenantId` with this; every other event keeps
 * the UUID-only base shape.
 */
export const TENANT_OR_PLATFORM_TENANT_ID_SCHEMA = {
  anyOf: [UUID_SCHEMA, { const: PLATFORM_EVENT_TENANT_ID }],
} as const;

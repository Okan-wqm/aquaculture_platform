import type { IEvent } from '@platform/event-bus';

/** Explicit platform routing identity admitted only by the system outbox API. */
export const OUTBOX_SYSTEM_TENANT_ID = 'system' as const;

/**
 * Reserved payload attestation stamped by OutboxPublisher for system rows.
 * The worker requires this marker together with a NULL tenant column and the
 * exact `system` payload tenant, so an ordinary tenant row cannot silently
 * downgrade onto `events.system.*`.
 */
export const OUTBOX_ROUTING_SCOPE_FIELD = '__outboxRoutingScope' as const;
export const OUTBOX_DELIVERY_POLICY_FIELD = '__outboxDeliveryPolicy' as const;
export const OUTBOX_SECURITY_RECOVERY_POLICY = 'security-recovery' as const;

export type OutboxRoutingScope = 'tenant' | 'system';
export type OutboxDeliveryPolicy = 'default' | typeof OUTBOX_SECURITY_RECOVERY_POLICY;
export type OutboxStoredPayload = IEvent & {
  [OUTBOX_ROUTING_SCOPE_FIELD]?: typeof OUTBOX_SYSTEM_TENANT_ID;
  [OUTBOX_DELIVERY_POLICY_FIELD]?: typeof OUTBOX_SECURITY_RECOVERY_POLICY;
};

export class OutboxStorageMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxStorageMetadataError';
  }
}

export interface OutboxFeatureOptions {
  /**
   * Admit rows whose routing tenant is the reserved `system` identity.
   *
   * Default-deny because system rows use a NULL tenant column and therefore
   * require a service-owned partial unique idempotency index. A service may
   * enable this only together with that entity/migration contract.
   */
  allowSystemRouting?: boolean;
  /**
   * Permit security recovery rows that must retry publish until success.
   * This is intentionally independent from system routing: tenant-scoped
   * credential mutations require the same durability.
   */
  allowSecurityRecovery?: boolean;
}

export function hasSecurityRecoveryDeliveryPolicy(payload: object): boolean {
  return (
    OUTBOX_DELIVERY_POLICY_FIELD in payload &&
    payload[OUTBOX_DELIVERY_POLICY_FIELD as keyof typeof payload] ===
      OUTBOX_SECURITY_RECOVERY_POLICY
  );
}

export function assertOutboxDeliveryPolicyIntegrity(payload: object): void {
  if (!(OUTBOX_DELIVERY_POLICY_FIELD in payload)) {
    return;
  }
  if (!hasSecurityRecoveryDeliveryPolicy(payload)) {
    throw new OutboxStorageMetadataError('Outbox row has an invalid storage delivery policy');
  }
}

/**
 * Remove the storage-only routing attestation before an event crosses NATS.
 * Strict event schemas reject unknown properties; the marker proves the row's
 * routing integrity at rest and must never become part of the domain wire
 * contract.
 */
export function withoutOutboxRoutingAttestation<TEvent extends object>(payload: TEvent): TEvent {
  if (!(OUTBOX_ROUTING_SCOPE_FIELD in payload) && !(OUTBOX_DELIVERY_POLICY_FIELD in payload)) {
    return payload;
  }
  const {
    [OUTBOX_ROUTING_SCOPE_FIELD]: _routingAttestation,
    [OUTBOX_DELIVERY_POLICY_FIELD]: _deliveryPolicy,
    ...event
  } = payload as TEvent & {
    [OUTBOX_ROUTING_SCOPE_FIELD]?: unknown;
    [OUTBOX_DELIVERY_POLICY_FIELD]?: unknown;
  };
  return event as TEvent;
}

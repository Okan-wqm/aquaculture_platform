/**
 * Canonical GDPR Art. 17 tenant-erasure target roster.
 *
 * This is the SSoT consumed by contracts, orchestrators, handlers, and
 * invariants. Do not duplicate this list in service-local code.
 */
export const TENANT_ERASURE_TARGET_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'ai-service',
  'billing-service',
  'notification-service',
  'hydroponics-service',
  'alert-engine',
  'admin-api-service',
  'config-service',
] as const;

export type TenantErasureTargetService =
  (typeof TENANT_ERASURE_TARGET_SERVICES)[number];

export const TENANT_ERASURE_TARGET_SERVICE_COUNT =
  TENANT_ERASURE_TARGET_SERVICES.length;

export function isTenantErasureTargetService(
  service: string,
): service is TenantErasureTargetService {
  return (TENANT_ERASURE_TARGET_SERVICES as readonly string[]).includes(service);
}

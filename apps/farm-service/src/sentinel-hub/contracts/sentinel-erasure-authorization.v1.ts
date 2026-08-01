/**
 * Immutable database/runtime contract for deleting retained legacy Sentinel
 * credential rows during tenant erasure.
 *
 * Migration 180700 installs a trigger with these values and the farm erasure
 * runtime presents the same transaction-local proof. Never mutate V1 in
 * place: introduce a V2 contract and a forward migration instead.
 */
export const SENTINEL_ERASURE_AUTHORIZATION_V1 = {
  targetService: 'farm-service',
  advisoryNamespace: 'farm-service:sentinel-erasure:v1',
  targetServiceGuc: 'app.tenant_erasure_target_service',
  tenantIdGuc: 'app.tenant_erasure_tenant_id',
  operationIdGuc: 'app.tenant_erasure_operation_id',
} as const;

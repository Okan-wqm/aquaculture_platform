import type { TenantErasureTargetService } from '@platform/event-contracts';

import type { TenantErasureTargetExecutorOptions } from './tenant-erasure-target-executor';

export const TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE = {
  'farm-service': {
    targetService: 'farm-service',
    moduleName: 'farm',
    sourceSchema: 'farm',
    mode: 'tenant-schema-module',
    outbox: { schema: 'farm', table: 'outbox_events' },
    proofLedger: { schema: 'farm', table: 'tenant_erasure_target_proofs' },
  },
  'sensor-service': {
    targetService: 'sensor-service',
    moduleName: 'sensor',
    sourceSchema: 'sensor',
    mode: 'tenant-schema-module',
    outbox: { schema: 'sensor', table: 'sensor_outbox' },
    proofLedger: { schema: 'sensor', table: 'tenant_erasure_target_proofs' },
  },
  'hr-service': {
    targetService: 'hr-service',
    moduleName: 'hr',
    sourceSchema: 'hr',
    mode: 'tenant-schema-module',
    outbox: { schema: 'hr', table: 'hr_outbox' },
    proofLedger: { schema: 'hr', table: 'tenant_erasure_target_proofs' },
  },
  'messaging-service': {
    targetService: 'messaging-service',
    moduleName: 'messaging',
    sourceSchema: 'messaging',
    mode: 'tenant-schema-module',
    outbox: { schema: 'messaging', table: 'messaging_outbox' },
    proofLedger: { schema: 'messaging', table: 'tenant_erasure_target_proofs' },
  },
  'ai-service': {
    targetService: 'ai-service',
    moduleName: 'ai',
    sourceSchema: 'ai',
    mode: 'tenant-schema-module',
    outbox: { schema: 'ai', table: 'ai_outbox' },
    proofLedger: { schema: 'ai', table: 'tenant_erasure_target_proofs' },
  },
  'billing-service': {
    targetService: 'billing-service',
    moduleName: 'billing',
    sourceSchema: 'billing',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'billing', table: 'billing_outbox' },
    proofLedger: { schema: 'billing', table: 'tenant_erasure_target_proofs' },
  },
  'notification-service': {
    targetService: 'notification-service',
    moduleName: 'notification',
    sourceSchema: 'notification',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'notification', table: 'notification_outbox' },
    proofLedger: { schema: 'notification', table: 'tenant_erasure_target_proofs' },
  },
  'hydroponics-service': {
    targetService: 'hydroponics-service',
    moduleName: 'hydroponics',
    sourceSchema: 'hydroponics',
    mode: 'tenant-schema-module',
    outbox: { schema: 'hydroponics', table: 'hydroponics_outbox' },
    proofLedger: { schema: 'hydroponics', table: 'tenant_erasure_target_proofs' },
  },
  'alert-engine': {
    targetService: 'alert-engine',
    moduleName: 'alert',
    sourceSchema: 'alert',
    mode: 'tenant-schema-module',
    outbox: { schema: 'alert', table: 'alert_outbox' },
    proofLedger: { schema: 'alert', table: 'tenant_erasure_target_proofs' },
  },
  'admin-api-service': {
    targetService: 'admin-api-service',
    moduleName: 'admin',
    sourceSchema: 'admin',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'admin', table: 'admin_outbox' },
    proofLedger: { schema: 'admin', table: 'tenant_erasure_target_proofs' },
    excludedTables: [
      'admin_outbox',
      'cleanup_runs',
      'tenant_erasure_operations',
      'tenant_schemas',
    ],
  },
  // DB-INFRA-HIGH-003: config-service — per-tenant dynamic configuration.
  'config-service': {
    targetService: 'config-service',
    moduleName: 'config',
    sourceSchema: 'config',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'config', table: 'config_outbox' },
    proofLedger: { schema: 'config', table: 'tenant_erasure_target_proofs' },
  },
  // DB-INFRA-HIGH-003: event-store-service — deletes the tenant-column projection
  // tables (event_streams, snapshots, projection_*). stored_events is EXCLUDED:
  // it is an immutable append-only log; its PII payload is erased by the
  // crypto-shred post-erasure hook (StoredEventsCryptoShredHook, rollout step 2
  // of docs/plans/2026-07-12-event-store-crypto-shred-design.md), not by row
  // deletion.
  'event-store-service': {
    targetService: 'event-store-service',
    moduleName: 'event_store',
    sourceSchema: 'event_store',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'event_store', table: 'event_store_outbox' },
    proofLedger: { schema: 'event_store', table: 'tenant_erasure_target_proofs' },
    excludedTables: [
      'event_store_outbox',
      'stored_events',
      // The crypto-shred key store: its GDPR treatment is the shred itself
      // (wrapped DEK overwritten + shredded_at stamped by the hook), NOT row
      // deletion. Deleting the row would destroy the shred tombstone (allowing
      // a fresh DEK to be minted for an erased tenant) and deadlock the erasure
      // transaction against the hook's own UPDATE on the same row.
      'tenant_payload_keys',
    ],
  },
} as const satisfies Record<
  TenantErasureTargetService,
  TenantErasureTargetExecutorOptions
>;

export function getTenantErasureTargetOptions(
  targetService: TenantErasureTargetService,
): TenantErasureTargetExecutorOptions {
  const options = TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE[targetService];
  const excludedTables =
    'excludedTables' in options ? options.excludedTables : undefined;
  const baseOptions = {
    ...options,
    outbox: { ...options.outbox },
    proofLedger: { ...options.proofLedger },
  };
  if (!excludedTables) {
    return baseOptions;
  }
  return {
    ...baseOptions,
    outbox: { ...options.outbox },
    proofLedger: { ...options.proofLedger },
    excludedTables: [...excludedTables],
  };
}

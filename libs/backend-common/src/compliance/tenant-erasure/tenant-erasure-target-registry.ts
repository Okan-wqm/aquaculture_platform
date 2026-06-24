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

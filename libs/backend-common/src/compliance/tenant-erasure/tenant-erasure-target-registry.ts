/**
 * Tenant-erasure target registry — one entry per erasure target service
 * (`TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET`), the SSoT for how each
 * target reaches a tenant's rows.
 *
 * Two modes:
 *   - `tenant-schema-module`: the tenant's rows live in `tenant_<uuid>`; the
 *     executor empties every registered table of that schema and the admin
 *     saga drops the schema afterwards.
 *   - `source-schema-tenant-column`: the tenant's rows live in the service's
 *     own schema beside every other tenant's; the executor deletes by the
 *     per-table policy declared here (`tenant-column` / `cascade-via` /
 *     `excluded`, ADMIN-CRITICAL-009). Nothing is derived from column names
 *     at runtime; the policy set must name every table `MODULE_SCHEMAS`
 *     registers for the module, and it is checked at boot and in CI.
 */
import type { TenantErasureTargetService } from '@platform/event-contracts';

import type { TenantErasureTablePolicies } from './tenant-erasure-table-policy';
import type { TenantErasureTargetExecutorOptions } from './tenant-erasure-target-executor';

const MIGRATIONS_LEDGER =
  'TypeORM migration ledger of the service; platform metadata, no tenant rows';
const OUTBOX =
  'transactional outbox: tenant rows pending publish — including the erasure events this very flow enqueues — must survive to publication';
const PROOF_LEDGER =
  'erasure proof ledger: the durable evidence that prior erasures completed; this operation inserts its own proof later in the same transaction';
const WORM_LEDGER =
  'append-only audit ledger (ADR-0008 WORM_LEDGERS): erasure must not destroy the evidence that erasure happened; rows expire under the retention authority (ADR-0012) and stay while legally held';
const PLATFORM_REFERENCE =
  'platform reference data shared by every tenant; carries no tenant rows';
const RETIRED_ARCHIVE =
  'archive of a retired store written by a retirement migration; jsonb rows have no tenant column and are pruned as a whole by the retention authority';

const ADMIN_TABLES: TenantErasureTablePolicies = {
  // Tenant-owned rows, reached by their own tenant column.
  tenant_activities: { kind: 'excluded', reason: WORM_LEDGER },
  tenant_notes: { kind: 'tenant-column', column: 'tenantId' },
  tenant_billing_info: { kind: 'tenant-column', column: 'tenantId' },
  custom_plans: { kind: 'tenant-column', column: 'tenantId' },
  message_threads: { kind: 'tenant-column', column: 'tenantId' },
  messages: { kind: 'cascade-via', parent: 'message_threads', foreignKey: 'threadId' },
  announcement_acknowledgments: { kind: 'tenant-column', column: 'tenantId' },
  support_tickets: { kind: 'tenant-column', column: 'tenantId' },
  ticket_comments: { kind: 'cascade-via', parent: 'support_tickets', foreignKey: 'ticketId' },
  onboarding_progress: { kind: 'tenant-column', column: 'tenantId' },
  background_jobs: { kind: 'tenant-column', column: 'tenantId' },
  job_execution_logs: { kind: 'cascade-via', parent: 'background_jobs', foreignKey: 'jobId' },
  error_occurrences: { kind: 'tenant-column', column: 'tenantId' },
  maintenance_modes: { kind: 'tenant-column', column: 'tenantId' },
  email_templates: { kind: 'tenant-column', column: 'tenantId' },
  security_events: { kind: 'tenant-column', column: 'tenantId' },
  data_requests: { kind: 'tenant-column', column: 'tenantId' },
  login_attempts: { kind: 'tenant-column', column: 'tenantId' },
  api_usage_logs: { kind: 'tenant-column', column: 'tenantId' },
  user_sessions: { kind: 'tenant-column', column: 'tenantId' },
  database_metrics: { kind: 'tenant-column', column: 'tenantId' },
  slow_query_logs: { kind: 'tenant-column', column: 'tenantId' },
  schema_migrations: { kind: 'tenant-column', column: 'tenantId' },
  tenant_provisioning_runs: { kind: 'tenant-column', column: 'tenantId' },
  tenant_provisioning_steps: {
    kind: 'cascade-via',
    parent: 'tenant_provisioning_runs',
    foreignKey: 'runId',
  },
  tenant_onboarding_acks: { kind: 'tenant-column', column: 'tenantId' },
  // Ledgers the erasure itself is evidence in.
  audit_logs: { kind: 'excluded', reason: WORM_LEDGER },
  activity_logs: { kind: 'excluded', reason: WORM_LEDGER },
  tenant_erasure_operations: {
    kind: 'excluded',
    reason: 'the erasure operation record itself; the admin saga owns its lifecycle and it must outlive the rows it erases',
  },
  tenant_schemas: {
    kind: 'excluded',
    reason: 'schema-deletion ledger: the saga retires the row when the tenant schema is dropped, after every target has proven its erasure',
  },
  cleanup_runs: { kind: 'excluded', reason: WORM_LEDGER },
  cleanup_run_steps: { kind: 'excluded', reason: WORM_LEDGER },
  cleanup_run_events: { kind: 'excluded', reason: WORM_LEDGER },
  cleanup_run_evidence: { kind: 'excluded', reason: WORM_LEDGER },
  retired_backup_ledger: { kind: 'excluded', reason: RETIRED_ARCHIVE },
  retired_config_backups: { kind: 'excluded', reason: RETIRED_ARCHIVE },
  migrations: { kind: 'excluded', reason: MIGRATIONS_LEDGER },
  admin_outbox: { kind: 'excluded', reason: OUTBOX },
  tenant_erasure_target_proofs: { kind: 'excluded', reason: PROOF_LEDGER },
  // Platform-wide reference data and detectors: no tenant rows.
  analytics_snapshots: {
    kind: 'excluded',
    reason: 'platform-wide aggregates with no tenant column; a tenant is one count among many',
  },
  report_definitions: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  report_executions: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  performance_metrics: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  performance_snapshots: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  error_groups: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  error_alert_rules: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  feature_toggles: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  security_incidents: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  threat_intelligence: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  compliance_reports: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  announcements: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  plan_definitions: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  plan_module_assignments: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  job_queues: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  system_versions: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  ingest_backend_policy_state: { kind: 'excluded', reason: PLATFORM_REFERENCE },
};

const BILLING_TABLES: TenantErasureTablePolicies = {
  subscriptions: { kind: 'tenant-column', column: 'tenant_id' },
  subscription_module_items: {
    kind: 'cascade-via',
    parent: 'subscriptions',
    foreignKey: 'subscription_id',
  },
  invoices: { kind: 'tenant-column', column: 'tenant_id' },
  payments: { kind: 'tenant-column', column: 'tenant_id' },
  scheduled_plan_changes: { kind: 'tenant-column', column: 'tenantId' },
  usage_aggregations: { kind: 'tenant-column', column: 'tenant_id' },
  usage_hourly_data: { kind: 'tenant-column', column: 'tenant_id' },
  command_receipts: { kind: 'tenant-column', column: 'tenantId' },
  plans: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  // ADR-0013 / BILLING-CRITICAL-002: the discount catalogue moved from admin.
  // A redemption is a tenant's row and is erased with the tenant; the code
  // itself is a platform-wide catalogue entry with no tenant column.
  discount_codes: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  discount_redemptions: { kind: 'tenant-column', column: 'tenant_id' },
  // ADR-0013: the module price sheet and its child rows are a platform-wide
  // catalogue priced per module, not per tenant.
  module_prices: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  module_price_metrics: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  module_price_tier_multipliers: { kind: 'excluded', reason: PLATFORM_REFERENCE },
  stripe_webhook_events: {
    kind: 'excluded',
    reason: 'Stripe webhook idempotency ledger keyed by Stripe event id; carries no tenant column and is the evidence of what Stripe delivered',
  },
  retired_usage_metrics_backup: { kind: 'excluded', reason: RETIRED_ARCHIVE },
  migrations: { kind: 'excluded', reason: MIGRATIONS_LEDGER },
  billing_outbox: { kind: 'excluded', reason: OUTBOX },
  tenant_erasure_target_proofs: { kind: 'excluded', reason: PROOF_LEDGER },
};

const NOTIFICATION_TABLES: TenantErasureTablePolicies = {
  device_tokens: { kind: 'tenant-column', column: 'tenant_id' },
  notification_logs: { kind: 'tenant-column', column: 'tenant_id' },
  command_receipts: { kind: 'tenant-column', column: 'tenantId' },
  migrations: { kind: 'excluded', reason: MIGRATIONS_LEDGER },
  notification_outbox: { kind: 'excluded', reason: OUTBOX },
  tenant_erasure_target_proofs: { kind: 'excluded', reason: PROOF_LEDGER },
};

const CONFIG_TABLES: TenantErasureTablePolicies = {
  configurations: { kind: 'tenant-column', column: 'tenant_id' },
  configuration_history: { kind: 'tenant-column', column: 'tenant_id' },
  migrations: { kind: 'excluded', reason: MIGRATIONS_LEDGER },
  config_outbox: { kind: 'excluded', reason: OUTBOX },
  tenant_erasure_target_proofs: { kind: 'excluded', reason: PROOF_LEDGER },
};

const EVENT_STORE_TABLES: TenantErasureTablePolicies = {
  event_streams: { kind: 'tenant-column', column: 'tenantId' },
  snapshots: { kind: 'tenant-column', column: 'tenantId' },
  projection_checkpoints: { kind: 'tenant-column', column: 'tenantId' },
  projection_rebuilds: { kind: 'tenant-column', column: 'tenantId' },
  stored_events: {
    kind: 'excluded',
    reason: 'immutable append-only event log; its PII payload is erased by the crypto-shred post-erasure hook (StoredEventsCryptoShredHook), not by row deletion',
  },
  tenant_payload_keys: {
    kind: 'excluded',
    reason: 'crypto-shred key store: the shred (wrapped DEK overwritten, shredded_at stamped) is the erasure; deleting the tombstone would let a fresh DEK be minted for an erased tenant',
  },
  migrations: { kind: 'excluded', reason: MIGRATIONS_LEDGER },
  event_store_outbox: { kind: 'excluded', reason: OUTBOX },
  tenant_erasure_target_proofs: { kind: 'excluded', reason: PROOF_LEDGER },
};

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
    tables: BILLING_TABLES,
  },
  'notification-service': {
    targetService: 'notification-service',
    moduleName: 'notification',
    sourceSchema: 'notification',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'notification', table: 'notification_outbox' },
    proofLedger: { schema: 'notification', table: 'tenant_erasure_target_proofs' },
    tables: NOTIFICATION_TABLES,
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
    tables: ADMIN_TABLES,
  },
  // DB-INFRA-HIGH-003: config-service — per-tenant dynamic configuration.
  'config-service': {
    targetService: 'config-service',
    moduleName: 'config',
    sourceSchema: 'config',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'config', table: 'config_outbox' },
    proofLedger: { schema: 'config', table: 'tenant_erasure_target_proofs' },
    tables: CONFIG_TABLES,
  },
  // DB-INFRA-HIGH-003: event-store-service — deletes the tenant-column projection
  // tables; stored_events is erased by the crypto-shred hook (rollout step 2 of
  // docs/plans/2026-07-12-event-store-crypto-shred-design.md), see its policy.
  'event-store-service': {
    targetService: 'event-store-service',
    moduleName: 'event_store',
    sourceSchema: 'event_store',
    mode: 'source-schema-tenant-column',
    outbox: { schema: 'event_store', table: 'event_store_outbox' },
    proofLedger: { schema: 'event_store', table: 'tenant_erasure_target_proofs' },
    tables: EVENT_STORE_TABLES,
  },
} as const satisfies Record<TenantErasureTargetService, TenantErasureTargetExecutorOptions>;

export function getTenantErasureTargetOptions(
  targetService: TenantErasureTargetService,
): TenantErasureTargetExecutorOptions {
  const options = TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE[targetService];
  if (options.mode === 'tenant-schema-module') {
    return {
      ...options,
      outbox: { ...options.outbox },
      proofLedger: { ...options.proofLedger },
    };
  }
  return {
    ...options,
    outbox: { ...options.outbox },
    proofLedger: { ...options.proofLedger },
    tables: { ...options.tables },
  };
}

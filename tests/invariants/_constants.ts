/**
 * Single source of truth for schema-owning services.
 *
 * Every service in SCHEMA_OWNING_SERVICES:
 *   1. Owns a Postgres schema declared on @Entity({ schema: '<name>' }) per ADR-011.
 *   2. MUST register SchemaDriftModule.forRoot({ serviceName }) in its AppModule per ADR-012.
 *   3. Is enforced by tests/invariants/adoption-invariants.spec.ts (BLOCKER-8, Round 3).
 *
 * Services in SCHEMALESS_SERVICES do not own a schema (pure API gateway or
 * observability aggregator); adoption invariants skip them.
 *
 * Historical note: Round-2 review (2026-04-16) incorrectly listed 9 services.
 * Round-3 ground-truth pass against CLAUDE.md Architecture Map confirmed 13.
 * Pre-existing ADR-011 violations to fix in W2: event-store-service and
 * config-service have @Entity() classes without schema: option.
 *
 * See /root/.claude/plans/declarative-riding-shamir.md BLOCKER-8 for context.
 */

export const SCHEMA_OWNING_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'alert-engine',
  'auth-service',
  'billing-service',
  'admin-api-service',
  'event-store-service',
  'ai-service',
  'config-service',
  'notification-service',
] as const;

export type SchemaOwningService = (typeof SCHEMA_OWNING_SERVICES)[number];

export const SCHEMALESS_SERVICES = [
  'gateway-api',
  'observability-service',
] as const;

export type SchemalessService = (typeof SCHEMALESS_SERVICES)[number];

/**
 * Per-tenant schema services: schemas are provisioned once per tenant
 * during provision-tenant skill execution. Distinct from the full
 * SCHEMA_OWNING_SERVICES set — auth/billing/admin/event-store/config/
 * notification own cross-tenant schemas, not per-tenant.
 *
 * Cited by CLAUDE.md Architecture Map and enforced by provision-tenant skill.
 */
export const PER_TENANT_SCHEMA_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'alert-engine',
  'ai-service',
] as const;

export type PerTenantSchemaService = (typeof PER_TENANT_SCHEMA_SERVICES)[number];

/**
 * Runtime assertion helpers — callers can narrow a string at the boundary
 * without importing Zod or duplicating the list.
 */
export function isSchemaOwningService(s: string): s is SchemaOwningService {
  return (SCHEMA_OWNING_SERVICES as readonly string[]).includes(s);
}

export function isPerTenantSchemaService(s: string): s is PerTenantSchemaService {
  return (PER_TENANT_SCHEMA_SERVICES as readonly string[]).includes(s);
}

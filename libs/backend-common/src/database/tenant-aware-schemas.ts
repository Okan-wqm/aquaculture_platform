import { tenantAwareSchemas } from '@platform/service-catalog';

/**
 * TENANT_AWARE_SCHEMAS — runtime `Set` view, DERIVED from the platform-topology
 * SSoT (@platform/service-catalog `tenantAware` flag). The membership lives in
 * ONE place (the topology registry) so this set, the four hand-copied spec
 * copies, and the migration-runner fan-out can never drift (ORPHAN-HIGH-411).
 * ============================================================================
 *
 * Enumerates the source schemas whose services own per-tenant schema
 * clones (`tenant_<uuid16>`). Referenced from three consumers that were
 * previously each maintaining their own local copy:
 *
 *   1. libs/backend-common/.../migration-runner.service.ts — the
 *      per-service MigrationRunnerService that fans migrations out to
 *      tenant schemas on boot (WP3).
 *   2. apps/db-migrate/src/migration-orchestrator.ts — the aqua-db-migrate
 *      orchestrator's tenant fan-out at deploy time (WP5).
 *   3. e2e/tests/integration/schema-propagation.spec.ts — the CI
 *      invariant that detects tenant-schema drift (WP6).
 *
 * All three now import from here. Adding / removing a tenant-aware
 * service is a one-line change in this file; drift between the three
 * consumers is impossible.
 *
 * # When to edit this list
 *
 * A service joins TENANT_AWARE_SCHEMAS when its @Entity layer introduces
 * schema-per-tenant semantics (row-level tables are cloned into
 * `tenant_<uuid>` schemas at tenant onboarding). Shared-schema services
 * (auth, billing, notification, config, admin, event_store,
 * observability, gateway) stay out of this set — their tables live in
 * the source schema only and don't need tenant fan-out.
 *
 * # Related constants
 *
 *   - SCHEMA_REGISTRY (apps/db-migrate/src/schema-registry.ts) — the
 *     ordered list of ALL schemas including shared ones. Superset of
 *     this file.
 *   - MODULE_SCHEMAS (libs/backend-common/.../schema-manager.service.ts)
 *     — richer per-module manifest with table lists, reference-data
 *     tables, strictOwnership flags. Consulted by tenant provisioning.
 */

export const TENANT_AWARE_SCHEMAS: ReadonlySet<string> = new Set(tenantAwareSchemas());

/**
 * Regex matching per-tenant schema names. Used by consumers that iterate
 * `information_schema.schemata` to find tenant clones. Kept here (next
 * to the SSoT set) so both constants are maintained together.
 */
export const TENANT_SCHEMA_NAME_RE = /^tenant_[a-f0-9]{16}$/;

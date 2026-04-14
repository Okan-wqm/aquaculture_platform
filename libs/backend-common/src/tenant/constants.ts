/**
 * Tenant-scoped shared constants.
 *
 * Canonical values shared across services that participate in the
 * multi-tenant data model. Centralising these removes the silent-drift
 * failure mode observed during 2026-04-14 public-schema teardown where
 * the all-zeros global tenant UUID was literal-coded in ≥10 files and a
 * refactor in any one place risked divergence from the seed services.
 */

/**
 * Well-known sentinel tenant UUID for global / template rows.
 *
 * Rows owned by this tenant are reference data copied into every new
 * tenant schema via `SchemaManagerService.copyReferenceData()` during
 * provisioning. They exist in the source schema alongside tenant-owned
 * rows and are filtered in / out of tenant queries via:
 *   WHERE "tenantId" IN (:ownTenant, '00000000-0000-0000-0000-000000000000')
 *
 * # Why all-zeros
 *
 * All-zeros is UUID v4's canonical "nil" value (RFC 4122 §4.1.7). It is
 * guaranteed never to be produced by `gen_random_uuid()` (the generator
 * we use for tenant registrations), so there's no collision risk with a
 * real tenant. The value is typeable, greppable, and round-trips cleanly
 * through JSON/DB/log layers — all important for the ergonomics of the
 * cross-service query patterns that reference it.
 *
 * # Writers
 *
 * Only system bootstraps write rows carrying this tenantId:
 *   - `FarmSeedService.seedGlobalCleanerFishSpecies()` — cleaner-fish
 *     templates (Lumpfish, Ballan/Corkwing/Goldsinny Wrasse).
 *   - Future reference-data seeds for equipment/chemical/feed types.
 *
 * These writes MUST execute under `BypassRlsService.withBypass()` because
 * the tenant RLS policy (`applyTenantRlsToSchema`) rejects inserts whose
 * tenantId doesn't match the current `app.current_tenant` GUC — and the
 * bootstrap phase runs before any HTTP request sets that GUC.
 *
 * # Readers
 *
 * Tenant handlers reading reference tables should accept rows owned by
 * either their own tenantId or this sentinel:
 *   `WHERE "tenantId" = :ownTenant OR "tenantId" = GLOBAL_TENANT_UUID`
 * The `copyReferenceData()` provisioning path already clones these rows
 * into new tenant schemas, so steady-state reads from tenant schemas
 * typically find the row locally — this OR-clause is the fallback for
 * services that read from the source schema directly.
 */
export const GLOBAL_TENANT_UUID = '00000000-0000-0000-0000-000000000000';

# Tenant-schema grant incident — mechanism fix (2026-07-06)

## INFRA-CRITICAL-039 — tenant fan-out + provisioner create tables with no service grants; live outage class

Per-tenant tables reach tenant\_<uuid> schemas via (a) the deploy-time migration fan-out (db-migrate main.ts) and
(b) the provisioner job (PROVISION/RECONCILE). Both run on the db-migrate bootstrap connection (superuser);
Postgres neither copies privileges through CREATE TABLE under search_path nor applies another role's default ACLs
(pg_default_acl is (role,schema)-scoped; 004's ALTER DEFAULT PRIVILEGES are all IN SCHEMA <source>), and the only
post-fan-out privilege call was the migration-ledger read grant. Every migration-added tenant table was therefore
born owner=superuser with an EMPTY ACL: the owning service's first query dies with "permission denied" — silent
at boot (SchemaVersionGate reads the ledger, which IS granted), loud in production. LIVE INCIDENT 2026-07-06:
sensor_temperature_latest (farm #872) blanked equipmentList.batchMetrics → mobile lost ALL fish counts;
farm_documents, regulatory_reports, training_sessions, message_receipt_ledger equally dead. Existing tenants only
worked because provisioning-era clones predate the 2026-04-28 runtime-sync amputation (admin_service default ACLs

- stage-008 REASSIGN accident). ADVERSARIALLY VERIFIED against code + live pg_catalog (multi-agent audit).

FIX (Tier 1 + Tier 3):

- libs/backend-common/src/database/tenant-schema-privileges.ts — assertTenantSchemaPrivileges: MODULE_SCHEMAS-
  derived (tables ∪ referenceDataTables), idempotent ALTER OWNER TO <source>\_schema_owner + GRANT DML TO
  <source>_service + owned-sequence alignment + schema USAGE. Wired at the three chokepoints: fan-out
  grantTenantLedgerReadAccess wrapper, provisioner PROVISION APPLYING_GRANTS, provisioner RECONCILE. The next
  deploy self-heals all drifted prod tables; every future migration-added table is aligned the moment it lands.
- verifyTenantSchemaPrivileges — deploy/job-BLOCKING drift gate after the full fan-out and before provisioner
  COMMIT: any registered-and-present table with wrong owner/DML fails the run; tenant tables registered by NO
  module are logged loudly (unknownTables) instead of silently skipped.
- Immediate prod repair 2026-07-02 applied by hand (5 tables re-owned + granted, live-verified); this change makes
  the manual ceremony unnecessary and the class undeployable.

Unit spec 9/9 (assert alignment, absent-skip, refusals, verify violations/unknowns, partition-children exclusion);
db-migrate contract+cli specs 40/40; invariants 1756.

## INFRA-MEDIUM-040 — orphan tenant tables with no owning module (deploy_artifacts, release_bundles)

Two tables exist in the tenant schema with no @Entity and no MODULE_SCHEMAS registration (legacy). They are now
surfaced by the unknownTables warning on every deploy. Disposition (register or drop) owner: infra-expert,
deadline 2026-07-20.

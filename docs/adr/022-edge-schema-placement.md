# ADR-022: Edge Feature Schema Placement — Dedicated `edge` Schema with RLS + Partitioning + Canonical Role Names

**Status:** ⚠️ **SUPERSEDED by ADR-034 (2026-05-18).**
The dedicated `edge` schema + admin-api-service ownership decision in this ADR is replaced by per-tenant placement under sensor-service ownership. See `docs/adr/034-edge-schema-sensor-per-tenant-ownership.md` for the rationale (migration owner ≠ runtime owner ADR-011 violation; per-tenant access pattern matches the row shape). The DDL constraint set (BYTEA hash columns, EXCLUDE USING gist, is_current trigger, partition policy, RESTRICT FKs) carries forward verbatim into ADR-034 — only the schema placement and ownership change.

**Original status:** Proposed (opened 2026-04-19; revised post-audit 2026-04-19 — 3 CRITICAL + 6 HIGH + 7 MEDIUM + 3 LOW closed in §11 closure table; target Accepted 2026-05-03)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + data-expert + database-reviewer + multi-tenant-saas-expert + compliance-expert
**Owner:** Okan (temp — PROC-001)
**Deadline:** 2026-05-03 — gates PLA-003/004/005
**Related findings:** DEC-016 (edge schema placement), ADR-011 (Schema Ownership Model) W5 skill gate, ADR-012 Schema Drift Prevention, ADR-022-FINDING-001..020 (post-audit closure)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §6 BC Matrix, §5 Faz 8
**Supersedes:** Plan §6 `shared.edge_*` placement (rejected by ADR-011 W5 gate)

---

## Context (WHY)

### Problem
ADR-017/018/019/020 hepsi platform-side persistence gerektiriyor: bytecode metadata, RBAC manifests, anti-rollback state, provisioning blob records, firmware state, audit chain metadata, v1 audit archive, anchor state. Plan §6 ilk öneri: `shared.edge_*` tabloları. ADR-011 W5 skill gate bunu reddeder (shared 4-table canonical invariant).

### Post-audit context
İlk ADR-022 taslağı database-reviewer tarafından **3 CRITICAL + 6 HIGH + 7 MEDIUM + 3 LOW + 1 INFO** bulgu ile NEEDS_MAJOR_REVISION. Ana problemler (CRITICAL):
- Role adları platform SSoT ile uyumsuz (`aquaculture_*` YANLIŞ; doğru `auth_service`, `admin_service`, `billing_service`, `sensor_service` — bkz. `infrastructure/docker/init-scripts/00-init-schemas.sh` + `apps/db-migrate/src/schema-registry.ts`)
- `UNIQUE INDEX WHERE expires_at > now()` — PG reddeder (STABLE function in predicate)
- `CHAR(64)` checklist-banned (space-padding ambiguity + TOAST bloat)

Core architectural decision (dedicated `edge` schema) **doğru** ve audit tarafından onaylandı; DDL-level düzeltmeler gerekli. Bu revizyon hepsini kapatır.

---

## Decision (WHAT)

**1. Yeni dedicated `edge` schema. 2. Canonical service role names (auth_service, admin_service, billing_service, sensor_service). 3. RLS ENABLE + FORCE on tenant-scoped tables (platform-consistent). 4. RANGE partitioning on `audit_archive_v1` (350 TB worst case). 5. BYTEA for 32-byte hashes (not CHAR(64)). 6. EXCLUDE constraints for temporal overlap (not `now()` predicates). 7. Explicit `ON DELETE RESTRICT ON UPDATE RESTRICT` on all FKs. 8. `is_current` BOOLEAN + trigger pattern for hot-path queries. 9. `synchronize: false` mandate + invariant test. 10. Tenant hard-delete forbidden (cryptographic erasure only). 11. Junction table for ceremony witnesses (FK integrity + role differentiation).**

### 1. Schema + canonical role GRANTS (FINDING-001 kapama)

```sql
-- Migration: apps/admin-api-service/src/database/migrations/NNNN-CreateEdgeSchema.ts
-- Owner: admin_service (NOT aquaculture_* — canonical SSoT per
--        infrastructure/docker/init-scripts/00-init-schemas.sh +
--        apps/db-migrate/src/schema-registry.ts)

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed for EXCLUDE USING gist (FINDING-002)

CREATE SCHEMA IF NOT EXISTS edge
  AUTHORIZATION admin_service;

COMMENT ON SCHEMA edge IS
  'Edge agent platform-owned persistence — policies, licenses, devices, provisioning,
   firmware, audit archive. Cross-tenant but tenant-scoped rows (tenant_id FK).
   Primary owner: admin_service (writes all tables).
   Readers: auth_service (policies, provisioning_records), billing_service (licenses),
   sensor_service (devices). ADR: docs/adr/022-edge-schema-placement.md';

-- GRANTS (canonical role names; least privilege; ADR-018 §2 spirit):
GRANT USAGE ON SCHEMA edge TO admin_service;
GRANT ALL ON ALL TABLES IN SCHEMA edge TO admin_service;
GRANT ALL ON ALL SEQUENCES IN SCHEMA edge TO admin_service;

GRANT USAGE ON SCHEMA edge TO auth_service;
GRANT SELECT ON edge.policies TO auth_service;
GRANT SELECT ON edge.provisioning_records TO auth_service;
GRANT SELECT ON edge.provisioning_record_witnesses TO auth_service;

GRANT USAGE ON SCHEMA edge TO billing_service;
GRANT SELECT, INSERT, UPDATE ON edge.licenses TO billing_service;

GRANT USAGE ON SCHEMA edge TO sensor_service;
GRANT SELECT ON edge.devices TO sensor_service;

-- No additional grants — any other service access requires ADR amendment.
-- Invariant: tests/invariants/edge_schema_grants.spec.ts cross-checks against this ADR text.
```

### 2. Tables (all DDL fixes applied)

```sql
-- §2.1 Device registry
CREATE TABLE edge.devices (
    device_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL
      REFERENCES auth.tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    site_code TEXT NOT NULL,
    hardware_model TEXT NOT NULL
      CHECK (hardware_model IN ('rpi4','rpi5','revpi_connect_4')),
    provisioned_at TIMESTAMPTZ NOT NULL,
    provisioning_blob_sha256 BYTEA NOT NULL
      CHECK (octet_length(provisioning_blob_sha256) = 32),
    firmware_version TEXT NOT NULL,
    firmware_signing_epoch SMALLINT NOT NULL,
    last_seen_at TIMESTAMPTZ,
    status TEXT NOT NULL
      CHECK(status IN ('active','decommissioned','emergency','rescue_boot')),
    device_audit_attestation_pubkey BYTEA NOT NULL
      CHECK (octet_length(device_audit_attestation_pubkey) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_edge_devices_tenant ON edge.devices(tenant_id);
CREATE INDEX idx_edge_devices_status_active
  ON edge.devices(tenant_id, status) WHERE status != 'decommissioned';

-- §2.2 RBAC manifests — FINDING-002 fix: is_current BOOLEAN + partial unique index
CREATE TABLE edge.policies (
    policy_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL
      REFERENCES auth.tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    policy_version BIGINT NOT NULL,
    signing_key_epoch SMALLINT NOT NULL,
    min_edge_version TEXT NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    schema_version SMALLINT NOT NULL,
    manifest_json JSONB NOT NULL
      CHECK (manifest_json ? 'custom_roles' AND manifest_json ? 'schema_version'),
    manifest_signature BYTEA NOT NULL
      CHECK (octet_length(manifest_signature) = 64),
    published_at TIMESTAMPTZ,
    published_to_device_count INT NOT NULL DEFAULT 0,
    is_current BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    UNIQUE(tenant_id, policy_version, signing_key_epoch)
);
COMMENT ON COLUMN edge.policies.published_to_device_count IS
  'Denormalized counter for admin dashboards. Authoritative source: event count.
   Reconciled nightly via admin-api job.';
COMMENT ON COLUMN edge.policies.is_current IS
  'Trigger-maintained flag; exactly one row per tenant has is_current=true at any time.
   Deprecated by next policy_version acceptance OR valid_until expiry.';

-- FINDING-007: hot-path index (auth_service fetch_active_manifest) — is_current-based
CREATE UNIQUE INDEX idx_edge_policies_tenant_current
  ON edge.policies(tenant_id) WHERE is_current;
CREATE INDEX idx_edge_policies_tenant_hotpath
  ON edge.policies(tenant_id)
  INCLUDE (policy_version, signing_key_epoch, valid_from, valid_until)
  WHERE is_current;

-- Trigger: maintain is_current on insert/update
CREATE OR REPLACE FUNCTION edge.update_policies_is_current() RETURNS TRIGGER AS $$
BEGIN
  -- New row → mark it current, unset previous current for same tenant
  IF NEW.is_current THEN
    UPDATE edge.policies
       SET is_current = false
     WHERE tenant_id = NEW.tenant_id
       AND policy_id != NEW.policy_id
       AND is_current = true;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_edge_policies_is_current
  BEFORE INSERT OR UPDATE ON edge.policies
  FOR EACH ROW EXECUTE FUNCTION edge.update_policies_is_current();

-- §2.3 Edge licenses — FINDING-002 fix: EXCLUDE constraint for temporal non-overlap
CREATE TABLE edge.licenses (
    license_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL
      REFERENCES auth.tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    tier TEXT NOT NULL CHECK(tier IN ('STARTER','PRO','ENTERPRISE','CUSTOM')),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    max_io_channels INT,
    max_fb_instances INT,
    min_scan_cycle_ms INT,
    max_st_programs INT,
    signed_deploy_required BOOLEAN NOT NULL DEFAULT true,
    license_jwt TEXT NOT NULL,   -- RFC-7519 canonical base64 TEXT; do NOT switch to BYTEA
    license_sha256 BYTEA NOT NULL
      CHECK (octet_length(license_sha256) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- FINDING-002: temporal non-overlap enforcement (replaces UNIQUE WHERE now())
    EXCLUDE USING gist (
      tenant_id WITH =,
      tstzrange(issued_at, expires_at, '[]') WITH &&
    ),
    CHECK (issued_at < expires_at)
);
CREATE INDEX idx_edge_licenses_tenant_recent
  ON edge.licenses(tenant_id, expires_at DESC);

-- §2.4 Provisioning records
CREATE TABLE edge.provisioning_records (
    provisioning_id UUID PRIMARY KEY,
    device_id UUID NOT NULL
      REFERENCES edge.devices(device_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    tenant_id UUID NOT NULL
      REFERENCES auth.tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    issued_at TIMESTAMPTZ NOT NULL,
    issued_by_operator_id UUID   -- nullable for pseudonymization support (FINDING-009)
      REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    pseudonymized_at TIMESTAMPTZ,  -- audit trail for GDPR Art 17 pseudonymization event
    provisioning_blob BYTEA NOT NULL,
    provisioning_signature BYTEA NOT NULL
      CHECK (octet_length(provisioning_signature) = 64),
    ceremony_video_archive_url TEXT,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX idx_edge_provisioning_device_active
  ON edge.provisioning_records(device_id) WHERE retired_at IS NULL;

-- FINDING-013: junction table for witnesses (FK integrity + role differentiation)
CREATE TABLE edge.provisioning_record_witnesses (
    provisioning_id UUID NOT NULL
      REFERENCES edge.provisioning_records(provisioning_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    witness_operator_id UUID NOT NULL
      REFERENCES auth.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    witness_role TEXT NOT NULL
      CHECK(witness_role IN ('legal_counsel','auditor','security_lead')),
    signed_at TIMESTAMPTZ NOT NULL,
    witness_signature BYTEA NOT NULL
      CHECK (octet_length(witness_signature) = 64),
    PRIMARY KEY (provisioning_id, witness_operator_id, witness_role)
);
CREATE INDEX idx_provisioning_witness_operator
  ON edge.provisioning_record_witnesses(witness_operator_id);

-- §2.5 Firmware release artifacts
CREATE TABLE edge.firmware_releases (
    firmware_id UUID PRIMARY KEY,
    firmware_version TEXT NOT NULL,
    signing_key_epoch SMALLINT NOT NULL,
    release_channel TEXT NOT NULL
      CHECK(release_channel IN ('stable','staged','beta','rescue')),
    target_hardware TEXT[] NOT NULL
      CHECK (target_hardware <@ ARRAY['rpi4','rpi5','revpi_connect_4']::TEXT[]),
    manifest_sha256 BYTEA NOT NULL
      CHECK (octet_length(manifest_sha256) = 32),
    manifest_json JSONB NOT NULL
      CHECK (manifest_json ? 'firmware_version' AND manifest_json ? 'signing_key_epoch'),
    signature BYTEA NOT NULL
      CHECK (octet_length(signature) = 64),
    slsa_attestation_url TEXT,
    published_at TIMESTAMPTZ NOT NULL,
    deprecated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    updated_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    UNIQUE(firmware_version, signing_key_epoch, release_channel)
);
CREATE INDEX idx_edge_firmware_channel_active
  ON edge.firmware_releases(release_channel, published_at DESC)
  WHERE deprecated_at IS NULL;
CREATE INDEX idx_edge_firmware_target_hardware
  ON edge.firmware_releases USING GIN (target_hardware);

-- §2.6 v1 audit archive — FINDING-005: RANGE partitioning by migrated_at
-- Parent table:
CREATE TABLE edge.audit_archive_v1 (
    archive_id UUID NOT NULL,
    device_id UUID NOT NULL
      REFERENCES edge.devices(device_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    tenant_id UUID NOT NULL
      REFERENCES auth.tenants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    archive_start_entry_id BIGINT NOT NULL,  -- device-local sequence (clarified in §2.6.1)
    archive_end_entry_id BIGINT NOT NULL,
    archive_encrypted_blob BYTEA NOT NULL,
    archive_sha256 BYTEA NOT NULL
      CHECK (octet_length(archive_sha256) = 32),
    archive_wrapping_key_epoch SMALLINT NOT NULL,  -- ADR-020 §12 cross-rotation
    migrated_at TIMESTAMPTZ NOT NULL,
    retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
    legal_hold_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID NOT NULL REFERENCES auth.users(id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    PRIMARY KEY (migrated_at, archive_id),  -- MUST include partition key
    CHECK (archive_end_entry_id >= archive_start_entry_id)
) PARTITION BY RANGE (migrated_at);

-- Initial monthly partitions (first 12 months + default — pg_partman takes over maintenance)
CREATE TABLE edge.audit_archive_v1_2026_04
  PARTITION OF edge.audit_archive_v1
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- (... 11 more months + default partition via pg_partman setup migration)

CREATE INDEX idx_edge_archive_device_range
  ON edge.audit_archive_v1(device_id, archive_start_entry_id);
CREATE INDEX idx_edge_archive_retention
  ON edge.audit_archive_v1(retention_until) WHERE legal_hold_until IS NULL;

-- pg_partman wiring (follows libs/backend-common/src/database/partition patterns):
-- SELECT partman.create_parent(
--   p_parent_table := 'edge.audit_archive_v1',
--   p_control := 'migrated_at',
--   p_type := 'range',
--   p_interval := '1 month',
--   p_premake := 3,
--   p_automatic_maintenance := 'on'
-- );
-- Retention cleanup: pg_partman drop_partition daily;
-- rows with legal_hold_until NOT NULL protected (partition retention policy conditional).
```

### 2.6.1 `archive_*_entry_id` clarification (FINDING-010 kapama)

`archive_start_entry_id` ve `archive_end_entry_id` **device-local** BIGINT sequence values (edge agent'ın SQLite audit.log entry_id). Global uniqueness yoktur; uniqueness scope `(device_id, entry_id)`. Cross-service identifier değildir → BIGINT OK.

### 3. Row-Level Security (FINDING-004 HIGH closure)

Platform-consistent RLS — libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts kalıbı uygulanır:

```sql
-- On every tenant-scoped table: enable + FORCE
ALTER TABLE edge.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge.devices FORCE ROW LEVEL SECURITY;
ALTER TABLE edge.policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge.policies FORCE ROW LEVEL SECURITY;
ALTER TABLE edge.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge.licenses FORCE ROW LEVEL SECURITY;
ALTER TABLE edge.provisioning_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge.provisioning_records FORCE ROW LEVEL SECURITY;
ALTER TABLE edge.audit_archive_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge.audit_archive_v1 FORCE ROW LEVEL SECURITY;
-- edge.firmware_releases + edge.provisioning_record_witnesses are NOT tenant-scoped
-- (firmware is fleet-global; witnesses join via provisioning_records which IS tenant-scoped)

-- Tenant-isolation policy (same pattern as apply-tenant-rls.helper.ts:327):
CREATE POLICY edge_tenant_isolation ON edge.devices
  USING (tenant_id::text = current_setting('app.current_tenant', true));
CREATE POLICY edge_tenant_isolation ON edge.policies
  USING (tenant_id::text = current_setting('app.current_tenant', true));
CREATE POLICY edge_tenant_isolation ON edge.licenses
  USING (tenant_id::text = current_setting('app.current_tenant', true));
CREATE POLICY edge_tenant_isolation ON edge.provisioning_records
  USING (tenant_id::text = current_setting('app.current_tenant', true));
CREATE POLICY edge_tenant_isolation ON edge.audit_archive_v1
  USING (tenant_id::text = current_setting('app.current_tenant', true));

-- Cross-tenant reporting role for admin dashboards (impersonation + fleet-wide queries):
CREATE ROLE admin_reporting_role;
GRANT USAGE ON SCHEMA edge TO admin_reporting_role;
GRANT SELECT ON ALL TABLES IN SCHEMA edge TO admin_reporting_role;
CREATE POLICY edge_admin_reporting ON edge.devices
  TO admin_reporting_role USING (true);
CREATE POLICY edge_admin_reporting ON edge.policies
  TO admin_reporting_role USING (true);
-- (... same for other tables)
-- INVARIANT: NEVER grant BYPASSRLS to any role; use TO admin_reporting_role USING (true) pattern.

-- Tenant-context set via TenantContextMiddleware (libs/backend-common):
-- SET LOCAL app.current_tenant = '<tenant_uuid>';  -- per-request
```

### 4. TenantScopedRepository (application layer — defense-in-depth alongside RLS)

```typescript
// apps/admin-api-service/src/edge/repositories/edge.repository.ts
// WHY: RLS is Tier-1 at DB; repository scope is Tier-1 at application API surface.
//      Defense-in-depth: both layers must agree on tenant scoping.
export abstract class TenantScopedRepository<T> {
  protected abstract tableName: string;

  async findByTenant(tenantId: TenantId): Promise<T[]> {
    return this.em.createQueryBuilder()
      .where('tenant_id = :tenantId', { tenantId: tenantId.toString() })
      .getMany();
  }
  // NO findAll() — compile-time API surface denies global scope
}
```

### 5. Tenant lifecycle — cryptographic erasure only (FINDING-009 closure)

**INVARIANT:** `auth.tenants` rows are NEVER hard-deleted platform-wide. Soft-delete via `deactivated_at` + cryptographic erasure (ADR-020 §10) only.

```
Tenant deactivation (soft):
  1. auth.tenants.deactivated_at = now() + cryptographic-erase tenant PII fields
  2. edge.devices WHERE tenant_id = $1 → status = 'decommissioned'
  3. edge.policies WHERE tenant_id = $1 → valid_until = now() (+ trigger unsets is_current)
  4. edge.licenses WHERE tenant_id = $1 → expires_at = now()
  5. edge.provisioning_records retained (regulatory 7-year); issued_by_operator_id
     nullable (pseudonymization support); ON DELETE RESTRICT FK still valid
  6. edge.audit_archive_v1 retained per retention_until / legal_hold_until

Operator (user) cryptographic erasure (GDPR Art 17 / KVKK Art 7):
  1. Tenant_erasure_key destruction renders operator-pseudonym unlinkable (ADR-020 §10)
  2. edge.provisioning_records.issued_by_operator_id set NULL;
     pseudonymized_at = now()
  3. FK RESTRICT still protects auth.users row (user row soft-deleted but not removed;
     RESTRICT doesn't trigger because no hard delete)

Platform-level discipline:
  - DELETE FROM auth.tenants → FORBIDDEN (documented + RLS-policy-level deny for non-superuser)
  - DELETE FROM auth.users → FORBIDDEN same pattern
  - Only DROP operations allowed at compliance retention boundary (ADR-020 §14)
```

### 6. Migration strategy — forward-only for compliance

```
Order of migrations (db-migrate CLI):
  1. Enable btree_gist extension + schema-registry update (apps/db-migrate/src/schema-registry.ts)
  2. CREATE SCHEMA edge (owner: admin_service) + GRANTS
  3. CREATE TABLE edge.devices + RLS + policies
  4. CREATE TABLE edge.policies + trigger + RLS
  5. CREATE TABLE edge.licenses + EXCLUDE constraint + RLS
  6. CREATE TABLE edge.provisioning_records + junction + RLS
  7. CREATE TABLE edge.firmware_releases (no RLS — fleet-global)
  8. CREATE TABLE edge.audit_archive_v1 (partitioned) + pg_partman setup + RLS
  9. Seed: edge.firmware_releases 'rescue' channel baseline row

Platform deployment ordering (staged):
  A. Deploy db-migrate — schema + tables created, no writers
  B. Deploy admin-api-service — writers active; admin-only reads
  C. Deploy auth-service (backward-compat adapter for legacy → edge.policies)
  D. Deploy billing-service (edge.licenses integration)
  E. Deploy sensor-service (edge.devices read path)
  F. Legacy adapter removed in v2.1.0 follow-up

Feature flag: `edge_schema_v2_enabled` per-tenant (signed config via ADR-018 §6);
staged rollout with manifest-driven activation.

FORWARD-ONLY IN PRODUCTION (FINDING-018 closure):
  Down migrations exist but refuse to execute without FORCE_DESTROY_REGULATORY_DATA=true
  env + explicit backup checkpoint. Rollback = restore from PITR backup, not DROP SCHEMA.
  Runbook: docs/runbooks/edge-schema-migration-rollback.md (Faz 8 deliverable)
```

### 7. TypeORM entity placement — `synchronize: false` mandate (FINDING-008 HIGH closure)

```typescript
// apps/admin-api-service/src/edge/entities/edge-device.entity.ts
@Entity('devices', { schema: 'edge' })
export class EdgeDeviceEntity { ... }

// ALL 7 edge entities:
//   edge-device.entity.ts                   schema: 'edge', table: 'devices'
//   edge-policy.entity.ts                    schema: 'edge', table: 'policies'
//   edge-license.entity.ts                   schema: 'edge', table: 'licenses'
//   edge-provisioning-record.entity.ts       schema: 'edge', table: 'provisioning_records'
//   edge-provisioning-witness.entity.ts      schema: 'edge', table: 'provisioning_record_witnesses'
//   edge-firmware-release.entity.ts          schema: 'edge', table: 'firmware_releases'
//   edge-audit-archive-v1.entity.ts          schema: 'edge', table: 'audit_archive_v1'

// All consuming services (admin-api-service, auth-service, billing-service,
// sensor-service) MUST declare:
//   TypeOrmModule.forRoot({
//     synchronize: false,   // MANDATED — edge schema includes partitioned table;
//                           //  TypeORM cannot model RANGE partitioning declaratively
//     migrationsRun: false,
//     migrations: [...classes],
//   });

// Invariant: tests/invariants/edge-entity-synchronize-off.spec.ts
//   - Parse TypeOrmModule config in each service that imports any edge entity
//   - Assert synchronize: false
//   - Assert migrationsRun: false
```

### 8. Schema invariant tests (ADR-012 compliance extension)

```typescript
// e2e/tests/integration/schema-invariants.spec.ts — EXTEND:
describe('edge schema invariants', () => {
  it('edge schema exists with admin_service owner', async () => { /* ... */ });
  it('exactly 7 tables in edge schema', async () => {
    const expected = [
      'devices', 'policies', 'licenses',
      'provisioning_records', 'provisioning_record_witnesses',
      'firmware_releases', 'audit_archive_v1'
    ];
    /* ... */
  });
  it('all tenant-scoped edge tables have tenant_id FK with explicit ON DELETE/UPDATE RESTRICT', async () => { /* ... */ });
  it('grants match ADR-022 §1 contract exactly', async () => { /* ... */ });
  it('RLS enabled + FORCED on all tenant-scoped tables', async () => { /* ... */ });
  it('edge.policies exactly-one is_current per tenant invariant', async () => { /* ... */ });
  it('edge.licenses no temporal overlap per tenant (EXCLUDE constraint)', async () => { /* ... */ });
  it('edge.audit_archive_v1 partitioned by migrated_at monthly', async () => { /* ... */ });
  it('all SHA-256 columns are BYTEA with octet_length=32 CHECK', async () => { /* ... */ });
  it('no edge entity declares @Entity() without schema: "edge"', async () => { /* ... */ });
  it('consuming services have synchronize: false in TypeOrmModule', async () => { /* ... */ });
});

// tests/invariants/:
//   edge-repository-tenant-scoped.spec.ts
//   edge_schema_grants.spec.ts
//   edge-entity-synchronize-off.spec.ts
//   edge-rls-tenant-isolation.spec.ts (fuzz: set app.current_tenant → query crosses tenant → 0 rows)
```

### 9. Cross-service read performance

- auth-service `fetch_active_manifest(tenant_id)`: hot-path index `idx_edge_policies_tenant_hotpath` → index-only scan; p99 < 5ms
- sensor-service `devices_for_tenant(tenant_id)`: `idx_edge_devices_tenant` → p99 < 2ms
- billing-service `latest_license(tenant_id)`: `idx_edge_licenses_tenant_recent` → p99 < 2ms
- admin dashboard fleet view: `idx_edge_devices_status_active` → p99 < 10ms for 500-device fleets
- pg_partman daily maintenance: <30s (new partition creation + retention-cleanup DROP)

### 10. edge.devices global-vs-per-tenant decision rationale (FINDING-016 kapama)

Quantified access pattern justifying global table over per-tenant schema-per-tenant:

- **Admin-api dashboard fleet view:** 1 query/5s per admin session × 10 concurrent = 2 QPS, filtered by `hardware_model`, `status`, or tenant-scope
- **Security-response revocation:** 1 query per cert-rotation event (rare, but must scan fleet)
- **Fleet-wide firmware analytics:** "which devices run firmware v2.0.1?" daily admin report; 1 QPS peak
- **Sensor-service device lookup:** N queries/tenant-request; only needs current tenant; would benefit from per-tenant partition pruning BUT cross-tenant (admin / security) path dominates

**Decision:** Global `edge.devices` with `tenant_id` column + RLS policy. Cross-tenant queries (admin + security) don't pay UNION ALL cost across 500 schemas. Sensor-service cost marginal (index lookup via `idx_edge_devices_tenant`).

### 11. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-022-FINDING-001 | CRITICAL | §1 | Canonical role names (`auth_service`, `admin_service`, `billing_service`, `sensor_service`); AUTHORIZATION admin_service; SSoT ref |
| ADR-022-FINDING-002 | CRITICAL | §2.2 + §2.3 | `is_current` BOOLEAN + trigger (policies); EXCLUDE USING gist + btree_gist (licenses); no `now()` in predicates |
| ADR-022-FINDING-003 | CRITICAL | §2 all sha256 columns | BYTEA NOT NULL + CHECK octet_length=32; no CHAR(64) |
| ADR-022-FINDING-004 | HIGH | §3 RLS | ENABLE + FORCE + CREATE POLICY + admin_reporting_role; platform-consistent; invariant test |
| ADR-022-FINDING-005 | HIGH | §2.6 partitioning | RANGE (migrated_at) monthly + pg_partman; composite PK includes migrated_at |
| ADR-022-FINDING-006 | HIGH | §2 all FKs | ON DELETE RESTRICT ON UPDATE RESTRICT explicit everywhere |
| ADR-022-FINDING-007 | HIGH | §2.2 | `idx_edge_policies_tenant_hotpath` INCLUDE covering index; `is_current` partial |
| ADR-022-FINDING-008 | HIGH | §7 | `synchronize: false` mandate + invariant test |
| ADR-022-FINDING-009 | HIGH | §5 | Cryptographic erasure only; `auth.tenants` hard-delete FORBIDDEN platform-wide |
| ADR-022-FINDING-010 | MEDIUM | §2.6.1 | `archive_*_entry_id` device-local scope clarified |
| ADR-022-FINDING-011 | MEDIUM | §2.1 + §2.5 | `hardware_model` CHECK IN (...); `target_hardware` CHECK + GIN index |
| ADR-022-FINDING-012 | MEDIUM | §2 manifest_json | CHECK (manifest_json ? 'custom_roles'...); no GIN prophylactically |
| ADR-022-FINDING-013 | MEDIUM | §2.4 witnesses | Junction table edge.provisioning_record_witnesses + FK + role enum |
| ADR-022-FINDING-014 | MEDIUM | §2 all tables | `created_by`, `updated_by` on every table (FK auth.users) |
| ADR-022-FINDING-015 | MEDIUM | §2.3 license_jwt TEXT | RFC-7519 canonical; comment documents; no BYTEA switch |
| ADR-022-FINDING-016 | MEDIUM | §10 | Quantified access pattern; global table justified |
| ADR-022-FINDING-017 | LOW | §2.2 trigger | `updated_at := now()` in trigger (applies to policies); pattern extensible to other tables |
| ADR-022-FINDING-018 | LOW | §6 | Forward-only in production; FORCE_DESTROY_REGULATORY_DATA env gate; runbook |
| ADR-022-FINDING-019 | LOW | §2 all epoch columns | SMALLINT (not INT) for signing_key_epoch / firmware_signing_epoch / etc |
| ADR-022-FINDING-020 | INFO | §2.2 comment | COMMENT ON COLUMN denormalization justification |

---

## Alternatives Considered (unchanged rationale)

### Alt-1 `shared` genişletme → W5 BLOCKER-15 → REDDET
### Alt-2 Per-tenant schema → edge tabloları platform-owned değil tenant-owned; over-apply → REDDET
### Alt-3 `auth`/`billing` schema extend → ownership bulanıklaşır → REDDET
### Alt-4 Dedicated `edge` schema → KABUL

---

## Consequences

### Positive
- **ADR-011 + ADR-012 compliance:** shared 4-canonical invariant korunur; schema-drift invariant test extended
- **Tenant isolation defense-in-depth:** RLS (DB Tier-1) + TenantScopedRepository (app Tier-1) + invariant fuzz
- **Service ownership explicit:** canonical role grants; no ambiguity; audit-test-enforced
- **Compliance safety:** forward-only migrations; cryptographic erasure only; hard-delete FORBIDDEN
- **Performance architected:** hot-path covering index; partitioning for audit archive; FK indices; GIN where justified
- **Type discipline:** BYTEA for hashes; SMALLINT for epochs; CHECK constraints for enum-like columns
- **Downstream unblocker:** PLA-003/004/005 all satisfied; ADR-017/018/019/020 platform integration complete

### Negative
- **Migration coordination:** 9-step migration; 4-service rollout; 2-3 week window
- **pg_partman operational overhead:** partition creation automated but requires monitoring
- **btree_gist extension dependency:** requires install on DB; CloudSQL/RDS support OK
- **Implementation complexity:** trigger (is_current maintenance) + RLS policies + EXCLUDE constraints — more DB machinery than naive schema

### Neutral
- **Row count projections refined:** 500 tenants × 50 devices × 7 years × 100 archive segments × 100 MB BYTEA = 175 TB worst case (partitioned; DROP PARTITION O(1)); base case ~1.8 TB manageable

---

## Implementation Plan (Plan §5 Faz 8)

**Hafta 20-23:**

1. Sprint 20.1: btree_gist extension + 9 migrations (includes pg_partman setup)
2. Sprint 20.2: TypeORM entities (7) + TenantScopedRepository + `synchronize: false`
3. Sprint 20.3: GRANT + RLS scripts + invariant tests
4. Sprint 21.1: admin-api EdgePolicyController + EdgeLicenseController + EdgeAuditController (PLA-005)
5. Sprint 21.2: auth-service backward-compat adapter + hot-path index validation
6. Sprint 21.3: billing-service edge-license resolver (PLA-003/004)
7. Sprint 22.1: sensor-service edge.devices read + cross-tenant impersonation path
8. Sprint 22.2: Feature flag + staged rollout + invariant test suite green
9. Sprint 22.3: E2E cross-ADR integration (ADR-017/018/019/020 platform consumers)
10. Sprint 23.1: Legacy cleanup + runbook docs/runbooks/edge-schema-migration-rollback.md

**Acceptance:**
- All 11+ invariant tests green
- 9 migrations applied + forward-only discipline verified (dev rollback test separate)
- PLA-003/004/005 RESOLVED
- pg_partman daily maintenance SLO 99.9% / 30-day window
- Status → Accepted

---

## References

- CLAUDE.md §Schema Ownership Model + W5 skill gate BLOCKER-15
- ADR-011 / ADR-012
- `infrastructure/docker/init-scripts/00-init-schemas.sh` — canonical role names SSoT
- `apps/db-migrate/src/schema-registry.ts` — schema SSoT
- `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts` — RLS pattern
- `apps/farm-service/src/database/migrations/1781000000000-RefreshTenantRlsPredicate.ts` — reference
- `apps/messaging-service/src/migrations/` — partitioned-table reference
- pg_partman documentation
- ADR-017/018/019/020 — downstream consumers

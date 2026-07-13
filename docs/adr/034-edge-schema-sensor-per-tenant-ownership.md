# ADR-034: Edge Feature Schema Placement — Per-Tenant under `sensor` Schema (sensor-service Ownership)

**Status:** Accepted
**Date:** 2026-05-18
**Deciders:** Okan (platform owner) + data-expert + database-reviewer + multi-tenant-saas-expert + architectural-arbiter + sensor-expert + edge-expert + admin-expert
**Owner:** Okan
**Related findings:** ADR-022-FINDING-001..020 (post-audit closure → reinterpreted here)
**Related plans:** `/root/.claude/plans/peppy-crafting-waterfall.md` Faz 2
**Supersedes:** **ADR-022 (Proposed) — dedicated `edge` schema under admin-api-service ownership.**

---

## Context (WHY)

ADR-022 proposed a dedicated `edge` schema owned by `admin-api-service` (writer) with sensor/billing/auth roles as readers. The 8-agent + 10-agent cross-review on 2026-05-18 surfaced two architectural objections that the original ADR-022 had not addressed:

1. **Migration owner ≠ runtime owner (ADR-011 violation).** sensor-service's `apps/sensor-service/src/edge-device/` already owns every runtime concern for edge devices: provisioning (`provisioning.service.ts`), MQTT auth, GraphQL surface (`edge-device.resolver.ts`), and 5 existing per-tenant entities (`edge-device.entity.ts`, `lora-device.entity.ts`, `device-event.entity.ts`, `device-io-config.entity.ts`, `tenant-provisioning-key.entity.ts`). Asking `admin-api-service` to author the new v2 migrations + entities for tables that sensor-service then consumes via dual-read adapter creates a Conformist+Big-Ball-of-Mud antipattern: admin becomes the silent shape-decision-maker, sensor becomes the read-only consumer. Every entity change goes through a service that does not run the queries. ADR-011's "schema owner = service owner" invariant is broken at the seam.

2. **Per-tenant semantics are correct for the tables themselves.** Every column inspection of the 7 v2 tables — `devices`, `policies`, `licenses`, `firmware_releases`, `provisioning_records`, `witnesses`, `audit_archive_v1` — shows `tenant_id uuid NOT NULL` as the leading index column. A physical edge device belongs to exactly one tenant; cross-tenant device transfer is not a supported operation (lock-in to tenant lifecycle, license, audit chain). Per-tenant placement matches the row-level access pattern verbatim. Cross-tenant fleet-management queries (operator dashboard) are O(N tenants × edge devices) at admin-side and serve only super-admin views — Open Host Service from sensor-service covers this without ADR-011-grade compromise.

The original ADR-022 cited "operator fleet view" as the driver for cross-tenant schema placement. That driver is real but addressable: sensor-service exposes a `getFleetDevices(filter)` query that admin-api consumes; the fleet view does not require a single physical schema.

Edge-expert's strongest objection to per-tenant placement — "ADR-022 §2 hash columns, EXCLUDE constraints, partition policy, audit chain — these are platform-scale constraints" — is sustained: the **constraints** stay. They are applied per-tenant via the per-tenant DDL clone path the same way every other tenant-scoped table receives `tenant_isolation_policy` + immutability triggers. Per-tenant scope does NOT mean per-tenant SHAPE; the canonical shape lives in `sensor` source schema and clones to each `tenant_<uuid>` via `TenantSchemaSyncService` + Faz 1.12 entity-parity invariant.

## Decision (WHAT)

1. **Schema:** edge tables live under the `sensor` schema (per-tenant pattern). No dedicated `edge` schema.
2. **Owner:** `sensor-service` writes migrations and owns entity files.
3. **Per-tenant tables (7):** `devices`, `policies`, `licenses`, `firmware_releases`, `provisioning_records`, `witnesses`, `audit_archive_v1`. All carry `tenant_id uuid NOT NULL`. All cloned to `tenant_<uuid>` schemas by the db-migrate tenant schema provisioner.
3. **Entity location:** `apps/sensor-service/src/edge-device/entities/v2/*.entity.ts`. No `schema:` declaration (per-tenant pattern). Existing v1 entities (`edge-device.entity.ts`, etc.) remain alongside; v2 dual-write adapter coordinates the cutover.
4. **MODULE_SCHEMAS update:** `libs/backend-common/src/database/schema-manager.service.ts` `sensor` module `tables` array gets the 7 new table names appended. This drives the `CREATE TABLE LIKE source INCLUDING ALL` fan-out for new tenants automatically.
5. **admin-api access:** Open Host Service. admin-api consumes a `getFleetDevices(filter)` / `getDevicePolicy(deviceId)` / `getDeviceAuditChain(deviceId)` query surface exposed by sensor-service (GraphQL federation or REST — implementation choice). admin-api **does not write** edge tables. admin-api **does not read** them via direct SQL.
6. **DDL constraints preserved from ADR-022 §2 where active migrations implement them:** BYTEA NOT NULL + CHECK octet_length=32 for hash columns. EXCLUDE USING gist for license temporal overlap. is_current BOOLEAN + trigger + partial unique index for policies. `audit_archive_v1` is append-only with composite `(migrated_at, archive_id)` primary key; no active migration declares partitioning yet. ON DELETE RESTRICT / ON UPDATE RESTRICT on every active FK. witness_role constrained string + 64-byte witness signature. created_by/updated_by UUID REFERENCES auth.users RESTRICT.
7. **Tenant deletion:** cryptographic erasure only (per ADR-022 §5 retained). `auth.tenants` hard-delete remains FORBIDDEN; tenant offboarding flips state + redacts keying material.
8. **Cutover:** Faz 6 baseline reset is the cutover point. Pre-Faz-6, no migration writes the v2 tables. Faz 6 baseline migration creates them per-service in `sensor` source schema + `TenantSchemaSyncService` clones them into every new `tenant_<uuid>` thereafter. There is no Phase 0–4 dual-write window because there is no production tenant data to preserve (the day-one reset wipes pre-existing tenants).

## Consequences

### Positive

- **ADR-011 invariant restored.** Schema owner = service owner = runtime owner. Entity changes flow through the service that actually queries them; reviewer load concentrates correctly on sensor-expert + multi-tenant-saas-expert.
- **`schema_drift_clean` boot signal validates v2 tables for free.** `SchemaDriftValidator` runs against sensor-service's entity metadata; v2 entities under `sensor` source schema are validated by the same code path that validates `edge_devices`, `lora_devices`, etc.
- **Tenant erasure cascade gains v2 tables automatically.** `gdpr-erasure-executor`'s sensor-service handler purges `tenant_<uuid>`'s schema; v2 device/policy/license/audit data follows the tenant out of existence by construction.
- **No new schema role to manage.** Existing `sensor_service` role + grants are sufficient; no `edge_admin_role`, no separate `admin_reporting_role`. RLS predicate is the canonical helper-emitted one (Faz 1.7 invariant) — no edge-specific RLS dialect.

### Negative

- **Cross-tenant fleet queries become inter-service calls.** admin-api → sensor-service (Open Host Service) adds one network hop per fleet-view page render vs ADR-022's direct cross-schema `SELECT`. Mitigation: dedicated read endpoint with strict pagination, sensor-service caches frequent fleet-view shapes. Operationally negligible: super-admin fleet views are O(seconds), not O(ms).
- **`audit_archive_v1` per-tenant partitioning multiplies the partition count by tenant count.** ADR-022 assumed one global `audit_archive_v1` table partitioned by `migrated_at`; per-tenant means each `tenant_<uuid>.audit_archive_v1` partitions independently. At scale (1000 tenants x 12 monthly partitions = 12000 partitions), `pg_class` size grows but stays within PostgreSQL's healthy bounds (Postgres handles 100k+ partitions reliably). Long-term migration to a global `event_store.edge_audit_archive` with tenant_id partition key is on the table if partition count becomes a performance signal; captured as a tracked follow-up, not an ADR-034 blocker.
- **edge-expert's Rust agent cutover requires sensor-service-aware activation.** Rust gateway already activates through sensor-service's `provisioning.service.ts`; the v2 trust-bundle payload extension is routed through that same endpoint. No new Rust integration surface.

### Architectural risk tier

Tier 1 (make-it-impossible). The schema owner / runtime owner / migration owner are unified by construction; there is no future drift path where they diverge silently.

## Alternatives Considered

### Alternative A — Keep ADR-022 (dedicated `edge` schema, admin-api owner)

Rejected. Migration owner ≠ runtime owner is the architectural cost; the original ADR-022 acknowledges this in §10 as a "long-term split" but does not provide the structural fix. The 8-agent cross-review identified the consequence: every v2 schema change requires admin-api migration authorship + sensor-service consumer adapter changes in lockstep, with no single CODEOWNERS reviewer who covers both. Cross-service migration coordination becomes the bottleneck.

### Alternative B — New `device-registry-service`

Rejected. Adds a 15th microservice to host 7 tables that share their entire runtime concern with sensor-service. Operational overhead (separate container, separate health probe, separate deploy lane) without a corresponding architectural gain. The bounded context for "device lifecycle + telemetry + policy + license + audit" is correctly drawn around sensor-service today; splitting it would require splitting `edge_devices` too (the v1 table sensor-service already owns), which is a regression.

### Alternative C — `sens-api-gateway` cloud-companion NestJS service

Rejected. Couples cloud-side schema authorship to the Rust edge-agent's release cadence — every Rust release would touch a NestJS service. The current sensor-service architecture already provides the cloud-companion role; conflating the two services would re-introduce the runtime/migration owner mismatch under a different name.

## Operational

- **Migration path file:** `apps/sensor-service/src/database/migrations/<timestamp>-Baseline.ts` (Faz 3 of day-one reset) consolidates all sensor-service tables including the 7 v2 edge tables.
- **Entity files:** `apps/sensor-service/src/edge-device/entities/v2/{device,policy,license,firmware-release,provisioning-record,witness,audit-archive}-v2.entity.ts`.
- **MODULE_SCHEMAS edit:** `libs/backend-common/src/database/schema-manager.service.ts` `sensor` module entry — append 7 table names to `tables`; the existing entries (edge_devices, lora_devices, device_events, device_io_configs, tenant_provisioning_keys) remain.
- **Open Host Service spec:** sensor-service exposes a `FleetDevicesQuery` GraphQL operation + REST mirror. admin-panel UI consumes via existing federation gateway. No GraphQL operation name changes; admin already federates sensor-service.
- **Plan dossier:** `docs/plans/2026-05-12-sens-api-gateway-edge-platform-v2-revision.md` Phase 2 ownership clause is rewritten to reference ADR-034 and explicitly retract the ADR-022 admin-api ownership stance.

## Compliance

- ADR-011 Schema Ownership Model: satisfied (sensor-service owns sensor schema; edge v2 tables are part of sensor schema).
- ADR-012 Schema Drift Prevention: satisfied (entity-fingerprint manifest catches drift on sensor-service entity files; Faz 1.6 entity-schema-declaration spec verifies per-tenant pattern).
- ADR-022 §5 cryptographic erasure: carried forward verbatim.
- ADR-022 §3 RLS: replaced by Faz 1.7 RLS canonical predicate invariant — sensor-service per-tenant tables already use it; the 7 v2 tables inherit by being part of sensor schema.

## Coexistence: v1 `edge_devices` ↔ v2 `devices` during the cutover (DB-SENSOR-MEDIUM-003)

Added 2026-07-13 (database E2E audit remediation Faz 8-A11, tracked as
`docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-390`). Both device models are
registered in `apps/sensor-service/src/edge-device/edge-device.module.ts` at
the same time — this is DISCLOSED work-in-progress mid-cutover, not drift:

- **v1 (`edge_devices`, entity `EdgeDevice`) is production-active.** All
  runtime writes (`edge-device.service.ts`, `provisioning.service.ts`,
  `mqtt-auth.service.ts`) and the GraphQL surface operate on v1. v1 is NOT
  retired outside the planned cutover.
- **v2 (the 7-table family above, entity `EdgeDeviceV2` et al.) is the
  target model.** It is migration-created and module-registered so tenant
  fan-out, RLS, and `SchemaDriftValidator` cover it from day one, but it has
  no runtime write path yet.
- **Single-writer-per-model rule:** no service file may write both the v1
  and the v2 device row. The cutover is a routing flip at a single seam, not
  an interleaved dual-write scattered across handlers — interleaving is how
  split-brain rows are born. Enforced at PR time by
  `tests/invariants/edge-device-dual-model-guard.spec.ts` (grep-based: a
  file acquiring both models' repositories, or issuing writes against both
  tables, fails the invariant unless explicitly allowlisted with a WHY).
- The coexistence contract is mirrored in the `EdgeDeviceV2` entity
  docblock (`apps/sensor-service/src/edge-device/entities/v2/device-v2.entity.ts`)
  so it is visible at the point of use.

## Open Items

- **OPEN-ADR-034-1:** `audit_archive_v1` partition-count budget under per-tenant scaling. Tracked as a Faz 8 monitoring signal: if partition count crosses a threshold operationally relevant on production (target: > 50k partitions OR pg_class oid pressure), revisit the global `event_store` placement option.

# ADR-011: Per-Service Schema Ownership Model

**Status:** Accepted (2026-04-14)
**Supersedes:** Implicit "everything goes to public" convention

## Context

The 2026-04-14 production log audit surfaced an active multi-tenant
isolation bug: three services (billing, config, notification) ran without
PostgreSQL Row-Level Security on 14 tenant-scoped tables in the `public`
schema. The root cause was that `@Entity()` decorators in those services
had been written without the `schema:` option, causing TypeORM to default
the table location to `public`. PostgreSQL requires table ownership for
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; service users connect as
per-service roles (e.g. `billing_service`) which did not own the
`aquaculture` superuser-created public tables, so RLS bootstrap failed
silently — leaving every public table reachable cross-tenant from any
SUPER_ADMIN-less authenticated session.

The acute fix (commit ef8e1042 + follow-up commits in the 2026-04-14
teardown) closed the immediate hole. This ADR documents the architectural
model that prevents the class of bug from recurring.

## Decision

Establish a three-tier schema ownership model:

### Tier 1: Service schemas

Every backend service that holds tenant-scoped or service-private data
owns a single PostgreSQL schema named after itself:

| Service              | Schema         | Owner role            |
|----------------------|----------------|-----------------------|
| auth-service         | `auth`         | `auth_service`        |
| farm-service         | `farm`         | `farm_service`        |
| sensor-service       | `sensor`       | `sensor_service`      |
| hr-service           | `hr`           | `hr_service`          |
| billing-service      | `billing`      | `billing_service`     |
| notification-service | `notification` | `notification_service`|
| alert-engine         | `alert`        | `alert_service`       |
| ai-service           | `ai`           | `ai_service`          |
| messaging-service    | `messaging`    | `messaging_service`   |
| hydroponics-service  | `hydroponics`  | `hydroponics_service` |
| admin-api-service    | `admin`        | `admin_service`       |
| gateway-api          | `gateway`      | `gateway_service`     |
| config-service       | `config`       | `config_service`      |
| event-store-service  | `event_store`  | `event_store_service` |
| observability-service| `observability`| `observability_service`|

Schemas + roles + ownership are created in
`infrastructure/docker/init-scripts/00-init-schemas.sh`.

**Entity decoration discipline (Wave 4-A.2 update, 2026-05-08):**

Two distinct entity-decoration conventions, BOTH correct, depending on
whether the service is tenant-scoped:

1. **Platform-level services** (`auth`, `billing`, `admin`, `notification`,
   `event_store`, `observability`, `config`, `gateway`) — every entity
   declares `schema: '<owner>'` explicitly. The data lives in a single
   schema; cross-service consumers read with schema-qualified queries.

2. **Tenant-scoped services** (`farm`, `sensor`, `hr`, `messaging`,
   `hydroponics`, `ai`, `alert`) — per-tenant entities OMIT the
   `schema:` parameter. The runtime sets
   `search_path = "tenant_<uuid>", public` per request, so unqualified
   table references resolve into the tenant's clone schema
   (`tenant_<uuid_first_16_hex>`). The source
   schema (`farm`, `sensor`, etc.) holds template tables that
   `TenantSchemaSyncService` copies into each tenant clone via
   `CREATE TABLE LIKE source.X INCLUDING ALL`. Pinning `schema: 'farm'`
   on a per-tenant entity would BYPASS the routing and write data to
   the source — the architecture spec at
   `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts`
   forbids this on every PR.

3. **Cross-tenant exceptions WITHIN tenant-scoped services** — outbox
   tables (`farm_outbox`, `messaging_outbox`, `hr_outbox`), audit logs
   (`farm_audit_logs`, `payroll_audit`, `alert_audit_log`,
   `tool_execution_audit`, `sensor_audit_logs`), and operational
   reference data (`code_sequences`, `tenant_erasure_audit`) keep
   `schema: '<source>'` explicit. They live in the source schema only
   (single cross-tenant copy) and are not cloned per tenant.

The CI invariant test (`e2e/tests/integration/schema-invariants.spec.ts`)
and the runtime schema-drift validator (`createSchemaDriftValidator` in
backend-common) enforce both conventions.

**Migration ledger boundary (2026-05-17 update):**

TypeORM migration ledger objects inside a service schema
(`typeorm_migrations`, `migrations_id_seq`, and equivalent metadata) are
infrastructure metadata, not service domain data. Ownership-repair
migrations must therefore declare the service domain surface they repair
and must not sweep every `pg_class` object in the schema.

For sequence repair, the canonical discovery path is `pg_depend` from a
sequence to a whitelisted domain table/column (`deptype IN ('a', 'i')`).
Schema-wide `relkind = 'S'` ownership sweeps are forbidden because they
capture metadata sequences owned by the migration ledger and break
database bootstrap before application containers start. This contract is
guarded by `tests/invariants/postgres-ddl-contract.spec.ts`.

### Tier 2: `shared` schema

Cross-service infrastructure tables — those written by three or more
services, or read by every service — live in a dedicated `shared` schema
owned by the `shared_schema_owner` group role. All service users are
members of this role via `GRANT shared_schema_owner TO <svc>_service`,
which gives every member ALTER privileges (needed for RLS bootstrap and
schema migrations) without exposing superuser credentials.

Currently (amended 2026-07-12 by ADR-042) the shared schema contains exactly
four tables:

  - `shared.audit_logs` — cross-service audit trail (backend-common's
    AuditLogEntity, written by billing/config/notification/alert/ai/
    admin-api).
  - `shared.gdpr_data_requests` — compliance: GDPR data-export tracking.
  - `shared.user_consents` — compliance: consent records.
  - `shared.access_logs` — cross-service access trail (backend-common's
    AccessLogEntity), distinct from audit_logs by retention policy and
    cardinality (access_logs are write-many, audit_logs are write-once).

> **Amendment (2026-07-12, ADR-042):** `shared.user_permissions` — originally
> listed here as "platform-wide RBAC, READ by every service" — was retired.
> No service ever read it; the live RBAC SSoT is the auth-service tenant RBAC
> (`auth.tenant_role_permissions.panel_permissions`). See
> `docs/adr/042-retire-shared-user-permissions.md` (ORPHAN-HIGH-378).

Adding a new shared table requires an ADR + architectural-arbiter
approval AND an update to the CI invariant (`SHARED_SCHEMA_TABLES` set
in schema-invariants.spec.ts). The `add-shared-table` skill gate
(BLOCKER-15) enforces this at PR time.

### Tier 3: `public` schema — application-empty

`public` is **forbidden** for application data. The CI invariant asserts
the only allowed table is TypeORM's `migrations` meta. PostgreSQL
extension artifacts (`pg_trgm` operators, etc.) live in `public` by
default; they are tolerated.

The historical convention "public = shared" produced the 2026-04-14
incident. Eliminating that convention removes the entire class of "did
you remember to set `schema:` on this entity?" footguns — the CI
invariant catches the omission immediately.

## Consequences

### Positive

- **RLS bootstrap is naturally correct.** Each service owns its schema
  and can ALTER its own tables without role-membership gymnastics.
- **Cross-service reads are explicit.** A consumer reading
  `shared.audit_logs` is doing so deliberately; the schema
  qualification documents the cross-service dependency in the query
  itself.
- **Tenant schema replication maps cleanly.** Source tables in service
  schemas get `CREATE TABLE LIKE INCLUDING ALL`-replicated into each
  `tenant_<uuid>` schema by `TenantSchemaSyncService`. Public-located
  tables would have polluted the per-tenant copies with cross-service
  contamination — the previous root cause for the farm-service strict
  ownership enforcement (see MODULE_SCHEMAS[farm].strictOwnership).
- **Migrations are deterministic.** Each service has its own
  `MigrationRunnerService` (extracted to backend-common as a factory
  in P2 of the teardown) so schema state advances through committed
  migration files, not runtime bootstraps.

### Negative / open questions

- **config-service moved to `config` schema (Wave 4-A.2, 2026-05-08).**
  Open question resolved: dedicated `config` schema + `config_service`
  role created in 00-init-schemas.sh. Configuration entity declares
  `schema: 'config'`. Backfill on legacy droplets handled by
  `MovePublicTablesToConfig` migration if needed.
- **Cross-tenant analytics queries become slightly harder to write.**
  Joining `shared.audit_logs` with `farm.batches_v2` requires
  schema-qualified joins instead of an unqualified-name lookup via
  search_path. Tradeoff: explicit > implicit.

## Enforcement

  - **Commit-time:** ESLint custom rule `require-entity-schema` enforces
    explicit `schema:` metadata on platform-level and source-scoped
    entities. Tenant-scoped per-tenant entities stay unqualified so
    request-scoped `search_path` routing can select the tenant clone;
    `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts`
    guards that inverse contract for farm-service.
  - **CI:** `e2e/tests/integration/schema-invariants.spec.ts` asserts
    the public/shared/per-service layout on every PR build.
  - **Runtime:** `createSchemaDriftValidator(serviceName)` from
    backend-common compares entity metadata to information_schema at
    every cold start; configurable to fail boot via
    `SCHEMA_DRIFT_FATAL=true`.

## Migration history

The full transition is documented in
`docs/plans/2026-04-14-public-schema-teardown/` (this ADR's source
plan). 14 commits between 2026-04-14 and the date of this ADR moved
10 single-owner tables to their service schemas (P6-P8), consolidated
4 cross-service tables into the new `shared` schema (P9), and wired
migration runners + drift prevention so the model stays enforced
(P2, P11).

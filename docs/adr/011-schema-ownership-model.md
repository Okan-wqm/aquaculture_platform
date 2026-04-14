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
| config-service       | (uses public — see open question below) |

Schemas + roles + ownership are created in
`infrastructure/docker/init-scripts/00-init-schemas.sh`. Each entity
owned by a service MUST declare `schema: '<owner>'` in its `@Entity()`
decorator. The CI invariant test
(`e2e/tests/integration/schema-invariants.spec.ts`) and the runtime
schema-drift validator (`createSchemaDriftValidator` in backend-common)
enforce this.

### Tier 2: `shared` schema

Cross-service infrastructure tables — those written by three or more
services, or read by every service — live in a dedicated `shared` schema
owned by the `shared_schema_owner` group role. All service users are
members of this role via `GRANT shared_schema_owner TO <svc>_service`,
which gives every member ALTER privileges (needed for RLS bootstrap and
schema migrations) without exposing superuser credentials.

Currently (2026-04-14) the shared schema contains exactly four tables:

  - `shared.audit_logs` — cross-service audit trail (backend-common's
    AuditLogEntity, written by billing/config/notification/alert/ai/
    admin-api).
  - `shared.gdpr_data_requests` — compliance: GDPR data-export tracking.
  - `shared.user_consents` — compliance: consent records.
  - `shared.user_permissions` — platform-wide RBAC, READ by every
    service for permission checks on every request.

Adding a new table to `shared` requires PR review explaining the
cross-service contract and an update to the CI invariant
(`SHARED_SCHEMA_TABLES` set in schema-invariants.spec.ts).

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
  `shared.user_permissions` is doing so deliberately; the schema
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

- **config-service still uses public.** config-service's Configuration
  entity is currently in `public` because there is only one tenant
  table (per-tenant configuration overrides). Future work: create a
  `config` schema and move it. Tracked as a follow-up to P9.
- **Cross-tenant analytics queries become slightly harder to write.**
  Joining `shared.audit_logs` with `farm.batches_v2` requires
  schema-qualified joins instead of an unqualified-name lookup via
  search_path. Tradeoff: explicit > implicit.

## Enforcement

  - **Commit-time:** ESLint custom rule `require-entity-schema`
    (deferred from P11; future work). Rejects `@Entity('x')` without
    a `{ schema: 'X' }` argument unless the table name is in the
    explicit allow-list (`migrations` only).
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

# ADR-038: Database-Layer RLS on the Auth Role/Permission Tables

**Status:** Proposed
**Date:** 2026-06-27
**Deciders:** platform team (auth-security-expert + data-expert + architecture)
**Related:** ADR-011 (Schema Ownership Model), ADR-012 (Schema Drift), CLAUDE.md Tenant-ID sourcing + Tenant row placement (D14), ORPHAN-HIGH-101

## Context

The platform enforces per-tenant isolation in tenant-scoped service schemas
(`farm`, `sensor`, `hr`, …) with PostgreSQL Row-Level Security: each per-tenant
table carries a `tenantId`, a `tenant_isolation_policy` checks it against the
`app.current_tenant` GUC, and the runtime sets that GUC per request via
`runInTenantTransaction` / the RLS module. `applyTenantRlsToSchema`
(`libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`) is the
canonical helper that enables + forces RLS and installs the policy.

The **auth role/permission tables do NOT have this protection** (ORPHAN-101):

- `auth.tenant_roles` (`apps/admin-api-service/src/users/entities/tenant-role.entity.ts`)
  HAS a `tenantId` column, and an archived migration even ran
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY; … FORCE ROW LEVEL SECURITY;` — but
  **no `CREATE POLICY` was ever issued**, so RLS is enabled with no policy
  (which denies all by default only when a policy is required — here it is a
  latent half-configuration, not a control).
- `auth.tenant_role_permissions` and `auth.user_role_assignments`
  (admin-api entities, created in `1800200000000-CreateAdminEntitySurfaceTables.ts`)
  have **no `tenantId` column at all** — they derive tenancy via FK to
  `tenant_roles`.

Today's actual control is **application-layer parameter scoping**: token minting
(`apps/auth-service/.../token.service.ts`) isolates with explicit
`WHERE … tr."tenantId" = $X` predicates, and the `auth` PG role is the sole
client of the `auth` schema (schema-role isolation).

### The architectural blocker

The `auth` schema is **cross-tenant by design** (CLAUDE.md D14): login must
resolve a tenant *before* any tenant context exists, so auth runs on ONE
connection pool that does **not** set `app.current_tenant` per request. RLS as
the *primary* control would therefore require auth to start setting a per-request
tenant GUC on its pool — non-trivial, because the earliest auth queries (resolve
tenant by email/slug) are inherently pre-tenant and must NOT be tenant-filtered.
This is exactly the kind of decision an ADR exists to settle, rather than have a
single fix pre-decide.

## Decision (to be ratified)

Two defensible paths; the team must choose one. The recommendation is **Path A**.

### Path A — RLS as defense-in-depth behind the existing param scoping (RECOMMENDED)

1. Add a `tenantId` column to `tenant_role_permissions` and `user_role_assignments`
   (nullable → backfill from the FK chain → NOT NULL; blue-green-safe per ADR-012).
2. Apply `applyTenantRlsToSchema(qr, { includeTables: ['tenant_roles',
   'tenant_role_permissions', 'user_role_assignments'] })` in a new auth migration —
   this installs the canonical `tenant_isolation_policy`
   (`"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`
   OR a documented bypass GUC).
3. Set `app.current_tenant` on the auth pool connection **only on the
   already-tenant-resolved paths** (post-login token mint, tenant-role admin),
   leaving the pre-tenant login-discovery queries on a bypass. The existing
   `WHERE tenantId = $X` predicates stay — RLS is the second line that catches a
   future query that forgets the predicate.

RLS becomes belt-and-suspenders, not a replacement for the app-layer control.

### Path B — App-layer scoping is sufficient; lock it with an invariant

Accept that, for the platform-level cross-tenant `auth` schema, schema-role
isolation + explicit parameter scoping is the control, and **do not** add DB-RLS
(avoid the per-request-GUC complexity on a pre-tenant pool). Compensate by adding
a tier-3 invariant that every query touching `tenant_roles` /
`tenant_role_permissions` / `user_role_assignments` carries a `tenantId`
predicate (or goes through a scoped helper), so a future unscoped query fails CI.

## Rationale

- **Path A** raises the floor to "make-it-impossible" (the DB rejects a
  cross-tenant read even if app code regresses), at the cost of adding GUC
  management to the auth pool and two `tenantId` columns + a backfill. The
  GUC-per-request mechanism is the only genuinely new moving part; the pre-tenant
  bypass must be reviewed carefully so login is never tenant-filtered.
- **Path B** keeps auth's bootstrap simple and matches the "auth is cross-tenant
  by design" stance, but leaves the control at "make-it-detectable" — a CI grep,
  not a DB guarantee.
- The recommendation is Path A *iff* the pre-tenant bypass review confirms login
  discovery is safely separable; otherwise Path B with the invariant is the
  honest fallback rather than a half-configured RLS (today's worst-of-both).

## Consequences

- **Path A:** one nullable-column migration per table + a backfill + the
  `applyTenantRlsToSchema` call; auth request path gains a `set_config` on
  tenant-resolved transactions; integration test proving a forged cross-tenant
  role read is denied at the DB even with the WHERE clause removed. Risk:
  mis-scoping the bypass would break login — staging validation mandatory.
- **Path B:** no schema change; a new `tests/invariants/auth-role-query-tenant-scoped.spec.ts`;
  the latent "RLS enabled, no policy" on `tenant_roles` is cleaned up (either
  install the policy under Path A, or `DISABLE ROW LEVEL SECURITY` under Path B so
  the state is honest).

Either way, the **latent half-state on `auth.tenant_roles` (RLS enabled, no
policy) must be resolved** — it is neither a control nor honest.

## References

- ORPHAN-HIGH-101 (`docs/reviews/orphan-findings.md`)
- `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`
- `apps/auth-service/src/modules/authentication/services/token.service.ts`
- `apps/admin-api-service/src/migrations/1800200000000-CreateAdminEntitySurfaceTables.ts`

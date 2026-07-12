# ADR-042 — Retire `shared.user_permissions` (dead parallel permission catalog)

- **Status:** Accepted
- **Date:** 2026-07-12
- **Owner:** platform operator (Okan) + admin-api / auth owners
- **Tracking:** `docs/reviews/orphan-findings.md#ORPHAN-HIGH-378`
- **Relates to:** ADR-011 (schema ownership — shared canonical set), ADR-012 (schema drift), Faz 8-A3 of the 2026-07-11 database E2E audit remediation

## Context

The platform carried **two** permission catalogs:

1. **`auth.tenant_role_permissions.panel_permissions`** — the tenant RBAC
   built end-to-end in auth-service (permission catalogue + tenant roles /
   permissions / assignments + `TokenService` claims +
   `@RequireTenantPermission` guard), surfaced through the auth GraphQL
   subgraph and consumed by the tenant-admin frontend. This is the live,
   enforced RBAC SSoT.
2. **`shared.user_permissions`** — a per-user JSONB checkbox-permission table
   owned by admin-api (`UserPermissions` entity, `UserPermissionsService`),
   exposed through five admin-api REST endpoints. It predates the tenant RBAC
   and was never migrated onto it.

A read-only scout (Faz 8-A3, 2026-07-11) established that the second catalog
is dead:

- **Zero frontend callers.** Across every frontend surface — web shell, all
  federated modules including tenant-admin and admin-panel, the aquamobil PWA,
  and the mcp server — no code calls any of the five REST endpoints backed by
  the table.
- **One live row** existed on the production droplet (a stale artifact of the
  pre-RBAC era), against hundreds of live tenant-RBAC assignments.
- **No backend readers.** No guard, middleware, or service outside the
  admin-api users module ever selected from the table; the
  "every service reads it for permission checks" comment in
  `generate-init-schemas.ts` described an intention that never materialized.

Two writable permission authorities with one of them unread is split-brain by
construction: any write to the dead catalog silently diverges from the
enforced one.

## Decision

**Delete the REST surface, retire the table, and shrink the canonical shared
set from 5 to 4 tables.**

1. **REST surface removed** (admin-api `users.controller.ts`):
   - `POST /users/tenant/invite` (invite-with-checkbox-permissions)
   - `GET /users/permission-categories`
   - `GET /users/:id/permissions`
   - `PUT /users/:id/permissions`
   - `GET /users/tenant/users-with-permissions`

   Tenant-admin user invites flow through the auth-service / tenant-admin
   GraphQL path; the deleted `POST /users/tenant/invite` had no callers. The
   SUPER_ADMIN `POST /users/invite` endpoint (backed by
   `UserProvisioningService`) is a **different** path used by admin-panel and
   is untouched.

2. **Code removed:** `UserPermissions` entity (+ `PanelPermissions`,
   `DEFAULT_USER_PERMISSIONS`, `TENANT_ADMIN_PERMISSIONS`),
   `UserPermissionsService`, the `invite-user.dto.ts` DTOs
   (`InviteUserDto`, `UpdateUserPermissionsDto`, `UserWithPermissionsDto`),
   their module wiring, and the corresponding spec. The tenant-admin
   frontend's `PanelPermissions` type is its own auth-RBAC-shaped type
   (`web/modules/tenant-admin/src/types/permissions.ts`) and does not import
   the deleted entity.

3. **Table retired with archive-before-drop:** admin-api migration
   `1801500000000-DropRetiredUserPermissions` copies every row (RLS-bypassed,
   count-asserted) into `admin.retired_config_backups` (the existing generic
   jsonb retirement archive, MODULE_SCHEMAS-registered) and then drops
   `shared.user_permissions` (and a `public.user_permissions` remnant on
   pre-move databases). Forward-only; recovery = restore rows from the
   archive.

4. **Canonical shared set is now 4 tables** — `audit_logs`,
   `gdpr_data_requests`, `user_consents`, `access_logs` — updated in the same
   PR across the full W5 gate chain:
   - `libs/backend-common/src/constants/protected-tables.ts` (`PROTECTED_TABLES`)
   - `scripts/schema-registry/generate-init-schemas.ts` (`SHARED_SCHEMA_TABLES`)
   - `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql`
     (CREATE/move/RLS blocks removed) + `004-schema-grants.sql` comment
   - `apps/db-migrate/src/platform-bootstrap.service.ts` post-condition list
   - `e2e/tests/integration/schema-invariants.spec.ts` (B.3 strict allow-list)
   - `tests/invariants/critical-infra-ssot.spec.ts` (positive list + a
     negative lock that stage 006 never recreates the table)
   - db-migrate specs (`bootstrap-from-scratch`, `platform-bootstrap.integration`)

## Consequences

### Positive

- One permission authority. Every grant a tenant admin makes is the one the
  guards enforce; the silent-divergence class is structurally gone.
- Smaller cross-tenant surface: one fewer FORCE-RLS shared table to bootstrap,
  grant, drift-validate, and audit.
- The invariant chain (`shared-schema-canonical`, schema-invariants B.3,
  critical-infra-ssot) now rejects any reappearance of the table at PR time.

### Negative / accepted risk

- The five REST endpoints disappear without a deprecation window. Accepted
  because the scout proved zero callers; any unknown external caller receives
  404 and the archived rows preserve the full pre-retirement state.
- Historical checkbox grants are no longer queryable in place; they live as
  jsonb in `admin.retired_config_backups` under
  `sourceTable = 'shared.user_permissions'`.

### Follow-ups (tracked)

- None required for this retirement. Documentation snapshots under `docs/db/`
  and dated audit reports intentionally keep their historical references.

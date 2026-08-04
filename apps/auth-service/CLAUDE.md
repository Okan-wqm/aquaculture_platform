# auth-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY auth-domain facts.

JWT (RS256), RBAC, tenant provisioning, refresh-token rotation, MFA. Schema: `auth`.

## Schema (platform-level — NOT tenant-scoped)
- `auth` is a PLATFORM-LEVEL schema, NOT one of the 7 tenant-scoped services. So EVERY auth entity declares `schema: 'auth'` explicitly — the per-tenant "omit `schema:`" rule NEVER applies here (`apps/auth-service/src/modules/authentication/entities/user.entity.ts` → `@Entity('users', { schema: 'auth' })`; the auth outbox keeps `schema: 'auth'` too).
- **D14:** `auth.tenants` (`apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`) is the authoritative tenant-record SSoT — `auth` is cross-tenant by design (login resolves a tenant before any other context). The tenant row does NOT live in `shared`.

## Domain invariants
- JWT signing is RS256 ONLY — no HS256 / `DEV_JWT_SECRET` fallback (fail-fast at boot). Guarded by `tests/invariants/jwt-rs256-only.spec.ts`.
- Refresh tokens rotate; tenant provisioning + MFA step-up flows live here.

## Enforcement
Boot: `SchemaDriftValidator`. CI: `tests/invariants/jwt-rs256-only.spec.ts`, `tenant-provisioning-ssot.spec.ts`, `e2e/tests/integration/schema-invariants.spec.ts`.

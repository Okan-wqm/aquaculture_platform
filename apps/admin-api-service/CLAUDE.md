# admin-api-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the admin-domain facts that CONTRADICT a correct reading of those rules.

Platform management, analytics, audit, impersonation, tenant lifecycle, billing views. Schema: `admin` (platform-level).

## admin-api LEGITIMATELY declares entities in other services' schemas

The root rule says a service owns its schema. This service reads across them on purpose, so `apps/admin-api-service/src/analytics/entities/external/*.entity.ts` declare `schema: 'billing'` / `schema: 'auth'`.

The contract is not "admin owns these" but a write/read split, frozen by `tests/invariants/admin-api-schema-boundaries.spec.ts`:

- **WRITE-allowed:** `admin`, `auth`, `shared`.
- **Every other schema is READ-ONLY**, and each such entity MUST carry `synchronize: false`. Omitting it would let admin's TypeORM sync mutate another service's DDL.

Do not "clean up" a cross-schema entity by dropping the schema option or the `synchronize: false`.

## …but admin may NOT write `auth.tenants`, even though `auth` is write-allowed

auth-service is the SINGLE writer of the authoritative tenant record (D14). Admin delegates every tenant lifecycle mutation over NATS request/reply and only reads the row back. The pre-fix dual-write raced auth's SERIALIZABLE receipt transaction and silently dropped suspension props (DB-ADMIN-HIGH-003). Guarded by `tests/invariants/admin-no-auth-tenants-writes.spec.ts`.

## admin owns a schema that is not named `admin`

The `compliance` schema (`compliance.legal_holds`) is created by an admin migration, but its entity lives in a lib — `libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts` — because legal hold is enforced cross-service. It is deliberately NOT in `shared`; `shared` is reserved for the canonical cross-service table set.

## Table names collide across schemas ON PURPOSE

`admin.messages` and messaging's `messages`; `admin.retention_policies` and messaging's per-tenant `retention_policies`; `admin.audit_logs` and `shared.audit_logs`. Same bare name, different owner, different lifecycle. Always qualify the schema when reasoning about these.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/admin-api-schema-boundaries.spec.ts`, `admin-no-auth-tenants-writes.spec.ts`, `admin-route-contract-ci.spec.ts`, `admin-security-runtime-contract.spec.ts`, `protected-tables-guard.spec.ts`, `legal-hold-canonical-lib.spec.ts`, `platform-entity-registry-parity.spec.ts`.

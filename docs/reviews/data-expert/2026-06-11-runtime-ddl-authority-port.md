# data-expert — review — 2026-06-11-runtime-ddl-authority-port

## Scope

Round-2 C-2 port: reimplementation of the PR#363 "runtime DDL authority enforcement layer" (`origin/maintanance` @ `8706e7a68`, written against a May-30 base) onto current `main` (@ `4473d2fc7`). Surfaces inspected: `libs/backend-common/src/database/**` (authority resolver, RLS bootstraps, audit-column bootstrap/helper, schema-version gate, TypeORM config factory, source-schema write guard), all 13 schema-owning `app.module.ts` files, `apps/db-migrate/src/{schema-registry,cli-args,main}.ts`, and `tests/invariants/**`.

## Executive summary

Main has absorbed large parts of the PR#363 design since May-30 — `applyTenantRlsToSchema` and `convertAuditColumnsToTimestamptz` now hard-refuse callers without the db-migrate capability env, `SourceSchemaWriteGuardService` is a no-DDL stub, `TenantSchemaSyncService` is read-only, and `SCHEMA_REGISTRY.postMigrationHardening` exists for 10 schemas. **But the authority DECISION layer never landed**: the util path (`db-migrate-authority.util.ts`) only offered resolution (`isSchemaDdlOwnedByDbMigrate`, non-strict parse), with no choke-point assertion; four parallel resolvers existed (util + inline blocks in `typeorm-config.factory` and `schema-version-gate`); five app.modules still registered RLS DDL bootstraps unconditionally (`auth autoApply: true`; `farm`/`sensor`/`alert`/`hydroponics` `syncTenantSchemas: true`) so every production cold start logged a swallowed `rls.bootstrap.failed`; and — materially — the `auth` schema had **no live RLS install owner at all** (runtime auto-apply refused by the helper, no registry hardening entry, no auth migration installing policies). One finding raised; resolved by the port commit this review accompanies.

## Findings (by severity)

### HIGH

#### DATA-HIGH-004 — Runtime DDL is not structurally blocked at the decision layer; util path offers resolution only, auth schema RLS install has no owner

**Severity:** HIGH
**Layer:** 2
**State:** OPEN → resolved by the accompanying port commit

**Evidence**
- `libs/backend-common/src/database/db-migrate-authority.util.ts:1` — pre-port: resolver only (`isSchemaDdlOwnedByDbMigrate` with silent fallback on malformed `DB_MIGRATE_AUTHORITATIVE`, no `assertRuntimeDdlAllowed`, no ConfigService bridge)
- `tests/invariants/authoritative-runtime-ddl-contract.spec.ts:1` — pre-port: did not exist; no executable gate stopped a new `autoApply: true` registration or a fifth parallel resolver
- `apps/billing-service/src/app.module.ts:196` — the conditional-registration pattern (`autoApply: !billingSchemaDdlOwnedByDbMigrate`) existed in 5 services but was NOT propagated to auth/farm/sensor/alert/hydroponics, and nothing enforced it
- `apps/auth-service/src/app.module.ts` — pre-port `autoApply: true` + `apps/db-migrate/src/schema-registry.ts` auth entry without `postMigrationHardening` ⇒ auth tenant-scoped tables (invitations, refresh_tokens, announcements, …) had no functioning RLS installer in production

**Rule violated**
- ADR-033 single-schema-writer: the authority question ("may this process issue DDL?") must have one resolver and a fail-fast assertion at every runtime DDL choke-point; helper-level refusal alone produces swallowed log lines instead of boot failures.
- CLAUDE.md hierarchy Tier 1/3: the wrong behaviour (second resolver, unconditional DDL bootstrap registration) was neither impossible nor detectable.

**Why it bites**
1. Malformed `DB_MIGRATE_AUTHORITATIVE` (e.g. `yes`) silently flipped the schema-ownership model to the environment default instead of failing the boot. 2. Authoritative production boots registered RLS bootstraps that always fail (helper refusal) — alert-noise training operators to ignore `rls.bootstrap.failed`, which is the exact signal that matters when isolation is genuinely missing. 3. The auth schema regression class: runtime install refused + no db-migrate hardening = newly provisioned environments run auth tenant-scoped tables WITHOUT `tenant_isolation_policy`, silently.

**Fix shape (what the port commit does)**
- SSOT merge: strict-parse `resolveDbMigrateAuthoritative` + `resolveDbMigrateAuthoritativeFromConfig` + `assertRuntimeDdlAllowed` consolidated into `db-migrate-authority.util.ts`; `isSchemaDdlOwnedByDbMigrate` becomes an alias (same function object), and the inline resolvers in `typeorm-config.factory.ts` / `schema-version-gate.service.ts` are replaced by the shared resolver.
- Choke-point assertions in `RlsSchemaBootstrap`, `TenantRlsSyncService`, `AuditColumnsBootstrap` (fail fast BEFORE a QueryRunner is opened), and the audit-column helper delegating its guard to the same assertion.
- Conditional registration propagated to auth/farm/sensor/alert/hydroponics; observability joins `createSchemaVersionGate` + env-aware migration timing.
- `SCHEMA_REGISTRY['auth'].postMigrationHardening` added (tenantRls with the app.module's excludeTables) so the gated runtime path has an authoritative replacement.
- Contract invariant `tests/invariants/authoritative-runtime-ddl-contract.spec.ts` (registered in the `registry` shard) pins all of the above per-PR.

**Tenant-provisioning exception (deliberately preserved)**
Tenant schema cloning and `tenant_provisioner` role DDL remain legitimate runtime DDL in their owning context: the db-migrate `tenant-schema-provisioner` carries `DB_MIGRATE_DDL_AUTHORITY=1`, which `assertRuntimeDdlAllowed` honours as a bypass; `TenantSchemaSyncService` (read-only on main) is untouched.

## Observations recorded as orphan findings

- ORPHAN-HIGH-087 (docs/reviews/orphan-findings.md) — `guard_source_write` trigger hardening is installed by NOTHING on main (runtime stub emits a notice deferring to db-migrate; db-migrate has no `sourceWriteGuards` hardening step). The PR#363 `source-schema-write-guards.helper.ts` port was deliberately NOT taken here because wiring it into `postMigrationHardening` requires a verified-current `MODULE_SCHEMAS` table classification first (misclassified reference/infrastructure tables would brick runtime writes on deploy).
- Pre-existing red unit test `tenant-rls-sync.service.spec.ts` ("iterates discovered tenant schemas") — broken on `origin/main` since the helper-level `DB_MIGRATE_DDL_AUTHORITY` guard landed without updating the spec; root-fixed in the port commit by scripting the only env in which the sweep's DDL path is legal.

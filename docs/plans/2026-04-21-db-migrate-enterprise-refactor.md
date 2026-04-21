# aqua-db-migrate Enterprise Refactor — Phased Plan (v3, execution-hardened)

**Start**: 2026-04-21
**Owners**: data-expert (schema/drift), platform-kernel-expert (runtime/orchestrator), infra-expert (CI/deploy gates)
**Honest timeline**: **34 weeks @ 0.5 FTE** or **17–18 weeks @ 1.0 FTE** (v1 claimed 10, v2 revised to 30 — v3 adds Phase 4.5 + security/compliance scope)
**Supersedes**: ad-hoc healing migration pattern accumulated in commits 5df00179 → e83904d2 (5 HR-drift fixes over 48h)
**Version**: v3 (2026-04-21)
- v1: initial synthesis of data-expert + platform-kernel-expert + infra-expert plans
- v2: consolidated blind-spot audits from architectural-arbiter + multi-tenant-saas-expert + architect-review (20 revisions)
- v3: consolidated security-auditor + compliance-expert + code-reviewer audits (38 revisions)
- User invariant: *"enterprise grade bir yapı olmalı çalışan"* — enterprise-grade AND executes end-to-end without hidden footguns

## v3 Revisions Applied (vs v2)

### CRITICAL — block Phase 1 kick-off

| ID | Category | v2 bug | v3 fix |
|---|---|---|---|
| R1 | Security | `SET LOCAL search_path "<tenant>"` is identifier string-interpolation (SQLi class) | `set_config('search_path', $1, true)` parameterized; schema names re-validated at orchestrator boundary against SAFE_IDENT_RE |
| R2 | Security | `backfillColumn(expr: string)` + `alignEnumLabels({remapTo})` raw strings = injection vectors | New `libs/backend-common/src/database/sql-fragments.ts` with branded `SqlIdent`/`SqlFragment` types; every primitive signature takes `SqlFragment`, raw strings become compile errors (Tier-1 make-impossible) |
| R3 | Compliance | `tenant_id_hash = sha256(tenant_schema)` invertible via rainbow table of known tenants | HMAC-SHA256 with per-env pepper (`TENANT_HASH_PEPPER` from Vault); GDPR cascade handler on `TenantErased` event; ADR-022 |
| R4 | Compliance | `s3://aqua-deploy-artifacts/` on DigitalOcean NYC3 = KVKK cross-border violation for TR tenants | Move bucket to **FRA1** (EU adequacy) or IBM Cloud Istanbul; VERBİS declaration; blocks Phase 7 until moved |
| R5 | Compliance | No author≠reviewer enforcement; SOC2 CC6.1 change-mgmt fails | **New Phase 4.5** — `tools/gates/author-not-reviewer.ts` + commit-msg accepts `Ticket: <url>` + CODEOWNERS on migrations; must land before Phase 8 Stage 2 |
| R6 | Code | `@ExpandContract` metadata-only; no runtime `dependsOn` between expand/migrate/contract migrations | Decorator injects pre-`up()` gate reading `observability.migration_backfill_progress`; `backfillColumn` per-chunk separate TX (TypeORM `transaction: false`); `TenantSchemaSyncService` replays decorators at provisioning |
| R7 | Code | `MigrationExecutor.executeMigration(Migration)` doesn't expose class → decorator metadata unreadable | Orchestrator reads `dataSource.migrations` class list BEFORE `executePendingMigrations()`, builds `{name→class}` map for fan-out/gating |
| R8 | Code | `/tmp/migration-plan.json` not shared between `aqua-db-migrate` container and GHA runner | Stdout sentinel `##MIGRATION_PLAN_BEGIN##…END##`; Ajv-validated producer + consumer |
| R9 | Code | Jest `globalSetup` + per-test testcontainer = 15-30s/test blows SLO | `beforeAll` spawns ONE PG per suite file; each test gets `CREATE SCHEMA test_<uuid>` + `DROP SCHEMA`; documented in plan |
| R10 | Code | `tools/gates/__tests__/` doesn't exist as jest runner | Extract gate code to new `libs/schema-gates/` Nx lib with proper jest config |

### HIGH — land alongside Phase 1 / early phases

| ID | Category | v2 bug | v3 fix |
|---|---|---|---|
| R11 | Code | Introspector claims 6 shapes, real PG needs ≥10 | Extend to: partial-index WHERE (via `pg_get_expr(indpred)`), EXCLUDE operator class, FK actions, generated columns (`attgenerated='s'`), identity columns, enum label ORDER, TimescaleDB `pg_inherits`, RLS `pg_policy` |
| R12 | Code | `withDdlSafety` sketch: SET LOCAL no-op outside tx; advisory unlock missing `finally`; CREATE INDEX CONCURRENTLY tx incompatibility | Conditional SET LOCAL; mandatory try/finally advisory_lock pair; `nonTransactionalDdl: boolean` flag; reuse `hashtext('aqua-db-migrate:<schema>')` scheme |
| R13 | Security | Snapshot tamper window; blanket `SPACES_KEY` all-bucket access | Sigstore cosign OIDC-keyless sign at upload; verify at download; split `SPACES_SNAPSHOT_WRITE_KEY`/`READ_KEY`; CODEOWNERS on prod-schema-snapshot.yml |
| R14 | Security+Compliance | "Schema-only = no PII" false — column names (`national_id`), CHECK literals, view SELECTs leak | `scripts/deploy/snapshot-scrubber.ts` strips COMMENT/CHECK literals + PII column-name allowlist check; compliance-expert = blocker on Phase 7 |
| R15 | Compliance | `alignColumnType` would "fix" `bytea` → `text` silently corrupting `pgp_sym_encrypt` ciphertext | `@EncryptedAtRest({keyId, algorithm})` decorator; Class J in Phase 2 validator; primitives refuse to alter encrypted columns; ADR-023 |
| R16 | Security | Phase 8 3am rollback `ssh droplet; vi .env` = plaintext, no MFA, no audit | `aqua-ctl drift-bypass --service --reason --ttl` CLI; `observability.emergency_overrides` table (7y retention); Vault-backed flags; auto-revert on TTL; daily env-drift-check |
| R17 | Compliance | Retention matrix incoherent (90d vs 30d vs 7y random) | `docs/compliance/retention-matrix.md` + ADR-024: migration_events=13mo, schema_object_history=7y, _archive=7y (Glacier), snapshots=30d@FRA1, findings=7y+hashchain+PII-scrub |
| R18 | Compliance | `findings.jsonl` not tamper-evident | Hash-chain verification (`prev_hash: sha256(previous)`) — already in `tools/gates/finding-registry.ts`; add CI invariant `registry-hash-chain-intact.spec.ts` |
| R19 | Compliance | No GDPR Art 15 DSAR export for migration history | `apps/observability-service/src/gdpr/{observability-erasure,portability}.handler.ts`; register observability in tenant-erasure cascade (10→11 services) |
| R20 | Code | Harness `Type<MigrationInterface>` + `MigrationExecutor.executeMigration(Migration wrapper)` mismatch | Document: harness `new opts.migration()` → wrap in `Migration` → pass to executor; or signature changes to `migration: MigrationInterface` (pre-instantiated) |
| R21 | Code | `p-limit=8` concurrency theater on catalog-contended DDL (`ALTER TYPE ADD VALUE` locks `pg_type`) | `@TenantFanOut({lockClass: 'catalog'|'tenant-local', concurrency})`; catalog-contended forced concurrency=1; scale test covers both classes |
| R22 | Code | "New Nx lib" without generator command | Explicit: `npx nx g @nx/js:lib migration-harness --directory=libs/migration-harness --unitTestRunner=jest --buildable --importPath=@platform/migration-harness` + `tsconfig.base.json` paths entry |
| R23 | Code | Phase 0 "introduce entity + migration + module" — actually 10 files | Enumerate: 2 entities, module, consumer, repository, data-source.ts, first migration, app.module wiring, schema-registry update, migration-runner provider (ADR-011 compliant) |
| R24 | Code+MT | Validator iterates tenants (Class I) may false-positive on legitimate tenant delta (Enterprise custom cols) | `@AllowTenantDelta({columnPrefix})` whitelist decorator; Class I respects |
| R25 | Security | `MigrationTenantFailed.error` leaks row data (`Key (ssn)=(123-45-6789)`) | `libs/backend-common/src/utils/sanitize-pg-error.ts`; extract SQLSTATE + template, redact `Key (..)=(..)`, `maskPii()`; JSON Schema validator REJECTS events matching leak regex |
| R26 | Security | NATS subject `platform.boot.hr-service.schema-drift-clean` leaks topology | Narrow ACL in `infrastructure/nats/services.yaml` — `platform.migration.>` + `platform.boot.>` subscribable by observability + db-migrate + sre-tools CN only; CI invariant ≤3 subscribers |
| R27 | Security | No CI enforcement of "every uses: pinned to 40-char SHA" (memory rule) | `tools/gates/gha-sha-pin.ts` — scans workflows, fails on tag-pinned `uses:` |
| R28 | Security | Bypass alert via NATS only (NATS down = silent bypass) | Dual channel: Postgres-direct write to `emergency_overrides` + 5min cron HTTP POST to PagerDuty + heartbeat-if-bypass-active (silence = alert) |
| R29 | Code | `apps/db-migrate/src/main.ts:1` lacks `import 'reflect-metadata'` — decorator no-op at runtime | Add import as line 1 as Phase 6 prerequisite |
| R30 | Security | testcontainers ~60 transitive deps; Docker socket = root | Phase 1 CI gate `npm audit --production=false --audit-level=high`; pin testcontainers exact SHA (not caret); image allowlist |

### MEDIUM — tracked findings, fix in phase windows

| ID | Fix |
|---|---|
| R31 | Pre-Phase-5 backfill `schema_object_history` from deleted migrations before `_archive/` |
| R32 | Phase 0 `error_detail JSONB` structured `{class, code, message, stack_hash, pg_error_code?}` |
| R33 | Dual detection path: Postgres-direct overrides table + 5min cron re-fires PagerDuty via HTTP webhook |
| R34 | `priorState: string \| ((ctx: {qr, schema}) => Promise<void>)` — tenant-aware seed context |
| R35 | Phase 4 AST walker tool `tools/gates/expand-contract-ast-walker.ts` (~300 LOC) |
| R36 | Spaces access-logs bucket enabled; 1y retention; shipped to observability |
| R37 | `docs/runbooks/kvkk-breach-notification.md` + `data_residency_region` tag on events |
| R38 | Phase 5 exit: compliance-expert blocker + `docs/compliance/evidence/<date>-<finding-id>.md` attestation |

## Context

The 5-commit HR-drift loop (`5df00179` → `e83904d2`) over 48 hours revealed the db-migrate system catches drift at boot, not PR. Each fix surfaced the next drift class — enum → partial index → EXCLUDE constraint → CHECK constraint → nullability + uuid-type. Architecturally correct at each layer, but the *pattern* is a smell: entity-model and DB diverge silently until a droplet deploy times out on boot signals.

Per user invariant: *"planda yazılan kodlar her zaman validasyon edilmeli — doğru çalışıyor mu yazılmış mı diye"* — every code proposal carries a test file path + audit agent + CI invariant + E2E smoke. v3 hardens these against tautological validation AND adds branded-type compile-time safety for SQL identifiers/fragments.

## Success KPIs

| Metric | Baseline (2026-04-21) | Target (post-Phase 9) |
|---|---|---|
| Drift-at-boot events per deploy | N (measure in Phase 0) | 0 |
| Heal migrations added per month | 3 (past day) | 0 |
| Boot-signal-timeout deploys per month | 5 (past 48h) | 0 |
| PR-to-prod time for trivial entity change | ~hours (with retries) | <60 min |
| Prod containers booting with silent drift | Unknown (FATAL=false) | 0 (FATAL=true in prod) |
| Per-tenant shape divergence (v2 Class I) | Undetected | Always caught at Phase 2 validator |
| Data-preserving migration success rate (v2 Phase 3.5) | N/A (guards reject non-empty) | >95% |
| **SOC2 change-mgmt evidence completeness (v3 R5+R18)** | N/A (no external ticket, no hashchain verification) | 100% — every schema change has author≠reviewer + ticket URL + 7y attestation |
| **GDPR Art 17 cascade effectiveness (v3 R3)** | Partial (sha256 reversible) | 100% — HMAC with pepper, explicit cascade on erasure event |

## Principles

1. **Fail-closed in prod, opt-in elsewhere** — FATAL=true production-only; dev/stg observe-log
2. **PR-gate before deploy-gate** — drift catchable at PR time via harness + **pg_catalog** introspection (NOT TypeORM generator)
3. **Single source of truth** — entity metadata → migration → DB; unavoidable drift (e.g. manifest ↔ emit-site) enforced via CI invariant
4. **Every phase reversible OR explicit point-of-no-return** — no hidden forward-only
5. **Validation is behavioral** — positive + negative fixtures, never "function exists" (AST grep tautology)
6. **Tenant-safe by default** — every primitive respects TENANT_AWARE_SCHEMAS; every validator iterates tenants; every event hashes tenant identifier via HMAC (R3)
7. **Prod-data-first** — primitives declare non-empty-table contract (`onRowsPresent: fail | backfill | defer`); empty-only is opt-in
8. **SQL injection impossible at compile-time (v3 R2)** — branded `SqlIdent`/`SqlFragment` types; raw strings refused by TypeScript
9. **Audit trail is tamper-evident (v3 R18)** — findings.jsonl hash-chained; CI invariant enforces integrity
10. **PII minimisation (v3 R3/R14/R25)** — HMAC tenant hash + PG error sanitizer + snapshot scrubber at every persistence + transmission boundary

## Dependency Graph (v3)

```
Phase 1 (harness; testcontainers + defineMigrationTest)
    ↓
Phase 2 (validator 10-class + pg_catalog introspector + Class J encrypted-column)
    ↓
Phase 0 (observability — HMAC tenant_id_hash + schema_object_history + retention matrix)
    ↓
Phase 3 (primitives with branded SqlFragment types + DDL safety envelope)
    ↓
Phase 3.5 (data-preserving + expand/contract with runtime dependsOn gate)
    ↓
Phase 4 (PR gates — pg_catalog introspection diff)
    ↓
Phase 4.5 (NEW v3 — separation of duties + external tickets + CODEOWNERS)
    ↓
Phase 5 (HR consolidation — pre-gate compliance attestation + schema_object_history backfill)
    ↓
Phase 6 (codegen + tenant fan-out lockClass + scale + parameterized set_config + required-signals parity)
    ↓
Phase 6.5 (app↔schema version compatibility)
    ↓
Phase 7 (dry-run + shadow deploy + cosign + snapshot-scrubber + FRA1 bucket + replica-lag)
    ↓
Phase 8 (FATAL rollout + aqua-ctl CLI + emergency_overrides table + dual detection path)
    ↓
Phase 9 (legacy deprecation + structured boot signals + NATS ACL narrow + DSAR handlers + exit artifacts)
```

## Handoff Contracts (v3 — hardened)

Every cross-owner interface ships BEFORE consuming phase starts:

| Contract | Producer | Consumer | File path | Phase |
|---|---|---|---|---|
| `SqlIdent` + `SqlFragment` branded types | Phase 3 authors | Every primitive caller | `libs/backend-common/src/database/sql-fragments.ts` | 3 (blocks 3.5, 6) |
| `DriftReport` | Phase 2 validator | Phase 1 harness, Phase 8 module | `libs/backend-common/src/database/schema-drift/drift-report.types.ts` + schema | 2 |
| `MigrationPlan` (dry-run stdout sentinel) | Phase 7 orchestrator | Phase 7 shadow-deploy | `libs/event-contracts/src/migration-plan.schema.ts` | 7 |
| `BootSignalEmitted` | Phase 9 validator | Phase 9 asserter | `libs/event-contracts/src/bootstrap-events.ts` | 9 |
| `MigrationEvent*` (Started/Applied/TenantFailed/BatchCompleted) | Phase 0 orchestrator | Phase 0 observability consumer | `libs/event-contracts/src/migration-events.ts` + Ajv schemas | 0 |
| `@MigrationMeta` decorator | Phase 9 authors | Phase 9 naming gate | `libs/backend-common/src/database/migration-meta.types.ts` | 9 |
| `@TenantFanOut` decorator (incl. `lockClass`) | Phase 6 authors | Phase 6 orchestrator | `libs/backend-common/src/database/migration-runner/tenant-fan-out.decorator.ts` | 6 |
| `@ExpandContract` decorator (incl. runtime `dependsOn` gate) | Phase 3.5 authors | Phase 4 gate | `libs/backend-common/src/database/expand-contract.decorator.ts` | 3.5 |
| `@CompatibleWithAppVersion` decorator | Phase 6.5 authors | Phase 7 deploy pipeline | `libs/backend-common/src/database/migration-compat.decorator.ts` | 6.5 |
| `@EncryptedAtRest` decorator (v3 R15) | Phase 2/3 authors | Phase 2 validator Class J | `libs/backend-common/src/database/encrypted-at-rest.decorator.ts` | 2 |
| `@AllowTenantDelta` decorator (v3 R24) | Phase 2 authors | Class I validator | `libs/backend-common/src/database/allow-tenant-delta.decorator.ts` | 2 |
| Nx tag schema | Phase 6 authors | schema-registry codegen | `tools/codegen/schema-registry.schema.json` | 6 |
| `required-signals.yaml` schema + `@EmitBootSignal` decorator | Phase 6 authors | Parity invariant | `infrastructure/deploy/required-signals.schema.json` + `libs/backend-common/src/bootstrap/emit-boot-signal.decorator.ts` | 6 |
| Sanitize-PG-error utility (v3 R25) | Phase 0 orchestrator | Every event emission | `libs/backend-common/src/utils/sanitize-pg-error.ts` | 0 |
| HMAC tenant-hash utility (v3 R3) | Phase 0 orchestrator | Every tenant-linked event | `libs/backend-common/src/utils/hmac-tenant-hash.ts` | 0 |

Per ADR-006: every event uses `createBaseEvent()`; every cross-trust-boundary event has JSON Schema validator in `libs/event-contracts/src/schemas/`.

---

## Phase 1 — Per-Migration Test Harness (~2 weeks)

**Goal**: testable migrations in isolation. Prerequisite for everything.

**Changes (v3-hardened)**:
- **Generator command** (v3 R22): `npx nx g @nx/js:lib migration-harness --directory=libs/migration-harness --unitTestRunner=jest --buildable=true --publishable=false --importPath=@platform/migration-harness`
- Update `tsconfig.base.json` `compilerOptions.paths`: `"@platform/migration-harness": ["libs/migration-harness/src/index.ts"]`
- API (v3 R20 + R34):
  ```ts
  export function defineMigrationTest(opts: {
    migration: Type<MigrationInterface>;
    schema: string;
    entities: Type<object>[];
    priorState: string | ((ctx: { qr: QueryRunner; schema: string }) => Promise<void>);
    tenantCount?: number; // default 1, max 3 in harness
  }): void;
  ```
- **Jest model (v3 R9)**: `beforeAll` in each spec file boots ONE shared PG testcontainer; per-test isolation via `CREATE SCHEMA test_<uuid16>` + `DROP SCHEMA CASCADE`. `globalSetup` for image pre-pull only, NOT per-test.
- **Migration execution (v3 R20)**: harness instantiates class (`new opts.migration()`), wraps in TypeORM's internal `Migration` shape, invokes `MigrationExecutor` against ephemeral DataSource with isolated `name` to avoid duplicate-registration conflicts
- **Supply chain gate (v3 R30)**: CI runs `npm audit --production=false --audit-level=high` against `libs/migration-harness/package.json`; testcontainers pinned exact SHA (not caret); image allowlist `TESTCONTAINERS_ALLOWED_IMAGES=timescale/timescaledb-ha:pg16@sha256:…`
- HR-drift regression test (proof-of-concept): `libs/migration-harness/src/__tests__/hr-drift-regression.spec.ts` — applies drifted seed (partial index + EXCLUDE constraint + CHECK + nullability), runs Phase 3 `bringToEntityShape`, asserts `DriftReport.total === 0`

**Validation (behavioral, not structural)**:
- Unit: `harness-contract.spec.ts` asserts (a) priorState rolls back between tests, (b) search_path pinned before up(), (c) zero-drift on clean pair, (d) teardown destroys DataSource + schema
- **Behavioral regression**: `hr-drift-regression.spec.ts` — exact 5-commit-loop seed → bringToEntityShape → zero violations
- Audit: **data-expert** primary; **database-reviewer** pg_catalog; **test-runner** discipline; **auth-security-expert** (R30 supply chain)
- CI invariant: glob `apps/*/src/database/migrations/__tests__/*.migration.spec.ts` picked up by `nx affected --target=test`; npm audit gate enforced
- Performance: single migration test <30s end-to-end; budget enforced via Jest timeout; Phase 0 dashboard tracks duration; per-file container reuse prevents cold-start blowup
- E2E: GHA smoke `migration-harness-smoke` runs canonical regression on every PR

**Rollback**: harness lib deletable without prod impact.

**Exit criteria**: harness shipped; HR-drift regression green; ≥5 existing migrations have sibling `.spec.ts`; CI duration increase <10%; supply chain audit clean.

---

## Phase 2 — Validator 10-Class + pg_catalog Introspector + Encrypted Columns (~3 weeks, was 2)

**Goal**: validator catches all 10 drift classes; pg_catalog introspector shared with Phase 4 gate.

**Changes (v3-hardened)**:
- `libs/backend-common/src/database/schema-drift/drift-classes.ts` — registry of 10 classes (adds Class I per-tenant divergence + Class J encrypted-column protection)
- `libs/backend-common/src/database/schema-drift-validator.service.ts` — extends `validateEntity`; iterates `TENANT_AWARE_SCHEMAS[schema]` for Class I
- `libs/backend-common/src/database/schema-drift/pg-catalog-introspector.ts` — returns normalized JSON `{tables, columns, indexes, constraints, enums, checks, partial_indexes, fk_actions, generated_cols, identity_cols, rls_policies, timescale_inheritance}` — **10 shapes (v3 R11)**
- **New decorators (v3 R15, R24)**:
  - `libs/backend-common/src/database/encrypted-at-rest.decorator.ts` — `@EncryptedAtRest({keyId, algorithm})` marks columns as encrypted; validator Class J refuses to propose alterations
  - `libs/backend-common/src/database/allow-tenant-delta.decorator.ts` — `@AllowTenantDelta({columnPrefix})` whitelist for legitimate Enterprise-tenant custom columns

Classes:

| ID | Class | Primitive |
|---|---|---|
| A | schema_location | `pinSearchPath` |
| B | uuid_type | `dropDependentPartialIndexes` + `alignColumnType` |
| C | nullability | `alignColumnNullability` (fail + backfill variants) |
| D | missing_column | `addMissingColumns` |
| E | orphan_column | `dropOrphanedColumns` (allowlist-gated) |
| F | enum_labels | `alignEnumLabels` (with sort order per R11) |
| G | check_constraint | `alignCheckConstraints` |
| H | **data_cast_incompatible** | Phase 3.5 refuse + emit `MigrationDataPreservationRequired` |
| I | **per_tenant_shape_divergence** | Phase 6 per-tenant heals; respects `@AllowTenantDelta` |
| J | **encrypted_column_protection (v3)** | Validator refuses; remediation is operator key-rotation script, never a migration |

**Validation**:
- Unit: `schema-drift-validator.spec.ts` — 10 `describe` blocks; each uses Phase 1 harness with **positive + negative** fixtures (non-tautological per v3 R24)
- Unit: `pg-catalog-introspector.spec.ts` — fixture per shape (R11): partial-index WHERE predicate, EXCLUDE constraint, FK actions, generated col, identity col, enum label ORDER, TimescaleDB hypertable, RLS policy
- Integration: multi-tenant fixture (3 tenants, one drifted from source) → Class I detected with tenant name; Enterprise tenant with `ent_custom_*` cols respects `@AllowTenantDelta`
- Audit: **data-expert** primary; **database-reviewer** pg_catalog queries; **multi-tenant-saas-expert** Class I; **auth-security-expert** (R15 encrypted column); **compliance-expert** (no PII in violation messages)
- CI invariant: `e2e/tests/integration/drift-class-parity.spec.ts` — each class has ≥1 positive + ≥1 negative fixture; no AST grep tautology
- E2E: `drift-e2e-hr.spec.ts` boots hr-service against deliberately-drifted seed across 10 classes

**Rollback**: each class behind `DRIFT_CLASS_<name>_ENABLED` env flag.

**Exit criteria**: 10 classes exercised by positive+negative fixtures; introspector single-source for validator+gate; zero false-positives in dogfooding.

---

## Phase 0 — Observability Instrumentation + Compliance Hardening (~3 weeks)

**Goal**: measure current state with Phase 2 detector; establish GDPR/SOC2-compliant event + audit infrastructure.

**Changes (v3 R3/R17/R23/R25/R32)** — **10 files minimum**:
1. `apps/observability-service/src/migration-events/entities/migration-event.entity.ts` — `{batch_id, schema, migration_name, tenant_id_hash, status, duration_ms, error_detail JSONB, emitted_at}`; **partitioned monthly by emitted_at**; `tenant_id_hash = HMAC_SHA256(pepper, tenant_schema)` per R3
2. `apps/observability-service/src/migration-events/entities/schema-object-history.entity.ts` — `{schema, table, column, change_type, old_value, new_value, migration_id, pr_url, finding_id, applied_at}` — 7-year retention (SOC2 per R17)
3. `apps/observability-service/src/migration-events/migration-events.module.ts`
4. `apps/observability-service/src/migration-events/migration-events.consumer.ts` — NATS subscriber on `platform.migration.>`; sanitizes PG errors via R25 util; handles `TenantErased` cascade per R3 (DELETE rows matching HMAC)
5. `apps/observability-service/src/migration-events/migration-events.repository.ts`
6. `apps/observability-service/src/database/data-source.ts` — was missing; adds TypeORM CLI entry
7. `apps/observability-service/src/database/migrations/2026-05-01__observability__create-migration-events-table.ts` — TimescaleDB retention policy (13mo per R17)
8. Update `apps/observability-service/src/app.module.ts` — imports `MigrationEventsModule`, `TypeOrmModule.forFeature([MigrationEvent, SchemaObjectHistory])`, `SchemaDriftModule.forRoot({serviceName: 'observability'})`
9. Update `apps/db-migrate/src/schema-registry.ts` — observability becomes registered schema (will be codegen'd in Phase 6)
10. `createMigrationRunnerService('observability')` provider per ADR-011

**Plus**:
- `libs/backend-common/src/utils/hmac-tenant-hash.ts` (R3) — `hmacTenantHash(pepper, schema)`; pepper from `TENANT_HASH_PEPPER` env (Vault-sourced in prod)
- `libs/backend-common/src/utils/sanitize-pg-error.ts` (R25) — extract SQLSTATE + template; redact `Key (...)=(...)`; `maskPii()`
- `apps/db-migrate/src/migration-orchestrator.ts` — emit structured events via `@platform/event-bus` factory (never direct NATS)
- `docs/adr/019-db-migrate-enterprise-refactor.md` — pins target architecture
- `docs/adr/022-pseudonymisation-key-management.md` — HMAC pepper rotation
- `docs/adr/024-compliance-retention-matrix.md` (R17)
- `docs/compliance/retention-matrix.md`
- `observability/grafana/dashboards/db-migrate.json` — migration duration histogram (per-schema, tenant-percentile); drift-at-boot counter; deploy-rollback-by-cause; **active-drift heatmap** (live `schema_drift_violations{service, class}`)

**Validation**:
- Unit: `orchestrator-event-emission.spec.ts` asserts every path emits via `createBaseEvent()`; `sanitize-pg-error.spec.ts` rejects leak patterns; `hmac-tenant-hash.spec.ts` confirms pepper-based collision resistance
- Unit: `migration-events.consumer.spec.ts` asserts HMAC tenant hash NEVER stores raw `tenant_schema`; `TenantErased` cascade DELETEs matching rows
- Integration: end-to-end NATS → observability round-trip <30s
- Audit: **observability-expert** primary (cardinality + retention); **data-expert** schema design; **compliance-expert** (GDPR cascade + HMAC + retention matrix); **auth-security-expert** (no secrets in error_detail; pepper handling)
- CI invariant: `observability-schema.spec.ts` byte-identical with ADR; JSON Schema validators for migration events **REJECT payloads matching `Key \(.+\)=\(.+\)`** per R25
- E2E: deploy migration to staging, confirm row lands with **HMAC hash** (never raw UUID), `error_detail` structured, retention policy active

**Rollback**: `MIGRATION_EVENT_EMIT=false` env flag; table append-only.

**Exit criteria**: ADR-019/022/024 merged; dashboard 7d data; `schema_object_history` backfilled from git log; baseline KPIs in `docs/kpis/2026-04-21-baseline.md`; compliance-expert signs off on HMAC/retention.

---

## Phase 3 — Authoring Primitives + Branded Types + DDL Safety Envelope (~3 weeks)

**Goal**: declarative migration authoring; SQL injection impossible at compile time.

**Changes (v3 R2/R12)**:
- **`libs/backend-common/src/database/sql-fragments.ts` (R2)**:
  ```ts
  // Branded types — raw strings won't satisfy the interface
  export type SqlIdent = { readonly __brand: 'SqlIdent'; value: string };
  export type SqlFragment = { readonly __brand: 'SqlFragment'; sql: string; params: unknown[] };
  export const sql = {
    ident: (name: string): SqlIdent => { /* SAFE_IDENT_RE validate, return branded */ },
    value: (v: unknown): SqlValue => ({ __brand: 'SqlValue', value: v }),
    fragment: (strings: TemplateStringsArray, ...args: (SqlIdent | SqlValue)[]): SqlFragment => {
      // Interpolate idents safely (quoted); values as params
    },
  };
  ```
  Every primitive signature takes `SqlFragment` / `SqlIdent`. Raw `string` for `backfillExpr` / `remapTo` becomes **TypeScript compile error**.

- **`libs/backend-common/src/database/base-migration.ts` — DDL Safety Envelope (v3 R12)**:
  ```ts
  export async function withDdlSafety<T>(
    qr: QueryRunner,
    opts: { lockTimeoutMs?: number; statementTimeoutMs?: number; advisoryLockKey?: number; nonTransactionalDdl?: boolean },
    fn: (qr: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const applyTimeouts = qr.isTransactionActive
      ? 'SET LOCAL'
      : (opts.nonTransactionalDdl ? null : 'SET');
    if (applyTimeouts) {
      await qr.query(`${applyTimeouts} lock_timeout = '${opts.lockTimeoutMs ?? 5000}ms'`);
      await qr.query(`${applyTimeouts} statement_timeout = '${opts.statementTimeoutMs ?? 60000}ms'`);
    }
    if (opts.advisoryLockKey !== undefined) {
      await qr.query('SELECT pg_advisory_lock($1)', [opts.advisoryLockKey]);
    }
    try {
      return await fn(qr);
    } finally {
      if (opts.advisoryLockKey !== undefined) {
        await qr.query('SELECT pg_advisory_unlock($1)', [opts.advisoryLockKey]);
      }
      if (applyTimeouts === 'SET') {
        await qr.query('RESET lock_timeout');
        await qr.query('RESET statement_timeout');
      }
    }
  }
  ```
  Advisory key scheme reuses existing `hashtext('aqua-db-migrate:<schema>')` (migration-orchestrator.ts:65-67).

- Primitives (every one takes `SqlFragment` for user-supplied fragments, `SqlIdent` for identifiers):
  1. `alignColumnNullability(qr, schema: SqlIdent, entities, opts: { onRowsPresent: 'fail' | 'defer' })`
  2. `addMissingColumns(qr, schema, entities)`
  3. `dropOrphanedColumns(qr, schema, entities, opts: { allowlist: SqlIdent[] })`
  4. `alignEnumLabels(qr, schema, entities, opts: { allowRemoval?: boolean, remapTo?: Record<string, SqlValue> })` — `remapTo` values become parameterized UPDATE per R2/R7
  5. `alignCheckConstraints(qr, schema, entities)`
  6. `bringToEntityShape(qr, { schema: SqlIdent, entities, safetyOpts? })` — composes A→D→B→F→C→G→E inside `withDdlSafety` envelope

**Validation**:
- Unit: one spec per primitive with ≥5 cases (no-op/single/multi/unsafe-reject/tx-boundary/**DDL-safety-envelope-applied**)
- **Compile-time negative test (v3 R2)**: `libs/backend-common/src/database/__tests__/sql-fragments.compile-error.spec.ts` — uses `@ts-expect-error` to prove raw string refused by `backfillExpr`
- Non-empty SAVEPOINT behaviour test: `onRowsPresent: 'fail'` + non-empty fixture → `MigrationDataPreservationRequired` event; `onRowsPresent: 'defer'` + empty fixture → succeeds
- Audit: **data-expert** primary; **database-reviewer** pg_catalog; **multi-tenant-saas-expert**; **auth-security-expert** blocker (R2 branded types + identifier boundaries)
- CI invariant: `drift-class-parity.spec.ts` (Phase 2) verifies each primitive has positive/negative fixtures
- E2E: `apps/hr-service/.../bring-to-entity-shape.migration.spec.ts` exercises all 6 primitives against 22-table HR drift fixture

**Rollback**: primitives additive; branded types additive (raw-string uses will surface as TS errors, forcing conversion — that's the point).

**Exit criteria**: 6 primitives shipped with behavioral + compile-time-negative tests; DDL safety envelope applied uniformly; `bringToEntityShape` idempotent; TS compile-error catches raw-string injection attempts.

---

## Phase 3.5 — Data-Preserving Primitives + Expand/Contract Runtime Gate (~2 weeks)

**Goal**: prod tables have data; expand/contract choreography across deploys; runtime gate prevents contract-before-migrate.

**Changes (v3 R6)**:
1. Data-preserving primitives (take `SqlFragment` per R2):
   - `tightenColumnNullability(qr, schema, column, { backfillExpr: SqlFragment, chunkSize })` — multi-deploy: expand+backfill+contract
   - `backfillColumn(qr, schema, table, column, expr: SqlFragment, opts: { chunkSize, throttleMs, progressTable })` — **per-chunk autonomous transaction (R6)**; resumable via `observability.migration_backfill_progress`
   - `reencodeColumn(qr, schema, table, column, fromEncoding, toEncoding, opts)`
   - `splitColumn(qr, schema, table, sourceColumn, targetColumns[], splitExpr: SqlFragment)`

2. **`@ExpandContract` with runtime gate (R6)**:
   ```ts
   @ExpandContract({ phase: 'contract', requires: { migratePhase: '1234567890000-MigrateXyz' } })
   export class EnforceNotNullXyz implements MigrationInterface {
     async up(qr: QueryRunner): Promise<void> {
       // Decorator-injected runtime gate:
       const progress = await qr.query(
         `SELECT status FROM observability.migration_backfill_progress WHERE migration_name = $1`,
         [this.requires.migratePhase]
       );
       if (progress[0]?.status !== 'complete') {
         throw new Error(`Contract phase refused: prerequisite ${this.requires.migratePhase} not complete`);
       }
       // ... SET NOT NULL etc.
     }
   }
   ```

3. **`TenantSchemaSyncService` replay (R6)** — on new tenant provisioning between expand and contract, replays `@ExpandContract` migrations in dependency order; skips backfill if table empty.

4. TypeORM `transaction: false` per-migration flag honored by orchestrator for non-transactional DDL.

**Pattern** — `NOT NULL` on populated column across deploys:
```
Deploy N:   @ExpandContract({phase:'expand'})                         — ADD COLUMN nullable + default
Deploy N+k: @ExpandContract({phase:'migrate'}, transaction:false)     — chunked backfill, per-chunk tx
Deploy N+m: @ExpandContract({phase:'contract', requires:{migratePhase:'...'}}) — SET NOT NULL (gated)
```

**Validation**:
- Unit: each primitive behavioral test at ≥100k-row fixture
- Unit: `@ExpandContract` runtime gate test — seed contract migration with incomplete migrate row, assert throw
- Integration: 3-deploy choreography end-to-end, inject fresh-tenant between expand and contract, assert replay handles correctly
- Audit: **data-expert** primary; **multi-tenant-saas-expert** tenant replay; **architectural-arbiter** choreography correctness
- CI invariant: `expand-contract-sequencing.spec.ts` validates phase order across git history (Phase 4 AST walker per R35)
- E2E: staging flow with ≥100k-row fixture; app v(N) serviceable during backfill

**Rollback**: primitives additive; mid-backfill resumable from progress table.

**Exit criteria**: data-preserving primitives shipped + tested at ≥100k-row scale; runtime gate blocks premature contract; fresh-tenant replay verified.

---

## Phase 4 — PR-Time Gates: pg_catalog Introspection + Test Coverage + AST Sequencing (~2 weeks)

**Goal**: entity changes without migrations fail at PR.

**Changes (v3 R10/R27/R35)**:
- **Extract gates to new Nx lib `libs/schema-gates/` (v3 R10)** — proper jest runner; replaces `tools/gates/*__tests__/` phantom paths
- `libs/schema-gates/src/entity-migration-parity.ts` — uses Phase 2 `pgCatalogIntrospector` (NOT TypeORM generator); deterministic class-level diff
- `libs/schema-gates/src/migration-test-coverage.ts` — PR adds migration → require sibling `.spec.ts`
- `libs/schema-gates/src/expand-contract-sequencing.ts` — AST walker (~300 LOC per R35) scans git history for `@ExpandContract` phase ordering; contract without prior expand fails
- **`tools/gates/gha-sha-pin.ts` (v3 R27)** — scans `.github/workflows/*.yml`, fails on tag-pinned `uses:`
- `.github/workflows/ci-affected.yml` — 4 new jobs (entity-parity, migration-test-coverage, expand-contract-sequencing, gha-sha-pin); first 2 weeks `continue-on-error: true`
- `npm run schema:preflight` — aggregator: runs all gates locally + consolidated checklist
- Runbook: `docs/runbooks/entity-migration-parity.md`

**Validation**:
- Unit per gate: fixture-driven positive + negative cases
- Audit: **infra-expert** (workflow + SHA pinning); **platform-kernel-expert** (gate determinism); **data-expert** (introspector reuse)
- CI invariant: dogfood last 30 PRs; false-positive rate <5% before flipping to required
- E2E: synthetic PR with each failure mode → sticky PR comment posted

**Rollback**: 2-week `continue-on-error` bake; per-service `GATE_*_ENV` flags.

**Exit criteria**: gates active-blocking 2 weeks; false-positive rate <2%; Phase 0 dashboard shows 0 drift-at-boot from PR-time entity changes.

---

## Phase 4.5 — Separation of Duties + External Tickets + CODEOWNERS (NEW v3, ~1 week)

**Goal**: SOC2 CC6.1 / CC8.1 compliance — schema change has author ≠ reviewer + external tracker reference. Blocks Phase 8 Stage 2 (fatal prod flip).

**Changes (v3 R5)**:
- `.github/CODEOWNERS` — `apps/*/src/database/migrations/** @data-expert-team`; ensures migration PRs require data-expert review
- `tools/gates/author-not-reviewer.ts` — CI gate: PR must have ≥1 approving review from a GitHub user whose login ≠ PR author. Uses `gh api repos/.../pulls/<n>/reviews`.
- Update `tools/gates/commit-msg-validator.ts` — for commits matching `fix(.*migration.*)` or `refactor(.*schema.*)`, require BOTH `Closes: <finding-id>` AND `Ticket: <https url>` trailers. Regex: `^Ticket:\s+https?://\S+$` (Linear, Jira, GitHub issue all acceptable)
- `docs/compliance/soc2-cc6.1-change-management.md` — attestation template
- `docs/compliance/evidence/` directory — per-finding attestation files (e.g. `2026-04-21-DEPLOY-CRITICAL-003.md`)

**Validation**:
- Unit: `author-not-reviewer.spec.ts` — fixture PRs with (a) author=reviewer → exit 1, (b) different reviewer → exit 0
- Unit: `commit-msg-validator.spec.ts` — adds test cases for Ticket: trailer on migration commits
- Audit: **compliance-expert** PRIMARY; **auth-security-expert** secondary; SOC2 sign-off mandatory
- CI invariant: branch protection rule on `main` requires `author-not-reviewer` + commit-msg check status
- E2E: dry-run PR with missing Ticket → blocked; PR with Ticket + different-reviewer → passes

**Rollback**: gate `continue-on-error: true` first 2 weeks. Branch protection rule adjustable.

**Exit criteria**: 2 weeks active-blocking with 0 false-positives; CODEOWNERS enforced; compliance evidence files started for existing findings.

---

## Phase 5 — HR Heal Migration Consolidation (~1 week)

**Goal**: replace 3 heal files with 1 idempotent canonical migration.

**Changes (v3 R31/R38)**:
- **Pre-gate (R31)**: `scripts/archive/backfill-schema-object-history-from-migrations.ts` — parses the 3 doomed files, emits rows to `observability.schema_object_history` for every `ADD COLUMN` / `SET NOT NULL` / `ALTER COLUMN TYPE`; Phase 5 deletion blocked until backfill verified
- DELETE: `1786800000000-SyncHrEntitiesToDb.ts`, `1786900000000-HealHrEnumTypeDrift.ts`, `1787000000000-HealHrNullabilityDrift.ts`
- CREATE: `apps/hr-service/src/database/migrations/1787100000000-HrBringToEntityShape.ts`:
  ```ts
  await pinSearchPath(qr, sql.ident('hr'));
  await qr.query(`DELETE FROM hr.typeorm_migrations WHERE name IN ($1, $2, $3)`, [3 old names]);
  await bringToEntityShape(qr, { schema: sql.ident('hr'), entities: HR_ENTITIES });
  ```
- Archive: `apps/hr-service/src/database/migrations/_archive/` — 7-year retention (R17) via git-LFS + S3 Glacier migration tracker
- **POINT-OF-NO-RETURN**: once merged, rollback requires cross-tenant `typeorm_migrations` reconciliation (multi-hour DBA op)
- **Attestation (R38)**: `docs/compliance/evidence/2026-04-21-DEPLOY-CRITICAL-003.md` + `2026-04-21-DEPLOY-CRITICAL-004.md` — finding → commit SHA → regression test → current-state attestation query

**Validation**:
- Unit: fresh DB (fast no-op), drifted DB (10 classes → converge), partial prior-run (3 old rows → converge), schema_object_history populated (R31)
- Audit: **data-expert**; **database-reviewer**; **observability-expert** (orphan-row impact on migration_events); **infra-expert** (deploy bundle + _archive Glacier); **compliance-expert** BLOCKER (R38); **architectural-arbiter** block-level sign-off
- CI invariant: `heal-consolidation.spec.ts` — no service has >1 `Heal*` / `Sync*EntitiesToDb` migration
- E2E: staging deploy → `Schema drift scan clean` round 1/30 for 3 consecutive deploys

**Rollback**: _archive preserved 7 years; restore-PR multi-hour DBA op.

**Exit criteria**: HR has 1 live migration; validator clean on 3 consecutive deploys; schema_object_history complete; compliance attestation files merged.

---

## Phase 6 — SCHEMA_REGISTRY Codegen + Tenant Fan-Out + Scale + Parameterized Search Path (~4 weeks)

**Goal**: kill hand-maintained manifests; tenant scale; parameterized SQL throughout.

**Changes (v3 R1/R7/R21/R26/R29)**:
- `apps/*/project.json` — Nx tags
- `tools/codegen/schema-registry.ts` — topo-sort → `apps/db-migrate/src/schema-registry.generated.ts`
- **`apps/db-migrate/src/main.ts:1` — add `import 'reflect-metadata'` (v3 R29)** — pre-req for decorators
- **Orchestrator class-map (v3 R7)**: reads `dataSource.migrations` class list BEFORE `executePendingMigrations()`; builds `{migrationName → classConstructor}` for fan-out/gating dispatch
- `libs/backend-common/src/database/migration-runner/tenant-fan-out.decorator.ts` — `@TenantFanOut({strategy, onFailure, concurrency, lockClass})` **(v3 R21 adds `lockClass: 'catalog'|'tenant-local'`)**
- **Orchestrator (v3 R1)** — `set_config('search_path', $1, true)` PARAMETERIZED; NEVER `SET LOCAL search_path "<interpolated>"`
- **Schema name re-validation (v3 R1)**: every schema read from `information_schema.schemata` validated against SAFE_IDENT_RE at orchestrator boundary
- Scale (v3-unchanged): `concurrency: 8` bounded `p-limit`; `all-or-nothing` hard-rejected >50 tenants; `observability.migration_events` partitioned monthly; per-source snapshot (Phase 7)
- **Catalog-contended vs tenant-local (v3 R21)**: `ALTER TYPE ADD VALUE`, `CREATE TYPE` forced concurrency=1; `ALTER TABLE tenant_X.foo` gets N parallel
- Advisory-lock rendezvous with `TenantSchemaSyncService` for provisioning race
- `@EmitBootSignal` decorator + `required-signals.yaml` codegen + parity invariant
- **NATS ACL narrow (v3 R26)**: `infrastructure/nats/services.yaml` — `platform.migration.>` + `platform.boot.>` subscribable by observability + db-migrate + sre-tools CN only; CI invariant ≤3 subscribers
- **POINT-OF-NO-RETURN**: `@TenantFanOut` adoption; migration-rewriter script ships with Phase 6 PR

**Validation**:
- Unit: codegen topo-sort, cycle detection; tenant-fan-out decorator (set_config once per tenant, isolate continues, concurrency-per-lock-class respects)
- Integration: fan-out test with failure on tenant 2 (isolate), scale test with 50 tenants (<120s at 8 concurrency for tenant-local DDL)
- Race test: concurrent fan-out + new tenant provisioning
- Audit: **platform-kernel-expert** primary; **multi-tenant-saas-expert**; **data-expert**; **auth-security-expert** blocker (R1 parameterization + R26 ACL narrow); **compliance-expert** (tenant-hash events); **infra-expert** (required-signals)
- CI invariant: codegen-drift + required-signals-parity + ESLint `no-raw-tenant-loop`; **NATS subject subscriber count ≤3 CI test (R26)**
- E2E: deploy trivial HR migration → source + 5 tenants; stress 100 tenants

**Rollback**: `LEGACY_PER_MIGRATION_TENANT_LOOP=true` works BEFORE adoption wave; post-PoNR requires rewriter script.

**Exit criteria**: 0 hand-coded tenant loops in new migrations; 100-tenant scale test green; required-signals parity; NATS ACL narrowed.

---

## Phase 6.5 — App↔Schema Version Compatibility (~1 week)

**Goal**: blue-green / canary deploys don't break when app v(N-1) hits schema migrated for v(N).

**Changes (unchanged from v2)**:
- `libs/backend-common/src/database/migration-compat.decorator.ts` — `@CompatibleWithAppVersion({min, max})`
- Deploy pipeline (Phase 7) reads decorator: `contract`-phase runs ONLY after rolling-update drained; `expand`-phase can run before
- `.github/workflows/deploy-digitalocean.yml` — ordering logic

**Validation**:
- Unit: decorator round-trip
- Integration: `blue-green-migration.spec.ts` simulates old app + new schema, asserts old app paths still succeed after expand-phase
- Audit: **infra-expert** (deploy ordering); **platform-kernel-expert** (contract enforcement); **SRE sign-off mandatory**

**Rollback**: decorator optional.

**Exit criteria**: blue-green with incompatible change refused at gate; compatible passes.

---

## Phase 7 — Dry-Run + Shadow Deploy + Cosign + Snapshot Scrubber + Replica Lag + FRA1 Residency (~3 weeks)

**Goal**: catch "orchestrator wants DDL not in PR"; handle replica lag; capture failures structurally; KVKK-residency + signed snapshots.

**Changes (v3 R4/R8/R13/R14/R36)**:
- **Bucket residency (v3 R4)**: migrate from `s3://aqua-deploy-artifacts/` (NYC3) to `s3://aqua-deploy-artifacts-fra1/` (Frankfurt EU adequacy) — OR IBM Cloud Istanbul for full TR residency
- **KVKK compliance**: `docs/compliance/kvkk-veri-sorumlusu.md` VERBİS declaration; `docs/runbooks/kvkk-breach-notification.md` 72h notification path
- **Cosign snapshot integrity (v3 R13)**: `.github/workflows/prod-schema-snapshot.yml` — `permissions: {contents: read, id-token: write}`; signs with Sigstore cosign OIDC-keyless (workflow-identity-bound)
- Split Spaces keys (v3 R13): `SPACES_SNAPSHOT_WRITE_KEY` (cron bucket-scoped PutObject only) + `SPACES_SNAPSHOT_READ_KEY` (deploy bucket-scoped GetObject only); CODEOWNERS on `.github/workflows/prod-schema-*.yml`
- **Access audit (v3 R36)**: Spaces access-logs bucket enabled, 1y retention, shipped to observability-service
- **`scripts/deploy/snapshot-scrubber.ts` (v3 R14)** — strips COMMENT, strips CHECK literal values, scans column names against PII allowlist (`national_id`, `ssn`, `tc_kimlik_no`, `bank_*`, `iban`, etc.); rejects snapshot on unexpected hit
- **Per-source-schema snapshot** (not full pg_dump): `pg_dump --schema=hr --schema-only` + 1 representative tenant clone; snapshot size bounded
- `apps/db-migrate/src/migration-orchestrator.ts` — `--dry-run` mode emits plan to stdout sentinel `##MIGRATION_PLAN_BEGIN##\n<json>\n##MIGRATION_PLAN_END##` (v3 R8); Ajv-validated at producer
- `scripts/deploy/shadow-deploy.ts` — GHA step downloads snapshot + verifies cosign signature + `snapshot-scrubber` applied + applies to ephemeral PG + invokes `--dry-run` + extracts sentinel JSON + Ajv-validates + diffs against PR migration bodies; exit 1 if superset
- **Replica-lag (v3-unchanged)**: `scripts/deploy/wait-for-replica-sync.ts` — queries `pg_last_xact_replay_timestamp`; blocks post-migration; refuses DROP COLUMN on published tables unless subscriber migration coordinated
- `scripts/deploy/capture-boot-failure-context.ts` (v3-unchanged) — structured `deploy-failure-<sha>.json` artifact + Slack + NATS event

**Validation**:
- Unit: `shadow-deploy.spec.ts` — **real Postgres testcontainer** (not mocked), fixtures (a) DDL matches → exit 0, (b) DDL superset → exit 1, (c) partial-index drift → exit 1, (d) cosign signature mismatch → exit 1 with clear error, (e) PII column name detected → snapshot rejected
- Unit: `snapshot-scrubber.spec.ts` — PII allowlist + COMMENT/CHECK stripping
- Integration: `migration-dry-run.spec.ts` — ephemeral PG, schema unchanged post-dry-run; sentinel JSON parseable
- Audit: **infra-expert** (workflow + SHA pinning + cosign); **platform-kernel-expert** (orchestrator dry-run contract); **auth-security-expert** (SSE-S3 + `::add-mask::` + key rotation); **compliance-expert** BLOCKER (KVKK residency + snapshot PII scrub + VERBİS)
- E2E: "naughty" PR with unexpected DDL → gate blocks + sticky PR comment; staged deploy at FRA1 verified

**Rollback**: `SHADOW_DEPLOY_ENFORCE=warn` for 2 weeks; capture additive.

**Exit criteria**: 2 weeks warn-mode <5% false-positive; enforce; 100% failures produce artifacts; KVKK residency verified; cosign signature mandatory.

---

## Phase 8 — FATAL Staged Rollout + aqua-ctl CLI + emergency_overrides Table (~4 weeks)

**Goal**: production refuses drift; 3am operator rollback is auditable <5min (not PR+CI+deploy).

**Changes (v3 R16/R28/R33)**:
- **`aqua-ctl` CLI (v3 R16)** — new Nx app `apps/aqua-ctl/`:
  - `aqua-ctl drift-bypass --service hr --reason "INC-123" --ttl 2h` — writes to `observability.emergency_overrides`; auto-reverts on TTL expiry; flags stored in Vault (not `.env`)
  - `aqua-ctl drift-bypass --list` — shows active overrides
  - `aqua-ctl drift-bypass --revoke --service hr` — immediate revoke
- **`observability.emergency_overrides` table** — `(svc, operator_id, activated_at, deactivated_at, ttl_expires_at, justification, post_incident_review_url, created_at)` — **7-year retention (R17)**; quarterly SRE review gap = CC7.1 finding
- **Dual detection path (v3 R28/R33)**: SchemaDriftValidator writes `schema.drift.bypass.active` event to:
  - (fast path) NATS `platform.drift.bypass.active`
  - (reliable path) HTTPS POST to observability-service `/events/drift-bypass`
  - PagerDuty alert on EITHER path; 5-min cron job in observability re-fires PagerDuty for ANY active override (heartbeat-if-active pattern)
- **Per-service env precedence (v3-preserves)**: `SCHEMA_DRIFT_FATAL_<SERVICE>` > global `SCHEMA_DRIFT_FATAL`; documented in runbook
- **`scripts/deploy/env-drift-check.ts`** — daily cron compares droplet env vs `docs/configs/env-prod-allowed-overrides.yaml`; alerts on divergence
- Stages:
  1. Stage 0: default `false`; stg/dev override `true` (1 week)
  2. Stage 1 (week +1): per-service `SchemaDriftModule.forRoot({fatal: true})` for auth, billing, hr (1 week)
  3. Stage 2 (week +3): default flips `fatal: true`; bypass → PagerDuty (2 weeks)
  4. Stage 3 (week +7): remove global env bypass; `SCHEMA_DRIFT_FATAL_<SERVICE>` preserved for incident response

**Validation**:
- Unit: `aqua-ctl.spec.ts` — CLI behavior + Vault integration mock; `emergency_overrides.spec.ts` — table retention + TTL auto-revert
- Audit: **data-expert**; **SRE sign-off mandatory**; **infra-expert**; **multi-tenant-saas-expert**; **auth-security-expert** (R16 replaces SSH+.env with auditable CLI)
- Chaos test: inject fixture-drift in staging, assert boot fails hard, `aqua-ctl drift-bypass` completes <2min, audit trail captured
- E2E: canary `aqua-stage` with prod-snapshot + injected drift

**Rollback**: per-stage; per-service env preserved through all stages. Runbook `docs/runbooks/schema-drift-response.md` has 3am section with `aqua-ctl` flow.

**Exit criteria**: Stage 3 in prod 4 weeks with 0 bypass events via old SSH path; `aqua-ctl` audit trail verified quarterly; SRE confirms playbook.

---

## Phase 9 — Legacy Deprecation + NATS ACL + DSAR Handlers + Naming + Exit Artifacts (~3 weeks)

**Goal**: delete dead code; structured boot signals; GDPR compliance fullfilled; naming; user-facing exit artifacts.

**Changes (v3 R19/R26 already in Phase 6)**:
- **MigrationRunnerService deprecation** (unchanged from v2): week 1 default true + warn; week 2-3 flip default false; week 4 delete + ESLint `no-createMigrationRunnerService`
- **Structured boot signal (v3)**: `BootSignalEmitted` event; NATS subject narrowed per Phase 6 R26; parallel stdout 2 weeks
- **DSAR handlers (v3 R19)**:
  - `apps/observability-service/src/gdpr/observability-erasure.handler.ts` — on `TenantErased` event, DELETE rows by `tenant_id_hash` (HMAC); enforce legal-hold precedence
  - `apps/observability-service/src/gdpr/observability-portability.handler.ts` — NDJSON export of migration history for requesting tenant's HMAC (excludes other tenants + operator identity)
  - Register observability in tenant-erasure cascade — **10 services → 11**
- Migration naming (v3 unchanged): `<epoch-ms>_<YYYY-MM-DD>__<purpose>__closes-<finding-id>.ts` + `@MigrationMeta`
- Developer local workflow: `npm run dev:migrate` wraps db-migrate CLI
- Exit artifacts:
  - `docs/runbooks/schema-change-how-to.md` — 5-step positive path
  - `npm run schema:preflight` — aggregates all Phase 4 gates
  - Grafana "active drift" panel (from Phase 0)
  - **`docs/runbooks/schema-drift-response.md`** updated with `aqua-ctl` 3am section (R16)
- Close findings: DEPLOY-CRITICAL-003/004 + phase-tracking findings

**Validation**:
- Unit: `migration-runner.spec.ts` (no-op false, warn true); `observability-erasure.handler.spec.ts` (HMAC match + legal-hold refusal); `observability-portability.handler.spec.ts` (NDJSON shape, tenant-hash filter)
- Integration: `cold-boot-no-legacy-runner.spec.ts` (pre-seed unapplied migration, cold-boot, assert service didn't apply, db-migrate did); `boot-signal-contract.spec.ts` (<10s NATS); `tenant-erasure-cascade.spec.ts` (11-service cascade includes observability)
- Audit: **platform-kernel-expert** (15-service atomic deletion); **data-expert**; **prompt-writer** (CLAUDE.md + runbook quality); **compliance-expert** PRIMARY on DSAR handlers
- CI invariant: `boot-signal-parity.spec.ts`; `migration-naming.ts` gate; NATS ACL subscriber-count invariant

**Rollback**: legacy flag revert; DSAR handlers additive until cascade registered.

**Exit criteria**: MigrationRunnerService removed; NATS signals; 100% migration naming conformance; new engineer reads runbook + ships valid migration; `schema:preflight` returns checklist; DSAR cascade 11 services; SOC2 attestation trail complete.

---

## Cross-Phase Governance

### Audit Matrix (v3 — revised)

| Phase | Primary | Secondary | Blocker | Compliance |
|---|---|---|---|---|
| 1 | data-expert | database-reviewer | test-runner, **auth-security-expert (R30)** | — |
| 2 | data-expert | database-reviewer | multi-tenant-saas, **auth-security-expert (R15)** | compliance-expert (Class J) |
| 0 | observability-expert | data-expert | compliance-expert (R3 HMAC + R17 retention) | **compliance-expert MANDATORY** |
| 3 | data-expert | database-reviewer | multi-tenant-saas, **auth-security-expert BLOCKER (R2)** | — |
| 3.5 | data-expert | multi-tenant-saas | architectural-arbiter | — |
| 4 | infra-expert | platform-kernel | data-expert | — |
| **4.5** | **compliance-expert (NEW)** | auth-security-expert | SOC2-sign-off | **mandatory** |
| 5 | data-expert | database-reviewer + observability + infra | architectural-arbiter | **compliance-expert BLOCKER (R38)** |
| 6 | platform-kernel | infra-expert | multi-tenant-saas, **auth-security-expert BLOCKER (R1, R26)** | compliance-expert (tenant-hash) |
| 6.5 | infra-expert | platform-kernel | **SRE-sign-off** | — |
| 7 | infra-expert | platform-kernel | auth-security, **compliance-expert BLOCKER (R4 KVKK + R14 PII)** | **compliance-expert BLOCKER** |
| 8 | data-expert | multi-tenant-saas | infra-expert, **SRE-sign-off + auth-security-expert (R16)** | SRE-sign-off mandatory |
| 9 | platform-kernel | prompt-writer | orchestrator | **compliance-expert primary on DSAR (R19)** |

### RACI (v3 — unchanged from v2)

| Phase | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| 0 | observability | data-expert | compliance, security, DBA | SRE |
| 4.5 | **compliance-expert** | **release-manager** | legal, auth-security | all devs |
| 7 | infra-expert | infra-expert | security, DBA, **compliance-expert** | release-manager |
| 8 | data-expert | SRE-lead | oncall, release-manager, **auth-security** | CS (alerts) |
| 9 | platform-kernel | prompt-writer | **compliance-expert for DSAR** | all devs |

(other rows unchanged from v2)

### Points-of-No-Return

| Phase | Event | Rollback cost |
|---|---|---|
| 5 | Merge deleting 3 HR heal migrations | Cross-tenant typeorm_migrations reconciliation, multi-hour DBA |
| 6 | First `@TenantFanOut` migration authored | Migration-rewriter script required (ships with Phase 6) |
| 8 Stage 3 | Global env bypass removed | Per-service env preserved — still 3am-safe via `aqua-ctl` |
| 9 Stage 3 | MigrationRunnerService deletion | Atomic cross-service revert required |

### Finding Traceability
Every commit carries `Closes: docs/plans/2026-04-21-db-migrate-enterprise-refactor.md#phase-N` OR new finding ID in registry. **Phase 5 + onwards commits additionally require `Ticket: <url>` trailer (v3 R5)**.

## Risks & Mitigations (v3 — consolidated)

Major new risks covered above in §v3 Revisions table. All v2 risks preserved + v3 adds:
- **SQL injection via identifier path** → R1+R2 branded types compile-error
- **Reversible tenant hash cascade violation** → R3 HMAC + erasure event consumer
- **KVKK cross-border** → R4 FRA1 residency
- **SOC2 change-mgmt fail** → R5 Phase 4.5 separation of duties
- **Encrypted column silent corruption** → R15 `@EncryptedAtRest` + Class J
- **3am SSH+.env unauditable** → R16 `aqua-ctl` + emergency_overrides
- **NATS topology leak** → R26 subject ACL narrowing
- **testcontainers root access** → R30 SBOM + image allowlist + SHA pinning

## Timeline (v3 — honest)

| Wk | Active | Milestone |
|---|---|---|
| 1–2 | Phase 1 | Harness + HR-drift regression + npm audit gate |
| 3–5 | Phase 2 | 10-class validator + pg_catalog introspector + encrypted-column Class J |
| 6–8 | Phase 0 | Observability + HMAC tenant hash + retention matrix + dashboards |
| 9–11 | Phase 3 | 6 primitives with branded SqlFragment + DDL safety envelope |
| 12–13 | Phase 3.5 | Data-preserving + expand/contract runtime gate |
| 14–15 | Phase 4 | pg_catalog gates in warn mode |
| 16 | **Phase 4.5 (NEW)** | Separation of duties + external tickets + CODEOWNERS |
| 17 | Phase 5 | HR consolidated + schema_object_history backfill + attestation |
| 18–21 | Phase 6 | Codegen + fan-out + parameterized set_config + NATS ACL + scale |
| 22 | Phase 6.5 | App-version compat |
| 23–25 | Phase 7 | Dry-run + cosign + scrubber + FRA1 bucket + replica-lag |
| 26–29 | Phase 8 | 4-stage FATAL rollout + `aqua-ctl` + emergency_overrides |
| 30–32 | Phase 9 | Legacy deprecation + DSAR cascade + NATS narrowing + exit artifacts |
| 33–34 | Bake/buffer | Post-Phase-9 observation + SOC2 evidence walkthrough |

**Realistic: 34 weeks @ 0.5 FTE; 17–18 weeks @ 1.0 FTE.**

## Related Documents

- `docs/adr/011-schema-ownership-model.md`
- `docs/adr/012-schema-drift-prevention.md`
- `docs/adr/019-db-migrate-enterprise-refactor.md` (Phase 0)
- `docs/adr/020-migration-file-convention.md` (Phase 9)
- `docs/adr/021-data-migration-contract.md` (Phase 3.5)
- **`docs/adr/022-pseudonymisation-key-management.md` (v3 R3 — Phase 0)**
- **`docs/adr/023-encrypted-column-schema-contract.md` (v3 R15 — Phase 2)**
- **`docs/adr/024-compliance-retention-matrix.md` (v3 R17 — Phase 0)**
- `docs/runbooks/schema-drift-response.md` — `aqua-ctl` 3am section added (Phase 8 R16)
- `docs/runbooks/entity-migration-parity.md` (Phase 4)
- `docs/runbooks/schema-change-how-to.md` (Phase 9)
- **`docs/runbooks/kvkk-breach-notification.md` (v3 R37 — Phase 7)**
- **`docs/runbooks/spaces-key-rotation.md` (v3 R13 — Phase 7)**
- **`docs/compliance/retention-matrix.md` (v3 R17)**
- **`docs/compliance/kvkk-veri-sorumlusu.md` (v3 R4 — Phase 7)**
- **`docs/compliance/soc2-cc6.1-change-management.md` (v3 R5 — Phase 4.5)**
- `docs/reviews/orphan-findings.md` (DEPLOY-CRITICAL-003, 004)

## Appendix — Expert Input Provenance

- v1: data-expert + platform-kernel-expert + infra-expert
- v2: +architectural-arbiter + multi-tenant-saas-expert + architect-review (20 revisions)
- v3: +security-auditor + compliance-expert + code-reviewer (38 revisions)

Audit reports archived in this plan's tracking PR.

## Implementation Kick-off Checklist (v3)

Before Phase 1 starts, the following CRITICAL v3 revisions must be in-place:
- [ ] R1 `set_config()` parameterization pattern documented + code-reviewed
- [ ] R2 `libs/backend-common/src/database/sql-fragments.ts` shipped with branded types
- [ ] R3 HMAC pepper util + ADR-022
- [ ] R9 Jest shared-container pattern documented
- [ ] R22 Nx generator command tested on clean checkout
- [ ] R29 `import 'reflect-metadata'` added to `apps/db-migrate/src/main.ts`

Without these 6, Phase 1 implementation carries compile-time or runtime bugs from day 1.

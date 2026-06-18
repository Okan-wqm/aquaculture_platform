# Review: E2E Messaging Service Architectural Remediation

- **Workflow run:** `E2E - Messaging Service` 24637240275, job 72034778476 (2026-04-19 19:30 UTC)
- **HEAD reviewed:** `6b78d589` (`fix(deploy-gate): canonical migration-runner-complete signal`)
- **Reviewer:** data-expert (primary), with messaging-expert + infra-expert delegated reviews per finding
- **Result:** 96 failed / 14 passed across 12 test suites — total bootstrap failure
- **Plan reference:** `/root/.claude/plans/sparkling-swimming-turtle.md`

## Context

A single visible symptom (`vector_cosine_ops` HNSW index error) was masking five distinct architectural defects that compound into total bootstrap failure for every E2E suite. This review documents each defect at architectural-tier-1 level — root cause, surface, fix, and bug-closure validation strategy.

---

## INFRA-CRITICAL-009 — Runtime `dataSource.synchronize()` is the upstream contaminant

- **Severity:** CRITICAL
- **Layer:** 2
- **Surface:** `libs/backend-common/src/database/source-schema-bootstrap.service.ts:88-102, 138-142`
- **Visible symptom:** `SourceSchemaBootstrapService Failed to bootstrap source schema ... there is no unique constraint matching given keys for referenced table "messages"`
- **Root cause:** `dataSource.synchronize()` runs at `onModuleInit` (NestJS lifecycle hook BEFORE `onApplicationBootstrap`). It fires on every fresh DB before `MessagingMigrationRunnerService` has a chance to apply migrations. TypeORM 0.3.x cannot generate composite-key FK to partitioned tables — `messages` is partitioned by `(id, createdAt)`, but synchronize attempts a single-column FK `REFERENCES messages(id)` which has no unique constraint to satisfy. The same synchronize call also creates columns with WRONG nullability (no NOT NULL on tenantId fields) — this is the HIDDEN cause of the schema-drift-validator's 11 violations later in the bootstrap chain.
- **Architectural fix (T1):** remove both `synchronize()` calls; move lifecycle hook from `onModuleInit` to `onApplicationBootstrap`; declare `MessagingMigrationRunnerService` BEFORE `SourceSchemaBootstrapService` in the providers array so migrations land first; replace the empty-schema branch with a hard-fail message instructing the operator to run db-migrate. Per CLAUDE.md, runtime synchronize is forbidden — migrations are the SSoT.
- **Closure validation:**
  - **(a) static** — `grep "dataSource\.synchronize" libs/backend-common/src/database/source-schema-bootstrap.service.ts` returns zero matches; `OnApplicationBootstrap` hook used (not `OnModuleInit`).
  - **(b) executable** — channel-management E2E spec bootstraps cleanly without QueryFailedError; tests reach the assertion phase (not the bootstrap phase).
  - **(c) regression invariant** — `tests/invariants/no-runtime-synchronize.spec.ts` greps the entire repo and asserts zero `dataSource\.synchronize\(` callsites outside test setup files.
- **Audit:** `Agent(subagent_type="data-expert")` re-reviews diff for tier-1 compliance.

---

## INFRA-CRITICAL-010 — pgvector absent from postgres image

- **Severity:** CRITICAL
- **Layer:** 3
- **Surface:** `.github/workflows/e2e-messaging.yml:65` (`timescale/timescaledb:2.17.2-pg16`); also `docker-compose.droplet.yml:155,215` (`timescale/timescaledb:2.25.1-pg16`)
- **Visible symptom:** `operator class "vector_cosine_ops" does not exist for access method "hnsw"` on `apps/messaging-service/src/migrations/1711800000001-CreateAITables.ts:178`
- **Root cause:** Migration creates HNSW index using pgvector's `vector_cosine_ops` operator class. Stock `timescale/timescaledb` images do not include pgvector. CI fresh DB triggers migration on every run; production is dormant-broken (warm-state DB never re-runs the migration, but the next clean boot would crash).
- **Architectural fix (T1):** build `infrastructure/docker/postgres/Dockerfile` = `FROM timescale/timescaledb:2.25.1-pg16` + install postgresql-16-pgvector. Publish to GHCR via `.github/workflows/build-postgres-image.yml`. Reference the GHCR tag in CI workflow + all 4 docker-compose files (droplet, dev, infra, prod). Single source of truth across every environment.
- **Closure validation:**
  - **(a) static** — Dockerfile builds; `docker inspect` shows valid image manifest.
  - **(b) executable** — `docker run` the new image, `CREATE EXTENSION vector` + `CREATE INDEX … USING hnsw (… vector_cosine_ops)` succeeds against a real running postgres.
  - **(c) regression invariant** — `tests/invariants/postgres-image-uniformity.spec.ts` asserts only one image tag is referenced across all `*.yml` files in the repo.
- **Audit:** `Agent(subagent_type="infra-expert")` confirms Dockerfile reproducibility, image-tag uniformity, GHCR publish workflow sanity, and prod rollout note.

---

## INFRA-CRITICAL-011 — Schema drift: 11 entity↔DB violations

- **Severity:** CRITICAL
- **Layer:** 1
- **Surface:** `SchemaDriftValidator[messaging]` reports 11 violations (4 NOT-NULL drifts + 7 missing columns)
- **Visible symptom:** `schema.drift.detected service="messaging" — 11 violation(s)` on every test bootstrap
- **Root cause:** entities have advanced beyond migrations. Specifically:
  - `channel_members.tenantId` declared NOT NULL @ `channel-member.entity.ts:51`, DB nullable
  - `channels.tenantId` declared NOT NULL @ `channel.entity.ts:49`, DB nullable
  - `messages.tenantId` declared NOT NULL @ `message.entity.ts:49`, DB nullable
  - `messages.isAiGenerated` declared @ `message.entity.ts:113`, DB has no column
  - `message_attachments.is_deleted` declared @ `message-attachment.entity.ts:91`, DB has no column
  - `message_attachments.deleted_at` declared @ `message-attachment.entity.ts:95`, DB has no column
  - `messaging_outbox.isDeadLettered` declared NOT NULL @ `outbox-entity.base.ts:116`, DB nullable
  - `legal_holds.legalMatterId` declared @ `legal-hold.entity.ts:45`, DB has no column
  - `legal_holds.legalMatterDescription` declared @ `legal-hold.entity.ts:53`, DB has no column
  - `legal_holds.requestedBy` declared @ `legal-hold.entity.ts:65`, DB has no column
  - `legal_holds.expiresAt` declared @ `legal-hold.entity.ts:90`, DB has no column

  After INFRA-CRITICAL-009 is fixed (synchronize gone), these violations are real entity-vs-migration gaps — synchronize was previously masking them by creating wrong-shape columns silently.
- **Architectural fix (T1):** single remediation migration `apps/messaging-service/src/migrations/1782600000000-AlignMessagingEntityDrift.ts` that:
  - Block 1: 7 × `ADD COLUMN IF NOT EXISTS` for the missing columns (idempotency-safe).
  - Block 2: 4 × `assertNoNulls` + `UPDATE ... WHERE col IS NULL` backfill + `ALTER COLUMN SET NOT NULL` for the nullability convergence targets.
  - `down()`: symmetrical `DROP COLUMN IF EXISTS` + `ALTER COLUMN DROP NOT NULL`.
  - Pattern mirrors `1782300000000-AddTenantIdToMessageChildren.ts:79-89` (assertNoNulls before SET NOT NULL).
- **Closure validation:**
  - **(a) static** — migration file present at expected timestamp; `grep -cE "ADD COLUMN IF NOT EXISTS|SET NOT NULL"` returns ≥ 11.
  - **(b) executable** — `SchemaDriftValidator` log line `Schema drift scan clean` appears in fresh-DB bootstrap.
  - **(c) regression invariant** — `apps/messaging-service/src/__tests__/integration/schema-drift-zero.spec.ts` asserts violations array is empty.
- **Audit:** `Agent(subagent_type="messaging-expert")` reviews migration; `Agent(subagent_type="data-expert")` cross-checks tenant fan-out semantics.

---

## INFRA-CRITICAL-012 — Test fixture creates partitions out-of-band

- **Severity:** CRITICAL
- **Layer:** 4
- **Surface:** `apps/messaging-service/test/e2e-setup.ts:380-430` uses naming `${table}_y${year}m${month}` (e.g. `messages_y2026m04`); runtime `apps/messaging-service/src/partition/partition-manager.service.ts:97` uses naming `${table}_${year}_${month}` (e.g. `messages_2026_04`)
- **Visible symptom:** `partition messages_2026_04 would overlap partition messages_y2026m04` — repeats for `messages_2026_{04,05,06}` AND `message_receipts_2026_{04,05,06}` on every test run
- **Root cause:** two competing partition creators violate single-source-of-truth. Test fixture creates partitions BEFORE app starts. PostgreSQL detects overlapping `FOR VALUES` ranges (regardless of partition NAME) and rejects the second attempt — bricks every test that needs to write to messages or message_receipts in tenant schema.
- **Architectural fix (T1):** delete the partition creation block in `e2e-setup.ts:380-430`. `PartitionManagerService.onApplicationBootstrap` is the canonical SSoT (already runs at app bootstrap, ensures current + 2 future months). The test fixture's partitioning is a pre-existing duplicate that was structurally never needed.
- **Closure validation:**
  - **(a) static** — `grep "_y[0-9]{4}m[0-9]{2}" apps/messaging-service/test/e2e-setup.ts` returns zero matches.
  - **(b) executable** — tenant-isolation E2E spec runs without "would overlap partition" log lines.
  - **(c) regression invariant** — `tests/invariants/single-partition-creator.spec.ts` greps for ANY `CREATE TABLE.*PARTITION OF` outside `migrations/` and `partition-manager.service.ts` and asserts zero hits.
- **Audit:** `Agent(subagent_type="messaging-expert")` confirms PartitionManagerService covers the test's date range without the fixture.

---

## INFRA-CRITICAL-013 — GraphQL enum coercion writes uppercase to DB

- **Severity:** HIGH
- **Layer:** 2
- **Surface:** `apps/messaging-service/src/channel/entities/channel-member.entity.ts:32` (`registerEnumType` without `valuesMap`); `apps/messaging-service/src/channel/resolvers/channel.resolver.ts:226`
- **Visible symptom:** `new row for relation "channel_members" violates check constraint "chk_member_role"` — failing row contains `MEMBER` (uppercase); CHECK allows lowercase only
- **Root cause:** TypeScript enum `ChannelMemberRole` has key `MEMBER` mapped to value `'member'`. `registerEnumType(ChannelMemberRole, { name: 'ChannelMemberRole' })` without explicit `valuesMap` exposes the enum NAMES as GraphQL enum values, but on input deserialization the raw NAME `'MEMBER'` leaks through to the resolver param → command → handler → SQL. Per OWASP input-boundary discipline, enum coercion must be the canonical normalization point.
- **Architectural fix (T1):** replace bare `registerEnumType` with explicit `valuesMap` so GraphQL→TypeScript coercion writes the TypeScript enum VALUE (`'member'`), not the NAME (`'MEMBER'`). If `valuesMap` alone insufficient (NestJS GraphQL edge case for value-mapped string enums), add explicit `@Transform` on `AddChannelMemberInput` DTO that maps GraphQL name to enum value. Apply same pattern to `NotificationPreference` registered on the same line.
- **Closure validation:**
  - **(a) static** — `grep -A3 "registerEnumType\(ChannelMemberRole" channel-member.entity.ts` shows `valuesMap` block.
  - **(b) executable** — channel-management E2E spec runs without `chk_member_role` violation; SELECT DISTINCT role FROM channel_members returns only lowercase values.
  - **(c) regression invariant** — `apps/messaging-service/src/channel/__tests__/role-enum-coercion.spec.ts` contract test calls resolver with GraphQL input `'MEMBER'` and asserts `AddMemberCommand` receives `'member'`.
- **Audit:** `Agent(subagent_type="messaging-expert")` confirms valuesMap fix; `Agent(subagent_type="frontend-expert")` checks no web client depends on uppercase response shape.

---

## INFRA-CRITICAL-014 — Illegal `value:` field in GraphQL enum `valuesMap`

- **Severity:** CRITICAL
- **Layer:** 2
- **Surface:** `apps/messaging-service/src/channel/entities/channel-member.entity.ts` `registerEnumType(..., { valuesMap })` entries for `ChannelMemberRole` and `NotificationPreference`
- **Visible symptom:** `tsc` rejects `value` properties in `valuesMap` metadata with TS2353, blocking 12/12 messaging E2E suites and the affected backend build before any runtime assertion can execute.
- **Root cause:** NestJS `EnumMetadataValuesMapOptions` accepts only enum metadata (`description` and `deprecationReason`). The attempted `value:` override treated `valuesMap` as the coercion SSoT, but NestJS derives runtime enum values from the TypeScript enum object. The actual GraphQL-name to TypeScript-value boundary normalization belongs at the resolver input boundary.
- **Architectural fix (T2/T3):** keep the resolver boundary normalization as the SSoT and keep `valuesMap` metadata-only. PR #533 added `tests/invariants/graphql-enum-valuesmap-metadata.spec.ts`, which scans every `registerEnumType` callsite under `apps/`, `libs/`, `platform/`, and `web/` and rejects unsupported `value` fields or spread-hidden fields in `valuesMap` entries.
- **Closure validation:**
  - **(a) static** — no `registerEnumType` `valuesMap` entry contains a `value` property.
  - **(b) executable** — `apps/messaging-service/src/channel/__tests__/role-enum-coercion.spec.ts` continues to prove GraphQL input `MEMBER` reaches `AddMemberCommand` as `member`.
  - **(c) regression invariant** — `tests/invariants/graphql-enum-valuesmap-metadata.spec.ts` keeps the metadata-only contract repository-wide.
- **Audit:** `Agent(subagent_type="messaging-expert")` owns the resolver-boundary behavior; `Agent(subagent_type="data-expert")` owns the review-file anchor and registry traceability.

---

## Out of scope

- AI tables relocation to `ai-service` (separate refactor).
- Switching to a non-TimescaleDB image just for messaging tests (would split image-set; not architecturally clean).
- Other `registerEnumType` callsites cross-platform — only messaging-service scope is fixed; broader sweep is a follow-up finding.
- Production droplet rollout coordination — operator action after the new image is published.

## Post-implementation acceptance

- All 5 findings RESOLVED in `docs/reviews/_registry/findings.jsonl` with `closing_commits` populated.
- `E2E - Messaging Service` workflow green: 12/12 suites pass.
- 5 specialist audit agents return PASS.
- No regression in sibling workflows (sensor E2E, deploy-digitalocean) on the same SHA.
- `Agent(subagent_type="orchestrator")` final master audit returns PASS with concrete evidence.

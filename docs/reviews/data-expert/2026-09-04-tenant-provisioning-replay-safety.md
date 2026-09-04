# Tenant provisioning replay safety — 2026-09-04

**Agent:** `data-expert` · **Mode:** CATCHER (read-only) · **Cycle:**
`2026-09-04-tenant-provisioning-replay-safety`

**Scope:** the tenant-schema provisioning path end to end — `admin-api` saga →
`platform.request_tenant_schema_provisioning` → `apps/db-migrate` provisioner →
`runSchemaMigrations` replay — plus the seven tenant-aware Baseline migrations
and the gates that are supposed to keep that replay honest.

**Why now:** `DATA-CRITICAL-010` (no new tenant can be provisioned) is past its
2026-08-15 deadline and blocks the pilot's super-admin flow. Planning its fix
surfaced two further defects of the same class and one gate-precision defect.

## Executive summary

Provisioning a tenant is migration **replay**: the orchestrator pins
`search_path` to `tenant_<uuid>` and runs each tenant-aware service's migration
set. That mechanism only redirects **unqualified** DDL. Anything that names its
schema explicitly — or re-pins the session to the source schema — escapes it,
lands in the source schema, and still gets recorded in the tenant's ledger as
applied.

The platform has one gate for this, `tenant-aware-migration-ddl-guard`, and it
recognises exactly one spelling of the defect. This review records the two
spellings it misses and the one gate whose waiver is wider than it reads.

## Findings

### MSG-HIGH-077 — a per-tenant migration re-pins the source schema

`apps/messaging-service/src/migrations/1800700000000-AddMessagesEmbeddingColumn.ts`
adds `embedding` (+ an hnsw index) to `messages`. `messages` is a **per-tenant**
table — it is in `MODULE_SCHEMAS.messaging.tables`, not `infrastructureTables`.

The migration is **not** `@SourceOnlyMigration`, yet both `up()` and `down()`
open with:

```ts
await pinSearchPath(queryRunner, 'messaging');
```

`pinSearchPath` (`libs/backend-common/src/database/base-migration.ts:106-130`)
issues `SET search_path TO "<arg>", public` and verifies it against
`current_schema()`. It takes its literal argument; it has no tenant awareness.

So in a tenant pass: the orchestrator pins `tenant_<uuid>`, the migration
re-pins `messaging`, `ALTER TABLE messages ADD COLUMN IF NOT EXISTS` no-ops
against the source (the column is already there), and
`recordSourceOnlySkip` is never reached because the migration is not
source-only — the ledger row is written as a normal successful apply.

**Effect:** no tenant's `messages` table has an `embedding` column, and no
tenant ever will, because the ledger says the migration ran. This is the
"ledger applied, DDL never ran" class that `postCondition()` exists to prevent;
this migration declares none.

**What makes it hard to see:** the file's own docblock asserts the opposite —

> Tenant-routing-correct (tenant-aware-migration-ddl-guard): the DDL is
> UNQUALIFIED and the search_path is pinned via `pinSearchPath`, so the runner
> applies it to whatever schema it is processing — the `messaging` source
> schema here, and any tenant clone the runner pins

The first half is true and the second is not: the DDL is unqualified, but the
pin overrides the runner rather than following it.

**Bounded:** the other four messaging migrations that call `pinSearchPath` are
all `@SourceOnlyMigration` (outbox, idempotency ledger, partition contract —
cross-tenant infrastructure), where pinning the source schema is correct and
the tenant pass skips them anyway. This file is the only violation repo-wide.

**Fix direction:** a forward migration, not an edit. Post-Baseline migrations
are already recorded applied in every existing tenant ledger, so editing this
file would never re-run anywhere. A new unqualified migration with a
`postCondition` heals existing tenants and new ones in one pass — the shape of
`1803100000000-HealAiProposedActionsUnqualified.ts`.

### DATA-HIGH-012 — the DDL guard cannot see a source-schema pin

`tests/invariants/tenant-aware-migration-ddl-guard.spec.ts` is the gate that
stops a per-tenant migration from writing to the source schema. Its detector is
a single regex over migration text (`:18-19`) that looks for a DDL keyword
followed by a `"<source schema>".` identifier.

Re-pinning `search_path` to the source schema is functionally identical to
qualifying every statement in the file, and the regex cannot see it. That is
how MSG-HIGH-077 shipped **citing this guard as evidence of its own
correctness**.

This is the same shape as the defect the guard's own docblock records:
`ORPHAN-HIGH-408` used a self-service docblock marker to qualify a per-tenant
table, and the replay never landed it in any tenant. The lesson taken then was
to replace the marker with a reviewer-gated allowlist; the lesson available now
is that the detector enumerates spellings rather than the property.

**Fix direction:** treat `pinSearchPath(qr, '<own source schema>')` inside a
tenant-aware migration that is not `@SourceOnlyMigration` as the same violation
as qualified DDL. The two holes close together with the Baseline exclusion at
`:64-79`, which is where `DATA-CRITICAL-010` hides.

### PROC-MEDIUM-021 — the immutability waiver is wider than it reads

`tools/gates/migration-immutability-witness.ts` requires a PR-body line
`MIGRATION-IMMUTABLE-OK: <filename> — <reason>` for each shipped migration
edited in place. `findWaiver` (`:152-163`) derives the **basename** from the
path and matches that:

```text
const baseName = path.split(/[\\/]/).pop() ?? path;
const re = new RegExp(
  `MIGRATION-IMMUTABLE-OK:[^\n]*\b${escapeRegex(baseName)}\b`, 'i');
```

All fourteen Baselines are named `1800000000000-Baseline.ts`. One waiver line
therefore waives every Baseline in the repository at once, including services
the PR never touched. The gate also cannot distinguish a comment change from a
DDL rewrite, so the only real control on a Baseline edit is CODEOWNERS review —
which the waiver's breadth then makes harder to scope.

**Fix direction:** match the repo-relative path, falling back to the basename
only when it is unambiguous across the repository.

### INFRA-HIGH-145 — a required check that cannot be honoured

Fixing the above meant editing `web/apps/aquamobil/package.json`, which is the
first change in a while to set `dependency_audit_required` and therefore run
`security-audit`. That job gated on `npm audit`'s own exit code, which is
all-or-nothing.

`GHSA-528h-pc64-c93x` (`minio@8.0.7` → `stream-json@1.9.1`) has no remediation
that keeps minio working. No patched stream-json 1.x or 2.x exists — the
advisory covers `<=3.4.0` — and 3.5+ is ESM-only and restructured under `src/`,
so an override breaks minio's CommonJS
`require("stream-json/jsonl/Parser.js")`. Verified by unpacking 3.6.0 rather
than inferred. npm's own remediation is a major downgrade to `minio@7.1.3`, and
8.0.7 is the latest published release.

`security-audit` is required for `merge-gate`, so it stays red for a reason
nobody can act on — and a permanently red required check stops being read, at
which point it protects nothing. The gate had no way to record a reviewed,
dated exception, unlike the affected-target quarantine and the
dormant-invariant registry, which both carry `{owner, reason, expires_on,
finding_id}`.

**Bounded:** every advisory with a real fix was fixed first — `fast-uri` (whose
existing override had itself become the vulnerable version), `browserslist`,
`qs`, and `sanitize-html`, the last by root-causing the Jest ESM failure to
`jest.preset.js`'s own `transformIgnorePatterns` allowlist rather than
excepting it. The minio chain is the only one left.

**Reachability, for whoever prices the risk:** minio touches stream-json only
in `notification.js`. `libs/storage/src/minio-client.service.ts` is the single
importer of minio in the repository and uses `bucketExists`, `getObject`,
`listObjects`, `makeBucket`, `presignedGetObject`, `presignedPutObject`,
`putObject`, `removeObject` and `statObject` — none of which reach it.

**Fix direction:** `scripts/ci/npm-audit-gate.mjs` renders the verdict instead
of npm, applying `scripts/ci/npm-audit-exceptions.json`. An exception is one
advisory, in one named audit leg, bound to the packages it was reviewed
against, with an owner, an argument, a registry finding and an expiry after
which the gate fails closed again.

## Findings from the gate's first live run

The three above were found by reading. The three below were found by running:
`tenant-provisioning-replay.spec.ts` provisioned a real tenant against a real
database for the first time, and the tenant came out with `farm` and none of the
other six services.

### ADMIN-CRITICAL-008 — the dry-run guard cannot read the table it guards

`admin.reject_dry_run_schema_deletion_job()`
(`1807500000000-PersistTenantErasureDryRunMode.ts:196-235`) fires BEFORE INSERT
OR UPDATE on `platform.tenant_schema_jobs`. It is SECURITY DEFINER owned by
`admin_schema_owner`, and that role has no SELECT on
`admin.tenant_erasure_operations` — see INFRA-HIGH-146 for why.

That alone would have been visible on day one. What hid it is the guard's shape:

```sql
IF NEW.job_type = 'DELETE' AND EXISTS (SELECT … FROM admin.tenant_erasure_operations …)
```

PL/pgSQL evaluates that as ONE query. Under a **custom** plan the `AND`
short-circuits and the subquery is never touched, so a PROVISION or RECONCILE
job passes. After the fifth execution in a session PL/pgSQL promotes the cached
plan to a **generic** one, the subquery's relation is permission-checked at
executor start whatever `job_type` holds, and every later write to the job row
fails with `permission denied for table tenant_erasure_operations`.

So a short job succeeds and a long one dies partway through. Provisioning a real
tenant is long — it heartbeats through the replay. It crossed the threshold
after the farm schema:

```text
"message":"Tenant schema provisioner failed to write job failure evidence",
"error":"permission denied for table tenant_erasure_operations"
  at executeLeaseBoundUpdate (apps/db-migrate/src/tenant-schema-provisioner.ts:121)
  at renewJobLease (…:133)
```

Both halves were reproduced on PostgreSQL 16 rather than inferred: the same
statement passes under a custom plan and raises this error under
`plan_cache_mode = force_generic_plan`.

**Fix:** nested `IF`s, so the subquery is a separate SPI plan prepared only for
DELETE jobs and no plan shape can make another job type depend on a privilege it
has no business needing; **and** `GRANT SELECT` to the definer, so the guard
works for the DELETE jobs it exists to judge instead of failing closed on them
with a privilege error that reads like corruption. Either alone leaves a hole.

### DATA-HIGH-014 — the farm outbox is cloned into every new tenant

`1800200000000-CreateFarmOutboxTable.ts` creates `farm_outbox` with unqualified
DDL and is not `@SourceOnlyMigration`, so a tenant pass resolves it into
`tenant_<uuid>`. `farm_outbox` is in `MODULE_SCHEMAS.farm.infrastructureTables`,
and that entry's own comment says it is not cloned. The messaging equivalent
carries the decorator; farm's did not. An outbox cloned per tenant silently
swallows platform-wide events.

### INFRA-HIGH-147 — the sensor rollups cannot be created after RLS is armed

With the heartbeat guard fixed, the provisioner got through farm AND sensor and
then died on

```text
cannot create continuous aggregate on hypertable with row security
  at ensureTenantSensorContinuousAggregateAuthority
     (apps/db-migrate/src/tenant-sensor-continuous-aggregate-authority.ts:121)
```

TimescaleDB's restriction is asymmetric: enabling row security on a hypertable
that already carries a continuous aggregate is allowed, creating the aggregate
afterwards is not. The retired `CREATE TABLE LIKE` path never hit this because
it cloned neither hypertables nor RLS.

Two things had to move, and the first attempt got only one of them:

1. The provisioner ran the aggregate authority AFTER the per-service loop, while
   that loop's `postMigrationHardening` arms RLS schema-wide. Fixed by creating
   the aggregates inside the loop, between the sensor migrations and the sensor
   hardening, with a fail-closed check that the sensor registry entry was
   actually seen so losing it cannot silently produce an aggregate-less tenant.
2. That alone changed nothing, because the RLS was never coming from the
   hardening pass at all. The sensor **Baseline** calls
   `applyTenantRlsToSchema(queryRunner, { excludeTables: [] })` in the same
   migration chain that creates `sensor_metrics` — so a tenant replay armed the
   table from inside the chain and reached the authority with no window left. It
   is invisible from the provisioner: the arming happens 15 migrations earlier,
   in a hand-authored block, in another service's file.

`sensor_metrics` is now excluded from the Baseline's RLS pass and armed by the
schema-wide hardening instead. The end state is identical — the table carries
RLS either way — and only the order moves, into the window step 1 opened.

**NOT fixed for RECONCILE** (owner @okan-wqm, deadline 2026-10-15).
`RECONCILE_EXISTING_SCHEMA` runs against a schema that is already hardened, so
it has no such window. The `CREATE MATERIALIZED VIEW` statements carry
`IF NOT EXISTS` and are expected to short-circuit before TimescaleDB's DDL hook
for a tenant that already has them — expected, not measured, because the
bootstrap needs `timescaledb` and `pgvector` and cannot run outside CI. The
exposed set is tenants provisioned through the retired `LIKE` path, and what
they actually have needs checking against a live database before choosing
between creating the aggregates before arming RLS in reconcile too, and having
reconcile report rather than attempt.

### INFRA-HIGH-146 — bootstrap hardening runs before the tables it hardens exist

Stage 008 states the invariant that every relation in a schema is owned by
`<svc>_schema_owner` and granted to `<svc>_service`, and implements it with
`ALTER TABLE … OWNER TO` and `GRANT … ON ALL TABLES IN SCHEMA`. Both are
point-in-time over the relations that exist when they run — and they run in
Phase 0, before the Phase 1 migration loop that creates most of them
(`main.ts:1283-1320`). Every table a migration creates is outside the invariant
until some later deploy's Phase 0 sweeps it up, and on a from-scratch install
there is no later deploy. ADMIN-CRITICAL-008 is one casualty of this; it is
fixed at the guard, and the class is not.

**Not fixed in the PR that raised it** (owner @okan-wqm, deadline 2026-10-15).
Re-running the hardening stage after Phase 1 is the fix, and it re-owns every
table in every schema — the bootstrap needs `timescaledb` and `pgvector`, so
that can be exercised nowhere but CI, and shipping it untested alongside the
provisioning fix would risk the fix. Note that in CI the bootstrap and the
migrations run as the same superuser, so `ALTER DEFAULT PRIVILEGES` masks the
grant half there; a production split between the bootstrap role and `db_migrate`
would not be masked.

## Context for DATA-CRITICAL-010

The three findings above were surfaced while planning the fix for
`DATA-CRITICAL-010`. Two facts from that planning belong in the record because
they change how that finding should be read.

**The qualification is a regression, not a design choice.** The pre-reset
migration corpus was overwhelmingly unqualified and therefore replay-safe:
`apps/farm-service/src/database/migrations/.archive/2026-05-18T09-42-08-277Z/1700000000000-CreateInitialSchema.ts`
has 49 `CREATE TABLE` statements and zero qualified identifiers;
`1789200000000-AddMissingFarmTables.ts` has 43 and zero. The 2026-05-18
day-one baseline reset regenerated every Baseline with
`typeorm migration:generate`, which always emits `"schema"."table"`. The
property existed and the generator silently dropped it.

**A failed provision does not merely fail.** The PROVISION path
runs `CREATE SCHEMA` outside any transaction and has no rollback, so a failure
leaves an empty `tenant_<uuid>` behind. The next deploy discovers it by name
alone (`listTenantSchemas` matches the namespace pattern and consults no
evidence table), `backfillTenantLedgersForSource` finds its ledger empty and
stamps the entire source history into it, and the fan-out then reports nothing
pending. The schema is permanently unrepairable — `RECONCILE_EXISTING_SCHEMA`
refuses it with `found empty schema`. Where TimescaleDB is installed it is
worse still: deploy Phase 1.3 runs
`REVOKE ... ON "<tenant>"."sensor_metrics"` unconditionally, which raises
`relation does not exist` and fails the deploy — so one failed provisioning
bricks every subsequent deploy. Recovery through the admin API is also closed:
`retryOperation` skips the already-succeeded `publish_provisioning_requested`
step, so the request is never re-issued and the FAILED job is never reset.

That behaviour is not itself new — it is the blast radius of DATA-CRITICAL-010
rather than a separate defect — but any fix must handle the phantom tenants
that already exist, not only prevent new ones.

## References

- Finding registry: `docs/reviews/_registry/findings.jsonl`
- Rule SSoT: `CLAUDE.md`, `docs/runbooks/migration-authoring.md`
- Related: `DATA-CRITICAL-010`, `ORPHAN-HIGH-408`, `INFRA-CRITICAL-039`

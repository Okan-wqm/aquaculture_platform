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

### SENSOR-CRITICAL-105 — the sensor rollups cannot be created after RLS is armed

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

### INFRA-HIGH-147 — the same wall on the RECONCILE path, and a mis-attributed trailer

`RECONCILE_EXISTING_SCHEMA` calls the same authority against a schema that is
already hardened, so it has no such window. The `CREATE MATERIALIZED VIEW`
statements carry `IF NOT EXISTS` and are expected to short-circuit before
TimescaleDB's DDL hook for a tenant that already has them — expected, not
measured, because the bootstrap needs `timescaledb` and `pgvector` and cannot
run outside CI. The exposed set is tenants provisioned through the retired
`LIKE` path, and what they actually have needs checking against a live database
before choosing between creating the aggregates before arming RLS in reconcile
too, and having reconcile report rather than attempt.

**Still open** — owner @okan-wqm, deadline 2026-10-15.

**Correction to the record.** Commit `82043ef` carries
`Closes: …#INFRA-HIGH-147`, and that trailer is wrong: 147's subject is the
RECONCILE path, which that commit did not touch. The PROVISION half it did fix
had no finding of its own, so it now has one — `SENSOR-CRITICAL-105` above —
and 147 stays OPEN. The trailer cannot be rewritten (history is not rewritten on
this branch), so it is corrected here and in the commit that follows rather than
left to close a finding nobody fixed. Traceability that closes the wrong finding
is worse than none: it retires an open defect by accident.

### INFRA-HIGH-148 — a migration hands the config schema to its login role

Once the provisioning gate went green, `schema-invariants` ran against a
migrated database for the first time and B.4 failed on one schema:

```text
B.4 schema "config" is owned by "config_service", expected "config_schema_owner"
```

The database is right about what it holds and the platform is wrong to hold it.
`apps/config-service/src/database/migrations/1800100000000-OwnConfigTablesByConfigService.ts:40`
executes `ALTER SCHEMA config OWNER TO config_service` in Phase 1, after stage
008 has given the schema to the NOLOGIN `config_schema_owner`. Ownership carries
DROP and ALTER over every object in the schema, so `config` ends every deploy
owned by the role the service logs in as.

The migration does not claim it. Its own docblock justifies moving "domain
tables, enum types, and owned sequences" so config-service can enable tenant RLS
at boot — and TABLE ownership is what that needs. The schema line is collateral,
beyond its stated contract and against the platform's.

**Why nothing caught it:** B.4's expectation used to be a hardcoded list of
fourteen schemas that omitted `config`. Deriving it from 008's own
`jsonb_to_recordset` table — done earlier in this same programme — added the
fifteenth, and the first run against a migrated database failed on it.

**Fixed** by `1807400000000-RestoreConfigSchemaOwnerRole`: the SCHEMA returns to
`config_schema_owner`; tables, types, sequences and the `USAGE, CREATE` grant
stay with `config_service`. A CREATE grant lets the service add objects without
conferring DROP over the ones already there — that difference is the whole fix.

Same family as INFRA-HIGH-146 below: a Phase 1 migration silently overriding
Phase 0 hardening, which nothing re-checks because 008 does not run again in
that deploy.

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

## Findings from the failed runs themselves

The gate reached 24/24 only after four real failed provisions. Each of those
left a `tenant_<uuid>` schema behind with `farm` and `sensor` present and the
other five services absent — and what the platform does with such a schema is
worse than the failure that produced it. The three defects below were named in
the DATA-CRITICAL-010 context section as "blast radius"; they are registered
separately because each has its own owner, its own fix, and its own test.

### INFRA-CRITICAL-149 — a deploy stamps a ledger the schema cannot back

`listTenantSchemas` (`apps/db-migrate/src/main.ts:886-900`) discovers tenants by
namespace pattern alone and consults no evidence table.
`backfillTenantLedgersForSource` (`:397-497`) then creates `migrations_<src>` in
every discovered schema and, finding it empty, copies the **entire** source
ledger into it. The fan-out that follows sees nothing pending. From that deploy
on the schema is reported fully migrated for all seven services while holding
two; `RECONCILE_EXISTING_SCHEMA` refuses it as an empty schema; and where
TimescaleDB is installed, deploy Phase 1.3 runs
`REVOKE … ON "<tenant>"."sensor_metrics"` unconditionally, raises
`relation does not exist`, and the deploy exits 1 — one failed provisioning
breaks every subsequent deploy.

**Why a "no tables at all" guard is wrong:** the schemas the gate actually left
behind were partial, not empty. That guard passes on them and stamps the five
missing services.

**Fix direction:** per source schema. Before stamping `migrations_<src>`, the
tenant schema must carry every per-tenant table `MODULE_SCHEMAS` registers for
`<src>` (`tables` + `referenceDataTables` — the set the provisioning gate itself
asserts). Otherwise the stamp is skipped and the missing set logged. Left empty,
the ledger makes the next fan-out build the missing schemas in the same deploy:
the rule turns a bricked tenant into a self-healing one, phantoms already in
production included.

### ADMIN-HIGH-009 — a retried provision cannot re-issue its failed job

`retryOperation` (`tenant-provisioning-workflow.service.ts:281-360`) resets every
step row except the SUCCEEDED ones, and `runStep` (`:1668-1684`) returns early on
a SUCCEEDED row. `publish_provisioning_requested` succeeded on the first attempt,
so on retry `platform.request_tenant_schema_provisioning` is never called again
— although that function is idempotent per `operation_id` and re-opens a
FAILED/ABORTED job by design (`009-tenant-schema-provisioner.sql:214-249`). The
wait step (`:1294-1315`) reads the same FAILED job and throws. The retry is dead
on arrival.

This is the class the same file already documents for `activate_tenant`
(`activateTenantAfterVerification`: re-verify before acting, because a SUCCEEDED
row is old evidence on a retry). The lesson was applied to one step and not to
the one whose postcondition lives in another table.

**Fix direction:** a step's ledger row is not its postcondition. `runStep`
accepts a postcondition probe; when the row says SUCCEEDED but the probe says
the postcondition no longer holds, the step re-runs. For the publish step the
probe is "a PROVISION job for this operation exists and is not FAILED/ABORTED".
A first-attempt failure still fails the run — only an explicit retry re-issues,
so there is no unbounded re-provision loop — and COMMITTED jobs are never
re-issued.

### INFRA-HIGH-150 — a failed provision leaves the schema it created

`processJob` issues `CREATE SCHEMA IF NOT EXISTS` on an autocommit connection
(`tenant-schema-provisioner.ts:944-946`); the replay cannot be one transaction
(`CREATE INDEX CONCURRENTLY` and the TimescaleDB steps opt out), so a
per-migration rollback cannot reach it. The catch block (`:1079-1104`) collects
residue and writes FAILED evidence and contains no `DROP SCHEMA`; the only drop
in the file is the DELETE path (`:630`).

**Fix direction:** drop only a schema _this run_ created.
`assertTenantSchemaIdentityAvailable` (`:273-291`) checks that no OTHER tenant
holds the name, not whether the schema pre-exists, and `IF NOT EXISTS` hides
pre-existence — so the provisioner probes `information_schema.schemata` before
`CREATE` and remembers the answer. A schema left by an earlier attempt
(reachable once ADMIN-HIGH-009 makes retries work) is not dropped: the
ledger-driven fan-out resumes it, and INFRA-CRITICAL-149 keeps a deploy from
sealing it. `collectFailureResidue` keeps running first — it is the diagnosis
the gate used four times — and the drop outcome is recorded in the same failure
evidence.

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

That behaviour was first recorded here as the blast radius of DATA-CRITICAL-010.
It is now registered as three defects of its own — INFRA-CRITICAL-149 (the
stamp), ADMIN-HIGH-009 (the retry) and INFRA-HIGH-150 (the leftover schema),
above — because each has a different owner and fix, and because the fix must
handle the phantom tenants that already exist, not only prevent new ones.

## References

- Finding registry: `docs/reviews/_registry/findings.jsonl`
- Rule SSoT: `CLAUDE.md`, `docs/runbooks/migration-authoring.md`
- Related: `DATA-CRITICAL-010`, `ORPHAN-HIGH-408`, `INFRA-CRITICAL-039`

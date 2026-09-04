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

# Migrations, schema drift and data integrity — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `data-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | alert-engine/farm/billing/admin migrations, schema drift classes, outbox, blue-green |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The alert_incidents blocker is confirmed: no farm-signal incident can be created, including
critical water-quality and mortality incidents. Everything else in this domain is major or below.

## Blocker

- **B1. `alert_incidents.rule_id` (ALERT-CRITICAL-009).**
  - The DB column is `uuid NOT NULL` with an FK to alert_rules (`ON DELETE RESTRICT`) at
    `apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts:22,43`. No later
    migration changes it. The entity declares it untyped at `alert-incident.entity.ts:100` and
    says `SET NULL` at `:209`.
  - Failure path: `feeding-execution.handler.ts:91` → `feeding-execution-alert.service.ts:44,53`
    saves the history row (history.rule_id is varchar), then reaches the dedup `findOne` at
    `farm-signal-incident.service.ts:111` and fails with PG 22P02 `invalid input syntax for type
    uuid: "system:meal-underfed:<unitId>"`. The insert at `:190` is never reached.
  - Same failure for mortality (`mortality-alert.service.ts:55`), water quality
    (`water-quality-critical-alert.service.ts:60`), low stock, FCR and feed coverage.
  - Durable event types are retried until they dead-letter; the others are acked and dropped.
    Every retry writes another alert_history row because no `source_event_id` is set.
  - Second effect: `alert-rule.service.ts:192` `remove()` on a rule that has incidents fails with
    23503 (the DB says RESTRICT).
  - Why drift detection missed it: `drift-classes.ts:104-111` only catches "entity says uuid, DB
    does not", not the reverse.
  - Proposed fix: make `rule_id` nullable uuid with FK `ON DELETE SET NULL`; add a
    `system_rule_key` column with `CHECK (num_nonnulls(rule_id, system_rule_key) = 1)` and partial
    dedup indexes; give the spec a branded `AlertRuleId | SystemRuleKey` union so a free string
    cannot reach the column; ship it as an unqualified, tenant-replayed expand migration; make
    drift class B check both directions.

## Major

- **M2. FARM-CRITICAL-238 is only partly fixed.**
  - `1809800000000-CompleteFeedInventoryLedgerBackfill.ts:104-156` removes the feed-level guard
    and imports every legacy row. For feeds already in the storage ledger there is no
    ALREADY_REPRESENTED / CONFLICT classification: the double-count that `1806100000000:28-32`
    itself warned about.
  - The roll-up overwrite (`:159-175`) still keeps no record of the old value. The closure
    criteria in `farm-expert/2026-07-15-enterprise-closure-orphans.md:53-55` are not met.
  - Data risk exists only where legacy `feed_inventory` rows exist; a fresh database is
    unaffected.
- **M3. The same entity/DB type mismatch exists elsewhere.** Untyped entity columns against uuid
  DB columns at `invoice.entity.ts:124`, `payment.entity.ts:103`, `sensor.entity.ts:275,345`,
  `lora-device.entity.ts:95` and `device-io-config.entity.ts:69`. They only work while every value
  looks like a UUID.

## Minor

- `shared.access_logs` is created in two places with different indexes
  (`006-shared-schema-tables.sql:468-471` vs admin `1808100000000:74-78`); the bootstrap version
  wins.
- Two migrations backfill, then `SET NOT NULL` or `DROP COLUMN` in the same release (admin
  `1808900000000:43-69`, billing `1802100000000:94-110`). Fine for the recreate-style compose
  deploy, not for true blue-green.
- `user.entity.ts:123` says `SET NULL` while the DB FK is `RESTRICT` (`1808300000000:87`).
- `billing.subscriptions` `createdAt`/`updatedAt` are timestamps without time zone
  (`Baseline:16`).

## Checked and OK

- `DATABASE_MIGRATIONS_RUN` is `'false'` for every backend service in `docker-compose.droplet.yml`
  and `docker-compose.prod.yml`; only `db-migrate` and the provisioner set it to true. All
  services use `createSchemaVersionGate` (`schema-version-gate.service.ts:166-175,234-240`). Side
  note: `prod.yml` defaults images to `${TAG:-latest}`.
- The outbox DDL has a partial unique index on (tenantId, idempotencyKey)
  (`outbox-migration.ts:74-77`). Only auth can publish system (null-tenant) events
  (`auth-outbox.module.ts:31`), with its own null-tenant unique index (`1807700000000`). The
  publisher refuses to insert outside an active transaction.

## Registry

| ID | Result | Evidence |
| --- | ------ | -------- |
| ALERT-CRITICAL-009 | CONFIRMED | Blocker B1 |
| ORPHAN-CRITICAL-516 | STALE: fixed in code, registry still says OPEN | `tests/invariants/lib/migration-corpus.ts`; auth `1808300000000`; admin `1808100000000`; the FK and access-log specs now use the shared migration list. `rls-predicate-canonical.spec.ts:97` still reads `.archive/`, but that only makes it stricter |
| ORPHAN-CRITICAL-517 | STALE: fixed in code | Generator `audit-immutability.sql.ts:87-128` makes DELETE conditional on legalHold; applied by admin `1808200000000`, auth `1808400000000`, farm `1808500000000`; `shared.audit_logs` has `legalHold` (`006:127`) |
| FARM-CRITICAL-238 | CONFIRMED, still open | Major M2 |

## Not verified

- Live production ledger state, including whether 180610 or 180980 has already run; `Closes:`
  trailers on the fix commits; whether Phase-A receipts wrote to both ledgers, which decides how
  big the double-count is; test execution; full column-by-column parity for farm entities.

## Registry entries

This review appended 5 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| DATA-HIGH-022 | HIGH | Schema-drift detection is one-directional: drift class B flags an entity that says uuid against a non-uuid column but not an untyped entity column against a uuid column, which let alert\_incidents.rule\_id ship and leaves the same mismatch on invoice, payment, sensor, lora-device and device-io-config columns |
| FARM-HIGH-363 | HIGH | The feed-ledger completion migration 1809800000000 drops the feed-level guard and imports every legacy feed\_inventory row, so feeds already represented in the storage ledger are added again and feeds.quantity is inflated; nothing classifies ALREADY\_REPRESENTED or CONFLICT, the roll-up overwrite records no provenance, and postCondition checks presence not balances |
| ALERT-MEDIUM-018 | MEDIUM | Deleting an alert rule that has incidents fails with PG 23503 because the database FK is ON DELETE RESTRICT while the entity declares SET NULL |
| DATA-MEDIUM-023 | MEDIUM | Two migrations backfill and then SET NOT NULL or DROP COLUMN in the same release (admin 1808900000000-ProtectAdminLedgers, billing 1802100000000-AddPlanChangeOperationSaga), which is fine for the recreate-style compose deploy but violates the nullable, backfill, NOT NULL blue-green sequence |
| DATA-LOW-024 | LOW | Schema hygiene: shared.access\_logs is created in two places with different indexes (bootstrap wins), user.entity.ts declares SET NULL while the DB FK is RESTRICT, and billing.subscriptions createdAt/updatedAt are timestamps without time zone |

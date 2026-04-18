---
name: pre-migration-restore-test
description: Before any destructive migration to production, validate the most recent backup by restoring it + running schema + row-count + sentinel-query assertions. Never-restored-backup = CRITICAL per infra-expert.
type: skill
version: 1
owners: infra-expert, data-expert, database-reviewer
handoff:
  on_complete_invoke: [infra-expert, data-expert]
  on_security_touch: null
  on_event_impact: null
  on_multi_tenant_touch: null
---

# Skill — Pre-Migration Restore Test

## When to invoke

Before ANY of the following reaches production:

- Destructive migration (`DROP COLUMN`, `DROP TABLE`, `TRUNCATE`, narrowing `ALTER COLUMN TYPE`, defaults that rewrite existing rows).
- First-time migration on a large (>1M row) table.
- Migration that touches a table with active compliance / audit retention (`audit_logs`, `gdpr_data_requests`, etc.).
- Any migration where `data-expert`'s review flagged `RequiresRestoreTest: true`.

This skill is the answer to the infra-expert invariant: "Scheduled restore-test job asserting schema + row count + sentinel query on the latest backup; never-restored-backup = CRITICAL."

## Prerequisites

- Backup artefact exists in `gs://<bucket>/backups/<YYYY-MM-DD>/postgres-<timestamp>.dump` (or equivalent) from the last ≤24h.
- `scripts/backup/backup-databases.sh` has a matching manifest entry in `.github/manifests/backup-script.sha256` per INFRA-1 hash-pinning invariant.
- A staging PG instance is provisioned with capacity ≥1.2× the prod dump size.
- The caller has read-only access to the backup bucket + write access to the staging PG.

## Cascade

### Step 1 — Verify the backup artefact integrity

**Affected files:** (no edits; verification only).

**Mechanism:**
```bash
# Download the most recent backup
BACKUP_URL=gs://<bucket>/backups/$(date -u -d yesterday +%Y-%m-%d)/postgres-latest.dump
gcloud storage cp $BACKUP_URL /tmp/dump.pgdump

# SHA-256 verify against manifest
sha256sum /tmp/dump.pgdump
# Cross-check against .github/manifests/backup-artefact.sha256 for the same date
```

**Why:** a silently corrupted backup is worse than no backup — it gives false confidence. The manifest pair-change rule (INFRA-1, commit `71474fbf`) ensures the backup script + manifest change together; the artefact's checksum must match the producing script's expected output hash.

**Verification:** checksum matches; `pg_restore --list /tmp/dump.pgdump | head -50` returns a valid table-of-contents without errors.

**Cross-domain notifications:** `infra-expert` primary (backup integrity); `security-reviewer` (supply-chain on the dump artefact).

### Step 2 — Restore to staging

**Affected files:** (no edits; ephemeral staging DB).

**Mechanism:**
```bash
# Drop-and-recreate staging DB
psql -h staging-db -U postgres -c "DROP DATABASE IF EXISTS restore_test;"
psql -h staging-db -U postgres -c "CREATE DATABASE restore_test;"

# Parallel restore for speed
pg_restore --jobs=8 --dbname=restore_test --verbose /tmp/dump.pgdump 2>&1 | tee /tmp/restore.log
```

**Why:** `--jobs=N` uses `N` parallel workers (PG 9.3+) — a 50GB prod dump restores in minutes instead of hours. `--verbose` captures every table restore status for forensic review.

**Verification:** restore exits 0; `grep -c "error:" /tmp/restore.log` returns 0; `grep -c "pg_restore: restored" /tmp/restore.log` matches the original dump's object count from Step 1.

**Cross-domain notifications:** `infra-expert` (staging DB capacity); `data-expert` (migration sequencing — if the dump predates recent migrations, Step 3 catches drift).

### Step 3 — Schema assertion — staging matches prod

**Affected files:** `scripts/backup/verify-schema.ts` (restore-test helper).

**Mechanism:** compare the restored schema against expected prod schema via per-schema table lists:

```sql
-- For each schema in MODULE_SCHEMAS + shared + public + tenant_*:
SELECT COUNT(*) AS tables FROM information_schema.tables
WHERE table_schema = '<schema>';

-- For each tenant schema:
SELECT COUNT(*) AS tables FROM information_schema.tables
WHERE table_schema LIKE 'tenant_%';
```

Assert table counts match within tolerance (∆≤1 allowed for pending migration; ∆>1 = FAIL with table-diff output).

**Why:** schema drift between backup and prod is a silent corruption vector — Step 3 catches it BEFORE the migration goes live. The ≤1 tolerance allows for an in-flight migration landing between backup capture and restore — larger drift invalidates the restore as the baseline.

**Verification:** `verify-schema.ts` exits 0; table-count delta ≤1 per schema.

**Cross-domain notifications:** `database-reviewer` (schema-state discrepancies); `data-expert` (migration-delta alignment).

### Step 4 — Row-count assertion — sentinel per tenant + global

**Affected files:** same helper.

**Mechanism:** for a representative sample of tenant schemas + every shared table:

```sql
-- Sentinel: row count + MD5 sum of a deterministic column set
SELECT COUNT(*), md5(string_agg(id::text, ',' ORDER BY id)) AS checksum
FROM <schema>.<table>;
```

Compare against the equivalent query against prod (or the prior verified restore-test baseline). Assert counts within ±0.5% + checksum matches.

**Why:** row counts alone can drift silently due to normal writes between backup capture and restore. The checksum over `id` list (ordered) is a stricter invariant: same row set = same checksum. Larger-than-expected drift indicates either (a) aggressive write activity against the sampled window (investigate), or (b) restore corruption (fail).

**Verification:** all sentinel rows + checksums match within tolerance.

**Cross-domain notifications:** `data-expert` (row-count anomaly investigation).

### Step 5 — Run the pending migration against staging

**Affected files:** `apps/<svc>/src/database/migrations/<pending>.ts` applied to the restored DB.

**Mechanism:**
```bash
# Run migration runner against restore_test DB
DATABASE_URL=postgres://<staging>/restore_test \
  npm run migration:run -- --service=<svc>
```

Capture the FULL migration output including every DDL statement + its duration + any warnings.

**Why:** this is the actual validation — run the exact migration against data that matches prod. If the migration fails here, it would fail in prod. If it takes 10× longer than expected, the prod window needs re-planning.

**Verification:** migration exits 0; no CRITICAL warnings (e.g. `ACCESS EXCLUSIVE` lock hold > 10s on a billing table). Post-migration `verify-schema.ts` re-run confirms the expected new shape.

**Cross-domain notifications:** `data-expert` (migration safety primary); `infra-expert` (lock-hold duration exceeds deploy window SLA).

### Step 6 — Sentinel queries — representative prod workload on migrated data

**Affected files:** `scripts/backup/verify-queries.sql` (a curated set of representative production queries).

**Mechanism:** run the top-20 most-expensive production queries (captured from `pg_stat_statements` earlier) against the migrated staging DB. Measure latency + result correctness against a known-good baseline.

**Why:** a migration can technically succeed + catastrophically change query plans. Representative-query coverage catches plan regressions before they become production latency incidents.

**Verification:** p99 latency regression <20% vs baseline; result set differences explained (e.g. new row due to seed data is OK; missing row is FAIL).

**Cross-domain notifications:** `performance-expert` (regressions); `observability-expert` (baseline capture from prod-stat_statements).

### Step 7 — Restore-test record + go/no-go

**Affected files:** `docs/reviews/infra-expert/{YYYY-MM-DD}-restore-test-{migration-slug}.md`.

**Mechanism:** infra-expert generates a restore-test report with every assertion's PASS/FAIL + numerical deltas + sentinel-query timings + migration duration + a go/no-go recommendation. Report is REQUIRED before the migration reaches prod — no report = no deploy (policy-enforced by the deploy workflow).

**Why:** audit trail for compliance (SOC 2 CC7.2 change-management); forensic reference if a post-deploy issue arises.

**Verification:** report lands; go/no-go recommendation signed by infra-expert; deploy workflow blocks if the report is missing or no-go.

**Cross-domain notifications:** `context-manager` (finding-state update if report closes a staleness concern); `architectural-arbiter` on NO-GO to decide next steps.

## Validation checklist

- [ ] Step 1 backup checksum matches manifest.
- [ ] Step 2 restore exits 0 with 0 errors in log.
- [ ] Step 3 schema table count ∆≤1 per schema.
- [ ] Step 4 sentinel row-count + checksum match within tolerance.
- [ ] Step 5 migration runs green against restored DB; lock-hold duration within SLA.
- [ ] Step 6 representative-query regression <20% p99.
- [ ] Step 7 restore-test report exists + signed by infra-expert.

## Examples

- `71474fbf` — INFRA-1 backup-script manifest pair-change (prerequisite for this skill's Step 1).
- No recent restore-test reports exist yet — this skill + the scheduled restore-test job (`infrastructure/scripts/restore-test.yml` — TO BE WRITTEN) are the mechanism to start the practice.

## Cross-references

- ADR-016 — Deploy resilience architecture (this skill is under that umbrella).
- `.claude/agents/infra-expert.md` — DR / resilience invariants (never-restored-backup CRITICAL).
- `.claude/agents/data-expert.md` — destructive-migration 4-requirement gate (rollback migration, documented backup, ops stage-gate, VACUUM FULL ack).
- `.github/workflows/backup-production.yml` — backup workflow.
- `.github/manifests/backup-script.sha256` — INFRA-1 hash-chain.

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable.

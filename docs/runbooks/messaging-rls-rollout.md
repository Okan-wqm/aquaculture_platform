# Runbook: Messaging RLS Rollout

**Owner:** platform team
**Related ADR:** ADR-013 (Messaging Service Isolation Convergence)
**Plan reference:** `/root/.claude/plans/polished-brewing-knuth.md`

## Purpose

This runbook executes the production deploy of the messaging-isolation
plan. It is **destructive** at P6 (data consolidation) and requires
strict ordering between P6 → P7 → P11 verification.

## Pre-deploy checklist

Confirm ALL of the following before starting:

- [ ] **Pre-flight audit reviewed** (`docs/plans/2026-04-14-messaging-isolation/pre-flight-audit.md`)
- [ ] **Handler audit gaps closed** — CRITICAL-MSG-002 + CRITICAL-MSG-003
      (embedding + knowledge-extraction cron BypassRls wraps) MUST be
      merged BEFORE this runbook executes. Otherwise AI features
      silently break for all tenants.
- [ ] **Staging end-to-end completed** — full sequence P0-P11 ran on
      staging, e2e suite green, observed for ≥72h with zero RLS
      bootstrap failures
- [ ] **Production snapshot** — `pg_dump` to encrypted S3 with 72h
      retention. Verify restore works on a scratch RDS instance.
- [ ] **Maintenance window scheduled** — recommended low-traffic 30min
      window. Notify #ops + #eng channels.
- [ ] **Runbook owner identified** — single operator drives the
      sequence; pair-buddy reviews each step.
- [ ] **Rollback procedure rehearsed** — operator can execute
      pg_dump restore + rolling restart within 15min.

## Execution sequence

### Step 1 — Land pre-existing commits (already merged on main)

By the time this runbook executes, commits below should already be on
`main` and have passed CI:

```
d93cc6a4  fix(messaging): quote ORDER BY alias
c156d8cb  chore(messaging): wire createMigrationRunnerService
af9516e3  feat(messaging,rls): tenantId on 7 child tables (P3 migration)
e88f132f  feat(messaging,rls): install tenant_isolation_policy (P4 migration)
205f93a8  chore(messaging,rls): sync RlsModule excludeTables
08db0f7b  feat(messaging,rls): write P6 data-consolidation (GATED)
f11491d2  feat(messaging,schema): decorate 17 entities
e94e1368  test(schema-invariants): 17 messaging tables
dbe56377  docs(messaging,rls): P10 handler audit
```

If P6 has not yet been registered (commit 08db0f7b ships migration as
NOT auto-run), proceed to Step 2. If P6 was registered prematurely,
revert that registration before continuing.

### Step 2 — pg_dump snapshot

```bash
docker exec aqua-postgres pg_dump \
  -U postgres \
  -d aquaculture \
  --schema=messaging \
  --schema='tenant_*' \
  --format=custom \
  --file=/tmp/messaging-pre-rollout-$(date +%Y%m%d-%H%M).dump

# Copy to encrypted S3
aws s3 cp /tmp/messaging-pre-rollout-*.dump \
  s3://aqua-backups-prod/messaging-rollout/ \
  --sse aws:kms \
  --sse-kms-key-id alias/aqua-backups
```

Verify backup is recoverable on scratch RDS instance BEFORE proceeding.

### Step 3 — Pre-execution row counts (assertion baseline)

Capture row counts so post-migration validation has a reference:

```sql
-- Per-tenant counts
WITH t AS (
  SELECT schema_name FROM information_schema.schemata
  WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
)
SELECT
  t.schema_name,
  (SELECT count(*) FROM messaging.channels WHERE 1=0) AS placeholder
FROM t;

-- Save these counts to a file:
-- pre-rollout-row-counts-$(date +%Y%m%d-%H%M).csv
```

### Step 4 — Register P6 migration

Edit `apps/messaging-service/src/app.module.ts` to add the import +
migrations[] entry for `ConsolidateTenantSchemaData1782500000000`.

```typescript
import { ConsolidateTenantSchemaData1782500000000 } from
  './migrations/1782500000000-ConsolidateTenantSchemaData';
// ...
migrations: [
  ...existing,
  ConsolidateTenantSchemaData1782500000000,
],
```

Commit on a release branch:

```bash
git checkout -b release/messaging-rls-rollout
git commit -am "rollout: register P6 ConsolidateTenantSchemaData"
```

DO NOT push to main yet — register is gated on operator verification.

### Step 5 — Deploy to a single canary replica (if available)

If infrastructure supports canary deploys:

```bash
helm upgrade messaging-service ./charts/messaging-service \
  --set image.tag=release-messaging-rls-rollout \
  --set canary.enabled=true \
  --set canary.weight=10
```

Watch for ~10min:
- Logs: zero `rls.bootstrap.failed` entries
- Logs: `MessagingMigrationRunnerService[messaging]` reports
  `Migration "ConsolidateTenantSchemaData1782500000000" applied successfully`
- Metrics: query latency on messaging endpoints unchanged
- Alerts: no Sentry / Grafana alerts firing

If anything off, abort + restore from snapshot.

### Step 6 — Full production rollout

```bash
helm upgrade messaging-service ./charts/messaging-service \
  --set image.tag=release-messaging-rls-rollout \
  --set canary.enabled=false
```

Pods rolling restart. Migration runs on the FIRST pod that boots
post-deploy (others wait via TypeORM's lock on `migrations` table).

### Step 7 — Post-execution validation

Run the same row-count query as Step 3, plus:

```sql
-- Verify all 17 messaging tables have policies
SELECT tablename FROM pg_policies
WHERE schemaname = 'messaging' AND policyname = 'tenant_isolation_policy'
ORDER BY tablename;
-- Expect: 16 tables (excluding messaging_outbox + embeddings_metadata)

-- Verify FORCE ROW LEVEL SECURITY is on
SELECT relname FROM pg_class
WHERE relnamespace = 'messaging'::regnamespace
  AND relrowsecurity = true
  AND relforcerowsecurity = true
ORDER BY relname;

-- Cross-tenant leak test (must return 0 rows for tenant B's session)
SET app.current_tenant = '<tenant_a_uuid>';
INSERT INTO messaging.channels (id, tenantId, name, ...)
  VALUES (gen_random_uuid(), '<tenant_a_uuid>', 'leak-test', ...);
SET app.current_tenant = '<tenant_b_uuid>';
SELECT count(*) FROM messaging.channels WHERE name = 'leak-test';
-- Expect: 0
```

### Step 8 — Monitor for 24h

Watch dashboards for:
- `rls.bootstrap.failed` log substring (Grafana alert)
- `schema.drift.detected` log substring (Grafana alert)
- Messaging endpoint p99 latency (should be unchanged ±5%)
- AI feature health: embedding jobs producing rows, knowledge
  extraction returning data (verifies F1/F2 fixes are working)

### Step 9 (optional, weeks later) — P9 cleanup

After 14+ days of stable operation:

```sql
-- Run inside a maintenance window with operator review
DO $$
DECLARE tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
  LOOP
    -- Drop only messaging-specific tables; preserve tenant schema
    -- for other services (farm, sensor, hr, etc.)
    EXECUTE format('DROP TABLE IF EXISTS %I.channels CASCADE', tenant_schema);
    EXECUTE format('DROP TABLE IF EXISTS %I.channel_members CASCADE', tenant_schema);
    -- ... repeat for all 17 messaging tables
  END LOOP;
END $$;
```

Skip if uncertainty remains. Defense-in-depth has zero downside; the
clones cost only disk + catalog metadata.

## Rollback procedures

### Rollback after Step 4 (registered P6 not yet executed)

```bash
git revert <register-commit>
git push
# CI deploys; previous app.module.ts wins; P6 not run
```

### Rollback after Step 6 (P6 executed, data consolidated)

P6 is **irreversible without snapshot restore**. Procedure:

1. Stop messaging-service pods: `kubectl scale deploy messaging-service --replicas=0`
2. Restore messaging schema + tenant schemas from snapshot:
   ```bash
   pg_restore -U postgres -d aquaculture --clean --schema=messaging \
     --schema='tenant_*' /tmp/messaging-pre-rollout-*.dump
   ```
3. Revert app.module.ts to remove P6 + P7 (entity decoration must
   also revert, otherwise queries hit empty messaging.* after restore):
   ```bash
   git revert <p7-commit> <register-commit>
   git push
   ```
4. Scale messaging-service back: `kubectl scale deploy messaging-service --replicas=N`
5. Verify queries return data: `SELECT count(*) FROM messaging.channels`

Estimated recovery: 15-30min.

## Failure modes and responses

| Symptom | Likely cause | Response |
|---|---|---|
| `column "channel_lastmessageat" does not exist` | P1 commit not on the deployed branch | Verify d93cc6a4 in deploy SHA |
| `relation "messaging.channels" does not exist` | P0/P2 migrations didn't run | Check `MessagingMigrationRunnerService[messaging]` logs; if empty, verify DATABASE_MIGRATIONS_RUN env var |
| Many `tenant_isolation_policy violation` errors | RlsConnectionBootstrap not firing | Check ALS context populated by TenantContextMiddleware; check provider order in app.module.ts |
| Embedding cron logs show "0 messages processed" | F1 BypassRls not wrapped (CRITICAL-MSG-002 unfixed) | Roll back canary; ship F1 fix; redeploy |
| Knowledge-extraction same | F2 BypassRls (CRITICAL-MSG-003) | Same as above |
| Tenant A sees Tenant B's channels | RLS not active on the queried table | Check `pg_policies` for policy presence; check `pg_class.relrowsecurity` |

## References

- ADR-013 (Messaging Service Isolation Convergence)
- Plan: `/root/.claude/plans/polished-brewing-knuth.md`
- Pre-flight audit: `docs/plans/2026-04-14-messaging-isolation/pre-flight-audit.md`
- Handler audit: `docs/plans/2026-04-14-messaging-isolation/p10-handler-audit.md`
- Schema drift response: `docs/runbooks/schema-drift-response.md`
- Post-deploy pool recycle: `docs/runbooks/post-deploy-pool-recycle.md`

# Faz 6 Cutover Window Runbook — Day-One Baseline Reset Execution

**Status:** Operator-driven runbook for Faz 6 of the day-one baseline reset.
**Audience:** Single operator with production droplet access.
**Plan reference:** `/root/.claude/plans/peppy-crafting-waterfall.md`.
**ADR reference:** `docs/adr/030-day-one-baseline-reset.md`.

## ⚠️ One-Way Door Notice

This runbook **wipes every pre-existing tenant** (SUPER_ADMIN excluded).
The only rollback path is the Faz 0 `pg_dump --schema-only --data-only`
snapshot, retained for 7 days then deleted (GDPR Art 5(1)(e) storage
limitation, ADR-030 §"Negative" consequences).

The MFA encryption key + password pepper MUST be vaulted in Faz 0. Their
loss = SUPER_ADMIN permanent lockout. KMS rotation during the cutover
window is FORBIDDEN.

**Estimated downtime:** 15–30 minutes.

## Pre-flight checklist — execute in order, all items GREEN before proceeding

### Branch + CI state

- [ ] `migration` branch CI yeşil for the 8 source-level invariants:
      protected-tables-guard, no-savepoint-in-migrations,
      rls-predicate-canonical, entity-schema-declaration,
      entity-diff-implies-migration, tenant-fanout-entity-parity,
      shared-schema-canonical, drift-repair-naming.
- [ ] `migration` PR (#288) approved by CODEOWNERS — database-reviewer
      + infra-expert dual review.
- [ ] Pre-existing CI fails resolved or explicitly classified as
      out-of-scope (lint web/shell, security-audit dependabot,
      E2E baseline — all tracked in OPEN-ADR-030-3).
- [ ] `git tag pre-baseline-2026-05-XX` set on the current production
      `main` HEAD (rollback reference).

### Vault state (Faz 0 completion)

- [ ] SUPER_ADMIN row snapshot in vault (`auth.users` filtered to
      `role=SUPER_ADMIN`).
- [ ] `mfaSecret`, `mfaRecoveryCodes`, `mfaEnabled` JSON snapshot from
      the SUPER_ADMIN row.
- [ ] `MFA_ENCRYPTION_KEY` env value vaulted.
- [ ] `PASSWORD_PEPPER` env value vaulted.
- [ ] `JWT_PRIVATE_KEY` (RS256) + `JWT_PUBLIC_KEY` vaulted.
- [ ] `INTERNAL_SERVICE_SECRET` vaulted.
- [ ] **KMS rotation lock active** for the cutover window.

### Stripe quiesce (Faz 0 completion — only if `STRIPE_API_KEY=sk_live_*`)

- [ ] All active Stripe Subscriptions cancelled (`cancel_at_period_end=false, prorate=false`).
- [ ] All open Stripe invoices voided.
- [ ] Stripe webhook endpoint disabled in Stripe Dashboard.
- [ ] Stripe Customers archived with `metadata.platform_reset=YYYY-MM-DD`.
- [ ] If `STRIPE_API_KEY=sk_test_*` — this section is no-op, skip.

### Production droplet state

- [ ] `docker-compose.droplet.yml` env shows `DATABASE_MIGRATIONS_RUN=false`
      for every backend service (Faz 1.5 ADR-021 production discipline).
- [ ] `aqua-db-migrate` container image rebuilt against the `migration`
      branch HEAD (will run the baseline migrations).
- [ ] Faz 0 `pg_dump --schema-only --data-only` snapshot taken,
      stored off-droplet (S3/MinIO + local), checksum verified.

## Cutover sequence (execute in order, no skipping)

### 1. Services down

```bash
ssh root@<droplet>
cd /var/aqua-saas
docker compose -f docker-compose.droplet.yml stop \
  gateway-api auth-service farm-service sensor-service hr-service \
  messaging-service billing-service admin-api-service notification-service \
  ai-service alert-engine hydroponics-service config-service \
  event-store-service observability-service
# leave postgres + aqua-db-migrate up
docker compose -f docker-compose.droplet.yml ps
```

Verify: only `postgres` (+ `aqua-db-migrate` idle) running.

### 2. Stripe live-key guard

```bash
echo "$STRIPE_API_KEY" | grep -q "^sk_live_" && {
  [ "$DAY_ONE_RESET_CONFIRM" = "I_UNDERSTAND_LIVE_KEYS" ] || \
    { echo "ABORT: sk_live_ without DAY_ONE_RESET_CONFIRM"; exit 1; }
}
```

### 3. Object storage purge

```bash
# MinIO buckets — assumes mc alias is configured
mc rm --recursive --force minio/messaging-attachments
mc rm --recursive --force minio/ai-uploads
mc rm --recursive --force minio/thumbnails
mc rm --recursive --force minio/farm-documents
mc rm --recursive --force minio/batch-attachments
```

### 4. NATS JetStream purge

```bash
# Stream-by-stream purge + durable consumer reset
for stream in MESSAGING_EVENTS AI_EVENTS FARM_EVENTS SENSOR_EVENTS \
              HR_EVENTS ALERT_EVENTS BILLING_EVENTS; do
  nats stream purge "$stream" --force 2>/dev/null || echo "stream $stream missing"
done
```

### 5. Redis FLUSHDB

```bash
redis-cli -h <redis-host> -a "$REDIS_PASSWORD" FLUSHDB
```

### 6. OPA reset (if OPA sidecar is running)

```bash
curl -X DELETE "http://opa:8181/v1/data/tenants"
# OPA reset cache (service restart later restores from clean policy bundle)
```

### 7. Postgres schema drop (TIER ORDER)

```bash
PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture <<'SQL'

-- TIER 1: leaf — per-tenant schemas
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM information_schema.schemata
           WHERE schema_name ~ '^tenant_[a-f0-9]{16}$' LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', r.schema_name);
  END LOOP;
END
$$;

-- TIER 2: consumer / utility (no inter-tier FKs)
DROP SCHEMA IF EXISTS ai            CASCADE;
DROP SCHEMA IF EXISTS alert         CASCADE;
DROP SCHEMA IF EXISTS notification  CASCADE;
DROP SCHEMA IF EXISTS billing       CASCADE;
DROP SCHEMA IF EXISTS observability CASCADE;
DROP SCHEMA IF EXISTS event_store   CASCADE;
DROP SCHEMA IF EXISTS config        CASCADE;
DROP SCHEMA IF EXISTS admin         CASCADE;

-- TIER 3: domain (tenant-scoped source schemas)
DROP SCHEMA IF EXISTS messaging   CASCADE;
DROP SCHEMA IF EXISTS hr          CASCADE;
DROP SCHEMA IF EXISTS hydroponics CASCADE;
DROP SCHEMA IF EXISTS farm        CASCADE;
DROP SCHEMA IF EXISTS sensor      CASCADE;

-- TIER 4: shared (FK target for many; drop after consumers)
DROP SCHEMA IF EXISTS shared CASCADE;

-- TIER 5: gateway reserved (no cross-FKs)
DROP SCHEMA IF EXISTS gateway CASCADE;

-- TIER 6: auth (trust root — last)
DROP SCHEMA IF EXISTS auth CASCADE;

-- public is left intact (extension owner)

\dn
SQL
```

Expected output: only `public` + system schemas remain.

### 8. Init scripts re-run

```bash
# Re-run the platform init scripts via psql
PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -f infrastructure/docker/init-scripts/00-init-schemas.sh   # the sh exits sqls via heredoc

PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -f infrastructure/docker/init-scripts/01-init-databases.sql

PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -f infrastructure/docker/init-scripts/05-platform-functions.sql

PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -f infrastructure/docker/init-scripts/09-hr-outbox.sql

PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -f infrastructure/docker/init-scripts/10-shared-schema.sql
```

Verify:
- `\dn` → 14 service schemas + `shared` + `gateway` present.
- `\du` → 14 service roles present (cluster-level, never dropped).
- `\df public.*` → `current_tenant_id`, `set_tenant_id`, `update_updated_at_column` present.
- `\dx` → `timescaledb`, `uuid-ossp`, `pg_trgm`, `btree_gist`, `pgcrypto`, `vector`.

### 9. Baseline migration run (aqua-db-migrate container)

Pre-condition: baseline migration files committed to `migration` branch
(per `docs/runbooks/baseline-migration-generation.md`). The
`aqua-db-migrate` image MUST be built from that branch HEAD.

```bash
docker compose -f docker-compose.droplet.yml up --no-deps aqua-db-migrate
# expect exit 0 + boot signal "db_migrate_complete"
docker compose -f docker-compose.droplet.yml logs --tail=50 aqua-db-migrate
```

Verify ledger state:

```bash
PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture <<'SQL'
SELECT 'auth' AS schema, MAX(timestamp) FROM auth.migrations
UNION ALL SELECT 'billing', MAX(timestamp) FROM billing.migrations
UNION ALL SELECT 'admin', MAX(timestamp) FROM admin.migrations
UNION ALL SELECT 'notification', MAX(timestamp) FROM notification.migrations
UNION ALL SELECT 'event_store', MAX(timestamp) FROM event_store.migrations
UNION ALL SELECT 'observability', MAX(timestamp) FROM observability.migrations
UNION ALL SELECT 'config', MAX(timestamp) FROM config.migrations
UNION ALL SELECT 'farm', MAX(timestamp) FROM farm.migrations
UNION ALL SELECT 'sensor', MAX(timestamp) FROM sensor.migrations
UNION ALL SELECT 'hr', MAX(timestamp) FROM hr.migrations
UNION ALL SELECT 'messaging', MAX(timestamp) FROM messaging.migrations
UNION ALL SELECT 'hydroponics', MAX(timestamp) FROM hydroponics.migrations
UNION ALL SELECT 'ai', MAX(timestamp) FROM ai.migrations
UNION ALL SELECT 'alert', MAX(timestamp) FROM alert.migrations;
SQL
```

All 14 schemas show `1800000000000` (or higher post-Faz-6 feature migrations).

### 10. SUPER_ADMIN restore

```bash
# Restore the SUPER_ADMIN row + MFA secret from the Faz 0 vault snapshot.
# The SeedService in auth-service handles user + module bootstrap on next
# start; only the MFA-encrypted fields need manual restoration.

PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture <<SQL
UPDATE auth.users
   SET "mfaSecret" = '$VAULTED_MFA_SECRET',
       "mfaRecoveryCodes" = '$VAULTED_MFA_RECOVERY',
       "mfaEnabled" = $VAULTED_MFA_ENABLED
 WHERE email = '$SUPER_ADMIN_EMAIL';
SQL
```

(Use the `SeedService.restoreSuperAdminMfaFromSnapshot()` method once
implemented; pre-implementation, the psql UPDATE above is the manual
fallback.)

### 11. Reference data seed (auto on service boot)

- `auth.modules` — 12 default modules (SeedService onModuleInit)
- `billing.plans` — 3 default plans (PlanSeedService onModuleInit) with
  fresh `stripePriceId` minted in Stripe Dashboard pre-cutover
- `farm.equipment_types` — 29 rows (baseline migration seed step)

### 12. Observability state reset (optional — test env)

```bash
# Prometheus tombstone — purge tenant-tagged series
curl -X POST 'http://prometheus:9090/api/v1/admin/tsdb/delete_series?match[]={tenant_id=~".+"}'
curl -X POST 'http://prometheus:9090/api/v1/admin/tsdb/clean_tombstones'

# Loki retention reset (skip — test env, no real PII concern)
```

### 13. Services up

```bash
docker compose -f docker-compose.droplet.yml up -d
docker compose -f docker-compose.droplet.yml ps   # all services healthy
```

Wait ~60s for all `OnApplicationBootstrap` hooks to complete.

## Smoke test sequence (post-cutover)

Each must pass before declaring the cutover successful.

### SUPER_ADMIN login

```bash
curl -X POST 'http://<gateway>/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"email":"'$SUPER_ADMIN_EMAIL'","password":"'$SUPER_ADMIN_PASSWORD'","mfaCode":"'$MFA_CODE'"}'
# expect 200 + access_token
```

### Health probe — every service 200

```bash
for svc in gateway-api auth-service farm-service sensor-service hr-service \
           messaging-service billing-service admin-api-service \
           notification-service ai-service alert-engine hydroponics-service \
           config-service event-store-service observability-service; do
  echo -n "$svc: "
  curl -s -o /dev/null -w '%{http_code}\n' "http://$svc:<port>/health"
done
```

### Required boot signals

```bash
scripts/deploy/assert-service-signals.ts
# expects: db_migrate_complete + schema_drift_clean + 14× ledger probe
```

### First tenant create

```bash
curl -X POST 'http://<gateway>/admin/tenants' \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN" \
  -d '{"name":"smoke-test-tenant","modules":["farm","sensor","hr"]}'
# expect 201 + tenantId
```

Verify in psql:
- `auth.tenants` has 1 row
- `auth.tenant_modules` has rows for selected modules
- `information_schema.schemata` shows new `tenant_<uuid>` schema
- `\dt tenant_<uuid>.*` shows ~80–90 tables (farm + sensor + hr + edge v2 entities cloned)

### Per-tenant CRUD smoke

```bash
curl -X POST 'http://<gateway>/farm/batches' \
  -H "Authorization: Bearer $TENANT_ADMIN_TOKEN" \
  -d '{"name":"smoke-batch","speciesId":"..."}'
# expect 201 with row in tenant_<uuid>.batches; source farm.batches still empty
```

### Immutability probe (manual)

```bash
PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U postgres -d aquaculture \
  -c "UPDATE shared.audit_logs SET action='tampered' WHERE id IS NOT NULL LIMIT 1"
# expect ERROR: audit_logs UPDATE refused by trigger trg_audit_logs_prevent_update
```

### CI gate probe (post-cutover)

In a development clone:

```bash
nx test invariants -- --testPathPattern='protected-tables-guard|drift-repair-naming|tenant-fanout|rls-predicate'
# all green
```

## Merge `migration` → `main`

Once every smoke test is green:

```bash
gh pr merge 288 --merge --delete-branch=false
```

`--delete-branch=false` preserves the `migration` branch as the rollback
reference until the 7-day post-reset window closes.

## Post-cutover monitoring (Faz 8 — 30/60/90 days)

Tracked by ADR-030 §"Open Items". Operator schedules monitoring:

- **+24h:** verify `schema_drift_clean` boot signal stays clean across
  service restarts; investigate any drift class K (foreign_key_presence)
  violations and decide whether to elevate `SCHEMA_DRIFT_VALIDATE_FK` to
  default-on.
- **+7d:** delete the Faz 0 `pg_dump` snapshot per GDPR Art 5(1)(e).
- **+30d:** zero new `Align*` / `Heal*` / `Repair*` / `Replay*` /
  `Reconcile*` / `Sync*` prefix migrations should have been authored.
  If any did, root-cause the upstream gate gap (entity-diff-witness or
  tenant-fanout-entity-parity miss).
- **+60d:** SchemaVersionGate strict-mode probe should have caught zero
  ledger/DDL divergences. Any incident = post-condition probe revision.
- **+90d:** lockfile-based entity-fingerprint manifest (OPEN-ADR-030-1)
  generated against the now-stable entity surface; CI gate enabled.

## Rollback (if smoke fails)

```bash
# Services down
docker compose -f docker-compose.droplet.yml stop $(...services...)

# Postgres restore from Faz 0 snapshot
PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h postgres -U postgres -d aquaculture \
  -c /vault/pre-baseline-2026-05-XX.dump

# Revert deploy
git checkout pre-baseline-2026-05-XX
docker compose -f docker-compose.droplet.yml up -d
```

Trigger a post-mortem; reset the cutover schedule. The 7-day window
allows ONE re-attempt; beyond it the snapshot is deleted.

## Sign-off

- [ ] Pre-flight checklist all GREEN
- [ ] Faz 0 vault snapshot verified by operator + secondary witness
- [ ] Cutover sequence (Steps 1–13) executed without skip
- [ ] Smoke tests (all 7) GREEN
- [ ] Faz 8 monitoring calendar set (24h / 7d / 30d / 60d / 90d)
- [ ] PR #288 merged with `--delete-branch=false`
- [ ] `git tag baseline-2026-05-XX` set on the new `main` HEAD
- [ ] SUPER_ADMIN credential rotation scheduled (next 24h — vault
      snapshot is now redundant once a new MFA enrolment lands)

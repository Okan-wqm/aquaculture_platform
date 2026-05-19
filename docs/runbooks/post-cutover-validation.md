# Post-Cutover Validation Runbook — Day-One Baseline Reset

**Audience:** Operator immediately after `Deploy to DigitalOcean` workflow completes.
**Plan reference:** `/root/.claude/plans/peppy-crafting-waterfall.md` Faz 6 + Faz 8.

## TL;DR

```bash
# 1. Smoke — login + health
curl -s http://localhost:3000/health | jq .

# 2. Release ledger — expected/applied heads match
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT release_id, git_sha, status,
       expected_heads = applied_heads AS heads_match,
       jsonb_array_length(tenant_schema_set) AS tenant_schema_count
  FROM platform.release_ledger
 ORDER BY updated_at DESC
 LIMIT 1;"

# 3. Canonical source ledgers
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT 'auth' AS s, MAX(timestamp) FROM auth.migrations
UNION ALL SELECT 'farm', MAX(timestamp) FROM farm.migrations
UNION ALL SELECT 'sensor', MAX(timestamp) FROM sensor.migrations
UNION ALL SELECT 'billing', MAX(timestamp) FROM billing.migrations
UNION ALL SELECT 'hr', MAX(timestamp) FROM hr.migrations
UNION ALL SELECT 'messaging', MAX(timestamp) FROM messaging.migrations
UNION ALL SELECT 'admin', MAX(timestamp) FROM admin.migrations
UNION ALL SELECT 'notification', MAX(timestamp) FROM notification.migrations
UNION ALL SELECT 'alert', MAX(timestamp) FROM alert.migrations
UNION ALL SELECT 'ai', MAX(timestamp) FROM ai.migrations
UNION ALL SELECT 'hydroponics', MAX(timestamp) FROM hydroponics.migrations
UNION ALL SELECT 'config', MAX(timestamp) FROM config.migrations
UNION ALL SELECT 'observability', MAX(timestamp) FROM observability.migrations
UNION ALL SELECT 'event_store', MAX(timestamp) FROM event_store.migrations;"

# 4. SUPER_ADMIN restore
docker exec -i aqua-postgres psql -U aquaculture -d aquaculture < /root/.aqua-vault-day-one-reset/2026-05-18/super-admin-restore.sql
```

## Step 1 — Service health probe

Expect all 14 service `/health` endpoints to return 200 with `"status": "ok"`:

```bash
for svc in gateway-api auth-service farm-service sensor-service hr-service \
           messaging-service billing-service admin-api-service notification-service \
           alert-engine hydroponics-service config-service observability-service; do
  port=$(docker port aqua-${svc%-service} 2>&1 | grep -oE '[0-9]+/tcp' | head -1 | cut -d/ -f1)
  printf "%-25s: " "$svc"
  if [ -n "$port" ]; then
    curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$port/health"
  else
    echo "no port"
  fi
done
```

Any non-200 → `docker logs aqua-<service-name> --tail 100` and inspect.

## Step 2 — Release and migration ledger state

The latest `platform.release_ledger` row MUST have `status = promoted` and
`expected_heads = applied_heads`. Source schemas use `<schema>.migrations`.
Tenant schemas use `tenant_<id>.migrations_<sourceSchema>`.

To inspect tenant ledgers for a source schema:

```bash
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SELECT table_schema, table_name
  FROM information_schema.tables
 WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
   AND table_name ~ '^migrations_(farm|sensor|hr|messaging|alert|ai|hydroponics)$'
 ORDER BY table_schema, table_name;"
```

If any schema reports `NULL` or the release ledger shows `heads_match = false`,
the `aqua-db-migrate` step failed or tenant fan-out did not reach the expected
head; check the deploy run logs:

```bash
gh run view <deploy-run-id> --log | grep -A 5 'Schema migration failed'
```

## Step 3 — SUPER_ADMIN restore

The vault snapshot at `/root/.aqua-vault-day-one-reset/2026-05-18/super-admin.json`
carries the original row. Restore via:

```bash
# Parse the JSON snapshot and emit an UPSERT
docker cp /root/.aqua-vault-day-one-reset/2026-05-18/super-admin.json aqua-postgres:/tmp/super-admin.json
docker exec aqua-postgres psql -U aquaculture -d aquaculture <<'SQL'
INSERT INTO auth.users
SELECT * FROM jsonb_populate_record(
  NULL::auth.users,
  (SELECT pg_read_file('/tmp/super-admin.json')::jsonb)
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  password = EXCLUDED.password,
  role = EXCLUDED.role,
  "mfaSecret" = EXCLUDED."mfaSecret",
  "mfaRecoveryCodes" = EXCLUDED."mfaRecoveryCodes",
  "mfaEnabled" = EXCLUDED."mfaEnabled";
SELECT email, role, "mfaEnabled" FROM auth.users WHERE role = 'SUPER_ADMIN';
SQL
```

If `pg_read_file` lacks permission (default postgres restricts it), fall back
to the SeedService approach: ensure `SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD`
env vars are in `aqua-auth` container, restart it; `SeedService.onModuleInit()`
upserts the row.

## Step 4 — End-to-end smoke

```bash
# Login as SUPER_ADMIN
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"by-okan@live.com","password":"<password from vault>"}' \
  | jq -r '.access_token' > /tmp/jwt

# Create first tenant
curl -X POST http://localhost:3000/admin/tenants \
  -H "Authorization: Bearer $(cat /tmp/jwt)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-tenant","modules":["farm","sensor","hr"]}'
```

Verify in psql:
- `auth.tenants` has 1 row
- `auth.tenant_modules` has rows for selected modules
- `information_schema.schemata` shows new `tenant_<uuid>` schema
- `\dt tenant_<uuid>.*` shows ~80-90 tables (per-tenant fan-out from MODULE_SCHEMAS)

## Step 5 — Immutability probe

```bash
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
INSERT INTO shared.audit_logs (id, \"tenantId\", action, \"performedAt\") VALUES (gen_random_uuid(), gen_random_uuid(), 'test', NOW());
UPDATE shared.audit_logs SET action = 'tampered' WHERE action = 'test';
"
```

Expect: INSERT success, UPDATE fails with `Audit table … is append-only; UPDATE/DELETE refused`.

## Step 6 — RLS isolation probe

```bash
docker exec aqua-postgres psql -U aquaculture -d aquaculture -c "
SET app.current_tenant = '00000000-0000-0000-0000-000000000001';
SELECT count(*) FROM farm.batches_v2;  -- expect 0
SET app.bypass_rls = 'on';
SELECT count(*) FROM farm.batches_v2;  -- expect actual count
"
```

## Failure modes + rollback

If any of Steps 1-6 fail unrecoverably:
1. Compose down all backend services
2. `git checkout pre-baseline-2026-05-18`
3. Redeploy from that ref via `gh workflow run deploy-digitalocean.yml`
4. **Vault dump corrupt** (known issue 2026-05-18): manual auth.users + auth.modules + auth.tenants recreate from `super-admin.json` + `SeedService.onModuleInit` re-run.

## Faz 8 monitoring window (operator scheduled)

- **+24h:** verify schema_drift_clean boot signal stable across service restarts
- **+7d:** delete `/root/.aqua-vault-day-one-reset/2026-05-18/` (GDPR Art 5(1)(e))
- **+30d:** zero new Align*/Heal*/Repair*/Replay*/Reconcile*/Sync* migrations authored
- **+60d:** SchemaVersionGate strict-mode probe → zero ledger/DDL divergences
- **+90d:** lockfile-based entity-fingerprint manifest (OPEN-ADR-030-1) generated + CI gate enabled

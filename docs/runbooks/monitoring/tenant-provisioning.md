<!-- markdownlint-disable MD013 -->

# Runbook: tenant provisioning alerts

## Why these alerts exist

Tenant onboarding was broken in production from roughly 2026-05 to 2026-08 and
nothing said so. Every run failed on its first step with
`new row violates row-level security policy for table "tenant_command_receipts"`,
the failure was recorded accurately in `admin.tenant_provisioning_runs.lastError`,
and no metric, alert or dashboard read that column. The outage was found by a
human trying to create a tenant.

Two tenants are still in the state it left behind: `Oceanfarm` is **ACTIVE with
no schema** — which looks healthy in the admin panel and has nowhere to put a
row — and `Suderra AS` is `PENDING`.

## `TenantProvisioningRunsFailing` (critical)

A provisioning run reached `FAILED` in the last 30 minutes. No new tenant can be
onboarded until this is resolved.

1. Name the step that refused:

   ```promql
   sum by (step) (increase(tenant_provisioning_step_failures_total[30m]))
   ```

2. Read that step's own error, which is where the cause is:

   ```sql
   SELECT r.id, r."tenantId", s."stepName", s.attempts, s."lastError"
     FROM admin.tenant_provisioning_runs r
     JOIN admin.tenant_provisioning_steps s ON s."runId" = r.id
    WHERE r.state = 'FAILED' AND s.state = 'FAILED'
    ORDER BY r."createdAt" DESC LIMIT 10;
   ```

3. If the error names a row-level security policy, the write reached the
   database without a bound tenant context. That is the ORPHAN-CRITICAL-573
   class: a command path — usually NATS, not HTTP — that did not seed
   `app.current_tenant`. Do not work around it by widening the policy.

4. A `FAILED` run does **not** leave half a tenant: the saga runs each step in a
   SERIALIZABLE transaction and rolls the attempt back. Verify rather than
   assume, with the parity probe below.

## `TenantProvisioningRunStuck` (warning)

A run has been neither `SUCCEEDED` nor `FAILED` for over an hour.

```sql
SELECT id, "tenantId", state, "currentStep", attempts, "leaseExpiresAt",
       now() - "createdAt" AS age
  FROM admin.tenant_provisioning_runs
 WHERE state IN ('QUEUED', 'RUNNING')
 ORDER BY "createdAt";
```

A `RUNNING` row with a null `leaseExpiresAt` and `attempts` at its ceiling is a
run whose worker died mid-step; the ten-second sweeper requeues stale runs, so a
row that stays put means requeue is also failing. Check that `admin-api-service`
is up and that its scheduler is firing before touching any row by hand.

## Confirming reality, not the ledger

The saga's own verification reads `admin.tenant_schemas`; it can pass while the
schema does not physically exist. To ask the database directly:

```sql
SELECT t.status,
       EXISTS (SELECT 1 FROM pg_namespace n
                WHERE n.nspname = 'tenant_' || left(replace(t.id::text, '-', ''), 16)) AS has_schema
  FROM auth.tenants t;
```

The schema name is the first **16** hex characters of the tenant UUID, not all
32 — matching `getTenantSchemaName`. Comparing against the full UUID reports
every tenant as unprovisioned, which is a false alarm that has already been
raised once.

The hourly `tenant-reality` probe
(`tools/watchdog/tenant-reality.mjs`) runs this comparison and classifies
`ACTIVE` without a usable schema as CRITICAL.

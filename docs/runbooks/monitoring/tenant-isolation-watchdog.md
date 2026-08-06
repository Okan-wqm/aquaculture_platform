# Runbook — tenant isolation watchdog

Covers `TenantIsolationViolationDetected`, `TenantIsolationWatchdogStale` and
`TenantIsolationScannerErrors`
(`infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`).

## What the watchdog is

`WatchdogRunner` (`libs/backend-common/src/database/watchdog/watchdog-runner.ts`)
scans for the three ways tenant isolation breaks: rows written into the source
schema instead of a tenant schema, rows visible across tenant boundaries, and
schema drift between a tenant clone and its source. `WatchdogCronService` in
farm-service runs it every ten minutes and publishes the verdict as three
gauges.

Before W-C the verdict went to an ERROR log line only. That mattered less for
the alerting gap than for a subtler one: a scanner that had stopped running
produced the same silence as a scanner finding nothing wrong.

## TenantIsolationViolationDetected (critical, no delay)

A CRITICAL violation means one tenant's data is reachable from another tenant's
context. There is deliberately no `for:` delay.

1. Read which scanner fired:
   `farm_tenant_isolation_violations{severity="CRITICAL"}` carries a `type`
   label naming the check.
2. Get the detail the metric cannot carry (schema, table, row counts) from
   farm-service logs — the same scan logs the full violation list at ERROR:
   `docker logs aquaculture-farm-service 2>&1 | grep 'WATCHDOG ALERT'`
3. Do **not** repair rows before capturing them. A cross-tenant leak is an
   incident with a disclosure question attached; the rows are the evidence.
4. Escalate to the operator. Data-side repair (moving rows back into the right
   tenant schema, or deleting a leaked copy) is an operator decision, not an
   automatic one.

## TenantIsolationWatchdogStale (high)

No completed scan in 45 minutes — three missed turns for a ten-minute job.

1. Is farm-service alive?
   `docker inspect -f '{{.State.Running}}' aquaculture-farm-service`
   (`docker ps` text is not proof; it reported "Up 2 weeks" for a container
   that had exited two days earlier during the 2026-08-03 outage.)
2. If the process is up, the scheduler or the scan is stuck. Look for the last
   `Starting scheduled watchdog scan` line and whether a matching completion or
   failure followed it.
3. A stale watchdog means isolation is **unverified**, not verified-safe.
   Treat the gap as unmonitored time and say so in the incident record.

## TenantIsolationScannerErrors (medium)

The scan completed but individual scanners failed, so the all-clear covers less
ground than it looks like it does.

1. The failing scanner names are in the warn-level log line
   `Watchdog scanner errors: <scanner>: <error>`.
2. Most common cause is a permissions change on `pg_policies` or a tenant
   schema that vanished mid-scan (tenant deletion racing the scan).
3. Fix the scanner, then wait for one clean scan before treating the all-clear
   as meaningful again.

## What this runbook does not cover

Repairing the isolation defect itself. That belongs to the owning service and
to `tenant-isolation-auditor`; this runbook stops at establishing what is true
and getting a human involved.

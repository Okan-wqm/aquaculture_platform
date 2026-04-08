# Research: Cross-Tenant Probe and Watchdog Design

**Topic:** Watchdog scheduled probes, write-to-one-tenant read-from-another, fail-closed behavior, SchemaDriftDetector integration
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [PostgreSQL 18 — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) (default-deny behavior, policy evaluation)
- [PostgreSQL 18 — information_schema](https://www.postgresql.org/docs/current/information-schema.html) (introspection queries)
- [Microsoft Learn — Event Sourcing Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) (idempotency, fail-closed consumer design)
- [AWS Prescriptive Guidance — Row-level security recommendations](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)
- Platform source: `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts`, `schema-drift-detector.ts`, `source-schema-scanner.ts`, `watchdog-runner.ts`

## Key Findings

### The watchdog's role in a multi-tenant data plane

A multi-tenant data plane with per-tenant schemas + RLS + pooled connections has at least four classes of silent isolation failure that cannot be detected by unit tests or schema-based static analysis:

1. **Cross-tenant data leak.** A row with `tenant_id = A` somehow lands in `tenant_B.some_table`. Causes: bug in `SET search_path`, a `public.*` legacy table shadowing a tenant table, an UPSERT that crossed contexts.
2. **Source schema contamination.** Tenant data lands in a source schema (e.g., `farm.sensors` has real tenant rows instead of template definitions). Causes: a service wrote to the source schema because the `search_path` fell back to `farm, public`.
3. **Schema drift.** Tenant_A has table `foo`, tenant_B does not. Causes: partial migration rollout, a new table added to `MODULE_SCHEMAS` but `TenantSchemaSyncService` was not triggered.
4. **Column-level drift.** Both tenants have `foo`, but with different column definitions. Causes: a migration that ran on some tenants but not others, or an entity change that raced a migration.

The watchdog exists to detect these failure modes **in production**, because they are invisible to green CI tests. Watchdog runs must be scheduled (every 15 minutes is the documented default), must not block the main pool, and must fail closed — detecting a violation must alert loudly, not just log.

### Architecture of the existing watchdog

`WatchdogRunner.run()` orchestrates three scanners:

- **`SourceSchemaScanner`** — scans source schemas (`farm`, `sensor`, etc.) for rows with a `tenant_id` column. A source schema should contain template tables + reference data; any row with a `tenant_id` is an indicator that tenant data has leaked into the source schema. Reports `SOURCE_CONTAMINATION` violations.
- **`CrossTenantProbe`** — for each tenant schema, finds tables with a `tenant_id` column (sample of up to 10 per schema) and verifies that every row's `tenant_id` matches the tenant that owns the schema. Reports `CROSS_TENANT_DATA` violations.
- **`SchemaDriftDetector`** — compares `MODULE_SCHEMAS.tables` against the actual set of tables in each tenant schema and detects missing/extra tables. Also performs a cross-schema majority-vote check. Reports `MISSING_TABLE` and `SCHEMA_DRIFT` violations.

Each scanner runs independently with a per-scanner timeout (`DEFAULT_SCANNER_TIMEOUT_MS = 300_000` = 5 min). Failures in one scanner do not block the others; scanner errors are captured in `report.scannerErrors`.

The report is sorted by severity (CRITICAL first) and emits a structured log at the end. The `summary.hasCritical` flag is the "fail-closed" signal — ops alerting should fire on this, and a CI integration run should fail the deploy on a non-empty critical list.

### The `CrossTenantProbe` design (write-one, read-from-another is aspirational)

The current implementation is a **read-side probe**: it examines every tenant schema's `tenant_id` columns and flags rows with foreign tenant IDs. It does **not** write a canary row into one tenant and then attempt to read it from another. The aspirational "write-one, read-other" design would be:

1. Open a connection in tenant_A's context; insert a canary row `{ probe_id: UUID(), created_at: now() }` into `tenant_A.watchdog_canaries`.
2. Close/return connection.
3. Open a connection in tenant_B's context; attempt to SELECT the canary row using the `probe_id`.
4. If the SELECT returns the row → isolation has failed (**CRITICAL**).
5. Clean up the canary row from tenant_A.

This approach has the advantage of actively probing the isolation boundary rather than passively scanning for leaks that already happened. The disadvantage is that it requires a dedicated `watchdog_canaries` table per tenant, and the canaries become garbage that must be cleaned up. For the current platform, the passive scan is likely sufficient, but the review should flag the aspirational gap.

### The sampling trade-off

`CrossTenantProbe` samples up to 10 tables per schema with `ORDER BY RANDOM()`. This is pragmatic: a full-table scan of every tenant's every table would take hours and hold read locks across the database. The 10-table sample is statistically likely to catch a systematic leak (one that affects most tables) but will miss a leak that only contaminates one specific table in one tenant.

For enterprise production, the correct enhancement is a **rotating full-coverage scan**: partition the tables into N windows and scan window_k on run_k so that over N runs, every table is scanned at least once. This is not currently implemented.

### Identifier safety in the probe

Both `CrossTenantProbe` and `SchemaDriftDetector` interpolate identifiers from `information_schema` into raw SQL. Even though `information_schema` is a trusted source, the probe validates them against `SAFE_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/` (more permissive than `SCHEMA_NAME_REGEX` to allow camelCase column names from entities that don't use SnakeNamingStrategy).

The probe also handles **both** `tenant_id` (snake_case) and `tenantId` (camelCase) column names, because the codebase has no global SnakeNamingStrategy — some entities use explicit `name: 'tenant_id'` while others default to camelCase `tenantId`. A probe that checks only one convention would miss the leak on the other half of the tables.

Review gap: **if a new column naming convention is added** (e.g., `tenantID`, `owner_tenant_id`), the probe will miss it. The review must flag this by grepping for `@Column({ name:` patterns in entity diffs and confirming the probe's column-name list covers them.

### Fail-closed behavior

PostgreSQL's RLS is default-deny by design: *"if no policies exist, a default-deny policy is applied — no rows are visible or modifiable until policies are created."* This is the correct fail-closed posture for a data plane. The watchdog extends this to the application layer:

- A scanner that cannot query a schema (because the schema was dropped mid-scan, or permissions were revoked) logs a warning and continues — it does not crash the entire run. This is acceptable because a missing schema is not an isolation failure.
- A scanner that finds a violation adds it to the violations list — it does not abort early. This is important because finding one CRITICAL violation should not hide 100 other violations.
- The final summary emits `hasCritical: true` and the caller (cron job, CI, admin API) decides whether to alert or block deploy. **The decision to fail the run is separated from the scanning.**

### Integration with `SchemaDriftDetector`

`SchemaDriftDetector.detect()` uses majority-vote to determine the canonical table set: a table is canonical if it appears in ≥50% of tenant schemas. This prevents a single drifted tenant from making every other tenant look drifted. This is a subtle and important design choice — the naive "compare against first schema" approach would generate N-1 false positives if the first schema happened to be the drifted one.

Gaps the reviewer should flag:

- **No column-level comparison.** Two tenants can have the same table with different column definitions and the detector reports no drift. The fix is a per-column check against `information_schema.columns`.
- **No type-level comparison.** Same column name, different type (varchar vs uuid). This is the 2026-04-07 incident class and the current detector misses it entirely.
- **No constraint-level comparison.** Same table, different CHECK/UNIQUE/FK constraints. Detector is blind.
- **Relies on `MODULE_SCHEMAS` as ground truth.** If `MODULE_SCHEMAS` is itself drifted from entity definitions, the detector's ground truth is wrong.

### Scheduling and pool pressure

The watchdog must not starve the primary connection pool. Options:

1. **Dedicated watchdog DataSource** with its own connection pool (e.g., `maxConnections = 2`). The watchdog never competes for the main pool.
2. **Rate limiting within a single scanner** — yield between schemas (`await new Promise(resolve => setImmediate(resolve))`) so the event loop can service other requests.
3. **Per-scanner timeout** (already implemented at 5 min) — bounds worst-case runtime.
4. **Off-peak scheduling** — run the full scan during a maintenance window, not at peak traffic.

The current implementation uses the main DataSource. For a platform with many tenants, this should be migrated to a dedicated DataSource to isolate watchdog impact from request traffic.

### Action on detection

The watchdog detects; it does not remediate. A CRITICAL violation triggers:

1. **Immediate alert** (PagerDuty, Slack, etc.) — ops must be woken for cross-tenant data leaks.
2. **Incident freeze** — block new deploys until the violation is investigated and resolved.
3. **Audit trail entry** — persist the violation to a `watchdog_violations` table so root-cause analysis has a record.
4. **NO automatic deletion** — removing the leaked rows destroys evidence. The remediation path must be explicit and ops-approved.

Review rule: any PR that adds automatic remediation (e.g., "auto-delete rows with foreign tenant_id") is **CRITICAL** — it destroys forensic evidence and may remove legitimate data if the violation is a false positive.

## Security Concerns

- **SQL injection via information_schema-sourced identifiers.** The probe has `SAFE_SQL_IDENTIFIER` validation, but any new code path that interpolates an identifier without this validation is a **CRITICAL** finding.
- **Read-only scanning must not touch writes.** The scanners execute only `SELECT`. Any `INSERT`, `UPDATE`, or `DELETE` inside a scanner is a **CRITICAL** finding (a bug in the scanner would cause data corruption).
- **Scanner connection leaks.** Each scanner must release its connection when done. A scanner that holds a connection through a timeout blocks pool recovery.
- **Incomplete column naming coverage.** If the codebase has a column named `owner_tenant_id` or `tenantID`, the probe misses it. The review must audit entity column names against the probe's recognized name list.
- **Privilege escalation via `pg_catalog`.** The probe queries `information_schema` (SQL standard wrapper) rather than `pg_catalog` directly, which is safer for least-privilege database roles.
- **Cross-schema `GRANT USAGE`.** For the scanner's DB role to query `information_schema.tables` on every tenant schema, it needs `USAGE` on every schema. This is typically granted to the service role, but a least-privilege setup might deny it. Review: the watchdog role should have `USAGE` on every schema but NOT `SELECT` on business tables — except for the row count queries in `CrossTenantProbe`, which do need `SELECT`.

## Performance Concerns

- **10-table sampling misses isolated leaks.** A leak that only contaminates one rare table in one tenant may never be sampled in 10-table runs. Consider rotating windows for full coverage.
- **`COUNT(*)` on large tables is expensive.** `SELECT COUNT(*) FROM "{schema}"."{table}" WHERE "{col}" != $1` scans the table. For large tenant tables, this is O(n). A better approach is `SELECT 1 ... LIMIT 1` (existence check) followed by a row count only if any violation is found.
- **Cross-tenant iteration is N schemas × up to 10 tables = N × 10 queries per run.** For 1000 tenants, that's 10k queries. At 10ms per query on a warm cache, that's 100 seconds — within the 5 min timeout but close.
- **No index on `tenant_id` violates the probe.** If a tenant table lacks an index on `tenant_id`, the `WHERE tenant_id != $1` scan is full-table. The reviewer must confirm `@Index` decorators on every `tenant_id` column (which is also a general performance requirement).
- **Main-pool contention.** Using the main DataSource for watchdog scans competes with request traffic. Migrate to a dedicated pool.

## Architectural Implications for data-expert reviews

1. **Watchdog coverage audit on every entity PR.** Any new entity with a `tenant_id` column must be detectable by the probe. The reviewer confirms the entity uses either `tenant_id` or `tenantId` (the probe's recognized names). A new naming convention requires updating the probe.
2. **Watchdog coverage audit on every `MODULE_SCHEMAS` change.** Adding a table to `MODULE_SCHEMAS` automatically extends the drift detector's expected table set — but the reviewer must also confirm that the table's `tenant_id` column is indexed and that `TenantSchemaSyncService` will propagate the table to existing tenants.
3. **Fail-closed verification.** The reviewer confirms there is an alerting pipeline (not just a log line) that fires on `summary.hasCritical === true`.
4. **Dedicated watchdog DataSource.** For any review of a PR that adds scanner load, the reviewer asks whether the main pool can absorb the load, and flags if it cannot.
5. **No automatic remediation.** Any PR that adds auto-remediation (auto-delete, auto-repair) is **CRITICAL** — the watchdog must be detect-only.
6. **Rotating full-coverage scan.** Review should recommend migrating from 10-table sampling to rotating window coverage once the platform has >100 tenants.
7. **Column-level drift detection.** The reviewer should recommend extending `SchemaDriftDetector` to compare `information_schema.columns` (name + data_type + is_nullable) across tenants — the current detector misses the 2026-04-07 incident class.

## Domain Rule Additions for data-expert

- Watchdog scanner code path that issues `INSERT`, `UPDATE`, or `DELETE` (i.e., non-read-only) = **CRITICAL**.
- Watchdog scanner code path that interpolates identifiers from `information_schema` without `SAFE_SQL_IDENTIFIER` validation = **CRITICAL**.
- New entity with a `tenant_id`-style column using a naming convention not recognized by `CrossTenantProbe` (not `tenant_id` and not `tenantId`) = **HIGH** (watchdog blind spot).
- New table added to `MODULE_SCHEMAS.tables` without a corresponding `TenantSchemaSyncService` sync path = **CRITICAL** (drift source).
- Watchdog violation handling that automatically deletes/modifies leaked rows (auto-remediation) = **CRITICAL** (evidence destruction).
- Watchdog run that uses the main request DataSource instead of a dedicated pool, under traffic pressure = **MEDIUM** (pool contention risk).
- Missing alert pipeline on `WatchdogReport.summary.hasCritical` (only logs, no alert) = **HIGH**.
- `SchemaDriftDetector` that does not include column-level comparison (name + data_type + is_nullable) = **MEDIUM** (incident-class blind spot; enhancement recommendation).
- Missing `@Index` on a `tenant_id` column that the watchdog scans = **MEDIUM** (scanner performance + general perf).
- Scanner that times out repeatedly (`scannerErrors` populated on each run) = **HIGH** (silent coverage loss).
- Watchdog scanner that crashes the entire run instead of isolating the failure in `scannerErrors` = **HIGH**.

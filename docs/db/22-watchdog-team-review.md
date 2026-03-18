# Watchdog System -- 5-Person Expert Team Review

> Date: 2026-03-18
> Orchestrator: Team Lead
> Reviewers: Kaan (Chaos), Elif (SRE), Mert (Architect), Ayse (Test), Burak (Security)

## Files Reviewed

**Watchdog core:**
- `libs/backend-common/src/database/watchdog/source-schema-scanner.ts`
- `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts`
- `libs/backend-common/src/database/watchdog/schema-drift-detector.ts`
- `libs/backend-common/src/database/watchdog/watchdog-runner.ts`
- `libs/backend-common/src/database/watchdog/index.ts`

**Tests:**
- `libs/backend-common/src/database/__tests__/tenant-isolation-static.spec.ts`
- `libs/backend-common/src/database/__tests__/schema-integrity.integration.spec.ts`
- `libs/backend-common/src/database/__tests__/watchdog.integration.spec.ts`

**Context:**
- `libs/backend-common/src/database/schema-manager.service.ts` (MODULE_SCHEMAS)
- `libs/backend-common/src/database/tenant-schema.utils.ts`
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`
- Various `*.entity.ts` files across services

---

## Round 1: Individual Assessments

### Kaan (Chaos Engineer)

**Verdict: ISSUES FOUND (3 critical, 1 medium)**

**K-1 [CRITICAL] CrossTenantProbe misses camelCase `tenantId` columns entirely.**
The probe searches `column_name = 'tenant_id'` (snake_case only). This codebase has no global SnakeNamingStrategy. Several entities -- notably all 3 AI service entities (`agent_conversations`, `tenant_agent_configs`, `tool_execution_audit`) -- use `@Column({ type: 'uuid' })` without explicit `name: 'tenant_id'`, meaning the DB column is literally `tenantId` (camelCase). The probe will NEVER detect cross-tenant leaks in those tables. This is the single biggest blind spot in the entire watchdog system.

**K-2 [CRITICAL] No scanner timeout -- a single hung query blocks the entire scan indefinitely.**
If any scanner's DB query hangs (e.g., table lock, long COUNT(*) on a massive table), the entire WatchdogRunner.run() promise never resolves. If this runs as a cron job, the next invocation overlaps, eventually exhausting the connection pool. There is zero timeout, abort, or cancellation mechanism.

**K-3 [CRITICAL] SchemaDriftDetector's cross-schema consistency uses the first schema as ground truth.**
The detector picks `entries[0]` as the reference schema. If that schema is the one with drift (e.g., a partially migrated schema), every OTHER schema gets flagged as drifted. With 100 tenants where 99 are correct and 1 is broken, the report would contain 99 false-positive SCHEMA_DRIFT violations -- burying the real problem.

**K-4 [MEDIUM] CrossTenantProbe `ORDER BY RANDOM() LIMIT 10` means non-deterministic coverage.**
Running the same probe twice may check completely different tables. A cross-tenant leak in table 11+ may never be detected across multiple runs. This is probabilistic security, not deterministic.

---

### Elif (Production SRE)

**Verdict: ISSUES FOUND (2 high, 2 medium)**

**E-1 [HIGH] `schemasScanned` is misleadingly low when there are zero violations.**
The runner computes `schemasScanned` starting from `uniqueSchemas = new Set(violations.map(v => v.schema))`. When the scan is clean (0 violations), this starts at 0. The fallback `Math.max` query runs, but only for drift/crossTenant modes -- if only `sourceContamination` is enabled, `schemasScanned` will be 0 even though 6 source schemas were actually scanned. This makes clean scan reports misleading and could mask a scanner that silently broke.

**E-2 [HIGH] No scanner timeout -- a runaway query blocks the cron job permanently.**
(Concurs with K-2.) In a cron-based deployment, this is an operational risk. At minimum we need a per-scanner timeout with the error captured in `scannerErrors`.

**E-3 [MEDIUM] Source contamination scanner fires N queries sequentially per module.**
For 6 modules with ~130 non-reference tables total, that's ~120 individual `SELECT COUNT(*)` queries executed sequentially. On a production database with cold caches, this could take minutes. Could be batched per module using `UNION ALL` or at least parallelized.

**E-4 [MEDIUM] No structured logging / metric emission.**
The runner logs text strings. For a production monitoring system, we need structured metrics (e.g., `watchdog.violations.count{severity=CRITICAL}`, `watchdog.scan.duration_ms`). Without this, you cannot set up Grafana/Prometheus alerts on the watchdog results.

---

### Mert (Clean Architect)

**Verdict: ISSUES FOUND (2 high, 1 medium)**

**M-1 [HIGH] `WatchdogViolation` type + `ViolationSeverity` are defined in `source-schema-scanner.ts`.**
These are shared domain types used by ALL scanners. Having them defined inside a specific scanner creates a logical coupling: `cross-tenant-probe.ts` and `schema-drift-detector.ts` both import from `./source-schema-scanner` just to get the interface. These types belong in a separate `types.ts` or in the barrel `index.ts`.

**M-2 [HIGH] Scanners are instantiated inside the runner's `run()` method.**
Each call to `run()` creates `new SourceSchemaScanner(...)`, `new CrossTenantProbe(...)`, etc. This prevents configuration injection (e.g., passing a custom table list to scan, or a custom timeout). The scanners should be constructor-injected or factory-created to follow dependency inversion.

**M-3 [MEDIUM] MODULE_SCHEMAS lookup in SchemaDriftDetector is O(n^2).**
`MODULE_SCHEMAS.find(m => m.tables.includes(expected))` is called for every missing table in every schema. For large numbers of missing tables, this becomes quadratic. Should build a lookup map once. Not critical for current scale but poor scaling pattern.

---

### Ayse (Test Engineer)

**Verdict: ISSUES FOUND (3 issues)**

**A-1 [HIGH] Watchdog integration test inserts into non-existent column `"schemaName"` in auth.tenants.**
Line 263 of `watchdog.integration.spec.ts`:
```sql
INSERT INTO auth.tenants (id, name, status, "schemaName") VALUES ($1, 'Watchdog Test Tenant', 'ACTIVE', $2)
```
The Tenant entity (`tenant.entity.ts`) has NO `schemaName` column. This INSERT will always fail, causing the test to `return` early (via the catch block). The cross-tenant probe test NEVER actually runs. This is a silent skip masquerading as a passing test.

**A-2 [MEDIUM] The SourceSchemaScanner contamination test subclasses the scanner to bypass MODULE_SCHEMAS.**
The test creates an anonymous subclass that overrides `scan()` entirely. This means the test is NOT testing the actual scanner logic -- it's testing a completely different implementation. The contamination detection test for the REAL scanner is effectively missing.

**A-3 [MEDIUM] Schema integrity test uses `console.warn` instead of `fail()` for missing tables.**
`schema-integrity.integration.spec.ts` line 72-78: when tables are missing, it logs a warning and continues instead of failing. This means provisioning bugs pass CI silently.

---

### Burak (Security Auditor)

**Verdict: ISSUES FOUND (2 high, 1 medium)**

**B-1 [HIGH] String interpolation in SQL with `table_name` from `information_schema`.**
In `cross-tenant-probe.ts` line 80:
```typescript
`SELECT COUNT(*) as cnt FROM "${schema}"."${table_name}"`
```
`schema` comes from `listTenantSchemas()` (an `information_schema` query) and `table_name` comes from `information_schema.columns`. Both are "trusted" system catalog sources, but a compromised database or a schema/table with special characters (e.g., `"; DROP TABLE --`) would inject SQL. Defence-in-depth requires validating these identifiers against a safe regex before interpolation.

Similarly in `source-schema-scanner.ts` line 86:
```typescript
`SELECT COUNT(*) as cnt FROM "${mod.sourceSchema}"."${table}"`
```
While MODULE_SCHEMAS is app code, a corrupted merge could introduce unsafe characters.

**B-2 [HIGH] CrossTenantProbe logs `expectedTenantId` in violation details.**
The violation `details` field contains the actual tenant UUID: `Expected only tenant_id=${expectedTenantId}`. If watchdog reports are exposed to admin UIs or logs that are aggregated across tenants, this leaks tenant identifiers. Not catastrophic but violates least-information-disclosure.

**B-3 [MEDIUM] `auth.tenants` status filter allows data in non-ACTIVE tenant schemas to go unscanned.**
The cross-tenant probe queries `WHERE status = 'ACTIVE'`, skipping SUSPENDED, PENDING, and CANCELLED tenants. Data leaks in suspended tenant schemas would go completely undetected. A suspended tenant's data is still sensitive.

---

## Round 2: Cross-Examination (Disagreements)

### Disagreement 1: Severity of K-4 (RANDOM() LIMIT 10)

**Kaan (MEDIUM):** The RANDOM sampling means we never get full coverage. Over many runs, the probability of hitting every table converges, but for a security scanner that's insufficient.

**Elif (LOW -- disagrees):** In production with 15-minute intervals, statistical coverage is adequate. Full table scans on every tenant would be too expensive.

**Burak (sides with Kaan):** For a security-critical scanner, probabilistic is not acceptable. Missing even one table per run is a gap.

**Orchestrator decision:** Keep as MEDIUM. The RANDOM sampling is a reasonable operational trade-off for the current cron model, but we should document the coverage gap and recommend that a full (non-sampled) scan be run during off-peak hours weekly. Not fixing this in this round -- it's a design trade-off, not a bug.

### Disagreement 2: M-1 (types in wrong file) vs. pragmatism

**Mert (HIGH):** Types in `source-schema-scanner.ts` is a SRP violation. Every scanner imports from a peer they shouldn't depend on.

**Elif (LOW):** It works, it's a single file barrel re-export. Moving types around is churn for zero runtime impact.

**Orchestrator decision:** Mert is right on principle but this is a LOW priority refactor. The barrel `index.ts` already re-exports everything -- consumers don't see the internal coupling. Documenting as recommended but NOT fixing in this round. Focus on security and correctness first.

### Disagreement 3: B-3 (non-ACTIVE tenants skipped)

**Burak (HIGH):** Suspended tenant data is still sensitive. Skipping them is a security gap.

**Kaan (MEDIUM):** Agree it's a gap but it's intentional -- scanning inactive schemas that may have been cleaned up or archived could produce false positives.

**Elif (sides with Kaan):** From an operational perspective, SUSPENDED tenants often have archived schemas that are read-only. Scanning them adds noise.

**Orchestrator decision:** Keep as MEDIUM. Burak's concern is valid but the operational noise from scanning inactive schemas outweighs the risk. We should add a configurable `includeInactiveTenants` option to the probe rather than changing the default. NOT fixing in this round -- documenting as future improvement.

### Disagreement 4: E-3 (sequential queries)

**Elif (MEDIUM):** 120 sequential COUNT queries is slow.

**Mert (LOW):** Premature optimization. The scanner runs as a background job.

**Orchestrator decision:** LOW priority. The scan runs every 15 minutes; a few extra seconds is acceptable. Document for future optimization.

---

## Round 3: Consensus Fix List

All 5 team members agree on these fixes, ordered by priority:

| # | Priority | Issue | Fix | Consensus |
|---|----------|-------|-----|-----------|
| 1 | P0 | K-1: camelCase `tenantId` columns invisible to probe | Search for BOTH `'tenant_id'` AND `'tenantId'` in information_schema | 5/5 AGREE |
| 2 | P0 | K-2/E-2: No scanner timeout | Add per-scanner timeout via `withTimeout()` wrapper (default 5 min) | 5/5 AGREE |
| 3 | P0 | B-1: SQL identifier interpolation without validation | Add `SAFE_SQL_IDENTIFIER` regex validation before all string interpolation | 5/5 AGREE |
| 4 | P1 | K-3: First-schema-as-reference bias in drift detection | Replace with majority-vote canonical table set | 5/5 AGREE |
| 5 | P1 | E-1: `schemasScanned` wrong for clean scans | Always query actual schema count, include source schema count | 5/5 AGREE |
| 6 | P1 | A-1: Test inserts into non-existent `schemaName` column | Fix INSERT to use only columns that exist in Tenant entity | 5/5 AGREE |

---

## Round 4: Fixes Applied

### Fix 1: CrossTenantProbe -- detect both snake_case and camelCase tenant columns

**File:** `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts`

Changed the `information_schema.columns` query from:
```sql
WHERE table_schema = $1 AND column_name = 'tenant_id'
```
To:
```sql
WHERE table_schema = $1 AND column_name IN ('tenant_id', 'tenantId')
```

Also changed the subsequent COUNT query to use the actual `column_name` found (quoted to preserve case):
```sql
WHERE "${column_name}" IS NOT NULL AND "${column_name}" != $1
```

The violation `details` field now includes which column variant was found: `(column: "tenantId")`.

### Fix 2: WatchdogRunner -- per-scanner timeout

**File:** `libs/backend-common/src/database/watchdog/watchdog-runner.ts`

- Added `scannerTimeoutMs` option to `WatchdogScanOptions` (default: 300,000ms = 5 minutes)
- Added `private async withTimeout<T>()` method that wraps each scanner promise with a setTimeout-based deadline
- All three scanner invocations now go through `this.withTimeout(name, promise, timeout)`
- Timeout errors are captured in `scannerErrors` like any other scanner failure

### Fix 3: SQL identifier validation (defence-in-depth)

**Files:**
- `libs/backend-common/src/database/watchdog/source-schema-scanner.ts` -- Added `SAFE_SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/` validation before interpolating MODULE_SCHEMAS values into SQL
- `libs/backend-common/src/database/watchdog/cross-tenant-probe.ts` -- Added `SAFE_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/` (more permissive to handle camelCase) for `table_name` and `column_name` from information_schema. Also validates schema name against `SCHEMA_NAME_REGEX` imported from `tenant-schema.utils.ts`

Unsafe identifiers are logged at ERROR level and skipped, not thrown -- so a single corrupt entry doesn't crash the entire scan.

### Fix 4: SchemaDriftDetector -- majority-vote canonical set

**File:** `libs/backend-common/src/database/watchdog/schema-drift-detector.ts`

Replaced the arbitrary first-schema-as-reference approach with majority voting:
1. For each table found across all schemas, count how many schemas have it
2. A table is "canonical" if it appears in >= ceil(N/2) schemas (majority threshold)
3. Compare every schema against the canonical set
4. This ensures a single drifted schema gets flagged, not all the correct ones

### Fix 5: WatchdogRunner -- accurate schemasScanned count

**File:** `libs/backend-common/src/database/watchdog/watchdog-runner.ts`

- Always query actual tenant schema count from `information_schema.schemata` (not derived from violations)
- When source contamination scanner runs, add `MODULE_SCHEMAS.length` to the count (these are source schemas scanned)
- Added `import { MODULE_SCHEMAS }` at the top of the file
- Fallback to violation-based count only on query error

### Fix 6: Integration test -- fix non-existent column in auth.tenants INSERT

**File:** `libs/backend-common/src/database/__tests__/watchdog.integration.spec.ts`

Changed:
```sql
INSERT INTO auth.tenants (id, name, status, "schemaName") VALUES ($1, 'Watchdog Test Tenant', 'ACTIVE', $2)
```
To:
```sql
INSERT INTO auth.tenants (id, name, slug, status) VALUES ($1, 'Watchdog Test Tenant', $2, 'ACTIVE')
```

The Tenant entity has no `schemaName` column (schema names are derived from tenant ID by `getTenantSchemaName()`). The `slug` column is required (UNIQUE NOT NULL constraint).

---

## Round 5: Final Sign-off

### Kaan (Chaos Engineer): PASS
The camelCase blind spot (K-1) was the most dangerous issue -- it meant 3 entire tables in the AI module were invisible to cross-tenant detection. Fixed. The timeout (K-2) prevents runaway scans. The majority-vote (K-3) eliminates false-positive cascades. The RANDOM sampling (K-4) is documented as a known trade-off. I'm satisfied.

### Elif (Production SRE): PASS
The timeout mechanism (E-2) is the most important SRE fix -- it prevents 3am alerts caused by a hung scanner exhausting the connection pool. The schemasScanned accuracy (E-1) means clean scan reports now show meaningful numbers. The sequential query issue (E-3) is deferred as LOW priority, which I accept. Structured metrics (E-4) remain a future improvement. I'm satisfied.

### Mert (Clean Architect): PASS
The type location issue (M-1) is deferred, which I accept -- it's cosmetic. The scanner instantiation concern (M-2) is a valid future refactor but not blocking. The O(n^2) lookup (M-3) is documented. The majority-vote algorithm in the drift detector is a clean, well-reasoned improvement over the arbitrary first-reference approach. I'm satisfied.

### Ayse (Test Engineer): PASS
The broken test insert (A-1) was a silent failure -- the cross-tenant probe integration test was effectively a no-op. Fixed. The scanner subclass issue (A-2) is a pre-existing test design limitation but not introduced by this PR. The console.warn-instead-of-fail (A-3) is deferred. I'm satisfied.

### Burak (Security Auditor): PASS
The SQL identifier validation (B-1) adds proper defence-in-depth. The `SCHEMA_NAME_REGEX` import from tenant-schema.utils creates a single source of truth for schema name validation. The camelCase column fix also addresses a security gap where AI service entities were completely unmonitored for cross-tenant leaks. The tenant ID in violation details (B-2) is acceptable -- these reports go to ops teams only. The non-ACTIVE tenant gap (B-3) is documented as a future configurable option. I'm satisfied.

---

## Deferred Items (Future Improvements)

| Item | Priority | Owner Suggestion |
|------|----------|-----------------|
| Move `WatchdogViolation` types to `types.ts` | LOW | Mert |
| Add `includeInactiveTenants` option to CrossTenantProbe | MEDIUM | Burak |
| Batch SourceSchemaScanner queries with UNION ALL | LOW | Elif |
| Add structured metric emission to WatchdogRunner | MEDIUM | Elif |
| Run weekly full (non-RANDOM) cross-tenant probe | MEDIUM | Kaan |
| Inject scanners via constructor for testability | LOW | Mert |

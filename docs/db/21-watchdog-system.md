# Tenant Isolation Watchdog System

> Created 2026-03-18. Covers the automated detection system for tenant data isolation violations.

## Overview

The watchdog system is a multi-layer scanning framework that detects tenant isolation violations in the aquaculture platform's PostgreSQL multi-tenant architecture. It runs without modifying any data and produces structured reports.

**Location:** `libs/backend-common/src/database/watchdog/`

## Architecture

```
WatchdogRunner (orchestrator)
  |
  +-- SourceSchemaScanner    -> Detects tenant data in template schemas
  +-- CrossTenantProbe       -> Detects wrong tenant_id rows in tenant schemas
  +-- SchemaDriftDetector    -> Detects missing/extra tables across tenant schemas
```

## Components

### 1. SourceSchemaScanner (`source-schema-scanner.ts`)

**Purpose:** Detects tenant data contamination in source (template) schemas.

Source schemas (`sensor`, `farm`, `hr`, `hydroponics`, `alert`, `ai`) serve as structural templates. They should contain:
- Table definitions (DDL)
- Reference/lookup data only (defined in `MODULE_SCHEMAS[].referenceDataTables`)

Any other data in these schemas means a service is writing to the template instead of the tenant schema -- a critical bug caused by misconfigured `search_path`.

**Violation type:** `SOURCE_CONTAMINATION` (severity: `CRITICAL`)

### 2. CrossTenantProbe (`cross-tenant-probe.ts`)

**Purpose:** Detects data that has leaked between tenant schemas.

For each tenant schema, the probe:
1. Resolves the expected `tenantId` from `auth.tenants`
2. Finds tables with a `tenant_id` column
3. Checks if any rows have a `tenant_id` that does not match the schema owner

Samples up to 10 tables per schema to keep execution time reasonable.

**Violation type:** `CROSS_TENANT_DATA` (severity: `CRITICAL`)

### 3. SchemaDriftDetector (`schema-drift-detector.ts`)

**Purpose:** Ensures all tenant schemas match `MODULE_SCHEMAS` and are consistent with each other.

Checks:
- Every table listed in `MODULE_SCHEMAS` exists in every tenant schema
- All tenant schemas have identical table sets (no partial migrations)

**Violation types:**
- `MISSING_TABLE` (severity: `HIGH`) -- Expected table not found
- `SCHEMA_DRIFT` (severity: `HIGH` or `MEDIUM`) -- Inconsistency between tenant schemas

### 4. WatchdogRunner (`watchdog-runner.ts`)

**Purpose:** Orchestrates all scanners and produces a unified `WatchdogReport`.

Each scanner runs independently. If one fails, the others still execute. Scanner-level errors are captured in the report.

## Data Types

### WatchdogViolation

```typescript
interface WatchdogViolation {
  type: 'SOURCE_CONTAMINATION' | 'CROSS_TENANT_DATA' | 'SCHEMA_DRIFT' | 'MISSING_TABLE';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  schema: string;
  table: string;
  details: string;
  rowCount?: number;
  timestamp: Date;
}
```

### WatchdogReport

```typescript
interface WatchdogReport {
  scanStartedAt: string;
  scanCompletedAt: string;
  summary: {
    totalViolations: number;
    bySeverity: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;
    byType: Record<string, number>;
    hasCritical: boolean;
    schemasScanned: number;
    durationMs: number;
  };
  violations: WatchdogViolation[];
  scannersRun: string[];
  scannerErrors: { scanner: string; error: string }[];
}
```

## Usage

### Programmatic (in a service or cron job)

```typescript
import { WatchdogRunner } from '@platform/backend-common';
import { DataSource } from 'typeorm';

const runner = new WatchdogRunner(dataSource);
const report = await runner.runFullScan();

if (report.summary.hasCritical) {
  // Alert operations team
  await notifyOps(report);
}
```

### Selective scanning

```typescript
const report = await runner.run({
  sourceContamination: true,
  crossTenantData: false,  // skip if auth.tenants is not available
  schemaDrift: true,
});
```

### As a cron job

```typescript
@Cron('*/15 * * * *')  // Every 15 minutes
async runWatchdog() {
  const runner = new WatchdogRunner(this.dataSource);
  const report = await runner.runFullScan();

  if (report.summary.hasCritical) {
    this.alertService.sendCritical('Tenant isolation violation detected', report);
  }
}
```

## Test Suite

### Static Analysis (CI-ready, no database needed)

**File:** `libs/backend-common/src/database/__tests__/tenant-isolation-static.spec.ts`

Validates:
- `MODULE_SCHEMAS` completeness (all 6 modules, 133 tables)
- No duplicate table names across modules
- `referenceDataTables` are subsets of `tables`
- `DEFAULT_TENANT_MODULES` matches `MODULE_SCHEMAS`
- Table names are valid SQL identifiers

Run: `npx jest --testPathPattern=tenant-isolation-static`

### Schema Integrity (Integration, requires database)

**File:** `libs/backend-common/src/database/__tests__/schema-integrity.integration.spec.ts`

Validates:
- Tenant schema creation produces all expected tables
- Reference data is copied correctly
- All tenant schemas have identical table sets
- Column structures match between source and tenant schemas

Run: `npx jest --testPathPattern=schema-integrity.integration`

### Watchdog Integration (requires database)

**File:** `libs/backend-common/src/database/__tests__/watchdog.integration.spec.ts`

Validates:
- Source schema contamination detection works
- Cross-tenant data detection works
- Schema drift detection works
- WatchdogRunner produces valid reports with correct structure

Run: `npx jest --testPathPattern=watchdog.integration`

## Severity Guide

| Severity | Meaning | Response Time |
|----------|---------|---------------|
| CRITICAL | Active data leak or contamination | Immediate |
| HIGH | Missing tables, structural issues | Same day |
| MEDIUM | Inconsistency, potential future issue | This week |
| LOW | Informational, minor drift | Next sprint |

## Integration Points

- **Exports:** All components are exported from `@platform/backend-common` via `libs/backend-common/src/database/index.ts`
- **Dependencies:** Only `typeorm` (DataSource) and `@nestjs/common` (Logger)
- **No DI required:** Scanners take a raw `DataSource` -- usable outside NestJS
- **MODULE_SCHEMAS:** Single source of truth from `schema-manager.service.ts` (133 tables across 6 modules)

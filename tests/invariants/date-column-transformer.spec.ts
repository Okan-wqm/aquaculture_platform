/**
 * Platform-wide invariant — FARM-CRITICAL-406 date-column serialization discipline.
 *
 * PostgreSQL returns `date` columns as plain strings (`"2026-10-10"`). When
 * such a column is declared with a `Date` TypeScript type and exposed through
 * a GraphQL `DateTime` field, the apollo scalar refuses to serialize the
 * hydrated string and every read selecting the column dies with
 * `Expected DateTime.serialize(...) to return non-nullable value, returned:
 * null` — while writes keep working because their payloads carry in-memory
 * Date objects. That read/write asymmetry kept the break invisible until an
 * end-to-end exercise of the Feeding Records, Harvest, Storage inventory and
 * Task surfaces (2026-10-10 farm E2E campaign).
 *
 * RULE: every `@Column({ type: 'date' })` whose property type is `Date` MUST
 * declare `transformer: new DateColumnTransformer()` (or the shared
 * `dateColumnTransformer` instance) from `@aquaculture/backend-common/database`.
 *
 * Columns typed as `string` are deliberate pass-throughs (e.g. lot identity
 * labels) and are exempt.
 *
 * # LEGACY ALLOWLIST
 *
 * 45 pre-existing columns (farm/hr/billing/admin) predate the transformer and
 * are swept under tracked finding FARM-MEDIUM-424 (each entry must be
 * verified for string-format dependencies before transforming). The allowlist
 * exists so NEW columns cannot regress — adding a Date-typed date column
 * without the transformer fails this spec unless the file:property pair is
 * consciously appended here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');

/** file path (from repo root) : property — awaiting the FARM-MEDIUM-424 conversion. */
const LEGACY_UNTRANSFORMED = new Set([
  'apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts:snapshotDate',
  'apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:periodStart',
  'apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:periodEnd',
  'apps/billing-service/src/billing/entities/invoice.entity.ts:periodStart',
  'apps/billing-service/src/billing/entities/invoice.entity.ts:periodEnd',
  'apps/farm-service/src/batch/entities/batch.entity.ts:stockedAt',
  'apps/farm-service/src/batch/entities/mortality-record.entity.ts:recordDate',
  'apps/farm-service/src/batch/entities/tank-allocation.entity.ts:allocationDate',
  'apps/farm-service/src/batch/entities/tank-operation.entity.ts:operationDate',
  'apps/farm-service/src/feeding/entities/daily-feeding-execution.entity.ts:executionDate',
  'apps/farm-service/src/feeding/entities/feeding-program.entity.ts:startDate',
  'apps/farm-service/src/feeding/entities/feeding-table.entity.ts:startDate',
  'apps/farm-service/src/feeding/entities/feeding-table.entity.ts:endDate',
  'apps/farm-service/src/feeding-protocol/entities/protocol-assignment.entity.ts:effectiveFrom',
  'apps/farm-service/src/fish-health/entities/health-event.entity.ts:eventDate',
  'apps/farm-service/src/growth/entities/growth-measurement.entity.ts:measurementDate',
  'apps/farm-service/src/maintenance/entities/maintenance-schedule.entity.ts:startDate',
  'apps/farm-service/src/worker/entities/worker.entity.ts:hireDate',
  'apps/hr-service/src/aquaculture/entities/work-rotation.entity.ts:startDate',
  'apps/hr-service/src/aquaculture/entities/work-rotation.entity.ts:endDate',
  'apps/hr-service/src/attendance/entities/attendance-record.entity.ts:date',
  'apps/hr-service/src/attendance/entities/schedule-entry.entity.ts:date',
  'apps/hr-service/src/attendance/entities/schedule.entity.ts:startDate',
  'apps/hr-service/src/attendance/entities/schedule.entity.ts:endDate',
  'apps/hr-service/src/hr/entities/employee.entity.ts:dateOfBirth',
  'apps/hr-service/src/hr/entities/employee.entity.ts:hireDate',
  'apps/hr-service/src/hr/entities/payroll.entity.ts:payPeriodStart',
  'apps/hr-service/src/hr/entities/payroll.entity.ts:payPeriodEnd',
  'apps/hr-service/src/leave/entities/leave-request.entity.ts:startDate',
  'apps/hr-service/src/leave/entities/leave-request.entity.ts:endDate',
  'apps/hr-service/src/performance/entities/goal.entity.ts:startDate',
  'apps/hr-service/src/performance/entities/goal.entity.ts:targetDate',
  'apps/hr-service/src/performance/entities/kpi.entity.ts:periodStart',
  'apps/hr-service/src/performance/entities/kpi.entity.ts:periodEnd',
  'apps/hr-service/src/performance/entities/performance-review.entity.ts:periodStart',
  'apps/hr-service/src/performance/entities/performance-review.entity.ts:periodEnd',
  'apps/hr-service/src/scheduling/entities/holiday.entity.ts:date',
  'apps/hr-service/src/scheduling/entities/holiday.entity.ts:startDate',
  'apps/hr-service/src/scheduling/entities/holiday.entity.ts:endDate',
  'apps/hr-service/src/scheduling/entities/weekly-plan-entry.entity.ts:date',
  'apps/hr-service/src/scheduling/entities/weekly-plan.entity.ts:weekStartDate',
  'apps/hr-service/src/scheduling/entities/weekly-plan.entity.ts:weekEndDate',
  'apps/hr-service/src/training/entities/employee-certification.entity.ts:issueDate',
  'apps/hr-service/src/training/entities/training-enrollment.entity.ts:enrollmentDate',
  'apps/hr-service/src/training/entities/training-session.entity.ts:sessionDate',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.entity.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Matches a `type: 'date'` @Column decorator plus the property it annotates. */
const DATE_COLUMN_RE =
  /@Column\(\{[^}]*type:\s*'date'[^}]*\}\)\s*\n\s*(?:@\w+(?:\([^)]*\))?\s*\n\s*)*(\w+)(\?)?!\s*:\s*([^;]+);/g;

interface Violation {
  file: string;
  property: string;
  line: number;
}

describe('date-column transformer invariant (FARM-CRITICAL-406)', () => {
  const violations: Violation[] = [];
  let scannedColumns = 0;

  beforeAll(() => {
    for (const file of walk(APPS_DIR)) {
      const source = readFileSync(file, 'utf8');
      DATE_COLUMN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = DATE_COLUMN_RE.exec(source)) !== null) {
        const decoratorStart = source.lastIndexOf('@Column', match.index);
        const decorator = source.slice(decoratorStart, match.index + match[0].length);
        const propertyType = match[3].trim();
        scannedColumns += 1;
        if (propertyType === 'Date' && !decorator.includes('DateColumnTransformer')) {
          violations.push({
            file: relative(REPO_ROOT, file),
            property: match[1],
            line: source.slice(0, decoratorStart).split('\n').length,
          });
        }
      }
    }
  });

  it('every Date-typed date column carries the DateColumnTransformer', () => {
    const fresh = violations.filter((v) => !LEGACY_UNTRANSFORMED.has(`${v.file}:${v.property}`));
    const stale = [...LEGACY_UNTRANSFORMED].filter(
      (entry) => !violations.some((v) => `${v.file}:${v.property}` === entry),
    );
    // fresh violations must gain the transformer; stale allowlist entries must
    // be removed once converted (FARM-MEDIUM-424).
    expect({ freshViolations: fresh, allowlistEntriesNoLongerMatching: stale }).toEqual({
      freshViolations: [],
      allowlistEntriesNoLongerMatching: [],
    });
  });

  it('the scan actually exercised date columns (guard against a rotting regex)', () => {
    expect(scannedColumns).toBeGreaterThan(20);
  });
});

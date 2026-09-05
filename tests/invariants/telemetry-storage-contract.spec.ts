/**
 * Platform-wide invariant — CRITICAL-003 (100-tenant readiness plan,
 * docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-CRITICAL-088):
 *
 * `sensor_metrics` and its `metrics_1min/1hour/1day` rollups are PER-TENANT
 * tables living in each tenant's `tenant_<16hex>` schema. The single writer
 * (`SensorMetricWriterService`) derives the destination schema from the row's
 * tenantId; the readers MUST resolve the same validated tenant schema. Any
 * active reader still hard-coding the shared `sensor.` schema silently reads
 * the legacy shared hypertable — a table the live write path no longer
 * populates — which returns empty or stale telemetry for every tenant.
 *
 * `ACTIVE_SENSOR_QUERY_FILES` lists the SQL-bearing reader files; doc-comments
 * elsewhere may mention the shared name historically, so the invariant scopes
 * itself to files that actually emit SQL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ACTIVE_SENSOR_QUERY_FILES = [
  'apps/sensor-service/src/sensor/services/metric-query.service.ts',
  'apps/sensor-service/src/aggregation/time-bucket.service.ts',
] as const;

const SHARED_SCHEMA_SQL_RE = /sensor\.(sensor_metrics|metrics_1min|metrics_1hour|metrics_1day)\b/;

describe('Telemetry storage contract (per-tenant sensor_metrics)', () => {
  it('tracks only files that exist', () => {
    for (const file of ACTIVE_SENSOR_QUERY_FILES) {
      expect(existsSync(resolve(REPO_ROOT, file))).toBe(true);
    }
  });

  it('contains no active shared sensor metric SQL', () => {
    const violations: string[] = [];
    for (const file of ACTIVE_SENSOR_QUERY_FILES) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (SHARED_SCHEMA_SQL_RE.test(source)) {
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Active telemetry readers must resolve the validated tenant schema instead of ` +
          `the shared 'sensor.' schema (the live writer no longer populates it):\n` +
          violations.map((file) => `  - ${file}`).join('\n'),
      );
    }

    expect(violations).toEqual([]);
  });
});

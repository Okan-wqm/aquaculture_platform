/**
 * SENSOR-HIGH-098: raw telemetry retention remains fail-closed until the
 * immutable export/verification ledger and LEGAL-001 gates authorize a drop.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SENSOR_ROOT = 'apps/sensor-service/src';

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('sensor telemetry retention contract', () => {
  it('has no active raw sensor_metrics retention policy installation', () => {
    const files = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', `${SENSOR_ROOT}/**/*.ts`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.includes('/.archive/'))
      .filter((file) => !file.includes('/__tests__/'));

    const violations = files.filter((file) => {
      const source = read(file);
      return /add_retention_policy\s*\([^)]*sensor_metrics/is.test(source);
    });

    expect(violations).toEqual([]);
  });

  it('requires both the technical retention gate and LEGAL-001 approval in the DB writer', () => {
    const migration = read(
      `${SENSOR_ROOT}/database/migrations/1816000000002-TelemetryArchiveLifecycle.ts`,
    );

    expect(migration).toContain("current_setting('app.telemetry_retention_enabled', true)");
    expect(migration).toContain("current_setting('app.legal_001_approved', true)");
    expect(migration).toContain('raw telemetry drop disabled pending LEGAL-001');
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON "sensor"."telemetry_archive_events" FROM sensor_service',
    );
  });

  it('keeps tenant schema filters on every Timescale introspection surface', () => {
    const cagg = read(`${SENSOR_ROOT}/timescale/continuous-aggregate.service.ts`);
    const hypertable = read(`${SENSOR_ROOT}/timescale/hypertable.service.ts`);
    const retention = read(`${SENSOR_ROOT}/timescale/retention-policy.service.ts`);

    expect(cagg).toContain('view_schema = $1');
    expect(hypertable).toContain('hypertable_schema = $1');
    expect(retention).toContain('j.hypertable_schema = $1');
  });
});

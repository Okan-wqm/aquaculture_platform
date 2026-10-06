/**
 * Invariant (SENSOR-HIGH-148): sensor-service's real-Postgres RLS specs stand
 * on ONE stage — `apps/sensor-service/src/__tests__/support/
 * sensor-rls-postgres.harness.ts` — instead of each re-creating it by hand.
 *
 * The stage is where production row security is reproduced: the pinned
 * TimescaleDB image, tenant tables synchronized from the runtime entities,
 * FORCE RLS armed by the platform helper, a non-owner runtime role and the
 * platform tenant↔schema mapping. Five specs carried their own copy of it,
 * and a copy that drifts (a missing grant, RLS armed in another order, a
 * different mapping) proves something about a database production never runs.
 * A `*.rls.postgres.spec.ts` therefore boots through the harness and never
 * calls the container factory itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS = 'apps/sensor-service/src/__tests__/support/sensor-rls-postgres.harness.ts';

function sensorRlsPostgresSpecs(): string[] {
  return execFileSync('git', ['ls-files', 'apps/sensor-service/src/**/*.rls.postgres.spec.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0);
}

describe('sensor-service RLS Postgres stage (SENSOR-HIGH-148)', () => {
  const specs = sensorRlsPostgresSpecs();

  it('finds the RLS specs it guards', () => {
    expect(specs.length).toBeGreaterThanOrEqual(5);
  });

  it('every RLS spec boots through the shared harness, never the container factory', () => {
    const offenders = specs.filter((file) => {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return !/\bbootSensorRlsHarness\(/.test(source) || /\bbootPostgresContainer\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('the harness itself is the only place that boots the container for them', () => {
    expect(readFileSync(path.join(REPO_ROOT, HARNESS), 'utf8')).toMatch(
      /\bbootPostgresContainer\(/,
    );
  });
});

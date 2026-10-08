/**
 * Invariant: the sensor-reading tier policy
 * (libs/shared-contracts/src/sensor-readings/tier-policy.ts) is the only owner
 * of the series window cap, the store choice, the display ladder, the interval
 * whitelist and the rollup windows/retention.
 *
 * Each of these used to be written by hand in two to five places. A copy that
 * moves on its own — a retention change in the rollup SQL that the store choice
 * never hears about — sends charts to a store that no longer holds the data.
 * The checks below fail on the specific shapes those copies took.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY = 'libs/shared-contracts/src/sensor-readings/tier-policy.ts';
const ROLLUP_DDL = 'libs/backend-common/src/database/sensor-continuous-aggregate-definition.ts';

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function sensorServiceSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/sensor-service/src/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0)
    .filter((file) => !/(\.spec|\.test)\.ts$|\/__tests__\/|\/migrations\//.test(file));
}

describe('sensor-reading tier policy has one owner', () => {
  it('the rollup DDL writes no interval, bucket width or table name of its own', () => {
    const ddl = read(ROLLUP_DDL);
    const sqlBodies = [...ddl.matchAll(/sql: `([\s\S]*?)`/g)].map((match) => match[1] ?? '');
    expect(sqlBodies.length).toBeGreaterThan(10);
    const offenders = sqlBodies.filter(
      (sql) =>
        /INTERVAL\s+'\d/.test(sql) ||
        /time_bucket\('\d/.test(sql) ||
        /(?<![\w"])(sensor_metrics|metrics_1min|metrics_1hour|metrics_1day)\b(?!_)/.test(sql),
    );
    expect(offenders).toEqual([]);
  });

  it('sensor-service keeps no copy of the window cap, tier thresholds or interval whitelist', () => {
    const copies = [
      /365\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, // the series window cap
      /\bhours\s*<=\s*(?:1|6|24|72|168|720)\b/, // the ladder / store thresholds
      /'1 minute',\s*'5 minutes',/, // the interval whitelist
      /AS_OF_LOOKBACK\s*=\s*'/, // the as-of lookback literal
    ];
    const offenders = sensorServiceSources().filter((file) => {
      const source = read(file);
      return copies.some((copy) => copy.test(source));
    });
    expect(offenders).toEqual([]);
  });

  it('the policy itself still declares what the checks above defer to', () => {
    const policy = read(POLICY);
    for (const name of [
      'AGGREGATION_INTERVALS',
      'MAX_SERIES_RANGE_MS',
      'AS_OF_LOOKBACK',
      'DISPLAY_INTERVAL_LADDER',
      'METRIC_TIERS',
    ]) {
      expect([name, new RegExp(`export const ${name}\\b`).test(policy)]).toEqual([name, true]);
    }
  });
});

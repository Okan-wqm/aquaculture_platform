import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ACTIVE_METRIC_READERS = [
  'apps/sensor-service/src/sensor/services/metric-query.service.ts',
  'apps/sensor-service/src/aggregation/time-bucket.service.ts',
] as const;

describe('CRITICAL-003 — active metric readers stay inside the tenant schema', () => {
  for (const relativePath of ACTIVE_METRIC_READERS) {
    it(`${relativePath} uses the canonical tenant-read boundary`, () => {
      const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');

      expect(source).toContain('runInTenantRead');
      expect(source).not.toMatch(
        /\bFROM\s+sensor\.(?:sensor_metrics|metrics_(?:1min|1hour|1day))\b/i,
      );
      expect(source).not.toMatch(
        /\bJOIN\s+sensor\.(?:sensor_metrics|metrics_(?:1min|1hour|1day))\b/i,
      );
    });
  }
});

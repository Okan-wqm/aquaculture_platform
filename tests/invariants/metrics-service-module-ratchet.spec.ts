/**
 * Platform-wide invariant — ORPHAN-089 (+ systemic siblings):
 *
 * Bespoke `@Controller('metrics')` endpoints in apps are RATCHETED: the count
 * may only shrink, never grow. New services MUST expose metrics through the
 * platform `ServiceMetricsModule` (libs/backend-common/src/metrics), which owns
 * the single GET /metrics endpoint AND the default http_/nodejs_ collectors.
 *
 * # Why
 *
 * A service that hand-rolls a `@Controller('metrics')` over its own
 * prom-client Registry serves ONLY its domain counters — the platform HTTP +
 * Node-runtime series are absent from its scrape (the messaging-service defect,
 * ORPHAN-089, now fixed by importing ServiceMetricsModule + contributeTo). The
 * same defect remains in auth / gateway / sensor; observability-service's
 * controller is the legitimate aggregator. This guard freezes the bespoke set so
 * messaging cannot regress and no NEW service can reintroduce the split; each
 * sibling migrated to ServiceMetricsModule lowers BASELINE.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Baseline captured 2026-06-26 AFTER messaging-service was migrated:
// auth-service, gateway-api, sensor-service (089-siblings, tracked) +
// observability-service (legitimate Prometheus aggregator).
const BASELINE_BESPOKE_METRICS_CONTROLLERS = 4;

describe('INVARIANT (ORPHAN-089): bespoke @Controller(metrics) endpoints are ratcheted', () => {
  it(`apps expose at most ${BASELINE_BESPOKE_METRICS_CONTROLLERS} bespoke metrics controllers`, () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'apps/*/src/**/*.ts'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.spec.ts') && !f.includes('/__tests__/'));

    const controllerRe = /@Controller\(\s*['"]metrics['"]\s*\)/;
    const offenders: string[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      if (controllerRe.test(src)) {
        offenders.push(rel);
      }
    }

    if (offenders.length > BASELINE_BESPOKE_METRICS_CONTROLLERS) {
      throw new Error(
        `Bespoke @Controller('metrics') endpoints grew from ` +
          `${BASELINE_BESPOKE_METRICS_CONTROLLERS} to ${offenders.length}.\n` +
          `Expose metrics through ServiceMetricsModule (it owns /metrics + the\n` +
          `default http_/nodejs_ collectors), not a hand-rolled controller.\n` +
          offenders.map((o) => `  ${o}`).join('\n'),
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(BASELINE_BESPOKE_METRICS_CONTROLLERS);
  });

  it('messaging-service exposes metrics via ServiceMetricsModule, not a bespoke controller', () => {
    const mod = readFileSync(
      resolve(REPO_ROOT, 'apps/messaging-service/src/metrics/metrics.module.ts'),
      'utf8',
    );
    expect(mod).toContain('ServiceMetricsModule');
    // No bespoke controller registration — ServiceMetricsModule owns /metrics.
    expect(mod).not.toMatch(/controllers:\s*\[/);
  });
});

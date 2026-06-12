/**
 * Prometheus scrape-target ↔ service-catalog sync invariant (B2 / D3).
 * ============================================================================
 *
 * SSoT chain:
 *
 *   platform/libs/service-catalog/src/index.ts        → which services exist,
 *                                                        their compose name,
 *                                                        containerPort,
 *                                                        metricsExposure,
 *                                                        criticality
 *   scripts/service-catalog/generate-artifacts.ts     → emits the file_sd
 *   infrastructure/monitoring/droplet/file_sd/         → what Prometheus scrapes
 *   THIS FILE                                          → fails CI on drift
 *
 * ORPHAN-HIGH-090: the droplet runs no collector because nothing generated
 * scrape targets. D3 makes the catalog the SSoT for those targets. A scrape
 * config that drifts from the running service set is the classic silent
 * observability gap — a new backend ships, nobody adds it to a hand-written
 * prometheus.yml, and it is simply never scraped. Deriving the targets from the
 * catalog + gating that derivation here makes the gap structurally impossible:
 * a catalog change that is not regenerated, or a hand-edit of the file_sd,
 * fails this invariant at PR time (the fast shard) rather than as a blind spot
 * discovered during an incident.
 *
 * When this fails: run `npm run service-catalog:generate` and commit the
 * regenerated infrastructure/monitoring/droplet/file_sd/aqua-services.json.
 */

import * as fs from 'fs';
import * as path from 'path';

// Relative import (not the @platform alias): the invariants jest project has no
// moduleNameMapper for @platform scopes — same convention as the sibling
// metrics-endpoint-adoption.spec.ts.
import { activeDropletServices } from '../../platform/libs/service-catalog/src';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_SD_PATH = path.join(
  REPO_ROOT,
  'infrastructure/monitoring/droplet/file_sd/aqua-services.json',
);

interface ScrapeTargetGroup {
  targets: string[];
  labels: { app: string; namespace: string; criticality: string };
}

// Re-derive the expected file_sd the SAME way the generator does. This is a
// deliberate, independent re-derivation (a parity check is supposed to compute
// the truth twice from the SSoT and compare) — not a DRY violation.
const expected: ScrapeTargetGroup[] = activeDropletServices()
  .filter((entry) => entry.metricsExposure === 'prom-endpoint')
  .map((entry) => ({
    targets: [`${entry.composeServiceName}:${entry.containerPort}`],
    labels: {
      app: entry.serviceId,
      namespace: 'aquaculture',
      criticality: entry.criticality,
    },
  }));

describe('INVARIANT: Prometheus file_sd scrape targets stay in sync with the service catalog (B2 / D3)', () => {
  it('the committed file_sd exists', () => {
    expect(fs.existsSync(FILE_SD_PATH)).toBe(true);
  });

  const committed = JSON.parse(fs.readFileSync(FILE_SD_PATH, 'utf8')) as ScrapeTargetGroup[];

  it('matches the catalog-derived target set EXACTLY (run `npm run service-catalog:generate` after catalog edits)', () => {
    expect(committed).toEqual(expected);
  });

  it('covers every prom-endpoint droplet service with no silent blind spot', () => {
    expect(committed.length).toBe(expected.length);
    // tripwire: the platform has 14+ scrapeable backends; a collapse to a
    // handful means the catalog filter or compose-name field regressed.
    expect(committed.length).toBeGreaterThanOrEqual(10);
  });

  it('every target is <compose-service>:<port> and carries app + namespace + criticality labels', () => {
    for (const group of committed) {
      expect(group.targets).toHaveLength(1);
      expect(group.targets[0]).toMatch(/^[a-z][a-z0-9-]*:\d+$/);
      expect(group.labels.namespace).toBe('aquaculture');
      expect(group.labels.app).toBeTruthy();
      expect(group.labels.criticality).toBeTruthy();
    }
  });
});

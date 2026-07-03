/**
 * DEPLOY-SSOT — startup-timing single source of truth.
 *
 * The physical invariant `per-service docker start_period ≤ deploy readiness
 * SLA` was previously unenforced because the numbers lived in three unlinked,
 * hand-maintained places:
 *   - a hardcoded `readiness_sla_seconds: 300` literal in the artifact generator
 *   - a dead `?? 300` fallback in scripts/deploy/check-service-health.ts
 *   - per-service `start_period` values hand-typed in docker-compose.droplet.yml
 *
 * Startup timing is now catalog-derived: every active droplet service declares
 * `startupBudgetSeconds`, and the readiness SLA is computed as
 * `max(startupBudgetSeconds over CRITICAL services) + READINESS_SLA_MARGIN_SECONDS`.
 *
 * This spec is the detectable-drift guard for the part NOT yet collapsed into
 * codegen: the compose `start_period` values. It asserts —
 *   1. the GENERATED manifest's readiness_sla_seconds equals the value
 *      recomputed from the catalog (the artifact cannot drift from the catalog);
 *   2. for EVERY service that is `criticality: critical` in the generated
 *      manifest, its docker-compose.droplet.yml healthcheck `start_period`
 *      (parsed) is ≤ the derived readiness_sla_seconds (a critical service can
 *      never be configured to boot slower than the gate will wait — otherwise
 *      the gate rolls back a service that was still legitimately starting).
 *
 * FOLLOW-UP (guarded, not deferred-silently): the compose `start_period` values
 * are still hand-typed; emitting them from the catalog's startupBudgetSeconds is
 * a separate generator pass. Until then THIS invariant is the active guard that
 * makes a drift between the two detectable at CI time (tier-3: make-it-detectable).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

import {
  READINESS_SLA_MARGIN_SECONDS,
  readinessSlaSeconds,
  serviceCatalogById,
} from '../../platform/libs/service-catalog/src';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface ComposeHealthcheck {
  start_period?: unknown;
}
interface ComposeService {
  healthcheck?: ComposeHealthcheck;
}
interface ComposeFile {
  services?: Record<string, ComposeService>;
}
interface CriticalityManifest {
  defaults?: { readiness_sla_seconds?: unknown };
  services?: Array<{ name?: string; level?: string }>;
}

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as T;
}

/**
 * Parse a Docker Compose duration (start_period) into seconds. Compose
 * accepts e.g. `30s`, `2m`, `1m30s`, `500ms`, or a bare number (seconds).
 * Returns 0 for ms-only values (sub-second budgets are irrelevant here).
 */
function parseDurationSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') {
    throw new Error(`unparseable compose duration: ${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const unitSeconds = (unit: string): number => {
    switch (unit) {
      case 'h':
        return 3600;
      case 'm':
        return 60;
      case 's':
        return 1;
      case 'ms':
        return 0;
      default:
        throw new Error(`unexpected compose duration unit: ${unit}`);
    }
  };
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+)(ms|h|m|s)/g)) {
    if (amount === undefined || unit === undefined) continue;
    matched = true;
    total += Number(amount) * unitSeconds(unit);
  }
  if (!matched) {
    throw new Error(`unparseable compose duration: ${JSON.stringify(value)}`);
  }
  return total;
}

describe('deploy startup-budget SSoT', () => {
  const compose = readYaml<ComposeFile>('docker-compose.droplet.yml');
  const manifest = readYaml<CriticalityManifest>('infrastructure/deploy/service-criticality.yaml');
  const catalog = serviceCatalogById();

  it('derives readiness_sla_seconds = max(critical startupBudgetSeconds) + margin', () => {
    // The catalog is the SSoT; recompute from it and require the GENERATED
    // artifact to match. This is what stops the artifact from drifting away
    // from the catalog after a budget edit without a regenerate.
    const derived = readinessSlaSeconds();
    expect(manifest.defaults?.readiness_sla_seconds).toBe(derived);

    // And confirm the formula itself, so the derivation can't silently change
    // shape (e.g. someone switching max→sum or dropping the margin).
    const maxCriticalBudget = Math.max(
      ...(manifest.services ?? [])
        .filter((entry) => entry.level === 'critical')
        .map((entry) => {
          const cat = catalog.get(entry.name ?? '');
          if (!cat) throw new Error(`manifest critical service ${entry.name} not in catalog`);
          return cat.startupBudgetSeconds;
        }),
    );
    expect(derived).toBe(maxCriticalBudget + READINESS_SLA_MARGIN_SECONDS);
  });

  it('keeps every critical service start_period ≤ the derived readiness SLA', () => {
    const sla = readinessSlaSeconds();
    const violations: string[] = [];

    for (const entry of manifest.services ?? []) {
      if (entry.level !== 'critical' || !entry.name) continue;
      const startPeriodRaw = compose.services?.[entry.name]?.healthcheck?.start_period;
      // No healthcheck/start_period (Docker default 0s) trivially satisfies
      // the bound — some critical infra (postgres/redis) and the frontends
      // intentionally omit start_period.
      if (startPeriodRaw === undefined) continue;
      const startPeriod = parseDurationSeconds(startPeriodRaw);
      if (startPeriod > sla) {
        violations.push(`${entry.name}: start_period=${startPeriod}s > SLA=${sla}s`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('declares a positive startup budget for every active droplet service', () => {
    // Belt-and-suspenders mirror of validateServiceCatalog's rule, anchored to
    // the manifest-listed (active droplet) services so the deploy gate's
    // service set is provably budget-covered.
    const missing: string[] = [];
    for (const entry of manifest.services ?? []) {
      const cat = catalog.get(entry.name ?? '');
      if (!cat) continue;
      if (!(cat.startupBudgetSeconds > 0)) {
        missing.push(entry.name ?? '<unknown>');
      }
    }
    expect(missing).toEqual([]);
  });
});

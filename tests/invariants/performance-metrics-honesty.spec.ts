/**
 * The performance surface reports what it measured (ADMIN-HIGH-014,
 * OBS-CRITICAL-003).
 *
 * Every number on the Performance Dashboard was a plain `number`, and every
 * path that could not produce one filled in 0 — or, for the Apdex, 1.0. So an
 * unreachable database rendered as an idle healthy one, an unmeasured window
 * rendered as a perfect score, and neither could be told apart from a real
 * measurement by the operator or by the alert thresholds, which compared
 * fabricated zeros against their "less than" bounds and passed.
 *
 * The fix is a type: `number | null`, declared once beside the entity that
 * persists it, so a fabricated zero is a compile error rather than a habit.
 * This spec keeps that property from being quietly undone:
 *
 *   1. the measured shapes are declared ONCE, in the entity file — the service
 *      re-exports rather than re-declaring, which is how the jsonb column and
 *      the API response drifted apart in the first place;
 *   2. every field of the two measured shapes admits `null`;
 *   3. the specific fabrications that were removed do not come back;
 *   4. the in-memory request-metric path — a writer with zero callers feeding a
 *      per-minute job that drained a permanently empty Map — stays deleted.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTITY = 'apps/admin-api-service/src/system-management/entities/performance-metric.entity.ts';
const SERVICE =
  'apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts';
const PAGE = 'web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx';

/** Source with comments stripped — a docblock quoting a fabrication is not one. */
function code(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of an `export interface X { … }` declaration, or null. */
function interfaceBody(source: string, name: string): string | null {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  return match ? (match[1] as string) : null;
}

const MEASURED_SHAPES = ['ApplicationMetrics', 'DatabaseMetrics'] as const;

describe('INVARIANT (ADMIN-HIGH-014): the performance surface reports what it measured', () => {
  const entity = code(ENTITY);
  const service = code(SERVICE);

  it.each(MEASURED_SHAPES)('%s is declared once, beside the column that persists it', (name) => {
    expect(interfaceBody(entity, name)).not.toBeNull();
    // The service used to re-declare all three, so the jsonb column and the API
    // response could drift silently — and did.
    expect(interfaceBody(service, name)).toBeNull();
    expect(service).toMatch(new RegExp(`export type \\{[^}]*${name}`));
  });

  it.each(MEASURED_SHAPES)('every %s field admits null, so absence cannot be spelled 0', (name) => {
    const body = interfaceBody(entity, name);
    expect(body).not.toBeNull();

    const fields = [...(body as string).matchAll(/^\s*(\w+)\??:\s*([^;]+);/gm)];
    expect(fields.length).toBeGreaterThanOrEqual(6);
    const notNullable = fields
      .filter(([, , type]) => !/\bnull\b/.test(type as string))
      .map(([, field]) => `${name}.${field as string}`);
    expect(notNullable).toEqual([]);
  });

  it('the removed fabrications do not come back', () => {
    // Each of these was a literal in a SUCCESS path or a catch-all.
    for (const fabrication of [
      /avgQueryTime:\s*0\b/,
      /slowQueryCount:\s*0\b/,
      /poolSize:\s*100\b/,
      /apdexScore[^\n]*\|\|\s*1\b/,
    ]) {
      expect(service).not.toMatch(fabrication);
    }
  });

  it('the in-memory request-metric path stays deleted', () => {
    // `recordRequestMetric` had zero callers, so `aggregateRequestMetrics` ran
    // every minute over an empty Map and `getApplicationMetrics` then read the
    // rows it would have written. The RED data it duplicated is in Prometheus.
    for (const symbol of [
      'recordRequestMetric',
      'aggregateRequestMetrics',
      'this.requestMetrics',
    ]) {
      expect(service).not.toContain(symbol);
    }
  });

  it('the dashboard renders absence instead of inventing a zero', () => {
    const page = code(PAGE);
    // The page's own error path used to re-seed every panel with zeros.
    expect(page).toMatch(/function formatMetric\(/);
    expect(page).not.toMatch(/setDatabase\(\{[\s\S]*?activeConnections:\s*0/);
    expect(page).not.toMatch(/setInfrastructure\(\{[\s\S]*?cpuUsage:\s*0/);
  });
});

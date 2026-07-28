/**
 * APA-149 — the admin panel's `/analytics/*` types must match what the backend
 * actually returns.
 *
 * Ten of them never did. `getKpiComparisons` was typed `KpiComparison[]` against
 * a `Record<string, ComparisonDto>`, so the natural `.map(...)` throws;
 * `getSystemAnalytics` invented `cpuUsage`/`memoryUsage`/`diskUsage`;
 * `getFinancialMetrics` invented `cac`/`churnRate`; six endpoints returning
 * `ChartData` or `TimeSeriesData` were typed as flat arrays; and `TenantMetrics`
 * named a per-tenant row shape no endpoint has ever produced, colliding with the
 * aggregate the backend really sends and hiding the drift behind a familiar
 * name. None was reachable from a shipped page — the only reason nothing had
 * crashed — but they were exported, type-checked FALSE contracts, and a compiler
 * that lies is worse than no types at all.
 *
 * # Why a gate instead of a shared import
 *
 * The admin panel is a federated web remote and cannot import a backend
 * library: its tsconfig resolves only `@/*` and `@aquaculture/shared-ui`, and
 * the constraint is documented on `types/users.ts`, `types/billing.ts`,
 * `types/tenant.ts` and `api/messaging.ts`. So the contract is declared on both
 * sides and PINNED here — the same tier-3 pattern as the audit-severity and
 * data-request-status vocabulary gates.
 *
 * The gate compares FIELD NAMES per shape. That is the axis this finding is
 * about: every one of the ten defects was a field the backend does not send, or
 * a field it sends that the frontend never declared.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-149
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const BACKEND_ENTITY = readFileSync(
  join(REPO_ROOT, 'apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts'),
  'utf8',
);
const BACKEND_SERVICE = readFileSync(
  join(REPO_ROOT, 'apps/admin-api-service/src/analytics/services/analytics.service.ts'),
  'utf8',
);
const FRONTEND_TYPES = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/types/analytics.ts'),
  'utf8',
);
const FRONTEND_API = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/api/analytics.ts'),
  'utf8',
);

/**
 * The declared property names of an `interface X { … }` block.
 *
 * Nested object literals are skipped by tracking brace depth, so a field's own
 * sub-shape does not leak into its parent's key set.
 */
function interfaceFields(source: string, name: string, file: string): string[] {
  const header = new RegExp(`export interface ${name}\\s*\\{`);
  const match = header.exec(source);
  if (!match) {
    throw new Error(`interface ${name} not found in ${file}`);
  }

  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  do {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    index++;
  } while (depth > 0 && index < source.length);

  const body = source
    .slice(start + 1, index - 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const fields: string[] = [];
  let nesting = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (nesting === 0) {
      const field = /^(\w+)\??\s*:/.exec(trimmed);
      if (field?.[1]) fields.push(field[1]);
    }
    nesting += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return fields.sort();
}

/** Frontend shape ← backend shape, where the two names differ. */
const SHAPES: ReadonlyArray<{ frontend: string; backend: string; source: 'entity' | 'service' }> = [
  { frontend: 'TenantMetrics', backend: 'TenantMetrics', source: 'entity' },
  { frontend: 'UserMetrics', backend: 'UserMetrics', source: 'entity' },
  { frontend: 'FinancialMetrics', backend: 'FinancialMetrics', source: 'entity' },
  { frontend: 'AnalyticsSystemMetrics', backend: 'SystemMetrics', source: 'entity' },
  { frontend: 'UsageMetrics', backend: 'UsageMetrics', source: 'entity' },
  { frontend: 'ModuleUsageStats', backend: 'ModuleUsageStats', source: 'entity' },
  { frontend: 'ChartData', backend: 'ChartData', source: 'entity' },
  { frontend: 'TimeSeriesPoint', backend: 'TimeSeriesPoint', source: 'entity' },
  { frontend: 'TimeSeriesData', backend: 'TimeSeriesData', source: 'entity' },
  { frontend: 'TimeSeriesResponse', backend: 'TimeSeriesResponse', source: 'entity' },
  { frontend: 'ComparisonDto', backend: 'ComparisonDto', source: 'service' },
];

describe('admin-panel analytics contract parity (APA-149)', () => {
  it.each(SHAPES.map((shape) => [shape.frontend, shape]))(
    '%s carries exactly the fields the backend sends',
    (_name, shape) => {
      const backendSource = shape.source === 'entity' ? BACKEND_ENTITY : BACKEND_SERVICE;
      const backend = interfaceFields(backendSource, shape.backend, 'admin-api-service');
      const frontend = interfaceFields(FRONTEND_TYPES, shape.frontend, 'admin-panel');

      expect(frontend).toEqual(backend);
    },
  );

  it('never types a chart or trend endpoint as a flat array', () => {
    // Six endpoints return `ChartData` or `TimeSeriesData` and were declared as
    // arrays of ad-hoc row objects, which is the shape of the defect: an
    // inline `Array<{…}>` generic is a hand-authored guess by construction.
    const inlineArrayGenerics = [
      ...FRONTEND_API.matchAll(/apiFetch<\s*Array<\s*\{[^>]*\}\s*>\s*>/g),
    ].map((match) => match[0]);

    expect(inlineArrayGenerics).toEqual([]);
  });

  it('never types an endpoint with an inline object literal', () => {
    // `apiFetch<{ mrr: number; cac: number; … }>` is how `cac`, `churnRate`,
    // `cpuUsage`, `memoryUsage` and `diskUsage` entered the contract: fields
    // invented at the call site, with nothing to compare them against.
    const inlineObjectGenerics = [
      ...FRONTEND_API.matchAll(/apiFetch<\s*\{[^>]*\}\s*>/g),
    ].map((match) => match[0]);

    expect(inlineObjectGenerics).toEqual([]);
  });

  it('keeps the kpi-comparisons response keyed by metric, not listed', () => {
    // `.map` on the record the endpoint actually returns throws.
    expect(FRONTEND_TYPES).toMatch(
      /export type KpiComparisons = Record<string, ComparisonDto>/,
    );
    expect(BACKEND_SERVICE).toMatch(
      /getKpiComparisons\(\):\s*Promise<Record<string, ComparisonDto>>/,
    );
  });
});

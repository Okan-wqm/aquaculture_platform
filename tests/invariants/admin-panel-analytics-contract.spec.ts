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
 * UPDATE — the field-by-field comparison this gate used to run is GONE, and so
 * is the second copy it compared. `tools/codegen/admin-contracts` now emits
 * these shapes from the backend types and `services/types/analytics.ts`
 * re-exports them, so there is nothing to hold in agreement:
 * `admin-contracts-generated` checks the emitted file is current, and the
 * compiler does the rest.
 *
 * What survives here is the part codegen does NOT cover — the api layer's own
 * habit of inlining a guessed generic at the call site, which is how `cac`,
 * `churnRate`, `cpuUsage`, `memoryUsage` and `diskUsage` entered the contract
 * in the first place. An inline literal has no backend counterpart to generate
 * from, so it stays a lint-shaped rule.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-149
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const BACKEND_SERVICE = readFileSync(
  join(REPO_ROOT, 'apps/admin-api-service/src/analytics/services/analytics.service.ts'),
  'utf8',
);
// Still read for the one shape codegen does not own: `KpiComparisons` is
// `Record<string, ComparisonDto>`, which the backend expresses as a return type
// rather than a named export, so the panel legitimately names it itself.
const FRONTEND_TYPES = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/types/analytics.ts'),
  'utf8',
);
const FRONTEND_API = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/api/analytics.ts'),
  'utf8',
);

describe('admin-panel analytics contract parity (APA-149)', () => {
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

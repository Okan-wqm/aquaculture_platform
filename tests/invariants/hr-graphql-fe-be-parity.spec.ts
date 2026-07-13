/**
 * HR GraphQL FE↔BE Parity Invariant
 * ============================================================================
 *
 * SSoT: the hr-service subgraph (NestJS resolver decorators) defines the
 * GraphQL contract. Every root field the hr-module frontend requests MUST
 * resolve to a backend `@Query` / `@Mutation` / `@Subscription` / `@ResolveField`
 * field, or to an explicitly allowlisted cross-subgraph field served by another
 * service through Apollo Federation.
 *
 * Why this gate exists:
 *   hr-module had NO FE↔BE parity guard (only farm-module did). A hand-edited
 *   root-field name (or a resolver renamed on the backend without updating the
 *   FE) would render nothing in production with no build-time signal — the exact
 *   failure mode the farm gate was created for. This mirrors
 *   `farm-graphql-fe-be-parity.spec.ts` for the hr subgraph, consuming the same
 *   shared decorator-scan SSoT (`helpers/farm-graphql-surface`) so the two gates
 *   cannot drift apart.
 *
 * Scope: this validates ROOT operation fields (the query/mutation the FE names).
 * Nested-selection / field-shape drift is covered separately by the composed-
 * supergraph operation-validation gate (`scripts/ci/validate-graphql-operations`).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { REPO_ROOT, listFiles, extractBackendFieldSet } from './helpers/farm-graphql-surface';

const HR_BE_SOURCE_ROOT = 'apps/hr-service/src';
const FE_SOURCE_ROOT = 'web/modules/hr-module/src';

/**
 * Root fields hr-module legitimately requests from OTHER subgraphs via Apollo
 * Federation. Every entry names the owning subgraph so the allowlist stays
 * auditable; adding one requires that service to actually serve the field.
 */
const CROSS_SUBGRAPH_FIELDS: Record<string, string> = {
  // apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts —
  // hr-module resolves tenant users (e.g. to attribute an approver).
  tenantUsers: 'auth-service',
};

interface FrontendRootField {
  operation: string;
  field: string;
  file: string;
}

/** Extract the root field of every operation document in hr-module. */
function extractFrontendRootFields(): FrontendRootField[] {
  const roots: FrontendRootField[] = [];
  const re =
    /`\s*(query|mutation|subscription)\s+[A-Za-z0-9_]*\s*(?:\([^)]*\))?\s*\{\s*([A-Za-z0-9_]+)/g;

  for (const file of listFiles(FE_SOURCE_ROOT, ['**/*.ts', '**/*.tsx'])) {
    if (file.includes('.spec.') || file.includes('.test.') || file.includes('test-setup')) continue;
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      roots.push({ operation: match[1]!, field: match[2]!, file });
    }
  }
  return roots;
}

describe('hr-module ↔ hr-service GraphQL parity', () => {
  const backendFields = extractBackendFieldSet(HR_BE_SOURCE_ROOT);
  const frontendRoots = extractFrontendRootFields();

  it('backend extraction finds a plausible resolver surface (guards against silent extractor rot)', () => {
    // hr-service serves employee/payroll/leave/scheduling/training/finance
    // fields — dozens today. A collapse of the extractor to near-zero would make
    // the parity assertion below pass vacuously.
    expect(backendFields.size).toBeGreaterThan(30);
    // Canary fields spanning domains that must always exist.
    for (const canary of ['employees', 'payrolls', 'createEmployee', 'hrLabourCost']) {
      expect(backendFields).toContain(canary);
    }
  });

  it('frontend extraction finds a plausible operation surface', () => {
    expect(frontendRoots.length).toBeGreaterThan(20);
  });

  it('every frontend root field resolves to an hr-service resolver or an allowlisted federation field', () => {
    const unresolved = frontendRoots.filter(
      ({ field }) => !backendFields.has(field) && !(field in CROSS_SUBGRAPH_FIELDS),
    );

    const report = unresolved
      .map(({ operation, field, file }) => `  ${operation} { ${field} } ← ${file}`)
      .join('\n');

    expect(
      unresolved.length === 0
        ? ''
        : `\n${unresolved.length} frontend operation(s) target fields the hr subgraph does not serve.\n` +
            `Fix the field name, implement the resolver, or (for federation fields) extend CROSS_SUBGRAPH_FIELDS:\n${report}\n`,
    ).toBe('');
  });
});

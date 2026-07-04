/**
 * Farm GraphQL FE↔BE Parity Invariant
 * ============================================================================
 *
 * SSoT: the farm-service subgraph (NestJS resolver decorators) defines the
 * GraphQL contract. Every root field the farm-module frontend requests MUST
 * resolve to a backend `@Query` / `@Mutation` / `@Subscription` field (or to
 * an explicitly allowlisted cross-subgraph field served by another service
 * through Apollo Federation).
 *
 * Why this gate exists (2026-06-10 farm trio audit):
 *   - `useBatchFeedAssignments.ts` queried `batchFeedAssignmentForBatch`
 *     while the backend exposed `batchFeedAssignment` — the Batch Feeding
 *     tab silently rendered nothing in production. Hand-maintained field
 *     names had no build-time check against the subgraph.
 *   - Three "DEAD-CODE" queries (`feedingProgramStats`,
 *     `feedingProgramCalendar`, `availableProgramsForTank`) shipped to the
 *     bundle pointing at resolvers that never existed.
 *
 * The wrong state (an FE document naming a field the subgraph does not
 * serve) now fails CI instead of failing at runtime in the user's browser.
 *
 * Extraction notes:
 *   - BE: scans farm-service source for resolver decorators, honouring the
 *     `{ name: '...' }` option (e.g. `@Query(() => Species, { name:
 *     'speciesList' })`) and skipping interleaved decorators like @Roles.
 *   - FE: scans farm-module template literals for operation documents and
 *     takes each document's root field(s). Only documents that start a
 *     template literal (gql`…` or raw string queries handed to
 *     graphqlClient.request) are considered — this is the only query
 *     transport the module uses.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, listFiles, extractBackendFieldSet } from './helpers/farm-graphql-surface';

const FE_SOURCE_ROOT = 'web/modules/farm-module/src';

/**
 * Root fields the farm-module legitimately requests from OTHER subgraphs
 * via Apollo Federation. Every entry must name the owning subgraph so the
 * allowlist stays auditable. Adding an entry requires the owning service
 * to actually serve the field — verify before extending.
 */
const CROSS_SUBGRAPH_FIELDS: Record<string, string> = {
  // apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts
  tenantUsers: 'auth-service',
  // apps/sensor-service/src/registration/resolvers/registration.resolver.ts
  // farm-module's useSensors hook lists sensors to link a temperature sensor
  // to a tank/pond/cage at equipment create/edit time.
  sensors: 'sensor-service',
};

interface FrontendRootField {
  operation: string;
  field: string;
  file: string;
}

/** Extract the root field of every operation document in farm-module. */
function extractFrontendRootFields(): FrontendRootField[] {
  const roots: FrontendRootField[] = [];
  // Anchored to a template-literal start so prose/comments cannot produce
  // false roots. Allows optional leading whitespace/newline inside the
  // literal and an optional variable-definition list on the operation.
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

describe('farm-module ↔ farm-service GraphQL parity', () => {
  const backendFields = extractBackendFieldSet();
  const frontendRoots = extractFrontendRootFields();

  it('backend extraction finds a plausible resolver surface (guards against silent extractor rot)', () => {
    // farm-service serves 400+ fields today; a collapse of the extractor to
    // near-zero would make the parity assertion below pass vacuously.
    expect(backendFields.size).toBeGreaterThan(200);
    // Canary fields that must always exist — chosen across domains and
    // including a `{ name: … }`-renamed resolver to pin option parsing.
    for (const canary of ['batchFeedAssignment', 'speciesList', 'createBatch', 'closeBatch']) {
      expect(backendFields).toContain(canary);
    }
  });

  it('frontend extraction finds a plausible operation surface', () => {
    expect(frontendRoots.length).toBeGreaterThan(50);
  });

  it('every frontend root field resolves to a farm-service resolver or an allowlisted federation field', () => {
    const unresolved = frontendRoots.filter(
      ({ field }) => !backendFields.has(field) && !(field in CROSS_SUBGRAPH_FIELDS),
    );

    const report = unresolved
      .map(({ operation, field, file }) => `  ${operation} { ${field} } ← ${file}`)
      .join('\n');

    expect(
      unresolved.length === 0
        ? ''
        : `\n${unresolved.length} frontend operation(s) target fields the farm subgraph does not serve.\n` +
            `Fix the field name, implement the resolver, or (for federation fields) extend CROSS_SUBGRAPH_FIELDS:\n${report}\n`,
    ).toBe('');
  });

  it('allowlist entries stay backed by a real resolver in the owning service', () => {
    for (const [field, subgraph] of Object.entries(CROSS_SUBGRAPH_FIELDS)) {
      const hits = execFileSync('git', ['grep', '-l', field, '--', `apps/${subgraph}/src`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});

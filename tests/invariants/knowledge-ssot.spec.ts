/**
 * Knowledge SSoT Invariant
 * ============================================================================
 *
 * Closes the BLOCKER-1 concern from /root/.claude/plans/declarative-riding-shamir.md
 * and Phase 4 of /root/.claude/plans/abstract-brewing-mochi.md:
 *
 *   Knowledge layer (.claude/knowledge/layer-*.md) is the SSoT for tech
 *   versions, function signatures, counts, and architectural claims. Agent
 *   files reference via @-includes; they MUST NOT inline duplicate content.
 *
 *   This invariant asserts a LIGHTWEIGHT version of the BLOCKER-1 rule:
 *   specific factual claims in the knowledge layer are verified against
 *   the real repo state, preventing the SSoT from silently diverging from
 *   code. The complementary half of BLOCKER-1 — the shingle/contiguous-run
 *   duplication test that flags an agent inlining SSoT content instead of
 *   `@`-referencing it — is now IMPLEMENTED in
 *   `tests/invariants/agent-inlining-ssot.spec.ts` (WS3). That spec scans the
 *   full agent corpus against the knowledge + shared SSoT corpus; this spec
 *   remains the factual-claim half (counts / signatures stay code-aligned).
 *
 * # What this spec enforces
 *
 *   1. `createTenantQueryKey` signature claimed by layer-1-react.md matches
 *      the real export in web/shared-ui (Phase 0.4 fix regression guard).
 *
 *   2. SCHEMA_OWNING_SERVICES count claimed by layer-1-typeorm.md matches
 *      the real constant in tests/invariants/_constants.ts.
 *
 *   3. PER_TENANT_SCHEMA_SERVICES count claimed by layer-2-patterns.md
 *      matches the real constant.
 *
 *   4. Misfiled ADR count claimed by layer-3-adrs.md matches the actual
 *      count of files under docs/architecture/ADR-*.md.
 *
 *   5. CLAUDE.md service count matches the actual apps/ directory count.
 *
 * # When this spec fails
 *
 *   - A signature / count claim drifted in the knowledge file without a
 *     corresponding code change → update the knowledge file.
 *
 *   - Code evolved but knowledge file wasn't updated → update the knowledge
 *     file's claim to match reality.
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-0.4 (SSoT drift)
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-4 (invariant test)
 *   - /var/aqua-saas/docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-1
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SCHEMA_OWNING_SERVICES,
  PER_TENANT_SCHEMA_SERVICES,
} from './_constants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('knowledge SSoT invariant', () => {
  describe('layer-1-react.md claims match reality', () => {
    const knowledge = readFile('.claude/knowledge/layer-1-react.md');
    const realFactorySrc = readFile('web/shared-ui/src/utils/tenant-query-keys.ts');

    it('createTenantQueryKey: tenantId is the FIRST parameter (not queryKey)', () => {
      // Assert the real code has tenantId first
      expect(realFactorySrc).toMatch(/createTenantQueryKey\s*\(\s*\n?\s*tenantId:/);

      // Assert the knowledge layer documents tenantId first
      expect(knowledge).toMatch(/createTenantQueryKey\(tenantId,/);

      // Regression guard against the inverted signature
      expect(knowledge).not.toMatch(/createTenantQueryKey\(queryKey,\s*tenantId\)/);
    });
  });

  describe('layer-1-typeorm.md counts match _constants.ts', () => {
    const knowledge = readFile('.claude/knowledge/layer-1-typeorm.md');

    it('SCHEMA_OWNING_SERVICES count matches claim', () => {
      const claimedCountMatch = knowledge.match(
        /(\d+)\s+services per\s+`tests\/invariants\/_constants\.ts`/,
      );
      if (claimedCountMatch === null) {
        throw new Error(
          'layer-1-typeorm.md should cite SCHEMA_OWNING_SERVICES count like "13 services per `tests/invariants/_constants.ts`"',
        );
      }
      const [, countStr] = claimedCountMatch;
      expect(countStr).toBeDefined();
      expect(parseInt(countStr ?? '0', 10)).toBe(SCHEMA_OWNING_SERVICES.length);
    });
  });

  describe('layer-2-patterns.md counts match _constants.ts', () => {
    const knowledge = readFile('.claude/knowledge/layer-2-patterns.md');

    it('PER_TENANT_SCHEMA_SERVICES count matches claim', () => {
      // Expected count is 7; knowledge file says "Schema-per-tenant services (7)"
      const expected = PER_TENANT_SCHEMA_SERVICES.length;
      const pattern = new RegExp(`Schema-per-tenant services\\s*\\(${expected}\\)`);
      expect(knowledge).toMatch(pattern);
    });
  });

  describe('layer-3-adrs.md misfiled ADR count matches docs/architecture/', () => {
    const knowledge = readFile('.claude/knowledge/layer-3-adrs.md');

    it('claim matches actual count of misfiled ADR files', () => {
      const archDir = path.join(REPO_ROOT, 'docs', 'architecture');
      const misfiledAdrs = fs
        .readdirSync(archDir)
        .filter((f) => /^ADR-01[0-9]-.*\.md$/.test(f));
      const actualCount = misfiledAdrs.length;

      // Knowledge file says "Five files" (or whichever number)
      const numberWords: Record<number, string> = {
        3: 'Three',
        4: 'Four',
        5: 'Five',
        6: 'Six',
        7: 'Seven',
      };
      const expectedWord = numberWords[actualCount] ?? String(actualCount);
      const pattern = new RegExp(`\\b${expectedWord}\\s+files under\\s+\`docs/architecture`);
      expect(knowledge).toMatch(pattern);
    });
  });

  describe('layer-1-ai.md Claude Agent SDK version matches package.json', () => {
    it('SDK version anchor matches root package.json dependency', () => {
      const knowledge = readFile('.claude/knowledge/layer-1-ai.md');
      const pkg = JSON.parse(readFile('package.json'));
      const pkgVersion: string | undefined =
        pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ??
        pkg.devDependencies?.['@anthropic-ai/claude-agent-sdk'];
      if (!pkgVersion) {
        throw new Error(
          'package.json does not declare @anthropic-ai/claude-agent-sdk. ' +
            'Either remove the SDK anchor from layer-1-ai.md or add the dependency.',
        );
      }
      // Strip caret/tilde range prefix; knowledge shard references the bare
      // semver (e.g., "0.2.37") not the range form (e.g., "^0.2.37").
      const bare = pkgVersion.replace(/^[\^~]/, '');
      const escaped = bare.replace(/[.]/g, '\\.');
      const pattern = new RegExp(`Claude Agent SDK\\s+${escaped}|claude-agent-sdk@\\^?${escaped}`);
      if (!pattern.test(knowledge)) {
        throw new Error(
          `layer-1-ai.md does not cite the real SDK version ${bare} (from package.json). ` +
            `Either update the knowledge shard's **Anchor:** line or adjust the dependency.`,
        );
      }
      expect(knowledge).toMatch(pattern);
    });
  });

  describe('CLAUDE.md backend service count matches apps/ directory', () => {
    const claudeMd = readFile('CLAUDE.md');

    it('claimed service count matches real apps/ subdirectory count', () => {
      const appsDir = path.join(REPO_ROOT, 'apps');
      const realCount = fs
        .readdirSync(appsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .length;

      const claimMatch = claudeMd.match(
        /Backend Services \(`apps\/`\)\s*[—-]\s*(\d+)\s+services/,
      );
      if (claimMatch === null) {
        throw new Error(
          'CLAUDE.md should cite service count like "Backend Services (`apps/`) — 16 services"',
        );
      }
      const [, countStr] = claimMatch;
      expect(parseInt(countStr ?? '0', 10)).toBe(realCount);
    });
  });
});

/**
 * Agent Name Uniqueness Invariant
 * ============================================================================
 *
 * Closes Phase 1d of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-CRITICAL-001 defensive gate).
 *
 *   Every agent file's `name:` frontmatter must be globally unique across
 *   the active dispatch directories:
 *     - .claude/agents-enterprise-v2/   (Lane-A code-quality)
 *     - .claude/test-agents/            (Lane-B product-quality)
 *
 *   Collisions produce undefined `claude-agent` CLI resolution because the
 *   runner delegates name-to-path lookup to the binary with no disambig-
 *   uation logic (tools/scripts/orchestrator-runner.ts:261). This invariant
 *   is the Tier-3 detectable gate matching the Tier-1 intent ("make it
 *   impossible") that the CLI cannot enforce today.
 *
 *   `.claude/agents.legacy/**` is EXEMPT — that directory is explicitly
 *   dormant per its README ("No new work lands here. Dispatch is disabled")
 *   and intentionally holds pre-split historical copies whose `name:`
 *   frontmatter would duplicate active names. The invariant does not walk
 *   the legacy tree.
 *
 * # When this spec fails
 *
 *   - Two active agents share a `name:` frontmatter → rename one. Lane-B
 *     should use a `product-audit-*` prefix per the 2026-04-18 renaming
 *     convention; Lane-A keeps bare domain names.
 *
 *   - A deprecated agent file is still in an active directory with a valid
 *     `name:` → move to `.claude/agents.legacy/` or delete the file.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-1d
 *   - /var/aqua-saas/docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md#CLAUDE-CRITICAL-001
 *   - .claude/agents-enterprise-v2/_shared/handoff-protocol.md § Ownership grammar
 *   - .claude/agents.legacy/README.md (dormancy declaration)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ACTIVE_DIRS: readonly string[] = [
  path.join(REPO_ROOT, '.claude', 'agents-enterprise-v2'),
  path.join(REPO_ROOT, '.claude', 'test-agents'),
];

interface NameClaim {
  readonly name: string;
  readonly file: string;
}

function extractName(content: string): string | null {
  // Match the first YAML frontmatter line of the form `name: <value>`
  // within the leading `---` block. `.md` files without frontmatter return null.
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const [, block] = m;
  if (!block) return null;
  const nameLine = block.split('\n').find((l) => /^name:\s*/.test(l));
  if (!nameLine) return null;
  return nameLine.replace(/^name:\s*/, '').trim();
}

function walkMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'INVOCATION-PACK.md')
    .map((f) => path.join(dir, f));
}

function collectClaims(): NameClaim[] {
  const claims: NameClaim[] = [];
  for (const dir of ACTIVE_DIRS) {
    for (const file of walkMdFiles(dir)) {
      const content = fs.readFileSync(file, 'utf8');
      const name = extractName(content);
      if (name !== null) {
        claims.push({ name, file: path.relative(REPO_ROOT, file) });
      }
    }
  }
  return claims;
}

describe('agent name uniqueness invariant', () => {
  const claims = collectClaims();

  it('every agent file has a non-empty name: frontmatter', () => {
    const missing = ACTIVE_DIRS.flatMap((dir) =>
      walkMdFiles(dir).filter((file) => {
        const content = fs.readFileSync(file, 'utf8');
        return extractName(content) === null;
      }),
    );
    expect(missing.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('no two active agents share a name:', () => {
    const byName = new Map<string, string[]>();
    for (const claim of claims) {
      const existing = byName.get(claim.name) ?? [];
      existing.push(claim.file);
      byName.set(claim.name, existing);
    }

    const collisions: string[] = [];
    for (const [name, files] of byName.entries()) {
      if (files.length >= 2) {
        collisions.push(`name="${name}" appears in: ${files.join(', ')}`);
      }
    }

    if (collisions.length > 0) {
      const hint =
        'Rename one file\'s `name:` frontmatter. Lane-B (test-agents) should use a ' +
        '`product-audit-*` prefix per the 2026-04-18 convention; Lane-A keeps bare domain names. ' +
        'See /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-1a for the canonical renames.';
      throw new Error(`Name collisions detected:\n  - ${collisions.join('\n  - ')}\n\n${hint}`);
    }
    expect(collisions).toEqual([]);
  });

  it('legacy directory is exempt from this check (dormancy invariant)', () => {
    // Sanity: legacy README declares dormancy. If the file goes missing, the
    // exemption rationale disappears; update this invariant or the README.
    const legacyReadme = path.join(REPO_ROOT, '.claude', 'agents.legacy', 'README.md');
    expect(fs.existsSync(legacyReadme)).toBe(true);
    const content = fs.readFileSync(legacyReadme, 'utf8');
    expect(content).toMatch(/Dispatch is disabled/);
  });
});

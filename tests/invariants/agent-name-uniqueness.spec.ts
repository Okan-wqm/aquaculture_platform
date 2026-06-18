/**
 * Agent Name Uniqueness Invariant
 * ============================================================================
 *
 * Closes Phase 1d of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-CRITICAL-001 defensive gate).
 *
 *   Every agent file's `name:` frontmatter must be globally unique across
 *   the active dispatch directories:
 *     - .claude/agents/   (Lane-A code-quality)
 *     - .claude/agents/product-audit/            (Lane-B product-quality)
 *
 *   Collisions produce undefined Claude Code `Agent(subagent_type=...)`
 *   resolution because auto-discovery under `.claude/agents/` (recursive)
 *   keys on the `name:` frontmatter and the CLI does not guarantee
 *   deterministic resolution when two files declare the same name. This
 *   invariant is the Tier-3 detectable gate matching the Tier-1 intent
 *   ("make it impossible") that the CLI cannot enforce today.
 *
 *   Retired prompt directories must not exist on disk. Keeping old prompt
 *   copies beside the active dispatch tree reintroduces duplicate `name:`
 *   frontmatter, stale output contracts, and undefined Agent() resolution.
 *
 * # When this spec fails
 *
 *   - Two active agents share a `name:` frontmatter → rename one. Lane-B
 *     should use a `product-audit-*` prefix per the 2026-04-18 renaming
 *     convention; Lane-A keeps bare domain names.
 *
 *   - A deprecated agent file is still in an active directory with a valid
 *     `name:` → delete the retired copy after migrating any still-needed
 *     guidance into the active prompt.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-1d
 *   - /var/aqua-saas/docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md#CLAUDE-CRITICAL-001
 *   - .claude/shared/handoff-protocol.md § Ownership grammar
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ACTIVE_DIRS: readonly string[] = [
  path.join(REPO_ROOT, '.claude', 'agents'),
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
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '_shared') continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkMdFiles(full));
      continue;
    }
    if (entry.endsWith('.md') && entry !== 'README.md' && entry !== 'INVOCATION-PACK.md') {
      files.push(full);
    }
  }
  return files;
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
        'Rename one file\'s `name:` frontmatter. Lane-B product-audit agents should use a ' +
        '`product-audit-*` prefix per the 2026-04-18 convention; Lane-A keeps bare domain names. ' +
        'See /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-1a for the canonical renames.';
      throw new Error(`Name collisions detected:\n  - ${collisions.join('\n  - ')}\n\n${hint}`);
    }
    expect(collisions).toEqual([]);
  });

  it('retired prompt directories are absent from the active worktree', () => {
    for (const relPath of [
      '.claude/agents.legacy',
      '.claude/agents-enterprise-v2',
      '.claude/test-agents',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, relPath))).toBe(false);
    }
  });
});

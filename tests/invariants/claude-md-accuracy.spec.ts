/**
 * CLAUDE.md Accuracy Invariants
 * ============================================================================
 *
 * The CLAUDE.md / AGENTS.md steering files DIRECT Claude Code on every turn —
 * a stale path or a bloated file silently mis-directs every future agent
 * action. This spec makes steering-file rot DETECTABLE at CI time (the repo's
 * own Tier-3 principle applied to its own steering layer).
 *
 * Scope is deliberately narrow — it asserts ONLY what no other invariant owns:
 *   1. Path existence — every concrete repo path cited in a steering file
 *      resolves on disk (strip a leading `@`; skip globs/placeholders).
 *   2. Line budgets — root CLAUDE.md <= 200 lines; nested CLAUDE.md <= 80
 *      (Claude Code memory guidance: longer files reduce adherence).
 *   3. Nested hygiene — each nested CLAUDE.md carries a PROSE inheritance note
 *      (never an `@../../CLAUDE.md` import, which would double-load the
 *      always-loaded root), and no steering file resurrects a dead-terminology
 *      token (extends active-path-hygiene's root-only coverage to nested files).
 *
 * It does NOT re-assert the shared-schema table list (owned by
 * shared-schema-canonical.spec.ts + schema-invariants.spec.ts) nor the apps/
 * service count (owned by knowledge-ssot.spec.ts) — duplicating those would
 * violate the no-duplication rule the steering rewrite itself enforces.
 *
 * Worktree copies (.worktrees/, .codex-worktrees/, .claude/worktrees/) are
 * byte-identical checkouts of other branches and are excluded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { discoverSteeringFiles } from './_constants';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Top-level repo directories a real cited path can start with. */
const KNOWN_TOP_LEVEL = [
  'apps',
  'libs',
  'platform',
  'web',
  'sens-api-gateway',
  'sensorprotocols',
  'infrastructure',
  'tools',
  'scripts',
  'docs',
  'e2e',
  'tests',
  '.claude',
] as const;

// `(?<!@)` rejects npm-scope aliases like `@platform/cqrs` (the real dir is
// `platform/libs/cqrs`) and agent-body `@.claude/...` reader-bookmarks.
// `{}*<>` are inside the char class so glob/placeholder tokens
// (`.claude/knowledge/layer-{1,2,3}-*.md`, `apps/<svc>/...`) are captured
// whole and then self-skip via the `[*{}<>$]` guard below.
const PATH_RX = new RegExp(
  `(?<!@)(?:${KNOWN_TOP_LEVEL.map((d) => d.replace('.', '\\.')).join('|')})\\/[A-Za-z0-9._\\/{}*<>-]+`,
  'g',
);

/**
 * Dead-terminology tokens (dir/command form, unambiguous) that must never
 * reappear in a steering file. Mirrors tests/invariants/_constants.ts
 * DEAD_TERMINOLOGY_TOKENS; active-path-hygiene already guards root CLAUDE.md
 * + .claude/README.md — this extends the same guard to NESTED CLAUDE.md files.
 */
const DEAD_TOKENS = [
  'agents-enterprise-v2',
  'npx claude-agent',
  'tools/scripts/orchestrator-runner',
] as const;

function lineCount(content: string): number {
  return content.replace(/\n+$/, '').split('\n').length;
}

/** Concrete, checkable repo paths cited in a steering file. */
function extractCheckablePaths(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.match(PATH_RX) ?? []) {
    const cleaned = match.replace(/[)`.,;:]+$/g, '');
    // Skip globs, brace-sets, angle/variable placeholders, and ellipses.
    if (/[*{}<>$]/.test(cleaned) || cleaned.includes('...') || cleaned.includes('…')) {
      continue;
    }
    out.add(cleaned);
  }
  return [...out];
}

const steeringFiles = discoverSteeringFiles(REPO_ROOT);
const nestedFiles = steeringFiles.filter(
  (f) => f !== 'CLAUDE.md' && f !== 'AGENTS.md',
);

describe('CLAUDE.md accuracy invariants', () => {
  it('discovers the root steering files', () => {
    expect(steeringFiles).toContain('CLAUDE.md');
    expect(steeringFiles).toContain('AGENTS.md');
  });

  describe('every cited repo path exists', () => {
    for (const file of steeringFiles) {
      it(`${file}: all concrete cited paths resolve on disk`, () => {
        const content = readFileSync(join(REPO_ROOT, file), 'utf8');
        const missing = extractCheckablePaths(content).filter(
          (p) => !existsSync(join(REPO_ROOT, p)),
        );
        if (missing.length > 0) {
          throw new Error(
            `${file} cites paths that do not exist: ${missing.join(', ')}. ` +
              `Fix the reference or skip it (globs/placeholders are ignored).`,
          );
        }
      });
    }
  });

  describe('line budgets', () => {
    it('root CLAUDE.md is <= 200 lines', () => {
      const n = lineCount(readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8'));
      expect(n).toBeLessThanOrEqual(200);
    });

    it('each nested CLAUDE.md is <= 80 lines', () => {
      for (const f of nestedFiles) {
        const n = lineCount(readFileSync(join(REPO_ROOT, f), 'utf8'));
        if (n > 80) {
          throw new Error(`${f} is ${n} lines (nested budget is 80).`);
        }
      }
    });
  });

  describe('nested-file hygiene', () => {
    it('each nested CLAUDE.md carries a prose inheritance note (not an @import of root)', () => {
      for (const f of nestedFiles) {
        const content = readFileSync(join(REPO_ROOT, f), 'utf8');
        if (!/Root rules in `?\/?CLAUDE\.md`?/.test(content)) {
          throw new Error(
            `${f} is missing the inheritance note ("Root rules in /CLAUDE.md already apply").`,
          );
        }
        if (/@(\.\.\/)+CLAUDE\.md/.test(content)) {
          throw new Error(
            `${f} @-imports root CLAUDE.md — root is always loaded, so this double-loads it. ` +
              `Use a plain prose inheritance note instead.`,
          );
        }
      }
    });

    it('no steering file resurrects a dead-terminology token', () => {
      for (const f of steeringFiles) {
        const content = readFileSync(join(REPO_ROOT, f), 'utf8');
        for (const token of DEAD_TOKENS) {
          if (content.includes(token)) {
            throw new Error(`${f} contains dead-terminology token "${token}".`);
          }
        }
      }
    });
  });
});

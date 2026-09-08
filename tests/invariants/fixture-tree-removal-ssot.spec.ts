/**
 * Every recursive fixture-tree removal in the gate suites goes through
 * `tools/gates/fixture-tree.ts` (INFRA-HIGH-172).
 *
 * # What went wrong
 *
 * `invariants-fast` went red on a PR whose diff was admin-panel TypeScript and
 * one Markdown file:
 *
 *   FAIL backup-restore-verification-contract.spec.ts
 *     ● rejects a symlink entry in the protected runtime commit tree
 *       ENOTEMPTY: directory not empty, rmdir '/tmp/aqua-runtime-bundle-repo-2kLgwL/.git'
 *       at backup-restore-verification-contract.spec.ts:424
 *
 * Line 424 is the spec's own `finally { rmSync(root, { recursive: true, force:
 * true }) }`. Every assertion in the test had passed. The suite failed on
 * teardown, on a diff that could not reach it.
 *
 * # Why a whole gate for a teardown
 *
 * Recursive removal is not atomic: Node walks the tree with readdir + unlink
 * and closes each directory with `rmdir`, so any entry that appears in the
 * window between the walk and the `rmdir` surfaces as ENOTEMPTY. `force: true`
 * does not cover that — it suppresses ENOENT only. `maxRetries` is the option
 * Node documents for exactly EBUSY / EMFILE / ENFILE / ENOTEMPTY / EPERM, and
 * it is ignored unless `recursive` is set.
 *
 * At the time this gate was written there were 106 recursive removals across
 * `tests/invariants/**` and `tools/gates/**` and not one of them passed
 * `maxRetries`. So this was never one flaky spec. It was 106 teardowns each
 * able to redden an unrelated PR, in a suite whose entire job is to be the
 * signal people trust — and a gate that cries wolf on someone else's diff
 * teaches the team to re-run it, which is how a real failure gets waved
 * through. Fixing the one spec that happened to lose the race would have left
 * the other 105 loaded.
 *
 * The cure is the shape this repo already uses for a rule that was restated in
 * N places (INFRA-HIGH-152, `helpers/nx.ts`): one module owns the semantics,
 * and this spec keeps it the only way to spell it. A new fixture teardown is
 * correct because the only import available is already correct.
 *
 * # Scope
 *
 * `tests/invariants/**` and `tools/gates/**` — the two trees that run as gates
 * on every PR, where a teardown race costs a red check. Operator scripts
 * elsewhere under `tools/` are not covered: there a failed cleanup is a visible
 * error in front of the person who ran it, not a random CI result.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  FIXTURE_TREE_REMOVAL_MAX_RETRIES,
  FIXTURE_TREE_REMOVAL_RETRY_DELAY_MS,
} from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The module that owns the semantics, and the only file allowed to call `rmSync` recursively. */
const OWNER = 'tools/gates/fixture-tree.ts';

/** Trees that run as gates on every PR. */
const SCANNED_ROOTS = ['tests/invariants', 'tools/gates'] as const;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'fixtures', '__fixtures__', 'dist']);

/**
 * A recursive removal, in any spelling the two trees could use: `rmSync`,
 * `promises.rm`, and the `fs.rm` callback form all take the same options bag,
 * so the option is what identifies them rather than the function name.
 */
const RECURSIVE_REMOVAL = /\brm(?:Sync)?\(([^()]*?)\{[^{}]*\brecursive\s*:\s*true\b/g;

/**
 * Blank out comments, preserving newlines so reported line numbers stay true.
 *
 * Required, not cosmetic: this file's own docblock quotes the failing teardown
 * verbatim, and a gate that flags the explanation of why it exists is a gate
 * nobody can write.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  );
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(join(directory, entry.name));
        }
        continue;
      }
      if (entry.name.endsWith('.ts')) {
        found.push(join(directory, entry.name));
      }
    }
  };
  for (const root of SCANNED_ROOTS) {
    walk(join(REPO_ROOT, root));
  }
  return found;
}

describe('recursive fixture-tree removal is single-sourced', () => {
  it('has exactly one module calling a recursive rm, and it is the owner', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const repoPath = relative(REPO_ROOT, file).split('\\').join('/');
      if (repoPath === OWNER) {
        continue;
      }
      const source = withoutComments(readFileSync(file, 'utf8'));
      RECURSIVE_REMOVAL.lastIndex = 0;
      let match: RegExpExecArray | null = RECURSIVE_REMOVAL.exec(source);
      while (match !== null) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${repoPath}:${line}`);
        match = RECURSIVE_REMOVAL.exec(source);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('gives the owner a retry budget, which is the whole point of routing through it', () => {
    const owner = withoutComments(readFileSync(join(REPO_ROOT, OWNER), 'utf8'));
    RECURSIVE_REMOVAL.lastIndex = 0;
    const removals = owner.match(RECURSIVE_REMOVAL) ?? [];
    const retryBudgets = owner.match(/\bmaxRetries\s*:/g) ?? [];

    // Every recursive removal the owner performs carries a retry budget. Any
    // future helper added here is held to the same rule by counting, so the
    // check cannot be satisfied by one annotated call among several bare ones.
    expect(removals.length).toBeGreaterThan(0);
    expect(retryBudgets).toHaveLength(removals.length);
    expect(FIXTURE_TREE_REMOVAL_MAX_RETRIES).toBeGreaterThanOrEqual(1);
    expect(FIXTURE_TREE_REMOVAL_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1);
  });
});

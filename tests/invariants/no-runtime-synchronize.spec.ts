/**
 * Platform-wide invariant: dataSource.synchronize() is FORBIDDEN at runtime.
 *
 * Per CLAUDE.md, migrations are the single source of truth for DDL. The TypeORM
 * `synchronize()` method derives schema from entity metadata at process start,
 * which:
 *   - bypasses migration history,
 *   - cannot generate composite-key FK to partitioned tables (TypeORM 0.3.x
 *     limitation that surfaces as "no unique constraint matching given keys"
 *     for messages(id, createdAt)),
 *   - silently creates columns with WRONG nullability when the migration
 *     history would have arrived at NOT NULL via a backfill step.
 *
 * INFRA-CRITICAL-009 closed the SourceSchemaBootstrapService callsite.
 * This invariant locks the contract platform-wide so a future regression
 * (any service re-introducing synchronize) fails CI immediately.
 *
 * Allowed callsites (whitelisted): test setup files only (e2e harnesses
 * may legitimately use synchronize for spin-up of throwaway test DBs).
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files where synchronize() is legitimately allowed:
//  - **/test/**, **/tests/**, **/__tests__/**, *.spec.ts, *.test.ts
//  - migration / typeorm config files that DEFINE synchronize: false (a
//    *config* mention, not a runtime call — distinguished by the absence of
//    `dataSource.synchronize(`).
// Anything else flagged is a forbidden runtime call.
const ALLOWED_PATH_FRAGMENTS = [
  '/test/',
  '/tests/',
  '/__tests__/',
  '/e2e/',
  '/.test.',
  '/.spec.',
];

function isAllowed(filePath: string): boolean {
  return ALLOWED_PATH_FRAGMENTS.some((frag) => filePath.includes(frag));
}

describe('INVARIANT: no runtime dataSource.synchronize() callsites', () => {
  it('asserts every dataSource.synchronize() callsite lives under a test path', () => {
    // ripgrep returns lines like: path/file.ts:123:    await this.dataSource.synchronize();
    // We exclude node_modules, dist, .worktrees, and .claude/worktrees.
    let hits: string;
    try {
      // Match `await ... .synchronize(` to capture actual runtime calls and
      // exclude bare textual mentions inside comments / docs / data files.
      hits = execSync(
        `git -C ${REPO_ROOT} grep -nE 'await\\s+(this\\.)?\\w*\\.?dataSource\\.synchronize\\(|await\\s+\\w+\\.synchronize\\(' -- ` +
          `':!node_modules' ':!dist' ':!.worktrees' ':!.claude/worktrees' ` +
          `':!**/*.md' ':!**/*.jsonl' ':!**/*.json'`,
        { encoding: 'utf8' },
      );
    } catch (err) {
      // git grep exits 1 when no matches found — that's the all-clear case.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) return;
      throw err;
    }

    const forbidden = hits
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => {
        // Strip "<path>:<lineno>:" prefix to inspect the actual source line.
        const sourceLine = line.split(':').slice(2).join(':').trimStart();
        // Skip comment-only lines (docstring continuations, JS line comments).
        if (sourceLine.startsWith('*') || sourceLine.startsWith('//')) return false;
        const filePath = line.split(':')[0];
        return filePath ? !isAllowed(filePath) : false;
      });

    if (forbidden.length > 0) {
      const formatted = forbidden.map((l) => `  ${l}`).join('\n');
      throw new Error(
        `INFRA-CRITICAL-009 invariant VIOLATED — runtime dataSource.synchronize() callsites:\n${formatted}\n\n` +
          `Per CLAUDE.md, migrations are the single source of truth for DDL. Use a migration\n` +
          `runner (libs/backend-common/src/database/migration-runner) instead of synchronize().\n` +
          `If this is genuinely a test fixture, move the file under a /test/, /tests/, /__tests__/,\n` +
          `or /e2e/ path; the invariant whitelists those.`,
      );
    }
  });
});

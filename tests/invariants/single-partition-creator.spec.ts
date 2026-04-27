/**
 * Platform-wide invariant: PartitionManagerService is the SINGLE source of
 * truth for runtime partition creation.
 *
 * INFRA-CRITICAL-012 closed the messaging-service test fixture's redundant
 * partition creator. The same anti-pattern (test or runtime code creating
 * `<table>_y<year>m<month>` style partitions OUTSIDE the canonical
 * partition-manager service) bricks any deploy where the date ranges
 * overlap with the runtime creator's `<table>_<year>_<month>` partitions.
 *
 * Allowed callsites:
 *   - apps/*\/src/partition/partition-manager.service.ts — the canonical
 *     runtime SSoT.
 *   - apps/*\/src/migrations/**.ts — initial-schema migrations may create
 *     PARTITION OF as part of CREATE TABLE.
 *
 * Anything else (test fixture, controller, service, helper) is flagged.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files where `CREATE TABLE … PARTITION OF` is legitimately allowed:
//   - migrations/ — initial schema definitions (may create empty partitions)
//   - partition-manager.service.ts — runtime canonical creator
//   - test/__fixtures__ / test_data — pure SQL files used as readonly fixtures
const ALLOWED_PATH_FRAGMENTS = [
  '/migrations/',
  // The partition module (manager + helpers + queries) is the canonical
  // runtime SSoT. Any file under apps/*\/src/partition/ is whitelisted.
  '/src/partition/',
  '/__fixtures__/',
];

function isAllowed(filePath: string): boolean {
  return ALLOWED_PATH_FRAGMENTS.some((frag) => filePath.includes(frag));
}

describe('INVARIANT: only PartitionManagerService creates partitions at runtime', () => {
  it('asserts no non-canonical PARTITION OF callsites exist outside migrations or the manager', () => {
    let raw: string;
    try {
      raw = execSync(
        `git -C ${REPO_ROOT} grep -nE 'PARTITION OF[[:space:]]+' -- ` +
          `':!node_modules' ':!dist' ':!.worktrees' ':!.claude/worktrees' ` +
          `':!**/*.md' ':!**/*.jsonl' ':!**/*.json'`,
        { encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) return;
      throw err;
    }

    const forbidden = raw
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => {
        const sourceLine = line.split(':').slice(2).join(':').trimStart();
        if (sourceLine.startsWith('*') || sourceLine.startsWith('//')) return false;
        const filePath = line.split(':')[0];
        return filePath ? !isAllowed(filePath) : false;
      });

    if (forbidden.length > 0) {
      const formatted = forbidden.map((l) => `  ${l}`).join('\n');
      throw new Error(
        `INFRA-CRITICAL-012 invariant VIOLATED — non-canonical partition creators:\n${formatted}\n\n` +
          `Use PartitionManagerService for runtime partition creation. Initial-schema partitions\n` +
          `belong inside a migration. Test fixtures should NOT create partitions — the runtime\n` +
          `service handles them at app bootstrap.`,
      );
    }
  });
});

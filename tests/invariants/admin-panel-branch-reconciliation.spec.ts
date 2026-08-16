import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  compileReconciliationAuthority,
  DEFAULT_RECONCILIATION_AUTHORITY_PATH,
} from '../../tools/codegen/admin-contracts/reconciliation-compiler';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('admin-panel branch reconciliation compiler', () => {
  const compilation = compileReconciliationAuthority({
    repoRoot: REPO_ROOT,
    authorityPath: DEFAULT_RECONCILIATION_AUTHORITY_PATH,
  });

  it('derives the immutable commit sequence and all cardinalities from the JSON authority', () => {
    expect(compilation.authority.commits).toHaveLength(
      compilation.authority.auditedRange.commitCount,
    );
    expect(compilation.orderedCommitSequenceSha256).toBe(
      compilation.authority.auditedRange.orderedCommitSequenceSha256,
    );
    expect(compilation.dispositionCounts).toEqual(compilation.authority.dispositionCounts);
  });

  it('admits strict closure only when the authority has no unresolved commit', () => {
    if (compilation.unresolvedCommits.length === 0) {
      expect(() =>
        compileReconciliationAuthority({
          repoRoot: REPO_ROOT,
          authorityPath: DEFAULT_RECONCILIATION_AUTHORITY_PATH,
          requireClosed: true,
        }),
      ).not.toThrow();
      return;
    }

    expect(() =>
      compileReconciliationAuthority({
        repoRoot: REPO_ROOT,
        authorityPath: DEFAULT_RECONCILIATION_AUTHORITY_PATH,
        requireClosed: true,
      }),
    ).toThrow(`${compilation.unresolvedCommits.length} commits remain STILL_OPEN`);
  });
});

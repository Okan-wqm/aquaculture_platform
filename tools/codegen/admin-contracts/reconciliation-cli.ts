import { resolve } from 'node:path';

import {
  compileReconciliationAuthority,
  DEFAULT_RECONCILIATION_AUTHORITY_PATH,
} from './reconciliation-compiler';

const repoRoot = resolve(__dirname, '..', '..', '..');
const requireClosed = process.argv.includes('--require-closed');
const compilation = compileReconciliationAuthority({
  repoRoot,
  authorityPath: DEFAULT_RECONCILIATION_AUTHORITY_PATH,
  requireClosed,
});

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: compilation.authority.schemaVersion,
    commitCount: compilation.authority.commits.length,
    orderedCommitSequenceSha256: compilation.orderedCommitSequenceSha256,
    dispositionCounts: compilation.dispositionCounts,
    unresolvedCommitCount: compilation.unresolvedCommits.length,
  })}\n`,
);

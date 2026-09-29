import { createHash } from 'node:crypto';

import type { RepositoryExecutionSnapshot } from '../src/application/repository-execution-snapshot';

export function repositorySnapshotFixture(headSha: string): RepositoryExecutionSnapshot {
  const bytes = Buffer.from('reviewed snapshot fixture\n');
  return {
    head_sha: headSha,
    tree_sha: 'c'.repeat(40),
    files: [
      {
        path: 'reviewed.txt',
        mode: '100644',
        blob_sha: createHash('sha1')
          .update(Buffer.from(`blob ${bytes.byteLength}\0`))
          .update(bytes)
          .digest('hex'),
        content_sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      },
    ],
  };
}

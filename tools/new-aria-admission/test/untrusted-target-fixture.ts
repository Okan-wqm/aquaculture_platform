import {
  type RepositoryTargetPort,
  type VerifiedRepositoryTarget,
  verifyRepositoryTarget,
} from '../src/application/repository-target-verifier';

import { repositorySnapshotFixture } from './repository-snapshot-fixture';

const repositoryRoot = '/srv/new-aria/repository';

class CallerDefinedTargetPort implements RepositoryTargetPort {
  readonly git_tool_id = 'git-2.43.0';
  readonly git_sha256 = '9'.repeat(64);

  canonicalRoot(): string {
    return repositoryRoot;
  }

  resolveCommit(_root: string, ref: string): string {
    return ref.endsWith('/reviewed') ? 'b'.repeat(40) : '0'.repeat(40);
  }

  objectType(): string {
    return 'commit';
  }

  isAncestor(): boolean {
    return true;
  }

  mergeBase(): string {
    return 'a'.repeat(40);
  }

  captureExecutionSnapshot(): ReturnType<typeof repositorySnapshotFixture> {
    return repositorySnapshotFixture('b'.repeat(40));
  }
}

export function untrustedTarget(): VerifiedRepositoryTarget {
  return verifyRepositoryTarget(
    {
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      repository_root: repositoryRoot,
      reviewed_ref: 'refs/remotes/origin/reviewed',
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
    },
    new CallerDefinedTargetPort(),
  );
}

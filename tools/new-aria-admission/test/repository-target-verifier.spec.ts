import {
  assertVerifiedRepositoryTarget,
  RepositoryTargetPort,
  RepositoryTargetRequest,
  verifyRepositoryTarget,
} from '../src/application/repository-target-verifier';

import { repositorySnapshotFixture } from './repository-snapshot-fixture';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

class TargetPortFixture implements RepositoryTargetPort {
  readonly git_tool_id = 'git-2.43.0';
  readonly git_sha256 = '9'.repeat(64);
  canonical_root = '/srv/aria/repository';
  resolved_ref_sha = headSha;
  base_type = 'commit';
  head_type = 'commit';
  ancestor = true;
  merge_base_sha = baseSha;
  resolved_ref_reads = 0;
  final_ref_sha = headSha;

  canonicalRoot(): string {
    return this.canonical_root;
  }

  resolveCommit(): string {
    this.resolved_ref_reads += 1;
    return this.resolved_ref_reads === 1 ? this.resolved_ref_sha : this.final_ref_sha;
  }

  objectType(_repositoryRoot: string, objectSha: string): string {
    return objectSha === baseSha ? this.base_type : this.head_type;
  }

  isAncestor(): boolean {
    return this.ancestor;
  }

  mergeBase(): string {
    return this.merge_base_sha;
  }

  captureExecutionSnapshot() {
    return repositorySnapshotFixture(headSha);
  }
}

const targetRequest = (): RepositoryTargetRequest => ({
  repository_id: 'repo-1',
  workspace_id: 'workspace-1',
  repository_root: '/srv/aria/repository',
  reviewed_ref: 'refs/remotes/upstream/reviewed-change',
  base_sha: baseSha,
  head_sha: headSha,
});

describe('repository target verification', () => {
  it('binds an exact canonical reviewed ref to an existing descendant commit', () => {
    const result = verifyRepositoryTarget(targetRequest(), new TargetPortFixture());

    expect(result).toEqual({
      schema_version: '1.0.0',
      contract_id: 'new-aria-repository-target-v1',
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      git_tool_id: 'git-2.43.0',
      git_tool_sha256: '9'.repeat(64),
      tree_sha: 'c'.repeat(40),
      repository_root: '/srv/aria/repository',
      reviewed_ref: 'refs/remotes/upstream/reviewed-change',
      reviewed_ref_sha: headSha,
      base_sha: baseSha,
      head_sha: headSha,
      merge_base_sha: baseSha,
      ancestry: 'BASE_IS_ANCESTOR',
      verdict: 'ACCEPTED',
    });
  });

  it.each([
    ['short ref', { reviewed_ref: 'upstream/reviewed-change' }, /canonical reviewed ref/],
    [
      'revision expression',
      { reviewed_ref: 'refs/remotes/upstream/reviewed~1' },
      /canonical reviewed ref/,
    ],
    [
      'empty ref segment',
      { reviewed_ref: 'refs/remotes/upstream//reviewed' },
      /canonical reviewed ref/,
    ],
    ['relative root', { repository_root: 'repository' }, /absolute canonical path/],
    ['malformed repository ID', { repository_id: '../repo' }, /repository identifier/],
    ['malformed workspace ID', { workspace_id: 'workspace\0other' }, /workspace identifier/],
    ['same base and head', { head_sha: baseSha }, /empty target range/],
    ['uppercase SHA', { head_sha: 'B'.repeat(40) }, /head SHA/],
  ])('rejects %s before repository inspection', (_label, change, error) => {
    const request = { ...targetRequest(), ...change };
    expect(() => verifyRepositoryTarget(request, new TargetPortFixture())).toThrow(error);
  });

  it.each([
    ['a different canonical root', 'canonical_root', '/srv/aria/other', /canonical root/],
    ['a ref that moved away from head', 'resolved_ref_sha', 'c'.repeat(40), /reviewed ref/],
    ['a missing base commit', 'base_type', 'missing', /base object/],
    ['a non-commit head object', 'head_type', 'blob', /head object/],
    ['a non-ancestor base', 'ancestor', false, /not an ancestor/],
    ['a different merge base', 'merge_base_sha', 'd'.repeat(40), /merge base/],
  ])('fails closed for %s', (_label, field, value, error) => {
    const port = new TargetPortFixture();
    if (field === 'canonical_root' && typeof value === 'string') port.canonical_root = value;
    if (field === 'resolved_ref_sha' && typeof value === 'string') port.resolved_ref_sha = value;
    if (field === 'base_type' && typeof value === 'string') port.base_type = value;
    if (field === 'head_type' && typeof value === 'string') port.head_type = value;
    if (field === 'ancestor' && typeof value === 'boolean') port.ancestor = value;
    if (field === 'merge_base_sha' && typeof value === 'string') port.merge_base_sha = value;

    expect(() => verifyRepositoryTarget(targetRequest(), port)).toThrow(error);
  });

  it('rejects a reviewed ref that moves after ancestry inspection', () => {
    const port = new TargetPortFixture();
    port.final_ref_sha = baseSha;

    expect(() => verifyRepositoryTarget(targetRequest(), port)).toThrow(/changed during/);
    expect(port.resolved_ref_reads).toBe(2);
  });

  it('rejects a structurally identical target that bypassed the verifier', () => {
    const verified = verifyRepositoryTarget(targetRequest(), new TargetPortFixture());

    expect(() => assertVerifiedRepositoryTarget(verified)).not.toThrow();
    expect(() => assertVerifiedRepositoryTarget({ ...verified })).toThrow(/not verifier-issued/);
  });
});

import {
  canonicalExecutionCwd,
  resolveExecutionIdentity,
  snapshotBaseExecutionArguments,
  snapshotExecutionArguments,
} from '../src/runtime/execution-identity';

function identity(repositoryId: string, workspaceId: string) {
  return resolveExecutionIdentity({
    repository_id: repositoryId,
    workspace_id: workspaceId,
    tool_id: 'verifier',
    input_reference_bundle_sha256: '1'.repeat(64),
    input_envelope_sha256: '2'.repeat(64),
    input_object_sha256s: ['3'.repeat(64)],
  });
}

describe('execution argument policy', () => {
  it.each([
    ['too many arguments', Array.from({ length: 63 }, () => 'x')],
    ['oversized argument', ['x'.repeat(4_097)]],
    ['oversized aggregate', Array.from({ length: 31 }, () => 'x'.repeat(1_024))],
    ['C1 control', ['unsafe\u0085text']],
    ['bidi control', ['unsafe\u061ctext']],
  ])('rejects %s before process execution', (_label, args) => {
    expect(() => snapshotExecutionArguments(args)).toThrow(/arguments/);
  });

  it('returns an immutable defensive argument snapshot', () => {
    const source = ['--mode', 'full'];
    const result = snapshotExecutionArguments(source);
    source[1] = 'mutated';

    expect(result).toEqual(['--mode', 'full']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('reserves count headroom for the negative-control suffix before baseline execution', () => {
    expect(snapshotBaseExecutionArguments(Array.from({ length: 60 }, () => 'x'))).toHaveLength(60);
    expect(() => snapshotBaseExecutionArguments(Array.from({ length: 61 }, () => 'x'))).toThrow(
      /headroom/,
    );
    expect(() => snapshotBaseExecutionArguments(Array.from({ length: 62 }, () => 'x'))).toThrow(
      /headroom/,
    );
  });
});

describe('logical execution identity', () => {
  it('uses one canonical percent-encoded authority identity', () => {
    expect(canonicalExecutionCwd('repo-1/sub', 'workspace:blue')).toBe(
      'workspace://repo-1%2Fsub/workspace%3Ablue',
    );
  });

  it('domain-separates repository and workspace components containing separators', () => {
    const left = identity('a/b', 'c');
    const right = identity('a', 'b/c');

    expect(left.logical_cwd).not.toBe(right.logical_cwd);
    expect(left.logical_cwd_sha256).not.toBe(right.logical_cwd_sha256);
  });
});

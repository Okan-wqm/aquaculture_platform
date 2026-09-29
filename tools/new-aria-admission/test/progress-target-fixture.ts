export interface ProgressTargetFixture {
  readonly reviewed_ref: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly git_tool_id: string;
  readonly git_tool_sha256: string;
}

export const defaultProgressTarget = (): ProgressTargetFixture => ({
  reviewed_ref: 'refs/remotes/origin/main',
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  git_tool_id: 'git-2.43.0',
  git_tool_sha256: '9'.repeat(64),
});

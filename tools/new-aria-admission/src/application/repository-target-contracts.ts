import type { RepositoryExecutionSnapshot } from './repository-execution-snapshot';

export interface RepositoryTargetRequest {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly repository_root: string;
  readonly reviewed_ref: string;
  readonly base_sha: string;
  readonly head_sha: string;
}

export interface RepositoryTargetPort {
  readonly git_tool_id: string;
  readonly git_sha256: string;
  canonicalRoot(repositoryRoot: string): string;
  resolveCommit(repositoryRoot: string, ref: string): string;
  objectType(repositoryRoot: string, objectSha: string): string;
  isAncestor(repositoryRoot: string, ancestorSha: string, descendantSha: string): boolean;
  mergeBase(repositoryRoot: string, leftSha: string, rightSha: string): string;
  captureExecutionSnapshot(repositoryRoot: string, headSha: string): RepositoryExecutionSnapshot;
}

export interface VerifiedRepositoryTarget {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-repository-target-v1';
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly git_tool_id: string;
  readonly git_tool_sha256: string;
  readonly tree_sha: string;
  readonly repository_root: string;
  readonly reviewed_ref: string;
  readonly reviewed_ref_sha: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly merge_base_sha: string;
  readonly ancestry: 'BASE_IS_ANCESTOR';
  readonly verdict: 'ACCEPTED';
}

export interface RepositoryExecutionCapability {
  readonly snapshot: RepositoryExecutionSnapshot;
  revalidate(): void;
}

export interface RepositoryExecutionReservation {
  readonly contract_id: 'new-aria-repository-execution-reservation-v1';
}

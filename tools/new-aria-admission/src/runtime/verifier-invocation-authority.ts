import { createHash } from 'node:crypto';

import type { RepositoryTargetRequest } from '../application/repository-target-verifier';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import type {
  LoadedVerifierInvocation,
  VerifierInvocationDescriptor,
} from './verifier-invocation-request';
import { canonicalExecutionCwd } from './execution-identity';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
type VerifiedProgressAuthority =
  | AuthorizedS01ProgressAuthority
  | HistoricallyVerifiedS01ProgressAuthority;

export function assertGitToolAuthority(
  authority: VerifiedProgressAuthority,
  gitSha256: string,
): void {
  const document = authority.authority.document;
  if (document.git_tool_id !== 'git' || gitSha256 !== document.git_tool_sha256) {
    throw new TypeError('request-selected Git executable does not match signed authority');
  }
}

export function assertRepositoryTargetRequestAuthority(
  authority: VerifiedProgressAuthority,
  target: RepositoryTargetRequest,
  gitSha256: string,
): void {
  const document = authority.authority.document;
  assertGitToolAuthority(authority, gitSha256);
  if (
    target.repository_id !== document.repository_id ||
    target.workspace_id !== document.workspace_id ||
    target.reviewed_ref !== document.reviewed_ref ||
    target.base_sha !== document.base_sha ||
    target.head_sha !== document.head_sha
  ) {
    throw new TypeError('repository target request does not match signed progress authority');
  }
}

export function assertVerifierInvocationDescriptorAuthority(
  authority: AuthorizedS01ProgressAuthority,
  target: RepositoryTargetRequest,
  invocation: VerifierInvocationDescriptor,
): void {
  const document = authority.authority.document;
  const runtimeId = `node@${process.version}`;
  const logicalCwd = canonicalExecutionCwd(target.repository_id, target.workspace_id);
  const expectedRuns = ['BASELINE', ...document.required_negative_control_ids];
  const actualRuns = invocation.runs.map((run) => run.run_id);
  assertRepositoryTargetRequestAuthority(authority, target, invocation.git_sha256);
  if (
    invocation.tool_id !== document.verifier_tool_id ||
    invocation.tool_sha256 !== document.verifier_sha256 ||
    invocation.runtime_sha256 !== document.toolchain_sha256 ||
    runtimeId !== document.runtime_id ||
    digest(canonicalJsonBytes([runtimeId, invocation.tool_id, ...invocation.args])) !==
      document.verifier_argv_sha256 ||
    digest(Buffer.from(logicalCwd)) !== document.execution_cwd_sha256 ||
    actualRuns.length !== expectedRuns.length ||
    actualRuns.some((runId, index) => runId !== expectedRuns[index])
  ) {
    throw new TypeError('verifier invocation does not match signed progress authority');
  }
}

export function assertVerifierInvocationResourceAuthority(
  authority: AuthorizedS01ProgressAuthority,
  invocation: LoadedVerifierInvocation,
): void {
  assertProgressTrustRootAuthority(
    authority,
    invocation.execution_trust_root_bytes,
    invocation.evidence_trust_root_bytes,
  );
}

export function assertProgressTrustRootAuthority(
  authority: VerifiedProgressAuthority,
  executionTrustRootBytes: Uint8Array,
  evidenceTrustRootBytes: Uint8Array,
): void {
  const document = authority.authority.document;
  if (
    digest(executionTrustRootBytes) !== document.execution_trust_root_sha256 ||
    digest(evidenceTrustRootBytes) !== document.evidence_trust_root_sha256
  )
    throw new TypeError('verifier trust roots do not match signed progress authority');
}

export function assertExecutionTrustRootAuthority(
  authority: VerifiedProgressAuthority,
  executionTrustRootBytes: Uint8Array,
): void {
  if (digest(executionTrustRootBytes) !== authority.authority.document.execution_trust_root_sha256)
    throw new TypeError('execution trust root does not match signed progress authority');
}

export function assertVerifierInvocationAuthority(
  authority: AuthorizedS01ProgressAuthority,
  target: RepositoryTargetRequest,
  invocation: LoadedVerifierInvocation,
): void {
  assertVerifierInvocationDescriptorAuthority(authority, target, invocation);
  assertVerifierInvocationResourceAuthority(authority, invocation);
}

import { createHash } from 'node:crypto';

import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import { canonicalExecutionCwd } from './execution-identity';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function assertExecutionSessionAuthority(
  authority: AuthorizedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  signingCapability: ExecutionSigningCapability,
): void {
  const document = authority.authority.document;
  if (
    target.repository_id !== document.repository_id ||
    target.workspace_id !== document.workspace_id ||
    target.base_sha !== document.base_sha ||
    target.head_sha !== document.head_sha ||
    target.git_tool_id !== document.git_tool_id ||
    target.git_tool_sha256 !== document.git_tool_sha256 ||
    signingCapability.execution_session_id !== document.execution_session_id ||
    signingCapability.trust_root_sha256 !== document.execution_trust_root_sha256
  ) {
    throw new TypeError('repository execution session does not match signed authority');
  }
}

export interface AuthorizedRunInvocation {
  readonly run_id: string;
  readonly tool_id: string;
  readonly tool_sha256: string;
  readonly runtime_sha256: string;
  readonly args: readonly string[];
}

export function assertExecutionRunAuthority(
  authority: AuthorizedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  invocation: AuthorizedRunInvocation,
): void {
  const document = authority.authority.document;
  const negativeSuffix = invocation.args.slice(-2);
  const baselineArgs =
    invocation.run_id === 'BASELINE' ? invocation.args : invocation.args.slice(0, -2);
  const argv = [`node@${process.version}`, invocation.tool_id, ...baselineArgs];
  const cwd = canonicalExecutionCwd(target.repository_id, target.workspace_id);
  if (
    invocation.tool_id !== document.verifier_tool_id ||
    invocation.tool_sha256 !== document.verifier_sha256 ||
    invocation.runtime_sha256 !== document.toolchain_sha256 ||
    (invocation.run_id !== 'BASELINE' &&
      (negativeSuffix[0] !== '--negative-control' || negativeSuffix[1] !== invocation.run_id)) ||
    `node@${process.version}` !== document.runtime_id ||
    digest(canonicalJsonBytes(argv)) !== document.verifier_argv_sha256 ||
    digest(Buffer.from(cwd)) !== document.execution_cwd_sha256
  ) {
    throw new TypeError('verifier process invocation does not match signed authority');
  }
}

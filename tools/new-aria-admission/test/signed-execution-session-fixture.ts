import type { VerifiedRepositoryTarget } from '../src/application/repository-target-verifier';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { readFileSync } from 'node:fs';
import {
  finalizeExecutableRun,
  openRepositoryExecutionSession,
} from '../src/runtime/executable-runner';
import type {
  PendingExecutableRun,
  RepositoryExecutionSession,
} from '../src/runtime/executable-runner';
import {
  attestExecutableRun,
  loadExecutionSigningCapability,
} from '../src/runtime/execution-signer';
import type { ExecutionSigningCapability } from '../src/runtime/execution-signer';
import { canonicalExecutionCwd } from '../src/runtime/execution-identity';

import { trustRootBytes } from './attestation-fixture';
import {
  authorizedExecutionAuthority,
  executionPrivateKeyBytes,
  executionTrustRootBytes,
} from './execution-receipt-fixture';
import { digest } from './operator-authority-fixture';
import { operatorEnvelopeBytes, operatorTrustRootBytes } from './operator-authority-fixture';
import { currentEpochProviderFixture, currentEpochStoreFixture } from './current-epoch-fixture';

export interface TestExecutionSession {
  readonly authority: ReturnType<typeof authorizedExecutionAuthority>;
  readonly capability: ExecutionSigningCapability;
  readonly target: VerifiedRepositoryTarget;
  readonly session: RepositoryExecutionSession;
  readonly authentication_objects: readonly Buffer[];
}

export function openTestExecutionSession(
  target: VerifiedRepositoryTarget,
  toolId: string,
  toolSha256: string,
  runtimeSha256: string,
  args: readonly string[],
): TestExecutionSession {
  const runtimeId = `node@${process.version}`;
  const logicalCwd = canonicalExecutionCwd(target.repository_id, target.workspace_id);
  const operatorRoot = operatorTrustRootBytes();
  const epochStore = currentEpochStoreFixture(operatorRoot);
  const authority = authorizedExecutionAuthority({
    base_sha: target.base_sha,
    head_sha: target.head_sha,
    verifier_tool_id: toolId,
    verifier_sha256: toolSha256,
    verifier_argv_sha256: digest(canonicalJsonBytes([runtimeId, toolId, ...args])),
    runtime_id: runtimeId,
    toolchain_sha256: runtimeSha256,
    execution_cwd_sha256: digest(Buffer.from(logicalCwd)),
    git_tool_id: target.git_tool_id,
    git_tool_sha256: target.git_tool_sha256,
    ...epochStore.authority,
  });
  const executionRoot = executionTrustRootBytes();
  const capability = loadExecutionSigningCapability({
    authority,
    trust_root_bytes: executionRoot,
    evidence_trust_root_bytes: trustRootBytes(),
    private_key_pkcs8_der: executionPrivateKeyBytes(),
  });
  const currentEpoch = currentEpochProviderFixture(authority, operatorRoot, epochStore);
  const operatorEnvelope = operatorEnvelopeBytes({
    authorityBytes: canonicalJsonBytes(authority.authority.document),
  });
  const session = openRepositoryExecutionSession({
    authority,
    target,
    signing_capability: capability,
    execution_trust_root_bytes: executionRoot,
    current_epoch_provider: currentEpoch.provider,
  });
  return {
    authority,
    capability,
    target,
    session,
    authentication_objects: Object.freeze([
      operatorEnvelope,
      operatorRoot,
      readFileSync(currentEpoch.snapshot_path),
    ]),
  };
}

export function finalizeTestRun(context: TestExecutionSession, pending: PendingExecutableRun) {
  const receipt = attestExecutableRun(context.capability, {
    authority: context.authority,
    target: context.target,
    run: pending,
  });
  return finalizeExecutableRun(context.session, pending, receipt);
}

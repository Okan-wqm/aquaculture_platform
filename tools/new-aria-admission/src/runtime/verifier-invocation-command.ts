import { GitRepositoryTargetPort } from '../adapters/git/git-repository-target-port';
import { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import { verifyRepositoryTarget } from '../application/repository-target-verifier';
import { authorizeS01ProgressAuthority } from '../kernel/operator-progress-authority';

import { readCanonicalFile } from './canonical-files';
import type { CliCommand } from './cli-arguments';
import { ExecutableRunBundlePublication } from './executable-run-bundle';
import { recoverExistingExecutableRunBundle } from './executable-run-bundle-recovery';
import { verifyStagedExecutableRunBundle } from './executable-run-bundle-verifier';
import {
  abortRepositoryExecutionSession,
  closeRepositoryExecutionSession,
  finalizeExecutableRun,
  openRepositoryExecutionSession,
  runVerifierExecutable,
} from './executable-runner';
import type { RepositoryExecutionSession } from './executable-runner';
import {
  attestExecutableRun,
  loadExecutionSigningCapability,
  revokeExecutionSigningCapability,
} from './execution-signer';
import type { ExecutionSigningCapability } from './execution-signer';
import { loadRepositoryTargetRequest } from './repository-target-request';
import { runtimeTemporaryRoot } from './runtime-temporary-root';
import {
  assertPhysicalMutationBoundary,
  assertPhysicalPathSeparation,
  assertSafeTemporaryParent,
} from './physical-publication-boundary';
import {
  assertExecutionTrustRootAuthority,
  assertVerifierInvocationDescriptorAuthority,
  assertVerifierInvocationResourceAuthority,
} from './verifier-invocation-authority';
import {
  loadVerifierInvocationResources,
  parseVerifierInvocationDescriptor,
} from './verifier-invocation-request';
import type { LoadedVerifierInvocation } from './verifier-invocation-request';

type RunVerifierCommand = Extract<CliCommand, { readonly kind: 'run-verifier' }>;

export function executeVerifierInvocationCommand(command: RunVerifierCommand): void {
  const descriptor = parseVerifierInvocationDescriptor(
    readCanonicalFile(command.request_path, 'verifier invocation descriptor'),
  );
  const operatorTrustRootBytes = readCanonicalFile(
    descriptor.operator_trust_root_path,
    'operator progress trust root',
    1024 * 1024,
  );
  const authority = authorizeS01ProgressAuthority({
    envelope_bytes: readCanonicalFile(
      descriptor.operator_envelope_path,
      'operator progress authority envelope',
      1024 * 1024,
    ),
    trust_root_bytes: operatorTrustRootBytes,
    expected_trust_root_sha256: command.operator_trust_root_sha256,
  });
  const targetRequest = loadRepositoryTargetRequest(
    readCanonicalFile(descriptor.target_request_path, 'repository target request'),
  );
  assertVerifierInvocationDescriptorAuthority(authority, targetRequest, descriptor);
  const mutationPaths = [command.bundle_path, command.current_epoch_root] as const;
  const protectedPaths = [
    command.request_path,
    targetRequest.repository_root,
    descriptor.target_request_path,
    descriptor.git_path,
    descriptor.operator_envelope_path,
    descriptor.operator_trust_root_path,
    descriptor.execution_trust_root_path,
    descriptor.evidence_trust_root_path,
    descriptor.execution_private_key_path,
    descriptor.tool_path,
    ...descriptor.runs.map(({ input_envelope_path: path }) => path),
  ];
  assertPhysicalPathSeparation(mutationPaths, protectedPaths);
  assertPhysicalMutationBoundary(targetRequest.repository_root, mutationPaths);
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [
    targetRequest.repository_root,
    ...mutationPaths,
  ]);
  const executionTrustRootBytes = readCanonicalFile(
    descriptor.execution_trust_root_path,
    'execution trust root',
    1024 * 1024,
  );
  assertExecutionTrustRootAuthority(authority, executionTrustRootBytes);
  let request: LoadedVerifierInvocation | undefined;
  let publication: ExecutableRunBundlePublication | undefined;
  let currentEpochProvider: FileCurrentEpochProvider | undefined;
  try {
    currentEpochProvider = new FileCurrentEpochProvider({
      state_root: command.current_epoch_root,
      provider_id: authority.authority.document.invalidation_epoch_provider_id,
      operator_trust_root_bytes: operatorTrustRootBytes,
      expected_operator_trust_root_sha256: command.operator_trust_root_sha256,
    });
    const target = verifyRepositoryTarget(
      targetRequest,
      new GitRepositoryTargetPort({
        executable_path: descriptor.git_path,
        executable_sha256: descriptor.git_sha256,
      }),
    );
    if (
      recoverExistingExecutableRunBundle({
        bundle_path: command.bundle_path,
        authority,
        target,
        execution_trust_root_bytes: executionTrustRootBytes,
        current_epoch_provider: currentEpochProvider,
      })
    )
      return;
    request = loadVerifierInvocationResources(descriptor);
    assertVerifierInvocationResourceAuthority(authority, request);
    const capability: ExecutionSigningCapability = loadExecutionSigningCapability({
      authority,
      trust_root_bytes: request.execution_trust_root_bytes,
      evidence_trust_root_bytes: request.evidence_trust_root_bytes,
      private_key_pkcs8_der: request.execution_private_key_bytes,
    });
    executeFreshSession(
      command,
      request,
      authority,
      target,
      capability,
      currentEpochProvider,
      operatorTrustRootBytes,
      (value) => {
        publication = value;
      },
    );
  } catch (error) {
    publication?.abort();
    throw error;
  } finally {
    request?.execution_private_key_bytes.fill(0);
    currentEpochProvider?.close();
  }
}

function executeFreshSession(
  command: RunVerifierCommand,
  request: LoadedVerifierInvocation,
  authority: Parameters<typeof openRepositoryExecutionSession>[0]['authority'],
  target: Parameters<typeof openRepositoryExecutionSession>[0]['target'],
  capability: ExecutionSigningCapability,
  currentEpochProvider: FileCurrentEpochProvider,
  operatorTrustRootBytes: Uint8Array,
  setPublication: (value: ExecutableRunBundlePublication) => void,
): void {
  let session: RepositoryExecutionSession | undefined;
  let capabilityRequiresRevocation = true;
  try {
    session = openRepositoryExecutionSession({
      authority,
      target,
      signing_capability: capability,
      execution_trust_root_bytes: request.execution_trust_root_bytes,
      current_epoch_provider: currentEpochProvider,
    });
    capabilityRequiresRevocation = false;
    const publication = new ExecutableRunBundlePublication(command.bundle_path);
    setPublication(publication);
    for (const run of request.runs) {
      const args =
        run.run_id === 'BASELINE'
          ? request.args
          : [...request.args, '--negative-control', run.run_id];
      const pending = runVerifierExecutable({
        session,
        run_id: run.run_id,
        run_context_sha256: run.run_context_sha256,
        tool_path: request.tool_path,
        tool_sha256: request.tool_sha256,
        runtime_sha256: request.runtime_sha256,
        tool_id: request.tool_id,
        input_envelope_bytes: run.input_envelope_bytes,
        args,
      });
      const receipt = attestExecutableRun(capability, { authority, target, run: pending });
      finalizeExecutableRun(session, pending, receipt);
    }
    const roster = closeRepositoryExecutionSession(session);
    session = undefined;
    publication.stageSession(roster);
    const verifierProvider = new FileCurrentEpochProvider({
      state_root: command.current_epoch_root,
      provider_id: authority.authority.document.invalidation_epoch_provider_id,
      operator_trust_root_bytes: operatorTrustRootBytes,
      expected_operator_trust_root_sha256: command.operator_trust_root_sha256,
    });
    try {
      publication.completeSession(
        verifyStagedExecutableRunBundle({
          bundle_path: command.bundle_path,
          authority,
          target,
          execution_trust_root_bytes: request.execution_trust_root_bytes,
          current_epoch_provider: verifierProvider,
        }),
      );
    } finally {
      verifierProvider.close();
    }
  } catch (error) {
    if (session !== undefined) {
      try {
        abortRepositoryExecutionSession(session);
      } catch {
        // Session teardown preserves the primary execution failure.
      }
    } else if (capabilityRequiresRevocation) {
      revokeExecutionSigningCapability(capability);
    }
    throw error;
  }
}

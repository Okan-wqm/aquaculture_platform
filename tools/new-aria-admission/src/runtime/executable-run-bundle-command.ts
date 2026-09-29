import { GitRepositoryTargetPort } from '../adapters/git/git-repository-target-port';
import { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import {
  verifyHistoricalRepositoryTarget,
  verifyRepositoryTarget,
} from '../application/repository-target-verifier';
import {
  authorizeS01ProgressAuthority,
  verifyHistoricalS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import { readCanonicalFile } from './canonical-files';
import type { CliCommand } from './cli-arguments';
import { parseExecutableRunBundleRequest } from './executable-run-bundle-request';
import { verifyHistoricalExecutableRunBundle } from './executable-run-bundle-historical-verifier';
import { verifyExecutableRunBundle } from './executable-run-bundle-verifier';
import { loadRepositoryTargetRequest } from './repository-target-request';
import { runtimeTemporaryRoot } from './runtime-temporary-root';
import {
  assertPhysicalMutationBoundary,
  assertPhysicalPathSeparation,
  assertSafeTemporaryParent,
} from './physical-publication-boundary';
import {
  assertExecutionTrustRootAuthority,
  assertRepositoryTargetRequestAuthority,
} from './verifier-invocation-authority';

type VerifyBundleCommand = Extract<CliCommand, { readonly kind: 'verify-bundle' }>;
type VerifyHistoricalBundleCommand = Extract<
  CliCommand,
  { readonly kind: 'verify-bundle-history' }
>;

export function executeBundleVerificationCommand(command: VerifyBundleCommand): void {
  const descriptor = parseExecutableRunBundleRequest(
    readCanonicalFile(command.request_path, 'run bundle verification request'),
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
  assertRepositoryTargetRequestAuthority(authority, targetRequest, descriptor.git_sha256);
  assertPhysicalPathSeparation(
    [command.current_epoch_root],
    [
      command.request_path,
      command.bundle_path,
      targetRequest.repository_root,
      descriptor.target_request_path,
      descriptor.git_path,
      descriptor.operator_envelope_path,
      descriptor.operator_trust_root_path,
      descriptor.execution_trust_root_path,
    ],
  );
  assertPhysicalMutationBoundary(targetRequest.repository_root, [command.current_epoch_root]);
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [
    targetRequest.repository_root,
    command.bundle_path,
    command.current_epoch_root,
  ]);
  const executionTrustRootBytes = readCanonicalFile(
    descriptor.execution_trust_root_path,
    'execution trust root',
    1024 * 1024,
  );
  assertExecutionTrustRootAuthority(authority, executionTrustRootBytes);
  const target = verifyRepositoryTarget(
    targetRequest,
    new GitRepositoryTargetPort({
      executable_path: descriptor.git_path,
      executable_sha256: descriptor.git_sha256,
    }),
  );
  const provider = new FileCurrentEpochProvider({
    state_root: command.current_epoch_root,
    provider_id: authority.authority.document.invalidation_epoch_provider_id,
    operator_trust_root_bytes: operatorTrustRootBytes,
    expected_operator_trust_root_sha256: command.operator_trust_root_sha256,
  });
  try {
    verifyExecutableRunBundle({
      bundle_path: command.bundle_path,
      authority,
      target,
      execution_trust_root_bytes: executionTrustRootBytes,
      current_epoch_provider: provider,
    });
  } finally {
    provider.close();
  }
}

export function executeHistoricalBundleVerificationCommand(
  command: VerifyHistoricalBundleCommand,
): void {
  const descriptor = parseExecutableRunBundleRequest(
    readCanonicalFile(command.request_path, 'run bundle verification request'),
  );
  const operatorTrustRootBytes = readCanonicalFile(
    descriptor.operator_trust_root_path,
    'operator progress trust root',
    1024 * 1024,
  );
  const authority = verifyHistoricalS01ProgressAuthority({
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
  assertRepositoryTargetRequestAuthority(authority, targetRequest, descriptor.git_sha256);
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [
    targetRequest.repository_root,
    command.bundle_path,
  ]);
  const executionTrustRootBytes = readCanonicalFile(
    descriptor.execution_trust_root_path,
    'execution trust root',
    1024 * 1024,
  );
  assertExecutionTrustRootAuthority(authority, executionTrustRootBytes);
  const target = verifyHistoricalRepositoryTarget(
    targetRequest,
    new GitRepositoryTargetPort({
      executable_path: descriptor.git_path,
      executable_sha256: descriptor.git_sha256,
    }),
  );
  verifyHistoricalExecutableRunBundle({
    bundle_path: command.bundle_path,
    authority,
    target,
    execution_trust_root_bytes: executionTrustRootBytes,
  });
}

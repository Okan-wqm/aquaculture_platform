import { GitRepositoryTargetPort } from '../adapters/git/git-repository-target-port';
import { historicalCompletionProjectionBytes } from '../application/historical-completion-proof';
import {
  verifyHistoricalRepositoryTarget,
  verifyRepositoryTarget,
} from '../application/repository-target-verifier';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import {
  authorizeS01ProgressAuthority,
  verifyHistoricalS01ProgressAuthority,
} from '../kernel/operator-progress-authority';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import type { CliCommand } from './cli-arguments';
import { readCanonicalFile } from './canonical-files';
import { runtimeTemporaryRoot } from './runtime-temporary-root';
import { readCompletionProofBundleAuthority } from './completion-proof-bundle-authority';
import { assertCurrentCompletionProofBundle } from './completion-proof-bundle-current';
import type { CurrentlyVerifiedCompletionProofBundle } from './completion-proof-bundle-current';
import {
  verifyHistoricalCompletionProofBundle,
  verifyStagedCompletionProofBundle,
  type VerifiedCompletionProofBundle,
} from './completion-proof-bundle-verifier';
import { readCompletionProofBundle } from './completion-proof-bundle-reader';
import { loadRepositoryTargetRequest } from './repository-target-request';
import {
  assertPhysicalMutationBoundary,
  assertPhysicalPathSeparation,
  assertSafeTemporaryParent,
} from './physical-publication-boundary';
import { assertRepositoryTargetRequestAuthority } from './verifier-invocation-authority';

type CurrentCommand = Extract<CliCommand, { readonly kind: 'verify-completion-bundle' }>;
type HistoricalCommand = Extract<CliCommand, { readonly kind: 'verify-completion-bundle-history' }>;
type ProgressAuthority = AuthorizedS01ProgressAuthority | HistoricallyVerifiedS01ProgressAuthority;
interface RecoveryCommand {
  readonly bundle_path: string;
  readonly operator_trust_root_sha256: string;
  readonly git_path: string;
  readonly repository_root?: string;
}

function authorityArtifacts(
  bundlePath: string,
  expectedTrustRootSha256: string,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): {
  readonly bytes: ReturnType<typeof readCompletionProofBundleAuthority>;
  readonly historical: HistoricallyVerifiedS01ProgressAuthority;
} {
  const bytes = readCompletionProofBundleAuthority(bundlePath, markerName);
  const historical = verifyHistoricalS01ProgressAuthority({
    envelope_bytes: bytes.operator_envelope_bytes,
    trust_root_bytes: bytes.operator_trust_root_bytes,
    expected_trust_root_sha256: expectedTrustRootSha256,
  });
  return { bytes, historical };
}

function target(
  bundlePath: string,
  repositoryRoot: string,
  gitPath: string,
  authority: ProgressAuthority,
  historical: boolean,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json' = 'COMPLETE.json',
): VerifiedRepositoryTarget {
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [repositoryRoot, bundlePath]);
  const source = readCompletionProofBundle(bundlePath, markerName).source;
  const archivedRequest = loadRepositoryTargetRequest(source.target_request_bytes);
  const expectedGitSha256 = authority.authority.document.git_tool_sha256;
  assertRepositoryTargetRequestAuthority(authority, archivedRequest, expectedGitSha256);
  const request = Object.freeze({ ...archivedRequest, repository_root: repositoryRoot });
  const port = new GitRepositoryTargetPort({
    executable_path: gitPath,
    executable_sha256: expectedGitSha256,
  });
  return historical
    ? verifyHistoricalRepositoryTarget(request, port)
    : verifyRepositoryTarget(request, port);
}

function assertExternalProjection(proof: VerifiedCompletionProofBundle, path: string): void {
  const actual = readCanonicalFile(path, 'completion projection output', 64 * 1024);
  if (!historicalCompletionProjectionBytes(proof.historical_proof).equals(actual)) {
    throw new TypeError('external completion projection differs from verified bundle');
  }
}

export function completionBundleRepositoryRoot(
  bundlePath: string,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json',
): string {
  return loadRepositoryTargetRequest(
    readCompletionProofBundle(bundlePath, markerName).source.target_request_bytes,
  ).repository_root;
}

export function executeHistoricalCompletionBundleCommand(
  command: HistoricalCommand,
): VerifiedCompletionProofBundle {
  const { historical } = authorityArtifacts(
    command.bundle_path,
    command.operator_trust_root_sha256,
  );
  const verifiedTarget = target(
    command.bundle_path,
    command.repository_root,
    command.git_path,
    historical,
    true,
  );
  const proof = verifyHistoricalCompletionProofBundle({
    bundle_path: command.bundle_path,
    authority: historical,
    target: verifiedTarget,
  });
  assertExternalProjection(proof, command.projection_path);
  return proof;
}

export function executeStagedCompletionBundleCommand(
  command: RecoveryCommand,
): VerifiedCompletionProofBundle {
  const { historical } = authorityArtifacts(
    command.bundle_path,
    command.operator_trust_root_sha256,
    'CANDIDATE.json',
  );
  const verifiedTarget = target(
    command.bundle_path,
    command.repository_root ??
      completionBundleRepositoryRoot(command.bundle_path, 'CANDIDATE.json'),
    command.git_path,
    historical,
    true,
    'CANDIDATE.json',
  );
  return verifyStagedCompletionProofBundle({
    bundle_path: command.bundle_path,
    authority: historical,
    target: verifiedTarget,
  });
}

export function executeRecoveredCompletionBundleCommand(
  command: RecoveryCommand,
): VerifiedCompletionProofBundle {
  const { historical } = authorityArtifacts(
    command.bundle_path,
    command.operator_trust_root_sha256,
  );
  const verifiedTarget = target(
    command.bundle_path,
    command.repository_root ?? completionBundleRepositoryRoot(command.bundle_path, 'COMPLETE.json'),
    command.git_path,
    historical,
    true,
  );
  return verifyHistoricalCompletionProofBundle({
    bundle_path: command.bundle_path,
    authority: historical,
    target: verifiedTarget,
  });
}

export function executeCurrentCompletionBundleCommand(
  command: CurrentCommand,
): CurrentlyVerifiedCompletionProofBundle {
  const { bytes, historical } = authorityArtifacts(
    command.bundle_path,
    command.operator_trust_root_sha256,
  );
  const current = authorizeS01ProgressAuthority({
    envelope_bytes: bytes.operator_envelope_bytes,
    trust_root_bytes: bytes.operator_trust_root_bytes,
    expected_trust_root_sha256: command.operator_trust_root_sha256,
  });
  if (current.authority.sha256 !== historical.authority.sha256) {
    throw new TypeError('current and historical completion authority differ');
  }
  assertPhysicalPathSeparation(
    [command.current_epoch_root, command.checkpoint_root],
    [command.bundle_path, command.projection_path, command.git_path, command.repository_root],
  );
  assertPhysicalMutationBoundary(command.repository_root, [
    command.current_epoch_root,
    command.checkpoint_root,
  ]);
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [
    command.repository_root,
    command.bundle_path,
    command.current_epoch_root,
    command.checkpoint_root,
  ]);
  const verifiedTarget = target(
    command.bundle_path,
    command.repository_root,
    command.git_path,
    current,
    false,
  );
  const proof = verifyHistoricalCompletionProofBundle({
    bundle_path: command.bundle_path,
    authority: historical,
    target: verifiedTarget,
  });
  assertExternalProjection(proof, command.projection_path);
  return assertCurrentCompletionProofBundle({
    proof,
    current_authority: current,
    historical_authority: historical,
    target: verifiedTarget,
    checkpoint_root: command.checkpoint_root,
    current_epoch_root: command.current_epoch_root,
    operator_trust_root_bytes: bytes.operator_trust_root_bytes,
    operator_trust_root_sha256: command.operator_trust_root_sha256,
  });
}

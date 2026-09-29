import { GitRepositoryTargetPort } from '../adapters/git/git-repository-target-port';
import { FileEvidenceCheckpointStore } from '../adapters/file-evidence-checkpoint-store';
import { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import {
  recoverCommittedCompletionProjection,
  recoveredCompletionProjectionBytes,
} from '../application/completion-publication-recovery';
import { historicalCompletionProjectionBytes } from '../application/historical-completion-proof';
import {
  commitPreparedSprintCompletion,
  prepareSprintCompletion,
  preparedCompletionProjectionBytes,
  snapshotCommittedCompletionProjection,
} from '../application/progress-admission';
import { verifyRepositoryTarget } from '../application/repository-target-verifier';
import { createTrustedCompletionContext } from '../application/trusted-completion-context';
import {
  authorizeS01ProgressAuthority,
  verifyHistoricalS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import { readCanonicalFile } from './canonical-files';
import {
  abortCanonicalOutput,
  publishCanonicalOutput,
  reserveCanonicalOutput,
} from './canonical-output-reservation';
import {
  loadCompletionAdmissionResources,
  parseCompletionAdmissionDescriptor,
} from './completion-admission-request';
import {
  assertCompletionPublicationPaths,
  completionDescriptorInputPaths,
} from './completion-publication-paths';
import { loadCompletionRecoveryTarget } from './completion-recovery-target';
import { serializeAdmittedCompletionProjection } from './projection-renderer';
import { runtimeTemporaryRoot } from './runtime-temporary-root';
import {
  assertPhysicalMutationBoundary,
  assertPhysicalPathSeparation,
  assertSafeTemporaryParent,
} from './physical-publication-boundary';
import {
  completionBundleRepositoryRoot,
  executeRecoveredCompletionBundleCommand,
  executeStagedCompletionBundleCommand,
} from './completion-proof-bundle-command';
import {
  assertCompletionProofBundleCommit,
  completionProofBundleState,
  promoteStagedCompletionProofBundle,
} from './completion-proof-bundle-promotion';
import { ensureStagedCompletionProofBundle } from './completion-proof-bundle-resume';
import {
  verifyHistoricalCompletionProofBundle,
  verifyStagedCompletionProofBundle,
} from './completion-proof-bundle-verifier';
import { assertProgressTrustRootAuthority } from './verifier-invocation-authority';

const PUBLIC_AUTHORITY_MAX_BYTES = 1024 * 1024;

export async function executeCompletionAdmissionCommand(
  requestPath: string,
  outputPath: string,
  operatorTrustRootSha256: string,
  currentEpochRoot: string,
  bundlePath: string,
): Promise<void> {
  const descriptor = parseCompletionAdmissionDescriptor(
    readCanonicalFile(requestPath, 'completion admission request'),
  );
  const operatorTrustRootBytes = readCanonicalFile(
    descriptor.operator_trust_root_path,
    'operator progress trust root',
    PUBLIC_AUTHORITY_MAX_BYTES,
  );
  const operatorEnvelopeBytes = readCanonicalFile(
    descriptor.operator_envelope_path,
    'operator progress authority envelope',
    PUBLIC_AUTHORITY_MAX_BYTES,
  );
  const authorityInput = {
    envelope_bytes: operatorEnvelopeBytes,
    trust_root_bytes: operatorTrustRootBytes,
    expected_trust_root_sha256: operatorTrustRootSha256,
  };
  const historicalAuthority = verifyHistoricalS01ProgressAuthority(authorityInput);
  const checkpointDirectory = process.env.NEW_ARIA_CHECKPOINT_DIRECTORY;
  if (checkpointDirectory === undefined || checkpointDirectory.length === 0) {
    throw new TypeError('completion checkpoint configuration is absent');
  }
  const sourceTarget = loadCompletionRecoveryTarget(descriptor, historicalAuthority);
  const initialBundleState = completionProofBundleState(bundlePath);
  const repositoryRoot =
    sourceTarget?.request.repository_root ??
    (initialBundleState === 'CANDIDATE' || initialBundleState === 'COMPLETE'
      ? completionBundleRepositoryRoot(
          bundlePath,
          initialBundleState === 'CANDIDATE' ? 'CANDIDATE.json' : 'COMPLETE.json',
        )
      : undefined);
  if (repositoryRoot === undefined) {
    throw new TypeError('completion repository target is unavailable');
  }
  const publicationPaths = {
    output_path: outputPath,
    bundle_path: bundlePath,
    checkpoint_root: checkpointDirectory,
    current_epoch_root: currentEpochRoot,
    input_paths: Object.freeze([
      requestPath,
      ...completionDescriptorInputPaths(descriptor, repositoryRoot),
    ]),
  } as const;
  assertCompletionPublicationPaths(publicationPaths);
  const mutationPaths = [outputPath, bundlePath, checkpointDirectory, currentEpochRoot] as const;
  assertPhysicalPathSeparation(mutationPaths, publicationPaths.input_paths);
  assertPhysicalMutationBoundary(repositoryRoot, mutationPaths);
  assertSafeTemporaryParent(runtimeTemporaryRoot(), [repositoryRoot, ...mutationPaths]);
  const checkpointStore = new FileEvidenceCheckpointStore(checkpointDirectory);
  try {
    const recovered = recoverCommittedCompletionProjection({
      authority: historicalAuthority,
      checkpoint_store: checkpointStore,
    });
    if (recovered !== null) {
      const recoveredBytes = recoveredCompletionProjectionBytes(recovered);
      const state = completionProofBundleState(bundlePath);
      const outputReservation = reserveCanonicalOutput(outputPath, recoveredBytes);
      const command = {
        bundle_path: bundlePath,
        operator_trust_root_sha256: operatorTrustRootSha256,
        git_path: descriptor.git_path,
        repository_root: repositoryRoot,
      } as const;
      if (state === 'CANDIDATE') {
        const staged = executeStagedCompletionBundleCommand(command);
        promoteStagedCompletionProofBundle(bundlePath, staged, recovered);
      } else if (state !== 'COMPLETE') {
        throw new TypeError('committed completion bundle is absent or incomplete');
      }
      const verifiedBundle = executeRecoveredCompletionBundleCommand(command);
      assertCompletionProofBundleCommit(verifiedBundle, recovered);
      if (
        !historicalCompletionProjectionBytes(verifiedBundle.historical_proof).equals(recoveredBytes)
      ) {
        throw new TypeError('completion bundle differs from committed projection outbox');
      }
      publishCanonicalOutput(outputReservation);
      return;
    }
    if (sourceTarget === undefined) {
      throw new TypeError('live completion repository target is unavailable');
    }
    const targetRequestBytes = sourceTarget.bytes;
    const targetRequest = sourceTarget.request;
    const request = loadCompletionAdmissionResources(
      descriptor,
      operatorEnvelopeBytes,
      operatorTrustRootBytes,
    );
    assertProgressTrustRootAuthority(
      historicalAuthority,
      request.execution_trust_root_bytes,
      request.evidence_trust_root_bytes,
    );
    const authority = authorizeS01ProgressAuthority(authorityInput);
    const currentEpochProvider = new FileCurrentEpochProvider({
      state_root: currentEpochRoot,
      provider_id: authority.authority.document.invalidation_epoch_provider_id,
      operator_trust_root_bytes: operatorTrustRootBytes,
      expected_operator_trust_root_sha256: operatorTrustRootSha256,
    });
    try {
      const target = verifyRepositoryTarget(
        targetRequest,
        new GitRepositoryTargetPort({
          executable_path: descriptor.git_path,
          executable_sha256: descriptor.git_sha256,
        }),
      );
      const context = createTrustedCompletionContext({
        progress_authority: authority,
        verified_target: target,
        evidence_trust_root_bytes: request.evidence_trust_root_bytes,
        execution_trust_root_bytes: request.execution_trust_root_bytes,
        event_policy_bytes: request.event_policy_bytes,
        freshness_policy_bytes: request.freshness_policy_bytes,
        checkpoint_store: checkpointStore,
        current_epoch_provider: currentEpochProvider,
      });
      const prepared = prepareSprintCompletion(request.candidate, context);
      const projectionBytes = preparedCompletionProjectionBytes(prepared);
      const outputReservation = reserveCanonicalOutput(outputPath, projectionBytes);
      let checkpointCommitted = false;
      try {
        ensureStagedCompletionProofBundle(bundlePath, {
          target_request_bytes: targetRequestBytes,
          operator_envelope_bytes: operatorEnvelopeBytes,
          operator_trust_root_bytes: operatorTrustRootBytes,
          evidence_trust_root_bytes: request.evidence_trust_root_bytes,
          execution_trust_root_bytes: request.execution_trust_root_bytes,
          event_policy_bytes: request.event_policy_bytes,
          freshness_policy_bytes: request.freshness_policy_bytes,
          event_chain_bytes: request.candidate.event_bytes,
          manifest_bytes: request.candidate.manifest_bytes,
          objects: request.candidate.objects,
          evidence_attestation_bytes: request.candidate.evidence_attestation_bytes,
          projection_artifact_bytes: projectionBytes,
        });
        const verified = verifyStagedCompletionProofBundle({
          bundle_path: bundlePath,
          authority: historicalAuthority,
          target,
        });
        const committed = await commitPreparedSprintCompletion(prepared, verified.historical_proof);
        checkpointCommitted = true;
        promoteStagedCompletionProofBundle(bundlePath, verified, committed);
        const completed = verifyHistoricalCompletionProofBundle({
          bundle_path: bundlePath,
          authority: historicalAuthority,
          target,
        });
        assertCompletionProofBundleCommit(completed, committed);
        const committedBytes = serializeAdmittedCompletionProjection(
          snapshotCommittedCompletionProjection(committed),
        );
        if (!committedBytes.equals(projectionBytes)) {
          throw new TypeError('committed completion projection changed after preparation');
        }
        publishCanonicalOutput(outputReservation);
      } catch (error) {
        if (!checkpointCommitted) abortCanonicalOutput(outputReservation);
        throw error;
      }
    } finally {
      currentEpochProvider.close();
    }
  } finally {
    checkpointStore.close();
  }
}

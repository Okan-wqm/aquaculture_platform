import { errorFromUnknown } from './error-cause';

export type SourceFindingPublicationFaultPoint =
  | 'ARTIFACT_DURABLE'
  | 'MANIFEST_COMMITTED'
  | 'CLEANUP_PROGRESS';

export class SourceFindingPublicationCrash extends Error {
  public constructor(public readonly point: SourceFindingPublicationFaultPoint) {
    super(`Simulated source-finding process crash at ${point}`);
    this.name = 'SourceFindingPublicationCrash';
  }
}

export interface SourceFindingPublicationFaultBoundary {
  checkpoint(point: SourceFindingPublicationFaultPoint): void;
}

export type SourceFindingOperationResult<T> = T | Promise<T>;

export interface SourceFindingPublicationTransaction {
  prepare(): SourceFindingOperationResult<void>;
  publishArtifact(): SourceFindingOperationResult<void>;
  verifyArtifact(): SourceFindingOperationResult<void>;
  publishManifestCommitMarker(): SourceFindingOperationResult<void>;
  cleanupSupersededArtifacts(checkpoint: () => void): SourceFindingOperationResult<void>;
  verifyCommittedCut(): SourceFindingOperationResult<void>;
  rollback(): SourceFindingOperationResult<void>;
  release(): void;
}

const NO_PUBLICATION_FAULTS: SourceFindingPublicationFaultBoundary = Object.freeze({
  checkpoint: () => undefined,
});

/**
 * One typed publication state machine. The artifact becomes durable before the manifest pointer;
 * cleanup occurs only after that commit marker. Ordinary failures compensate, while a simulated
 * process death deliberately leaves the cut for restart recovery to reconcile.
 */
export async function executeSourceFindingPublicationTransaction(
  transaction: SourceFindingPublicationTransaction,
  faults: SourceFindingPublicationFaultBoundary = NO_PUBLICATION_FAULTS,
): Promise<void> {
  let mutationStarted = false;
  let outcome: { readonly status: 'SUCCESS' } | { readonly status: 'FAILURE'; error: unknown };
  try {
    await Promise.resolve(transaction.prepare());
    mutationStarted = true;
    await Promise.resolve(transaction.publishArtifact());
    faults.checkpoint('ARTIFACT_DURABLE');
    await Promise.resolve(transaction.verifyArtifact());
    await Promise.resolve(transaction.publishManifestCommitMarker());
    faults.checkpoint('MANIFEST_COMMITTED');
    await Promise.resolve(
      transaction.cleanupSupersededArtifacts(() => faults.checkpoint('CLEANUP_PROGRESS')),
    );
    await Promise.resolve(transaction.verifyCommittedCut());
    outcome = { status: 'SUCCESS' };
  } catch (error) {
    outcome = { status: 'FAILURE', error };
  }

  let rollbackFailure: unknown;
  if (
    outcome.status === 'FAILURE' &&
    mutationStarted &&
    !(outcome.error instanceof SourceFindingPublicationCrash)
  ) {
    try {
      await Promise.resolve(transaction.rollback());
    } catch (error) {
      rollbackFailure = error;
    }
  }

  let releaseFailure: unknown;
  try {
    transaction.release();
  } catch (error) {
    releaseFailure = error;
  }

  if (outcome.status === 'FAILURE') {
    const primaryFailure = errorFromUnknown('Source publication failed.', outcome.error);
    const failures = [primaryFailure];
    if (rollbackFailure !== undefined) {
      failures.push(errorFromUnknown('Source publication rollback failed.', rollbackFailure));
    }
    if (releaseFailure !== undefined) {
      failures.push(errorFromUnknown('Source publication release failed.', releaseFailure));
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Source-finding publication transaction failed.');
    }
    throw primaryFailure;
  }
  if (releaseFailure !== undefined) {
    throw errorFromUnknown('Source publication release failed.', releaseFailure);
  }
}

export interface SourceFindingRestartRecovery {
  readAndVerifyManifestCommitMarker(): SourceFindingOperationResult<void>;
  verifySelectedArtifact(): SourceFindingOperationResult<void>;
  removeOneSupersededArtifact(): SourceFindingOperationResult<boolean>;
  syncRecoveredCut(): SourceFindingOperationResult<void>;
}

/** Manifest-selected roll-forward; recovery never guesses which artifact should be authoritative. */
export async function executeSourceFindingRestartRecovery(
  recovery: SourceFindingRestartRecovery,
): Promise<void> {
  await Promise.resolve(recovery.readAndVerifyManifestCommitMarker());
  await Promise.resolve(recovery.verifySelectedArtifact());
  let removed = false;
  while (await Promise.resolve(recovery.removeOneSupersededArtifact())) removed = true;
  if (removed) await Promise.resolve(recovery.syncRecoveredCut());
}

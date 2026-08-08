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

export interface SourceFindingPublicationTransaction {
  prepare(): Promise<void>;
  publishArtifact(): Promise<void>;
  verifyArtifact(): Promise<void>;
  publishManifestCommitMarker(): Promise<void>;
  cleanupSupersededArtifacts(checkpoint: () => void): Promise<void>;
  verifyCommittedCut(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

const NO_PUBLICATION_FAULTS: SourceFindingPublicationFaultBoundary = Object.freeze({
  checkpoint: () => {},
});

function observedFailure(message: string, error: unknown): Error {
  if (error instanceof Error) return error;
  const wrapped = new Error(message);
  Object.defineProperty(wrapped, 'cause', {
    configurable: true,
    enumerable: false,
    value: error,
    writable: true,
  });
  return wrapped;
}

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
    await transaction.prepare();
    mutationStarted = true;
    await transaction.publishArtifact();
    faults.checkpoint('ARTIFACT_DURABLE');
    await transaction.verifyArtifact();
    await transaction.publishManifestCommitMarker();
    faults.checkpoint('MANIFEST_COMMITTED');
    await transaction.cleanupSupersededArtifacts(() => faults.checkpoint('CLEANUP_PROGRESS'));
    await transaction.verifyCommittedCut();
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
      await transaction.rollback();
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
    const failures = [observedFailure('Source publication failed.', outcome.error)];
    if (rollbackFailure !== undefined) {
      failures.push(observedFailure('Source publication rollback failed.', rollbackFailure));
    }
    if (releaseFailure !== undefined) {
      failures.push(observedFailure('Source publication release failed.', releaseFailure));
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Source-finding publication transaction failed.');
    }
    throw failures[0];
  }
  if (releaseFailure !== undefined) {
    throw observedFailure('Source publication release failed.', releaseFailure);
  }
}

export interface SourceFindingRestartRecovery {
  readAndVerifyManifestCommitMarker(): Promise<void>;
  verifySelectedArtifact(): Promise<void>;
  removeOneSupersededArtifact(): Promise<boolean>;
  syncRecoveredCut(): Promise<void>;
}

/** Manifest-selected roll-forward; recovery never guesses which artifact should be authoritative. */
export async function executeSourceFindingRestartRecovery(
  recovery: SourceFindingRestartRecovery,
): Promise<void> {
  await recovery.readAndVerifyManifestCommitMarker();
  await recovery.verifySelectedArtifact();
  let removed = false;
  while (await recovery.removeOneSupersededArtifact()) removed = true;
  if (removed) await recovery.syncRecoveredCut();
}

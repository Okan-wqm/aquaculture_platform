import {
  abortRepositoryExecutionReservation,
  assertExecutableRepositoryTarget,
  commitRepositoryExecutionReservation,
  reserveRepositoryExecutionCapability,
  snapshotRepositoryExecutionReservation,
} from '../application/repository-target-verifier';
import { readCurrentEpochSnapshot } from '../adapters/file-current-epoch-provider';
import {
  abortExecutionSigningReservation,
  commitExecutionSigningReservation,
  reserveExecutionSigningCapability,
  verifyExecutionSigningCapability,
} from '../kernel/execution-signing-capability';
import { loadExecutionTrustKey } from '../kernel/execution-trust-root';
import { assertAuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import { assertExecutionSessionAuthority } from './execution-session-authority';
import type { OpenExecutionSessionRequest } from './repository-execution-contracts';
import { PrivateRepositorySnapshot } from './repository-snapshot-materializer';

export interface PreparedRepositoryExecution {
  readonly trust_root_bytes: Buffer;
  readonly repository: PrivateRepositorySnapshot;
  readonly revalidate: () => void;
}

function cleanupFailure(failures: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    failures.push(error);
  }
}

export function prepareRepositoryExecution(
  input: OpenExecutionSessionRequest,
): PreparedRepositoryExecution {
  assertAuthorizedS01ProgressAuthority(input.authority);
  const trustRootBytes = Buffer.from(input.execution_trust_root_bytes);
  verifyExecutionSigningCapability(input.signing_capability, input.authority, trustRootBytes);
  assertExecutableRepositoryTarget(input.target);
  assertExecutionSessionAuthority(input.authority, input.target, input.signing_capability);
  readCurrentEpochSnapshot(input.current_epoch_provider, input.authority);
  const key = loadExecutionTrustKey(
    trustRootBytes,
    input.authority.authority.document.execution_trust_root_sha256,
  );
  if (
    key.principalId !== input.signing_capability.principal_id ||
    key.keySha256 !== input.signing_capability.key_sha256
  ) {
    throw new TypeError('repository execution session signer does not match its trust root');
  }
  const signingReservation = reserveExecutionSigningCapability(
    input.signing_capability,
    input.authority,
    trustRootBytes,
  );
  let targetReservation: ReturnType<typeof reserveRepositoryExecutionCapability> | undefined;
  let repository: PrivateRepositorySnapshot | undefined;
  try {
    targetReservation = reserveRepositoryExecutionCapability(input.target);
    const capability = snapshotRepositoryExecutionReservation(targetReservation);
    repository = new PrivateRepositorySnapshot(capability.snapshot);
    repository.verify();
    capability.revalidate();
    commitRepositoryExecutionReservation(targetReservation);
    commitExecutionSigningReservation(signingReservation);
    return Object.freeze({
      trust_root_bytes: trustRootBytes,
      repository,
      revalidate: capability.revalidate,
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (repository !== undefined) {
      const allocatedRepository = repository;
      cleanupFailure(cleanupFailures, () => allocatedRepository.dispose());
    }
    if (targetReservation !== undefined) {
      const activeTargetReservation = targetReservation;
      cleanupFailure(cleanupFailures, () =>
        abortRepositoryExecutionReservation(activeTargetReservation),
      );
    }
    cleanupFailure(cleanupFailures, () => abortExecutionSigningReservation(signingReservation));
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'repository execution preparation failed during transactional cleanup',
      );
    }
    throw error;
  }
}

import type { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';

import { revokeExecutionSigningSecret } from './execution-signing-secrets';
import type { PrivateRepositorySnapshot } from './repository-snapshot-materializer';

export function cleanupRepositorySessionResources(
  repository: PrivateRepositorySnapshot,
  signingCapability: ExecutionSigningCapability,
  currentEpochProvider: FileCurrentEpochProvider,
): readonly unknown[] {
  const failures: unknown[] = [];
  try {
    repository.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    revokeExecutionSigningSecret(signingCapability);
  } catch (error) {
    failures.push(error);
  }
  try {
    currentEpochProvider.close();
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

export function cleanupRepositorySessionOrThrow(
  repository: PrivateRepositorySnapshot,
  signingCapability: ExecutionSigningCapability,
  currentEpochProvider: FileCurrentEpochProvider,
): void {
  const failures = cleanupRepositorySessionResources(
    repository,
    signingCapability,
    currentEpochProvider,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'repository execution session cleanup failed');
  }
}

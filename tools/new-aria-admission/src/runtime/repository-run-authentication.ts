import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import {
  readCurrentEpochSnapshot,
  type CurrentEpochProviderSnapshot,
  type FileCurrentEpochProvider,
} from '../adapters/file-current-epoch-provider';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import { authenticateVerifierInput } from '../verifier/authenticated-input';
import type { AuthenticatedVerifierInput } from '../verifier/authenticated-input';

import type { ExecutableRunResult } from './executable-run-result';
import type { OpenExecutionSessionRequest } from './repository-execution-contracts';
import type { PrivateRepositorySnapshot } from './repository-snapshot-materializer';

export interface RepositoryExecutionState {
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly trustRootBytes: Buffer;
  readonly repository: PrivateRepositorySnapshot;
  readonly revalidate: () => void;
  readonly expectedRuns: readonly string[];
  readonly usedRuns: Set<string>;
  readonly finalizedRuns: Map<string, ExecutableRunResult>;
  readonly signingCapability: OpenExecutionSessionRequest['signing_capability'];
  readonly currentEpochProvider: FileCurrentEpochProvider;
  baselineObjectSha256s?: readonly string[];
  baselineRunContextSha256?: string;
  closed: boolean;
}

export function verifiedRepositoryRunEpoch(
  state: RepositoryExecutionState,
  objectSha256s: readonly string[],
): CurrentEpochProviderSnapshot {
  const snapshot = readCurrentEpochSnapshot(state.currentEpochProvider, state.authority);
  const document = state.authority.authority.document;
  if (
    objectSha256s[1] !== state.authority.envelope_sha256 ||
    objectSha256s[2] !== state.authority.trust_root_sha256 ||
    objectSha256s[3] !== snapshot.sha256 ||
    snapshot.provider_identity_sha256 !== document.invalidation_epoch_provider_identity_sha256
  )
    throw new TypeError('execution authentication roster is stale or outside authority');
  return snapshot;
}

function canonicalBaselineArgs(
  runId: string,
  args: readonly string[],
  operatorTrustRootSha256: string,
): readonly string[] {
  const baselineArgs = runId === 'BASELINE' ? args : args.slice(0, -2);
  if (
    baselineArgs.length !== 4 ||
    baselineArgs[0] !== '--mode' ||
    baselineArgs[1] !== 'full' ||
    baselineArgs[2] !== '--operator-trust-root-sha256' ||
    baselineArgs[3] !== operatorTrustRootSha256
  )
    throw new TypeError('verifier baseline invocation is not canonical');
  return Object.freeze([...baselineArgs]);
}

export function authenticateRepositoryRun(
  state: RepositoryExecutionState,
  runId: string,
  runContextSha256: string,
  args: readonly string[],
  objectBytes: readonly Buffer[],
): AuthenticatedVerifierInput {
  const authenticated = authenticateVerifierInput(
    objectBytes.slice(0, 4),
    state.authority.trust_root_sha256,
    state.repository.root,
    canonicalBaselineArgs(runId, args, state.authority.trust_root_sha256),
  );
  const derivedRunContext = authenticated.verification.baseline.run_context_sha256;
  if (
    runContextSha256 !== derivedRunContext ||
    (state.baselineRunContextSha256 !== undefined &&
      state.baselineRunContextSha256 !== derivedRunContext)
  )
    throw new TypeError('execution run context differs from authenticated baseline input');
  return authenticated;
}

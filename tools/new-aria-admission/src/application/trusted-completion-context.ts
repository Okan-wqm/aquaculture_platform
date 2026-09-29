import {
  assertTrustedEvidenceCheckpointStore,
  checkpointStoreIdentityFor,
} from '../adapters/file-evidence-checkpoint-store';
import {
  assertTrustedCurrentEpochProvider,
  FileCurrentEpochProvider,
  readCurrentEpochSnapshot,
} from '../adapters/file-current-epoch-provider';
import type { CurrentEpochProviderSnapshot } from '../adapters/file-current-epoch-provider';
import { FreshnessContext } from '../kernel/freshness';
import { loadFreshnessPolicy } from '../kernel/freshness-policy';
import { ImmutableStringMap } from '../kernel/immutable-string-map';
import {
  assertAuthorizedS01ProgressAuthority,
  AuthorizedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';
import { eventPolicySha256, loadEventPolicy } from '../kernel/policy';

import { EvidenceCheckpointRequest, EvidenceCheckpointStore } from './evidence-checkpoint';
import {
  assertVerifiedRepositoryTarget,
  revalidateExecutableRepositoryTarget,
  VerifiedRepositoryTarget,
} from './repository-target-verifier';
import { assertCompletionIdentitySeparation } from './completion-identity-separation';

export interface TrustedCompletionContextInput {
  readonly progress_authority: AuthorizedS01ProgressAuthority;
  readonly verified_target: VerifiedRepositoryTarget;
  readonly evidence_trust_root_bytes: Uint8Array;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly event_policy_bytes: Uint8Array;
  readonly freshness_policy_bytes: Uint8Array;
  readonly checkpoint_store: EvidenceCheckpointStore;
  readonly current_epoch_provider: FileCurrentEpochProvider;
}

export interface TrustedCompletionContext {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-trusted-completion-context-v1';
  readonly progress_authority: AuthorizedS01ProgressAuthority;
  readonly verified_target: VerifiedRepositoryTarget;
}

export interface TrustedCompletionResources {
  readonly evidence_trust_root_bytes: Uint8Array;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly event_policy_bytes: Uint8Array;
  readonly freshness_policy_bytes: Uint8Array;
  readonly checkpoint_store: EvidenceCheckpointStore;
  readonly freshness_context: FreshnessContext;
  readonly current_epoch_snapshot: CurrentEpochProviderSnapshot;
}

interface PrivateContextState {
  readonly evidenceTrustRootBytes: Buffer;
  readonly executionTrustRootBytes: Buffer;
  readonly eventPolicyBytes: Buffer;
  readonly freshnessPolicyBytes: Buffer;
  readonly checkpointStore: EvidenceCheckpointStore;
  readonly currentEpochProvider: FileCurrentEpochProvider;
}

const issuedContexts = new WeakMap<object, PrivateContextState>();

function ownedBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} cannot use shared mutable memory`);
  }
  return Buffer.from(value);
}

function trustedNow(authority: AuthorizedS01ProgressAuthority): string {
  const now = Date.now();
  if (!Number.isSafeInteger(now)) throw new TypeError('trusted clock is invalid');
  if (now < Date.parse(authority.observed_at)) {
    throw new TypeError('trusted clock precedes operator authority observation');
  }
  if (now > Date.parse(authority.valid_until)) {
    throw new TypeError('operator authority is stale');
  }
  return new Date(now).toISOString();
}

function assertTargetBinding(
  authority: AuthorizedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
): void {
  const document = authority.authority.document;
  if (
    target.repository_id !== document.repository_id ||
    target.workspace_id !== document.workspace_id ||
    target.git_tool_id !== document.git_tool_id ||
    target.git_tool_sha256 !== document.git_tool_sha256 ||
    target.base_sha !== document.base_sha ||
    target.head_sha !== document.head_sha ||
    target.reviewed_ref_sha !== document.head_sha
  ) {
    throw new TypeError('verified repository target does not match operator authority');
  }
}

function checkpointSnapshot(
  store: EvidenceCheckpointStore,
  authority: AuthorizedS01ProgressAuthority,
): EvidenceCheckpointStore {
  assertTrustedEvidenceCheckpointStore(store);
  if (store === null || typeof store !== 'object' || typeof store.compareAndSet !== 'function') {
    throw new TypeError('evidence checkpoint store is unavailable');
  }
  const identity = checkpointStoreIdentityFor(store);
  const document = authority.authority.document;
  if (
    identity.checkpoint_store_id !== document.checkpoint_store_id ||
    identity.sha256 !== document.checkpoint_store_identity_sha256
  ) {
    throw new TypeError('checkpoint store identity does not match operator authority');
  }
  const compareAndSet = store.compareAndSet.bind(store);
  return Object.freeze({
    compareAndSet: (request: EvidenceCheckpointRequest) => compareAndSet(request),
  });
}

function requireContext(value: unknown): PrivateContextState {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('trusted completion context capability was not issued');
  }
  const state = issuedContexts.get(value);
  if (state === undefined) {
    throw new TypeError('trusted completion context capability was not issued');
  }
  return state;
}

export function createTrustedCompletionContext(
  input: TrustedCompletionContextInput,
): TrustedCompletionContext {
  assertAuthorizedS01ProgressAuthority(input.progress_authority);
  const checkpointStore = checkpointSnapshot(input.checkpoint_store, input.progress_authority);
  assertVerifiedRepositoryTarget(input.verified_target);
  revalidateExecutableRepositoryTarget(input.verified_target);
  assertTargetBinding(input.progress_authority, input.verified_target);
  trustedNow(input.progress_authority);

  const evidenceTrustRootBytes = ownedBytes(input.evidence_trust_root_bytes, 'evidence trust root');
  const executionTrustRootBytes = ownedBytes(
    input.execution_trust_root_bytes,
    'execution trust root',
  );
  const eventPolicyBytes = ownedBytes(input.event_policy_bytes, 'event policy');
  const freshnessPolicyBytes = ownedBytes(input.freshness_policy_bytes, 'freshness policy');
  assertCompletionIdentitySeparation(
    input.progress_authority,
    evidenceTrustRootBytes,
    executionTrustRootBytes,
  );

  const document = input.progress_authority.authority.document;
  loadEventPolicy(eventPolicyBytes);
  const freshnessPolicy = loadFreshnessPolicy(freshnessPolicyBytes);
  if (
    eventPolicySha256(eventPolicyBytes) !== document.event_policy_sha256 ||
    freshnessPolicy.sha256 !== document.freshness_policy_sha256
  ) {
    throw new TypeError('trusted completion policy digest does not match operator authority');
  }
  assertTrustedCurrentEpochProvider(input.current_epoch_provider);
  readCurrentEpochSnapshot(input.current_epoch_provider, input.progress_authority);

  const context: TrustedCompletionContext = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-trusted-completion-context-v1',
    progress_authority: input.progress_authority,
    verified_target: input.verified_target,
  });
  issuedContexts.set(context, {
    evidenceTrustRootBytes,
    executionTrustRootBytes,
    eventPolicyBytes,
    freshnessPolicyBytes,
    checkpointStore,
    currentEpochProvider: input.current_epoch_provider,
  });
  return context;
}

function freshnessSnapshotFor(
  context: TrustedCompletionContext,
  state: PrivateContextState,
): {
  readonly context: FreshnessContext;
  readonly snapshot: CurrentEpochProviderSnapshot;
} {
  assertAuthorizedS01ProgressAuthority(context.progress_authority);
  assertVerifiedRepositoryTarget(context.verified_target);
  assertTargetBinding(context.progress_authority, context.verified_target);
  trustedNow(context.progress_authority);
  const snapshot = readCurrentEpochSnapshot(state.currentEpochProvider, context.progress_authority);
  return Object.freeze({
    context: Object.freeze({
      now: snapshot.read_at,
      current_invalidation_epochs: new ImmutableStringMap([
        ...snapshot.epochs,
        ['source_head', `git:${context.verified_target.head_sha}`],
      ]),
    }),
    snapshot,
  });
}

export function freshnessContextFor(context: TrustedCompletionContext): FreshnessContext {
  return freshnessSnapshotFor(context, requireContext(context)).context;
}

export function completionResourcesFor(
  context: TrustedCompletionContext,
): TrustedCompletionResources {
  const state = requireContext(context);
  revalidateExecutableRepositoryTarget(context.verified_target);
  const freshness = freshnessSnapshotFor(context, state);
  return {
    evidence_trust_root_bytes: Buffer.from(state.evidenceTrustRootBytes),
    execution_trust_root_bytes: Buffer.from(state.executionTrustRootBytes),
    event_policy_bytes: Buffer.from(state.eventPolicyBytes),
    freshness_policy_bytes: Buffer.from(state.freshnessPolicyBytes),
    checkpoint_store: state.checkpointStore,
    freshness_context: freshness.context,
    current_epoch_snapshot: freshness.snapshot,
  };
}

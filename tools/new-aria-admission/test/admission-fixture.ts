import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import {
  createTrustedCompletionContext,
  TrustedCompletionContext,
  TrustedCompletionContextInput,
} from '../src/application/trusted-completion-context';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import { trustedContextInput } from './admission-trusted-context-fixture';
import { verifiedDossierResult } from './admission-verification-result-fixture';
import {
  currentEpochProviderFixture,
  currentEpochSnapshotBytes,
  currentEpochStoreFixture,
} from './current-epoch-fixture';
import { executionTrustRootBytes, trustedExecutionSigner } from './execution-key-fixture';
import { createGitTargetFixture, gitSha256, verifiedGitTarget } from './git-target-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
} from './operator-authority-fixture';
import type { OracleProofOverrides } from './oracle-proof-fixture';
import { defaultCheckpointStoreId } from './progress-authority-fixture';
import {
  authorityBytes,
  completionFixture,
} from './progress-fixture';
import { syntheticExecutionReceiptIssuer } from './synthetic-execution-receipt-fixture';
import { verifierDossier, verifierPlanSha256 } from './verifier-dossier-fixture';

type Fixture = ReturnType<typeof completionFixture>;
const temporaryRoots: string[] = [];
const temporaryStores: FileEvidenceCheckpointStore[] = [];
const temporaryEpochProviders: FileCurrentEpochProvider[] = [];

export function cleanupAdmissionFixtures(): void {
  for (const provider of temporaryEpochProviders.splice(0)) provider.close();
  for (const store of temporaryStores.splice(0)) store.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

function trustedCheckpointStore(): {
  readonly authority: {
    readonly checkpoint_store_id: string;
    readonly checkpoint_store_identity_sha256: string;
  };
  readonly root: string;
  readonly store: FileEvidenceCheckpointStore;
} {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-admission-checkpoint-'));
  temporaryRoots.push(root);
  const identityBytes = checkpointStoreIdentityBytes(defaultCheckpointStoreId, root);
  const store = new FileEvidenceCheckpointStore(root, identityBytes);
  temporaryStores.push(store);
  return {
    authority: {
      checkpoint_store_id: defaultCheckpointStoreId,
      checkpoint_store_identity_sha256: digest(identityBytes),
    },
    root,
    store,
  };
}

export interface MutableCompletionCandidate {
  event_bytes: Uint8Array;
  manifest_bytes: readonly Uint8Array[];
  objects: ReadonlyMap<string, Uint8Array>;
  evidence_attestation_bytes: Uint8Array;
}

export interface AdmissionScenario {
  readonly candidate: MutableCompletionCandidate;
  readonly context: TrustedCompletionContext;
  readonly context_input: TrustedCompletionContextInput;
  readonly fixture: Fixture;
  readonly authority_sha256: string;
  readonly checkpoint_root: string;
  readonly current_epoch_root: string;
  readonly write_current_epochs: ReturnType<typeof currentEpochProviderFixture>['writeSnapshot'];
}

export function admissionInput(overrides: OracleProofOverrides = {}): AdmissionScenario {
  const checkpoint = trustedCheckpointStore();
  const repository = createGitTargetFixture();
  temporaryRoots.push(repository.root);
  const target = {
    reviewed_ref: repository.reviewed_ref,
    base_sha: repository.base,
    head_sha: repository.head,
    git_tool_id: 'git',
    git_tool_sha256: gitSha256,
  };
  const observedAt = '2026-09-02T11:30:00.000Z';
  const validUntil = '2026-09-02T14:00:00.000Z';
  const executionRoot = executionTrustRootBytes(
    trustedExecutionSigner,
    'ATTEST_EXECUTION',
    {},
    { valid_from: observedAt, valid_until: validUntil },
  );
  const operatorTrustRoot = operatorTrustRootBytes();
  const verifierArgv = Object.freeze([
    'nodejs-20.11.1-linux-x64',
    'new-aria-admission-verifier',
    '--mode',
    'full',
    '--operator-trust-root-sha256',
    digest(operatorTrustRoot),
  ]);
  const currentEpochStore = currentEpochStoreFixture(operatorTrustRoot);
  temporaryRoots.push(currentEpochStore.root);
  const verificationPlanScope = {
    authority_sha256: '0'.repeat(64),
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: repository.base,
    head_sha: repository.head,
    evidence_id: 'S01-code-proof',
    verification_time: '2026-09-02T11:40:00.000Z',
    valid_until: '2026-09-02T13:00:00.000Z',
    epoch_provider_id: currentEpochStore.authority.invalidation_epoch_provider_id,
    epoch_provider_identity_sha256:
      currentEpochStore.authority.invalidation_epoch_provider_identity_sha256,
  };
  const checkpointAuthority = {
    ...checkpoint.authority,
    ...currentEpochStore.authority,
    execution_trust_root_sha256: digest(executionRoot),
    verification_plan_sha256: verifierPlanSha256(verificationPlanScope),
    verifier_argv_sha256: digest(canonicalJsonBytes(verifierArgv)),
  };
  const expectedAuthority = authorityBytes(checkpointAuthority, target);
  const operatorEnvelope = operatorEnvelopeBytes({
    authorityBytes: expectedAuthority,
    observedAt,
    validUntil,
  });
  const progressAuthority = authorizeS01ProgressAuthority({
    envelope_bytes: operatorEnvelope,
    trust_root_bytes: operatorTrustRoot,
    expected_trust_root_sha256: digest(operatorTrustRoot),
  });
  const currentEpochs = currentEpochProviderFixture(
    progressAuthority,
    operatorTrustRoot,
    currentEpochStore,
  );
  temporaryEpochProviders.push(currentEpochs.provider);
  const epochOptions = { observed_at: '2026-09-02T11:35:00.000Z' } as const;
  currentEpochs.writeSnapshot(epochOptions);
  const epochSnapshotBytes = currentEpochSnapshotBytes(progressAuthority, epochOptions);
  const verificationDossier = verifierDossier({
    ...verificationPlanScope,
    authority_sha256: progressAuthority.authority.sha256,
  });
  const verifiedTarget = verifiedGitTarget(repository);
  const verifiedDossier = verifiedDossierResult(
    verificationDossier,
    progressAuthority,
    verifiedTarget,
    currentEpochs.provider,
  );
  const issueReceipt = syntheticExecutionReceiptIssuer({
    authority_sha256: digest(expectedAuthority),
    authority_envelope_sha256: digest(operatorEnvelope),
    execution_trust_root_sha256: digest(executionRoot),
    execution_session_id: 'execution-session-s01-0001',
    signer_principal_id: trustedExecutionSigner.principalId,
    signer_private_key: trustedExecutionSigner.privateKey,
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: repository.base,
    head_sha: repository.head,
    tree_sha: verifiedTarget.tree_sha,
    issued_at: '2026-09-02T11:50:00.000Z',
    valid_until: validUntil,
  });
  const fixture = completionFixture(
    { ...overrides, argv: overrides.argv ?? verifierArgv },
    checkpointAuthority,
    target,
    issueReceipt,
    verifiedTarget.tree_sha,
    {
      authority_envelope_bytes: operatorEnvelope,
      operator_trust_root_bytes: operatorTrustRoot,
      current_epoch_snapshot_bytes: epochSnapshotBytes,
      current_epoch_provider_identity_sha256:
        currentEpochStore.authority.invalidation_epoch_provider_identity_sha256,
      current_epoch_revision: 1,
    },
    verificationDossier,
    verifiedDossier,
  );
  if (!fixture.authority.equals(expectedAuthority)) {
    throw new TypeError('admission fixture authority construction diverged');
  }
  const contextInput = trustedContextInput(
    fixture,
    checkpoint.store,
    verifiedTarget,
    executionRoot,
    progressAuthority,
    currentEpochs.provider,
  );
  return {
    candidate: {
      event_bytes: fixture.eventBytes,
      manifest_bytes: fixture.manifestBytesChain,
      objects: fixture.objects,
      evidence_attestation_bytes: fixture.attestation,
    },
    context: createTrustedCompletionContext(contextInput),
    context_input: contextInput,
    fixture,
    authority_sha256: fixture.authoritySha256,
    checkpoint_root: checkpoint.root,
    current_epoch_root: currentEpochStore.root,
    write_current_epochs: currentEpochs.writeSnapshot,
  };
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkpointStoreIdentityFor,
  FileEvidenceCheckpointStore,
} from '../src/adapters/file-evidence-checkpoint-store';
import type { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import {
  createTrustedCompletionContext,
  freshnessContextFor,
  type TrustedCompletionContextInput,
} from '../src/application/trusted-completion-context';
import type { ProgressAuthorityDocument } from '../src/domain/progress-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';
import {
  authorizeS01ProgressAuthority,
  type AuthorizedS01ProgressAuthority,
} from '../src/kernel/operator-progress-authority';

import { executionTrustRootBytes } from './execution-key-fixture';
import { currentEpochProviderFixture, currentEpochStoreFixture } from './current-epoch-fixture';
import { createGitTargetFixture, verifiedGitTarget } from './git-target-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
  trustedOperatorSigner,
} from './operator-authority-fixture';
import { completionFixture, eventPolicyBytes, freshnessPolicyBytes } from './progress-fixture';
import { untrustedTarget } from './untrusted-target-fixture';

const temporaryRoots: string[] = [];
const temporaryStores: FileEvidenceCheckpointStore[] = [];
const temporaryEpochProviders: FileCurrentEpochProvider[] = [];

function checkpointStore(): FileEvidenceCheckpointStore {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-checkpoint-'));
  temporaryRoots.push(root);
  const store = new FileEvidenceCheckpointStore(
    root,
    checkpointStoreIdentityBytes('new-aria-s01-checkpoint-store', root),
  );
  temporaryStores.push(store);
  return store;
}

function authorizedAuthority(
  evidenceTrustRoot: Uint8Array,
  authorityOverrides: Partial<ProgressAuthorityDocument> = {},
  operatorRoot = operatorTrustRootBytes(),
  epochAuthority: Partial<ProgressAuthorityDocument> = {},
): AuthorizedS01ProgressAuthority {
  const authorityBytes = s01ProgressAuthorityBytes({
    evidence_trust_root_sha256: digest(evidenceTrustRoot),
    ...epochAuthority,
    ...authorityOverrides,
  });
  return authorizeS01ProgressAuthority({
    envelope_bytes: operatorEnvelopeBytes({
      authorityBytes,
      validUntil: '2026-09-02T14:00:00.000Z',
    }),
    trust_root_bytes: operatorRoot,
    expected_trust_root_sha256: digest(operatorRoot),
  });
}

function contextInput(
  evidenceTrustRoot = completionFixture().trustRoot,
  executionTrustRoot = executionTrustRootBytes(),
): TrustedCompletionContextInput {
  const repository = createGitTargetFixture();
  temporaryRoots.push(repository.root);
  const target = verifiedGitTarget(repository);
  const checkpoint = checkpointStore();
  const checkpointIdentity = checkpointStoreIdentityFor(checkpoint);
  const operatorRoot = operatorTrustRootBytes();
  const currentEpochStore = currentEpochStoreFixture(operatorRoot);
  temporaryRoots.push(currentEpochStore.root);
  const progressAuthority = authorizedAuthority(
    evidenceTrustRoot,
    {
      execution_trust_root_sha256: digest(executionTrustRoot),
      base_sha: target.base_sha,
      head_sha: target.head_sha,
      git_tool_id: target.git_tool_id,
      git_tool_sha256: target.git_tool_sha256,
      checkpoint_store_id: checkpointIdentity.checkpoint_store_id,
      checkpoint_store_identity_sha256: checkpointIdentity.sha256,
    },
    operatorRoot,
    currentEpochStore.authority,
  );
  const currentEpochs = currentEpochProviderFixture(
    progressAuthority,
    operatorRoot,
    currentEpochStore,
  );
  temporaryEpochProviders.push(currentEpochs.provider);
  return {
    progress_authority: progressAuthority,
    verified_target: target,
    evidence_trust_root_bytes: evidenceTrustRoot,
    execution_trust_root_bytes: executionTrustRoot,
    event_policy_bytes: eventPolicyBytes,
    freshness_policy_bytes: freshnessPolicyBytes,
    checkpoint_store: checkpoint,
    current_epoch_provider: currentEpochs.provider,
  };
}

describe('trusted completion context', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const provider of temporaryEpochProviders.splice(0)) provider.close();
    for (const store of temporaryStores.splice(0)) store.close();
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('derives clock and every invalidation epoch from verified authority and target', () => {
    const context = createTrustedCompletionContext(contextInput());
    const freshness = freshnessContextFor(context);

    expect(freshness.now).toBe('2026-09-02T12:30:00.000Z');
    expect(Object.fromEntries(freshness.current_invalidation_epochs)).toEqual({
      authority: `sha256:${context.progress_authority.authority.sha256}`,
      dependency: `sha256:${'d'.repeat(64)}`,
      policy: `sha256:${'e'.repeat(64)}`,
      source_head: `git:${context.verified_target.head_sha}`,
      toolchain: `sha256:${'f'.repeat(64)}`,
      verifier: `sha256:${'1'.repeat(64)}`,
    });
  });

  it('rejects a structural copy that bypasses the issued-context capability', () => {
    const context = createTrustedCompletionContext(contextInput());
    expect(() => freshnessContextFor({ ...context })).toThrow(/context capability/);
  });

  it('rechecks operator authorization expiry when admission consumes the context', () => {
    const context = createTrustedCompletionContext(contextInput());
    jest.setSystemTime(new Date('2026-09-02T14:00:00.001Z'));
    expect(() => freshnessContextFor(context)).toThrow(/operator authority is stale/);
  });

  it('rejects a verifier-issued target outside the signed authority', () => {
    const input = contextInput();
    const mismatchedAuthority = authorizedAuthority(input.evidence_trust_root_bytes, {
      ...input.progress_authority.authority.document,
      head_sha: 'c'.repeat(40),
    });
    expect(() =>
      createTrustedCompletionContext({ ...input, progress_authority: mismatchedAuthority }),
    ).toThrow(/target.*authority/);
  });

  it('rejects a repository verifier outside the signed Git tool identity', () => {
    const input = contextInput();
    const authority = authorizedAuthority(input.evidence_trust_root_bytes, {
      ...input.progress_authority.authority.document,
      git_tool_sha256: '8'.repeat(64),
    });

    expect(() =>
      createTrustedCompletionContext({ ...input, progress_authority: authority }),
    ).toThrow(/target.*authority/);
  });

  it('does not release admission resources for a caller-defined Git target port', () => {
    const input = contextInput();

    expect(() =>
      createTrustedCompletionContext({ ...input, verified_target: untrustedTarget() }),
    ).toThrow(/trusted Git|execution snapshot/);
  });

  it('rejects operator principal reuse under an evidence capability', () => {
    const document = JSON.parse(completionFixture().trustRoot.toString()) as {
      keys: { principal_id: string; public_key_spki_der_base64: string }[];
    };
    const oracle = document.keys[1];
    if (oracle === undefined) throw new Error('oracle trust key fixture is missing');
    oracle.principal_id = trustedOperatorSigner.principalId;
    const evidenceRoot = canonicalJsonBytes(document);
    expect(() => createTrustedCompletionContext(contextInput(evidenceRoot))).toThrow(/separation/);
  });

  it('rejects operator key reuse through a different evidence principal alias', () => {
    const document = JSON.parse(completionFixture().trustRoot.toString()) as {
      keys: { principal_id: string; public_key_spki_der_base64: string }[];
    };
    const oracle = document.keys[1];
    if (oracle === undefined) throw new Error('oracle trust key fixture is missing');
    oracle.public_key_spki_der_base64 = trustedOperatorSigner.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const evidenceRoot = canonicalJsonBytes(document);
    expect(() => createTrustedCompletionContext(contextInput(evidenceRoot))).toThrow(/separation/);
  });

  it('rejects an unpinned execution trust root without releasing resources', () => {
    const input = contextInput();
    const attackerRoot = executionTrustRootBytes(undefined, 'ATTEST_EXECUTION', {
      root_note: 'not pinned',
    });

    expect(() =>
      createTrustedCompletionContext({
        ...input,
        execution_trust_root_bytes: attackerRoot,
      }),
    ).toThrow(/execution trust root digest/);
  });

  it('rejects a trusted checkpoint adapter outside the signed store identity', () => {
    const input = contextInput();

    expect(() =>
      createTrustedCompletionContext({ ...input, checkpoint_store: checkpointStore() }),
    ).toThrow(/checkpoint store identity.*authority/i);
  });
});

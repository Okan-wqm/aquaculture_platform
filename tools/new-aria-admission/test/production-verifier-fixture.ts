import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import { currentEpochSnapshotFileName } from '../src/adapters/file-current-epoch-binding';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { canonicalExecutionCwd } from '../src/runtime/execution-identity';

import { trustRootBytes } from './attestation-fixture';
import { currentEpochSnapshotBytes, currentEpochStoreFixture } from './current-epoch-fixture';
import { createExecutionRoster } from './execution-roster-fixture';
import { createGitTargetFixture, gitSha256 } from './git-target-fixture';
import { oracleBaselineInput } from './negative-control-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';
import { verifierDossier, verifierPlanSha256 } from './verifier-dossier-fixture';
import { executionTrustRootBytes } from './execution-receipt-fixture';

function instant(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString();
}

export interface ProductionVerifierFixtureOptions {
  readonly checkpoint_store_id?: string;
  readonly checkpoint_store_identity_sha256?: string;
}

export function productionVerifierFixture(
  verifierPath: string,
  options: ProductionVerifierFixtureOptions = {},
) {
  const repository = createGitTargetFixture();
  const operatorRoot = operatorTrustRootBytes();
  const epochStore = currentEpochStoreFixture(operatorRoot);
  const verifierSha256 = digest(readFileSync(verifierPath));
  const runtimeSha256 = digest(readFileSync(process.execPath));
  const operatorRootSha256 = digest(operatorRoot);
  const baselineArgs = Object.freeze([
    '--mode',
    'full',
    '--operator-trust-root-sha256',
    operatorRootSha256,
  ]);
  const verificationTime = instant(-60_000);
  const validUntil = instant(30 * 60_000);
  const authorityObservedAt = instant(-5 * 60_000);
  const executionRoot = executionTrustRootBytes(
    undefined,
    undefined,
    {},
    {
      valid_from: authorityObservedAt,
      valid_until: validUntil,
    },
  );
  const evidenceRoot = trustRootBytes();
  const planScope = {
    authority_sha256: '0'.repeat(64),
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: repository.base,
    head_sha: repository.head,
    evidence_id: 'S01-code-proof',
    verification_time: verificationTime,
    valid_until: validUntil,
    epoch_provider_id: epochStore.authority.invalidation_epoch_provider_id,
    epoch_provider_identity_sha256:
      epochStore.authority.invalidation_epoch_provider_identity_sha256,
    dependency_sha256: 'd'.repeat(64),
    policy_epoch_sha256: 'e'.repeat(64),
    toolchain_sha256: runtimeSha256,
    verifier_sha256: verifierSha256,
  };
  const authorityBytes = s01ProgressAuthorityBytes({
    base_sha: repository.base,
    head_sha: repository.head,
    reviewed_ref: repository.reviewed_ref,
    ...options,
    ...epochStore.authority,
    verification_plan_sha256: verifierPlanSha256(planScope),
    verifier_tool_id: 'new-aria-admission-verifier',
    verifier_sha256: verifierSha256,
    verifier_argv_sha256: digest(
      canonicalJsonBytes([
        `node@${process.version}`,
        'new-aria-admission-verifier',
        ...baselineArgs,
      ]),
    ),
    runtime_id: `node@${process.version}`,
    toolchain_sha256: runtimeSha256,
    execution_cwd_sha256: digest(Buffer.from(canonicalExecutionCwd('repo-1', 'workspace-1'))),
    execution_trust_root_sha256: digest(executionRoot),
    evidence_trust_root_sha256: digest(evidenceRoot),
    git_tool_id: 'git',
    git_tool_sha256: gitSha256,
  });
  const operatorEnvelope = operatorEnvelopeBytes({
    authorityBytes,
    observedAt: authorityObservedAt,
    validUntil,
  });
  const authority = authorizeS01ProgressAuthority({
    envelope_bytes: operatorEnvelope,
    trust_root_bytes: operatorRoot,
    expected_trust_root_sha256: operatorRootSha256,
  });
  const epochSnapshot = currentEpochSnapshotBytes(authority, {
    observed_at: instant(-2 * 60_000),
    valid_until: validUntil,
  });
  const currentEpochProvider = new FileCurrentEpochProvider({
    state_root: epochStore.root,
    genesis_identity_bytes: epochStore.identity_bytes,
    provider_id: epochStore.authority.invalidation_epoch_provider_id,
    operator_trust_root_bytes: operatorRoot,
    expected_operator_trust_root_sha256: operatorRootSha256,
  });
  const currentEpochSnapshotPath = join(epochStore.root, currentEpochSnapshotFileName);
  writeFileSync(currentEpochSnapshotPath, epochSnapshot, { mode: 0o600 });
  const dossier = verifierDossier({
    ...planScope,
    authority_sha256: authority.authority.sha256,
  });
  const baseline = oracleBaselineInput({
    authority_sha256: authority.authority.sha256,
    evidence_id: 'S01-code-proof',
    version: 3,
    observation_id: 'observation-0003',
    observed_at: verificationTime,
    claim: { program_id: 'new-aria-autonomous-engineering', sprint_id: 'S01' },
    freshness: { observed_at: verificationTime, valid_until: validUntil },
    target: {
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      base_sha: repository.base,
      head_sha: repository.head,
    },
    report: { sha256: '4'.repeat(64) },
    artifacts: [],
    verification_dossier: dossier,
  });
  const roster = createExecutionRoster(
    baseline,
    authority.authority.sha256,
    {
      operator_envelope_bytes: operatorEnvelope,
      operator_trust_root_bytes: operatorRoot,
      current_epoch_snapshot_bytes: epochSnapshot,
    },
    baseline,
  );
  return Object.freeze({
    authority,
    execution_trust_root_bytes: executionRoot,
    evidence_trust_root_bytes: evidenceRoot,
    baseline,
    operator_envelope_bytes: operatorEnvelope,
    operator_trust_root_bytes: operatorRoot,
    current_epoch_snapshot_bytes: epochSnapshot,
    current_epoch_snapshot_path: currentEpochSnapshotPath,
    current_epoch_provider: currentEpochProvider,
    current_epoch_store_identity_bytes: epochStore.identity_bytes,
    repository,
    epoch_store_root: epochStore.root,
    baseline_args: baselineArgs,
    operator_root_sha256: operatorRootSha256,
    verification_time: verificationTime,
    valid_until: validUntil,
    roster,
    dossier,
  });
}

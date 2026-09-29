import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProgressAuthorityDocument } from '../src/domain/progress-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { checkpointStoreIdentityBytes } from '../src/kernel/checkpoint-store-identity';
import { S01_PROGRESS_AUTHORITY_SCOPE } from '../src/kernel/operator-progress-authority';

import { trustRootBytes } from './attestation-fixture';
import { executionTrustRootBytes } from './execution-key-fixture';
import { verifierArgv, verifierCwd } from './oracle-proof-fixture';
import { defaultProgressTarget } from './progress-target-fixture';
import type { ProgressTargetFixture } from './progress-target-fixture';

export const defaultCheckpointStoreId = 'new-aria-s01-checkpoint-store';
export const defaultCheckpointStoreRoot = '/srv/new-aria/checkpoints/s01';
export const defaultCheckpointStoreIdentityBytes = checkpointStoreIdentityBytes(
  defaultCheckpointStoreId,
  defaultCheckpointStoreRoot,
);

export interface CheckpointAuthorityFixture {
  readonly checkpoint_store_id: string;
  readonly checkpoint_store_identity_sha256: string;
  readonly execution_trust_root_sha256?: string;
  readonly invalidation_epoch_provider_id?: string;
  readonly invalidation_epoch_provider_identity_sha256?: string;
  readonly verification_plan_sha256?: string;
  readonly verifier_argv_sha256?: string;
}

const defaultCheckpointAuthority = (): CheckpointAuthorityFixture => ({
  checkpoint_store_id: defaultCheckpointStoreId,
  checkpoint_store_identity_sha256: sha256(defaultCheckpointStoreIdentityBytes),
  invalidation_epoch_provider_id: 'new-aria-s01-current-epochs',
  invalidation_epoch_provider_identity_sha256: '9'.repeat(64),
  verification_plan_sha256: 'a'.repeat(64),
});

export function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const eventPolicyBytes = readFileSync(join(__dirname, '../policy/event-policy.json'));
export const freshnessPolicyBytes = readFileSync(
  join(__dirname, '../policy/freshness-policy.json'),
);

export const progressAuthority = (
  checkpoint = defaultCheckpointAuthority(),
  target: ProgressTargetFixture = defaultProgressTarget(),
): ProgressAuthorityDocument => ({
  schema_version: '1.0.0',
  contract_id: 'new-aria-progress-authority-v1',
  program_id: 'new-aria-autonomous-engineering',
  sprint_id: 'S01',
  repository_id: 'repo-1',
  workspace_id: 'workspace-1',
  reviewed_ref: target.reviewed_ref,
  base_sha: target.base_sha,
  head_sha: target.head_sha,
  event_policy_sha256: sha256(eventPolicyBytes),
  freshness_policy_sha256: sha256(freshnessPolicyBytes),
  evidence_trust_root_sha256: sha256(trustRootBytes()),
  execution_trust_root_sha256: sha256(executionTrustRootBytes()),
  execution_session_id: 'execution-session-s01-0001',
  ...checkpoint,
  invalidation_epoch_provider_id:
    checkpoint.invalidation_epoch_provider_id ?? 'new-aria-s01-current-epochs',
  invalidation_epoch_provider_identity_sha256:
    checkpoint.invalidation_epoch_provider_identity_sha256 ?? '9'.repeat(64),
  verification_plan_sha256: checkpoint.verification_plan_sha256 ?? 'a'.repeat(64),
  evidence_id: 'S01-code-proof',
  evidence_version: 4,
  dependency_sha256: 'd'.repeat(64),
  policy_epoch_sha256: 'e'.repeat(64),
  verifier_tool_id: 'new-aria-admission-verifier',
  toolchain_sha256: 'f'.repeat(64),
  verifier_sha256: '1'.repeat(64),
  verifier_argv_sha256:
    checkpoint.verifier_argv_sha256 ?? sha256(canonicalJsonBytes(verifierArgv)),
  runtime_id: 'nodejs-20.11.1-linux-x64',
  execution_cwd_sha256: sha256(Buffer.from(verifierCwd)),
  git_tool_id: target.git_tool_id,
  git_tool_sha256: target.git_tool_sha256,
  oracle_id: 'new-aria-s01-admission-oracle',
  oracle_sha256: '2'.repeat(64),
  required_negative_control_ids: [
    'NC-S01-EVENT-HASH-TAMPER',
    'NC-S01-EVIDENCE-DIGEST-TAMPER',
    'NC-S01-STALE-EVIDENCE',
    'NC-S01-UNAUTHORIZED-TARGET',
  ],
  acceptance_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids],
  finding_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.finding_ids],
});

export const authorityBytes = (
  checkpoint?: CheckpointAuthorityFixture,
  target?: ProgressTargetFixture,
): Buffer => canonicalJsonBytes(progressAuthority(checkpoint, target));

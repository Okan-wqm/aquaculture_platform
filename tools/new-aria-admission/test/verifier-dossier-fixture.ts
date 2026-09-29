import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { computeEventHash } from '../src/kernel/event-chain';
import { S01_PROGRESS_AUTHORITY_SCOPE } from '../src/kernel/operator-progress-authority';

import { digest } from './operator-authority-fixture';

export interface VerificationDossierScope {
  readonly authority_sha256: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly evidence_id: string;
  readonly verification_time: string;
  readonly valid_until: string;
  readonly epoch_provider_id?: string;
  readonly epoch_provider_identity_sha256?: string;
  readonly dependency_sha256?: string;
  readonly policy_epoch_sha256?: string;
  readonly toolchain_sha256?: string;
  readonly verifier_sha256?: string;
  readonly repository_artifact_path?: string;
  readonly repository_artifact_bytes?: Uint8Array;
}

const policyRoot = join(__dirname, '../policy');
const eventPolicy = readFileSync(join(policyRoot, 'event-policy.json'));
const freshnessPolicy = readFileSync(join(policyRoot, 'freshness-policy.json'));

const encoded = (bytes: Uint8Array) => ({
  bytes_base64: Buffer.from(bytes).toString('base64'),
  sha256: digest(bytes),
});

function before(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) - milliseconds).toISOString();
}

function manifests(scope: VerificationDossierScope): readonly Buffer[] {
  const states = ['READY', 'IN_PROGRESS', 'VERIFYING'] as const;
  let previous: string | null = null;
  return states.map((state, index) => {
    const bytes = Buffer.concat([
      canonicalJsonBytes({
        schema_version: '1.0.0',
        contract_id: 'aria-evidence-manifest-v1',
        evidence_id: scope.evidence_id,
        version: index + 1,
        previous_manifest_sha256: previous,
        observed_at: before(scope.verification_time, (3 - index) * 60_000),
        observation_id: `observation-${(index + 1).toString().padStart(4, '0')}`,
        authority_sha256: scope.authority_sha256,
        claim: {
          program_id: S01_PROGRESS_AUTHORITY_SCOPE.program_id,
          sprint_id: S01_PROGRESS_AUTHORITY_SCOPE.sprint_id,
          state,
          acceptance_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids],
          finding_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.finding_ids],
        },
        identities: {
          producer_principal_id: 'producer-1',
          reviewer_principal_id: 'reviewer-1',
          oracle_principal_id: 'oracle-1',
          appellate_principal_id: 'appellate-1',
        },
        target: {
          repository_id: scope.repository_id,
          workspace_id: scope.workspace_id,
          base_sha: scope.base_sha,
          head_sha: scope.head_sha,
          deployed_sha: null,
        },
      }),
      Buffer.from('\n'),
    ]);
    previous = digest(bytes);
    return bytes;
  });
}

function events(scope: VerificationDossierScope, history: readonly Buffer[]): Buffer {
  const transitions = [
    ['PLANNED', 'READY'],
    ['READY', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'VERIFYING'],
  ] as const;
  let previousHash = '0'.repeat(64);
  const rows = transitions.map(([fromState, toState], index) => {
    const manifest = history[index];
    if (manifest === undefined) throw new TypeError('dossier fixture history is incomplete');
    const evidenceSha256 = digest(manifest);
    const event = {
      schema_version: '1.0.0',
      contract_id: 'aria-event-cjson-v1',
      program_id: S01_PROGRESS_AUTHORITY_SCOPE.program_id,
      event_id: `s01-${(index + 1).toString().padStart(4, '0')}`,
      sequence: index + 1,
      sprint_id: S01_PROGRESS_AUTHORITY_SCOPE.sprint_id,
      from_state: fromState,
      to_state: toState,
      occurred_at: before(scope.verification_time, (3 - index) * 60_000 - 30_000),
      actor_id: 's01-controller',
      target_sha: scope.head_sha,
      authority_sha256: scope.authority_sha256,
      evidence_uri: `aria-evidence://sha256/${evidenceSha256}`,
      evidence_sha256: evidenceSha256,
      previous_hash: previousHash,
      event_hash: '',
    };
    event.event_hash = computeEventHash(event);
    previousHash = event.event_hash;
    return canonicalJsonBytes(event);
  });
  return Buffer.from(`${rows.map((row) => row.toString()).join('\n')}\n`);
}

export function verifierDossier(scope: VerificationDossierScope) {
  const history = manifests(scope);
  const eventChain = events(scope, history);
  const candidateBytes = Buffer.from(scope.repository_artifact_bytes ?? Buffer.from('head\n'));
  const candidatePath = scope.repository_artifact_path ?? 'reviewed.txt';
  const artifactReference = {
    path: candidatePath,
    uri: `aria-evidence://sha256/${digest(candidateBytes)}`,
    sha256: digest(candidateBytes),
  };
  const freshness = {
    type: 'SOURCE_CODE_ORACLE',
    observed_at: scope.verification_time,
    valid_until: scope.valid_until,
    invalidation_epochs: [
      { key: 'authority', epoch: `sha256:${scope.authority_sha256}` },
      { key: 'dependency', epoch: `sha256:${scope.dependency_sha256 ?? 'd'.repeat(64)}` },
      { key: 'policy', epoch: `sha256:${scope.policy_epoch_sha256 ?? 'e'.repeat(64)}` },
      { key: 'source_head', epoch: `git:${scope.head_sha}` },
      { key: 'toolchain', epoch: `sha256:${scope.toolchain_sha256 ?? 'f'.repeat(64)}` },
      { key: 'verifier', epoch: `sha256:${scope.verifier_sha256 ?? '1'.repeat(64)}` },
    ],
  };
  const plan = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-s01-verification-plan-v1',
    repository_id: scope.repository_id,
    workspace_id: scope.workspace_id,
    base_sha: scope.base_sha,
    head_sha: scope.head_sha,
    program_id: S01_PROGRESS_AUTHORITY_SCOPE.program_id,
    sprint_id: S01_PROGRESS_AUTHORITY_SCOPE.sprint_id,
    evidence_id: scope.evidence_id,
    verification_time: scope.verification_time,
    valid_until: scope.valid_until,
    acceptance_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.acceptance_ids],
    finding_ids: [...S01_PROGRESS_AUTHORITY_SCOPE.finding_ids],
    identities: {
      producer_principal_id: 'producer-1',
      reviewer_principal_id: 'reviewer-1',
      oracle_principal_id: 'oracle-1',
      appellate_principal_id: 'appellate-1',
    },
    epoch_provider_id: scope.epoch_provider_id ?? 'new-aria-s01-current-epochs',
    epoch_provider_identity_sha256: scope.epoch_provider_identity_sha256 ?? '9'.repeat(64),
    history: ['READY', 'IN_PROGRESS', 'VERIFYING'].map((state, index) => ({
      state,
      event_id: `s01-${(index + 1).toString().padStart(4, '0')}`,
      actor_id: 's01-controller',
      observation_id: `observation-${(index + 1).toString().padStart(4, '0')}`,
      manifest_observed_at: before(scope.verification_time, (3 - index) * 60_000),
      event_occurred_at: before(scope.verification_time, (3 - index) * 60_000 - 30_000),
    })),
    event_policy: encoded(eventPolicy),
    freshness_policy: encoded(freshnessPolicy),
    objects: [{ ...artifactReference, bytes_base64: candidateBytes.toString('base64') }],
  };
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-s01-verification-dossier-v1',
    authority_sha256: scope.authority_sha256,
    plan,
    event_chain: encoded(eventChain),
    manifest_chain: history.map(encoded),
    freshness,
    current_invalidation_epochs: freshness.invalidation_epochs,
  };
}

export const verifierDossierBytes = (scope: VerificationDossierScope): Buffer =>
  canonicalJsonBytes(verifierDossier(scope));

export const verifierPlanSha256 = (scope: VerificationDossierScope): string =>
  digest(canonicalJsonBytes(verifierDossier(scope).plan));

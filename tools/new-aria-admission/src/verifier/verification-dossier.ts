import { verifyEventChain } from '../kernel/event-chain';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from '../kernel/evidence-object';
import { assertFreshnessProofShape, evaluateFreshness } from '../kernel/freshness';
import { loadFreshnessPolicy } from '../kernel/freshness-policy';
import { loadEventPolicy } from '../kernel/policy';
import type { JsonRecord } from '../kernel/evidence-object';
import type { JsonValue } from '../kernel/strict-json';

import { decodeDossierBytes } from './dossier-bytes';
import { verifyDossierHistory } from './dossier-history';
import { verifyRepositoryArtifactClosure } from './repository-artifact';
import type { RepositoryArtifactSource } from './repository-artifact';
import { loadVerificationPlan } from './verification-plan';
import type { VerificationPlanBinding } from './verification-plan';
import { canonicalVerifyingProjection } from './verifying-projection';
import { rejectVerification } from './verification-rejection';

const dossierKeys = [
  'schema_version',
  'contract_id',
  'authority_sha256',
  'plan',
  'event_chain',
  'manifest_chain',
  'freshness',
  'current_invalidation_epochs',
] as const;

export interface TrustedDossierScope extends VerificationPlanBinding {
  readonly repository_artifacts: RepositoryArtifactSource;
  readonly event_policy_sha256: string;
  readonly freshness_policy_sha256: string;
  readonly current_time: string;
  readonly current_invalidation_epochs: ReadonlyMap<string, string>;
}

export interface VerifiedDossierResult {
  readonly verification_plan_sha256: string;
  readonly verifying_projection_bytes: Buffer;
  readonly verifying_projection_sha256: string;
  readonly event_chain_sha256: string;
  readonly history_sha256: string;
  readonly object_closure_sha256: string;
  readonly event_chain_bytes: Buffer;
  readonly manifest_chain_bytes: readonly Buffer[];
  readonly manifest_chain_sha256s: readonly string[];
}

function dossierRecord(value: JsonValue): JsonRecord {
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, dossierKeys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-s01-verification-dossier-v1'
  )
    throw new TypeError('S01 verification dossier is not canonical, closed, or versioned');
  return value;
}

function exactCurrentEpochs(
  value: JsonValue | undefined,
  expected: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(value) || value.length !== expected.size) {
    throw new TypeError('dossier current invalidation epoch roster is incomplete');
  }
  const actual = new Map<string, string>();
  for (const entry of value) {
    if (
      !isJsonRecord(entry) ||
      !hasExactKeys(entry, ['epoch', 'key']) ||
      typeof entry.key !== 'string' ||
      typeof entry.epoch !== 'string' ||
      actual.has(entry.key)
    )
      throw new TypeError('dossier current invalidation epoch is invalid');
    actual.set(entry.key, entry.epoch);
  }
  for (const [key, epoch] of expected) {
    if (actual.get(key) !== epoch) {
      throw new TypeError('dossier current invalidation epochs differ from external authority');
    }
  }
}

function historyEntries(history: readonly JsonRecord[]) {
  return history.map((entry) => ({
    state: requiredText(entry.state, 'plan history state'),
    event_id: requiredText(entry.event_id, 'plan history event ID'),
    actor_id: requiredText(entry.actor_id, 'plan history actor'),
    observation_id: requiredText(entry.observation_id, 'plan history observation ID'),
    manifest_observed_at: requiredText(
      entry.manifest_observed_at,
      'plan history manifest observation',
    ),
    event_occurred_at: requiredText(entry.event_occurred_at, 'plan history event occurrence'),
  }));
}

export function verifyS01VerificationDossier(
  value: JsonValue,
  scope: TrustedDossierScope,
): VerifiedDossierResult {
  const dossier = dossierRecord(value);
  if (requiredSha256(dossier.authority_sha256, 'dossier authority') !== scope.authority_sha256) {
    throw new TypeError('S01 verification dossier authority is not bound');
  }
  const plan = loadVerificationPlan(dossier.plan, scope);
  const eventPolicy = decodeDossierBytes(plan.record.event_policy, 'dossier event policy');
  const freshnessPolicy = decodeDossierBytes(
    plan.record.freshness_policy,
    'dossier freshness policy',
  );
  if (
    eventPolicy.sha256 !== scope.event_policy_sha256 ||
    freshnessPolicy.sha256 !== scope.freshness_policy_sha256
  )
    throw new TypeError('dossier policy digest differs from signed authority');
  const parsedEventPolicy = loadEventPolicy(eventPolicy.bytes);
  const parsedFreshnessPolicy = loadFreshnessPolicy(freshnessPolicy.bytes);
  const eventChain = decodeDossierBytes(dossier.event_chain, 'dossier event chain');
  let events;
  try {
    events = verifyEventChain(eventChain.bytes, parsedEventPolicy);
  } catch {
    rejectVerification('EVENT_CONTEXT_PROBE_MISMATCH', 'dossier event chain verification failed');
  }
  if (events.some((event) => event.target_sha !== scope.head_sha)) {
    rejectVerification('TARGET_HEAD_NOT_AUTHORIZED', 'dossier event target is unauthorized');
  }
  let history: ReturnType<typeof verifyDossierHistory>;
  try {
    history = verifyDossierHistory(dossier.manifest_chain, events, {
      authority_sha256: scope.authority_sha256,
      repository_id: scope.repository_id,
      workspace_id: scope.workspace_id,
      base_sha: scope.base_sha,
      head_sha: scope.head_sha,
      evidence_id: scope.evidence_id,
      program_id: scope.program_id,
      sprint_id: scope.sprint_id,
      acceptance_ids: scope.acceptance_ids,
      finding_ids: scope.finding_ids,
      identities: plan.identities,
      history: historyEntries(plan.history),
    });
  } catch {
    rejectVerification(
      'EVIDENCE_CONTEXT_PROBE_MISMATCH',
      'dossier event and evidence history verification failed',
    );
  }
  const objectClosureSha256 = verifyRepositoryArtifactClosure(
    plan.record.objects,
    scope.repository_artifacts,
  );
  try {
    assertFreshnessProofShape(dossier.freshness);
  } catch {
    rejectVerification('FRESHNESS_CONTEXT_STALE', 'dossier freshness proof is invalid');
  }
  exactCurrentEpochs(dossier.current_invalidation_epochs, scope.current_invalidation_epochs);
  if (
    dossier.freshness.observed_at !== plan.verification_time ||
    dossier.freshness.valid_until !== plan.valid_until ||
    evaluateFreshness(
      dossier.freshness,
      { now: scope.current_time, current_invalidation_epochs: scope.current_invalidation_epochs },
      parsedFreshnessPolicy.document,
    ) !== 'CURRENT'
  )
    rejectVerification('FRESHNESS_CONTEXT_STALE', 'S01 verification dossier is stale');
  const tail = events.at(-1);
  if (tail === undefined || tail.to_state !== 'VERIFYING') {
    throw new TypeError('S01 verification dossier does not end at VERIFYING');
  }
  const projection = canonicalVerifyingProjection({
    program_id: scope.program_id,
    sprint_id: scope.sprint_id,
    head_sha: scope.head_sha,
    authority_sha256: scope.authority_sha256,
    verification_time: plan.verification_time,
    valid_until: plan.valid_until,
    event_chain_sha256: eventChain.sha256,
    history_sha256: history.sha256,
    object_closure_sha256: objectClosureSha256,
    event_policy_sha256: eventPolicy.sha256,
    freshness_policy_sha256: freshnessPolicy.sha256,
    tail_event_hash: requiredSha256(tail.event_hash, 'dossier event tail'),
  });
  return Object.freeze({
    verification_plan_sha256: scope.verification_plan_sha256,
    verifying_projection_bytes: projection,
    verifying_projection_sha256: digestBytes(projection),
    event_chain_sha256: eventChain.sha256,
    history_sha256: history.sha256,
    object_closure_sha256: objectClosureSha256,
    event_chain_bytes: Buffer.from(eventChain.bytes),
    manifest_chain_bytes: history.manifest_bytes,
    manifest_chain_sha256s: history.manifest_sha256s,
  });
}

import { canonicalJsonBytes, compareCodePoints } from '../kernel/canonical-json';
import { sha40 } from '../kernel/evidence-manifest-schema';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from '../kernel/evidence-object';
import { requireIdentifier } from '../kernel/identifiers';
import type { JsonRecord } from '../kernel/evidence-object';
import type { JsonValue } from '../kernel/strict-json';

const keys = [
  'schema_version',
  'contract_id',
  'repository_id',
  'workspace_id',
  'base_sha',
  'head_sha',
  'program_id',
  'sprint_id',
  'evidence_id',
  'verification_time',
  'valid_until',
  'acceptance_ids',
  'finding_ids',
  'identities',
  'epoch_provider_id',
  'epoch_provider_identity_sha256',
  'history',
  'event_policy',
  'freshness_policy',
  'objects',
] as const;
const historyKeys = [
  'state',
  'event_id',
  'actor_id',
  'observation_id',
  'manifest_observed_at',
  'event_occurred_at',
] as const;
const identityKeys = [
  'producer_principal_id',
  'reviewer_principal_id',
  'oracle_principal_id',
  'appellate_principal_id',
] as const;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface VerificationPlanBinding {
  readonly authority_sha256: string;
  readonly verification_plan_sha256: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly evidence_id: string;
  readonly program_id: string;
  readonly sprint_id: string;
  readonly acceptance_ids: readonly string[];
  readonly finding_ids: readonly string[];
  readonly epoch_provider_id: string;
  readonly epoch_provider_identity_sha256: string;
}

export interface VerifiedVerificationPlan extends VerificationPlanBinding {
  readonly record: JsonRecord;
  readonly identities: JsonRecord;
  readonly history: readonly JsonRecord[];
  readonly verification_time: string;
  readonly valid_until: string;
}

function canonicalTimestamp(value: JsonValue | undefined, label: string): string {
  const result = requiredText(value, label);
  const parsed = Date.parse(result);
  if (
    !timestamp.test(result) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== result
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return result;
}

function identifiers(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} is invalid`);
  const result = value.map((entry) => requireIdentifier(entry, label));
  const sorted = [...result].sort(compareCodePoints);
  if (
    new Set(result).size !== result.length ||
    result.some((entry, index) => entry !== sorted[index] || !pattern.test(entry))
  )
    throw new TypeError(`${label} is not unique and sorted`);
  return Object.freeze(result);
}

function planIdentities(value: JsonValue | undefined): JsonRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, identityKeys)) {
    throw new TypeError('verification plan identities are invalid');
  }
  const principals = identityKeys.map((key) => requireIdentifier(value[key], `plan ${key}`));
  if (new Set(principals).size !== principals.length) {
    throw new TypeError('verification plan identities are not separated');
  }
  return value;
}

function planHistory(value: JsonValue | undefined): readonly JsonRecord[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError('verification plan history must have three transitions');
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (!isJsonRecord(entry) || !hasExactKeys(entry, historyKeys)) {
        throw new TypeError('verification plan history entry is invalid');
      }
      const expectedState = ['READY', 'IN_PROGRESS', 'VERIFYING'][index];
      if (
        entry.state !== expectedState ||
        requireIdentifier(entry.event_id, 'plan event ID') !==
          `s01-${(index + 1).toString().padStart(4, '0')}`
      )
        throw new TypeError('verification plan transition identity is invalid');
      requireIdentifier(entry.actor_id, 'plan actor');
      requireIdentifier(entry.observation_id, 'plan observation');
      const observed = canonicalTimestamp(entry.manifest_observed_at, 'plan manifest observation');
      const occurred = canonicalTimestamp(entry.event_occurred_at, 'plan event occurrence');
      if (Date.parse(observed) > Date.parse(occurred)) {
        throw new TypeError('verification plan event precedes its evidence');
      }
      return entry;
    }),
  );
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function loadVerificationPlan(
  value: JsonValue | undefined,
  binding: VerificationPlanBinding,
): VerifiedVerificationPlan {
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-s01-verification-plan-v1' ||
    digestBytes(canonicalJsonBytes(value)) !== binding.verification_plan_sha256
  )
    throw new TypeError('verification plan is not the signed canonical plan');
  const acceptanceIds = identifiers(
    value.acceptance_ids,
    /^ACC-[A-Z0-9-]+$/u,
    'plan acceptance IDs',
  );
  const findingIds = identifiers(value.finding_ids, /^ARIA-AUDIT-\d{3}$/u, 'plan finding IDs');
  const baseSha = requiredText(value.base_sha, 'plan base SHA');
  const headSha = requiredText(value.head_sha, 'plan head SHA');
  if (
    !sha40.test(baseSha) ||
    !sha40.test(headSha) ||
    requireIdentifier(value.repository_id, 'plan repository') !== binding.repository_id ||
    requireIdentifier(value.workspace_id, 'plan workspace') !== binding.workspace_id ||
    baseSha !== binding.base_sha ||
    headSha !== binding.head_sha ||
    requireIdentifier(value.evidence_id, 'plan evidence') !== binding.evidence_id ||
    requireIdentifier(value.program_id, 'plan program') !== binding.program_id ||
    requireIdentifier(value.sprint_id, 'plan sprint') !== binding.sprint_id ||
    requireIdentifier(value.epoch_provider_id, 'plan epoch provider') !==
      binding.epoch_provider_id ||
    requiredSha256(value.epoch_provider_identity_sha256, 'plan epoch provider identity') !==
      binding.epoch_provider_identity_sha256 ||
    !same(acceptanceIds, binding.acceptance_ids) ||
    !same(findingIds, binding.finding_ids)
  )
    throw new TypeError('verification plan does not match signed authority scope');
  return Object.freeze({
    ...binding,
    record: value,
    identities: planIdentities(value.identities),
    history: planHistory(value.history),
    verification_time: canonicalTimestamp(value.verification_time, 'plan verification time'),
    valid_until: canonicalTimestamp(value.valid_until, 'plan validity deadline'),
  });
}

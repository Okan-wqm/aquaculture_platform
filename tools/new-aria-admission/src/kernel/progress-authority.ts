import { createHash } from 'node:crypto';

import { LoadedProgressAuthority, ProgressAuthorityDocument } from '../domain/progress-contracts';

import { canonicalJsonBytes } from './canonical-json';
import { requireIdentifier } from './identifiers';
import {
  progressAuthorityDigest,
  sortedProgressAuthorityIdentifiers,
} from './progress-authority-fields';
import { requireCanonicalReviewedRef } from './reviewed-ref';
import { JsonValue, parseStrictJson } from './strict-json';

const keys = [
  'schema_version',
  'contract_id',
  'program_id',
  'sprint_id',
  'repository_id',
  'workspace_id',
  'reviewed_ref',
  'base_sha',
  'head_sha',
  'event_policy_sha256',
  'freshness_policy_sha256',
  'evidence_trust_root_sha256',
  'execution_trust_root_sha256',
  'execution_session_id',
  'checkpoint_store_id',
  'checkpoint_store_identity_sha256',
  'invalidation_epoch_provider_id',
  'invalidation_epoch_provider_identity_sha256',
  'verification_plan_sha256',
  'evidence_id',
  'evidence_version',
  'dependency_sha256',
  'policy_epoch_sha256',
  'verifier_tool_id',
  'toolchain_sha256',
  'verifier_sha256',
  'verifier_argv_sha256',
  'runtime_id',
  'execution_cwd_sha256',
  'git_tool_id',
  'git_tool_sha256',
  'oracle_id',
  'oracle_sha256',
  'required_negative_control_ids',
  'acceptance_ids',
  'finding_ids',
] as const;
const acceptanceId = /^ACC-[A-Z0-9-]+$/u;
const findingId = /^ARIA-AUDIT-\d{3}$/u;
const sha40 = /^[a-f0-9]{40}$/u;

type JsonRecord = { [key: string]: JsonValue };

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: JsonRecord): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

function nonEmptyString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function loadProgressAuthority(bytes: Uint8Array): LoadedProgressAuthority {
  const value = parseStrictJson(bytes);
  if (!isRecord(value) || !exactKeys(value)) {
    throw new TypeError('progress authority schema is open or incomplete');
  }
  if (!canonicalJsonBytes(value).equals(Buffer.from(bytes))) {
    throw new TypeError('progress authority must use canonical JSON');
  }
  if (value.schema_version !== '1.0.0' || value.contract_id !== 'new-aria-progress-authority-v1') {
    throw new TypeError('progress authority contract identity mismatch');
  }
  const programId = requireIdentifier(value.program_id, 'progress authority program identifier');
  const sprintId = requireIdentifier(value.sprint_id, 'progress authority sprint identifier');
  const repositoryId = requireIdentifier(
    value.repository_id,
    'progress authority repository identifier',
  );
  const workspaceId = requireIdentifier(
    value.workspace_id,
    'progress authority workspace identifier',
  );
  const reviewedRef = requireCanonicalReviewedRef(
    value.reviewed_ref,
    'progress authority reviewed_ref',
  );
  const evidenceId = requireIdentifier(value.evidence_id, 'progress authority evidence identifier');
  const executionSessionId = requireIdentifier(
    value.execution_session_id,
    'progress authority execution session identifier',
  );
  const checkpointStoreId = requireIdentifier(
    value.checkpoint_store_id,
    'progress authority checkpoint store identifier',
  );
  const invalidationEpochProviderId = requireIdentifier(
    value.invalidation_epoch_provider_id,
    'progress authority invalidation epoch provider identifier',
  );
  const oracleId = requireIdentifier(value.oracle_id, 'progress authority oracle identifier');
  const verifierToolId = requireIdentifier(
    value.verifier_tool_id,
    'progress authority verifier identifier',
  );
  const runtimeId = requireIdentifier(value.runtime_id, 'progress authority runtime identifier');
  const gitToolId = requireIdentifier(value.git_tool_id, 'progress authority Git tool identifier');
  if (!Number.isSafeInteger(value.evidence_version) || (value.evidence_version as number) < 1) {
    throw new TypeError('progress authority evidence version is invalid');
  }
  const baseSha = nonEmptyString(value.base_sha, 'progress authority base_sha');
  const headSha = nonEmptyString(value.head_sha, 'progress authority head_sha');
  for (const [field, targetSha] of [
    ['base_sha', baseSha],
    ['head_sha', headSha],
  ] as const) {
    if (!sha40.test(targetSha)) {
      throw new TypeError(`progress authority ${field} is invalid`);
    }
  }
  if (baseSha === headSha) {
    throw new TypeError('progress authority cannot authorize an empty target range');
  }
  const eventPolicySha256 = progressAuthorityDigest(value.event_policy_sha256, 'event_policy_sha256');
  const freshnessPolicySha256 = progressAuthorityDigest(
    value.freshness_policy_sha256,
    'freshness_policy_sha256',
  );
  const trustRootSha256 = progressAuthorityDigest(
    value.evidence_trust_root_sha256,
    'evidence_trust_root_sha256',
  );
  const executionTrustRootSha256 = progressAuthorityDigest(
    value.execution_trust_root_sha256,
    'execution_trust_root_sha256',
  );
  const checkpointStoreIdentitySha256 = progressAuthorityDigest(
    value.checkpoint_store_identity_sha256,
    'checkpoint_store_identity_sha256',
  );
  const invalidationEpochProviderIdentitySha256 = progressAuthorityDigest(
    value.invalidation_epoch_provider_identity_sha256,
    'invalidation_epoch_provider_identity_sha256',
  );
  const verificationPlanSha256 = progressAuthorityDigest(
    value.verification_plan_sha256,
    'verification_plan_sha256',
  );
  if (executionTrustRootSha256 === trustRootSha256) {
    throw new TypeError('execution and evidence trust roots must be distinct');
  }
  const dependencySha256 = progressAuthorityDigest(value.dependency_sha256, 'dependency_sha256');
  const policyEpochSha256 = progressAuthorityDigest(value.policy_epoch_sha256, 'policy_epoch_sha256');
  const toolchainSha256 = progressAuthorityDigest(value.toolchain_sha256, 'toolchain_sha256');
  const verifierSha256 = progressAuthorityDigest(value.verifier_sha256, 'verifier_sha256');
  const verifierArgvSha256 = progressAuthorityDigest(value.verifier_argv_sha256, 'verifier_argv_sha256');
  const executionCwdSha256 = progressAuthorityDigest(value.execution_cwd_sha256, 'execution_cwd_sha256');
  const gitToolSha256 = progressAuthorityDigest(value.git_tool_sha256, 'git_tool_sha256');
  const oracleSha256 = progressAuthorityDigest(value.oracle_sha256, 'oracle_sha256');
  const acceptanceIds = sortedProgressAuthorityIdentifiers(
    value.acceptance_ids,
    acceptanceId,
    'progress authority acceptance IDs',
  );
  const findingIds = sortedProgressAuthorityIdentifiers(
    value.finding_ids,
    findingId,
    'progress authority finding IDs',
  );
  const negativeControlIds = sortedProgressAuthorityIdentifiers(
    value.required_negative_control_ids,
    /^NC-[A-Z0-9-]+$/u,
    'progress authority negative control IDs',
  );
  const document: ProgressAuthorityDocument = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-progress-authority-v1',
    program_id: programId,
    sprint_id: sprintId,
    repository_id: repositoryId,
    workspace_id: workspaceId,
    reviewed_ref: reviewedRef,
    base_sha: baseSha,
    head_sha: headSha,
    event_policy_sha256: eventPolicySha256,
    freshness_policy_sha256: freshnessPolicySha256,
    evidence_trust_root_sha256: trustRootSha256,
    execution_trust_root_sha256: executionTrustRootSha256,
    execution_session_id: executionSessionId,
    checkpoint_store_id: checkpointStoreId,
    checkpoint_store_identity_sha256: checkpointStoreIdentitySha256,
    invalidation_epoch_provider_id: invalidationEpochProviderId,
    invalidation_epoch_provider_identity_sha256: invalidationEpochProviderIdentitySha256,
    verification_plan_sha256: verificationPlanSha256,
    evidence_id: evidenceId,
    evidence_version: Number(value.evidence_version),
    dependency_sha256: dependencySha256,
    policy_epoch_sha256: policyEpochSha256,
    verifier_tool_id: verifierToolId,
    toolchain_sha256: toolchainSha256,
    verifier_sha256: verifierSha256,
    verifier_argv_sha256: verifierArgvSha256,
    runtime_id: runtimeId,
    execution_cwd_sha256: executionCwdSha256,
    git_tool_id: gitToolId,
    git_tool_sha256: gitToolSha256,
    oracle_id: oracleId,
    oracle_sha256: oracleSha256,
    required_negative_control_ids: Object.freeze([...negativeControlIds]),
    acceptance_ids: Object.freeze([...acceptanceIds]),
    finding_ids: Object.freeze([...findingIds]),
  });
  return Object.freeze({
    document,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

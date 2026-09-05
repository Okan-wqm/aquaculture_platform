const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const githubUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const D0_DELIVERY_CONTEXT = Object.freeze({
  program_id: 'new-aria-autonomous-engineering',
  work_unit_id: 'D0',
  successor_work_unit_id: 'S01',
  repository_slug: 'Okan-wqm/aquaculture_platform',
  pull_request_number: 1393,
  base_ref: 'main',
});

const payloadKeys = [
  'schema_version',
  'contract_id',
  'program_id',
  'work_unit_id',
  'successor_work_unit_id',
  'readback_id',
  'observation_sequence',
  'observation_id',
  'repository_slug',
  'provider',
  'pull_request_number',
  'merge_method',
  'base_sha',
  'reviewed_head_sha',
  'merge_commit_sha',
  'merge_parent_shas',
  'resulting_main_sha',
  'final_note_sha256',
  'final_note_identity_sha256',
  'review_dossier_sha256',
  'review_admission_sha256',
  'bypass_used',
  'producer_principal_id',
  'operator_principal_id',
  'observed_at',
  'valid_until',
  'invalidation_facts',
];
const providerKeys = [
  'system',
  'repository_id',
  'repository_node_id',
  'pull_request_url',
  'base_ref',
  'enforce_admins',
  'strict_required_checks',
  'required_checks_sha256',
  'ruleset_sha256',
];
const invalidationKeys = ['main_sha', 'head_sha', 'required_checks_sha256', 'ruleset_sha256'];
const evidenceKeys = [
  'base_sha',
  'reviewed_head_sha',
  'final_note_sha256',
  'final_note_identity_sha256',
  'review_dossier_sha256',
  'review_admission_sha256',
  'pull_merged_at',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function validIdentifier(value) {
  return typeof value === 'string' && identifier.test(value);
}

function timestamp(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) return NaN;
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === canonical
    ? milliseconds
    : NaN;
}

export function d0ReadbackId(reviewedHeadSha) {
  if (!exactSha.test(reviewedHeadSha ?? '')) throw new Error('reviewed head SHA is invalid');
  return `d0-readback-${reviewedHeadSha.slice(0, 16)}`;
}

function validateEvidence(evidence) {
  if (!exactKeys(evidence, evidenceKeys)) {
    throw new Error('derived readback evidence is incomplete');
  }
  if (!exactSha.test(evidence.base_sha) || !exactSha.test(evidence.reviewed_head_sha)) {
    throw new Error('derived readback target SHA is invalid');
  }
  for (const field of evidenceKeys.filter((key) => key.endsWith('_sha256'))) {
    if (!exactDigest.test(evidence[field] ?? '')) throw new Error(`derived ${field} is invalid`);
  }
  if (!Number.isFinite(timestamp(evidence.pull_merged_at, githubUtc))) {
    throw new Error('derived pull merged_at is invalid');
  }
}

function validateContainerShape(payload) {
  if (!exactKeys(payload, payloadKeys))
    throw new Error('delivery readback schema is open or drifted');
  if (!exactKeys(payload.provider, providerKeys))
    throw new Error('provider schema is open or drifted');
  if (!exactKeys(payload.invalidation_facts, invalidationKeys)) {
    throw new Error('readback invalidation schema is open or drifted');
  }
}

function validateContractIdentity(payload) {
  if (
    payload.schema_version !== '1.0.0' ||
    payload.contract_id !== 'new-aria-delivery-readback-v1' ||
    payload.provider.system !== 'GITHUB_API'
  ) {
    throw new Error('delivery readback contract identity mismatch');
  }
}

function validateD0Context(payload) {
  for (const [field, label] of [
    ['program_id', 'program'],
    ['work_unit_id', 'work unit'],
    ['successor_work_unit_id', 'successor'],
    ['repository_slug', 'repository'],
    ['pull_request_number', 'pull request'],
  ]) {
    if (payload[field] !== D0_DELIVERY_CONTEXT[field]) {
      throw new Error(`delivery readback ${label} context mismatch`);
    }
  }
  if (payload.provider.base_ref !== D0_DELIVERY_CONTEXT.base_ref) {
    throw new Error('delivery readback base ref context mismatch');
  }
}

function validateShape(payload) {
  validateContainerShape(payload);
  validateContractIdentity(payload);
  validateD0Context(payload);
}

function validateContext(payload, evidence) {
  for (const [field, label] of [
    ['base_sha', 'base SHA'],
    ['reviewed_head_sha', 'reviewed head SHA'],
    ['final_note_sha256', 'final note'],
    ['final_note_identity_sha256', 'final note identity'],
    ['review_dossier_sha256', 'review dossier'],
    ['review_admission_sha256', 'review admission'],
  ]) {
    if (payload[field] !== evidence[field]) throw new Error(`${label} context mismatch`);
  }
  if (payload.readback_id !== d0ReadbackId(evidence.reviewed_head_sha)) {
    throw new Error('readback context mismatch');
  }
  if (!validIdentifier(payload.readback_id)) throw new Error('readback ID is invalid');
}

function validatePrincipals(payload, signer) {
  if (
    !validIdentifier(payload.producer_principal_id) ||
    !validIdentifier(payload.operator_principal_id) ||
    payload.producer_principal_id === payload.operator_principal_id ||
    payload.operator_principal_id !== signer.principalId
  ) {
    throw new Error('delivery readback operator signer must be distinct and exact');
  }
}

export function assertReadbackFresh(payload) {
  const observedAt = timestamp(payload.observed_at, exactUtc);
  const validUntil = timestamp(payload.valid_until, exactUtc);
  if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil)) {
    throw new Error('delivery readback timestamps must be canonical UTC');
  }
  if (!Number.isSafeInteger(payload.observation_sequence) || payload.observation_sequence < 1) {
    throw new Error('delivery readback observation sequence is invalid');
  }
  if (!validIdentifier(payload.observation_id)) {
    throw new Error('delivery readback observation ID is invalid');
  }
  const now = Date.now();
  if (observedAt > now || now >= validUntil || validUntil - observedAt > 300_000) {
    throw new Error('delivery readback freshness or runtime clock check failed');
  }
}

function validateObservationOrder(payload, mergedAt) {
  if (timestamp(payload.observed_at, exactUtc) < timestamp(mergedAt, githubUtc) + 1_000) {
    throw new Error('delivery readback must be observed strictly after pull merge');
  }
}

function validateMerge(payload) {
  const shaFields = ['base_sha', 'reviewed_head_sha', 'merge_commit_sha', 'resulting_main_sha'];
  const validParents =
    Array.isArray(payload.merge_parent_shas) &&
    payload.merge_parent_shas.length === 2 &&
    payload.merge_parent_shas.every((value) => exactSha.test(value));
  if (shaFields.some((field) => !exactSha.test(payload[field])) || !validParents) {
    throw new Error('delivery readback merge SHA is invalid');
  }
  if (
    payload.merge_method !== 'MERGE_COMMIT' ||
    payload.merge_parent_shas[0] !== payload.base_sha ||
    payload.merge_parent_shas[1] !== payload.reviewed_head_sha ||
    payload.resulting_main_sha !== payload.merge_commit_sha
  ) {
    throw new Error('delivery readback merge method or parents mismatch');
  }
  if (payload.bypass_used !== false) throw new Error('delivery readback forbids merge bypass');
}

export function validateSignedReadback(payload, evidence, signer) {
  validateEvidence(evidence);
  validateShape(payload);
  validateContext(payload, evidence);
  validatePrincipals(payload, signer);
  assertReadbackFresh(payload);
  validateObservationOrder(payload, evidence.pull_merged_at);
  validateMerge(payload);
}

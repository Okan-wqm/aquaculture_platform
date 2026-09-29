import { canonicalJsonBytes } from './canonical-json';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { requireIdentifier } from './identifiers';
import { parseStrictJson } from './strict-json';
import type { JsonRecord } from './evidence-object';
import type { JsonValue } from './strict-json';

const keys = [
  'schema_version',
  'contract_id',
  'run_context_sha256',
  'authority_sha256',
  'repository_id',
  'workspace_id',
  'base_sha',
  'head_sha',
  'evidence_id',
  'program_id',
  'sprint_id',
  'event_policy_sha256',
  'freshness_policy_sha256',
  'epoch_provider_id',
  'epoch_provider_identity_sha256',
  'verification_plan_sha256',
  'verification_dossier',
] as const;
const sha40 = /^[a-f0-9]{40}$/u;

export interface OracleBaselineInput {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-oracle-baseline-input-v4';
  readonly run_context_sha256: string;
  readonly authority_sha256: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly evidence_id: string;
  readonly program_id: string;
  readonly sprint_id: string;
  readonly event_policy_sha256: string;
  readonly freshness_policy_sha256: string;
  readonly epoch_provider_id: string;
  readonly epoch_provider_identity_sha256: string;
  readonly verification_plan_sha256: string;
  readonly verification_dossier: JsonRecord;
}

export function oracleBaselineRunContext(
  value: Omit<
    OracleBaselineInput,
    'schema_version' | 'contract_id' | 'run_context_sha256' | 'verification_dossier'
  >,
): string {
  return digestBytes(
    canonicalJsonBytes({
      contract_id: 'new-aria-negative-control-run-context-v2',
      ...value,
    }),
  );
}

function record(bytes: Uint8Array): JsonRecord {
  const value = parseStrictJson(bytes);
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, keys) ||
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-oracle-baseline-input-v4'
  )
    throw new TypeError('oracle baseline input is not canonical, closed, or versioned');
  return value;
}

function commit(value: JsonValue | undefined, label: string): string {
  const result = requiredText(value, label);
  if (!sha40.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

export function loadOracleBaselineDocument(bytes: Uint8Array): OracleBaselineInput {
  const value = record(bytes);
  if (!isJsonRecord(value.verification_dossier)) {
    throw new TypeError('oracle baseline verification dossier is invalid');
  }
  const staticScope = Object.freeze({
    authority_sha256: requiredSha256(value.authority_sha256, 'oracle baseline authority'),
    repository_id: requireIdentifier(value.repository_id, 'oracle baseline repository'),
    workspace_id: requireIdentifier(value.workspace_id, 'oracle baseline workspace'),
    base_sha: commit(value.base_sha, 'oracle baseline base SHA'),
    head_sha: commit(value.head_sha, 'oracle baseline head SHA'),
    evidence_id: requireIdentifier(value.evidence_id, 'oracle baseline evidence'),
    program_id: requireIdentifier(value.program_id, 'oracle baseline program'),
    sprint_id: requireIdentifier(value.sprint_id, 'oracle baseline sprint'),
    event_policy_sha256: requiredSha256(value.event_policy_sha256, 'oracle baseline event policy'),
    freshness_policy_sha256: requiredSha256(
      value.freshness_policy_sha256,
      'oracle baseline freshness policy',
    ),
    epoch_provider_id: requireIdentifier(value.epoch_provider_id, 'oracle baseline epoch provider'),
    epoch_provider_identity_sha256: requiredSha256(
      value.epoch_provider_identity_sha256,
      'oracle baseline epoch provider identity',
    ),
    verification_plan_sha256: requiredSha256(
      value.verification_plan_sha256,
      'oracle baseline verification plan',
    ),
  });
  const runContext = requiredSha256(value.run_context_sha256, 'oracle baseline run context');
  if (oracleBaselineRunContext(staticScope) !== runContext) {
    throw new TypeError('oracle baseline run context does not match its static scope');
  }
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-oracle-baseline-input-v4',
    run_context_sha256: runContext,
    ...staticScope,
    verification_dossier: value.verification_dossier,
  });
}
